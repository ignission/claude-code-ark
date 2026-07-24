import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DiagramDeleteRequest, DiagramDeleteResponse } from "@ark/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDiagramDeleteSocketHandler,
  type DiagramDeleteRequestDeps,
  deleteDiagramFile,
  handleDiagramDeleteRequest,
  isDiagramTracked,
} from "./diagram-delete.js";

const tempDirs: string[] = [];

function makeDeleteFixture(): {
  worktree: string;
  diagramsDir: string;
  outside: string;
} {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ark-diagram-delete-"))
  );
  tempDirs.push(root);
  const worktree = path.join(root, "worktree");
  const diagramsDir = path.join(worktree, ".claude", "diagrams");
  const outside = path.join(root, "outside.diagram.html");
  fs.mkdirSync(diagramsDir, { recursive: true });
  fs.writeFileSync(outside, "outside");
  return { worktree, diagramsDir, outside };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("diagram delete shared contract", () => {
  it("request と success/error response を共有型で表現する", () => {
    const request: DiagramDeleteRequest = {
      sessionId: "session-1",
      relPath: ".claude/diagrams/a.diagram.html",
      expectedTracked: true,
    };
    const success: DiagramDeleteResponse = {
      ok: true,
      relPath: request.relPath,
      tracked: true,
    };
    const failure: DiagramDeleteResponse = {
      ok: false,
      code: "FORBIDDEN",
      error: "拒否",
    };

    expect(success.ok).toBe(true);
    expect(failure.ok).toBe(false);
  });
});

function makeRequestDeps(): DiagramDeleteRequestDeps {
  return {
    getSession: vi.fn(() => ({
      id: "session-1",
      worktreePath: "/input/worktree",
    })),
    resolveManagedWorktreePath: vi.fn(() => "/real/worktree"),
    isDiagramTracked: vi.fn(async () => true),
    deleteDiagramFile: vi.fn(async () => ({
      ok: true as const,
      absPath: "/real/worktree/.claude/diagrams/a.diagram.html",
    })),
    clearSessionLastDiagramIfMatches: vi.fn(() => false),
    onSessionCleared: vi.fn(),
    onDeleted: vi.fn(),
  };
}

describe("handleDiagramDeleteRequest payload validation", () => {
  it.each([
    undefined,
    null,
    [],
    {},
    { sessionId: "", relPath: "a.diagram.html", expectedTracked: true },
    { sessionId: 1, relPath: "a.diagram.html", expectedTracked: true },
    {
      sessionId: "x".repeat(1025),
      relPath: "a.diagram.html",
      expectedTracked: true,
    },
    { sessionId: "session-1", relPath: "", expectedTracked: true },
    { sessionId: "session-1", relPath: 1, expectedTracked: true },
    {
      sessionId: "session-1",
      relPath: "a.diagram.html",
      expectedTracked: "true",
    },
  ])("不正 payload %j は依存処理を呼ばず BAD_REQUEST にする", async data => {
    const deps = makeRequestDeps();

    await expect(handleDiagramDeleteRequest(deps, data)).resolves.toEqual({
      ok: false,
      code: "BAD_REQUEST",
      error: "不正なリクエストです",
    });
    for (const dependency of Object.values(deps)) {
      expect(dependency).not.toHaveBeenCalled();
    }
  });
});

describe("handleDiagramDeleteRequest managed worktree boundary", () => {
  const request: DiagramDeleteRequest = {
    sessionId: "session-1",
    relPath: ".claude/diagrams/a.diagram.html",
    expectedTracked: true,
  };

  it("不明 session を SESSION_NOT_FOUND にする", async () => {
    const deps = makeRequestDeps();
    vi.mocked(deps.getSession).mockReturnValue(null);

    await expect(handleDiagramDeleteRequest(deps, request)).resolves.toEqual({
      ok: false,
      code: "SESSION_NOT_FOUND",
      error: "セッションが見つかりません",
    });
    expect(deps.resolveManagedWorktreePath).not.toHaveBeenCalled();
    expect(deps.deleteDiagramFile).not.toHaveBeenCalled();
  });

  it("session の worktree が管理対象外なら FORBIDDEN にする", async () => {
    const deps = makeRequestDeps();
    vi.mocked(deps.resolveManagedWorktreePath).mockReturnValue(null);

    await expect(handleDiagramDeleteRequest(deps, request)).resolves.toEqual({
      ok: false,
      code: "FORBIDDEN",
      error: "管理対象の worktree ではありません",
    });
    expect(deps.resolveManagedWorktreePath).toHaveBeenCalledWith(
      "/input/worktree"
    );
    expect(deps.deleteDiagramFile).not.toHaveBeenCalled();
  });

  it("resolver の realpath だけを file helper に渡す", async () => {
    const deps = makeRequestDeps();

    await expect(
      handleDiagramDeleteRequest(deps, request)
    ).resolves.toMatchObject({ ok: true });
    expect(deps.deleteDiagramFile).toHaveBeenCalledWith(
      "/real/worktree",
      request.relPath
    );
    expect(deps.deleteDiagramFile).not.toHaveBeenCalledWith(
      "/input/worktree",
      request.relPath
    );
  });
});

