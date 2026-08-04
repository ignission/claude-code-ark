/**
 * 図の編集ハーネス（Ark が `.diagram.html` の配信時に注入する JS/CSS）。
 *
 * 生成物（Claude が書く `.diagram.html`）にはハーネス自身を書かせない。
 * 書かせてしまうと「書かなければ編集できない」状態になり、既存の図（旧世代の
 * 生成物）が編集不能になってしまうため、常にサーバー側（配信時）で注入する。
 *
 * ## 二重注入の防止と DIAGRAM_HARNESS_MARKER の一意性
 *
 * `injectHarness` は既に注入済みかどうかを `html.includes(DIAGRAM_HARNESS_MARKER)`
 * で判定する。このマーカー文字列は注入する `<script>` タグの `id` 属性としてのみ
 * 現れる契約になっている。ハーネス JS 本体（`HARNESS_JS`）や CSS（`HARNESS_STYLE`）
 * の中では絶対にこの文字列を使わないこと。自分自身（script/style タグ）を
 * 実行時に識別する必要がある箇所は、マーカーではなく別途 `data-ark-harness-ui`
 * 属性（静的にテンプレートへ書き込み済み）を使う。マーカーが 2 箇所以上に
 * 出現すると、二重注入防止のテスト（同一マーカーの出現回数が 1 であること）が壊れる。
 *
 * ## UI 要素の識別と送信時のクリーンアップ
 *
 * ハーネスが追加する DOM（ツールバー・行コントロール・トグルパネル等）には
 * すべて `data-ark-harness-ui` を付け、「変更を送る」時の HTML 生成
 * （`buildSubmissionHtml`）で丸ごと取り除く。編集用に元要素をラップした
 * テキスト span には `data-ark-harness-wrap` を付け、中身は残してラップだけ
 * 解除する。CSS クラスはすべて `ark-harness-` 接頭辞を付け、送信時に取り除く
 * （生成物のクラスと衝突しないことに加え、送信 HTML に編集モードの痕跡を
 * 残さないため）。
 */

import { MODEL_SCRIPT_ID } from "./diagram-file.js";
import { layoutDiagram } from "./diagram-layout.js";

/**
 * 二重注入検出に使うマーカー。注入する `<script>` タグの id 属性の値として
 * 一度だけ現れる（HARNESS_JS / HARNESS_STYLE の中では絶対に使わない）。
 */
export const DIAGRAM_HARNESS_MARKER = "ark-diagram-harness";

/**
 * 注入サイズを抑えるため、既知の trusted source から文字列外の空白だけを除く。
 * 対象区間には comment と、空白を含む正規表現 literal を置かない。
 */
function compactTrustedJavaScript(source: string): string {
  let result = "";
  let quote = "";
  let escaped = false;
  const isWord = (character: string | undefined) =>
    character !== undefined && /[A-Za-z0-9_$]/.test(character);
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      result += character;
      continue;
    }
    if (/\s/.test(character)) {
      let next = index + 1;
      while (next < source.length && /\s/.test(source[next])) next += 1;
      if (isWord(result.at(-1)) && isWord(source[next])) result += " ";
      index = next - 1;
      continue;
    }
    result += character;
  }
  return result;
}

const GROUP_LAYOUT_KERNEL_SOURCE = compactTrustedJavaScript(
  layoutDiagram.toString()
);

const HARNESS_STYLE = `<style data-ark-harness-ui="1">
.ark-harness-toolbar {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483647;
  display: flex; align-items: center; gap: .5rem;
  padding: .6rem .75rem; background: #11131a; border-top: 1px solid #2a2f3a;
  font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif;
  font-size: 12.5px; color: #e6e8ee; box-shadow: 0 -2px 12px rgba(0,0,0,.35);
}
.ark-harness-spacer { flex: 1 1 auto; }
.ark-harness-status { color: #8b93a7; font-size: 11.5px; margin-right: .25rem; }
.ark-harness-status-ok { color: #34d399; }
.ark-harness-btn {
  appearance: none; border: 1px solid #333947; background: #1b1e27; color: #e6e8ee;
  border-radius: 6px; padding: .4rem .75rem; font-size: 12.5px; cursor: pointer; line-height: 1;
}
.ark-harness-btn:hover { background: #232732; }
.ark-harness-btn:disabled { opacity: .45; cursor: not-allowed; }
.ark-harness-layout-direction { min-width: 5.5rem; }
.ark-harness-btn-primary { background: #0ea5b7; border-color: #0ea5b7; color: #05201f; font-weight: 600; }
.ark-harness-btn-primary:hover { background: #14b8c9; }
.ark-harness-btn-primary:disabled { background: #1b1e27; border-color: #333947; color: #8b93a7; }
.ark-harness-model-panel {
  position: fixed; left: .75rem; right: .75rem; bottom: 3.4rem; z-index: 2147483646;
  max-height: 60vh; display: flex; flex-direction: column; gap: .4rem;
  background: #11131a; border: 1px solid #2a2f3a; border-radius: 8px; padding: .75rem;
  box-shadow: 0 -4px 20px rgba(0,0,0,.45);
  font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif;
}
.ark-harness-model-panel-label { color: #8b93a7; font-size: 11.5px; }
.ark-harness-textarea {
  flex: 1 1 auto; min-height: 12rem; resize: vertical; background: #0b0d12; color: #d7ecff;
  border: 1px solid #2a2f3a; border-radius: 6px; padding: .5rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.5;
}
.ark-harness-model-error { color: #f87171; font-size: 11.5px; white-space: pre-wrap; }
.ark-harness-model-actions { display: flex; gap: .5rem; justify-content: flex-end; }
.ark-harness-editable { outline: 1px dashed transparent; border-radius: 3px; }
.ark-harness-editable:empty::before { content: attr(data-placeholder); color: rgba(148,163,184,.7); pointer-events: none; }
.ark-harness-editable:hover { outline-color: rgba(56,189,248,.35); }
.ark-harness-editable:focus { outline: 1px solid #38bdf8; outline-offset: 1px; background: rgba(56,189,248,.1); }
.ark-harness-note { white-space: pre-wrap; min-height: 1.5em; padding: .4rem .6rem; outline: none; }
.ark-harness-note:empty::before { content: attr(data-placeholder); color: rgba(148,163,184,.7); pointer-events: none; }
li.ark-harness-row { display: flex; align-items: center; gap: .35rem; }
li.ark-harness-row .ark-harness-text { flex: 1 1 auto; min-width: 0; }
.ark-harness-dragging { opacity: .4; }
.ark-harness-handle, .ark-harness-delete {
  flex: 0 0 auto; border: none; background: transparent; cursor: pointer;
  width: 1.4rem; height: 1.4rem; line-height: 1.4rem; text-align: center; border-radius: 4px;
  font-size: 11px; color: #6b7280; padding: 0;
}
.ark-harness-handle { cursor: grab; }
.ark-harness-handle:hover { background: rgba(255,255,255,.08); color: #d7dee8; }
.ark-harness-delete:hover { background: rgba(248,113,113,.2); color: #f87171; }
[data-ark-container="graph"] { position: relative; }
[data-ark-container="graph"].ark-harness-graph-layout {
  min-width: var(--ark-harness-graph-min-width); min-height: var(--ark-harness-graph-min-height);
}
.ark-harness-graph-group { position: absolute; z-index: 0; }
.ark-harness-graph-node {
  position: absolute; left: var(--ark-harness-graph-x); top: var(--ark-harness-graph-y); z-index: 2;
}
.ark-harness-kind-select {
  appearance: auto; max-width: 9rem; min-width: 4.5rem; padding: .18rem .25rem;
  border: 1px solid rgba(100,116,139,.55); border-radius: 4px;
  background: rgba(255,255,255,.94); color: #334155; font: 11px/1.2 sans-serif;
  cursor: pointer;
}
.ark-harness-edge-layer {
  position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%;
  overflow: visible; pointer-events: none;
}
.ark-harness-edge-layer line, .ark-harness-edge-layer path {
  fill: none; stroke: #64748b; stroke-width: 1.5;
}
.ark-harness-edge-cardinality circle {
  fill: #fff; stroke: #64748b; stroke-width: 1.5;
}
.ark-harness-edge-cardinality line {
  stroke: #64748b; stroke-width: 1.5;
}
.ark-harness-edge-layer text {
  fill: #475569; font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif;
  font-size: 12px; text-anchor: middle; dominant-baseline: central;
}
.ark-harness-edge-hit-target {
  stroke: transparent !important; stroke-width: 18 !important; pointer-events: stroke;
}
.ark-harness-edge-handle-layer {
  position: absolute; inset: 0; z-index: 3; pointer-events: none;
}
.ark-harness-edge-preview-layer {
  position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%;
  overflow: visible; pointer-events: none;
}
.ark-harness-edge-handle {
  position: absolute; transform: translate(-50%, -50%); z-index: 5;
  width: 18px; height: 18px; padding: 0; border: 2px solid #0ea5b7; border-radius: 999px;
  background: #fff; color: #0e7490; cursor: crosshair; line-height: 14px; font-size: 9px;
  pointer-events: auto; touch-action: none;
}
.ark-harness-node-connectors {
  position: absolute; inset: 0; z-index: 4; opacity: 0; pointer-events: none;
  transition: opacity .12s ease;
}
.ark-harness-node-anchor {
  position: absolute; width: 12px; height: 12px; padding: 0;
  transform: translate(-50%, -50%); border: 2px solid #0ea5b7; border-radius: 999px;
  background: #fff; color: #0e7490; font: 9px/8px sans-serif;
  cursor: crosshair; touch-action: none; pointer-events: none;
  transition: transform .12s ease;
}
.ark-harness-node-connectors.ark-harness-node-connectors-visible {
  opacity: 1;
}
.ark-harness-node-connectors.ark-harness-node-connectors-visible > .ark-harness-node-anchor {
  pointer-events: auto;
}
.ark-harness-node-anchor:hover { transform: translate(-50%, -50%) scale(1.15); }
.ark-harness-edge-dragging .ark-harness-node-connectors {
  opacity: 0; pointer-events: none;
}
.ark-harness-edge-dragging .ark-harness-node-anchor { pointer-events: none !important; }
.ark-harness-edge-control {
  box-sizing: border-box; min-width: 108px; padding: 2px 3px;
  border: 1px solid rgba(100,116,139,.65); border-radius: 4px;
  background: rgba(255,255,255,.97); color: #334155; font: 10px/1.2 sans-serif;
}
.ark-harness-edge-preview {
  position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none;
}
.ark-harness-edge-preview line {
  stroke: #0ea5b7; stroke-width: 2; stroke-dasharray: 5 4;
}
.ark-harness-edge-delete-pending { cursor: not-allowed !important; }
.ark-harness-edge-main.ark-harness-edge-delete-pending {
  opacity: .28; stroke-width: 1;
}
.ark-harness-edge-preview.ark-harness-edge-delete-pending line {
  stroke: #dc2626; stroke-width: 1; stroke-dasharray: 2 5; opacity: .55;
}
.ark-harness-edge-handle.ark-harness-edge-delete-pending {
  border-color: #dc2626; background: #fee2e2; color: #b91c1c;
}
.ark-harness-edge-drop-indicator {
  position: absolute; box-sizing: border-box; border: 2px solid #0ea5b7;
  border-radius: 8px; background: transparent; pointer-events: none;
}
.ark-harness-graph-node.ark-harness-node-selected {
  outline: 2px solid #0ea5b7; outline-offset: 3px;
}
.ark-harness-edge-main.ark-harness-edge-selected {
  stroke: #0ea5b7; stroke-width: 3;
}
.ark-harness-context-toolbar {
  position: fixed; z-index: 2147483647; display: flex; align-items: center; gap: .35rem;
  box-sizing: border-box; max-width: calc(100vw - 16px); padding: .35rem;
  border: 1px solid rgba(100,116,139,.55); border-radius: 7px;
  background: rgba(255,255,255,.98); color: #334155;
  box-shadow: 0 4px 14px rgba(15,23,42,.22); font: 11px/1.2 sans-serif;
}
.ark-harness-toolbar, .ark-harness-context-toolbar { animation: ark-harness-in .12s ease-out; }
@keyframes ark-harness-in { from { opacity: 0; transform: translateY(4px); } }
.ark-harness-context-toolbar[hidden] { display: none; }
.ark-harness-context-toolbar button {
  appearance: none; border: 1px solid rgba(100,116,139,.55); border-radius: 4px;
  background: #fff; color: #334155; padding: .25rem .45rem; font: inherit; cursor: pointer;
}
.ark-harness-context-toolbar button:disabled,
.ark-harness-context-toolbar select:disabled { opacity: .45; cursor: not-allowed; }
.ark-harness-context-toolbar .ark-harness-node-delete,
.ark-harness-context-toolbar .ark-harness-edge-delete { color: #b91c1c; }
.ark-harness-graph-dragging { z-index: 3; }
body { padding-bottom: var(--ark-harness-toolbar-height, 3.4rem) !important; }
</style>`;

/**
 * ブラウザで実行するハーネス本体。バッククォート（テンプレートリテラル）を
 * 使うと TS 側のテンプレートリテラルとネストして壊れるため、文字列連結のみで
 * 書く。model script id と trusted kernel の function literal を TS 側で埋め込む。
 */
