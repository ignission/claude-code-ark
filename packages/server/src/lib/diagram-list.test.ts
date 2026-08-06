import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIAGRAM_DIR } from "@ark/shared";
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
  execFileSync("git", ["init", "-q", worktree]);
  const diagramDir = path.join(worktree, DIAGRAM_DIR);
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
  it("アンダースコア始まりのディレクトリ配下は一覧から除外する", async () => {
    // 規約サンプル（diagram-authoring skill の完成例）等の参照用ファイルを
    // 図スイッチャーに並べないための隠しディレクトリ規約
    const { worktree, diagramDir } = makeWorktree();
    fs.mkdirSync(path.join(diagramDir, "_examples", "nested"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(diagramDir, "visible.diagram.html"),
      diagramHtml("可視の図")
    );
    fs.writeFileSync(
      path.join(diagramDir, "_examples", "hidden.diagram.html"),
      diagramHtml("規約サンプル")
    );
    fs.writeFileSync(
      path.join(diagramDir, "_examples", "nested", "deep.diagram.html"),
      diagramHtml("深い規約サンプル")
    );

    await expect(listDiagrams(worktree)).resolves.toEqual([
      {
        relPath: ".claude/diagrams/visible.diagram.html",
        displayName: "可視の図",
        tracked: false,
      },
    ]);
  });

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
    execFileSync("git", [
      "-C",
      worktree,
      "add",
      "--",
      ".claude/diagrams/a.diagram.html",
      ".claude/diagrams/nested/b.diagram.html",
    ]);

    await expect(listDiagrams(worktree)).resolves.toEqual([
      {
        relPath: ".claude/diagrams/a.diagram.html",
        displayName: "a.diagram.html",
        tracked: true,
      },
      {
        relPath: ".claude/diagrams/blank.diagram.html",
        displayName: "blank.diagram.html",
        tracked: false,
      },
      {
        relPath: ".claude/diagrams/nested/b.diagram.html",
        displayName: "サブ図",
        tracked: true,
      },
      {
        relPath: ".claude/diagrams/z.diagram.html",
        displayName: "注文フロー",
        tracked: false,
      },
    ]);
  });

  it("diagrams directory が無い場合と空の場合は空配列を返す", async () => {
    const missing = makeWorktree(false);
    const empty = makeWorktree();

    await expect(listDiagrams(missing.worktree)).resolves.toEqual([]);
    await expect(listDiagrams(empty.worktree)).resolves.toEqual([]);
  });

  it("tracked、untracked、ignored-untracked、nested tracked を一括判定する", async () => {
    const { worktree, diagramDir } = makeWorktree();
    fs.mkdirSync(path.join(diagramDir, "nested"), { recursive: true });
    fs.writeFileSync(
      path.join(diagramDir, "tracked.diagram.html"),
      diagramHtml("tracked")
    );
    fs.writeFileSync(
      path.join(diagramDir, "untracked.diagram.html"),
      diagramHtml("untracked")
    );
    fs.writeFileSync(
      path.join(diagramDir, "ignored.diagram.html"),
      diagramHtml("ignored")
    );
    fs.writeFileSync(
      path.join(diagramDir, "nested", "tracked.diagram.html"),
      diagramHtml("nested")
    );
    fs.writeFileSync(
      path.join(worktree, ".gitignore"),
      ".claude/diagrams/ignored.diagram.html\n"
    );
    execFileSync("git", [
      "-C",
      worktree,
      "add",
      "--",
      ".gitignore",
      ".claude/diagrams/tracked.diagram.html",
      ".claude/diagrams/nested/tracked.diagram.html",
    ]);

    await expect(listDiagrams(worktree)).resolves.toEqual([
      {
        relPath: ".claude/diagrams/ignored.diagram.html",
        displayName: "ignored",
        tracked: false,
      },
      {
        relPath: ".claude/diagrams/nested/tracked.diagram.html",
        displayName: "nested",
        tracked: true,
      },
      {
        relPath: ".claude/diagrams/tracked.diagram.html",
        displayName: "tracked",
        tracked: true,
      },
      {
        relPath: ".claude/diagrams/untracked.diagram.html",
        displayName: "untracked",
        tracked: false,
      },
    ]);
  });

  it("git index の取得失敗を全件 untracked に丸めず一覧 error にする", async () => {
    const { worktree, diagramDir } = makeWorktree();
    fs.writeFileSync(
      path.join(diagramDir, "valid.diagram.html"),
      diagramHtml("正常")
    );
    fs.renameSync(
      path.join(worktree, ".git"),
      path.join(worktree, ".git-broken")
    );

    await expect(listDiagrams(worktree)).rejects.toThrow();
  });

  it("旧 docs/diagrams にだけ有効な図があっても空配列を返す", async () => {
    const { worktree } = makeWorktree(false);
    const legacyDir = path.join(worktree, "docs", "diagrams");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, "legacy.diagram.html"),
      diagramHtml("旧ルート")
    );

    await expect(listDiagrams(worktree)).resolves.toEqual([]);
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
        relPath: ".claude/diagrams/valid.diagram.html",
        displayName: "正常",
        tracked: false,
      },
    ]);
  });

  it("図の読み込みを同時に8件までに制限する", async () => {
    const { worktree, diagramDir } = makeWorktree();
    for (let index = 0; index < 17; index += 1) {
      fs.writeFileSync(
        path.join(diagramDir, `${index}.diagram.html`),
        diagramHtml()
      );
    }

    const originalOpen = fs.promises.open.bind(fs.promises);
    let active = 0;
    let maxActive = 0;
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      try {
        return await originalOpen(...args);
      } finally {
        active -= 1;
      }
    });

    await expect(listDiagrams(worktree)).resolves.toHaveLength(17);
    expect(maxActive).toBe(8);
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
        relPath: ".claude/diagrams/a.diagram.html",
        displayName: "A",
        tracked: true,
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
