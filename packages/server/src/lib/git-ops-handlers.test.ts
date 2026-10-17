import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitOpsHandlers } from "./git-ops-handlers.js";

let dir: string;

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function make() {
  return createGitOpsHandlers({
    getWorktreePath: id => (id === "s1" ? dir : undefined),
  });
}

async function call(
  handlers: ReturnType<typeof make>,
  name: keyof ReturnType<typeof make>,
  data: unknown
): Promise<unknown> {
  const cb = vi.fn();
  await handlers[name](data, cb);
  return cb.mock.calls[0]?.[0];
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ark-goh-")));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.com");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  git("add", "-A");
  git("commit", "-q", "-m", "c1");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("git ops handlers", () => {
  it("作成・名前変更・削除を ack で返す", async () => {
    const h = make();
    const head = git("rev-parse", "HEAD");
    expect(
      await call(h, "branchCreate", {
        sessionId: "s1",
        name: "a",
        startPoint: head,
      })
    ).toEqual({ ok: true });
    expect(
      await call(h, "branchRename", { sessionId: "s1", from: "a", to: "b" })
    ).toEqual({ ok: true });
    expect(
      await call(h, "branchDelete", {
        sessionId: "s1",
        name: "b",
        force: false,
      })
    ).toEqual({ ok: true, sha: head });
  });

  it("未マージの削除は notMerged を付けて返す", async () => {
    const h = make();
    git("checkout", "-q", "-b", "wip");
    fs.writeFileSync(path.join(dir, "a.txt"), "wip\n");
    git("commit", "-qam", "wip");
    git("checkout", "-q", "main");
    expect(
      await call(h, "branchDelete", {
        sessionId: "s1",
        name: "wip",
        force: false,
      })
    ).toMatchObject({ ok: false, notMerged: true });
  });

  it("入力の誤りは黙って捨てずに理由を返す", async () => {
    const h = make();
    expect(
      await call(h, "branchCreate", {
        sessionId: "s1",
        name: "bad name",
        startPoint: git("rev-parse", "HEAD"),
      })
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("使えません"),
    });
    expect(await call(h, "fetch", { sessionId: "nope" })).toEqual({
      ok: false,
      error: "セッションが見つかりません",
    });
    expect(await call(h, "fetch", null)).toMatchObject({ ok: false });
  });

  it("cb が関数でなければ何もしない", async () => {
    await expect(
      make().fetch({ sessionId: "s1" }, undefined)
    ).resolves.toBeUndefined();
  });

  it("同じ worktree への操作は重ねず、実行中に届いた操作は断る (socket をまたいでも)", async () => {
    const head = git("rev-parse", "HEAD");
    // 別の接続の handler (タブが 2 つ) から同時に作る
    const results = await Promise.all([
      call(make(), "branchCreate", {
        sessionId: "s1",
        name: "x",
        startPoint: head,
      }),
      call(make(), "branchCreate", {
        sessionId: "s1",
        name: "y",
        startPoint: head,
      }),
    ]);
    expect(results).toContainEqual({ ok: true });
    expect(results).toContainEqual({
      ok: false,
      error: "別の Git の操作が実行中です",
    });
    // 終わったあとは通る
    expect(
      await call(make(), "branchCreate", {
        sessionId: "s1",
        name: "z",
        startPoint: head,
      })
    ).toEqual({ ok: true });
  });
});
