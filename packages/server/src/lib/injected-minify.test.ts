import { describe, expect, it, vi } from "vitest";
import {
  DIAGRAM_KEYNAV_LAYER_MARKER,
  injectDiagramKeynavLayer,
  KEYNAV_LAYER,
} from "./diagram-keynav-layer.js";
import {
  DIAGRAM_LINK_LAYER_MARKER,
  injectDiagramLinkLayer,
  LINK_LAYER,
} from "./diagram-link-layer.js";
import { createCachedMinifier } from "./injected-minify.js";

const byteLength = (value: string) => Buffer.byteLength(value, "utf8");
const occurrences = (value: string, token: string) =>
  value.split(token).length - 1;

describe("注入コードの minify", () => {
  it("リンク層とキーの層をソースより小さくする", () => {
    expect(byteLength(injectDiagramLinkLayer(""))).toBeLessThan(
      byteLength(LINK_LAYER)
    );
    expect(byteLength(injectDiagramKeynavLayer(""))).toBeLessThan(
      byteLength(KEYNAV_LAYER)
    );
  });

  it("marker と port protocol を minify 後も維持する", () => {
    const link = injectDiagramLinkLayer("");
    const keynav = injectDiagramKeynavLayer("");

    expect(occurrences(link, DIAGRAM_LINK_LAYER_MARKER)).toBe(1);
    expect(occurrences(keynav, DIAGRAM_KEYNAV_LAYER_MARKER)).toBe(1);
    for (const protocol of ["ark:diagram-init", "ark:diagram-open-link"]) {
      expect(link).toContain(protocol);
    }
    for (const protocol of [
      "ark:diagram-init",
      "ark:diagram-keynav-leader",
      "ark:diagram-keynav-scroll",
      "ark:diagram-pinch",
    ]) {
      expect(keynav).toContain(protocol);
    }
  });

  it("minify 後も CSP 禁止 token を含まない", () => {
    for (const injected of [
      injectDiagramLinkLayer(""),
      injectDiagramKeynavLayer(""),
    ]) {
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
    }
  });
});

describe("createCachedMinifier", () => {
  it("初回だけ変換し、2 回目以降はキャッシュを返す", () => {
    const transform = vi.fn(() => ({ code: "minified" }));
    const minify = createCachedMinifier("source", "js", () => transform);

    expect(minify()).toBe("minified");
    expect(minify()).toBe("minified");
    expect(transform).toHaveBeenCalledOnce();
    expect(transform).toHaveBeenCalledWith("source", {
      loader: "js",
      minify: true,
      target: "es2018",
    });
  });

  it("変換に失敗したら警告して元のソースを返す", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const transform = vi.fn(() => {
      throw new Error("syntax error");
    });
    const minify = createCachedMinifier("broken", "js", () => transform);

    expect(minify()).toBe("broken");
    expect(minify()).toBe("broken");
    // 失敗も cache するので、変換も警告も 1 度きり。
    expect(transform).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();

    warn.mockRestore();
  });

  it("esbuild を解決できなくても元のソースを返す", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // packaged .app で `require("esbuild")` が解決できない状況。
    const resolve = vi.fn((): never => {
      throw new Error("Cannot find module 'esbuild'");
    });
    const minify = createCachedMinifier("source", "css", resolve);

    expect(minify()).toBe("source");
    expect(minify()).toBe("source");
    expect(resolve).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();

    warn.mockRestore();
  });
});
