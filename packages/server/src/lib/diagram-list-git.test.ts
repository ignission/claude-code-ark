import { beforeEach, expect, it, vi } from "vitest";

const gitMocks = vi.hoisted(() => {
  const execFileAsync = vi.fn(async () => ({ stdout: "", stderr: "" }));
  const execFile = vi.fn();
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {
    value: execFileAsync,
  });
  return { execFile, execFileAsync };
});

vi.mock("node:child_process", () => ({ execFile: gitMocks.execFile }));

import { handleDiagramListRequest, listDiagrams } from "./diagram-list.js";

beforeEach(() => {
  gitMocks.execFileAsync.mockReset();
  gitMocks.execFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
});

it("git ls-files に timeout と maxBuffer を設定する", async () => {
  await expect(listDiagrams("/managed/worktree")).resolves.toEqual([]);

  expect(gitMocks.execFileAsync).toHaveBeenCalledWith(
    "git",
    [
      "-C",
      "/managed/worktree",
      "ls-files",
      "--cached",
      "-z",
      "--",
      ".claude/diagrams",
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024,
    }
  );
});

it("git timeout kill を未追跡扱いにせず一覧 ACK error にする", async () => {
  gitMocks.execFileAsync.mockRejectedValue(
    Object.assign(new Error("git timed out"), {
      killed: true,
      signal: "SIGTERM",
    })
  );

  const result = await handleDiagramListRequest(
    {
      resolveManagedWorktreePath: () => "/managed/worktree",
      listDiagrams,
    },
    { worktreePath: "/input/worktree" }
  );

  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("git timed out");
});