const RAW_HARNESS_JS = `(function () {
  "use strict";

  var MODEL_SCRIPT_ID = "${MODEL_SCRIPT_ID}";
  var groupAwareLayout = ${GROUP_LAYOUT_KERNEL_SOURCE};
  var GROUP_GEOMETRY_PROPERTIES = [
    "--ark-harness-group-x",
    "--ark-harness-group-y",
    "--ark-harness-group-width",
    "--ark-harness-group-height"
  ];
  var GRAPH_LAYOUT_PROPERTIES = [
    "--ark-harness-graph-min-width",
    "--ark-harness-graph-min-height"
  ];
  var AFFORDANCE_CLOSE_DELAY = 120;
  var EDGE_DRAG_MIN_DISTANCE = 8;
  var CARDINALITY_VALUES = [
    "one", "many", "zero-or-one", "one-or-many", "zero-or-many"
  ];
  var DIRECTION_VALUES = ["forward", "reverse", "both", "none"];
  var CARDINALITY_LABELS = {
    "one": "1",
    "many": "N",
    "zero-or-one": "0..1",
    "one-or-many": "1..N",
    "zero-or-many": "0..N"
  };
  var DIRECTION_LABELS = {
    "forward": "\\u2192",
    "reverse": "\\u2190",
    "both": "\\u2194",
    "none": "\\u77E2\\u5370\\u306A\\u3057"
  };

  var BLOCK_TAGS = {
    DIV: 1, UL: 1, OL: 1, LI: 1, TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, TD: 1, TH: 1,
    SECTION: 1, ARTICLE: 1, HEADER: 1, FOOTER: 1, NAV: 1, ASIDE: 1, FIGURE: 1,
    FIGCAPTION: 1, FORM: 1, FIELDSET: 1, BLOCKQUOTE: 1, PRE: 1,
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, P: 1, HR: 1, DL: 1, DT: 1, DD: 1
  };

  var state = { model: null };
  var submitPort = null;
  var dragSrcLi = null;
  var graphDrag = null;
  var edgeDrag = null;
  var graphs = [];
  var graphSequence = 0;
  var kindCandidates = [];
  var lastKind = null;
  var reservedModelIds = new Set();
  var generatedIdCounter = 0;
  var selection = { kind: null, id: null };
  var selectionGraph = null;
  var contextToolbar = null;
  var toolbarPositionFrame = null;
  var selectionResizeObserver = null;
  var listBindingsByNode = new Map();
  var statusEl = null;
  var sendBtn = null;
  var layoutDirectionBtn = null;
  var toolbarEl = null;
  var baselineModelJson;
  var savedJson, savingJson, autosaveTimer, submitPending;

  function isRecordObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  function collectModelIds(model) {
    var ids = new Set();
    var reserve = function (entry) {
      if (entry && typeof entry.id === "string") ids.add(entry.id);
    };
    (model.nodes || []).forEach(function (node) {
      reserve(node);
      (node.fields || []).forEach(reserve);
    });
    (model.edges || []).forEach(reserve);
    (model.groups || []).forEach(reserve);
    return ids;
  }

  function reserveCurrentModelIds() {
    collectModelIds(state.model || {}).forEach(function (id) {
      reservedModelIds.add(id);
    });
  }

  function randomOpaquePart() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      try {
        return window.crypto.randomUUID();
      } catch (_) {
        // getRandomValues fallback へ進む
      }
    }
    if (window.crypto && typeof window.crypto.getRandomValues === "function") {
      try {
        var bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);
        var encoded = "";
        for (var i = 0; i < bytes.length; i++) {
          encoded += bytes[i].toString(16).padStart(2, "0");
        }
        return encoded;
      } catch (_) {
        // counter fallback へ進む
      }
    }
    generatedIdCounter += 1;
    return "session-" + generatedIdCounter;
  }

  function generateUniqueModelId(prefix) {
    for (var attempt = 0; attempt < 32; attempt++) {
      var candidate = prefix + "-" + randomOpaquePart();
      if (reservedModelIds.has(candidate)) continue;
      reservedModelIds.add(candidate);
      return candidate;
    }
    return null;
  }

  function loadModel() {
    var scriptEl = document.getElementById(MODEL_SCRIPT_ID);
    if (!scriptEl) {
      console.warn("[ark-harness] モデルブロックが見つかりません");
      return null;
    }
    try {
      var parsed = JSON.parse(scriptEl.textContent || "");
      if (!isRecordObject(parsed)) throw new Error("モデルはオブジェクトではありません");
      if (!Array.isArray(parsed.nodes)) parsed.nodes = [];
      if (!Array.isArray(parsed.edges)) parsed.edges = [];
      if (!Array.isArray(parsed.groups)) parsed.groups = [];
      return parsed;
    } catch (e) {
      console.warn("[ark-harness] モデル JSON を解析できません", e);
      return null;
    }
  }

  function getNode(model, id) {
    var nodes = model.nodes || [];
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].id === id) return nodes[i];
    }
    return null;
  }

  function decodeCssEscapes(value) {
    return value.replace(/\\\\([0-9a-fA-F]{1,6}[ \\t\\r\\n\\f]?|[\\s\\S])/g, function (_, escaped) {
      var hex = escaped.trim();
      if (/^[0-9a-fA-F]{1,6}$/.test(hex)) {
        var codePoint = parseInt(hex, 16);
        if (codePoint === 0 || codePoint > 1114111 ||
            (codePoint >= 55296 && codePoint <= 57343)) {
          return "\\uFFFD";
        }
        return String.fromCodePoint(codePoint);
      }
      if (escaped === "\\n" || escaped === "\\r" || escaped === "\\f") return "";
      return escaped;
    });
  }

  function collectKindRules(rules, seen, values) {
    if (!rules || values.length >= 128) return;
    for (var i = 0; i < rules.length && values.length < 128; i++) {
      var rule = rules[i];
      if (typeof rule.selectorText === "string") {
        var pattern = /\\[\\s*data-kind\\s*=\\s*(?:"((?:\\\\[\\s\\S]|[^"\\\\])*)"|'((?:\\\\[\\s\\S]|[^'\\\\])*)'|((?:\\\\[\\s\\S]|[^\\s\\]])+))\\s*\\]/gi;
        var match = null;
        while ((match = pattern.exec(rule.selectorText)) !== null &&
               values.length < 128) {
          var encoded = match[1] !== undefined ? match[1]
            : match[2] !== undefined ? match[2] : match[3];
          var value = decodeCssEscapes(encoded);
          if (value && value.length <= 256 && !seen.has(value)) {
            seen.add(value);
            values.push(value);
          }
        }
      }
      var nested = null;
      try {
        nested = rule.cssRules;
      } catch (_) {
        nested = null;
      }
      if (nested) collectKindRules(nested, seen, values);
    }
  }

  function collectKindCandidates() {
    var seen = new Set();
    var values = [];
    document.querySelectorAll("style:not([data-ark-harness-ui])").forEach(function (style) {
      var rules = null;
      try {
        rules = style.sheet && style.sheet.cssRules;
      } catch (_) {
        rules = null;
      }
      if (rules) collectKindRules(rules, seen, values);
    });
    var nodes = state.model && Array.isArray(state.model.nodes)
      ? state.model.nodes
      : [];
    nodes.forEach(function (node) {
      var value = node && node.kind;
      if (typeof value === "string" && value && !seen.has(value)) {
        seen.add(value);
        values.push(value);
      }
    });
    return values;
  }

  function getGroup(model, id) {
    var groups = model.groups || [];
    for (var i = 0; i < groups.length; i++) {
      if (groups[i].id === id) return groups[i];
    }
    return null;
  }

  function getEdge(model, id) {
    var edges = model.edges || [];
    for (var i = 0; i < edges.length; i++) {
      if (edges[i].id === id) return edges[i];
    }
    return null;
  }

  function finiteNumber(v) {
    return typeof v === "number" && Number.isFinite(v);
  }

  function graphPosition(node) {
    if (!node || !isRecordObject(node.ext)) return null;
    if (!finiteNumber(node.ext.x) || !finiteNumber(node.ext.y)) return null;
    return { x: node.ext.x, y: node.ext.y };
  }

  function readLayoutConfig(model) {
    var layout = isRecordObject(model && model.ext) && isRecordObject(model.ext.layout)
      ? model.ext.layout
      : {};
    var bounded = function (value, fallback, maximum) {
      return finiteNumber(value) && value >= 0 ? Math.min(value, maximum) : fallback;
    };
    return {
      direction: layout.direction === "TB" ? "TB" : "LR",
      rankSpacing: bounded(layout.rankSpacing, 96, 512),
      nodeSpacing: bounded(layout.nodeSpacing, 48, 512),
      padding: bounded(layout.padding, 24, 256)
    };
  }

  function syncLayoutDirectionButton() {
    if (!layoutDirectionBtn || !state.model) return;
    var direction = readLayoutConfig(state.model).direction;
    var nextDirection = direction === "LR" ? "TB" : "LR";
    var visibleLabel = "方向: " + direction;
    var label = visibleLabel + "（現在 " + direction + "。" + nextDirection + " に切り替える）";
    layoutDirectionBtn.textContent = visibleLabel;
    layoutDirectionBtn.setAttribute("aria-label", label);
    layoutDirectionBtn.title = label;
  }

  function toggleLayoutDirection() {
    if (!state.model) return;
    var direction = readLayoutConfig(state.model).direction;
    var nextDirection = direction === "LR" ? "TB" : "LR";
    if (!isRecordObject(state.model.ext)) state.model.ext = {};
    if (!isRecordObject(state.model.ext.layout)) state.model.ext.layout = {};
    state.model.ext.layout.direction = nextDirection;
    syncLayoutDirectionButton();
    graphs.forEach(function (graph) { scheduleGraphRender(graph); });
  }

  function graphModelNodes(graph) {
    var result = [];
    var nodes = state.model && Array.isArray(state.model.nodes) ? state.model.nodes : [];
    nodes.forEach(function (node, index) {
      if (!node || typeof node.id !== "string") return;
      var el = graph.nodesById.get(node.id);
      if (el) result.push({ id: node.id, node: node, el: el, index: index });
    });
    return result;
  }

  function assignLayerRanks(graph) {
    var entries = graphModelNodes(graph);
    var indexById = new Map();
    var adjacency = new Map();
    entries.forEach(function (entry) {
      indexById.set(entry.id, entry.index);
      adjacency.set(entry.id, []);
    });
    var seenEdges = new Set();
    var edges = state.model && Array.isArray(state.model.edges) ? state.model.edges : [];
    edges.forEach(function (edge) {
      if (!edge || edge.from === edge.to || !adjacency.has(edge.from) || !adjacency.has(edge.to)) {
        return;
      }
      var key = edge.from + "\u0000" + edge.to;
      if (seenEdges.has(key)) return;
      seenEdges.add(key);
      adjacency.get(edge.from).push(edge.to);
    });
    adjacency.forEach(function (targets) {
      targets.sort(function (left, right) {
        return indexById.get(left) - indexById.get(right);
      });
    });

    var nextIndex = 0;
    var stack = [];
    var onStack = new Set();
    var indexes = new Map();
    var lowLinks = new Map();
    var components = [];
    var visit = function (id) {
      indexes.set(id, nextIndex);
      lowLinks.set(id, nextIndex);
      nextIndex += 1;
      stack.push(id);
      onStack.add(id);
      adjacency.get(id).forEach(function (target) {
        if (!indexes.has(target)) {
          visit(target);
          lowLinks.set(id, Math.min(lowLinks.get(id), lowLinks.get(target)));
        } else if (onStack.has(target)) {
          lowLinks.set(id, Math.min(lowLinks.get(id), indexes.get(target)));
        }
      });
      if (lowLinks.get(id) !== indexes.get(id)) return;
      var component = [];
      var member = null;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== id);
      component.sort(function (left, right) {
        return indexById.get(left) - indexById.get(right);
      });
      components.push(component);
    };
    entries.forEach(function (entry) {
      if (!indexes.has(entry.id)) visit(entry.id);
    });
    components.sort(function (left, right) {
      return indexById.get(left[0]) - indexById.get(right[0]);
    });

    var componentById = new Map();
    var componentOrder = [];
    components.forEach(function (component, componentIndex) {
      componentOrder[componentIndex] = indexById.get(component[0]);
      component.forEach(function (id) { componentById.set(id, componentIndex); });
    });
    var outgoing = components.map(function () { return new Set(); });
    var indegrees = components.map(function () { return 0; });
    adjacency.forEach(function (targets, from) {
      var fromComponent = componentById.get(from);
      targets.forEach(function (to) {
        var toComponent = componentById.get(to);
        if (fromComponent === toComponent || outgoing[fromComponent].has(toComponent)) return;
        outgoing[fromComponent].add(toComponent);
        indegrees[toComponent] += 1;
      });
    });
    var queue = [];
    indegrees.forEach(function (degree, componentIndex) {
      if (degree === 0) queue.push(componentIndex);
    });
    var byOrder = function (left, right) {
      return componentOrder[left] - componentOrder[right];
    };
    queue.sort(byOrder);
    var componentRanks = components.map(function () { return 0; });
    while (queue.length > 0) {
      var current = queue.shift();
      Array.from(outgoing[current]).sort(byOrder).forEach(function (target) {
        componentRanks[target] = Math.max(
          componentRanks[target],
          componentRanks[current] + 1
        );
        indegrees[target] -= 1;
        if (indegrees[target] === 0) {
          queue.push(target);
          queue.sort(byOrder);
        }
      });
    }
    var ranks = new Map();
    entries.forEach(function (entry) {
      ranks.set(entry.id, componentRanks[componentById.get(entry.id)] || 0);
    });
    return ranks;
  }

  function rectanglesCollide(left, right, gap) {
    return left.x < right.x + right.width + gap &&
      left.x + left.width + gap > right.x &&
      left.y < right.y + right.height + gap &&
      left.y + left.height + gap > right.y;
  }

  function applyLayoutPositions(graph, entries, measured, nextPositions, config) {
    var maxRight = 0;
    var maxBottom = 0;
    entries.forEach(function (entry) {
      var position = nextPositions.get(entry.id);
      var size = measured.get(entry.id);
      if (!position || !size) return;
      var previous = graph.positionsById.get(entry.id);
      if (!previous || previous.x !== position.x || previous.y !== position.y) {
        entry.el.style.setProperty("--ark-harness-graph-x", position.x + "px");
        entry.el.style.setProperty("--ark-harness-graph-y", position.y + "px");
      }
      maxRight = Math.max(maxRight, position.x + size.width);
      maxBottom = Math.max(maxBottom, position.y + size.height);
    });
    graph.positionsById = nextPositions;
    var minWidth = Math.ceil(maxRight + config.padding) + "px";
    var minHeight = Math.ceil(maxBottom + config.padding) + "px";
    if (graph.layoutExtent.width !== minWidth) {
      graph.container.style.setProperty("--ark-harness-graph-min-width", minWidth);
      graph.layoutExtent.width = minWidth;
    }
    if (graph.layoutExtent.height !== minHeight) {
      graph.container.style.setProperty("--ark-harness-graph-min-height", minHeight);
      graph.layoutExtent.height = minHeight;
    }
    graph.container.classList.add("ark-harness-graph-layout");
  }

  function freezeGraphPositions(graph) {
    graphModelNodes(graph).forEach(function (entry) {
      if (graphPosition(entry.node)) return;
      var pos = graph.positionsById.get(entry.id);
      if (!pos) return;
      if (!isRecordObject(entry.node.ext)) entry.node.ext = {};
      entry.node.ext.x = pos.x;
      entry.node.ext.y = pos.y;
    });
  }

  function layoutGraph(graph) {
    var config = readLayoutConfig(state.model);
    var direction = config.direction;
    var entries = graphModelNodes(graph);
    var ranksById = assignLayerRanks(graph);
    var measured = new Map();
    var ranks = [];
    entries.forEach(function (entry) {
      var rect = entry.el.getBoundingClientRect();
      var size = { width: rect.width, height: rect.height };
      measured.set(entry.id, size);
      var rank = ranksById.get(entry.id) || 0;
      if (!ranks[rank]) ranks[rank] = [];
      ranks[rank].push(entry);
    });

    var primaryStarts = [];
    var primary = config.padding;
    ranks.forEach(function (rankEntries, rank) {
      primaryStarts[rank] = primary;
      var largest = 0;
      rankEntries.forEach(function (entry) {
        var size = measured.get(entry.id);
        largest = Math.max(largest, direction === "TB" ? size.height : size.width);
      });
      primary += largest + config.rankSpacing;
    });

    var occupied = [];
    var nextPositions = new Map();
    entries.forEach(function (entry) {
      var manual = graphPosition(entry.node);
      if (!manual) return;
      var size = measured.get(entry.id);
      var rectangle = {
        id: entry.id,
        x: manual.x,
        y: manual.y,
        width: size.width,
        height: size.height
      };
      nextPositions.set(entry.id, manual);
      occupied.push(rectangle);
    });

    ranks.forEach(function (rankEntries, rank) {
      var secondary = config.padding;
      rankEntries.forEach(function (entry) {
        if (nextPositions.has(entry.id)) return;
        var size = measured.get(entry.id);
        var position = direction === "TB"
          ? { x: secondary, y: primaryStarts[rank] }
          : { x: primaryStarts[rank], y: secondary };
        var rectangle = {
          id: entry.id,
          x: position.x,
          y: position.y,
          width: size.width,
          height: size.height
        };
        var maximumAttempts = entries.length * 4 + 8;
        var attempts = 0;
        while (attempts < maximumAttempts) {
          var collision = null;
          for (var i = 0; i < occupied.length; i++) {
            if (rectanglesCollide(rectangle, occupied[i], config.nodeSpacing)) {
              collision = occupied[i];
              break;
            }
          }
          if (!collision) break;
          secondary = direction === "TB"
            ? collision.x + collision.width + config.nodeSpacing
            : collision.y + collision.height + config.nodeSpacing;
          if (direction === "TB") rectangle.x = secondary;
          else rectangle.y = secondary;
          attempts += 1;
        }
        if (attempts === maximumAttempts) {
          var fallback = config.padding;
          occupied.forEach(function (other) {
            fallback = Math.max(
              fallback,
              (direction === "TB" ? other.x + other.width : other.y + other.height) +
                config.nodeSpacing
            );
          });
          secondary = fallback;
          if (direction === "TB") rectangle.x = fallback;
          else rectangle.y = fallback;
        }
        nextPositions.set(entry.id, { x: rectangle.x, y: rectangle.y });
        occupied.push(rectangle);
        secondary = (direction === "TB"
          ? rectangle.x + rectangle.width
          : rectangle.y + rectangle.height) + config.nodeSpacing;
      });
    });

    applyLayoutPositions(graph, entries, measured, nextPositions, config);
  }

  function applyGroupLayout(graph, entries, measured, result, config) {
    var nextPositions = new Map();
    entries.forEach(function (entry) {
      var position = result.positions[entry.id];
      if (position) nextPositions.set(entry.id, position);
    });
    applyLayoutPositions(graph, entries, measured, nextPositions, config);
  }

  function measureGroupOutsets(graph, groups) {
    var outsets = new Map();
    groups.forEach(function (group) {
      var boundary = graph.groupsById.get(group.id);
      var memberEls = group.nodes.map(function (id) {
        return graph.nodesById.get(id);
      });
      if (!boundary || memberEls.some(function (el) { return !el; })) {
        outsets.set(group.id, { left: 0, top: 0, right: 0, bottom: 0 });
        return;
      }
      var first = memberEls[0].getBoundingClientRect();
      var left = first.left;
      var top = first.top;
      var right = first.right;
      var bottom = first.bottom;
      memberEls.slice(1).forEach(function (el) {
        var rect = el.getBoundingClientRect();
        left = Math.min(left, rect.left);
        top = Math.min(top, rect.top);
        right = Math.max(right, rect.right);
        bottom = Math.max(bottom, rect.bottom);
      });
      var boundaryRect = boundary.getBoundingClientRect();
      var values = {
        left: Math.max(0, left - boundaryRect.left),
        top: Math.max(0, top - boundaryRect.top),
        right: Math.max(0, boundaryRect.right - right),
        bottom: Math.max(0, boundaryRect.bottom - bottom)
      };
      if (!Object.keys(values).every(function (key) {
        return finiteNumber(values[key]);
      })) values = { left: 0, top: 0, right: 0, bottom: 0 };
      outsets.set(group.id, values);
    });
    return outsets;
  }

  function layoutGroupAwareGraph(graph) {
    if (graph.groupsById.size === 0) return false;
    var entries = graphModelNodes(graph);
    if (entries.length === 0 || entries.every(function (entry) {
      return !!graphPosition(entry.node);
    })) return false;
    var modelGroups = state.model && Array.isArray(state.model.groups)
      ? state.model.groups
      : [];
    var groups = [];
    modelGroups.forEach(function (group, index) {
      if (!group || !graph.groupsById.has(group.id)) return;
      groups.push({
        id: group.id,
        index: index,
        nodes: Array.isArray(group.nodes) ? group.nodes.slice() : [],
        outsets: { left: 0, top: 0, right: 0, bottom: 0 }
      });
    });
    if (groups.length === 0 || groups.length !== graph.groupsById.size) return false;

    var config = readLayoutConfig(state.model);
    var measured = new Map();
    var nodes = entries.map(function (entry) {
      var rect = entry.el.getBoundingClientRect();
      var size = { width: rect.width, height: rect.height };
      measured.set(entry.id, size);
      var manual = graphPosition(entry.node);
      return {
        id: entry.id,
        index: entry.index,
        width: size.width,
        height: size.height,
        manual: manual || undefined
      };
    });
    var edges = state.model && Array.isArray(state.model.edges)
      ? state.model.edges.map(function (edge) {
          return { from: edge.from, to: edge.to };
        })
      : [];
    var input = {
      nodes: nodes,
      edges: edges,
      groups: groups,
      direction: config.direction,
      rankSpacing: config.rankSpacing,
      nodeSpacing: config.nodeSpacing,
      padding: config.padding
    };
    var provisional = groupAwareLayout(input);
    if (provisional.fallback) return false;
    applyGroupLayout(graph, entries, measured, provisional, config);
    renderGraphGroups(graph);
    var measuredOutsets = measureGroupOutsets(graph, groups);
    groups.forEach(function (group) {
      group.outsets = measuredOutsets.get(group.id);
    });
    var finalLayout = groupAwareLayout(input);
    if (finalLayout.fallback) return false;
    applyGroupLayout(graph, entries, measured, finalLayout, config);
    return true;
  }

  function svgElement(name) {
    return document.createElementNS("http://www.w3.org/2000/svg", name);
  }

  function appendGraphMarker(svg, markerId) {
    var defs = svgElement("defs");
    var marker = svgElement("marker");
    marker.setAttribute("id", markerId);
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "7");
    marker.setAttribute("markerHeight", "7");
    marker.setAttribute("orient", "auto-start-reverse");
    var arrow = svgElement("path");
    arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    arrow.setAttribute("fill", "#64748b");
    arrow.setAttribute("stroke", "none");
    marker.appendChild(arrow);
    defs.appendChild(marker);
    svg.appendChild(defs);
  }

  function appendGraphLabel(svg, edge, x, y) {
    var label = edge && edge.label;
    if (typeof label !== "string" || label.length === 0) return;
    var text = svgElement("text");
    text.classList.add("ark-harness-edge-label");
    text.setAttribute("data-ark-edge-id", edge.id);
    text.setAttribute("x", String(x));
    text.setAttribute("y", String(y));
    text.textContent = label;
    svg.appendChild(text);
  }

  function edgeDirection(edge) {
    if (!edge || !isRecordObject(edge.ext)) return "forward";
    var direction = edge.ext.direction;
    return DIRECTION_VALUES.indexOf(direction) !== -1 ? direction : "forward";
  }

  function edgeCardinality(edge, end) {
    if (!edge || !isRecordObject(edge.ext)) return null;
    var value = edge.ext[end === "from" ? "from_card" : "to_card"];
    return CARDINALITY_VALUES.indexOf(value) !== -1 ? value : null;
  }

  function edgeType(edge) {
    if (!edge || !isRecordObject(edge.ext)) return null;
    return typeof edge.ext.type === "string" ? edge.ext.type : null;
  }

  function updateEdgeExt(graph, edgeId, property, value) {
    var cardinalityProperty = property === "from_card" || property === "to_card";
    var valid = cardinalityProperty
      ? CARDINALITY_VALUES.indexOf(value) !== -1
      : property === "direction" && DIRECTION_VALUES.indexOf(value) !== -1;
    if (!valid) return;
    var edge = getEdge(state.model, edgeId);
    if (!edge) return;
    if (!isRecordObject(edge.ext)) edge.ext = {};
    edge.ext[property] = value;
    syncDirtyState();
    scheduleGraphRender(graph);
  }

  function edgeGeometry(graph, edge) {
    var fromEl = graph.nodesById.get(edge.from);
    var toEl = graph.nodesById.get(edge.to);
    if (!fromEl || !toEl) return null;

    var svgRect = graph.svg.getBoundingClientRect();
    var fromRect = fromEl.getBoundingClientRect();
    var toRect = toEl.getBoundingClientRect();
    var fromCx = fromRect.left + fromRect.width / 2 - svgRect.left;
    var fromCy = fromRect.top + fromRect.height / 2 - svgRect.top;
    var toCx = toRect.left + toRect.width / 2 - svgRect.left;
    var toCy = toRect.top + toRect.height / 2 - svgRect.top;

    if (edge.from === edge.to) {
      var startX = fromRect.right - svgRect.left;
      var startY = fromCy;
      var endX = fromCx;
      var endY = fromRect.top - svgRect.top;
      var loopSize = Math.max(36, Math.min(fromRect.width, fromRect.height) / 2);
      return {
        kind: "path",
        path: "M " + startX + " " + startY + " C " +
          (startX + loopSize) + " " + startY + ", " +
          fromCx + " " + (endY - loopSize) + ", " + endX + " " + endY,
        from: { x: startX, y: startY, tx: 1, ty: 0 },
        to: { x: endX, y: endY, tx: 0, ty: -1 },
        label: { x: startX + loopSize * 0.7, y: endY - loopSize * 0.45 }
      };
    }

    var dx = toCx - fromCx;
    var dy = toCy - fromCy;
    var length = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / length;
    var uy = dy / length;
    var fromRadius = Math.min(
      Math.abs(ux) > 0 ? fromRect.width / 2 / Math.abs(ux) : Infinity,
      Math.abs(uy) > 0 ? fromRect.height / 2 / Math.abs(uy) : Infinity
    );
    var toRadius = Math.min(
      Math.abs(ux) > 0 ? toRect.width / 2 / Math.abs(ux) : Infinity,
      Math.abs(uy) > 0 ? toRect.height / 2 / Math.abs(uy) : Infinity
    );
    var x1 = fromCx + ux * fromRadius;
    var y1 = fromCy + uy * fromRadius;
    var x2 = toCx - ux * toRadius;
    var y2 = toCy - uy * toRadius;
    return {
      kind: "line",
      from: { x: x1, y: y1, tx: ux, ty: uy },
      to: { x: x2, y: y2, tx: -ux, ty: -uy },
      label: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 }
    };
  }

  function setEdgeProjectionAttributes(main, edge, direction) {
    main.classList.add("ark-harness-edge-main");
    main.setAttribute("data-ark-edge-id", edge.id);
    main.setAttribute("data-ark-edge-direction", direction);
    var type = edgeType(edge);
    if (type !== null) main.setAttribute("data-ark-edge-type", type);
  }

  function setEdgeGeometryAttributes(element, geometry) {
    if (geometry.kind === "path") {
      element.setAttribute("d", geometry.path);
    } else {
      element.setAttribute("x1", String(geometry.from.x));
      element.setAttribute("y1", String(geometry.from.y));
      element.setAttribute("x2", String(geometry.to.x));
      element.setAttribute("y2", String(geometry.to.y));
    }
  }

  function removeEdge(edgeId) {
    var edge = getEdge(state.model, edgeId);
    if (!edge) return;
    if (selection.kind === "edge" && selection.id === edgeId) clearSelection();
    if (edgeDrag && edgeDrag.mode === "rewire" && edgeDrag.edgeId === edgeId) {
      finishEdgeDrag(null, false);
    }
    state.model.edges = state.model.edges.filter(function (entry) {
      return entry.id !== edgeId;
    });
    graphs.forEach(function (graph) { scheduleGraphRender(graph); });
  }

  function isEditableControlTarget(target) {
    if (!target || !target.closest) return false;
    return !!target.isContentEditable ||
      !!target.closest('[contenteditable="true"], input, textarea, select, button');
  }

  function applyEdgeMarkers(main, markerId, direction) {
    var marker = "url(#" + markerId + ")";
    if (direction === "reverse" || direction === "both") {
      main.setAttribute("marker-start", marker);
    }
    if (direction === "forward" || direction === "both") {
      main.setAttribute("marker-end", marker);
    }
  }

  function appendEdgeHitTarget(graph, edge, geometry) {
    var hitTarget = svgElement(geometry.kind);
    hitTarget.classList.add("ark-harness-edge-hit-target");
    hitTarget.setAttribute("data-ark-edge-id", edge.id);
    setEdgeGeometryAttributes(hitTarget, geometry);
    markUi(hitTarget);
    hitTarget.addEventListener("click", function (event) {
      if (event.button !== 0) return;
      event.stopPropagation();
      setSelection("edge", edge.id, graph);
    });
    graph.svg.appendChild(hitTarget);
  }

  function appendCardinalityLine(group, a, b) {
    var line = svgElement("line");
    line.setAttribute("x1", String(a.x));
    line.setAttribute("y1", String(a.y));
    line.setAttribute("x2", String(b.x));
    line.setAttribute("y2", String(b.y));
    group.appendChild(line);
  }

  function appendEdgeCardinality(svg, edge, end, endpoint, value) {
    if (!value) return;
    var barDistance = 12;
    var secondDistance = 22;
    var halfWidth = 7;
    var circleRadius = 4;
    var nx = -endpoint.ty;
    var ny = endpoint.tx;
    var point = function (distance, perpendicular) {
      return {
        x: endpoint.x + endpoint.tx * distance + nx * perpendicular,
        y: endpoint.y + endpoint.ty * distance + ny * perpendicular
      };
    };
    var group = svgElement("g");
    group.classList.add("ark-harness-edge-cardinality");
    group.setAttribute("data-ark-edge-id", edge.id);
    group.setAttribute("data-ark-edge-end", end);
    group.setAttribute("data-ark-edge-cardinality", value);
    markUi(group);

    var appendBar = function (distance) {
      appendCardinalityLine(group, point(distance, -halfWidth), point(distance, halfWidth));
    };
    var appendCircle = function (distance) {
      var circle = svgElement("circle");
      var center = point(distance, 0);
      circle.setAttribute("cx", String(center.x));
      circle.setAttribute("cy", String(center.y));
      circle.setAttribute("r", String(circleRadius));
      group.appendChild(circle);
    };
    var appendMany = function (distance) {
      var tip = point(distance - 7, 0);
      appendCardinalityLine(group, tip, point(distance, -halfWidth));
      appendCardinalityLine(group, tip, point(distance, 0));
      appendCardinalityLine(group, tip, point(distance, halfWidth));
    };

    if (value === "one") appendBar(barDistance);
    if (value === "many") appendMany(barDistance + 7);
    if (value === "zero-or-one") {
      appendCircle(barDistance);
      appendBar(secondDistance);
    }
    if (value === "one-or-many") {
      appendBar(barDistance);
      appendMany(secondDistance);
    }
    if (value === "zero-or-many") {
      appendCircle(barDistance);
      appendMany(secondDistance);
    }
    svg.appendChild(group);
  }

  function clearGroupGeometry(el) {
    el.classList.remove("ark-harness-graph-group");
    GROUP_GEOMETRY_PROPERTIES.forEach(function (property) {
      el.style.removeProperty(property);
    });
    if (el.style.length === 0) el.removeAttribute("style");
  }

  function renderGraphGroups(graph) {
    var containerRect = graph.container.getBoundingClientRect();
    graph.groupsById.forEach(function (el, id) {
      var group = getGroup(state.model, id);
      if (!group || !Array.isArray(group.nodes) || group.nodes.length === 0) {
        clearGroupGeometry(el);
        return;
      }

      var memberEls = [];
      for (var i = 0; i < group.nodes.length; i++) {
        var memberEl = graph.nodesById.get(group.nodes[i]);
        if (!memberEl) {
          clearGroupGeometry(el);
          return;
        }
        memberEls.push(memberEl);
      }

      var firstRect = memberEls[0].getBoundingClientRect();
      var minLeft = firstRect.left;
      var minTop = firstRect.top;
      var maxRight = firstRect.right;
      var maxBottom = firstRect.bottom;
      for (var j = 1; j < memberEls.length; j++) {
        var memberRect = memberEls[j].getBoundingClientRect();
        minLeft = Math.min(minLeft, memberRect.left);
        minTop = Math.min(minTop, memberRect.top);
        maxRight = Math.max(maxRight, memberRect.right);
        maxBottom = Math.max(maxBottom, memberRect.bottom);
      }

      el.classList.add("ark-harness-graph-group");
      el.style.setProperty("--ark-harness-group-x", minLeft - containerRect.left + "px");
      el.style.setProperty("--ark-harness-group-y", minTop - containerRect.top + "px");
      el.style.setProperty("--ark-harness-group-width", maxRight - minLeft + "px");
      el.style.setProperty("--ark-harness-group-height", maxBottom - minTop + "px");
    });
  }

  function renderGraph(graph) {
    graph.scheduled = false;
    if (!layoutGroupAwareGraph(graph)) layoutGraph(graph);
    renderGraphGroups(graph);
    while (graph.svg.firstChild) graph.svg.removeChild(graph.svg.firstChild);
    appendGraphMarker(graph.svg, graph.markerId);

    graph.edgeGeometryById.clear();
    graph.edgeMainById.clear();
    var edges = state.model && state.model.edges ? state.model.edges : [];
    edges.forEach(function (edge) {
      var geometry = edgeGeometry(graph, edge);
      if (!geometry) return;
      graph.edgeGeometryById.set(edge.id, geometry);
      var direction = edgeDirection(edge);
      var main = svgElement(geometry.kind);
      setEdgeProjectionAttributes(main, edge, direction);
      setEdgeGeometryAttributes(main, geometry);
      applyEdgeMarkers(main, graph.markerId, direction);
      graph.svg.appendChild(main);
      graph.edgeMainById.set(edge.id, main);
      appendEdgeCardinality(
        graph.svg,
        edge,
        "from",
        geometry.from,
        edgeCardinality(edge, "from")
      );
      appendEdgeCardinality(
        graph.svg,
        edge,
        "to",
        geometry.to,
        edgeCardinality(edge, "to")
      );
      appendGraphLabel(graph.svg, edge, geometry.label.x, geometry.label.y);
      appendEdgeHitTarget(graph, edge, geometry);
    });
    syncEdgeHandles(graph, edges);
    syncNodeConnectors(graph);
    reconcileSelection();
  }

  function scheduleGraphRender(graph) {
    if (graph.scheduled) return;
    graph.scheduled = true;
    window.requestAnimationFrame(function () { renderGraph(graph); syncDirtyState(); });
  }

  function positionEdgeHandle(handle, endpoint) {
    handle.style.left = endpoint.x + "px";
    handle.style.top = endpoint.y + "px";
  }

  function findEdgeDropCandidate(graph, clientX, clientY) {
    var elements = document.elementsFromPoint(clientX, clientY);
    for (var i = 0; i < elements.length; i++) {
      var current = elements[i];
      while (current && current !== graph.container) {
        var id = current.getAttribute && current.getAttribute("data-model-id");
        var nodeEl = id ? graph.nodesById.get(id) : null;
        if (nodeEl && getNode(state.model, id) &&
            nodeEl.closest('[data-ark-container="graph"]') === graph.container) {
          return { id: id, el: nodeEl };
        }
        current = current.parentElement;
      }
    }
    return null;
  }

  function removeEdgeDragUi(drag) {
    setEdgeDeletePending(drag, false);
    if (drag.preview && drag.preview.parentNode) drag.preview.parentNode.removeChild(drag.preview);
    if (drag.indicator && drag.indicator.parentNode) {
      drag.indicator.parentNode.removeChild(drag.indicator);
    }
    drag.preview = null;
    drag.previewLine = null;
    drag.indicator = null;
    drag.candidateId = null;
    drag.graph.container.classList.remove("ark-harness-edge-dragging");
  }

  function setEdgeDeletePending(drag, pending) {
    if (drag.mode !== "rewire") return;
    drag.graph.container.classList.toggle("ark-harness-edge-delete-pending", pending);
    drag.preview.classList.toggle("ark-harness-edge-delete-pending", pending);
    drag.handle.classList.toggle("ark-harness-edge-delete-pending", pending);
    drag.handle.textContent = pending ? "\\u00D7" : "";
    drag.handle.setAttribute(
      "aria-label",
      pending ? "離すと edge を削除" : drag.handleLabel
    );
    drag.handle.title = pending ? "離すと edge を削除" : drag.handleLabel;
    drag.graph.svg.querySelectorAll(".ark-harness-edge-main").forEach(function (main) {
      if (main.getAttribute("data-ark-edge-id") === drag.edgeId) {
        main.classList.toggle("ark-harness-edge-delete-pending", pending);
      }
    });
  }

  function updateEdgeDropIndicator(drag, candidate) {
    if (!candidate) {
      if (drag.indicator && drag.indicator.parentNode) {
        drag.indicator.parentNode.removeChild(drag.indicator);
      }
      drag.indicator = null;
      drag.candidateId = null;
      return;
    }
    if (!drag.indicator) {
      drag.indicator = document.createElement("div");
      drag.indicator.className = "ark-harness-edge-drop-indicator";
      markUi(drag.indicator);
      drag.graph.handleLayer.appendChild(drag.indicator);
    }
    var layerRect = drag.graph.handleLayer.getBoundingClientRect();
    var nodeRect = candidate.el.getBoundingClientRect();
    drag.indicator.style.left = nodeRect.left - layerRect.left - 4 + "px";
    drag.indicator.style.top = nodeRect.top - layerRect.top - 4 + "px";
    drag.indicator.style.width = nodeRect.width + 8 + "px";
    drag.indicator.style.height = nodeRect.height + 8 + "px";
    drag.candidateId = candidate.id;
  }

  function nodeBoundaryPoint(graph, nodeEl, towardX, towardY) {
    var previewRect = graph.previewLayer.getBoundingClientRect();
    var rect = nodeEl.getBoundingClientRect();
    var cx = rect.left + rect.width / 2 - previewRect.left;
    var cy = rect.top + rect.height / 2 - previewRect.top;
    var dx = towardX - cx;
    var dy = towardY - cy;
    var length = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / length;
    var uy = dy / length;
    var radius = Math.min(
      Math.abs(ux) > 0 ? rect.width / 2 / Math.abs(ux) : Infinity,
      Math.abs(uy) > 0 ? rect.height / 2 / Math.abs(uy) : Infinity
    );
    if (!finiteNumber(radius)) radius = 0;
    return { x: cx + ux * radius, y: cy + uy * radius };
  }

  function updateEdgeDrag(event) {
    if (!edgeDrag || event.pointerId !== edgeDrag.pointerId) return;
    var drag = edgeDrag;
    var previewRect = drag.graph.previewLayer.getBoundingClientRect();
    var candidate = findEdgeDropCandidate(drag.graph, event.clientX, event.clientY);
    var dx = event.clientX - drag.startClientX;
    var dy = event.clientY - drag.startClientY;
    if (dx * dx + dy * dy >= EDGE_DRAG_MIN_DISTANCE * EDGE_DRAG_MIN_DISTANCE) {
      drag.didDrag = true;
    }
    if (drag.didDrag && drag.mode === "create" &&
        (!candidate || candidate.id !== drag.sourceId)) {
      drag.leftSource = true;
    }
    var end = candidate
      ? nodeBoundaryPoint(
          drag.graph,
          candidate.el,
          Number(drag.previewLine.getAttribute("x1")),
          Number(drag.previewLine.getAttribute("y1"))
        )
      : {
          x: event.clientX - previewRect.left,
          y: event.clientY - previewRect.top
        };
    drag.previewLine.setAttribute("x2", String(end.x));
    drag.previewLine.setAttribute("y2", String(end.y));
    updateEdgeDropIndicator(drag, candidate);
    setEdgeDeletePending(
      drag,
      drag.mode === "rewire" && drag.didDrag && !candidate
    );
  }

  function edgeDropCandidateAtPointer(drag, event) {
    var candidate = findEdgeDropCandidate(drag.graph, event.clientX, event.clientY);
    if (candidate || !drag.candidateId) return candidate;
    var nodeEl = drag.graph.nodesById.get(drag.candidateId);
    if (!nodeEl || !getNode(state.model, drag.candidateId)) return null;
    var rect = nodeEl.getBoundingClientRect();
    return event.clientX >= rect.left && event.clientX <= rect.right &&
      event.clientY >= rect.top && event.clientY <= rect.bottom
      ? { id: drag.candidateId, el: nodeEl }
      : null;
  }

  function finishEdgeDrag(event, commit) {
    if (!edgeDrag) return;
    if (event && event.pointerId !== edgeDrag.pointerId) return;
    var drag = edgeDrag;
    var candidate = commit && event ? edgeDropCandidateAtPointer(drag, event) : null;
    edgeDrag = null;
    var explicitSelfDrop = drag.mode !== "create" ||
      candidate && candidate.id !== drag.sourceId ||
      drag.leftSource;
    if (commit && drag.didDrag && drag.mode === "rewire" && !candidate) {
      removeEdge(drag.edgeId);
    } else if (commit && drag.didDrag && drag.mode === "create" && !candidate) {
      var overOtherGraph = graphs.some(function (entry) {
        if (entry === drag.graph) return false;
        var rect = entry.container.getBoundingClientRect();
        return event.clientX >= rect.left && event.clientX <= rect.right &&
          event.clientY >= rect.top && event.clientY <= rect.bottom;
      });
      if (overOtherGraph) {
        removeEdgeDragUi(drag);
        if (drag.handle.hasPointerCapture(drag.pointerId)) {
          drag.handle.releasePointerCapture(drag.pointerId);
        }
        graphs.forEach(function (graph) { scheduleGraphRender(graph); });
        return;
      }
      var blankSource = getNode(state.model, drag.sourceId);
      var blankSourceEl = drag.graph.nodesById.get(drag.sourceId);
      if (blankSource && blankSourceEl) {
        var graphRect = drag.graph.container.getBoundingClientRect();
        var point = {
          x: event.clientX - graphRect.left,
          y: event.clientY - graphRect.top
        };
        var kind = lastKind === "note"
          ? "note"
          : kindCandidates.indexOf(lastKind) !== -1
            ? lastKind
            : kindCandidates[0] || "";
        var previousLastKind = lastKind;
        var newNode = createNodeInGraph(drag.graph, kind, point);
        if (!newNode) {
          updateStatus(!!submitPort, "ノードと edge を作成できませんでした");
        } else {
          var newEdgeId = generateUniqueModelId("edge");
          if (newEdgeId) {
            freezeGraphPositions(drag.graph);
            state.model.edges.push({
              id: newEdgeId,
              from: blankSource.id,
              to: newNode.id
            });
          } else {
            removeNode(newNode.id);
            lastKind = previousLastKind;
            updateStatus(!!submitPort, "ノードと edge を作成できませんでした");
          }
        }
      }
    } else if (commit && drag.didDrag && candidate && explicitSelfDrop) {
      if (drag.mode === "rewire") {
        var currentEdge = getEdge(state.model, drag.edgeId);
        if (currentEdge && getNode(state.model, candidate.id) &&
            drag.graph.nodesById.has(candidate.id)) {
          currentEdge[drag.end] = candidate.id;
        }
      } else {
        var source = getNode(state.model, drag.sourceId);
        var target = getNode(state.model, candidate.id);
        if (source && target && drag.graph.nodesById.has(source.id) &&
            drag.graph.nodesById.has(target.id)) {
          var edgeId = generateUniqueModelId("edge");
          if (edgeId) {
            state.model.edges.push({ id: edgeId, from: source.id, to: target.id });
          } else {
            updateStatus(!!submitPort, "一意な ID を生成できませんでした");
          }
        }
      }
    }
    removeEdgeDragUi(drag);
    if (drag.handle.hasPointerCapture(drag.pointerId)) {
      drag.handle.releasePointerCapture(drag.pointerId);
    }
    graphs.forEach(function (graph) { scheduleGraphRender(graph); });
  }

  function createEdgePreview(graph, start) {
    var preview = svgElement("svg");
    preview.classList.add("ark-harness-edge-preview");
    markUi(preview);
    var line = svgElement("line");
    line.setAttribute("x1", String(start.x));
    line.setAttribute("y1", String(start.y));
    line.setAttribute("x2", String(start.x));
    line.setAttribute("y2", String(start.y));
    preview.appendChild(line);
    graph.previewLayer.appendChild(preview);
    graph.container.classList.add("ark-harness-edge-dragging");
    return { preview: preview, line: line };
  }

  function createEdgeHandle(graph, edge, end) {
    var handle = createButton("", "ark-harness-edge-handle");
    handle.setAttribute("data-ark-edge-id", edge.id);
    handle.setAttribute("data-ark-edge-end", end);
    handle.addEventListener("pointerdown", function (event) {
      if (graphDrag || edgeDrag) return;
      var currentEdge = getEdge(state.model, handle.getAttribute("data-ark-edge-id"));
      var geometry = currentEdge && graph.edgeGeometryById.get(currentEdge.id);
      var endpoint = geometry && geometry[end];
      if (!currentEdge || !endpoint) return;
      event.preventDefault();
      event.stopPropagation();
      handle.setPointerCapture(event.pointerId);

      var previewUi = createEdgePreview(graph, endpoint);
      edgeDrag = {
        mode: "rewire",
        pointerId: event.pointerId,
        handle: handle,
        graph: graph,
        edgeId: currentEdge.id,
        end: end,
        startClientX: event.clientX,
        startClientY: event.clientY,
        didDrag: false,
        leftSource: false,
        handleLabel: handle.getAttribute("aria-label") || "",
        preview: previewUi.preview,
        previewLine: previewUi.line,
        indicator: null,
        candidateId: null
      };
    });
    handle.addEventListener("pointermove", updateEdgeDrag);
    handle.addEventListener("pointerup", function (event) { finishEdgeDrag(event, true); });
    handle.addEventListener("pointercancel", function (event) { finishEdgeDrag(event, false); });
    graph.handleLayer.appendChild(handle);
    return handle;
  }

  function syncEdgeHandles(graph, edges) {
    var activeKeys = new Set();
    edges.forEach(function (edge) {
      var geometry = graph.edgeGeometryById.get(edge.id);
      if (!geometry) return;
      ["from", "to"].forEach(function (end) {
        var key = edge.id + ":" + end;
        activeKeys.add(key);
        var handle = graph.edgeHandlesByKey.get(key);
        if (!handle) {
          handle = createEdgeHandle(graph, edge, end);
          graph.edgeHandlesByKey.set(key, handle);
        }
        handle.setAttribute("data-ark-edge-id", edge.id);
        handle.setAttribute("data-ark-edge-end", end);
        var name = (typeof edge.label === "string" && edge.label) || edge.id;
        var endLabel = end === "from" ? "始点" : "終点";
        var ariaLabel = name + " の" + endLabel +
          "をドラッグして張り替え、空き領域で削除";
        handle.setAttribute("aria-label", ariaLabel);
        handle.title = ariaLabel;
        positionEdgeHandle(handle, geometry[end]);
      });
    });
    graph.edgeHandlesByKey.forEach(function (handle, key) {
      if (activeKeys.has(key)) return;
      if (handle.parentNode) handle.parentNode.removeChild(handle);
      graph.edgeHandlesByKey.delete(key);
    });
  }

  function graphLocalRect(graph, element) {
    var rect = element.getBoundingClientRect();
    var containerRect = graph.container.getBoundingClientRect();
    if (!finiteNumber(rect.width) || !finiteNumber(rect.height)) return null;
    return {
      x: rect.left - containerRect.left,
      y: rect.top - containerRect.top,
      width: rect.width,
      height: rect.height
    };
  }

  function createEdgeOption(value, label) {
    var option = document.createElement("option");
    option.value = value;
    option.textContent = label + " (" + value + ")";
    markUi(option);
    return option;
  }

  function createEdgePlaceholder(text) {
    var option = document.createElement("option");
    option.value = "__ark_invalid__";
    option.textContent = text;
    option.setAttribute("disabled", "");
    markUi(option);
    return option;
  }

  function edgeControlProperty(role) {
    if (role === "from-card") return "from_card";
    if (role === "to-card") return "to_card";
    return role === "direction" ? "direction" : null;
  }

  function createEdgeSelect(graph, edgeId, role) {
    var select = document.createElement("select");
    select.className = "ark-harness-edge-control";
    select.setAttribute("data-ark-edge-control", role);
    markUi(select);
    var values = role === "direction" ? DIRECTION_VALUES : CARDINALITY_VALUES;
    var labels = role === "direction" ? DIRECTION_LABELS : CARDINALITY_LABELS;
    values.forEach(function (value) {
      select.appendChild(createEdgeOption(value, labels[value]));
    });
    ["pointerdown", "click", "keydown"].forEach(function (type) {
      select.addEventListener(type, function (event) { event.stopPropagation(); });
    });
    select.addEventListener("change", function (event) {
      event.stopPropagation();
      if (selection.kind !== "edge" || selection.id !== edgeId ||
          selectionGraph !== graph) return;
      var property = edgeControlProperty(select.getAttribute("data-ark-edge-control"));
      if (property) updateEdgeExt(graph, edgeId, property, select.value);
    });
    return select;
  }

  function syncEdgeSelect(select, role, edge) {
    var property = edgeControlProperty(role);
    var raw = isRecordObject(edge.ext) ? edge.ext[property] : undefined;
    var allowed = role === "direction"
      ? DIRECTION_VALUES.indexOf(raw) !== -1
      : CARDINALITY_VALUES.indexOf(raw) !== -1;
    var missingDirection = role === "direction" && raw === undefined;
    var current = allowed ? raw : missingDirection ? "forward" : null;
    var placeholderText = raw === undefined
      ? "\\u672A\\u8A2D\\u5B9A"
      : role === "direction"
        ? "\\u4E0D\\u6B63\\u5024\\u30FB\\u8868\\u793A\\u306F forward"
        : "\\u4E0D\\u6B63\\u5024";
    if (current === null) {
      var placeholder = createEdgePlaceholder(placeholderText);
      select.insertBefore(placeholder, select.firstChild);
      select.value = "__ark_invalid__";
    } else {
      select.value = current;
    }
    select.disabled = false;
    var name = (typeof edge.label === "string" && edge.label) || edge.id;
    var roleLabel = role === "from-card"
      ? "\\u59CB\\u70B9 cardinality"
      : role === "to-card"
        ? "\\u7D42\\u70B9 cardinality"
        : "direction";
    var currentLabel = current === null ? placeholderText : current;
    var label = name + " \\u306E" + roleLabel + "\\uFF08\\u73FE\\u5728 " + currentLabel + "\\uFF09";
    select.setAttribute("aria-label", label);
    select.setAttribute("title", label);
  }

  function finishGraphDrag(event) {
    if (!graphDrag) return;
    if (event && event.pointerId !== graphDrag.pointerId) return;
    var drag = graphDrag;
    graphDrag = null;
    drag.el.classList.remove("ark-harness-graph-dragging");
    if (drag.handle.hasPointerCapture(drag.pointerId)) {
      drag.handle.releasePointerCapture(drag.pointerId);
    }
  }

  function startGraphDrag(graph, el, handle, event, start) {
    if (graphDrag || edgeDrag) return false;
    var id = el.getAttribute("data-model-id");
    if (!id) return false;
    var currentNode = getNode(state.model, id);
    var position = graphPosition(currentNode) || graph.positionsById.get(id);
    if (!position) return false;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    el.classList.add("ark-harness-graph-dragging");
    graphDrag = {
      pointerId: event.pointerId,
      handle: handle,
      graph: graph,
      el: el,
      node: currentNode,
      start: {
        clientX: start ? start.x : event.clientX,
        clientY: start ? start.y : event.clientY,
        x: position.x,
        y: position.y
      }
    };
    return true;
  }

  function updateGraphDrag(event) {
    if (!graphDrag || event.pointerId !== graphDrag.pointerId) return;
    var drag = graphDrag;
    var x = Math.max(0, Math.round(drag.start.x + event.clientX - drag.start.clientX));
    var y = Math.max(0, Math.round(drag.start.y + event.clientY - drag.start.clientY));
    if (!isRecordObject(drag.node.ext)) drag.node.ext = {};
    drag.node.ext.x = x;
    drag.node.ext.y = y;
    drag.graph.positionsById.set(drag.node.id, { x: x, y: y });
    drag.el.style.setProperty("--ark-harness-graph-x", x + "px");
    drag.el.style.setProperty("--ark-harness-graph-y", y + "px");
    scheduleGraphRender(drag.graph);
  }

  function attachNodeDrag(graph, el) {
    var pending = null;
    var suppressClick = false;
    el.addEventListener("pointerdown", function (event) {
      if (!event.isTrusted || event.button !== 0 || graphDrag || edgeDrag ||
          !event.target.closest) return;
      var editable = event.target.closest('[contenteditable="true"],input,textarea');
      if (event.target.closest('button,select,option,.ark-harness-node-anchor,.ark-harness-node-connectors,[draggable="true"]') ||
          editable === document.activeElement) return;
      pending = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        editable: editable
      };
      el.setPointerCapture(event.pointerId);
    });
    el.addEventListener("pointermove", function (event) {
      if (!pending || event.pointerId !== pending.pointerId) {
        updateGraphDrag(event);
        return;
      }
      var dx = event.clientX - pending.x;
      var dy = event.clientY - pending.y;
      if (dx * dx + dy * dy <= 16) return;
      var start = pending;
      pending = null;
      if (start.editable) start.editable.blur();
      if (startGraphDrag(graph, el, el, event, start)) {
        suppressClick = true;
        updateGraphDrag(event);
      }
    });
    var finish = function (event) {
      if (pending && event.pointerId === pending.pointerId) pending = null;
      finishGraphDrag(event);
      if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
      if (suppressClick) window.setTimeout(function () { suppressClick = false; });
    };
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", finish);
    el.addEventListener("click", function (event) {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    }, true);
  }

  function syncNodeConnectors(graph) {
    graph.nodeConnectorsById.forEach(function (connectors, id) {
      var node = getNode(state.model, id);
      if (!node) return;
      var name = (typeof node.label === "string" && node.label) || node.id;
      connectors.querySelectorAll(".ark-harness-node-anchor").forEach(function (anchor) {
        var position = anchor.getAttribute("data-ark-anchor-position") || "";
        var label = name + " の" + position + "接続点から edge を作成";
        anchor.setAttribute("aria-label", label);
        anchor.title = label;
        var point = nodeAnchorPoint(
          graph.nodesById.get(id),
          anchor,
          connectors
        );
        anchor.style.left = point.x + "px";
        anchor.style.top = point.y + "px";
      });
    });
  }

  function nodeAnchorPoint(nodeEl, anchor, reference) {
    var referenceRect = reference.getBoundingClientRect();
    var nodeRect = nodeEl.getBoundingClientRect();
    var xRatio = Number(anchor.getAttribute("data-ark-anchor-x"));
    var yRatio = Number(anchor.getAttribute("data-ark-anchor-y"));
    return {
      x: nodeRect.left - referenceRect.left + nodeRect.width * xRatio,
      y: nodeRect.top - referenceRect.top + nodeRect.height * yRatio
    };
  }

  function startCreateEdgeDrag(graph, nodeEl, anchor, event) {
    if (graphDrag || edgeDrag) return;
    var sourceId = nodeEl.getAttribute("data-model-id");
    if (!sourceId || !getNode(state.model, sourceId) ||
        graph.nodesById.get(sourceId) !== nodeEl) return;
    event.preventDefault();
    event.stopPropagation();
    anchor.setPointerCapture(event.pointerId);
    var start = nodeAnchorPoint(nodeEl, anchor, graph.previewLayer);
    var previewUi = createEdgePreview(graph, start);
    edgeDrag = {
      mode: "create",
      pointerId: event.pointerId,
      handle: anchor,
      graph: graph,
      sourceId: sourceId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      didDrag: false,
      leftSource: false,
      preview: previewUi.preview,
      previewLine: previewUi.line,
      indicator: null,
      candidateId: null
    };
  }

  function attachNodeConnectors(graph, root) {
    var id = root.getAttribute("data-model-id");
    if (!id || graph.nodeConnectorsById.has(id)) return;
    var node = getNode(state.model, id);
    if (!node) return;
    var connectors = document.createElement("span");
    connectors.className = "ark-harness-node-connectors";
    connectors.setAttribute("data-ark-node-id", id);
    markUi(connectors);
    var name = (typeof node.label === "string" && node.label) || node.id;
    var positions = [
      ["top-left", 0, 0],
      ["top", 0.5, 0],
      ["top-right", 1, 0],
      ["right", 1, 0.5],
      ["bottom-right", 1, 1],
      ["bottom", 0.5, 1],
      ["bottom-left", 0, 1],
      ["left", 0, 0.5]
    ];
    ["pointerdown", "click", "keydown"].forEach(function (type) {
      connectors.addEventListener(type, function (event) { event.stopPropagation(); });
    });
    positions.forEach(function (position) {
      var label = name + " の" + position[0] + "接続点から edge を作成";
      var anchor = createButton("\\u2022", "ark-harness-node-anchor", label);
      anchor.setAttribute("data-ark-node-id", id);
      anchor.setAttribute("data-ark-anchor-position", String(position[0]));
      anchor.setAttribute("data-ark-anchor-x", String(position[1]));
      anchor.setAttribute("data-ark-anchor-y", String(position[2]));
      anchor.addEventListener("pointerdown", function (event) {
        startCreateEdgeDrag(graph, root, anchor, event);
      });
      anchor.addEventListener("pointermove", updateEdgeDrag);
      anchor.addEventListener("pointerup", function (event) {
        finishEdgeDrag(event, true);
      });
      anchor.addEventListener("pointercancel", function (event) {
        finishEdgeDrag(event, false);
      });
      connectors.appendChild(anchor);
    });
    graph.handleLayer.appendChild(connectors);
    graph.nodeConnectorsById.set(id, connectors);
  }

  function clearNodeAffordanceClose(controller) {
    if (!controller || controller.closeTimer === null) return;
    window.clearTimeout(controller.closeTimer);
    controller.closeTimer = null;
  }

  function openNodeAffordance(controller) {
    clearNodeAffordanceClose(controller);
    controller.root.classList.add("ark-harness-node-affordance-open");
    controller.connectors.classList.add("ark-harness-node-connectors-visible");
  }

  function scheduleNodeAffordanceClose(controller) {
    clearNodeAffordanceClose(controller);
    controller.closeTimer = window.setTimeout(function () {
      controller.closeTimer = null;
      if (controller.root.matches(":hover") ||
          controller.root.matches(":focus-within") ||
          controller.connectors.matches(":hover") ||
          controller.connectors.matches(":focus-within")) return;
      controller.root.classList.remove("ark-harness-node-affordance-open");
      controller.connectors.classList.remove("ark-harness-node-connectors-visible");
    }, AFFORDANCE_CLOSE_DELAY);
  }

  function attachNodeAffordanceHover(graph, root, id) {
    var connectors = graph.nodeConnectorsById.get(id);
    if (!connectors) return;
    var controller = { root: root, connectors: connectors, closeTimer: null };
    ["pointerenter", "focusin"].forEach(function (type) {
      root.addEventListener(type, function () {
        openNodeAffordance(controller);
      });
    });
    ["pointerleave", "focusout"].forEach(function (type) {
      root.addEventListener(type, function () {
        scheduleNodeAffordanceClose(controller);
      });
    });
    connectors.addEventListener("pointerenter", function () {
      openNodeAffordance(controller);
    });
    connectors.addEventListener("pointerleave", function () {
      scheduleNodeAffordanceClose(controller);
    });
    graph.nodeAffordancesById.set(id, controller);
  }

  function selectionEntry() {
    if (selection.kind === "node") return getNode(state.model, selection.id);
    if (selection.kind === "edge") return getEdge(state.model, selection.id);
    return null;
  }

  function selectionAnchor() {
    if (!selectionGraph || graphs.indexOf(selectionGraph) === -1) return null;
    if (selection.kind === "node") {
      return selectionGraph.nodesById.get(selection.id) || null;
    }
    if (selection.kind === "edge") {
      return selectionGraph.edgeMainById.get(selection.id) || null;
    }
    return null;
  }

  function renderSelectionVisuals() {
    graphs.forEach(function (graph) {
      graph.nodesById.forEach(function (root, nodeId) {
        root.classList.toggle(
          "ark-harness-node-selected",
          selection.kind === "node" && graph === selectionGraph &&
            nodeId === selection.id
        );
      });
      graph.edgeMainById.forEach(function (main, edgeId) {
        main.classList.toggle(
          "ark-harness-edge-selected",
          selection.kind === "edge" && graph === selectionGraph &&
            edgeId === selection.id
        );
      });
    });
  }

  function clearToolbarChildren() {
    if (!contextToolbar) return;
    while (contextToolbar.firstChild) {
      contextToolbar.removeChild(contextToolbar.firstChild);
    }
  }

  function syncKindSelect(select, node) {
    var current = typeof node.kind === "string" ? node.kind : "";
    if (current && current !== "note" &&
        kindCandidates.indexOf(current) === -1) {
      var currentOption = createKindOption(current);
      currentOption.textContent = current;
      currentOption.disabled = true;
      select.insertBefore(currentOption, select.children[1] || null);
    }
    select.value = current;
    if (!current) select.selectedIndex = -1;
    var name = (typeof node.label === "string" && node.label) || node.id;
    var label = name + " \\u306E kind\\uFF08\\u73FE\\u5728 " +
      (current || "\\u306A\\u3057") + "\\uFF09";
    select.setAttribute("aria-label", label);
    select.title = label;
  }

  function listBinding(nodeId, root) {
    var bindings = listBindingsByNode.get(nodeId) || [];
    for (var i = 0; i < bindings.length; i++) {
      if (bindings[i].listEl.isConnected && root &&
          root.contains(bindings[i].listEl)) {
        return bindings[i];
      }
    }
    return null;
  }

  function selectedListBinding() {
    if (selection.kind !== "node" || !selectionGraph) return null;
    return listBinding(
      selection.id,
      selectionGraph.nodesById.get(selection.id)
    );
  }

  function renderNodeToolbar(node) {
    var graph = selectionGraph;
    var root = graph && graph.nodesById.get(node.id);
    var select = document.createElement("select");
    select.className = "ark-harness-kind-select";
    markUi(select);
    var note = createKindOption("note");
    note.textContent = "note";
    select.appendChild(note);
    kindCandidates.forEach(function (value) {
      if (value !== "note") select.appendChild(createKindOption(value));
    });
    syncKindSelect(select, node);
    select.addEventListener("change", function (event) {
      event.stopPropagation();
      if (selection.kind === "node" && selection.id === node.id &&
          selectionGraph === graph && root) {
        updateNodeKind(graph, root, select.value);
      }
    });
    contextToolbar.appendChild(select);

    var binding = selectedListBinding();
    var add = createButton(
      "+ \\u884C",
      "ark-harness-node-add-field",
      "\\u884C\\u3092\\u8FFD\\u52A0"
    );
    add.disabled = !binding;
    add.addEventListener("click", function () {
      if (selection.kind !== "node" || selection.id !== node.id) return;
      var current = selectedListBinding();
      if (current) addField(current.listEl, current.ownerNodeId);
    });
    contextToolbar.appendChild(add);

    var name = (typeof node.label === "string" && node.label) || node.id;
    var del = createButton(
      "\\u524A\\u9664",
      "ark-harness-node-delete",
      name + " \\u3092\\u524A\\u9664"
    );
    del.addEventListener("click", function () {
      if (selection.kind !== "node" || selection.id !== node.id) return;
      clearSelection();
      removeNode(node.id);
    });
    contextToolbar.appendChild(del);
  }

  function renderEdgeToolbar(edge) {
    var graph = selectionGraph;
    var input = document.createElement("input");
    input.type = "text";
    input.className = "ark-harness-edge-control ark-harness-edge-label-input";
    input.value = typeof edge.label === "string" ? edge.label : "";
    input.placeholder = "\u30E9\u30D9\u30EB";
    markUi(input);
    function updateLabel(event) {
      event.stopPropagation();
      var current = getEdge(state.model, edge.id);
      if (!current) return;
      if (input.value) current.label = input.value;
      else delete current.label;
      graphs.forEach(function (entry) { scheduleGraphRender(entry); });
    }
    input.addEventListener("input", updateLabel);
    input.addEventListener("change", updateLabel);
    ["pointerdown", "click"].forEach(function (type) {
      input.addEventListener(type, function (event) { event.stopPropagation(); });
    });
    input.addEventListener("keydown", function (event) {
      event.stopPropagation();
      if (event.key === "Enter") input.blur();
    });
    contextToolbar.appendChild(input);
    ["from-card", "to-card", "direction"].forEach(function (role) {
      var select = createEdgeSelect(graph, edge.id, role);
      syncEdgeSelect(select, role, edge);
      contextToolbar.appendChild(select);
    });
    var name = (typeof edge.label === "string" && edge.label) || edge.id;
    var reverse = createButton(
      "\\u5411\\u304D\\u53CD\\u8EE2",
      "ark-harness-edge-reverse",
      name + " \\u306E\\u5411\\u304D\\u3092\\u53CD\\u8EE2"
    );
    var reversible = edgeDirection(edge);
    reverse.disabled = reversible !== "forward" && reversible !== "reverse";
    reverse.addEventListener("click", function () {
      if (selection.kind !== "edge" || selection.id !== edge.id) return;
      var current = getEdge(state.model, edge.id);
      if (!current) return;
      var dir = edgeDirection(current);
      if (dir !== "forward" && dir !== "reverse") return;
      if (!isRecordObject(current.ext)) current.ext = {};
      current.ext.direction = dir === "forward" ? "reverse" : "forward";
      graphs.forEach(function (entry) { scheduleGraphRender(entry); });
      reverse.blur();
      renderContextToolbar();
    });
    contextToolbar.appendChild(reverse);
    var del = createButton(
      "\\u524A\\u9664",
      "ark-harness-edge-delete",
      name + " \\u3092\\u524A\\u9664"
    );
    del.addEventListener("click", function () {
      if (selection.kind !== "edge" || selection.id !== edge.id) return;
      clearSelection();
      removeEdge(edge.id);
    });
    contextToolbar.appendChild(del);
  }

  function renderContextToolbar() {
    if (!contextToolbar) return;
    if (!contextToolbar.hidden &&
        contextToolbar.contains(document.activeElement) &&
        contextToolbar.getAttribute("data-ark-selection-kind") === selection.kind &&
        contextToolbar.getAttribute("data-ark-selection-id") === selection.id) return;
    clearToolbarChildren();
    contextToolbar.removeAttribute("data-ark-selection-kind");
    contextToolbar.removeAttribute("data-ark-selection-id");
    contextToolbar.removeAttribute("data-ark-toolbar-placement");
    var entry = selectionEntry();
    if (!entry) {
      contextToolbar.hidden = true;
      return;
    }
    contextToolbar.hidden = false;
    contextToolbar.setAttribute("data-ark-selection-kind", selection.kind);
    contextToolbar.setAttribute("data-ark-selection-id", selection.id);
    var name = (typeof entry.label === "string" && entry.label) || entry.id;
    contextToolbar.setAttribute(
      "aria-label",
      name + " \\u306E\\u30B3\\u30F3\\u30C6\\u30AD\\u30B9\\u30C8\\u30C4\\u30FC\\u30EB\\u30D0\\u30FC"
    );
    if (selection.kind === "node") renderNodeToolbar(entry);
    if (selection.kind === "edge") renderEdgeToolbar(entry);
  }

  function observeSelectionAnchor(anchor) {
    if (!selectionResizeObserver) return;
    selectionResizeObserver.disconnect();
    if (anchor) selectionResizeObserver.observe(anchor);
    if (contextToolbar && !contextToolbar.hidden) {
      selectionResizeObserver.observe(contextToolbar);
    }
  }

  function positionContextToolbar() {
    toolbarPositionFrame = null;
    if (!contextToolbar || contextToolbar.hidden) return;
    var anchor = selectionAnchor();
    if (!anchor || !anchor.isConnected) {
      clearSelection();
      return;
    }
    var anchorRect = anchor.getBoundingClientRect();
    var toolbarRect = contextToolbar.getBoundingClientRect();
    if (!finiteNumber(anchorRect.left) || !finiteNumber(anchorRect.top) ||
        !finiteNumber(toolbarRect.width) || !finiteNumber(toolbarRect.height) ||
        toolbarRect.width <= 0 || toolbarRect.height <= 0) {
      clearSelection();
      return;
    }
    var margin = 8;
    var top = anchorRect.top - toolbarRect.height - margin;
    var placement = "above";
    if (top < margin) {
      top = anchorRect.bottom + margin;
      placement = "below";
    }
    if (top + toolbarRect.height > window.innerHeight - margin) {
      top = Math.max(
        margin,
        Math.min(top, window.innerHeight - toolbarRect.height - margin)
      );
      placement = "clamped";
    }
    var left = anchorRect.left +
      (anchorRect.width - toolbarRect.width) / 2;
    left = Math.max(
      margin,
      Math.min(left, window.innerWidth - toolbarRect.width - margin)
    );
    contextToolbar.style.left = left + "px";
    contextToolbar.style.top = top + "px";
    contextToolbar.setAttribute("data-ark-toolbar-placement", placement);
    observeSelectionAnchor(anchor);
  }

  function scheduleContextToolbarPosition() {
    if (toolbarPositionFrame !== null || !contextToolbar ||
        contextToolbar.hidden) return;
    toolbarPositionFrame = window.requestAnimationFrame(positionContextToolbar);
  }

  function clearSelection() {
    selection = { kind: null, id: null };
    selectionGraph = null;
    if (selectionResizeObserver) selectionResizeObserver.disconnect();
    renderSelectionVisuals();
    renderContextToolbar();
  }

  function setSelection(kind, id, graph) {
    var valid = kind === "node"
      ? getNode(state.model, id)
      : kind === "edge"
        ? getEdge(state.model, id)
        : null;
    if (!valid || graphs.indexOf(graph) === -1) {
      clearSelection();
      return;
    }
    selection = { kind: kind, id: id };
    selectionGraph = graph;
    renderSelectionVisuals();
    renderContextToolbar();
    scheduleContextToolbarPosition();
  }

  function reconcileSelection() {
    if (!selectionEntry()) {
      clearSelection();
      return;
    }
    var anchor = selectionAnchor();
    if (!anchor || !anchor.isConnected) {
      clearSelection();
      return;
    }
    renderSelectionVisuals();
    renderContextToolbar();
    scheduleContextToolbarPosition();
  }

  function buildContextToolbar() {
    contextToolbar = document.createElement("div");
    contextToolbar.className = "ark-harness-context-toolbar";
    contextToolbar.setAttribute("role", "toolbar");
    contextToolbar.hidden = true;
    markUi(contextToolbar);
    ["pointerdown", "click"].forEach(function (type) {
      contextToolbar.addEventListener(type, function (event) {
        event.stopPropagation();
      });
    });
    document.body.appendChild(contextToolbar);
    if (typeof ResizeObserver !== "undefined") {
      selectionResizeObserver = new ResizeObserver(
        scheduleContextToolbarPosition
      );
    }
  }

  function attachNodeSelection(root, id) {
    if (!root.hasAttribute("tabindex")) {
      root.setAttribute("tabindex", "0");
      root.classList.add("ark-harness-node-tabindex-added");
    }
    root.addEventListener("pointerdown", function (event) {
      if (event.button !== 0 || isInsideHarnessUi(event.target)) return;
      if (isEditableControlTarget(event.target)) return;
      event.preventDefault();
      var graph = graphs.find(function (entry) {
        return entry.nodesById.get(id) === root;
      });
      setSelection("node", id, graph);
      root.focus({ preventScroll: true });
    });
    root.addEventListener("click", function (event) {
      if (event.button !== 0 || isInsideHarnessUi(event.target) ||
          !isEditableControlTarget(event.target)) return;
      var graph = graphs.find(function (entry) {
        return entry.nodesById.get(id) === root;
      });
      setSelection("node", id, graph);
    });
  }

  function registerGraphNode(graph, root, node) {
    if (!node || typeof node.id !== "string" || graph.nodesById.has(node.id)) return false;
    graph.nodesById.set(node.id, root);
    root.classList.add("ark-harness-graph-node");
    attachNodeSelection(root, node.id);
    attachNodeDrag(graph, root);
    attachNodeConnectors(graph, root);
    attachNodeAffordanceHover(graph, root, node.id);
    if (graph.resizeObserver) graph.resizeObserver.observe(root);
    return true;
  }

  function unregisterGraphNode(graph, id) {
    var root = graph.nodesById.get(id);
    if (root && graph.resizeObserver) graph.resizeObserver.unobserve(root);
    graph.nodesById.delete(id);
    graph.positionsById.delete(id);
    var connectors = graph.nodeConnectorsById.get(id);
    if (connectors) connectors.remove();
    graph.nodeConnectorsById.delete(id);
    var affordance = graph.nodeAffordancesById.get(id);
    clearNodeAffordanceClose(affordance);
    graph.nodeAffordancesById.delete(id);
    if (graphDrag && graphDrag.graph === graph &&
        graphDrag.el.getAttribute("data-model-id") === id) {
      finishGraphDrag(null);
    }
  }

  function removeNode(id) {
    var node = getNode(state.model, id);
    if (!node) return;
    var projections = [];
    graphs.forEach(function (graph) {
      var root = graph.nodesById.get(id);
      if (root && root !== graph.container &&
          root.closest('[data-ark-container="graph"]') === graph.container) {
        projections.push(root);
      }
    });
    document.querySelectorAll("[data-model-id]").forEach(function (element) {
      if (element.getAttribute("data-model-id") !== id ||
          isInsideHarnessUi(element) ||
          element.closest('[data-ark-container="graph"]') ||
          element.hasAttribute("data-ark-container") ||
          element.hasAttribute("data-ark-group")) return;
      var ancestor = element.parentElement;
      while (ancestor && ancestor !== document.body) {
        if (ancestor.getAttribute &&
            ancestor.getAttribute("data-model-id") === id &&
            !ancestor.hasAttribute("data-ark-container") &&
            !ancestor.hasAttribute("data-ark-group")) return;
        ancestor = ancestor.parentElement;
      }
      projections.push(element);
    });
    var incidentIds = new Set();
    state.model.edges.forEach(function (edge) {
      if (edge.from === id || edge.to === id) incidentIds.add(edge.id);
    });
    if (edgeDrag && (
      (edgeDrag.mode === "create" && edgeDrag.sourceId === id) ||
      (edgeDrag.mode === "rewire" && incidentIds.has(edgeDrag.edgeId))
    )) finishEdgeDrag(null, false);
    if (selection.kind === "node" && selection.id === id) clearSelection();

    listBindingsByNode.delete(id);
    state.model.nodes = state.model.nodes.filter(function (entry) {
      return entry.id !== id;
    });
    state.model.edges = state.model.edges.filter(function (edge) {
      return edge.from !== id && edge.to !== id;
    });
    state.model.groups.forEach(function (group) {
      if (!Array.isArray(group.nodes)) return;
      group.nodes = group.nodes.filter(function (nodeId) { return nodeId !== id; });
    });
    graphs.forEach(function (graph) { unregisterGraphNode(graph, id); });
    projections.forEach(function (element) { element.remove(); });
    graphs.forEach(function (graph) { scheduleGraphRender(graph); });
  }

  function handleSelectionKey(event) {
    if ((event.key !== "Delete" && event.key !== "Backspace") ||
        !selection.id || graphDrag || edgeDrag ||
        isEditableControlTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    var selected = { kind: selection.kind, id: selection.id };
    clearSelection();
    if (selected.kind === "node") removeNode(selected.id);
    if (selected.kind === "edge") removeEdge(selected.id);
  }

  function authoredClassName(root) {
    var kept = [];
    root.classList.forEach(function (token) {
      if (token.indexOf("ark-harness-") !== 0) kept.push(token);
    });
    return kept.join(" ");
  }

  function findNodeLabelEl(rootEl, id) {
    var labelEl = null;
    rootEl.querySelectorAll("[data-model-id]").forEach(function (candidate) {
      if (labelEl || candidate === rootEl ||
          candidate.getAttribute("data-model-id") !== id ||
          isInsideHarnessUi(candidate) ||
          candidate.hasAttribute("data-ark-container") ||
          candidate.hasAttribute("data-ark-group")) return;
      var nested = candidate.querySelectorAll("[data-model-id]");
      for (var i = 0; i < nested.length; i++) {
        if (nested[i].getAttribute("data-model-id") === id) return;
      }
      labelEl = candidate;
    });
    return labelEl;
  }

  function projectionTemplateForRoot(template, matched, labelMatched) {
    var tag = template && /^(ARTICLE|SECTION|DIV)$/.test(template.tagName)
      ? template.tagName.toLowerCase()
      : "article";
    var id = template && template.getAttribute("data-model-id");
    var labelEl = (matched || labelMatched) && id
      ? findNodeLabelEl(template, id)
      : null;
    var labelTag = labelEl &&
      /^(H1|H2|H3|H4|H5|H6|SPAN|DIV|P|STRONG|HEADER)$/.test(labelEl.tagName)
      ? labelEl.tagName.toLowerCase()
      : null;
    var listEl = null;
    if (matched && id) {
      template.querySelectorAll("ul, ol").forEach(function (candidate) {
        if (!listEl && !isInsideHarnessUi(candidate) &&
            findOwnerNodeId(state.model, candidate) === id) {
          listEl = candidate;
        }
      });
    }
    return {
      tag: tag,
      className: template ? authoredClassName(template) : "",
      labelTag: labelTag,
      labelClassName: labelEl ? authoredClassName(labelEl) : "",
      listTag: listEl ? listEl.tagName.toLowerCase() : null,
      listClassName: listEl ? authoredClassName(listEl) : ""
    };
  }

  function projectionTemplate(graph, kind, excludeId) {
    var template = null;
    var matched = false;
    var labelMatched = false;
    graph.nodesById.forEach(function (root, id) {
      if (excludeId && id === excludeId) return;
      if (template) return;
      var node = getNode(state.model, id);
      if (kind && node && node.kind === kind) {
        template = root;
        matched = true;
      }
    });
    if (!template) {
      graph.nodesById.forEach(function (root, id) {
        if (excludeId && id === excludeId) return;
        if (!template) {
          template = root;
          if (kind && excludeId) labelMatched = true;
        }
      });
    }
    return projectionTemplateForRoot(template, matched, labelMatched);
  }

  function createNoteProjection(node) {
    var note = document.createElement("div");
    note.className = "ark-harness-note";
    note.setAttribute("data-ark-harness-note", "");
    note.setAttribute("data-placeholder", "\\u30E1\\u30E2\\u3092\\u5165\\u529B");
    note.setAttribute("contenteditable", "true");
    note.textContent = typeof node.noteText === "string" ? node.noteText : "";
    return note;
  }

  function createStructuredProjection(template, node) {
    var label = template.labelTag
      ? document.createElement(template.labelTag)
      : document.createElement("span");
    label.setAttribute("data-model-id", node.id);
    label.setAttribute("data-placeholder", "\\u540D\\u524D\\u3092\\u5165\\u529B");
    if (template.labelClassName) label.className = template.labelClassName;
    label.textContent = typeof node.label === "string" ? node.label : "";
    var list = null;
    if (template.listTag) {
      list = document.createElement(template.listTag);
      if (template.listClassName) list.className = template.listClassName;
      (node.fields || []).forEach(function (field) {
        var li = document.createElement("li");
        li.setAttribute("data-model-id", field.id);
        li.textContent = field.label;
        list.appendChild(li);
      });
    }
    return { label: label, list: list };
  }

  function createNodeProjection(graph, node) {
    var template = projectionTemplate(graph, node.kind || "");
    var root = template.tag === "section"
      ? document.createElement("section")
      : template.tag === "div"
        ? document.createElement("div")
        : document.createElement("article");
    root.setAttribute("data-model-id", node.id);
    if (node.kind) root.setAttribute("data-kind", node.kind);
    if (template.className) root.className = template.className;
    var label = null;
    var list = null;
    var note = null;
    if (node.kind === "note") {
      note = createNoteProjection(node);
      root.appendChild(note);
    } else {
      if (node.kind === "entity") {
        if (!template.labelTag) template.labelTag = "h2";
        if (!template.listTag) template.listTag = "ul";
      }
      var structured = createStructuredProjection(template, node);
      label = structured.label;
      list = structured.list;
      root.appendChild(label);
      if (list) root.appendChild(list);
    }
    return { root: root, label: label, list: list, note: note };
  }

  function nodePlacementBlockers(graph, excluded) {
    var blockers = [];
    var add = function (element) {
      if (element === excluded || !element.isConnected) return;
      var rect = graphLocalRect(graph, element);
      if (rect && rect.width > 0 && rect.height > 0) blockers.push(rect);
    };
    graph.nodesById.forEach(add);
    graph.svg.querySelectorAll("text[data-ark-edge-id]").forEach(add);
    graph.edgeHandlesByKey.forEach(add);
    return blockers;
  }

  function findNodePlacement(graph, root) {
    var config = readLayoutConfig(state.model);
    var rect = root.getBoundingClientRect();
    var width = rect.width || 160;
    var height = rect.height || 64;
    var blockers = nodePlacementBlockers(graph, root);
    var maximumRight = config.padding;
    var maximumBottom = config.padding;
    blockers.forEach(function (blocker) {
      maximumRight = Math.max(maximumRight, blocker.x + blocker.width);
      maximumBottom = Math.max(maximumBottom, blocker.y + blocker.height);
    });
    var candidates = [];
    for (var i = 0; i < blockers.length + 8; i++) {
      candidates.push(config.direction === "TB"
        ? {
            x: config.padding + i * (width + config.nodeSpacing),
            y: maximumBottom + config.rankSpacing
          }
        : {
            x: maximumRight + config.rankSpacing,
            y: config.padding + i * (height + config.nodeSpacing)
          });
    }
    for (var j = 0; j < candidates.length; j++) {
      var candidate = {
        x: Math.max(0, Math.round(candidates[j].x)),
        y: Math.max(0, Math.round(candidates[j].y)),
        width: width,
        height: height
      };
      if (!blockers.some(function (blocker) {
        return rectanglesCollide(candidate, blocker, config.nodeSpacing);
      })) return { x: candidate.x, y: candidate.y };
    }
    return config.direction === "TB"
      ? { x: Math.round(maximumRight + config.nodeSpacing), y: Math.round(maximumBottom + config.rankSpacing) }
      : { x: Math.round(maximumRight + config.rankSpacing), y: Math.round(maximumBottom + config.nodeSpacing) };
  }

  function createNodeInGraph(graph, kind, point) {
    if (!graph || graphs.indexOf(graph) === -1) {
      updateStatus(!!submitPort, "配置先 graph を解決できませんでした");
      return null;
    }
    if (kind !== "note" && kind &&
        kindCandidates.indexOf(kind) === -1) return null;
    var id = generateUniqueModelId("node");
    if (!id) {
      updateStatus(!!submitPort, "一意な ID を生成できませんでした");
      return null;
    }
    var node = { id: id, label: "", ext: { x: 0, y: 0 } };
    if (kind) node.kind = kind;
    if (kind === "note") node.noteText = "";
    var projection = createNodeProjection(graph, node);
    graph.container.appendChild(projection.root);
    projection.root.classList.add("ark-harness-graph-node");
    projection.root.style.setProperty("--ark-harness-graph-x", "0px");
    projection.root.style.setProperty("--ark-harness-graph-y", "0px");
    try {
      var rect = projection.root.getBoundingClientRect();
      var position = point === null
        ? findNodePlacement(graph, projection.root)
        : {
            x: Math.max(0, Math.round(point.x - (rect.width || 160) / 2)),
            y: Math.max(0, Math.round(point.y - (rect.height || 64) / 2))
          };
      node.ext.x = position.x;
      node.ext.y = position.y;
      state.model.nodes.push(node);
      if (!registerGraphNode(graph, projection.root, node)) {
        throw new Error("node registration failed");
      }
      if (projection.label) wireEditableLeaf(projection.label, null);
      if (projection.note) wireNote(projection.note, node);
      if (projection.list) {
        var owned = listBindingsByNode.get(node.id) || [];
        owned.push({ listEl: projection.list, ownerNodeId: node.id });
        listBindingsByNode.set(node.id, owned);
        wireList(projection.list, node.id);
        projection.list.querySelectorAll(":scope > li").forEach(function (li) {
          wireEditableLeaf(li, {
            listEl: projection.list,
            ownerNodeId: node.id
          });
        });
      }
      lastKind = kind;
      graphs.forEach(function (entry) { scheduleGraphRender(entry); });
      return node;
    } catch (error) {
      state.model.nodes = state.model.nodes.filter(function (entry) {
        return entry.id !== id;
      });
      unregisterGraphNode(graph, id);
      projection.root.remove();
      updateStatus(!!submitPort, "ノードを追加できませんでした");
      return null;
    }
  }

  function wireGraph(container) {
    var nodesById = new Map();
    var nodeCandidates = [];
    var groupsById = new Map();
    var groupCandidates = container.querySelectorAll("[data-ark-group][data-model-id]");
    groupCandidates.forEach(function (el) {
      if (el.closest('[data-ark-container="graph"]') !== container) return;
      var id = el.getAttribute("data-model-id");
      if (!id || groupsById.has(id) || !getGroup(state.model, id)) return;
      groupsById.set(id, el);
    });
    var candidates = container.querySelectorAll("[data-model-id]");
    candidates.forEach(function (el) {
      if (el.closest('[data-ark-container="graph"]') !== container) return;
      var id = el.getAttribute("data-model-id");
      if (!id || nodesById.has(id)) return;
      var node = getNode(state.model, id);
      if (!node) return;
      nodesById.set(id, el);
      nodeCandidates.push({ root: el, node: node });
    });

    var svg = svgElement("svg");
    svg.classList.add("ark-harness-edge-layer");
    markUi(svg);
    container.appendChild(svg);
    var previewLayer = document.createElement("div");
    previewLayer.classList.add("ark-harness-edge-preview-layer");
    markUi(previewLayer);
    container.appendChild(previewLayer);
    var handleLayer = document.createElement("div");
    handleLayer.className = "ark-harness-edge-handle-layer";
    markUi(handleLayer);
    container.appendChild(handleLayer);
    graphSequence += 1;
    var graph = {
      container: container,
      nodesById: nodesById,
      groupsById: groupsById,
      svg: svg,
      edgeGeometryById: new Map(),
      edgeMainById: new Map(),
      handleLayer: handleLayer,
      previewLayer: previewLayer,
      edgeHandlesByKey: new Map(),
      nodeConnectorsById: new Map(),
      nodeAffordancesById: new Map(),
      positionsById: new Map(),
      layoutExtent: { width: null, height: null },
      resizeObserver: null,
      scheduled: false,
      markerId: "ark-harness-arrow-" + graphSequence
    };
    nodesById.clear();
    nodeCandidates.forEach(function (candidate) {
      registerGraphNode(graph, candidate.root, candidate.node);
    });
    if (typeof ResizeObserver !== "undefined") {
      graph.resizeObserver = new ResizeObserver(function () { scheduleGraphRender(graph); });
      graph.resizeObserver.observe(container);
      graph.nodesById.forEach(function (el) { graph.resizeObserver.observe(el); });
    }
    scheduleGraphRender(graph);
    return graph;
  }

  function initGraphs() {
    var containers = document.querySelectorAll('[data-ark-container="graph"]');
    containers.forEach(function (container) { graphs.push(wireGraph(container)); });
    window.addEventListener("resize", function () {
      graphs.forEach(function (graph) { scheduleGraphRender(graph); });
      scheduleContextToolbarPosition();
    });
    window.addEventListener("scroll", scheduleContextToolbarPosition, true);
    window.addEventListener("pointerup", function (event) {
      finishEdgeDrag(event, true);
    });
    window.addEventListener("pointercancel", function (event) {
      finishEdgeDrag(event, false);
    });
    window.addEventListener("click", function (event) {
      if (event.button !== 0) return;
      var target = event.target;
      if (!target || isInsideHarnessUi(target) ||
          target.closest(".ark-harness-graph-node") ||
          target.closest(".ark-harness-edge-hit-target") ||
          isEditableControlTarget(target)) return;
      clearSelection();
    });
    window.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        if (edgeDrag) event.preventDefault();
        finishEdgeDrag(null, false);
        clearSelection();
        return;
      }
      handleSelectionKey(event);
    }, true);
  }

  function findEntry(model, id) {
    if (!model) return null;
    var nodes = model.nodes || [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.id === id) {
        return {
          set: (function (n) {
            return function (v) { n.label = v; };
          })(node)
        };
      }
      var fields = node.fields || [];
      for (var j = 0; j < fields.length; j++) {
        if (fields[j].id === id) {
          return {
            set: (function (f) {
              return function (v) { f.label = v; };
            })(fields[j])
          };
        }
      }
    }
    var edges = model.edges || [];
    for (var k = 0; k < edges.length; k++) {
      if (edges[k].id === id) {
        return {
          set: (function (e) {
            return function (v) { e.label = v; };
          })(edges[k])
        };
      }
    }
    var groups = model.groups || [];
    for (var m = 0; m < groups.length; m++) {
      if (groups[m].id === id) {
        return {
          set: (function (g) {
            return function (v) { g.label = v; };
          })(groups[m])
        };
      }
    }
    return null;
  }

  function findOwnerNodeId(model, listEl) {
    var ancestor = listEl.parentElement;
    while (ancestor) {
      var id = ancestor.getAttribute("data-model-id");
      if (id && getNode(model, id)) return id;
      ancestor = ancestor.parentElement;
    }
    return null;
  }

  function isLeaf(el) {
    var children = el.children;
    for (var i = 0; i < children.length; i++) {
      if (BLOCK_TAGS[children[i].tagName]) return false;
    }
    return true;
  }

  function isInsideHarnessUi(el) {
    return !!(el.closest && el.closest("[data-ark-harness-ui]"));
  }

  function syncNodeKinds() {
    document.querySelectorAll("[data-model-id]").forEach(function (el) {
      if (isInsideHarnessUi(el)) return;
      var id = el.getAttribute("data-model-id");
      if (!id) return;
      var node = getNode(state.model, id);
      if (!node) return;
      if (typeof node.kind === "string") {
        el.setAttribute("data-kind", node.kind);
      } else {
        el.removeAttribute("data-kind");
      }
    });
  }

  function createKindOption(value) {
    var option = document.createElement("option");
    option.textContent = value;
    option.value = value;
    markUi(option);
    return option;
  }

  function rememberProjectionTemplate(root, kind) {
    if (!kind || kind === "note") return;
    if (!root.__arkHarnessProjectionTemplates) {
      root.__arkHarnessProjectionTemplates = new Map();
    }
    root.__arkHarnessProjectionTemplates.set(
      kind,
      projectionTemplateForRoot(root, true, true)
    );
  }

  function projectionTemplateForKind(graph, root, kind, id) {
    var remembered = root.__arkHarnessProjectionTemplates &&
      root.__arkHarnessProjectionTemplates.get(kind);
    var template = remembered || projectionTemplate(graph, kind, id);
    if (kind === "entity") {
      if (!template.labelTag) template.labelTag = "h2";
      if (!template.listTag) template.listTag = "ul";
    }
    return template;
  }

  function clearNodeProjection(root) {
    Array.from(root.childNodes).forEach(function (child) {
      if (child.nodeType === 1 && isInsideHarnessUi(child)) return;
      root.removeChild(child);
    });
  }

  function registerProjectedList(node, list) {
    var binding = { listEl: list, ownerNodeId: node.id };
    listBindingsByNode.set(node.id, [binding]);
    wireList(list, node.id);
    list.querySelectorAll(":scope > li").forEach(function (li) {
      wireEditableLeaf(li, {
        listEl: list,
        ownerNodeId: node.id
      });
    });
  }

  function projectNoteContent(root, node) {
    listBindingsByNode.delete(node.id);
    clearNodeProjection(root);
    var note = createNoteProjection(node);
    root.insertBefore(note, root.firstChild);
    wireNote(note, node);
  }

  function projectStructuredContent(root, node, template) {
    listBindingsByNode.delete(node.id);
    clearNodeProjection(root);
    var projection = createStructuredProjection(template, node);
    root.insertBefore(projection.label, root.firstChild);
    wireEditableLeaf(projection.label, null);
    if (projection.list) {
      root.insertBefore(projection.list, projection.label.nextSibling);
      registerProjectedList(node, projection.list);
    }
  }

  function updateNodeKind(graph, root, value) {
    var id = root.getAttribute("data-model-id");
    if (!id || !(value === "note" ||
        kindCandidates.indexOf(value) !== -1)) return;
    var node = getNode(state.model, id);
    if (!node) return;
    var previousKind = typeof node.kind === "string" ? node.kind : "";
    if (previousKind === value) {
      lastKind = value;
      return;
    }
    rememberProjectionTemplate(root, previousKind);
    node.kind = value;
    lastKind = value;
    if (value === "note") {
      if (typeof node.noteText !== "string") node.noteText = "";
      projectNoteContent(root, node);
    } else {
      var tpl = projectionTemplateForKind(graph, root, value, id);
      if (tpl.listTag || previousKind === "note") {
        projectStructuredContent(root, node, tpl);
      } else {
        var targetTag = tpl.labelTag || "span";
        var targetClass = tpl.labelClassName || "";
        var cur = findNodeLabelEl(root, id);
        if (cur && cur.tagName.toLowerCase() !== targetTag) {
          var next = document.createElement(targetTag);
          if (targetClass) next.className = targetClass;
          next.setAttribute("data-model-id", id);
          next.textContent = typeof node.label === "string"
            ? node.label
            : (cur.textContent || "");
          cur.parentNode.replaceChild(next, cur);
          wireEditableLeaf(next, null);
        }
      }
    }
    syncNodeKinds();
    renderContextToolbar();
    scheduleGraphRender(graph);
  }

  function markUi(el) {
    el.setAttribute("data-ark-harness-ui", "1");
    return el;
  }

  function createButton(text, className, ariaLabel) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.textContent = text;
    if (ariaLabel) {
      btn.setAttribute("aria-label", ariaLabel);
      btn.title = ariaLabel;
    }
    markUi(btn);
    return btn;
  }

  function updateStatus(connected, message) {
    if (sendBtn) sendBtn.disabled = !connected;
    if (!statusEl) return;
    statusEl.textContent = message || (connected ? "送信可能" : "親フレーム未接続");
    if (connected) {
      statusEl.classList.add("ark-harness-status-ok");
    } else {
      statusEl.classList.remove("ark-harness-status-ok");
    }
  }

  function isDebugMode() {
    return /(^|[#,])ark-debug($|[,])/.test(location.hash);
  }

  function syncDirtyState() {
    var modelJson = JSON.stringify(state.model);
    var dirty = modelJson !== baselineModelJson;
    if (sendBtn) sendBtn.style.display = dirty ? "" : "none";
    if (statusEl) statusEl.style.display = dirty ? "" : "none";
    syncToolbarVisibility(dirty);
    clearTimeout(autosaveTimer);
    if (modelJson !== savedJson && !savingJson && submitPort) {
      autosaveTimer = setTimeout(function () {
        try {
          savingJson = JSON.stringify(state.model);
          updateStatus(true, "保存中…");
          submitPort.postMessage({ type: "ark:diagram-autosave", model: state.model, html: buildSubmissionHtml() });
        } catch {
          savingJson = null;
          updateStatus(true, "保存失敗");
        }
      }, 800);
    }
  }

  function syncToolbarVisibility(dirty) {
    if (!toolbarEl) return;
    if (dirty === undefined) dirty = JSON.stringify(state.model) !== baselineModelJson;
    var debug = isDebugMode();
    toolbarEl.style.display = dirty || debug ? "" : "none";
  }

  function attachRowControls(li, listEl, ownerNodeId) {
    var handle = createButton("\\u283F", "ark-harness-handle", "ドラッグして並べ替え");
    handle.draggable = true;
    handle.addEventListener("dragstart", function (e) {
      dragSrcLi = li;
      li.classList.add("ark-harness-dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", li.getAttribute("data-model-id") || "");
      }
    });
    handle.addEventListener("dragend", function () {
      li.classList.remove("ark-harness-dragging");
      dragSrcLi = null;
    });

    var del = createButton("\\u00D7", "ark-harness-delete", "この行を削除");
    del.addEventListener("click", function () {
      var node = getNode(state.model, ownerNodeId);
      var id = li.getAttribute("data-model-id");
      if (node && node.fields) {
        node.fields = node.fields.filter(function (f) { return f.id !== id; });
      }
      li.remove();
      syncDirtyState();
    });

    li.appendChild(handle);
    li.appendChild(del);
  }

  function wireEditableLeaf(el, rowInfo) {
    var id = el.getAttribute("data-model-id");
    if (!id) return;

    var editableTarget = el;
    if (rowInfo) {
      var span = document.createElement("span");
      span.className = "ark-harness-text";
      span.setAttribute("data-ark-harness-wrap", "1");
      while (el.firstChild) span.appendChild(el.firstChild);
      el.appendChild(span);
      editableTarget = span;
      el.classList.add("ark-harness-row");
    }

    editableTarget.contentEditable = "true";
    editableTarget.classList.add("ark-harness-editable");
    editableTarget.addEventListener("input", function () {
      var entry = findEntry(state.model, id);
      if (entry) entry.set(editableTarget.textContent || "");
      syncDirtyState();
    });

    editableTarget.addEventListener("keydown", function (event) {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      var binding = rowInfo || listBinding(
        id,
        editableTarget.closest(".ark-harness-graph-node")
      );
      if (!binding || rowInfo && el !== binding.listEl.lastElementChild) return;
      var next = addField(binding.listEl, binding.ownerNodeId);
      if (next) next.focus();
    });
    if (rowInfo) {
      attachRowControls(el, rowInfo.listEl, rowInfo.ownerNodeId);
    }
    return editableTarget;
  }

  function wireNote(el, node) {
    var ownerId = node.id;
    if (el.__arkHarnessNoteWired) return;
    el.__arkHarnessNoteWired = true;
    el.addEventListener("input", function () {
      var text = typeof el.innerText === "string"
        ? el.innerText
        : (el.textContent || "");
      var current = getNode(state.model, ownerId);
      if (!current) return;
      current.noteText = text.replace(/\\r\\n?/g, "\\n");
      syncDirtyState();
    });
  }

  function syncFieldOrder(listEl, ownerNodeId) {
    var node = getNode(state.model, ownerNodeId);
    if (!node) return;
    var ids = [];
    for (var i = 0; i < listEl.children.length; i++) {
      var child = listEl.children[i];
      if (child.tagName === "LI") {
        var id = child.getAttribute("data-model-id");
        if (id) ids.push(id);
      }
    }
    var fields = node.fields || [];
    var byId = {};
    fields.forEach(function (f) { byId[f.id] = f; });
    var reordered = [];
    ids.forEach(function (id) {
      if (byId[id]) reordered.push(byId[id]);
    });
    fields.forEach(function (f) {
      if (reordered.indexOf(f) === -1) reordered.push(f);
    });
    node.fields = reordered;
    syncDirtyState();
  }

  function addField(listEl, ownerNodeId) {
    var node = getNode(state.model, ownerNodeId);
    if (!node) return;
    var id = generateUniqueModelId("field");
    if (!id) {
      updateStatus(!!submitPort, "一意な ID を生成できませんでした");
      return;
    }
    var field = { id: id, label: "" };
    if (!node.fields) node.fields = [];
    node.fields.push(field);
    syncDirtyState();

    var li = document.createElement("li");
    li.setAttribute("data-model-id", id);
    listEl.appendChild(li);

    var editable = wireEditableLeaf(li, { listEl: listEl, ownerNodeId: ownerNodeId });
    if (editable) editable.setAttribute("data-placeholder", "\\u9805\\u76EE\\u3092\\u5165\\u529B");
    return editable;
  }

  function wireList(listEl, ownerNodeId) {
    listEl.addEventListener("dragover", function (e) {
      if (!dragSrcLi || dragSrcLi.parentElement !== listEl) return;
      e.preventDefault();
      var targetLi = e.target && e.target.closest ? e.target.closest("li") : null;
      if (!targetLi || targetLi === dragSrcLi || targetLi.parentElement !== listEl) return;
      var rect = targetLi.getBoundingClientRect();
      var before = e.clientY - rect.top < rect.height / 2;
      listEl.insertBefore(dragSrcLi, before ? targetLi : targetLi.nextSibling);
    });
    listEl.addEventListener("drop", function (e) {
      if (!dragSrcLi) return;
      e.preventDefault();
      syncFieldOrder(listEl, ownerNodeId);
    });
  }

  function initEditing() {
    var model = state.model;
    var listBindings = [];
    listBindingsByNode = new Map();
    var listEls = document.querySelectorAll("ul, ol");
    listEls.forEach(function (listEl) {
      if (isInsideHarnessUi(listEl)) return;
      var ownerNodeId = findOwnerNodeId(model, listEl);
      if (ownerNodeId) {
        var binding = { listEl: listEl, ownerNodeId: ownerNodeId };
        listBindings.push(binding);
        var owned = listBindingsByNode.get(ownerNodeId) || [];
        owned.push(binding);
        listBindingsByNode.set(ownerNodeId, owned);
      }
    });

    listBindings.forEach(function (binding) {
      wireList(binding.listEl, binding.ownerNodeId);
    });

    function bindingFor(listEl) {
      for (var i = 0; i < listBindings.length; i++) {
        if (listBindings[i].listEl === listEl) return listBindings[i];
      }
      return null;
    }

    var editableEls = document.querySelectorAll("[data-model-id]");
    editableEls.forEach(function (el) {
      if (isInsideHarnessUi(el)) return;
      if (el.hasAttribute("data-ark-group")) return;
      if (getNode(model, el.getAttribute("data-model-id")) &&
          el.closest('[data-ark-container="graph"]') &&
          el.querySelector("[data-model-id]")) return;
      if (!isLeaf(el)) return;
      var rowInfo = null;
      if (el.tagName === "LI" && el.parentElement) {
        var binding = bindingFor(el.parentElement);
        if (binding) {
          rowInfo = { listEl: binding.listEl, ownerNodeId: binding.ownerNodeId };
        }
      }
      wireEditableLeaf(el, rowInfo);
    });
  }

  function initNoteProjections() {
    graphs.forEach(function (graph) {
      graph.nodesById.forEach(function (root, id) {
        var node = getNode(state.model, id);
        if (node && node.kind === "note") projectNoteContent(root, node);
      });
    });
  }

  function buildSubmissionHtml() {
    var clone = document.documentElement.cloneNode(true);

    clone.querySelectorAll("[data-ark-harness-ui]").forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    if (clone.body) {
      clone.body.style.removeProperty("--ark-harness-toolbar-height");
      if (clone.body.style.length === 0) clone.body.removeAttribute("style");
    }
    clone.querySelectorAll(".ark-harness-graph-node").forEach(function (el) {
      el.style.removeProperty("--ark-harness-graph-x");
      el.style.removeProperty("--ark-harness-graph-y");
      if (el.style.length === 0) el.removeAttribute("style");
    });
    clone.querySelectorAll('[data-ark-container="graph"]').forEach(function (el) {
      GRAPH_LAYOUT_PROPERTIES.forEach(function (property) {
        el.style.removeProperty(property);
      });
      if (el.style.length === 0) el.removeAttribute("style");
    });
    clone.querySelectorAll(".ark-harness-graph-group").forEach(function (el) {
      GROUP_GEOMETRY_PROPERTIES.forEach(function (property) {
        el.style.removeProperty(property);
      });
      if (el.style.length === 0) el.removeAttribute("style");
    });
    clone.querySelectorAll("[data-ark-harness-wrap]").forEach(function (span) {
      var parent = span.parentNode;
      if (!parent) return;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
    });
    clone.querySelectorAll("[contenteditable]").forEach(function (el) {
      el.removeAttribute("contenteditable");
    });
    clone.querySelectorAll("[data-placeholder]").forEach(function (el) {
      el.removeAttribute("data-placeholder");
    });
    clone.querySelectorAll(".ark-harness-node-tabindex-added").forEach(function (el) {
      el.removeAttribute("tabindex");
    });
    clone.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]').forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    clone.querySelectorAll("[class]").forEach(function (el) {
      var kept = [];
      el.classList.forEach(function (c) {
        if (c.indexOf("ark-harness-") !== 0) kept.push(c);
      });
      if (kept.length) {
        el.className = kept.join(" ");
      } else {
        el.removeAttribute("class");
      }
    });

    return clone.outerHTML;
  }

  function handleSubmit() {
    if (!submitPort) {
      updateStatus(false, "親フレーム未接続のため送信できません");
      return;
    }
    if (savingJson) {
      submitPending = true;
      return;
    }
    try {
      clearTimeout(autosaveTimer);
      var html = buildSubmissionHtml();
      submitPort.postMessage({ type: "ark:diagram-submit", model: state.model, html: html });
      baselineModelJson = JSON.stringify(state.model);
      savedJson = baselineModelJson;
      updateStatus(true, "送信しました");
      syncDirtyState();
    } catch (e) {
      updateStatus(true, "送信に失敗しました: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  function buildModelPanel() {
    var panel = document.createElement("div");
    panel.className = "ark-harness-model-panel";
    panel.style.display = "none";
    markUi(panel);

    var label = document.createElement("div");
    label.className = "ark-harness-model-panel-label";
    label.textContent = "モデル JSON（直接編集）";
    panel.appendChild(label);

    var textarea = document.createElement("textarea");
    textarea.className = "ark-harness-textarea";
    textarea.spellcheck = false;
    panel.appendChild(textarea);

    var error = document.createElement("div");
    error.className = "ark-harness-model-error";
    error.style.display = "none";
    panel.appendChild(error);

    var actions = document.createElement("div");
    actions.className = "ark-harness-model-actions";
    var applyBtn = createButton("反映", "ark-harness-btn ark-harness-btn-primary");
    var closeBtn = createButton("閉じる", "ark-harness-btn ark-harness-btn-secondary");
    actions.appendChild(applyBtn);
    actions.appendChild(closeBtn);
    panel.appendChild(actions);

    applyBtn.addEventListener("click", function () {
      try {
        var parsed = JSON.parse(textarea.value);
        if (!isRecordObject(parsed)) throw new Error("モデルはオブジェクトである必要があります");
        if (!Array.isArray(parsed.nodes)) throw new Error("nodes は配列である必要があります");
        if (!Array.isArray(parsed.edges)) parsed.edges = [];
        if (!Array.isArray(parsed.groups)) parsed.groups = [];
        finishEdgeDrag(null, false);
        state.model = parsed;
        reserveCurrentModelIds();
        syncNodeKinds();
        syncLayoutDirectionButton();
        reconcileSelection();
        initNoteProjections();
        graphs.forEach(function (graph) { scheduleGraphRender(graph); });
        syncDirtyState();
        error.style.display = "none";
        panel.style.display = "none";
      } catch (e) {
        error.textContent = "JSON を解析できません: " + (e instanceof Error ? e.message : String(e));
        error.style.display = "block";
      }
    });
    closeBtn.addEventListener("click", function () {
      panel.style.display = "none";
    });

    panel.__textarea = textarea;
    panel.__error = error;
    return panel;
  }

  function syncToolbarHeight(bar) {
    var update = function () {
      var height = Math.ceil(bar.getBoundingClientRect().height);
      document.body.style.setProperty("--ark-harness-toolbar-height", height + "px");
    };
    update();
    window.requestAnimationFrame(update);
    if (typeof ResizeObserver !== "undefined") {
      var observer = new ResizeObserver(update);
      observer.observe(bar);
    }
  }

  function buildToolbar() {
    var bar = document.createElement("div");
    bar.className = "ark-harness-toolbar";
    markUi(bar);
    toolbarEl = bar;

    if (document.querySelector('[data-ark-container="graph"]')) {
      layoutDirectionBtn = createButton("", "ark-harness-btn ark-harness-btn-secondary ark-harness-layout-direction");
      syncLayoutDirectionButton();
      layoutDirectionBtn.addEventListener("click", toggleLayoutDirection);
      bar.appendChild(layoutDirectionBtn);
    }

    var editModelBtn = createButton("モデルを直接編集", "ark-harness-btn ark-harness-btn-secondary", "モデル JSON を直接編集する");

    var spacer = document.createElement("div");
    spacer.className = "ark-harness-spacer";
    markUi(spacer);

    statusEl = document.createElement("span");
    statusEl.className = "ark-harness-status";
    markUi(statusEl);

    sendBtn = createButton("変更を送る", "ark-harness-btn ark-harness-btn-secondary", "変更を親フレームへ送信する");
    sendBtn.disabled = true;
    sendBtn.addEventListener("click", handleSubmit);

    bar.appendChild(editModelBtn);
    bar.appendChild(spacer);
    bar.appendChild(statusEl);
    bar.appendChild(sendBtn);

    var panel = buildModelPanel();

    document.body.appendChild(panel);
    document.body.appendChild(bar);
    syncToolbarHeight(bar);

    editModelBtn.addEventListener("click", function () {
      var opening = panel.style.display !== "flex";
      if (opening) {
        panel.__textarea.value = JSON.stringify(state.model, null, 2);
        panel.__error.style.display = "none";
      }
      panel.style.display = opening ? "flex" : "none";
    });

    function syncDebugChrome() {
      var debug = isDebugMode();
      editModelBtn.style.display = debug ? "" : "none";
      if (layoutDirectionBtn) layoutDirectionBtn.style.display = debug ? "" : "none";
      syncToolbarVisibility();
    }
    syncDebugChrome();
    window.addEventListener("hashchange", syncDebugChrome);

    updateStatus(false);
    syncDirtyState();
  }

  function init() {
    try {
      var model = loadModel();
      if (!model) return;
      state.model = model;
      baselineModelJson = JSON.stringify(state.model);
      savedJson = baselineModelJson;
      reservedModelIds = collectModelIds(model);
      syncNodeKinds();
      kindCandidates = collectKindCandidates();
      buildToolbar();
      initEditing();
      buildContextToolbar();
      initGraphs();
      initNoteProjections();
    } catch (e) {
      console.error("[ark-harness] 初期化に失敗しました", e);
    }
  }

  init();

  window.addEventListener("wheel",function(e){if(!e.ctrlKey||!submitPort)return;e.preventDefault();submitPort.postMessage({type:"ark:diagram-pinch",deltaY:e.deltaY})},{passive:false});
  window.addEventListener("message", function onMessage(event) {
    // event.origin は検証しない: sandbox iframe は不透明オリジンで
    // event.origin === "null" になる（実測済み）。port を持っていること
    // 自体を能力として扱う（親からの MessageChannel port 受け渡しが前提）。
    if (submitPort) return;
    if (event.ports && event.ports.length > 0) {
      submitPort = event.ports[0];
      submitPort.onmessage = function (e) {
        if (e.data && e.data.type === "ark:diagram-autosave-result") {
          if (e.data.ok) savedJson = savingJson;
          savingJson = null;
          if (e.data.ok) updateStatus(true, "保存済み");
          else updateStatus(false, "保存失敗");
          if (submitPending) {
            submitPending = false;
            handleSubmit();
          } else syncDirtyState();
        }
      };
      updateStatus(true);
      syncDirtyState();
    }
  });
})();`;

