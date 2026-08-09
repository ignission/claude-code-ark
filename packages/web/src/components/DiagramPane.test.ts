import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DiagramCommentPortRequest } from "../lib/diagram-comment-bridge";
import {
  applyDiagramPinchZoom,
  DIAGRAM_ZOOM_MAX,
  DIAGRAM_ZOOM_MIN,
  DiagramViewport,
  emitDiagramAutosave,
  forwardDiagramCommentPortRequest,
  getDiagramZoomPercent,
  handleDiagramPinchMessage,
  readDiagramCommentConnectionState,
  resetDiagramZoom,
  stepDiagramZoom,
} from "./DiagramPane";

const REL_PATH = ".claude/diagrams/sample.diagram.html";
const HTML = "<!doctype html><html><body>diagram</body></html>";

function renderViewport(zoom: number, relPath = REL_PATH): string {
  return renderToStaticMarkup(
    createElement(DiagramViewport, {
      relPath,
      html: HTML,
      zoom,
      onZoomOut: vi.fn(),
      onZoomReset: vi.fn(),
      onZoomIn: vi.fn(),
      onIframeLoad: vi.fn(),
    })
  );
}

function getRenderedSrcDoc(markup: string): string | undefined {
  return markup.match(/srcDoc="([^"]*)"/)?.[1];
}

describe("emitDiagramAutosave", () => {
  it("ACK timeout を保存失敗として reply する", () => {
    const reply = vi.fn();
    const emit = vi.fn(
      (_event: string, _request: unknown, callback: (error: Error) => void) =>
        callback(new Error("operation has timed out"))
    );
    const timeout = vi.fn(() => ({ emit }));

    emitDiagramAutosave(
      { timeout } as never,
      {
        sessionId: "session-1",
        worktreePath: "/worktree",
        relPath: ".claude/diagrams/sample.diagram.html",
        model: {},
        html: "<html></html>",
      },
      reply
    );

    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(reply).toHaveBeenCalledWith({
      ok: false,
      error: "保存がタイムアウトしました",
    });
  });
});

describe("forwardDiagramCommentPortRequest", () => {
  const requests: DiagramCommentPortRequest[] = [
    { type: "ark:diagram-comments-load", requestId: "req-load" },
    {
      type: "ark:diagram-comment-create",
      requestId: "req-create",
      anchorId: "s1",
      anchorQuote: "選択した本文",
      anchorOccurrence: 1,
      author: "Reviewer",
      body: "本文",
    },
    {
      type: "ark:diagram-comment-resolve",
      requestId: "req-resolve",
      threadId: "th-1",
    },
  ];

  function dependencies() {
    const response = {
      ok: true as const,
      comments: {
        version: 1 as const,
        target: "sample.diagram.html",
        threads: [],
      },
    };
    return {
      isConnected: true,
      sessionId: "session-1",
      relPath: REL_PATH,
      getDiagramComments: vi.fn(async () => response),
      createDiagramComment: vi.fn(async () => response),
      resolveDiagramComment: vi.fn(async () => response),
      isCurrent: vi.fn(() => true),
      reply: vi.fn(),
      onError: vi.fn(),
    };
  }

  it("load/create/resolve を現在の session/path と検証済み payload で中継する", async () => {
    const deps = dependencies();

    for (const request of requests) {
      await forwardDiagramCommentPortRequest(request, deps);
    }

    expect(deps.getDiagramComments).toHaveBeenCalledWith("session-1", REL_PATH);
    expect(deps.createDiagramComment).toHaveBeenCalledWith(
      "session-1",
      REL_PATH,
      "s1",
      "Reviewer",
      "本文",
      "選択した本文",
      1
    );
    expect(deps.resolveDiagramComment).toHaveBeenCalledWith(
      "session-1",
      REL_PATH,
      "th-1"
    );
    expect(deps.reply.mock.calls.map(call => call[0].requestId)).toEqual([
      "req-load",
      "req-create",
      "req-resolve",
    ]);
  });

  it("transport timeout を同じ requestId の error result と banner へ返す", async () => {
    const deps = dependencies();
    deps.getDiagramComments.mockRejectedValueOnce(
      new Error("コメント処理がタイムアウトしました")
    );

    await forwardDiagramCommentPortRequest(requests[0], deps);

    expect(deps.reply).toHaveBeenCalledWith({
      type: "ark:diagram-comments-result",
      requestId: "req-load",
      ok: false,
      code: "IO_ERROR",
      error: "コメント処理がタイムアウトしました",
    });
    expect(deps.onError).toHaveBeenCalledWith(
      "コメント処理がタイムアウトしました"
    );
  });

  it("未接続は transport を呼ばず即 error ACK にする", async () => {
    const deps = dependencies();
    deps.isConnected = false;

    await forwardDiagramCommentPortRequest(requests[0], deps);

    expect(deps.getDiagramComments).not.toHaveBeenCalled();
    expect(deps.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, requestId: "req-load" })
    );
  });

  it("同じ port の処理でも再接続後は最新の接続状態で中継する", async () => {
    const connection = { current: false };
    const deps = dependencies();

    await forwardDiagramCommentPortRequest(requests[0], {
      ...deps,
      isConnected: readDiagramCommentConnectionState(connection),
    });
    expect(deps.getDiagramComments).not.toHaveBeenCalled();

    connection.current = true;
    await forwardDiagramCommentPortRequest(requests[0], {
      ...deps,
      isConnected: readDiagramCommentConnectionState(connection),
    });
    expect(deps.getDiagramComments).toHaveBeenCalledOnce();
  });

  it("旧 port generation の遅延結果を reply/state に反映しない", async () => {
    const deps = dependencies();
    deps.isCurrent.mockReturnValue(false);

    const handled = await forwardDiagramCommentPortRequest(requests[0], deps);

    expect(handled).toBe(false);
    expect(deps.reply).not.toHaveBeenCalled();
    expect(deps.onError).not.toHaveBeenCalled();
  });
});

