import {
  type Loader,
  type TransformOptions,
  type TransformResult,
  transformSync,
} from "esbuild";

type Transform = (input: string, options: TransformOptions) => TransformResult;

/** 初回だけ trusted source を圧縮し、以後は同じ文字列を返す。 */
export function createCachedMinifier(
  source: string,
  loader: Extract<Loader, "css" | "js">,
  transform: Transform = transformSync
): () => string {
  let cached: string | undefined;
  return () => {
    if (cached === undefined) {
      cached = transform(source, {
        loader,
        minify: true,
        target: "es2018",
      }).code;
    }
    return cached;
  };
}
