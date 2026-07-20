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
    // id だけで一致させると <script id="ark-diagram-model">（type 無し）も
    // 拾ってしまう。type 無しの script はブラウザが JS として実行するため、
    // サーバー検証（id 一致）を通る一方でブラウザは実行する、という契約と
    // 実装のずれが生まれる。skill / このファイル先頭のコメントが要求する
    // type="application/json" もここで検証する。
    if (!/type\s*=\s*["']application\/json["']/i.test(attrs)) continue;
    return parseDiagramModel((m[2] ?? "").trim());
  }
  return {
    ok: false,
    error: `モデルブロックが見つかりません（<script type="application/json" id="${MODEL_SCRIPT_ID}">）`,
  };
}

/** 既存の CSP meta を除去したうえで、Ark が管理する meta CSP を先頭に差し込む */
export function injectCsp(html: string): string {
  // 既存の CSP meta を除去（引用符あり/なし両対応）。
  // HTML コメント内の <head> 誤検出を避けるため、常に文書先頭に prepend し、
  // head の有無や位置に依存しない。HTML5 パーサは先頭の <meta> を暗黙の <head> の
  // 最初の子として復旧するため、この方法でセキュリティ境界を確保できる。
  const stripped = html.replace(
    /<meta\b[^>]*http-equiv\s*=\s*(?:["']?Content-Security-Policy["']?)[^>]*>/gi,
    ""
  );
  return DIAGRAM_CSP + stripped;
}
