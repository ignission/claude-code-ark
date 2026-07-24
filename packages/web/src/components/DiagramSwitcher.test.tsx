import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DiagramSwitcher } from "./DiagramSwitcher";

const diagrams = [
  {
    relPath: ".claude/diagrams/a.diagram.html",
    displayName: "注文フロー",
  },
  {
    relPath: ".claude/diagrams/nested/b.diagram.html",
    displayName: "b.diagram.html",
  },
];

describe("DiagramSwitcher", () => {
  it("表示名と相対 path を並べ、現在図を selected にする", () => {
    const markup = renderToStaticMarkup(
      createElement(DiagramSwitcher, {
        diagrams,
        currentRelPath: ".claude/diagrams/nested/b.diagram.html",
        onSelect: vi.fn(),
      })
    );

    expect(markup).toContain('aria-label="表示する図"');
    expect(markup).toContain(
      '<option value=".claude/diagrams/a.diagram.html" title=".claude/diagrams/a.diagram.html">注文フロー — a.diagram.html</option>'
    );
    expect(markup).toContain(
      '<option value=".claude/diagrams/nested/b.diagram.html" title=".claude/diagrams/nested/b.diagram.html" selected="">nested/b.diagram.html</option>'
    );
  });

  it("current 無しでは「図を選択」を selected placeholder にする", () => {
    const markup = renderToStaticMarkup(
      createElement(DiagramSwitcher, {
        diagrams,
        currentRelPath: undefined,
        onSelect: vi.fn(),
      })
    );

    expect(markup).toContain('<option value="" selected="">図を選択</option>');
  });

  it("0件では disabled の「図がありません」を表示する", () => {
    const markup = renderToStaticMarkup(
      createElement(DiagramSwitcher, {
        diagrams: [],
        currentRelPath: undefined,
        onSelect: vi.fn(),
      })
    );

    expect(markup).toContain("<select");
    expect(markup).toContain('disabled=""');
    expect(markup).toContain(
      '<option value="" selected="">図がありません</option>'
    );
  });

  it("current が一覧に無い場合も整形した一時 option を selected にする", () => {
    const markup = renderToStaticMarkup(
      createElement(DiagramSwitcher, {
        diagrams,
        currentRelPath: ".claude/diagrams/deleted/deleted.diagram.html",
        onSelect: vi.fn(),
      })
    );

    expect(markup).toContain(
      '<option value=".claude/diagrams/deleted/deleted.diagram.html" title=".claude/diagrams/deleted/deleted.diagram.html" selected="">deleted/deleted.diagram.html</option>'
    );
  });
});
