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

// --- モデルブロック判定の共有部品（extractModel と replaceModelBlock で使う） ---
// 定数として1度だけ組み、script タグごとの再コンパイルを避ける（extractModel /
// replaceModelBlock は /api/diagram・board_open・diagram:submit の各経路で通る）。

/** 先頭 doctype の一致（BOM・空白は許容）。ensureDoctype / injectCsp で共用する */
const LEADING_DOCTYPE_RE = /^[﻿\s]*<!doctype[^>]*>/i;
/** script タグ全体（属性 = $1、本文 = $2） */
const SCRIPT_TAG_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const MODEL_ID_ATTR_RE = new RegExp(
  `id\\s*=\\s*["']${MODEL_SCRIPT_ID}["']`,
  "i"
);
const MODEL_TYPE_ATTR_RE = /type\s*=\s*["']application\/json["']/i;
const MODEL_BLOCK_NOT_FOUND = `モデルブロックが見つかりません（<script type="application/json" id="${MODEL_SCRIPT_ID}">）`;

/**
 * script タグの属性がモデルブロック（id 一致 + type="application/json"）かを判定する。
 *
 * id だけで一致させると <script id="ark-diagram-model">（type 無し）も拾い、
 * ブラウザはそれを JS として実行してしまう（サーバー検証は通るのに実行される、
 * という契約と実装のずれ）。type もここで必ず検証する。
 */
function isModelScriptAttrs(attrs: string): boolean {
  return MODEL_ID_ATTR_RE.test(attrs) && MODEL_TYPE_ATTR_RE.test(attrs);
}

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
  if (LEADING_DOCTYPE_RE.test(html)) return html;
  return `<!doctype html>\n${html}`;
}

/** モデル埋め込みブロックの中身を取り出して検証する */
export function extractModel(html: string): ParseResult {
  // id と type は順不同で書かれうるので、script タグ全体を拾ってから中身を判定する
  for (const m of html.matchAll(SCRIPT_TAG_RE)) {
    if (!isModelScriptAttrs(m[1] ?? "")) continue;
    return parseDiagramModel((m[2] ?? "").trim());
  }
  return { ok: false, error: MODEL_BLOCK_NOT_FOUND };
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
  const next = html.replace(SCRIPT_TAG_RE, (match: string, attrs: string) => {
    if (replaced) return match; // 最初に一致したブロックだけを差し替える
    if (!isModelScriptAttrs(attrs)) return match;
    replaced = true;
    // `<` を < に退避する。JSON.stringify は `<` をエスケープしないため、
    // label や ext に `</script >`（`>` の前が空白/改行/`/` でもブラウザの
    // script-data トークナイザは終了扱い）を仕込むと、application/json の
    // モデルブロックをブレイクアウトして後続のインライン script が
    // script-src 'unsafe-inline' の下で実行されてしまう。application/json
    // として JSON.parse すると < は `<` に戻るため往復は保たれる。
    const json = JSON.stringify(model, null, 2).replace(/</g, "\\u003c");
    return `<script${attrs}>\n${json}\n</script>`;
  });
  if (!replaced) {
    return { ok: false, error: MODEL_BLOCK_NOT_FOUND };
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
  const doctype = stripped.match(LEADING_DOCTYPE_RE);
  if (doctype) {
    const at = doctype[0].length;
    return stripped.slice(0, at) + DIAGRAM_CSP + stripped.slice(at);
  }
  return DIAGRAM_CSP + stripped;
}