const GROUP_ADAPTER_START = "  function applyGroupLayout(";
const GROUP_ADAPTER_END = "  function svgElement(";
const groupAdapterStart = RAW_HARNESS_JS.indexOf(GROUP_ADAPTER_START);
const groupAdapterEnd = RAW_HARNESS_JS.indexOf(
  GROUP_ADAPTER_END,
  groupAdapterStart
);
const GROUP_COMPACTED_HARNESS_JS =
  RAW_HARNESS_JS.slice(0, groupAdapterStart) +
  compactTrustedJavaScript(
    RAW_HARNESS_JS.slice(groupAdapterStart, groupAdapterEnd)
  ) +
  RAW_HARNESS_JS.slice(groupAdapterEnd);

function requireIndex(value: string, marker: string): number {
  const index = value.indexOf(marker);
  if (index === -1) {
    throw new Error(`ハーネス圧縮マーカーが見つかりません: ${marker}`);
  }
  return index;
}

const AUTO_LAYOUT_START = "  function assignLayerRanks(";
const AUTO_LAYOUT_END = "function applyGroupLayout(";
const autoLayoutStart = requireIndex(
  GROUP_COMPACTED_HARNESS_JS,
  AUTO_LAYOUT_START
);
const autoLayoutEnd = requireIndex(GROUP_COMPACTED_HARNESS_JS, AUTO_LAYOUT_END);
const AUTO_LAYOUT_COMPACTED_HARNESS_JS =
  GROUP_COMPACTED_HARNESS_JS.slice(0, autoLayoutStart) +
  compactTrustedJavaScript(
    GROUP_COMPACTED_HARNESS_JS.slice(autoLayoutStart, autoLayoutEnd)
  ) +
  GROUP_COMPACTED_HARNESS_JS.slice(autoLayoutEnd);

