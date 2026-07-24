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

import { isDiagramTracked } from "./diagram-delete.js";

beforeEach(() => {
  gitMocks.execFileAsync.mockClear();
});

it("git ls-files の pathspec magic を明示的に無効化する", async () => {
  await expect(
    isDiagramTracked("/managed/worktree", ":(glob)*.diagram.html")
  ).resolves.toBe(false);

  expect(gitMocks.execFileAsync).toHaveBeenCalledWith(
    "git",
    [
      "-C",
      "/managed/worktree",
      "--literal-pathspecs",
      "ls-files",
      "--cached",
      "-z",
      "--",
      ".claude/diagrams/:(glob)*.diagram.html",
    ],
    { encoding: "utf8" }
  );
});
