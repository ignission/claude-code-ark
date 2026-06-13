/**
 * プレーンテキスト中の URL を検出して断片に分解する純粋ロジック。
 *
 * AskUserQuestion の質問文・回答など、Markdown レンダリングを通さない
 * プレーンテキスト表示で URL をクリッカブルにするために使う。
 * 描画 (React) 側は `Linkify` コンポーネント (SplitChatPane) が担う。
 */

/** http(s) URL を検出する */
const URL_RE = /https?:\/\/[^\s<>"'`]+/g;

/**
 * URL の末尾に付きがちな句読点・閉じ括弧を切り離す。
 * 例: "(see https://example.com)." → URL は "https://example.com"
 * 閉じ括弧は、URL 内に対応する開き括弧がある場合のみ残す
 * (Wikipedia 等の `..._(disambiguation)` を壊さない)。
 */
function trimTrailingPunctuation(url: string): {
  url: string;
  trailing: string;
} {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1];
    if (")]".includes(ch)) {
      const open = ch === ")" ? "(" : "[";
      const slice = url.slice(0, end);
      const opens = slice.split(open).length - 1;
      const closes = slice.split(ch).length - 1;
      if (opens >= closes) break;
      end--;
    } else if (".,;:!?".includes(ch)) {
      end--;
    } else {
      break;
    }
  }
  return { url: url.slice(0, end), trailing: url.slice(end) };
}

export type LinkSegment =
  | { type: "text"; value: string }
  | { type: "url"; value: string };

/**
 * 正規化後の文字列がリンク化に値する http(s) URL か検証する。
 * `http://` や `http://.` のようにホスト部が無い壊れた文字列を弾く。
 */
function isLinkableHttpUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  // ホスト名にドットを含む or localhost のみ許可 (http://. や http://, を弾く)
  return parsed.hostname.includes(".") || parsed.hostname === "localhost";
}

/**
 * テキストを「テキスト断片」と「URL 断片」の列に分解する。
 * 連続するテキストはまとめる。URL 末尾の句読点はテキスト側へ送る。
 */
export function splitTextWithUrls(text: string): LinkSegment[] {
  const segments: LinkSegment[] = [];
  let lastIndex = 0;
  const pushText = (value: string) => {
    if (!value) return;
    const last = segments[segments.length - 1];
    if (last && last.type === "text") last.value += value;
    else segments.push({ type: "text", value });
  };

  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null = URL_RE.exec(text);
  while (m !== null) {
    pushText(text.slice(lastIndex, m.index));
    const { url, trailing } = trimTrailingPunctuation(m[0]);
    // 正規化後にリンク化可能な URL か検証し、壊れた文字列 (http://. 等) は
    // text セグメントへ戻す (壊れた href を作らない)
    if (isLinkableHttpUrl(url)) {
      segments.push({ type: "url", value: url });
      if (trailing) pushText(trailing);
    } else {
      pushText(m[0]);
    }
    lastIndex = m.index + m[0].length;
    m = URL_RE.exec(text);
  }
  pushText(text.slice(lastIndex));
  return segments;
}
