import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  DiagramCommentPortParse,
  DiagramCommentPortRequest,
} from "../lib/diagram-comment-bridge";
import { parseDiagramCommentPortRequest } from "../lib/diagram-comment-bridge";
import {
  anchorDiagramScroll,
  applyDiagramPinchZoom,
  DIAGRAM_ZOOM_MAX,
  DIAGRAM_ZOOM_MIN,
  DiagramViewport,
  emitDiagramAutosave,
  forwardDiagramCommentPortRequest,
  forwardDiagramCommentsUpdate,
  getDiagramZoomPercent,
  getDiagramZoomSizerStyle,
  handleDiagramOpenLinkMessage,
  handleDiagramPinchMessage,
  parseDiagramLinkHref,
  readDiagramCommentConnectionState,
  replyToInvalidDiagramCommentPortRequest,
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
      type: "ark:diagram-comment-reply",
      requestId: "req-reply",
      operationId: "op-reply",
      threadId: "th-1",
      body: "返信本文",
    },
    {
      type: "ark:diagram-comment-create",
      requestId: "req-create",
      operationId: "op-create",
      anchorId: "s1",
      anchorQuote: "選択した本文",
      anchorOccurrence: 1,
      body: "本文",
    },
    {
      type: "ark:diagram-comment-resolve",
      requestId: "req-resolve",
      operationId: "op-resolve",
      threadId: "th-1",
    },
    {
      type: "ark:diagram-comment-delete",
      requestId: "req-delete",
      operationId: "op-delete",
      threadId: "th-1",
    },
    {
      type: "ark:diagram-comment-send",
      requestId: "req-send",
      operationId: "op-send",
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
      replyDiagramComment: vi.fn(async () => response),
      deleteDiagramComment: vi.fn(async () => response),
      resolveDiagramComment: vi.fn(async () => response),
      sendDiagramComment: vi.fn(async () => response),
      isCurrent: vi.fn(() => true),
      reply: vi.fn(),
      onError: vi.fn(),
    };
  }

  it("load/create/reply/resolve/delete/send を現在の session/path と検証済み payload で中継する", async () => {
    const deps = dependencies();

    for (const request of requests) {
      await forwardDiagramCommentPortRequest(request, deps);
    }

    expect(deps.getDiagramComments).toHaveBeenCalledWith("session-1", REL_PATH);
    // operationId は iframe 由来の値をそのまま透過させる（#306）
    expect(deps.createDiagramComment).toHaveBeenCalledWith(
      "session-1",
      REL_PATH,
      "op-create",
      "s1",
      "本文",
      "選択した本文",
      1
    );
    expect(deps.replyDiagramComment).toHaveBeenCalledWith(
      "session-1",
      REL_PATH,
      "op-reply",
      "th-1",
      "返信本文"
    );
    expect(deps.resolveDiagramComment).toHaveBeenCalledWith(
      "session-1",
      REL_PATH,
      "op-resolve",
      "th-1"
    );
    expect(deps.deleteDiagramComment).toHaveBeenCalledWith(
      "session-1",
      REL_PATH,
      "op-delete",
      "th-1"
    );
    expect(deps.sendDiagramComment).toHaveBeenCalledWith(
      "session-1",
      REL_PATH,
      "op-send",
      "th-1"
    );
    expect(deps.reply.mock.calls.map(call => call[0].requestId)).toEqual([
      "req-load",
      "req-reply",
      "req-create",
      "req-resolve",
      "req-delete",
      "req-send",
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

describe("replyToInvalidDiagramCommentPortRequest", () => {
  it("invalid は同じ requestId の BAD_REQUEST を必ず reply する", () => {
    const reply = vi.fn();
    const onError = vi.fn();
    const parsed: DiagramCommentPortParse = {
      kind: "invalid",
      requestId: "req-invalid",
      error: "body が不正です",
    };

    expect(
      replyToInvalidDiagramCommentPortRequest(parsed, reply, onError)
    ).toBe(true);
    expect(reply).toHaveBeenCalledWith({
      type: "ark:diagram-comments-result",
      requestId: "req-invalid",
      ok: false,
      code: "BAD_REQUEST",
      error: "body が不正です",
    });
    expect(onError).toHaveBeenCalledWith("body が不正です");
  });

  it("ignore は reply しない", () => {
    const reply = vi.fn();
    const onError = vi.fn();

    expect(
      replyToInvalidDiagramCommentPortRequest(
        { kind: "ignore" },
        reply,
        onError
      )
    ).toBe(false);
    expect(reply).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("operationId を持たない古いタブへ BAD_REQUEST の理由を返して画面にも表示する", () => {
    const parsed = parseDiagramCommentPortRequest({
      type: "ark:diagram-comment-create",
      requestId: "req-old-tab",
      anchorId: "s1",
      body: "本文",
    });
    const reply = vi.fn();
    const onError = vi.fn();

    expect(
      replyToInvalidDiagramCommentPortRequest(parsed, reply, onError)
    ).toBe(true);
    expect(reply).toHaveBeenCalledWith({
      type: "ark:diagram-comments-result",
      requestId: "req-old-tab",
      ok: false,
      code: "BAD_REQUEST",
      error: "操作 ID（operationId）が不正です",
    });
    expect(onError).toHaveBeenCalledWith("操作 ID（operationId）が不正です");
  });
});

describe("forwardDiagramCommentsUpdate", () => {
  it("現在の図の sidecar 更新だけを iframe へ通知する", () => {
    const postMessage = vi.fn();
    const update = { worktreePath: "/wt", relPath: REL_PATH };

    expect(
      forwardDiagramCommentsUpdate(update, "/wt", REL_PATH, postMessage)
    ).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({
      type: "ark:diagram-comments-changed",
    });

    postMessage.mockClear();
    expect(
      forwardDiagramCommentsUpdate(update, "/other", REL_PATH, postMessage)
    ).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe("DiagramPane zoom", () => {
  it("pinch メッセージで連続ズームし 400% / 25% で clamp する", () => {
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

  it("pinch の位置を覚える (その点を中心に拡大縮小する)。位置が無ければ null", () => {
    const setAnchor = vi.fn();
    handleDiagramPinchMessage(
      { type: "ark:diagram-pinch", deltaY: -40, clientX: 120, clientY: 80 },
      vi.fn(),
      setAnchor
    );
    handleDiagramPinchMessage(
      { type: "ark:diagram-pinch", deltaY: -40 },
      vi.fn(),
      setAnchor
    );
    handleDiagramPinchMessage(
      { type: "ark:diagram-pinch", deltaY: -40, clientX: "1", clientY: 2 },
      vi.fn(),
      setAnchor
    );
    expect(setAnchor.mock.calls).toEqual([[{ x: 120, y: 80 }], [null], [null]]);
  });

  it("拡大は入れ物を広げて見た目だけを大きくし、縮小は入れ物を枠のままにする", () => {
    // 拡大: iframe は枠と同じ大きさ (入れ物の 1/2) のまま、2 倍に広げる
    expect(getDiagramZoomSizerStyle(2)).toEqual({
      width: "200%",
      height: "200%",
    });
    const zoomedIn = renderViewport(2);
    expect(zoomedIn).toContain("width:200%;height:200%");
    expect(zoomedIn).toContain("overflow-auto");
    // 縮小: iframe を枠より大きくしてから縮める (広いレイアウトを見渡す)
    expect(getDiagramZoomSizerStyle(0.5)).toEqual({
      width: "100%",
      height: "100%",
    });
    expect(renderViewport(0.5)).toContain("overflow-hidden");
    expect(renderViewport(1)).toContain("overflow-hidden");
  });

  it("拡大率を変えても、つまんだ点は画面の同じ場所に残る", () => {
    const viewport = { width: 800, height: 600 };
    // 100% で (200, 100) をつまんで 200% へ: 点は (400, 200) へ動くので、そのぶん送る
    expect(
      anchorDiagramScroll(1, 2, { left: 0, top: 0 }, viewport, {
        x: 200,
        y: 100,
      })
    ).toEqual({ left: 200, top: 100 });
    // 200% で送ってある状態から 400% へ: 画面上の位置 (400-200, 200-100) を保つ
    expect(
      anchorDiagramScroll(2, 4, { left: 200, top: 100 }, viewport, {
        x: 200,
        y: 100,
      })
    ).toEqual({ left: 600, top: 300 });
    // 左上の隅をつまんだら、送らない
    expect(
      anchorDiagramScroll(1, 3, { left: 0, top: 0 }, viewport, { x: 0, y: 0 })
    ).toEqual({ left: 0, top: 0 });
  });

  it("点が無ければ (ボタン)、見えている範囲の中心を保つ", () => {
    const viewport = { width: 800, height: 600 };
    expect(
      anchorDiagramScroll(1, 2, { left: 0, top: 0 }, viewport, null)
    ).toEqual({ left: 400, top: 300 });
    expect(
      anchorDiagramScroll(2, 4, { left: 400, top: 300 }, viewport, null)
    ).toEqual({ left: 1200, top: 900 });
  });

  it("100% 以下へ戻したら、スクロールを左上へ戻す", () => {
    expect(
      anchorDiagramScroll(
        2,
        1,
        { left: 300, top: 200 },
        { width: 800, height: 600 },
        { x: 200, y: 100 }
      )
    ).toEqual({ left: 0, top: 0 });
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

  it("400% / 25% で clamp し、対応するボタンを disabled にする", () => {
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

describe("parseDiagramLinkHref", () => {
  it("相対パスと行を読む", () => {
    expect(parseDiagramLinkHref("src/foo.ts#L10")).toEqual({
      kind: "file",
      path: "src/foo.ts",
      line: 10,
      endLine: null,
    });
    expect(parseDiagramLinkHref("src/foo.ts#L10-L24")).toEqual({
      kind: "file",
      path: "src/foo.ts",
      line: 10,
      endLine: 24,
    });
    expect(parseDiagramLinkHref("src/foo.ts")).toEqual({
      kind: "file",
      path: "src/foo.ts",
      line: null,
      endLine: null,
    });
  });

  it("./ を剥がし、行が読めなければ行なしにする", () => {
    expect(parseDiagramLinkHref("./src/foo.ts#L0")).toMatchObject({
      kind: "file",
      path: "src/foo.ts",
      line: null,
    });
    expect(parseDiagramLinkHref("src/foo.ts#section")).toMatchObject({
      path: "src/foo.ts",
      line: null,
    });
  });

  it("符号化されたパスは戻してから扱い、%2e%2e も traversal として弾く", () => {
    expect(parseDiagramLinkHref("src/my%20file.ts#L10")).toMatchObject({
      kind: "file",
      path: "src/my file.ts",
      line: 10,
    });
    expect(parseDiagramLinkHref("src/%2e%2e/%2e%2e/etc/passwd")).toBeNull();
    expect(parseDiagramLinkHref("src/%zz.ts")).toBeNull();
  });

  it("http(s) は URL として返す", () => {
    expect(parseDiagramLinkHref("https://example.com/a?b=1")).toEqual({
      kind: "url",
      url: "https://example.com/a?b=1",
    });
  });

  it("危険なパスと不明なスキームは拒否する", () => {
    expect(parseDiagramLinkHref("../etc/passwd")).toBeNull();
    expect(parseDiagramLinkHref("src/../../x")).toBeNull();
    expect(parseDiagramLinkHref("/etc/passwd")).toBeNull();
    expect(parseDiagramLinkHref("")).toBeNull();
    expect(parseDiagramLinkHref("#s6")).toBeNull();
    expect(parseDiagramLinkHref("javascript:alert(1)")).toBeNull();
    expect(parseDiagramLinkHref("mailto:a@example.com")).toBeNull();
  });
});

describe("handleDiagramOpenLinkMessage", () => {
  it("ファイルは ark:open-file、URL は ark:open-url にして post する", () => {
    const posted: unknown[] = [];
    const post = (message: unknown) => posted.push(message);
    expect(
      handleDiagramOpenLinkMessage(
        { type: "ark:diagram-open-link", href: "src/foo.ts#L10-L24" },
        post
      )
    ).toBe(true);
    expect(
      handleDiagramOpenLinkMessage(
        { type: "ark:diagram-open-link", href: "https://example.com" },
        post
      )
    ).toBe(true);
    expect(posted).toEqual([
      {
        type: "ark:open-file",
        path: "src/foo.ts",
        line: 10,
        endLine: 24,
        source: "board",
      },
      { type: "ark:open-url", url: "https://example.com" },
    ]);
  });

  it("別のメッセージや不正な href は扱わない / 拒否する", () => {
    const posted: unknown[] = [];
    const post = (message: unknown) => posted.push(message);
    expect(
      handleDiagramOpenLinkMessage({ type: "ark:diagram-pinch" }, post)
    ).toBe(false);
    expect(
      handleDiagramOpenLinkMessage(
        { type: "ark:diagram-open-link", href: "../x" },
        post
      )
    ).toBe(true);
    expect(posted).toEqual([]);
  });
});
