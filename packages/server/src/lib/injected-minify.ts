import { createRequire } from "node:module";
import type { Loader, TransformOptions, TransformResult } from "esbuild";

type Transform = (input: string, options: TransformOptions) => TransformResult;
/** 圧縮器を「使う直前に」取り出す関数。解決の失敗も変換の失敗として扱える。 */
type ResolveTransform = () => Transform;

// esbuild は **静的 import しない**。packaged .app では
// `app.asar` 配下からの解決が保証できず、top-level の import が失敗すると
// try/catch の外で throw して bootstrap ごと落ちるため
// (ESM の import は hoist される)。CJS の require なら Electron の asar 対応が
// 効くうえ、呼ばれるまで読み込まれない。
const requireFromHere = createRequire(import.meta.url);

let resolved: Transform | undefined;

const resolveEsbuildTransform: ResolveTransform = () => {
  if (resolved === undefined) {
    resolved = (requireFromHere("esbuild") as typeof import("esbuild"))
      .transformSync;
  }
  return resolved;
};

/**
 * 初回だけ trusted source を圧縮し、以後は同じ文字列を返す。
 *
 * 圧縮は配信サイズの最適化であって正しさの要件ではない。esbuild を解決できない
 * 環境でも、変換に失敗した場合でも、理由を 1 度だけ記録して元のソースを返し、
 * 注入自体は止めない。失敗も cache するので、警告が読み取りのたびに
 * 繰り返されることはない。
 */
export function createCachedMinifier(
  source: string,
  loader: Extract<Loader, "css" | "js">,
  resolveTransform: ResolveTransform = resolveEsbuildTransform
): () => string {
  let cached: string | undefined;
  return () => {
    if (cached === undefined) {
      try {
        cached = resolveTransform()(source, {
          loader,
          minify: true,
          target: "es2018",
        }).code;
      } catch (e) {
        console.warn(
          `[injected-minify] ${loader} の圧縮に失敗したため元のソースを注入します`,
          e
        );
        cached = source;
      }
    }
    return cached;
  };
}
