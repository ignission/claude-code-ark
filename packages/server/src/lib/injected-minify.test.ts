import { describe, expect, it, vi } from "vitest";
import {
  COMMENT_LAYER,
  DIAGRAM_COMMENT_LAYER_MARKER,
  injectDiagramCommentLayer,
} from "./diagram-comment-layer.js";
import {
  DIAGRAM_HARNESS_MARKER,
  DIAGRAM_HARNESS_SOURCE,
  injectHarness,
} from "./diagram-harness.js";
import { createCachedMinifier } from "./injected-minify.js";

const byteLength = (value: string) => Buffer.byteLength(value, "utf8");
const occurrences = (value: string, token: string) =>
  value.split(token).length - 1;

describe("注入コードの minify", () => {
  it("ハーネスとコメント層をソースより明確に小さくする", () => {
    const harness = injectHarness("");
    const commentLayer = injectDiagramCommentLayer("");

    expect(byteLength(harness)).toBeLessThan(
      byteLength(DIAGRAM_HARNESS_SOURCE) * 0.8
    );
    expect(byteLength(commentLayer)).toBeLessThan(
      byteLength(COMMENT_LAYER) * 0.8
    );
  });

  it("marker と port protocol を minify 後も維持する", () => {
    const harness = injectHarness("");
    const commentLayer = injectDiagramCommentLayer("");

    expect(occurrences(harness, DIAGRAM_HARNESS_MARKER)).toBe(1);
    expect(occurrences(commentLayer, DIAGRAM_COMMENT_LAYER_MARKER)).toBe(1);
    for (const protocol of ["ark:diagram-submit", "ark:diagram-pinch"]) {
      expect(harness).toContain(protocol);
    }
    for (const protocol of [
      "ark:diagram-init",
      "ark:diagram-comments-load",
      "ark:diagram-comments-result",
      "ark:diagram-pinch",
      "ark:diagram-comments-changed",
    ]) {
      expect(commentLayer).toContain(protocol);
    }
  });

  it("minify 後も CSP 禁止 token を含まない", () => {
    for (const injected of [injectHarness(""), injectDiagramCommentLayer("")]) {
      for (const forbidden of [
        "fetch(",
        "import(",
        "https://",
        "innerHTML",
        "insertAdjacentHTML",
        "@font-face",
        "confirm(",
        "alert(",
      ]) {
        expect(injected).not.toContain(forbidden);
      }
      expect(injected).not.toMatch(
        /<link\b[^>]*rel=["']?stylesheet|@import\s/iu
      );
    }
  });
});

describe("createCachedMinifier", () => {
  it("初回だけ変換し、2 回目以降はキャッシュを返す", () => {
    const transform = vi.fn(() => ({ code: "minified" }));
    const minify = createCachedMinifier("source", "js", transform);

    expect(minify()).toBe("minified");
    expect(minify()).toBe("minified");
    expect(transform).toHaveBeenCalledOnce();
    expect(transform).toHaveBeenCalledWith("source", {
      loader: "js",
      minify: true,
      target: "es2018",
    });
  });

  it("変換失敗を握りつぶさない", () => {
    const error = new Error("syntax error");
    const minify = createCachedMinifier("broken", "js", () => {
      throw error;
    });

    expect(minify).toThrow(error);
  });
});
