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

  it("authored CSS 由来の kind picker 契約を注入する", () => {
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
    expect(out).toContain("ark-harness-kind-picker");
    expect(out).toContain('document.createElement("select")');
    expect(out).toContain('document.createElement("option")');
    expect(out).toContain("option.textContent = value");
    expect(out).toContain("option.value = value");
    expect(out).toContain("function syncKindPicker(");
    expect(out).toContain("function updateNodeKind(");
    expect(out).toContain("getNode(state.model, id)");
    expect(out).toContain("kindCandidates.indexOf(value) === -1");
    expect(out).toContain("node.kind = value");
    expect(out).toContain("syncNodeKinds();");
    expect(out).toContain("scheduleGraphRender(graph);");
    expect(out).toContain('el.setAttribute("data-kind", node.kind)');
    expect(out).not.toContain("aggregate");
    expect(out).not.toContain("entity");
    expect(out).not.toContain('value === "event"');
    expect(out).not.toContain('kindCandidates = ["');
    expect(out.match(new RegExp(DIAGRAM_HARNESS_MARKER, "g"))).toHaveLength(1);
  });
});
