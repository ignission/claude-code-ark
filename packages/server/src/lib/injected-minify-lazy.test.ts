import { describe, expect, it, vi } from "vitest";

// 圧縮がいつ走るかだけを見たいので、`createCachedMinifier` を「呼ばれた loader を
// 記録して元のソースを返す」実装に差し替える。本物の esbuild は
// `createRequire` 経由で読むため `vi.mock("esbuild")` では捕まえられない
// (それ自体が packaged .app 向けの設計)。圧縮結果そのものの検証は
// `injected-minify.test.ts` 側で本物の esbuild を使って行う。
const { minified } = vi.hoisted(() => ({ minified: [] as string[] }));

vi.mock("./injected-minify.js", () => ({
  createCachedMinifier: (source: string, loader: "css" | "js") => {
    let cached: string | undefined;
    return () => {
      if (cached === undefined) {
        minified.push(loader);
        cached = source;
      }
      return cached;
    };
  },
}));

import { injectDiagramCommentLayer } from "./diagram-comment-layer.js";
import { injectHarness } from "./diagram-harness.js";

describe("注入 payload の遅延生成", () => {
  it("import しただけでは圧縮せず、初回注入時に 1 度だけ走る", () => {
    // module 評価で esbuild を呼ぶと、bundle した Electron の bootstrap が
    // server module の読み込み中に落ちる (v1.5.0 の release smoke test 失敗)。
    expect(minified).toEqual([]);

    // ハーネスは style (css) と script (js) の 2 回。
    injectHarness("");
    expect(minified).toEqual(["css", "js"]);
    injectHarness("");
    expect(minified).toEqual(["css", "js"]);

    // コメント層は script (js) の 1 回だけ。
    injectDiagramCommentLayer("");
    expect(minified).toEqual(["css", "js", "js"]);
    injectDiagramCommentLayer("");
    expect(minified).toEqual(["css", "js", "js"]);
  });
});