describe("handleDiagramDeleteRequest tracked 再確認", () => {
  it.each([
    { expectedTracked: true, currentTracked: true },
    { expectedTracked: false, currentTracked: false },
  ])("expected=$expectedTracked/current=$currentTracked なら削除へ進む", async ({
    expectedTracked,
    currentTracked,
  }) => {
    const deps = makeRequestDeps();
    vi.mocked(deps.isDiagramTracked).mockResolvedValue(currentTracked);

    await expect(
      handleDiagramDeleteRequest(deps, {
        sessionId: "session-1",
        relPath: ".claude/diagrams/a.diagram.html",
        expectedTracked,
      })
    ).resolves.toEqual({
      ok: true,
      relPath: ".claude/diagrams/a.diagram.html",
      tracked: currentTracked,
    });
    expect(deps.deleteDiagramFile).toHaveBeenCalledOnce();
  });

  it.each([
    { expectedTracked: true, currentTracked: false },
    { expectedTracked: false, currentTracked: true },
  ])("expected=$expectedTracked/current=$currentTracked の不一致は CONFLICT で削除しない", async ({
    expectedTracked,
    currentTracked,
  }) => {
    const deps = makeRequestDeps();
    vi.mocked(deps.isDiagramTracked).mockResolvedValue(currentTracked);

    await expect(
      handleDiagramDeleteRequest(deps, {
        sessionId: "session-1",
        relPath: ".claude/diagrams/a.diagram.html",
        expectedTracked,
      })
    ).resolves.toMatchObject({ ok: false, code: "CONFLICT" });
    expect(deps.deleteDiagramFile).not.toHaveBeenCalled();
  });

  it("git error は unlink 前の IO_ERROR にする", async () => {
    const deps = makeRequestDeps();
    vi.mocked(deps.isDiagramTracked).mockRejectedValue(
      Object.assign(new Error("git failed"), { code: "EIO" })
    );

    const result = await handleDiagramDeleteRequest(deps, {
      sessionId: "session-1",
      relPath: ".claude/diagrams/a.diagram.html",
      expectedTracked: true,
    });

    expect(result).toMatchObject({ ok: false, code: "IO_ERROR" });
    if (!result.ok) expect(result.error).toContain("git failed");
    expect(deps.deleteDiagramFile).not.toHaveBeenCalled();
  });
});

