import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  anchorDiagramScroll,
  applyDiagramPinchZoom,
  DIAGRAM_ZOOM_MAX,
  DIAGRAM_ZOOM_MIN,
  DiagramViewport,
  getDiagramZoomSizerStyle,
  handleDiagramOpenLinkMessage,
  handleDiagramPinchMessage,
  parseDiagramLinkHref,
  planDiagramKeynavScroll,
  resetDiagramZoom,
} from "./DiagramPane";

const REL_PATH = ".claude/diagrams/sample.diagram.html";
const HTML = "<!doctype html><html><body>diagram</body></html>";

function renderViewport(zoom: number, relPath = REL_PATH): string {
  return renderToStaticMarkup(
    createElement(DiagramViewport, {
      relPath,
      html: HTML,
      zoom,
      onIframeLoad: vi.fn(),
    })
  );
}

function getRenderedSrcDoc(markup: string): string | undefined {
  return markup.match(/srcDoc="([^"]*)"/)?.[1];
}

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

    // 100% をまたぐときは、いったん 100% で止まる (つまみ戻すだけで元へ戻せる)
    handleDiagramPinchMessage(
      { type: "ark:diagram-pinch", deltaY: 80 },
      setZoom
    );
    expect(zoom).toBe(1);
    handleDiagramPinchMessage(
      { type: "ark:diagram-pinch", deltaY: 40 },
      setZoom
    );
    expect(zoom).toBeCloseTo(Math.exp(-0.1));
    handleDiagramPinchMessage(
      { type: "ark:diagram-pinch", deltaY: -400 },
      setZoom
    );
    expect(zoom).toBe(1);
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

  it("点が無ければ、見えている範囲の中心を保つ", () => {
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

  it("拡大中の j / k は、まず外側を動かし、端まで来たら中の文書へ渡す", () => {
    const scroller = { scrollTop: 100, scrollHeight: 1600, clientHeight: 800 };
    expect(planDiagramKeynavScroll(scroller, { unit: "line", dir: 1 })).toEqual(
      { top: 180, forward: false }
    );
    expect(
      planDiagramKeynavScroll(scroller, { unit: "page", dir: -1 })
    ).toEqual({ top: 0, forward: false });
    // 下の端にいるときの j は、中の文書を送る
    expect(
      planDiagramKeynavScroll(
        { ...scroller, scrollTop: 800 },
        { unit: "line", dir: 1 }
      )
    ).toEqual({ forward: true });
    // 上の端にいるときの k も同じ
    expect(
      planDiagramKeynavScroll(
        { ...scroller, scrollTop: 0 },
        { unit: "line", dir: -1 }
      )
    ).toEqual({ forward: true });
  });

  it("拡大中の gg / G は、外側と中の文書の両方を端へ寄せる", () => {
    const scroller = { scrollTop: 100, scrollHeight: 1600, clientHeight: 800 };
    expect(planDiagramKeynavScroll(scroller, { unit: "edge", dir: 1 })).toEqual(
      { top: 800, forward: true }
    );
    expect(
      planDiagramKeynavScroll(scroller, { unit: "edge", dir: -1 })
    ).toEqual({ top: 0, forward: true });
  });

  it("拡大していなければ、j / k はそのまま中の文書へ渡す", () => {
    expect(
      planDiagramKeynavScroll(
        { scrollTop: 0, scrollHeight: 800, clientHeight: 800 },
        { unit: "line", dir: 1 }
      )
    ).toEqual({ forward: true });
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

  it("拡大率に応じて iframe の width / transform が変わり、100% では付かない", () => {
    expect(renderViewport(1.25)).toContain(
      "width:calc(100% / 1.25);height:calc(100% / 1.25);transform:scale(1.25);transform-origin:0 0"
    );
    expect(renderViewport(0.8)).toContain(
      "width:calc(100% / 0.8);height:calc(100% / 0.8);transform:scale(0.8);transform-origin:0 0"
    );
    const reset = renderViewport(resetDiagramZoom());
    expect(reset).not.toContain("transform:");
    expect(reset).not.toContain("<iframe style=");
  });

  it("拡大縮小のボタンと倍率の表示は出さない (ピンチだけで動かす)", () => {
    const markup = renderViewport(2);
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("200%</");
  });

  it("zoom 変更では iframe の srcDoc が変わらない", () => {
    const before = renderViewport(1);
    const after = renderViewport(1.25);

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