const GRAPH_DRAG_START = "  function finishGraphDrag(";
const GRAPH_DRAG_END = "  function syncNodeConnectors(";
const graphDragStart = requireIndex(
  AUTO_LAYOUT_COMPACTED_HARNESS_JS,
  GRAPH_DRAG_START
);
const graphDragEnd = requireIndex(
  AUTO_LAYOUT_COMPACTED_HARNESS_JS,
  GRAPH_DRAG_END
);
const GRAPH_DRAG_COMPACTED_HARNESS_JS =
  AUTO_LAYOUT_COMPACTED_HARNESS_JS.slice(0, graphDragStart) +
  compactTrustedJavaScript(
    AUTO_LAYOUT_COMPACTED_HARNESS_JS.slice(graphDragStart, graphDragEnd)
  ) +
  AUTO_LAYOUT_COMPACTED_HARNESS_JS.slice(graphDragEnd);

const STATUS_STATE_START = "  function updateStatus(";
const STATUS_STATE_END = "  function attachRowControls(";
const statusStateStart = requireIndex(
  GRAPH_DRAG_COMPACTED_HARNESS_JS,
  STATUS_STATE_START
);
const statusStateEnd = requireIndex(
  GRAPH_DRAG_COMPACTED_HARNESS_JS,
  STATUS_STATE_END
);
const STATUS_COMPACTED_HARNESS_JS =
  GRAPH_DRAG_COMPACTED_HARNESS_JS.slice(0, statusStateStart) +
  compactTrustedJavaScript(
    GRAPH_DRAG_COMPACTED_HARNESS_JS.slice(statusStateStart, statusStateEnd)
  ) +
  GRAPH_DRAG_COMPACTED_HARNESS_JS.slice(statusStateEnd);
