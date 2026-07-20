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

import {
  type DiagramModel,
  type ParseResult,
  parseDiagramModel,
} from "./diagram-model.js";

export const MODEL_SCRIPT_ID = "ark-diagram-model";

/**
 * 実測で遮断を確認した内容。外部 fetch は Failed to fetch になり、
 * インライン script とインライン style は動作を続ける。
 */
export const DIAGRAM_CSP =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
  `script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;">`;

/**
 * doctype が無ければ先頭に補う。
 *
 * 編集ハーネスが送る HTML は document.documentElement.outerHTML 由来のため
 * doctype を含まない。そのまま保存すると送信のたびにファイルから doctype が
 * 落ちる（quirks mode の火種になり、git diff にもノイズが出る）ので、
 * diagram:submit の保存直前にこれを通す。
 * 先頭の BOM・空白は許容し、既にあれば大文字小文字を問わず何もしない。
 */
export function ensureDoctype(html: string): string {
  if (/^[﻿\s]*<!doctype\b/i.test(html)) return html;
  return `<!doctype html>\n${html}`;
}

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

export type ReplaceModelResult =
  | { ok: true; html: string }
  | { ok: false; error: string };

/**
 * html 内のモデル埋め込みブロック（<script type="application/json"
 * id="ark-diagram-model">）の中身だけを model で差し替える。投影（DOM）側は
 * 一切変更しない。
 *
 * ハーネス（diagram-harness.ts）はモデル編集を state.model 側だけに反映し、
 * DOM 上の script タグは書き戻さない。そのためクライアントから届く html 内の
 * モデルブロックは編集前の古い JSON のままであることがある。保存前にここで
 * 最新の model へ差し替え、「古いモデル + 新しい DOM」のずれを防ぐ。
 *
 * 対象ブロックの判定は extractModel と同じ規則（id 一致 + type 一致）にし、
 * 書式（開始/終了タグの前後改行）も揃える。
 */
export function replaceModelBlock(
  html: string,
  model: DiagramModel
): ReplaceModelResult {
  let replaced = false;
  const next = html.replace(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
    (match: string, attrs: string) => {
      if (replaced) return match; // 最初に一致したブロックだけを差し替える
      if (!new RegExp(`id\\s*=\\s*["']${MODEL_SCRIPT_ID}["']`, "i").test(attrs))
        return match;
      if (!/type\s*=\s*["']application\/json["']/i.test(attrs)) return match;
      replaced = true;
      return `<script${attrs}>\n${JSON.stringify(model, null, 2)}\n</script>`;
    }
  );
  if (!replaced) {
    return {
      ok: false,
      error: `モデルブロックが見つかりません（<script type="application/json" id="${MODEL_SCRIPT_ID}">）`,
    };
  }
  return { ok: true, html: next };
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
  const doctype = stripped.match(/^[﻿\s]*<!doctype[^>]*>/i);
  if (doctype) {
    const at = doctype[0].length;
    return stripped.slice(0, at) + DIAGRAM_CSP + stripped.slice(at);
  }
  return DIAGRAM_CSP + stripped;
}
