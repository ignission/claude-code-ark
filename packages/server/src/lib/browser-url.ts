/**
 * ブラウザ機能で開くURLの決まり。
 *
 * Arkが遷移させてよいのは、`about:blank` と、ホストを問わない `http:` / `https:` のURL。
 *
 * ホストは絞らない。Arkは1人で使うもので、使う人はこの機械のシェルをすでに持っているので、
 * ホストを絞っても守るものが無い。スキームは絞る。`file:` はサーバーのファイルをページに
 * 読み込ませ、`javascript:` や `data:` はスクリプトを走らせるURLになる。
 *
 * ブリッジとChromiumを起動する側の両方が使うので、どちらにも依らないモジュールに置く。
 */

/** スキームで始まっているか (`http:`、`about:` など) */
const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
/** 最初のコロンのあとがポートか (`localhost:3000`、`127.0.0.1:8080/x`) */
const HOST_PORT_PATTERN = /^[^/?#\s]+:\d+(?:[/?#]|$)/;

/** 開くURLの上限 (文字数)。視聴者のメッセージで受け取るURLの上限と揃える */
export const MAX_BROWSER_URL_LENGTH = 2048;

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
 * ブラウザ機能で開いてよいURLかを確かめ、遷移に使う文字列を返す。だめなら例外を投げる。
 * - `about:blank` は通す
 * - それ以外は `http:` / `https:` のURLだけ。ホストは問わない
 * - ユーザー名やパスワードの付いたURLは通さない (`http://localhost@evil.com/` のように、
 *   ホストを見誤らせる書き方に使われる)
 * - `MAX_BROWSER_URL_LENGTH` を超えるものは通さない
 *
 * 返すのは、ここで読んだあとの形 (`URL` の `href`)。遷移には、渡した文字列ではなく
 * 返った文字列を使う。渡した文字列をChromiumが読み直すと、ここでの読み方と食い違う
 * 書き方 (`http://localhost\@evil.com`、改行や全角の混じったホストなど) で、確かめた先と
 * 違う先へ遷移しうる。
 */
export function validateBrowserUrl(url: string): string {
  if (url === "about:blank") return url;
  if (url.length > MAX_BROWSER_URL_LENGTH) {
    throw new Error("URLが長すぎます");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("無効なURL形式です");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("http://またはhttps://のみ許可されています");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("ユーザー名やパスワードの付いたURLは許可されていません");
  }
  return parsed.href;
}

/** `validateBrowserUrl` を通るか。投げない */
export function isBrowserUrlAllowed(url: string): boolean {
  try {
    validateBrowserUrl(url);
    return true;
  } catch {
    return false;
  }
}
