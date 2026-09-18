import {
  type Loader,
  type TransformOptions,
  type TransformResult,
  transformSync,
} from "esbuild";

type Transform = (input: string, options: TransformOptions) => TransformResult;

/**
 * 初回だけ trusted source を圧縮し、以後は同じ文字列を返す。
 *
 * 圧縮は配信サイズの最適化であって正しさの要件ではない。packaged .app のように
 * esbuild を呼べない環境では理由を 1 度だけ記録して元のソースを返し、注入自体は
 * 止めない。失敗も cache するので、警告が読み取りのたびに繰り返されることはない。
 */
export function createCachedMinifier(
  source: string,
  loader: Extract<Loader, "css" | "js">,
  transform: Transform = transformSync
): () => string {
  let cached: string | undefined;
  return () => {
    if (cached === undefined) {
      try {
        cached = transform(source, {
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
