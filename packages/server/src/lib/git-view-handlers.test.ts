import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitViewHandlers } from "./git-view-handlers.js";

let dir: string;

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function make() {
  return createGitViewHandlers({
    getWorktreePath: id => (id === "s1" ? dir : undefined),
  });
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ark-gvh-")));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.com");
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  git("add", "-A");
  git("commit", "-q", "-m", "c1");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(
  name: keyof ReturnType<typeof make>,
  data: unknown
): Promise<unknown> {
  const cb = vi.fn();
  await make()[name](data, cb);
  return cb.mock.calls[0]?.[0];
}

describe("正常系", () => {
  it("log", async () => {
    const r = (await call("log", { sessionId: "s1", skip: 0, limit: 10 })) as {
      ok: boolean;
      commits: { subject: string }[];
      hasMore: boolean;
    };
    expect(r.ok).toBe(true);
    expect(r.commits[0].subject).toBe("c1");
    expect(r.hasMore).toBe(false);
  });
  it("refs", async () => {
    const r = (await call("refs", { sessionId: "s1" })) as {
      ok: boolean;
      head: { branch: string };
    };
    expect(r.ok).toBe(true);
    expect(r.head.branch).toBe("main");
  });
  it("status", async () => {
    fs.writeFileSync(path.join(dir, "u.txt"), "u\n");
    const r = (await call("status", { sessionId: "s1" })) as {
      ok: boolean;
      untracked: { path: string }[];
    };
    expect(r.ok).toBe(true);
    expect(r.untracked[0].path).toBe("u.txt");
  });
  it("commit", async () => {
    const sha = git("rev-parse", "HEAD");
    const r = (await call("commit", { sessionId: "s1", sha })) as {
      ok: boolean;
      commit: { sha: string };
      files: unknown[];
    };
    expect(r.ok).toBe(true);
    expect(r.commit.sha).toBe(sha);
    expect(r.files).toHaveLength(1);
  });
  it("fileDiff", async () => {
    const r = await call("fileDiff", {
      sessionId: "s1",
      target: { kind: "untracked" },
      path: "a.txt",
    });
    expect(r).toMatchObject({ ok: true, newContent: "hello\n" });
  });
  it("fingerprint", async () => {
    const r = (await call("fingerprint", { sessionId: "s1" })) as {
      ok: boolean;
      fingerprint: string;
    };
    expect(r.ok).toBe(true);
    expect(r.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("異常系", () => {
  const names = [
    "log",
    "refs",
    "status",
    "commit",
    "fileDiff",
    "fingerprint",
  ] as const;

  it("未知のセッション", async () => {
    for (const n of names) {
      expect(
        await call(n, {
          sessionId: "nope",
          skip: 0,
          limit: 1,
          sha: "abcdef1",
          target: { kind: "staged" },
          path: "a.txt",
        })
      ).toEqual({ ok: false, error: "セッションが見つかりません" });
    }
  });

  it("cb が関数でない・data の形が不正なら何も起きない", async () => {
    const h = make();
    for (const n of names) {
      await expect(
        h[n]({ sessionId: "s1" }, undefined)
      ).resolves.toBeUndefined();
      await expect(h[n]({ sessionId: "s1" }, "x")).resolves.toBeUndefined();
      for (const bad of [null, undefined, 1, "x", {}, { sessionId: 1 }]) {
        const cb = vi.fn();
        await expect(h[n](bad, cb)).resolves.toBeUndefined();
        expect(cb).not.toHaveBeenCalled();
      }
    }
  });

  it("不正な値は ack せず黙って捨てる", async () => {
    const bad: [keyof ReturnType<typeof make>, unknown][] = [
      ["log", { sessionId: "s1", skip: "0", limit: 10 }],
      ["log", { sessionId: "s1", skip: 0 }],
      ["commit", { sessionId: "s1", sha: "--all" }],
      ["commit", { sessionId: "s1", sha: 1 }],
      ["fileDiff", { sessionId: "s1", target: { kind: "x" }, path: "a.txt" }],
      [
        "fileDiff",
        {
          sessionId: "s1",
          target: { kind: "commit", sha: "-x" },
          path: "a.txt",
        },
      ],
      [
        "fileDiff",
        { sessionId: "s1", target: { kind: "staged" }, path: "../a" },
      ],
      [
        "fileDiff",
        { sessionId: "s1", target: { kind: "staged" }, path: "--output=x" },
      ],
      [
        "fileDiff",
        {
          sessionId: "s1",
          target: { kind: "staged" },
          path: "a",
          oldPath: "/etc/passwd",
        },
      ],
      ["fileDiff", { sessionId: "s1", path: "a.txt" }],
    ];
    for (const [n, data] of bad) {
      const cb = vi.fn();
      await make()[n](data, cb);
      expect(cb).not.toHaveBeenCalled();
    }
    expect(fs.existsSync(path.join(dir, "x"))).toBe(false);
  });

  it("git が失敗したら ok:false で返し投げない", async () => {
    const cb = vi.fn();
    await make().commit({ sessionId: "s1", sha: "deadbeef" }, cb);
    expect(cb.mock.calls[0][0]).toMatchObject({ ok: false });
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "ark-gvh-plain-"));
    try {
      const h = createGitViewHandlers({ getWorktreePath: () => plain });
      const cb2 = vi.fn();
      await h.status({ sessionId: "s1" }, cb2);
      expect(cb2.mock.calls[0][0]).toEqual({
        ok: false,
        error: "git リポジトリではありません",
      });
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});
