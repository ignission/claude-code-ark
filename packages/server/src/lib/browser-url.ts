/**
 * ブラウザ機能で開くURLの決まり。
 *
 * Arkが遷移させてよいのは、Chromiumが動いている機械の `localhost` / `127.0.0.1` と
 * `about:blank` だけ。
 *
 * ブリッジとChromiumを起動する側の両方が使うので、どちらにも依らないモジュールに置く。
 */

/** スキームで始まっているか (`http:`、`about:` など) */
const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
/** 最初のコロンのあとがポートか (`localhost:3000`、`127.0.0.1:8080/x`) */
const HOST_PORT_PATTERN = /^[^/?#\s]+:\d+(?:[/?#]|$)/;

/**
 * アドレスバーに打たれた文字列をURLにする。前後の空白を落とし、スキームが無ければ
 * `http://` を補う。開いてよいかは見ない (`validateBrowserUrl` が見る)。
 *
 * 最初のコロンのあとがポートなら、コロンの前はスキームではなくホストとして読む。
 * そう読まないと、`localhost:3000` がスキーム `localhost:` のURLになり、開けない。
 */
export function normalizeUserUrl(input: string): string {
  const trimmed = input.trim();
  if (HOST_PORT_PATTERN.test(trimmed)) return `http://${trimmed}`;
  return SCHEME_PATTERN.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/**
 * ブラウザ機能で開いてよいURLかを確かめる。だめなら例外を投げる。
 * - `about:blank` は通す
 * - それ以外は `http:` / `https:` で、ホストが `localhost` / `127.0.0.1` のものだけ
 */
export function validateBrowserUrl(url: string): void {
  if (url === "about:blank") return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("無効なURL形式です");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("http://またはhttps://のみ許可されています");
  }
  if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("localhost/127.0.0.1のみ許可されています");
  }
}