const SUBMIT_START = "  function handleSubmit(";
const SUBMIT_END = "  function buildModelPanel(";
const submitStart = requireIndex(STATUS_COMPACTED_HARNESS_JS, SUBMIT_START);
const submitEnd = requireIndex(STATUS_COMPACTED_HARNESS_JS, SUBMIT_END);
const SUBMIT_COMPACTED_HARNESS_JS =
  STATUS_COMPACTED_HARNESS_JS.slice(0, submitStart) +
  compactTrustedJavaScript(
    STATUS_COMPACTED_HARNESS_JS.slice(submitStart, submitEnd)
  ) +
  STATUS_COMPACTED_HARNESS_JS.slice(submitEnd);
const INIT_START = "  function init() {";
const INIT_END = "  init();";
const initStart = requireIndex(SUBMIT_COMPACTED_HARNESS_JS, INIT_START);
const initEnd = requireIndex(SUBMIT_COMPACTED_HARNESS_JS, INIT_END);
const INIT_COMPACTED_HARNESS_JS =
  SUBMIT_COMPACTED_HARNESS_JS.slice(0, initStart) +
  compactTrustedJavaScript(
    SUBMIT_COMPACTED_HARNESS_JS.slice(initStart, initEnd)
  ) +
  SUBMIT_COMPACTED_HARNESS_JS.slice(initEnd);
