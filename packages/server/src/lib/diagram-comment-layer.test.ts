import { describe, expect, it } from "vitest";
import {
  DIAGRAM_COMMENT_LAYER_MARKER,
  injectDiagramCommentLayer,
} from "./diagram-comment-layer.js";

const minimalDoc =
  '<!doctype html><html><head></head><body><p data-ark-id="s1">本文</p></body></html>';

describe("injectDiagramCommentLayer", () => {
  it("</body> 直前へ marker を1回だけ注入する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain(DIAGRAM_COMMENT_LAYER_MARKER);
    expect(injected.indexOf(DIAGRAM_COMMENT_LAYER_MARKER)).toBe(
      injected.lastIndexOf(DIAGRAM_COMMENT_LAYER_MARKER)
    );
    expect(injected.indexOf(DIAGRAM_COMMENT_LAYER_MARKER)).toBeLessThan(
      injected.toLowerCase().lastIndexOf("</body>")
    );
  });

  it("body がなくても末尾へ注入する", () => {
    const html = "<main>文書</main>";

    const injected = injectDiagramCommentLayer(html);

    expect(injected.startsWith(html)).toBe(true);
    expect(injected).toContain(DIAGRAM_COMMENT_LAYER_MARKER);
  });

  it("二重注入しない", () => {
    const once = injectDiagramCommentLayer(minimalDoc);

    expect(injectDiagramCommentLayer(once)).toBe(once);
  });

  it("ark:diagram-init の transferred port で load/result を相関する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain("ark:diagram-init");
    expect(injected).toContain("event.ports[0]");
    expect(injected).toContain("ark:diagram-comments-load");
    expect(injected).toContain("ark:diagram-comments-result");
    expect(injected).toContain("requestId");
    expect(injected.match(/ark:diagram-init/gu)).toHaveLength(1);
  });

  it("128 KiB 未満で CSP 禁止 token と外部 stylesheet を含まない", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(Buffer.byteLength(injected, "utf8")).toBeLessThan(128 * 1024);
    for (const forbidden of [
      "fetch(",
      "import(",
      "https://",
      "innerHTML",
      "insertAdjacentHTML",
      "@font-face",
    ]) {
      expect(injected).not.toContain(forbidden);
    }
    expect(injected).not.toMatch(
      /<link\b[^>]*rel=["']?stylesheet|@import\s|url\s*\(/iu
    );
  });

  it("DOM API だけで right rail・marker・composer を構築する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    for (const contract of [
      "createElement",
      "textContent",
      "setAttribute",
      "appendChild",
      "[data-ark-id]",
      "ResizeObserver",
      "scroll",
      "resize",
    ]) {
      expect(injected).toContain(contract);
    }
  });

  it("marker をコメント無し・未解決あり・解決済みのみで区別する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain('setAttribute("data-comment-state",state)');
    expect(injected).toContain(
      'setAttribute("data-open-count",String(openCount))'
    );
    expect(injected).toContain('state="open"');
    expect(injected).toContain('state="resolved"');
    expect(injected).toContain('state="none"');
    expect(injected).toContain(".ark-comment-marker[data-comment-state=none]");
  });

  it("成功 result を受け取るたび marker 状態を更新する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain("function updateMarkers()");
    expect(injected).toMatch(
      /if\(data\.ok\)\{[^}]*comments=data\.comments;[^}]*updateMarkers\(\)/u
    );
  });

  it("pinch/create/resolve と pending/error 契約を含む", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain("ark:diagram-pinch");
    expect(injected).toContain("ctrlKey");
    expect(injected).toContain("ark:diagram-comment-create");
    expect(injected).toContain("ark:diagram-comment-resolve");
    expect(injected).toContain("pendingRequestId");
    expect(injected).toContain("disabled");
    expect(injected).toContain("error");
    expect(injected).not.toContain("ark:diagram-comment-reply");
    expect(injected).not.toContain("orphaned");
  });
});
