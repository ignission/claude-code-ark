import { transformSync } from "esbuild";
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

// 本物の transformSync を通す spy。呼ばれた回数だけを見たいので、圧縮結果は
// そのまま (後続のサイズ比較テストは実際に圧縮された出力を検証する)。
vi.mock("esbuild", async importOriginal => {
  const actual = await importOriginal<typeof import("esbuild")>();
  return { ...actual, transformSync: vi.fn(actual.transformSync) };
});

const transformSpy = vi.mocked(transformSync);

const byteLength = (value: string) => Buffer.byteLength(value, "utf8");
const occurrences = (value: string, token: string) =>
  value.split(token).length - 1;

// 最初に実行される必要がある: 他のテストが注入を走らせると呼び出し回数が動く。
describe("注入 payload の遅延生成", () => {
  it("import しただけでは圧縮せず、初回注入時に 1 度だけ走る", () => {
    // module 評価で esbuild を呼ぶと、bundle した Electron の bootstrap が
    // server module の読み込み中に落ちる (#446 後の v1.5.0 release 失敗)。
    expect(transformSpy).not.toHaveBeenCalled();

    // ハーネスは style (css) と script (js) の 2 回。
    injectHarness("");
    expect(transformSpy).toHaveBeenCalledTimes(2);
    injectHarness("");
    expect(transformSpy).toHaveBeenCalledTimes(2);

    // コメント層は script (js) の 1 回だけ。
    injectDiagramCommentLayer("");
    expect(transformSpy).toHaveBeenCalledTimes(3);
    injectDiagramCommentLayer("");
    expect(transformSpy).toHaveBeenCalledTimes(3);
  });
});

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

  it("変換に失敗したら警告して元のソースを返す", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const transform = vi.fn(() => {
      throw new Error("syntax error");
    });
    const minify = createCachedMinifier("broken", "js", transform);

    expect(minify()).toBe("broken");
    expect(minify()).toBe("broken");
    // 失敗も cache するので、変換も警告も 1 度きり。
    expect(transform).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();

    warn.mockRestore();
  });
});
