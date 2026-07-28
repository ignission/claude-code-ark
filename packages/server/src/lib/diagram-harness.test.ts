import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { DIAGRAM_HARNESS_MARKER, injectHarness } from "./diagram-harness.js";

const page = (body: string) =>
  `<!doctype html><html><head></head><body>${body}</body></html>`;

describe("injectHarness", () => {
  it("body の末尾にハーネスを差し込む", () => {
    const out = injectHarness(page("<div>図</div>"));

    expect(out).toContain(DIAGRAM_HARNESS_MARKER);
    expect(out.indexOf("<div>図</div>")).toBeLessThan(
      out.indexOf(DIAGRAM_HARNESS_MARKER)
    );
  });

  it("body が無い文書でも末尾に差し込む", () => {
    const out = injectHarness("<div>図</div>");

    expect(out).toContain(DIAGRAM_HARNESS_MARKER);
    expect(out.indexOf("<div>図</div>")).toBeLessThan(
      out.indexOf(DIAGRAM_HARNESS_MARKER)
    );
  });

  it("二重注入しない", () => {
    const once = injectHarness(page("<div>図</div>"));
    const twice = injectHarness(once);

    expect(twice.match(new RegExp(DIAGRAM_HARNESS_MARKER, "g"))).toHaveLength(
      1
    );
  });

  it("graph 編集 UI の契約を注入する", () => {
    const out = injectHarness(
      page(
        '<div data-ark-container="graph"><div data-model-id="node"></div></div>'
      )
    );

    expect(out).toContain('[data-ark-container="graph"]');
    expect(out).toContain("ark-harness-edge-layer");
    expect(out).toContain("ark-harness-graph-handle");
    expect(out).toContain("ark-harness-edge-handle-layer");
    expect(out).toContain("ark-harness-edge-handle");
    expect(out).toContain("function syncEdgeHandles(");
    expect(out).toContain("function finishEdgeDrag(");
    expect(out).toContain("getEdge(state.model, drag.edgeId)");
    expect(out).toContain("ark-harness-layout-direction");
    expect(out).toContain("function syncLayoutDirectionButton(");
    expect(out).toContain("function toggleLayoutDirection(");
    expect(out).toContain('var label = visibleLabel + "（現在 "');
    expect(out).toContain(
      "if (!isRecordObject(state.model.ext)) state.model.ext = {};"
    );
    expect(out).toContain(
      "if (!isRecordObject(state.model.ext.layout)) state.model.ext.layout = {};"
    );
    expect(out).toContain("state.model.ext.layout.direction = nextDirection;");
    expect(out).toContain(
      "graphs.forEach(function (graph) { scheduleGraphRender(graph); });"
    );
    expect(out.match(new RegExp(DIAGRAM_HARNESS_MARKER, "g"))).toHaveLength(1);
  });

  it("node / edge 共通 selection と単一 context toolbar の契約を注入する", () => {
    const out = injectHarness(
      page(
        '<div data-ark-container="graph"><div data-model-id="node"></div></div>'
      )
    );

    expect(out).toContain("var selection = { kind: null, id: null };");
    expect(out).toContain("var selectionGraph = null;");
    expect(out).toContain("function setSelection(");
    expect(out).toContain("function clearSelection(");
    expect(out).toContain("function reconcileSelection(");
    expect(out).toContain("function renderSelectionVisuals(");
    expect(out).toContain("function buildContextToolbar(");
    expect(out).toContain("function renderContextToolbar(");
    expect(out).toContain("function scheduleContextToolbarPosition(");
    expect(out).toContain("ark-harness-context-toolbar");
    expect(out).toContain('setAttribute("role", "toolbar")');
    expect(out).toContain('setAttribute("data-ark-selection-kind"');
    expect(out).toContain('setAttribute("data-ark-selection-id"');
    expect(out).toContain("data-ark-toolbar-placement");
    expect(out).toContain("document.body.appendChild(contextToolbar)");
    expect(out).not.toContain("selectedNodeId");
    expect(out).not.toContain("function setSelectedNode(");
    expect(out).not.toContain("edgeControlsById: new Map()");
  });

  it("selection toolbar から node / edge action の既存安全境界へ到達する", () => {
    const out = injectHarness(
      page(
        '<div data-ark-container="graph"><div data-model-id="node"></div></div>'
      )
    );

    expect(out).toContain("function renderNodeToolbar(");
    expect(out).toContain("function renderEdgeToolbar(");
    expect(out).toContain("function collectKindCandidates(");
    expect(out).toContain("function updateNodeKind(");
    expect(out).toContain("value && kindCandidates.indexOf(value) === -1");
    expect(out).toContain("function updateEdgeExt(");
    expect(out).toContain("CARDINALITY_VALUES.indexOf(value)");
    expect(out).toContain("DIRECTION_VALUES.indexOf(direction)");
    expect(out).toContain("function addField(");
    expect(out).toContain("function removeNode(");
    expect(out).toContain("function removeEdge(");
    expect(out).toContain("group.nodes = group.nodes.filter");
    expect(out).toContain("var listBindingsByNode = new Map();");
    expect(out).toContain("function selectedListBinding(");
    expect(out).not.toContain("ark-harness-add-row");
  });

  it("selection toolbar は hover close 経路を持たず creation hover だけを維持する", () => {
    const out = injectHarness(
      page(
        '<div data-ark-container="graph"><div data-model-id="node"></div></div>'
      )
    );

    expect(out).not.toContain(
      ".ark-harness-graph-node:hover > .ark-harness-kind-picker"
    );
    expect(out).not.toContain("ark-harness-kind-picker");
    expect(out).not.toContain("function scheduleEdgeControlsClose(");
    expect(out).not.toContain("function activateEdgeControls(");
    expect(out).not.toContain("function edgeControlsEngaged(");
    expect(out).not.toContain("ark-harness-edge-controls-active");
    expect(out).not.toContain("function positionEdgeControls(");
    expect(out).toContain("var AFFORDANCE_CLOSE_DELAY = 120");
    expect(out).toContain("function scheduleNodeAffordanceClose(");
    expect(out).toContain("ark-harness-node-connectors-visible");
    expect(out).toContain('anchor.addEventListener("pointerdown"');
  });

  it("依存なし auto layout と注入サイズの契約を満たす", () => {
    const out = injectHarness(
      page(
        '<div data-ark-container="graph"><div data-model-id="node"></div></div>'
      )
    );

    expect(out).toContain("function readLayoutConfig(");
    expect(out).toContain("function assignLayerRanks(");
    expect(out).toContain("function layoutGraph(");
    expect(out).toContain("positionsById");
    expect(out).toContain('direction === "TB"');
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(128 * 1024);
    expect(out).not.toContain("elkjs");
    expect(out).not.toContain("new Worker");
    expect(out).not.toContain("blob:");
    expect(out).not.toContain("fetch(");
    expect(out).not.toContain("import(");
    expect(out).not.toContain("https://");
    expect(out).not.toContain("innerHTML");
    expect(out).not.toContain("insertAdjacentHTML");
    expect(out).not.toContain("@font-face");
    expect(out).not.toContain('rel="stylesheet"');
    expect(out.match(new RegExp(DIAGRAM_HARNESS_MARKER, "g"))).toHaveLength(1);
  });

  it("group layout kernel を function literal で一度だけ注入する", () => {
    const out = injectHarness(
      page(
        '<div data-ark-container="graph"><section data-ark-group data-model-id="group"></section><div data-model-id="node"></div></div>'
      )
    );

    expect(
      out.match(/var groupAwareLayout = function layoutDiagram/g)
    ).toHaveLength(1);
    expect(out.match(/function layoutGroupAwareGraph\(/g)).toHaveLength(1);
    expect(out.match(/function measureGroupOutsets\(/g)).toHaveLength(1);
    expect(out.match(/\bunitEdges=/g)).toHaveLength(1);
    expect(out).toContain(
      "if (!layoutGroupAwareGraph(graph)) layoutGraph(graph);"
    );
    expect(out).not.toContain("eval(");
    expect(out).not.toContain("new Function");
  });

  it("esbuild artifact からも group kernel を function literal として注入する", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ark-diagram-harness-"));
    const outfile = join(directory, "diagram-harness.mjs");
    try {
      await build({
        entryPoints: [join(import.meta.dirname, "diagram-harness.ts")],
        outfile,
        bundle: true,
        format: "esm",
        platform: "node",
      });
      const artifact = (await import(
        `${pathToFileURL(outfile).href}?test=${Date.now()}`
      )) as typeof import("./diagram-harness.js");
      const out = artifact.injectHarness(
        page(
          '<div data-ark-container="graph"><section data-ark-group data-model-id="group"></section><div data-model-id="node"></div></div>'
        )
      );

      expect(
        out.match(/var groupAwareLayout = function layoutDiagram/g)
      ).toHaveLength(1);
      expect(out.match(/function layoutGroupAwareGraph\(/g)).toHaveLength(1);
      expect(Buffer.byteLength(out, "utf8")).toBeLessThan(128 * 1024);
      expect(out).not.toContain("eval(");
      expect(out).not.toContain("new Function");
      expect(out).not.toContain("import(");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("edge ext の cardinality・direction・type 投影契約を注入する", () => {
    const out = injectHarness(
      page(
        '<div data-ark-container="graph"><div data-model-id="node"></div></div>'
      )
    );

    expect(out).toContain("from_card");
    expect(out).toContain("to_card");
    expect(out).toContain("function edgeDirection(");
    expect(out).toContain("function appendEdgeCardinality(");
    expect(out).toContain("ark-harness-edge-cardinality");
    expect(out).toContain("data-ark-edge-cardinality");
    expect(out).toContain("data-ark-edge-direction");
    expect(out).toContain("data-ark-edge-type");
    expect(out.match(new RegExp(DIAGRAM_HARNESS_MARKER, "g"))).toHaveLength(1);
  });

  it("edge cardinality・direction control の安全な更新契約を注入する", () => {
    const out = injectHarness(
      page(
        '<div data-ark-container="graph"><div data-model-id="node"></div></div>'
      )
    );

    expect(out).toContain("var CARDINALITY_VALUES = [");
    expect(out).toContain("var DIRECTION_VALUES = [");
    expect(out).toContain("function updateEdgeExt(");
    expect(out).toContain("getEdge(state.model, edgeId)");
    expect(out).toContain("if (!isRecordObject(edge.ext)) edge.ext = {};");
    expect(out).toContain("scheduleGraphRender(graph);");
    expect(out).toContain('document.createElement("select")');
    expect(out).toContain('document.createElement("option")');
    expect(out).toContain("option.textContent =");
    expect(out).toContain("markUi(option)");
    expect(out).toContain("function syncEdgeSelect(");
    expect(out).toContain("function renderEdgeToolbar(");
    expect(out).toContain("data-ark-harness-ui");
  });

  it("edge control と SVG 投影が同じ allowlist・描画経路を共有する", () => {
    const out = injectHarness(
      page(
        '<div data-ark-container="graph"><div data-model-id="node"></div></div>'
      )
    );

    expect(out).toContain("CARDINALITY_VALUES.indexOf(value)");
    expect(out).toContain("DIRECTION_VALUES.indexOf(direction)");
    expect(out).toContain("function edgeCardinality(");
    expect(out).toContain("function edgeDirection(");
    expect(out).toContain("applyEdgeMarkers(main, graph.markerId, direction)");
    expect(out).toContain("appendEdgeCardinality(");
    expect(out.match(/var CARDINALITY_VALUES = \[/g)).toHaveLength(1);
    expect(out.match(/var DIRECTION_VALUES = \[/g)).toHaveLength(1);
  });

  it("edge control option を固定文字列と安全な DOM API だけで作る", () => {
    const out = injectHarness(
      page(
        '<div data-ark-container="graph"><div data-model-id="node"></div></div>'
      )
    );

    expect(out).toContain('document.createElement("option")');
    expect(out).toContain("option.textContent =");
    expect(out).toContain("option.value =");
    expect(out).toContain('option.setAttribute("disabled", "")');
    expect(out).not.toContain("innerHTML");
    expect(out).not.toContain("insertAdjacentHTML");
    expect(out).not.toContain("fetch(");
    expect(out).not.toContain("import(");
    expect(out).not.toContain("https://");
    expect(out).not.toContain("@font-face");
    expect(out).not.toContain('rel="stylesheet"');
  });

  it("group projection と geometry 同期の契約を注入する", () => {
    const out = injectHarness(
      page(
        '<div data-ark-container="graph"><section data-ark-group data-model-id="group"></section></div>'
      )
    );

    expect(out).toContain("[data-ark-group]");
    expect(out).toContain("ark-harness-graph-group");
    expect(out).toContain("--ark-harness-group-x");
    expect(out).toContain("--ark-harness-group-y");
    expect(out).toContain("--ark-harness-group-width");
    expect(out).toContain("--ark-harness-group-height");
    expect(out).toContain("function renderGraphGroups(");
    expect(out.match(new RegExp(DIAGRAM_HARNESS_MARKER, "g"))).toHaveLength(1);
  });

  it("node projection の data-kind を初期表示とモデル再適用で同期する", () => {
    const out = injectHarness(
      page('<div data-model-id="node" data-kind="stale"></div>')
    );

    expect(out).toContain("function syncNodeKinds()");
    expect(out).toContain('document.querySelectorAll("[data-model-id]")');
    expect(out).toContain('typeof node.kind === "string"');
    expect(out).toContain('el.setAttribute("data-kind", node.kind)');
    expect(out).toContain('el.removeAttribute("data-kind")');
    expect(out.match(/syncNodeKinds\(\);/g)).toHaveLength(3);
    expect(out.match(new RegExp(DIAGRAM_HARNESS_MARKER, "g"))).toHaveLength(1);
  });

  it("authored CSS と model node 由来の kind toolbar 契約を注入する", () => {
    const out = injectHarness(
      page(
        '<div data-ark-container="graph"><div data-model-id="node"></div></div>'
      )
    );

    expect(out).toContain("function collectKindCandidates(");
    expect(out).toContain("function collectKindRules(");
    expect(out).toContain("function decodeCssEscapes(");
    expect(out).toContain("style:not([data-ark-harness-ui])");
    expect(out).toContain("rule.selectorText");
    expect(out).toContain("new Set()");
    expect(out).toContain("state.model && Array.isArray(state.model.nodes)");
    expect(out).toContain('typeof value === "string" && value');
    expect(out).toContain("!seen.has(value)");
    expect(out).toContain("values.push(value)");
    expect(out).toContain("ark-harness-context-toolbar");
    expect(out).not.toContain("ark-harness-kind-picker");
    expect(out).toContain('document.createElement("select")');
    expect(out).toContain('document.createElement("option")');
    expect(out).toContain("option.textContent = value");
    expect(out).toContain("option.value = value");
    expect(out).toContain("function syncKindSelect(");
    expect(out).toContain("function updateNodeKind(");
    expect(out).toContain("getNode(state.model, id)");
    expect(out).toContain("value && kindCandidates.indexOf(value) === -1");
    expect(out).toContain("node.kind = value");
    expect(out).toContain("else delete node.kind");
    expect(out).toContain('var none = createKindOption("")');
    expect(out).toContain('lastKind === ""');
    expect(out).toContain("lastKind = kind;");
    expect(out).toContain("syncNodeKinds();");
    expect(out).toContain("scheduleGraphRender(graph);");
    expect(out).toContain('el.setAttribute("data-kind", node.kind)');
    expect(out).not.toContain("aggregate");
    expect(out).not.toContain("entity");
    expect(out).not.toContain('value === "event"');
    expect(out).not.toContain('kindCandidates = ["');
    expect(out.match(new RegExp(DIAGRAM_HARNESS_MARKER, "g"))).toHaveLength(1);
  });

  it("node projection に authored label と空 list の構造を複製する契約を注入する", () => {
    const out = injectHarness(
      page(
        '<div data-ark-container="graph"><section class="entity" data-model-id="node"><h2 class="title" data-model-id="node">Node</h2><ul class="fields"><li data-model-id="field">Field</li></ul></section></div>'
      )
    );

    expect(out).toContain(
      'var id = template && template.getAttribute("data-model-id")'
    );
    expect(out).toContain('template.querySelectorAll("[data-model-id]")');
    expect(out).toContain('candidate.getAttribute("data-model-id") !== id');
    expect(out).toContain("isInsideHarnessUi(candidate)");
    expect(out).toContain('candidate.hasAttribute("data-ark-container")');
    expect(out).toContain('candidate.hasAttribute("data-ark-group")');
    expect(out).toContain("/^(H1|H2|H3|H4|H5|H6|SPAN|DIV|P|STRONG|HEADER)$/");
    expect(out).toContain("labelTag: labelTag");
    expect(out).toContain(
      "labelClassName: labelEl ? authoredClassName(labelEl) :"
    );
    expect(out).toContain("document.createElement(template.labelTag)");
    expect(out).toContain(
      "if (template.labelClassName) label.className = template.labelClassName"
    );
    expect(out).toContain('template.querySelectorAll("ul, ol")');
    expect(out).toContain("findOwnerNodeId(state.model, candidate) === id");
    expect(out).toContain(
      "listTag: listEl ? listEl.tagName.toLowerCase() : null"
    );
    expect(out).toContain(
      "listClassName: listEl ? authoredClassName(listEl) :"
    );
    expect(out).toContain("document.createElement(template.listTag)");
    expect(out).toContain(
      "if (template.listClassName) list.className = template.listClassName"
    );
    expect(out).toContain("return { root: root, label: label, list: list }");
  });

  it("node / edge CRUD と参照整合性の契約を注入する", () => {
    const out = injectHarness(
      page(
        '<div data-ark-container="graph"><div data-model-id="node"></div></div>'
      )
    );

    expect(out).toContain("reservedModelIds");
    expect(out).toContain("function collectModelIds(");
    expect(out).toContain("function generateUniqueModelId(");
    expect(out).not.toContain("ark-harness-node-palette");
    expect(out).not.toContain("buildNodePalette");
    expect(out).not.toContain("createPaletteSelect");
    expect(out).toContain("function registerGraphNode(");
    expect(out).toContain("function createNodeInGraph(");
    expect(out).toContain("function removeNode(");
    expect(out).toContain("listBindingsByNode.delete(id)");
    expect(out).toContain(
      "owned.push({ listEl: projection.list, ownerNodeId: node.id })"
    );
    expect(out).toContain("wireList(projection.list, node.id)");
    expect(out).toContain("group.nodes = group.nodes.filter");
    expect(out).toContain('mode: "create"');
    expect(out).toContain('mode: "rewire"');
    expect(out).toContain("var EDGE_DRAG_MIN_DISTANCE = 8");
    expect(out).toContain("drag.didDrag");
    expect(out).toContain("drag.leftSource");
    expect(out).toContain("ark-harness-node-connectors");
    expect(out).toContain("ark-harness-node-anchor");
    expect(out).toContain(
      "position: absolute; transform: translate(-50%, -50%); z-index: 5"
    );
    expect(out).toContain("function nodeAnchorPoint(");
    expect(out).toContain("function attachNodeConnectors(");
    expect(out).toContain('["top-left", 0, 0]');
    expect(out).toContain('["bottom-right", 1, 1]');
    expect(out).not.toContain("ark-harness-node-create");
    expect(out).not.toContain("ark-harness-node-rail");
    expect(out).toContain("function removeEdge(");
    expect(out).toContain("function setEdgeDeletePending(");
    expect(out).toContain('drag.mode === "rewire" && !candidate');
    expect(out).toContain("離すと edge を削除");
    expect(out).toContain("function setSelection(");
    expect(out).toContain('root.addEventListener("pointerdown"');
    expect(out).toContain("if (isEditableControlTarget(event.target)) return;");
    expect(out).toContain("event.preventDefault()");
    expect(out).toContain("root.focus({ preventScroll: true })");
    expect(out).toContain("function handleSelectionKey(");
    expect(out).toContain('event.key !== "Delete"');
    expect(out).toContain('event.key !== "Backspace"');
    expect(out).toContain("target.isContentEditable");
    expect(out).toContain("ark-harness-node-delete");
    expect(out).not.toContain("ark-harness-edge-delete-visible");
    expect(out).not.toContain(".ark-harness-edge-hit {");
    expect(out).not.toContain("function syncEdgeDeleteControls(");
    expect(out).toContain("var AFFORDANCE_CLOSE_DELAY = 120");
    expect(out).toContain("function scheduleNodeAffordanceClose(");
    expect(out).toContain("ark-harness-node-affordance-open");
    expect(out).toContain('controller.root.matches(":focus-within")');
    expect(out).toContain(
      "root.closest('[data-ark-container=\"graph\"]') === graph.container"
    );
    expect(out).toContain('element.hasAttribute("data-ark-container")');
  });

  it("CRUD DOM を安全な API だけで生成し全 model id を予約する", () => {
    const out = injectHarness(
      page(
        '<div data-ark-container="graph"><div data-model-id="node"></div></div>'
      )
    );

    expect(out).toContain('document.createElement("article")');
    expect(out).toContain('document.createElement("span")');
    expect(out).toContain(
      'document.createElementNS("http://www.w3.org/2000/svg"'
    );
    expect(out).toContain('root.setAttribute("data-model-id", node.id)');
    expect(out).toContain("label.textContent = node.label");
    expect(out).toContain("(node.fields || []).forEach");
    expect(out).toContain("(model.edges || []).forEach");
    expect(out).toContain("(model.groups || []).forEach");
    expect(out).toContain("reservedModelIds.has(candidate)");
    expect(out).not.toContain("innerHTML");
    expect(out).not.toContain("insertAdjacentHTML");
    expect(out).not.toContain("fetch(");
    expect(out).not.toContain("import(");
    expect(out).not.toContain("https://");
  });
});
