/**
 * `.diagram.html` の読み書き補助。
 *
 * モデルは `<script type="application/json" id="ark-diagram-model">` に埋め込む。
 * `type="application/json"` なので実行されず、meta CSP の script-src の影響も受けない。
 *
 * CSP について（判断4.2.1 の実測）:
 * クライアントは HtmlViewerPane と同じく fetch → srcDoc で描画するため、
 * サーバーのレスポンスヘッダに付けた CSP は srcDoc 文書に適用されない。
 * 外部送信を止めるには本文に meta を差し込む必要がある。
 */

import { type ParseResult, parseDiagramModel } from "./diagram-model.js";

export const MODEL_SCRIPT_ID = "ark-diagram-model";

/**
 * 実測で遮断を確認した内容。外部 fetch は Failed to fetch になり、
 * インライン script とインライン style は動作を続ける。
 */
export const DIAGRAM_CSP =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
  `script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;">`;

/** モデル埋め込みブロックの中身を取り出して検証する */
export function extractModel(html: string): ParseResult {
  // id と type は順不同で書かれうるので、script タグ全体を拾ってから中身を判定する
  const scripts = html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi);
  for (const m of scripts) {
    const attrs = m[1] ?? "";
    if (!new RegExp(`id\\s*=\\s*["']${MODEL_SCRIPT_ID}["']`, "i").test(attrs))
      continue;
    return parseDiagramModel((m[2] ?? "").trim());
  }
  return {
    ok: false,
    error: `モデルブロックが見つかりません（<script type="application/json" id="${MODEL_SCRIPT_ID}">）`,
  };
}

/** 既存の CSP meta を除去したうえで、Ark が管理する meta CSP を先頭に差し込む */
export function injectCsp(html: string): string {
  const stripped = html.replace(
    /<meta\b[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi,
    ""
  );
  const headOpen = stripped.match(/<head\b[^>]*>/i);
  if (headOpen && headOpen.index !== undefined) {
    const at = headOpen.index + headOpen[0].length;
    return stripped.slice(0, at) + DIAGRAM_CSP + stripped.slice(at);
  }
  return DIAGRAM_CSP + stripped;
}