describe("handleDiagramDeleteRequest side-effect order", () => {
  const request: DiagramDeleteRequest = {
    sessionId: "session-1",
    relPath: ".claude/diagrams/a.diagram.html",
    expectedTracked: true,
  };

  it("unlink 成功後だけ conditional clear と通知を順に行う", async () => {
    const deps = makeRequestDeps();
    vi.mocked(deps.clearSessionLastDiagramIfMatches).mockReturnValue(true);

    await expect(handleDiagramDeleteRequest(deps, request)).resolves.toEqual({
      ok: true,
      relPath: request.relPath,
      tracked: true,
    });
    expect(deps.deleteDiagramFile).toHaveBeenCalledBefore(
      vi.mocked(deps.clearSessionLastDiagramIfMatches)
    );
    expect(deps.clearSessionLastDiagramIfMatches).toHaveBeenCalledWith(
      request.sessionId,
      request.relPath
    );
    expect(deps.clearSessionLastDiagramIfMatches).toHaveBeenCalledBefore(
      vi.mocked(deps.onSessionCleared)
    );
    expect(deps.onSessionCleared).toHaveBeenCalledBefore(
      vi.mocked(deps.onDeleted)
    );
    expect(deps.onDeleted).toHaveBeenCalledWith({
      sessionId: request.sessionId,
      relPath: request.relPath,
    });
  });

  it("unlink 失敗時は DB と broadcast を呼ばない", async () => {
    const deps = makeRequestDeps();
    vi.mocked(deps.deleteDiagramFile).mockResolvedValue({
      ok: false,
      code: "NOT_FOUND",
      error: "missing",
    });

    await expect(
      handleDiagramDeleteRequest(deps, request)
    ).resolves.toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(deps.clearSessionLastDiagramIfMatches).not.toHaveBeenCalled();
    expect(deps.onSessionCleared).not.toHaveBeenCalled();
    expect(deps.onDeleted).not.toHaveBeenCalled();
  });

  it("DB clear failure は success + warning で削除通知を送る", async () => {
    const deps = makeRequestDeps();
    vi.mocked(deps.clearSessionLastDiagramIfMatches).mockImplementation(() => {
      throw new Error("database unavailable");
    });

    const result = await handleDiagramDeleteRequest(deps, request);

    expect(result).toMatchObject({
      ok: true,
      relPath: request.relPath,
      tracked: true,
    });
    if (result.ok) {
      expect(result.warning).toContain("database unavailable");
    }
    expect(deps.onSessionCleared).not.toHaveBeenCalled();
    expect(deps.onDeleted).toHaveBeenCalledWith({
      sessionId: request.sessionId,
      relPath: request.relPath,
    });
  });
});

describe("diagram:delete ACK handler", () => {
  it("ACK を成功結果で1回だけ呼ぶ", async () => {
    const response: DiagramDeleteResponse = {
      ok: true,
      relPath: ".claude/diagrams/a.diagram.html",
      tracked: true,
    };
    const requestHandler = vi.fn(async () => response);
    const callback = vi.fn();
    const handler = createDiagramDeleteSocketHandler(
      makeRequestDeps(),
      requestHandler
    );

    handler({ sessionId: "session-1" }, callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
    expect(callback).toHaveBeenCalledWith(response);
    expect(requestHandler).toHaveBeenCalledOnce();
  });

  it.each([
    undefined,
    null,
    "callback",
  ])("callback が関数でない場合 (%j) は core を呼ばず安全に無視する", async callback => {
    const requestHandler = vi.fn();
    const handler = createDiagramDeleteSocketHandler(
      makeRequestDeps(),
      requestHandler
    );

    expect(() => handler({}, callback)).not.toThrow();
    await Promise.resolve();
    expect(requestHandler).not.toHaveBeenCalled();
  });

  it("ACK callback が throw しても handler から伝播しない", async () => {
    const handler = createDiagramDeleteSocketHandler(
      makeRequestDeps(),
      async () => ({
        ok: false,
        code: "BAD_REQUEST",
        error: "bad request",
      })
    );
    const callback = vi.fn(() => {
      throw new Error("client callback failed");
    });

    expect(() => handler({}, callback)).not.toThrow();
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
  });

  it("core が reject しても IO_ERROR の ACK を1回だけ返す", async () => {
    const requestHandler = vi.fn(async (): Promise<DiagramDeleteResponse> => {
      throw new Error("unexpected core failure");
    });
    const callback = vi.fn();
    const handler = createDiagramDeleteSocketHandler(
      makeRequestDeps(),
      requestHandler
    );

    handler({}, callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
    expect(callback).toHaveBeenCalledWith({
      ok: false,
      code: "IO_ERROR",
      error: "図ファイルの削除に失敗しました: unexpected core failure",
    });
  });
});

describe("deleteDiagramFile path boundary", () => {
  it.each([
    "../outside.diagram.html",
    ".claude/diagrams/nested/../../../outside.diagram.html",
    "",
    `${"a".repeat(1025)}.diagram.html`,
    ".claude/diagrams/not-diagram.html",
    "docs/diagrams/legacy.diagram.html",
    ".claude/other/outside.diagram.html",
  ])("不正な相対 path %j を FORBIDDEN にして何も削除しない", async relPath => {
    const { worktree, diagramsDir, outside } = makeDeleteFixture();
    const neighbor = path.join(diagramsDir, "neighbor.diagram.html");
    const legacy = path.join(
      worktree,
      "docs",
      "diagrams",
      "legacy.diagram.html"
    );
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(neighbor, "neighbor");
    fs.writeFileSync(legacy, "legacy");

    await expect(deleteDiagramFile(worktree, relPath)).resolves.toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    });
    expect(fs.readFileSync(outside, "utf8")).toBe("outside");
    expect(fs.readFileSync(neighbor, "utf8")).toBe("neighbor");
    expect(fs.readFileSync(legacy, "utf8")).toBe("legacy");
  });

  it("絶対 path を FORBIDDEN にして外部 file を残す", async () => {
    const { worktree, outside } = makeDeleteFixture();

    await expect(deleteDiagramFile(worktree, outside)).resolves.toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    });
    expect(fs.readFileSync(outside, "utf8")).toBe("outside");
  });

  it.each([
    "../outside.diagram.html",
    "/tmp/outside.diagram.html",
    "docs/diagrams/legacy.diagram.html",
    ".claude/other/outside.diagram.html",
  ])("request core は不正 path %j を Git 判定より前に FORBIDDEN にする", async relPath => {
    const deps = makeRequestDeps();

    await expect(
      handleDiagramDeleteRequest(deps, {
        sessionId: "session-1",
        relPath,
        expectedTracked: true,
      })
    ).resolves.toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(deps.isDiagramTracked).not.toHaveBeenCalled();
    expect(deps.deleteDiagramFile).not.toHaveBeenCalled();
  });
});

