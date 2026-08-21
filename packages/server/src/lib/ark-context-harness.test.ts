import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./database.js", () => ({
  db: { getSetting: vi.fn(() => undefined) },
}));

import {
  ARK_CONTEXT_ENABLED_SETTING_KEY,
  ArkContextHarness,
} from "./ark-context-harness.js";

const temporaryDirectories: string[] = [];

function makeScriptDirectory(
  initBody: string,
  teardownBody = "exit 0"
): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ark-context-test-"));
  temporaryDirectories.push(directory);
  fs.writeFileSync(
    path.join(directory, "session-init.sh"),
    `#!/usr/bin/env bash\n${initBody}\n`,
    { mode: 0o700 }
  );
  fs.writeFileSync(
    path.join(directory, "session-teardown.sh"),
    `#!/usr/bin/env bash\n${teardownBody}\n`,
    { mode: 0o700 }
  );
  return directory;
}

function makeWorktreeDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "ark-context-worktree-")
  );
  temporaryDirectories.push(directory);
  return directory;
}

function enabledOutput(sessionId = "a".repeat(32)): string {
  return [
    "printf 'enabled\\t1\\n'",
    `printf 'ARK_SESSION_ID\\t${sessionId}\\n'`,
    "printf 'ARK_SESSION_DIR\\t/context/session\\n'",
    "printf 'ARK_CACHE_DIR\\t/context/cache\\n'",
    "printf 'ARK_RECITE_INTERVAL\\t10\\n'",
    "printf 'ARK_KNOWLEDGE_DIR\\t/context/knowledge\\n'",
    "printf 'ARK_REPO_KEY\\trepo-key\\n'",
  ].join("\n");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("ArkContextHarness", () => {
  it("opt-in が true 以外なら script を実行せず無効のままにする", async () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    const readSetting = vi.fn(() => undefined);
    const harness = new ArkContextHarness({
      scriptDirectory: "/does/not/exist",
      readSetting,
      logger,
    });

    await expect(
      harness.initializeSession("/worktree")
    ).resolves.toBeUndefined();

    expect(readSetting).toHaveBeenCalledWith(ARK_CONTEXT_ENABLED_SETTING_KEY);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("enabled 1 の TSV を検証して tmux 用 env に変換する", async () => {
    const argumentsFile = path.join(
      os.tmpdir(),
      `ark-context-args-${process.pid}`
    );
    const scriptDirectory = makeScriptDirectory(
      `printf '%s\\n' "$@" >${JSON.stringify(argumentsFile)}\n${enabledOutput()}`
    );
    const harness = new ArkContextHarness({
      scriptDirectory,
      ownerPid: 4242,
      readSetting: () => true,
    });
    const worktreePath = makeWorktreeDirectory();

    const env = await harness.initializeSession(worktreePath, "b".repeat(32));

    expect(env).toEqual({
      ARK_SESSION_ID: "a".repeat(32),
      ARK_SESSION_DIR: "/context/session",
      ARK_CACHE_DIR: "/context/cache",
      ARK_RECITE_INTERVAL: "10",
      ARK_KNOWLEDGE_DIR: "/context/knowledge",
      ARK_REPO_KEY: "repo-key",
    });
    expect(fs.readFileSync(argumentsFile, "utf8").trim().split("\n")).toEqual([
      "--repo",
      fs.realpathSync(worktreePath),
      "--owner-pid",
      "4242",
      "--restart",
      "b".repeat(32),
    ]);
    fs.rmSync(argumentsFile, { force: true });
  });

  it("enabled 0 は理由をログして通常起動へフォールバックする", async () => {
    const scriptDirectory = makeScriptDirectory(
      "printf 'enabled\\t0\\nreason\\tanother live session owns this repo\\n'"
    );
    const logger = { error: vi.fn(), warn: vi.fn() };
    const harness = new ArkContextHarness({
      scriptDirectory,
      readSetting: () => true,
      logger,
    });
    const worktreePath = makeWorktreeDirectory();

    await expect(
      harness.initializeSession(worktreePath)
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("another live session owns this repo")
    );
  });

  it("非0終了は理由をログして通常起動へフォールバックする", async () => {
    const scriptDirectory = makeScriptDirectory("echo init-broke >&2\nexit 7");
    const logger = { error: vi.fn(), warn: vi.fn() };
    const harness = new ArkContextHarness({
      scriptDirectory,
      readSetting: () => true,
      logger,
    });
    const worktreePath = makeWorktreeDirectory();

    await expect(
      harness.initializeSession(worktreePath)
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("session init failed")
    );
  });

  it("timeout はログして通常起動へフォールバックする", async () => {
    const scriptDirectory = makeScriptDirectory("sleep 1");
    const logger = { error: vi.fn(), warn: vi.fn() };
    const harness = new ArkContextHarness({
      scriptDirectory,
      timeoutMs: 20,
      readSetting: () => true,
      logger,
    });
    const worktreePath = makeWorktreeDirectory();

    await expect(
      harness.initializeSession(worktreePath)
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("session init failed")
    );
  });

  it("teardown の非0終了は呼び出し側へ通知する", async () => {
    const scriptDirectory = makeScriptDirectory(enabledOutput(), "exit 9");
    const harness = new ArkContextHarness({
      scriptDirectory,
      readSetting: () => true,
    });
    const worktreePath = makeWorktreeDirectory();

    await expect(
      harness.teardownSession(worktreePath, "a".repeat(32))
    ).rejects.toThrow();
  });

  it("worktree の実体パスを解決できなければログして無効化する", async () => {
    const scriptDirectory = makeScriptDirectory(enabledOutput());
    const logger = { error: vi.fn(), warn: vi.fn() };
    const harness = new ArkContextHarness({
      scriptDirectory,
      readSetting: () => true,
      logger,
    });
    const missingWorktreePath = path.join(
      makeWorktreeDirectory(),
      "does-not-exist"
    );

    await expect(
      harness.initializeSession(missingWorktreePath)
    ).resolves.toBeUndefined();
    await expect(
      harness.teardownSession(missingWorktreePath, "a".repeat(32))
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("worktree path resolution failed")
    );
  });
});