describe("DiagramPane zoom", () => {
  it("pinch メッセージで連続ズームし 200% / 25% で clamp する", () => {
    let zoom = 1;
    const setZoom = (update: (current: number) => number) => {
      zoom = update(zoom);
    };

    expect(
      handleDiagramPinchMessage(
        { type: "ark:diagram-pinch", deltaY: -40 },
        setZoom
      )
    ).toBe(true);
    expect(zoom).toBeCloseTo(Math.exp(0.1));

    handleDiagramPinchMessage(
      { type: "ark:diagram-pinch", deltaY: 80 },
      setZoom
    );
    expect(zoom).toBeCloseTo(Math.exp(-0.1));
    expect(applyDiagramPinchZoom(1, -10_000)).toBe(DIAGRAM_ZOOM_MAX);
    expect(applyDiagramPinchZoom(1, 10_000)).toBe(DIAGRAM_ZOOM_MIN);
  });

  it("不正な pinch メッセージは zoom を変更しない", () => {
    const setZoom = vi.fn();

    expect(
      handleDiagramPinchMessage(
        { type: "ark:diagram-pinch", deltaY: "-40" },
        setZoom
      )
    ).toBe(false);
    expect(
      handleDiagramPinchMessage(
        { type: "ark:diagram-pinch", deltaY: Number.NaN },
        setZoom
      )
    ).toBe(false);
    expect(setZoom).not.toHaveBeenCalled();
  });

  it("＋/−で percent 表示と iframe の width/transform が変わる", () => {
    const zoomedIn = stepDiagramZoom(1, "in");
    expect(getDiagramZoomPercent(zoomedIn)).toBe(125);
    expect(renderViewport(zoomedIn)).toContain(
      "width:calc(100% / 1.25);height:calc(100% / 1.25);transform:scale(1.25);transform-origin:0 0"
    );

    const zoomedOut = stepDiagramZoom(1, "out");
    expect(getDiagramZoomPercent(zoomedOut)).toBe(80);
    expect(renderViewport(zoomedOut)).toContain(
      "width:calc(100% / 0.8);height:calc(100% / 0.8);transform:scale(0.8);transform-origin:0 0"
    );
  });

  it("200% / 25% で clamp し、対応するボタンを disabled にする", () => {
    let upper = 1;
    let lower = 1;
    for (let i = 0; i < 10; i += 1) {
      upper = stepDiagramZoom(upper, "in");
      lower = stepDiagramZoom(lower, "out");
    }

    expect(upper).toBe(DIAGRAM_ZOOM_MAX);
    expect(lower).toBe(DIAGRAM_ZOOM_MIN);
    expect(stepDiagramZoom(upper, "in")).toBe(DIAGRAM_ZOOM_MAX);
    expect(stepDiagramZoom(lower, "out")).toBe(DIAGRAM_ZOOM_MIN);
    expect(renderViewport(upper)).toContain('title="ズームイン" disabled=""');
    expect(renderViewport(lower)).toContain('title="ズームアウト" disabled=""');
  });

  it("percent リセットで 100% に戻り、iframe の transform が外れる", () => {
    const zoom = resetDiagramZoom();
    const markup = renderViewport(zoom);

    expect(getDiagramZoomPercent(zoom)).toBe(100);
    expect(markup).toContain(">100%</button>");
    expect(markup).not.toContain("transform:");
    expect(markup).not.toContain("<iframe style=");
  });

  it("relPath 変更時は 100% にリセットした表示になる", () => {
    const before = renderViewport(stepDiagramZoom(1, "in"), REL_PATH);
    const after = renderViewport(
      resetDiagramZoom(),
      ".claude/diagrams/other.diagram.html"
    );

    expect(before).toContain(">125%</button>");
    expect(after).toContain(">100%</button>");
    expect(after).not.toContain("transform:");
  });

  it("zoom 変更では iframe の srcDoc が変わらない", () => {
    const before = renderViewport(1);
    const after = renderViewport(stepDiagramZoom(1, "in"));

    expect(getRenderedSrcDoc(before)).toBeDefined();
    expect(getRenderedSrcDoc(after)).toBe(getRenderedSrcDoc(before));
    expect(after).toContain('sandbox="allow-scripts"');
  });
});
