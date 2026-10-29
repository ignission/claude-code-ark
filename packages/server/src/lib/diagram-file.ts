/**
 * `.diagram.html` の配信補助。
 *
 * ボードの図は Claude が自由に書いた HTML で、Ark は中身を解釈しない
 * (決まった部品や図種に当てはめると、文章を枠に入れただけの図になるため)。
 * Ark が足すのは、外部へ送らせないための meta CSP と、一覧に出す題名の取り出しだけ。
 *
 * CSP について（判断4.2.1 の実測）:
 * クライアントは HtmlViewerPane と同じく fetch → srcDoc で描画するため、
 * サーバーのレスポンスヘッダに付けた CSP は srcDoc 文書に適用されない。
 * 外部送信を止めるには本文に meta を差し込む必要がある。
 */

/**
 * 実測で遮断を確認した内容。外部 fetch は Failed to fetch になり、
 * インライン script とインライン style は動作を続ける。
 */
export const DIAGRAM_CSP =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
  `script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;">`;

/** 先頭 doctype の一致（BOM・空白は許容） */
const LEADING_DOCTYPE_RE = /^[﻿\s]*<!doctype[^>]*>/i;
const TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title>/i;

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
};

/** `<title>` の文字列。無いか空なら null */
export function extractTitle(html: string): string | null {
  const match = html.match(TITLE_RE);
  if (!match) return null;
  const title = (match[1] ?? "")
    .replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, name: string) => {
      return HTML_ENTITIES[name] ?? "";
    })
    .replace(/\s+/g, " ")
    .trim();
  return title || null;
}

/** 既存の CSP meta を除去したうえで、Ark が管理する meta CSP を差し込む */
export function injectCsp(html: string): string {
  // 既存の CSP meta を除去（引用符あり/なし両対応）。
  // HTML コメント内の <head> 誤検出を避けるため <head> は探さず、文書先頭
  // （doctype があればその直後）に差し込む。HTML5 パーサは先頭の <meta> を
  // 暗黙の <head> の最初の子として復旧するため、位置に依存せず境界を確保できる。
  const stripped = html.replace(
    /<meta\b[^>]*http-equiv\s*=\s*(?:["']?Content-Security-Policy["']?)[^>]*>/gi,
    ""
  );
  // doctype がある場合はその直後に置く。doctype より前に要素を置くと、
  // /api/diagram を直接ブラウザで開いた場合に doctype が先頭トークンで
  // なくなり quirks mode になる（srcDoc 描画は仕様上常に no-quirks のため
  // 影響しないが、直接閲覧経路も正しくしておく）。先頭アンカーの一致に
  // 限るため、コメント内の偽 doctype で位置をずらすことはできない。
  const doctype = stripped.match(LEADING_DOCTYPE_RE);
  if (doctype) {
    const at = doctype[0].length;
    return stripped.slice(0, at) + DIAGRAM_CSP + stripped.slice(at);
  }
  return DIAGRAM_CSP + stripped;
}