describe("deleteDiagramFile symlink と file 種別", () => {
  it.each([
    "outside",
    "inside",
  ] as const)("最終要素が %s 向き symlink なら link と target を残して FORBIDDEN にする", async direction => {
    const { worktree, diagramsDir, outside } = makeDeleteFixture();
    const inside = path.join(diagramsDir, "target.diagram.html");
    const link = path.join(diagramsDir, "link.diagram.html");
    fs.writeFileSync(inside, "inside");
    const target = direction === "outside" ? outside : inside;
    fs.symlinkSync(target, link);

    await expect(
      deleteDiagramFile(worktree, ".claude/diagrams/link.diagram.html")
    ).resolves.toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe(direction);
  });

  it("外向き ancestor symlink を辿らず外部 target を残す", async () => {
    const { worktree, diagramsDir } = makeDeleteFixture();
    const outsideDir = path.join(path.dirname(worktree), "outside-dir");
    const outsideTarget = path.join(outsideDir, "target.diagram.html");
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(outsideTarget, "outside-target");
    fs.symlinkSync(outsideDir, path.join(diagramsDir, "linked"), "dir");

    await expect(
      deleteDiagramFile(worktree, ".claude/diagrams/linked/target.diagram.html")
    ).resolves.toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(fs.readFileSync(outsideTarget, "utf8")).toBe("outside-target");
    expect(
      fs.lstatSync(path.join(diagramsDir, "linked")).isSymbolicLink()
    ).toBe(true);
  });

  it("directory を FORBIDDEN にして entry を残す", async () => {
    const { worktree, diagramsDir } = makeDeleteFixture();
    const directory = path.join(diagramsDir, "directory.diagram.html");
    fs.mkdirSync(directory);

    await expect(
      deleteDiagramFile(worktree, ".claude/diagrams/directory.diagram.html")
    ).resolves.toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(fs.statSync(directory).isDirectory()).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "FIFO を FORBIDDEN にして entry を残す",
    async () => {
      const { worktree, diagramsDir } = makeDeleteFixture();
      const fifo = path.join(diagramsDir, "pipe.diagram.html");
      execFileSync("mkfifo", [fifo]);

      await expect(
        deleteDiagramFile(worktree, ".claude/diagrams/pipe.diagram.html", {
          fs: {
            open: (filePath, flags) =>
              fs.promises.open(filePath, flags | fs.constants.O_NONBLOCK),
            realpath: fs.promises.realpath,
            stat: fs.promises.stat,
            lstatSync: fs.lstatSync,
            unlinkSync: fs.unlinkSync,
          },
        })
      ).resolves.toMatchObject({ ok: false, code: "FORBIDDEN" });
      expect(fs.lstatSync(fifo).isFIFO()).toBe(true);
    }
  );
});

describe("deleteDiagramFile verified unlink", () => {
  it.each([
    ".claude/diagrams/direct.diagram.html",
    ".claude/diagrams/nested/deep.diagram.html",
  ])("通常 file %s だけを削除する", async relPath => {
    const { worktree, diagramsDir } = makeDeleteFixture();
    const target = path.join(worktree, relPath);
    const neighbor = path.join(diagramsDir, "neighbor.diagram.html");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "target");
    fs.writeFileSync(neighbor, "neighbor");
    let openFlags = 0;

    await expect(
      deleteDiagramFile(worktree, relPath, {
        fs: {
          open: (filePath, flags) => {
            openFlags = flags;
            return fs.promises.open(filePath, flags);
          },
          realpath: fs.promises.realpath,
          stat: fs.promises.stat,
          lstatSync: fs.lstatSync,
          unlinkSync: fs.unlinkSync,
        },
      })
    ).resolves.toEqual({ ok: true, absPath: target });
    expect(openFlags & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(neighbor, "utf8")).toBe("neighbor");
  });

  it("存在しない path を NOT_FOUND にして directory 内容を維持する", async () => {
    const { worktree, diagramsDir } = makeDeleteFixture();
    const neighbor = path.join(diagramsDir, "neighbor.diagram.html");
    fs.writeFileSync(neighbor, "neighbor");

    await expect(
      deleteDiagramFile(worktree, ".claude/diagrams/missing.diagram.html")
    ).resolves.toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(fs.readFileSync(neighbor, "utf8")).toBe("neighbor");
  });

  it.each([
    "EACCES",
    "EPERM",
  ])("%s を FORBIDDEN にして unlink しない", async code => {
    const { worktree, diagramsDir } = makeDeleteFixture();
    const target = path.join(diagramsDir, "denied.diagram.html");
    fs.writeFileSync(target, "target");
    const unlinkSync = vi.fn();

    await expect(
      deleteDiagramFile(worktree, ".claude/diagrams/denied.diagram.html", {
        fs: {
          open: async () => {
            throw Object.assign(new Error("denied"), { code });
          },
          realpath: fs.promises.realpath,
          stat: fs.promises.stat,
          lstatSync: fs.lstatSync,
          unlinkSync,
        },
      })
    ).resolves.toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(unlinkSync).not.toHaveBeenCalled();
    expect(fs.readFileSync(target, "utf8")).toBe("target");
  });

  it("その他 I/O error は errno を含む IO_ERROR にする", async () => {
    const { worktree, diagramsDir } = makeDeleteFixture();
    const target = path.join(diagramsDir, "io.diagram.html");
    fs.writeFileSync(target, "target");

    const result = await deleteDiagramFile(
      worktree,
      ".claude/diagrams/io.diagram.html",
      {
        fs: {
          open: async () => {
            throw Object.assign(new Error("device failure"), { code: "EIO" });
          },
          realpath: fs.promises.realpath,
          stat: fs.promises.stat,
          lstatSync: fs.lstatSync,
          unlinkSync: fs.unlinkSync,
        },
      }
    );

    expect(result).toMatchObject({ ok: false, code: "IO_ERROR" });
    if (!result.ok) {
      expect(result.error).toContain("EIO");
      expect(result.error).toContain("device failure");
    }
    expect(fs.readFileSync(target, "utf8")).toBe("target");
  });
});

