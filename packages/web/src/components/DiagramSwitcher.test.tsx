import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  DiagramSwitcher,
  getDiagramDeleteWarning,
  handleDiagramDeleteConfirmation,
} from "./DiagramSwitcher";

const diagrams = [
  {
    relPath: ".claude/diagrams/a.diagram.html",
    displayName: "注文フロー",
    tracked: true,
  },
  {
    relPath: ".claude/diagrams/nested/b.diagram.html",
    displayName: "b.diagram.html",
    tracked: false,
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
      '<option value=".claude/diagrams/a.diagram.html" title=".claude/diagrams/a.diagram.html（Git管理）">注文フロー — a.diagram.html — Git管理</option>'
    );
    expect(markup).toContain(
      '<option value=".claude/diagrams/nested/b.diagram.html" title=".claude/diagrams/nested/b.diagram.html（未追跡）" selected="">nested/b.diagram.html — 未追跡</option>'
    );
    expect(markup).toContain(
      'title=".claude/diagrams/nested/b.diagram.html（未追跡）"'
    );
    expect(markup).toContain(">未追跡</span>");
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

  it("current item が有効なときだけ削除ボタンを有効にする", () => {
    const enabled = renderToStaticMarkup(
      createElement(DiagramSwitcher, {
        diagrams,
        currentRelPath: diagrams[0].relPath,
        onSelect: vi.fn(),
        onDelete: vi.fn(),
        isConnected: true,
      })
    );
    expect(enabled).toContain('aria-label="現在の図を削除"');
    expect(enabled).not.toContain('aria-label="現在の図を削除" disabled=""');

    for (const props of [
      { currentRelPath: undefined },
      { currentRelPath: ".claude/diagrams/stale.diagram.html" },
      { currentRelPath: diagrams[0].relPath, listLoading: true },
      { currentRelPath: diagrams[0].relPath, isConnected: false },
      { currentRelPath: diagrams[0].relPath, isDeleting: true },
    ]) {
      const markup = renderToStaticMarkup(
        createElement(DiagramSwitcher, {
          diagrams,
          onSelect: vi.fn(),
          onDelete: vi.fn(),
          isConnected: true,
          ...props,
        })
      );
      expect(markup).toContain('aria-label="現在の図を削除" disabled=""');
    }
  });

  it("tracked/untracked ごとの取り消せない警告を返す", () => {
    const tracked = getDiagramDeleteWarning(diagrams[0]);
    const untracked = getDiagramDeleteWarning(diagrams[1]);

    expect(tracked).toContain("コメント sidecar も削除");
    expect(tracked).toContain("worktree に削除差分が残ります");
    expect(tracked).toContain("Git で復元");
    expect(tracked).toContain("Git 未追跡のファイルは復元できません");
    expect(untracked).toContain("コメント sidecar も削除");
    expect(untracked).toContain("Git 未追跡のファイルは復元できません");
    expect(untracked).toContain("取り消せません");
  });

  it("cancel は callback 無し、confirm は current 1件だけを渡して成否を返す", async () => {
    const onDelete = vi.fn(async () => false);

    await expect(
      handleDiagramDeleteConfirmation(false, diagrams[0], onDelete)
    ).resolves.toBe(false);
    expect(onDelete).not.toHaveBeenCalled();
    await expect(
      handleDiagramDeleteConfirmation(true, diagrams[1], onDelete)
    ).resolves.toBe(false);
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledWith(diagrams[1].relPath, false);
  });
});
