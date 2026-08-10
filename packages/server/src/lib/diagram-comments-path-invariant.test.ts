import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("./diagram-path.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./diagram-path.js")>();
  return {
    ...actual,
    resolveDiagramPath: (worktreeReal: string, relPath: string) => ({
      ok: true as const,
      absPath: path.join(worktreeReal, relPath),
      relPath,
    }),
  };
});

import { resolveDiagramCommentsPath } from "./diagram-comments.js";

describe("resolveDiagramCommentsPath の自己上書き防止", () => {
  it("suffix 置換が効かない場合は図と同じ path を sidecar にしない", () => {
    const result = resolveDiagramCommentsPath(
      "/worktree",
      ".claude/diagrams/order-flow.html"
    );

    expect(result).toEqual({
      ok: false,
      code: "BAD_REQUEST",
      error: "コメント sidecar のパスを図ファイルから導出できません",
    });
  });
});
