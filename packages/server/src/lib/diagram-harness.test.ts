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
});