describe("deleteDiagramFile TOCTOU final identity", () => {
  it("open 後に外向き symlink へ交換された path を削除しない", async () => {
    const { worktree, diagramsDir, outside } = makeDeleteFixture();
    const target = path.join(diagramsDir, "race.diagram.html");
    const openedOriginal = path.join(diagramsDir, "opened-original");
    fs.writeFileSync(target, "original");

    const beforeFinalIdentityCheck = vi.fn(() => {
      fs.renameSync(target, openedOriginal);
      fs.symlinkSync(outside, target);
    });
    await expect(
      deleteDiagramFile(worktree, ".claude/diagrams/race.diagram.html", {
        beforeFinalIdentityCheck,
      })
    ).resolves.toMatchObject({ ok: false, code: "FORBIDDEN" });

    expect(beforeFinalIdentityCheck).toHaveBeenCalledWith(target);
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(outside, "utf8")).toBe("outside");
    expect(fs.readFileSync(openedOriginal, "utf8")).toBe("original");
  });

  it("open 後に root 内の別 inode へ交換された path を削除しない", async () => {
    const { worktree, diagramsDir } = makeDeleteFixture();
    const target = path.join(diagramsDir, "race.diagram.html");
    const openedOriginal = path.join(diagramsDir, "opened-original");
    fs.writeFileSync(target, "original");

    await expect(
      deleteDiagramFile(worktree, ".claude/diagrams/race.diagram.html", {
        beforeFinalIdentityCheck: () => {
          fs.renameSync(target, openedOriginal);
          fs.writeFileSync(target, "replacement");
        },
      })
    ).resolves.toMatchObject({ ok: false, code: "FORBIDDEN" });

    expect(fs.readFileSync(target, "utf8")).toBe("replacement");
    expect(fs.readFileSync(openedOriginal, "utf8")).toBe("original");
  });
});

