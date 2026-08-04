import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  applyDiagramPinchZoom,
  DIAGRAM_ZOOM_MAX,
  DIAGRAM_ZOOM_MIN,
  DiagramViewport,
  emitDiagramAutosave,
  getDiagramZoomPercent,
  handleDiagramPinchMessage,
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
