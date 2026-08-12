import { describe, expect, it } from "vitest";
import { formatDiagramOptionLabel } from "./diagram-option-label";

describe("formatDiagramOptionLabel", () => {
  it("タイトルと .claude/diagrams/ より後ろの path を表示する", () => {
    expect(
      formatDiagramOptionLabel(
        "注文フロー",
        ".claude/diagrams/sample-order-status.diagram.html"
      )
    ).toBe("注文フロー — sample-order-status.diagram.html");
  });

  it("displayName が basename と同じ場合は path だけを表示する", () => {
    expect(
      formatDiagramOptionLabel(
        "b.diagram.html",
        ".claude/diagrams/b.diagram.html"
      )
    ).toBe("b.diagram.html");
  });

  it("ネストした path を保つ", () => {
    expect(
      formatDiagramOptionLabel(
        "b.diagram.html",
        ".claude/diagrams/nested/b.diagram.html"
      )
    ).toBe("nested/b.diagram.html");
  });

  it("旧 docs/diagrams/ の relPath は全体を path として使う", () => {
    expect(
      formatDiagramOptionLabel("注文フロー", "docs/diagrams/order.diagram.html")
    ).toBe("注文フロー — docs/diagrams/order.diagram.html");
  });

  it(".claude/diagrams/ 以外の relPath は全体を path として使う", () => {
    expect(
      formatDiagramOptionLabel(
        "注文フロー",
        "other/diagrams/order.diagram.html"
      )
    ).toBe("注文フロー — other/diagrams/order.diagram.html");
  });
});
