import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./tmux-manager.js", async () => {
  const { EventEmitter } = await import("node:events");
  class TmuxManagerStub extends EventEmitter {
    getAllSessions = vi.fn(() => []);
    getSession = vi.fn();
    getSessionByWorktree = vi.fn();
    createSession = vi.fn();
    killSession = vi.fn();
    getEnv = vi.fn();
    getPaneEnv = vi.fn();
    setClaudeMcpConfigPath = vi.fn();
    setClaudeAppendSystemPrompt = vi.fn();
  }
  return { tmuxManager: new TmuxManagerStub() };
});

vi.mock("./ttyd-manager.js", async () => {
  const { EventEmitter } = await import("node:events");
  class TtydManagerStub extends EventEmitter {
    startInstance = vi.fn(async (sessionId: string) => ({
      sessionId,
      port: 7681,
      tmuxSessionName: "ark-context-integration",
      basePath: `/ttyd/${sessionId}`,
    }));
    stopInstance = vi.fn();
    getInstance = vi.fn();
  }
  return { ttydManager: new TtydManagerStub() };
});

vi.mock("./database.js", () => ({
  db: {
    getSetting: vi.fn((key: string) =>
      key === "ark_context_enabled" ? true : undefined
    ),
    getRepoProfileLink: vi.fn(() => null),
    getWorktreeProfileLink: vi.fn(() => null),
    getProfile: vi.fn(() => null),
    getSessionByWorktreePath: vi.fn(() => null),
    upsertSession: vi.fn(),
    replaceSession: vi.fn(),
    updateSessionRepoPath: vi.fn(),
    updateSessionStatus: vi.fn(),
    deleteSession: vi.fn(),
  },
}));

import { SessionOrchestrator } from "./session-orchestrator.js";
import { tmuxManager } from "./tmux-manager.js";

const mockedTmux = vi.mocked(tmuxManager);
let testRoot: string;
let worktreePath: string;
const savedXdg = {
  config: process.env.XDG_CONFIG_HOME,
  data: process.env.XDG_DATA_HOME,
  cache: process.env.XDG_CACHE_HOME,
};

beforeAll(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ark-context-integration-"));
  worktreePath = path.join(testRoot, "worktree");
  fs.mkdirSync(worktreePath, { mode: 0o700 });
  fs.mkdirSync(path.join(worktreePath, ".claude"), { mode: 0o755 });
  fs.writeFileSync(
    path.join(worktreePath, ".gitignore"),
    ".claude/settings.local.json\n.claude/settings.local.json.ark-context-tmp\n"
  );
  execFileSync("git", ["-C", worktreePath, "init", "-q"]);
  execFileSync("git", ["-C", worktreePath, "config", "user.name", "fixture"]);
  execFileSync("git", [
    "-C",
    worktreePath,
    "config",
    "user.email",
    "fixture@example.invalid",
  ]);
  execFileSync("git", ["-C", worktreePath, "add", ".gitignore"]);
  execFileSync("git", ["-C", worktreePath, "commit", "-qm", "init"]);

  for (const [name, directory] of [
    ["XDG_CONFIG_HOME", path.join(testRoot, "config")],
    ["XDG_DATA_HOME", path.join(testRoot, "data")],
    ["XDG_CACHE_HOME", path.join(testRoot, "cache")],
  ] as const) {
    fs.mkdirSync(directory, { mode: 0o700 });
    process.env[name] = directory;
  }
});

afterAll(() => {
  if (savedXdg.config === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg.config;
  if (savedXdg.data === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedXdg.data;
  if (savedXdg.cache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedXdg.cache;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe("SessionOrchestrator + real Ark context harness", () => {
  it("session-init の env を tmux に渡し、空 task を生成して stop 後に teardown する", async () => {
    const tmuxSession = {
      id: "tmux-context-integration",
      tmuxSessionName: "ark-context-integration",
      worktreePath,
      createdAt: new Date(),
      lastActivity: new Date(),
      status: "running" as const,
    };
    mockedTmux.getSessionByWorktree.mockReturnValue(undefined);
    mockedTmux.createSession.mockResolvedValue(tmuxSession);
    mockedTmux.getSession.mockReturnValue(tmuxSession);

    const orchestrator = new SessionOrchestrator();
    const managed = await orchestrator.startSession(
      "wt-context-integration",
      worktreePath
    );
    const createOptions = mockedTmux.createSession.mock.calls[0]?.[1];
    const contextEnv = createOptions?.env;

    expect(contextEnv?.ARK_SESSION_ID).toMatch(/^[0-9a-f]{32}$/);
    expect(contextEnv?.ARK_SESSION_DIR).toBeTruthy();
    expect(contextEnv?.ARK_REPO_KEY).toMatch(/^[0-9a-f]{64}$/);
    const taskPath = path.join(contextEnv?.ARK_SESSION_DIR ?? "", "task.md");
    expect(fs.readFileSync(taskPath, "utf8")).toContain("## Goal\n\n");
    expect(fs.readFileSync(taskPath, "utf8")).not.toContain("← NOW");

    mockedTmux.getEnv.mockImplementation((_sessionId, name) =>
      contextEnv?.[name] ? contextEnv[name] : null
    );
    orchestrator.stopSession(managed.id);

    const settingsPath = path.join(
      worktreePath,
      ".claude",
      "settings.local.json"
    );
    await vi.waitFor(() => expect(fs.existsSync(settingsPath)).toBe(false), {
      timeout: 5_000,
      interval: 20,
    });
  });
});
