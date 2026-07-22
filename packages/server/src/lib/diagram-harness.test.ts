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
    expect(out.match(/syncNodeKinds\(\);/g)).toHaveLength(2);
    expect(out.match(new RegExp(DIAGRAM_HARNESS_MARKER, "g"))).toHaveLength(1);
  });
});