describe("tracked/untracked unlink integration", () => {
  function initializeGitWorktree(worktree: string): void {
    execFileSync("git", ["init", "-q", worktree]);
    execFileSync("git", ["-C", worktree, "config", "user.name", "Ark Test"]);
    execFileSync("git", [
      "-C",
      worktree,
      "config",
      "user.email",
      "ark-test@example.com",
    ]);
  }

  function realDeps(worktree: string): DiagramDeleteRequestDeps {
    return {
      getSession: () => ({ id: "session-1", worktreePath: worktree }),
      resolveManagedWorktreePath: () => worktree,
      isDiagramTracked,
      deleteDiagramFile,
      clearSessionLastDiagramIfMatches: () => false,
      onSessionCleared: vi.fn(),
      onDeleted: vi.fn(),
    };
  }

  it("tracked regular file は index を変えず worktree に削除差分だけを残す", async () => {
    const { worktree, diagramsDir } = makeDeleteFixture();
    initializeGitWorktree(worktree);
    const target = path.join(diagramsDir, "tracked.diagram.html");
    const neighbor = path.join(diagramsDir, "neighbor.diagram.html");
    fs.writeFileSync(target, "tracked");
    fs.writeFileSync(neighbor, "neighbor");
    execFileSync("git", ["-C", worktree, "add", "--", ".claude/diagrams"]);
    execFileSync("git", ["-C", worktree, "commit", "-qm", "fixture"]);
    const indexBefore = execFileSync("git", [
      "-C",
      worktree,
      "ls-files",
      "--stage",
    ]).toString();

    await expect(
      handleDiagramDeleteRequest(realDeps(worktree), {
        sessionId: "session-1",
        relPath: ".claude/diagrams/tracked.diagram.html",
        expectedTracked: true,
      })
    ).resolves.toMatchObject({ ok: true, tracked: true });

    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(neighbor, "utf8")).toBe("neighbor");
    expect(
      execFileSync("git", ["-C", worktree, "ls-files", "--stage"]).toString()
    ).toBe(indexBefore);
    expect(
      execFileSync("git", ["-C", worktree, "status", "--short"]).toString()
    ).toContain(" D .claude/diagrams/tracked.diagram.html");
  });

  it("untracked regular file は対象1件だけを unlink する", async () => {
    const { worktree, diagramsDir } = makeDeleteFixture();
    initializeGitWorktree(worktree);
    const target = path.join(diagramsDir, "untracked.diagram.html");
    const neighbor = path.join(diagramsDir, "neighbor.diagram.html");
    fs.writeFileSync(target, "untracked");
    fs.writeFileSync(neighbor, "neighbor");

    await expect(
      handleDiagramDeleteRequest(realDeps(worktree), {
        sessionId: "session-1",
        relPath: ".claude/diagrams/untracked.diagram.html",
        expectedTracked: false,
      })
    ).resolves.toMatchObject({ ok: true, tracked: false });

    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(neighbor, "utf8")).toBe("neighbor");
    expect(execFileSync("git", ["-C", worktree, "ls-files"]).toString()).toBe(
      ""
    );
  });
});
