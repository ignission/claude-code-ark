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

/**
 * 二重注入検出に使うマーカー。注入する `<script>` タグの id 属性の値として
 * 一度だけ現れる（HARNESS_JS / HARNESS_STYLE の中では絶対に使わない）。
 */
export const DIAGRAM_HARNESS_MARKER = "ark-diagram-harness";

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
.ark-harness-editable:hover { outline-color: rgba(56,189,248,.35); }
.ark-harness-editable:focus { outline: 1px solid #38bdf8; outline-offset: 1px; background: rgba(56,189,248,.1); }
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
.ark-harness-add-row {
  display: inline-block; margin: .35rem 0 1.5rem; padding: .3rem .6rem;
  border: 1px dashed #333947; border-radius: 6px; background: transparent; color: #8b93a7;
  font-size: 11.5px; cursor: pointer;
}
.ark-harness-add-row:hover { border-color: #38bdf8; color: #38bdf8; }
[data-ark-container="graph"] { position: relative; }
[data-ark-container="graph"].ark-harness-graph-layout {
  min-width: var(--ark-harness-graph-min-width); min-height: var(--ark-harness-graph-min-height);
}
.ark-harness-graph-group { position: absolute; z-index: 0; }
.ark-harness-graph-node {
  position: absolute; left: var(--ark-harness-graph-x); top: var(--ark-harness-graph-y); z-index: 2;
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
.ark-harness-edge-handle-layer {
  position: absolute; inset: 0; z-index: 3; pointer-events: none;
}
.ark-harness-edge-handle {
  position: absolute; transform: translate(-50%, -50%); z-index: 3;
  width: 18px; height: 18px; padding: 0; border: 2px solid #0ea5b7; border-radius: 999px;
  background: #fff; color: #0e7490; cursor: crosshair; line-height: 14px; font-size: 9px;
  pointer-events: auto; touch-action: none;
}
.ark-harness-edge-preview {
  position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none;
}
.ark-harness-edge-preview line {
  stroke: #0ea5b7; stroke-width: 2; stroke-dasharray: 5 4;
}
.ark-harness-edge-drop-indicator {
  position: absolute; box-sizing: border-box; border: 2px solid #0ea5b7;
  border-radius: 6px; background: rgba(14,165,183,.1); pointer-events: none;
}
.ark-harness-graph-handle {
  position: absolute; top: .25rem; right: .25rem; z-index: 3;
  border: 1px solid rgba(100,116,139,.45); border-radius: 4px; background: rgba(255,255,255,.9);
  color: #64748b; cursor: grab; line-height: 1; padding: .25rem; touch-action: none;
}
.ark-harness-graph-dragging { z-index: 3; }
body { padding-bottom: 3.4rem !important; }
</style>`;

/**
 * ブラウザで実行するハーネス本体。バッククォート（テンプレートリテラル）を
 * 使うと TS 側のテンプレートリテラルとネストして壊れるため、文字列連結のみで
 * 書く。`${MODEL_SCRIPT_ID}` の 1 箇所だけ TS 側の定数を埋め込む。
 */
const HARNESS_JS = `(function () {
  "use strict";

  var MODEL_SCRIPT_ID = "${MODEL_SCRIPT_ID}";
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
  var statusEl = null;
  var sendBtn = null;
  var layoutDirectionBtn = null;

  function isRecordObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  function cryptoRandomId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
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

  function appendGraphLabel(svg, label, x, y) {
    if (typeof label !== "string" || label.length === 0) return;
    var text = svgElement("text");
    text.setAttribute("x", String(x));
    text.setAttribute("y", String(y));
    text.textContent = label;
    svg.appendChild(text);
  }

  function edgeDirection(edge) {
    if (!edge || !isRecordObject(edge.ext)) return "forward";
    var direction = edge.ext.direction;
    return direction === "reverse" || direction === "both" || direction === "none"
      ? direction
      : "forward";
  }

  function edgeCardinality(edge, end) {
    if (!edge || !isRecordObject(edge.ext)) return null;
    var value = edge.ext[end === "from" ? "from_card" : "to_card"];
    return value === "one" || value === "many" || value === "zero-or-one" ||
      value === "one-or-many" || value === "zero-or-many" ? value : null;
  }

  function edgeType(edge) {
    if (!edge || !isRecordObject(edge.ext)) return null;
    return typeof edge.ext.type === "string" ? edge.ext.type : null;
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

  function applyEdgeMarkers(main, markerId, direction) {
    var marker = "url(#" + markerId + ")";
    if (direction === "reverse" || direction === "both") {
      main.setAttribute("marker-start", marker);
    }
    if (direction === "forward" || direction === "both") {
      main.setAttribute("marker-end", marker);
    }
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
    layoutGraph(graph);
    renderGraphGroups(graph);
    while (graph.svg.firstChild) graph.svg.removeChild(graph.svg.firstChild);
    appendGraphMarker(graph.svg, graph.markerId);

    graph.edgeGeometryById.clear();
    var edges = state.model && state.model.edges ? state.model.edges : [];
    edges.forEach(function (edge) {
      var geometry = edgeGeometry(graph, edge);
      if (!geometry) return;
      graph.edgeGeometryById.set(edge.id, geometry);
      var direction = edgeDirection(edge);
      var main = svgElement(geometry.kind);
      setEdgeProjectionAttributes(main, edge, direction);
      if (geometry.kind === "path") {
        main.setAttribute("d", geometry.path);
      } else {
        main.setAttribute("x1", String(geometry.from.x));
        main.setAttribute("y1", String(geometry.from.y));
        main.setAttribute("x2", String(geometry.to.x));
        main.setAttribute("y2", String(geometry.to.y));
      }
      applyEdgeMarkers(main, graph.markerId, direction);
      graph.svg.appendChild(main);
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
      appendGraphLabel(graph.svg, edge.label, geometry.label.x, geometry.label.y);
    });
    syncEdgeHandles(graph, edges);
  }

  function scheduleGraphRender(graph) {
    if (graph.scheduled) return;
    graph.scheduled = true;
    window.requestAnimationFrame(function () { renderGraph(graph); });
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
    if (drag.preview && drag.preview.parentNode) drag.preview.parentNode.removeChild(drag.preview);
    if (drag.indicator && drag.indicator.parentNode) {
      drag.indicator.parentNode.removeChild(drag.indicator);
    }
    drag.preview = null;
    drag.previewLine = null;
    drag.indicator = null;
    drag.candidateId = null;
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
    var containerRect = drag.graph.container.getBoundingClientRect();
    var nodeRect = candidate.el.getBoundingClientRect();
    drag.indicator.style.left = nodeRect.left - containerRect.left + "px";
    drag.indicator.style.top = nodeRect.top - containerRect.top + "px";
    drag.indicator.style.width = nodeRect.width + "px";
    drag.indicator.style.height = nodeRect.height + "px";
    drag.candidateId = candidate.id;
  }

  function updateEdgeDrag(event) {
    if (!edgeDrag || event.pointerId !== edgeDrag.pointerId) return;
    var drag = edgeDrag;
    var containerRect = drag.graph.container.getBoundingClientRect();
    drag.previewLine.setAttribute("x2", String(event.clientX - containerRect.left));
    drag.previewLine.setAttribute("y2", String(event.clientY - containerRect.top));
    updateEdgeDropIndicator(
      drag,
      findEdgeDropCandidate(drag.graph, event.clientX, event.clientY)
    );
  }

  function finishEdgeDrag(event, commit) {
    if (!edgeDrag) return;
    if (event && event.pointerId !== edgeDrag.pointerId) return;
    var drag = edgeDrag;
    var candidate = commit && event
      ? findEdgeDropCandidate(drag.graph, event.clientX, event.clientY)
      : null;
    edgeDrag = null;
    if (commit && candidate) {
      var currentEdge = getEdge(state.model, drag.edgeId);
      if (currentEdge && drag.graph.positionsById.has(candidate.id)) {
        currentEdge[drag.end] = candidate.id;
      }
    }
    removeEdgeDragUi(drag);
    if (drag.handle.hasPointerCapture(drag.pointerId)) {
      drag.handle.releasePointerCapture(drag.pointerId);
    }
    scheduleGraphRender(drag.graph);
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

      var preview = svgElement("svg");
      preview.classList.add("ark-harness-edge-preview");
      markUi(preview);
      var line = svgElement("line");
      line.setAttribute("x1", String(endpoint.x));
      line.setAttribute("y1", String(endpoint.y));
      line.setAttribute("x2", String(endpoint.x));
      line.setAttribute("y2", String(endpoint.y));
      preview.appendChild(line);
      graph.handleLayer.insertBefore(preview, graph.handleLayer.firstChild);
      edgeDrag = {
        pointerId: event.pointerId,
        handle: handle,
        graph: graph,
        edgeId: currentEdge.id,
        end: end,
        preview: preview,
        previewLine: line,
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
        var ariaLabel = name + " の" + endLabel + "をドラッグして張り替え";
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

  function attachGraphHandle(graph, el, node) {
    var handle = createButton(
      "\\u283F",
      "ark-harness-graph-handle",
      (node.label || node.id) + " をドラッグして移動"
    );
    handle.addEventListener("pointerdown", function (event) {
      if (graphDrag || edgeDrag) return;
      var id = el.getAttribute("data-model-id");
      if (!id) return;
      var currentNode = getNode(state.model, id);
      var position = graphPosition(currentNode) || graph.positionsById.get(id);
      if (!position) return;
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
          clientX: event.clientX,
          clientY: event.clientY,
          x: position.x,
          y: position.y
        }
      };
    });
    handle.addEventListener("pointermove", function (event) {
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
    });
    handle.addEventListener("pointerup", finishGraphDrag);
    handle.addEventListener("pointercancel", finishGraphDrag);
    el.appendChild(handle);
  }

  function wireGraph(container) {
    var nodesById = new Map();
    var modelNodesById = new Map();
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
      modelNodesById.set(id, node);
      el.classList.add("ark-harness-graph-node");
    });

    var svg = svgElement("svg");
    svg.classList.add("ark-harness-edge-layer");
    markUi(svg);
    container.appendChild(svg);
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
      handleLayer: handleLayer,
      edgeHandlesByKey: new Map(),
      positionsById: new Map(),
      layoutExtent: { width: null, height: null },
      resizeObserver: null,
      scheduled: false,
      markerId: "ark-harness-arrow-" + graphSequence
    };
    nodesById.forEach(function (el, id) {
      attachGraphHandle(graph, el, modelNodesById.get(id));
    });
    if (typeof ResizeObserver !== "undefined") {
      graph.resizeObserver = new ResizeObserver(function () { scheduleGraphRender(graph); });
      graph.resizeObserver.observe(container);
      nodesById.forEach(function (el) { graph.resizeObserver.observe(el); });
    }
    scheduleGraphRender(graph);
    return graph;
  }

  function initGraphs() {
    var containers = document.querySelectorAll('[data-ark-container="graph"]');
    containers.forEach(function (container) { graphs.push(wireGraph(container)); });
    window.addEventListener("resize", function () {
      graphs.forEach(function (graph) { scheduleGraphRender(graph); });
    });
    window.addEventListener("pointerup", function (event) {
      finishEdgeDrag(event, true);
    });
    window.addEventListener("pointercancel", function (event) {
      finishEdgeDrag(event, false);
    });
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
    });

    if (rowInfo) {
      attachRowControls(el, rowInfo.listEl, rowInfo.ownerNodeId);
    }
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
  }

  function addField(listEl, ownerNodeId) {
    var node = getNode(state.model, ownerNodeId);
    if (!node) return;
    var id = cryptoRandomId();
    var field = { id: id, label: "新しい項目" };
    if (!node.fields) node.fields = [];
    node.fields.push(field);

    var li = document.createElement("li");
    li.setAttribute("data-model-id", id);
    li.textContent = field.label;
    listEl.appendChild(li);

    wireEditableLeaf(li, { listEl: listEl, ownerNodeId: ownerNodeId });
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

    var addBtn = createButton("+ 行を追加", "ark-harness-add-row", "行を追加");
    addBtn.addEventListener("click", function () {
      addField(listEl, ownerNodeId);
    });
    listEl.insertAdjacentElement("afterend", addBtn);
  }

  function initEditing() {
    var model = state.model;
    var listBindings = [];
    var listEls = document.querySelectorAll("ul, ol");
    listEls.forEach(function (listEl) {
      if (isInsideHarnessUi(listEl)) return;
      var ownerNodeId = findOwnerNodeId(model, listEl);
      if (ownerNodeId) listBindings.push({ listEl: listEl, ownerNodeId: ownerNodeId });
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

  function buildSubmissionHtml() {
    var clone = document.documentElement.cloneNode(true);

    clone.querySelectorAll("[data-ark-harness-ui]").forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
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
    try {
      var html = buildSubmissionHtml();
      submitPort.postMessage({ type: "ark:diagram-submit", model: state.model, html: html });
      updateStatus(true, "送信しました");
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
        state.model = parsed;
        syncNodeKinds();
        syncLayoutDirectionButton();
        graphs.forEach(function (graph) { scheduleGraphRender(graph); });
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

  function buildToolbar() {
    var bar = document.createElement("div");
    bar.className = "ark-harness-toolbar";
    markUi(bar);

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

    sendBtn = createButton("変更を送る", "ark-harness-btn ark-harness-btn-primary", "変更を親フレームへ送信する");
    sendBtn.disabled = true;
    sendBtn.addEventListener("click", handleSubmit);

    bar.appendChild(editModelBtn);
    bar.appendChild(spacer);
    bar.appendChild(statusEl);
    bar.appendChild(sendBtn);

    var panel = buildModelPanel();

    document.body.appendChild(panel);
    document.body.appendChild(bar);

    editModelBtn.addEventListener("click", function () {
      var opening = panel.style.display !== "flex";
      if (opening) {
        panel.__textarea.value = JSON.stringify(state.model, null, 2);
        panel.__error.style.display = "none";
      }
      panel.style.display = opening ? "flex" : "none";
    });

    updateStatus(false);
  }

  function init() {
    try {
      var model = loadModel();
      if (!model) return;
      state.model = model;
      syncNodeKinds();
      buildToolbar();
      initEditing();
      initGraphs();
    } catch (e) {
      console.error("[ark-harness] 初期化に失敗しました", e);
    }
  }

  init();

  window.addEventListener("message", function onMessage(event) {
    // event.origin は検証しない: sandbox iframe は不透明オリジンで
    // event.origin === "null" になる（実測済み）。port を持っていること
    // 自体を能力として扱う（親からの MessageChannel port 受け渡しが前提）。
    if (submitPort) return;
    if (event.ports && event.ports.length > 0) {
      submitPort = event.ports[0];
      updateStatus(true);
    }
  });
})();`;

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