const PORT_HANDLER_START = "    if (submitPort) return;";
const PORT_HANDLER_END = "  });\n})();";
const portHandlerStart = requireIndex(
  INIT_COMPACTED_HARNESS_JS,
  PORT_HANDLER_START
);
const portHandlerEnd = requireIndex(
  INIT_COMPACTED_HARNESS_JS,
  PORT_HANDLER_END
);
const HARNESS_JS =
  INIT_COMPACTED_HARNESS_JS.slice(0, portHandlerStart) +
  compactTrustedJavaScript(
    INIT_COMPACTED_HARNESS_JS.slice(portHandlerStart, portHandlerEnd)
  ) +
  INIT_COMPACTED_HARNESS_JS.slice(portHandlerEnd);

export const DIAGRAM_HARNESS_SCRIPT = `${HARNESS_STYLE}
<script id="${DIAGRAM_HARNESS_MARKER}" data-ark-harness-ui="1">
${HARNESS_JS}
</script>`;

/**
 * ハーネスを本文へ差し込む。`injectCsp` と同じ「本文に差し込む」形。
 * `</body>` の直前へ差し込み、無ければ末尾へ追記する。
 * 既にマーカーを含む場合は何もしない（二重注入防止）。
 */
export function injectHarness(html: string): string {
  if (html.includes(DIAGRAM_HARNESS_MARKER)) return html;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${DIAGRAM_HARNESS_SCRIPT}</body>`);
  }
  return html + DIAGRAM_HARNESS_SCRIPT;
}
