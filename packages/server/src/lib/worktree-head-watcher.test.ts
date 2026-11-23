/**
 * worktree-head-watcher.ts のテスト
 *
 * 指紋は実際の git リポジトリで読み、巡回の判定は指紋の関数を差し替えて確かめる。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readHeadFingerprint,
  resolveGitCommonDir,
  WorktreeHeadWatcher,
} from "./worktree-head-watcher.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeRepo(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ark-head-")));
  dirs.push(root);
  const repo = path.join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(
    repo,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init"
  );
  return repo;
}

describe("readHeadFingerprint", () => {
  it("本体のブランチの切り替えで変わる", async () => {
    const repo = makeRepo();
    const commonDir = await resolveGitCommonDir(repo);
    const before = await readHeadFingerprint(commonDir);
    git(repo, "checkout", "-q", "-b", "feature");
    const after = await readHeadFingerprint(commonDir);
    expect(before).toContain("refs/heads/main");
    expect(after).toContain("refs/heads/feature");
  });

  it("worktreeの追加と、そのworktreeでの切り替えで変わる", async () => {
    const repo = makeRepo();
    const commonDir = await resolveGitCommonDir(repo);
    const before = await readHeadFingerprint(commonDir);
    const wt = path.join(path.dirname(repo), "wt");
    git(repo, "worktree", "add", "-q", "-b", "child", wt);
    const added = await readHeadFingerprint(commonDir);
    expect(added).not.toBe(before);
    expect(added).toContain("refs/heads/child");
    git(wt, "checkout", "-q", "-b", "child2");
    expect(await readHeadFingerprint(commonDir)).toContain("refs/heads/child2");
  });

  it("worktreeの中から解決しても、本体と同じ共通ディレクトリになる", async () => {
    const repo = makeRepo();
    const wt = path.join(path.dirname(repo), "wt");
    git(repo, "worktree", "add", "-q", "-b", "child", wt);
    expect(await resolveGitCommonDir(wt)).toBe(await resolveGitCommonDir(repo));
  });
});

describe("WorktreeHeadWatcher", () => {
  function setup(fingerprints: Map<string, string | Error>) {
    const onChange = vi.fn();
    const watcher = new WorktreeHeadWatcher(onChange, {
      resolveCommonDir: async repo => `${repo}/.git`,
      readFingerprint: async commonDir => {
        const value = fingerprints.get(commonDir);
        if (value === undefined || value instanceof Error) {
          throw value ?? new Error("missing");
        }
        return value;
      },
    });
    return { watcher, onChange };
  }

  it("初めて読んだ指紋では呼ばず、変わったときだけ呼ぶ", async () => {
    const fp = new Map<string, string | Error>([["/a/.git", "main:x"]]);
    const { watcher, onChange } = setup(fp);
    watcher.watch("/a");
    await watcher.check();
    await watcher.check();
    expect(onChange).not.toHaveBeenCalled();
    fp.set("/a/.git", "main:y");
    await watcher.check();
    expect(onChange).toHaveBeenCalledExactlyOnceWith("/a");
  });

  it("読めなくなったリポジトリは外し、watchし直せば戻る", async () => {
    const fp = new Map<string, string | Error>([["/a/.git", "main:x"]]);
    const { watcher, onChange } = setup(fp);
    watcher.watch("/a");
    await watcher.check();
    fp.set("/a/.git", new Error("gone"));
    await watcher.check();
    fp.set("/a/.git", "main:y");
    await watcher.check();
    // 外したあとは読まないので、変わっても呼ばない
    expect(onChange).not.toHaveBeenCalled();
    watcher.watch("/a");
    await watcher.check();
    fp.set("/a/.git", "main:z");
    await watcher.check();
    expect(onChange).toHaveBeenCalledExactlyOnceWith("/a");
  });

  it("同じリポジトリを何度watchしても、前の指紋を保つ", async () => {
    const fp = new Map<string, string | Error>([["/a/.git", "main:x"]]);
    const { watcher, onChange } = setup(fp);
    watcher.watch("/a");
    await watcher.check();
    watcher.watch("/a");
    fp.set("/a/.git", "main:y");
    await watcher.check();
    expect(onChange).toHaveBeenCalledOnce();
  });
});
