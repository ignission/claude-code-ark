import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleDiagramListRequest, listDiagrams } from "./diagram-list.js";

const tempDirs: string[] = [];

function makeWorktree(withDiagramDir = true): {
  worktree: string;
  diagramDir: string;
} {
  const worktree = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ark-diagram-list-"))
  );
  tempDirs.push(worktree);
  const diagramDir = path.join(worktree, "docs", "diagrams");
  if (withDiagramDir) fs.mkdirSync(diagramDir, { recursive: true });
  return { worktree, diagramDir };
}

function diagramHtml(title?: string): string {
  const model = {
    version: 1,
    ...(title === undefined ? {} : { title }),
    nodes: [],
    edges: [],
    groups: [],
  };
  return (
    "<!doctype html><html><body>" +
    `<script type="application/json" id="ark-diagram-model">${JSON.stringify(model)}</script>` +
    "</body></html>"
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("listDiagrams", () => {
  it("有効な図だけを再帰列挙し、title 優先・basename fallback でパス順に返す", async () => {
    const { worktree, diagramDir } = makeWorktree();
    fs.mkdirSync(path.join(diagramDir, "nested"), { recursive: true });
    fs.writeFileSync(
      path.join(diagramDir, "z.diagram.html"),
      diagramHtml("注文フロー")
    );
    fs.writeFileSync(path.join(diagramDir, "a.diagram.html"), diagramHtml());
    fs.writeFileSync(
      path.join(diagramDir, "blank.diagram.html"),
      diagramHtml("   ")
    );
    fs.writeFileSync(
      path.join(diagramDir, "nested", "b.diagram.html"),
      diagramHtml("サブ図")
    );
    fs.writeFileSync(
      path.join(diagramDir, "not-diagram.html"),
      diagramHtml("対象外")
    );
    fs.writeFileSync(path.join(diagramDir, "notes.txt"), "対象外");

    await expect(listDiagrams(worktree)).resolves.toEqual([
      {
        relPath: "docs/diagrams/a.diagram.html",
        displayName: "a.diagram.html",
      },
      {
        relPath: "docs/diagrams/blank.diagram.html",
        displayName: "blank.diagram.html",
      },
      {
        relPath: "docs/diagrams/nested/b.diagram.html",
        displayName: "サブ図",
      },
      {
        relPath: "docs/diagrams/z.diagram.html",
        displayName: "注文フロー",
      },
    ]);
  });

  it("diagrams directory が無い場合と空の場合は空配列を返す", async () => {
    const missing = makeWorktree(false);
    const empty = makeWorktree();

    await expect(listDiagrams(missing.worktree)).resolves.toEqual([]);
    await expect(listDiagrams(empty.worktree)).resolves.toEqual([]);
  });

  it("不正モデル・モデル無し・外向き symlink・symlink directory を除外する", async () => {
    const { worktree, diagramDir } = makeWorktree();
    const outside = makeWorktree();
    fs.writeFileSync(
      path.join(diagramDir, "valid.diagram.html"),
      diagramHtml("正常")
    );
    fs.writeFileSync(
      path.join(diagramDir, "broken.diagram.html"),
      '<script type="application/json" id="ark-diagram-model">{</script>'
    );
    fs.writeFileSync(
      path.join(diagramDir, "missing-model.diagram.html"),
      "<html></html>"
    );
    const outsideFile = path.join(outside.worktree, "outside.diagram.html");
    fs.writeFileSync(outsideFile, diagramHtml("外部"));
    fs.symlinkSync(outsideFile, path.join(diagramDir, "outside.diagram.html"));
    fs.mkdirSync(path.join(outside.worktree, "linked"), { recursive: true });
    fs.writeFileSync(
      path.join(outside.worktree, "linked", "hidden.diagram.html"),
      diagramHtml("辿らない")
    );
    fs.symlinkSync(
      path.join(outside.worktree, "linked"),
      path.join(diagramDir, "linked"),
      "dir"
    );

    await expect(listDiagrams(worktree)).resolves.toEqual([
      {
        relPath: "docs/diagrams/valid.diagram.html",
        displayName: "正常",
      },
    ]);
  });
});

describe("handleDiagramListRequest", () => {
  it.each([
    undefined,
    null,
    {},
    { worktreePath: 1 },
    { worktreePath: "" },
  ])("不正 payload %j を ACK error にする", async data => {
    const resolveManagedWorktreePath = vi.fn();
    const list = vi.fn();

    const result = await handleDiagramListRequest(
      { resolveManagedWorktreePath, listDiagrams: list },
      data
    );

    expect(result).toEqual({ ok: false, error: "不正なリクエストです" });
    expect(resolveManagedWorktreePath).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("長すぎる path と managed worktree 解決失敗を ACK error にする", async () => {
    const resolveManagedWorktreePath = vi.fn(() => null);
    const list = vi.fn();

    await expect(
      handleDiagramListRequest(
        { resolveManagedWorktreePath, listDiagrams: list },
        { worktreePath: "x".repeat(4097) }
      )
    ).resolves.toEqual({ ok: false, error: "worktree のパスが長すぎます" });
    expect(resolveManagedWorktreePath).not.toHaveBeenCalled();

    await expect(
      handleDiagramListRequest(
        { resolveManagedWorktreePath, listDiagrams: list },
        { worktreePath: "/unmanaged" }
      )
    ).resolves.toEqual({
      ok: false,
      error: "管理対象の worktree ではありません",
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("resolver の正規化済み実パスだけを helper に渡して成功応答を返す", async () => {
    const diagrams = [
      {
        relPath: "docs/diagrams/a.diagram.html",
        displayName: "A",
      },
    ];
    const resolveManagedWorktreePath = vi.fn(() => "/real/worktree");
    const list = vi.fn(async () => diagrams);

    await expect(
      handleDiagramListRequest(
        { resolveManagedWorktreePath, listDiagrams: list },
        { worktreePath: "/input/worktree/." }
      )
    ).resolves.toEqual({ ok: true, diagrams });
    expect(resolveManagedWorktreePath).toHaveBeenCalledWith(
      "/input/worktree/."
    );
    expect(list).toHaveBeenCalledWith("/real/worktree");
  });

  it("列挙中の予期しない I/O error を ACK error に変換する", async () => {
    const result = await handleDiagramListRequest(
      {
        resolveManagedWorktreePath: () => "/real/worktree",
        listDiagrams: async () => {
          throw Object.assign(new Error("permission denied"), {
            code: "EACCES",
          });
        },
      },
      { worktreePath: "/input/worktree" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("EACCES");
      expect(result.error).toContain("permission denied");
    }
  });
});
