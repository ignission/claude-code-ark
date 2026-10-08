import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getCommit,
  getFileDiff,
  getFingerprint,
  getLog,
  getRefs,
  getStatus,
  isSafeRelPath,
  isValidSha,
} from "./git-view.js";

let dir: string;

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

function write(rel: string, content: string | Buffer) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function commit(msg: string, files: Record<string, string | Buffer> = {}) {
  for (const [k, v] of Object.entries(files)) write(k, v);
  git("add", "-A");
  git("commit", "-q", "-m", msg);
  return git("rev-parse", "HEAD");
}

/** 失敗してよいgit (競合するマージ等)。出力は捨てる */
function gitQuiet(...args: string[]) {
  spawnSync("git", args, { cwd: dir, stdio: "pipe" });
}

/** mainとsideが同じ行を別々に書き換え、マージが競合した状態にする */
function makeConflict() {
  commit("base", { "c.txt": "base\n", "keep.txt": "k\n" });
  git("checkout", "-q", "-b", "side");
  commit("theirs", { "c.txt": "theirs\n" });
  git("checkout", "-q", "main");
  commit("ours", { "c.txt": "ours\n" });
  gitQuiet("merge", "side");
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ark-gv-")));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.com");
  git("config", "commit.gpgsign", "false");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("validators", () => {
  it("isValidSha", () => {
    expect(isValidSha("abcdef1")).toBe(true);
    expect(isValidSha("a".repeat(40))).toBe(true);
    expect(isValidSha("abcdef")).toBe(false);
    expect(isValidSha("a".repeat(41))).toBe(false);
    expect(isValidSha("ABCDEF1")).toBe(false);
    expect(isValidSha("--all")).toBe(false);
    expect(isValidSha(undefined)).toBe(false);
  });
  it("isSafeRelPath", () => {
    expect(isSafeRelPath("a/b.txt")).toBe(true);
    expect(isSafeRelPath("a..b")).toBe(true);
    expect(isSafeRelPath("")).toBe(false);
    expect(isSafeRelPath("--output=x")).toBe(false);
    expect(isSafeRelPath("../x")).toBe(false);
    expect(isSafeRelPath("a/../x")).toBe(false);
    expect(isSafeRelPath("/abs")).toBe(false);
    expect(isSafeRelPath("a\0b")).toBe(false);
    expect(isSafeRelPath(1)).toBe(false);
  });
});

describe("非リポジトリ", () => {
  it("日本語のエラーで投げる", async () => {
    const plain = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "ark-gv-plain-"))
    );
    try {
      await expect(getLog(plain, 0, 10)).rejects.toThrow(
        "git リポジトリではありません"
      );
      await expect(getStatus(plain)).rejects.toThrow(
        "git リポジトリではありません"
      );
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("getLog", () => {
  it("並び・親・ref・マージ・スタッシュ除外・ページング", async () => {
    const c1 = commit("c1", { "a.txt": "1\n" });
    git("checkout", "-q", "-b", "feat");
    const c2 = commit("c2 feat", { "b.txt": "b\n" });
    git("checkout", "-q", "main");
    const c3 = commit("c3 main", { "c.txt": "c\n" });
    git("merge", "-q", "--no-ff", "-m", "merge feat", "feat");
    const merge = git("rev-parse", "HEAD");
    git("tag", "light");
    git("tag", "-a", "ann", "-m", "annotated");
    git("update-ref", "refs/remotes/origin/main", c3);
    git("update-ref", "refs/remotes/origin/HEAD", c3);
    write("a.txt", "dirty\n");
    git("stash", "push", "-q");

    const { commits, hasMore } = await getLog(dir, 0, 50);
    expect(hasMore).toBe(false);
    expect(commits.map(c => c.sha)).toHaveLength(4);
    expect(commits[0].sha).toBe(merge);
    expect(commits[0].parents).toEqual([c3, c2]);
    expect(commits[0].subject).toBe("merge feat");
    expect(commits[0].authorName).toBe("T");
    expect(commits[0].authorEmail).toBe("t@example.com");
    expect(commits[0].refs).toEqual(
      expect.arrayContaining([
        { kind: "head", name: "main" },
        { kind: "tag", name: "light" },
        { kind: "tag", name: "ann" },
      ])
    );
    const byLast = commits.find(c => c.sha === c3);
    expect(byLast?.refs).toEqual([{ kind: "remote", name: "origin/main" }]);
    expect(commits.find(c => c.sha === c2)?.refs).toEqual([
      { kind: "branch", name: "feat" },
    ]);
    expect(commits[commits.length - 1].sha).toBe(c1);
    expect(commits[commits.length - 1].parents).toEqual([]);
    // スタッシュの内部コミットは混ざらない
    expect(commits.every(c => !c.subject.startsWith("WIP on"))).toBe(true);
    expect(commits.flatMap(c => c.refs).some(r => r.kind === "stash")).toBe(
      false
    );

    const p1 = await getLog(dir, 0, 2);
    expect(p1.commits).toHaveLength(2);
    expect(p1.hasMore).toBe(true);
    const p2 = await getLog(dir, 2, 2);
    expect(p2.commits).toHaveLength(2);
    expect(p2.hasMore).toBe(false);
    expect([...p1.commits, ...p2.commits].map(c => c.sha)).toEqual(
      commits.map(c => c.sha)
    );
  });

  it("detached HEAD は HEAD の札が付く", async () => {
    const c1 = commit("c1", { "a.txt": "1\n" });
    commit("c2", { "a.txt": "2\n" });
    git("checkout", "-q", "--detach", c1);
    const { commits } = await getLog(dir, 0, 10);
    expect(commits.find(c => c.sha === c1)?.refs).toContainEqual({
      kind: "head",
      name: "HEAD",
    });
  });

  it("コミットが無いリポジトリは空", async () => {
    expect(await getLog(dir, 0, 10)).toEqual({ commits: [], hasMore: false });
  });

  it("limit は 1..500 に丸める", async () => {
    commit("c1", { "a.txt": "1\n" });
    const r = await getLog(dir, -5, 0);
    expect(r.commits).toHaveLength(1);
  });
});

describe("getRefs", () => {
  it("ahead / behind・リモート・タグ (peeled)・スタッシュ", async () => {
    const c1 = commit("c1", { "a.txt": "1\n" });
    git("update-ref", "refs/remotes/origin/main", c1);
    git("config", "remote.origin.url", "/nonexistent");
    git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    git("config", "branch.main.remote", "origin");
    git("config", "branch.main.merge", "refs/heads/main");
    commit("c2", { "a.txt": "2\n" });
    commit("c3", { "a.txt": "3\n" });
    const head = git("rev-parse", "HEAD");
    git("tag", "-a", "ann", "-m", "x", c1);
    git("tag", "light");
    write("a.txt", "dirty\n");
    git("stash", "push", "-q", "-m", "mystash");

    const r = await getRefs(dir);
    expect(r.head).toEqual({ sha: head, branch: "main" });
    expect(r.branches).toEqual([
      {
        name: "main",
        sha: head,
        current: true,
        upstream: "origin/main",
        ahead: 2,
        behind: 0,
      },
    ]);
    expect(r.remotes).toEqual([{ name: "origin/main", sha: c1 }]);
    expect(r.tags).toContainEqual({ name: "ann", sha: c1 });
    expect(r.tags).toContainEqual({ name: "light", sha: head });
    expect(r.stashes).toHaveLength(1);
    expect(r.stashes[0].name).toBe("stash@{0}");
    expect(r.stashes[0].subject).toContain("mystash");
  });

  it("behind を数える", async () => {
    const c1 = commit("c1", { "a.txt": "1\n" });
    const c2 = commit("c2", { "a.txt": "2\n" });
    git("update-ref", "refs/remotes/origin/main", c2);
    git("config", "remote.origin.url", "/nonexistent");
    git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    git("config", "branch.main.remote", "origin");
    git("config", "branch.main.merge", "refs/heads/main");
    git("reset", "-q", "--hard", c1);
    const r = await getRefs(dir);
    expect(r.branches[0]).toMatchObject({ ahead: 0, behind: 1 });
  });

  it("detached は branch が null", async () => {
    const c1 = commit("c1", { "a.txt": "1\n" });
    git("checkout", "-q", "--detach", c1);
    const r = await getRefs(dir);
    expect(r.head).toEqual({ sha: c1, branch: null });
    expect(r.branches[0].current).toBe(false);
  });

  it("unborn は sha が null で branch 名だけ入る", async () => {
    const r = await getRefs(dir);
    expect(r.head).toEqual({ sha: null, branch: "main" });
    expect(r.branches).toEqual([]);
  });
});

describe("getStatus", () => {
  it("ステージ済み・未ステージ・未追跡・リネーム", async () => {
    commit("c1", {
      "a.txt": "a\n",
      "b.txt": "b\nb\nb\nb\n",
      "keep.txt": "k\n",
    });
    write("a.txt", "a\nmore\n");
    git("add", "a.txt");
    write("keep.txt", "k\nchanged\n");
    git("mv", "b.txt", "renamed.txt");
    write("new dir/日本語.txt", "u\n");

    const s = await getStatus(dir);
    expect(s.staged).toContainEqual({
      path: "a.txt",
      status: "M",
      added: 1,
      removed: 0,
    });
    expect(s.staged).toContainEqual({
      path: "renamed.txt",
      oldPath: "b.txt",
      status: "R",
      added: 0,
      removed: 0,
    });
    expect(s.unstaged).toEqual([
      { path: "keep.txt", status: "M", added: 1, removed: 0 },
    ]);
    expect(s.untracked).toEqual([
      { path: "new dir/日本語.txt", status: "?", added: null, removed: null },
    ]);
  });

  it("unborn でも動く", async () => {
    write("a.txt", "a\n");
    write("b.txt", "b\n");
    git("add", "a.txt");
    const s = await getStatus(dir);
    expect(s.staged).toEqual([
      { path: "a.txt", status: "A", added: 1, removed: 0 },
    ]);
    expect(s.untracked.map(f => f.path)).toEqual(["b.txt"]);
    expect(s.unstaged).toEqual([]);
  });
});

describe("競合 (unmerged)", () => {
  it("getStatusは競合したパスを未ステージに1回だけUで出す", async () => {
    makeConflict();
    const s = await getStatus(dir);
    expect(s.staged).toEqual([]);
    expect(s.unstaged).toEqual([
      { path: "c.txt", status: "U", added: null, removed: null },
    ]);
    expect(s.untracked).toEqual([]);
  });

  it("getFileDiffはours (ステージ2) と作業ツリーの差を返す", async () => {
    makeConflict();
    for (const kind of ["staged", "unstaged"] as const) {
      const d = await getFileDiff(dir, { kind }, "c.txt");
      expect(d.oldContent).toBe("ours\n");
      expect(d.newContent).toContain("<<<<<<<");
      expect(d.newContent).toContain("theirs\n");
      expect(d.binary).toBe(false);
    }
  });

  it("oursが無い競合 (こちらで削除) はbase (ステージ1) をoldにする", async () => {
    commit("base", { "c.txt": "base\n" });
    git("checkout", "-q", "-b", "side");
    commit("theirs", { "c.txt": "theirs\n" });
    git("checkout", "-q", "main");
    git("rm", "-q", "c.txt");
    git("commit", "-q", "-m", "ours deletes");
    gitQuiet("merge", "side");

    const s = await getStatus(dir);
    expect(s.staged).toEqual([]);
    expect(s.unstaged.map(f => [f.path, f.status])).toEqual([["c.txt", "U"]]);
    expect(await getFileDiff(dir, { kind: "unstaged" }, "c.txt")).toMatchObject(
      { oldContent: "base\n", newContent: "theirs\n" }
    );
  });

  it("両方で追加した競合 (baseが無い) でも投げない", async () => {
    commit("base", { "keep.txt": "k\n" });
    git("checkout", "-q", "-b", "side");
    commit("theirs", { "n.txt": "theirs\n" });
    git("checkout", "-q", "main");
    commit("ours", { "n.txt": "ours\n" });
    gitQuiet("merge", "side");
    expect(await getFileDiff(dir, { kind: "staged" }, "n.txt")).toMatchObject({
      oldContent: "ours\n",
    });
  });
});

describe("シンボリックリンク", () => {
  const relink = (rel: string, target: string) => {
    fs.rmSync(path.join(dir, rel), { force: true });
    fs.symlinkSync(target, path.join(dir, rel));
  };

  it("追跡中のリンクの行き先を変えると、差分は古い行き先と新しい行き先", async () => {
    write("one.txt", "ONE CONTENT\n");
    write("two.txt", "TWO CONTENT\n");
    fs.symlinkSync("one.txt", path.join(dir, "link"));
    commit("c1");
    relink("link", "two.txt");

    expect(await getFileDiff(dir, { kind: "unstaged" }, "link")).toMatchObject({
      oldContent: "one.txt",
      newContent: "two.txt",
      binary: false,
      tooLarge: false,
    });
  });

  it("未追跡の切れたリンクは、行き先の文字列をnewにする", async () => {
    commit("c1", { "a.txt": "a\n" });
    fs.symlinkSync("no/such/target", path.join(dir, "dangling"));
    expect(
      await getFileDiff(dir, { kind: "untracked" }, "dangling")
    ).toMatchObject({ oldContent: "", newContent: "no/such/target" });
  });

  it("worktreeの外を指すリンクも、たどらずに行き先だけを返す", async () => {
    commit("c1", { "a.txt": "a\n" });
    fs.symlinkSync("/etc/hostname", path.join(dir, "out"));
    expect(await getFileDiff(dir, { kind: "untracked" }, "out")).toMatchObject({
      oldContent: "",
      newContent: "/etc/hostname",
    });
  });

  it("worktreeの外へ出るディレクトリのリンク越しには読まない", async () => {
    commit("c1", { "a.txt": "a\n" });
    const outside = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "ark-gv-out-"))
    );
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
      fs.symlinkSync(outside, path.join(dir, "esc"));
      await expect(
        getFileDiff(dir, { kind: "untracked" }, "esc/secret.txt")
      ).rejects.toThrow();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("getCommit", () => {
  it("ルートコミット", async () => {
    const c1 = commit("root subject\n\nbody line", {
      "a.txt": "a\nb\n",
      "bin.dat": Buffer.from([0, 1, 2, 0]),
    });
    const r = await getCommit(dir, c1);
    expect(r.commit.sha).toBe(c1);
    expect(r.commit.subject).toBe("root subject");
    expect(r.commit.body).toBe("body line");
    expect(r.commit.parents).toEqual([]);
    expect(r.commit.committerName).toBe("T");
    expect(r.commit.committerTime).toBeGreaterThan(0);
    expect(r.commit.refs).toContainEqual({ kind: "head", name: "main" });
    expect(r.files).toContainEqual({
      path: "a.txt",
      status: "A",
      added: 2,
      removed: 0,
    });
    expect(r.files).toContainEqual({
      path: "bin.dat",
      status: "A",
      added: null,
      removed: null,
    });
  });

  it("通常コミットと短縮 sha", async () => {
    commit("c1", { "a.txt": "a\nb\n" });
    const c2 = commit("c2", { "a.txt": "a\nB\nc\n" });
    const r = await getCommit(dir, c2.slice(0, 8));
    expect(r.commit.sha).toBe(c2);
    expect(r.files).toEqual([
      { path: "a.txt", status: "M", added: 2, removed: 1 },
    ]);
  });

  it("マージは第 1 親との差", async () => {
    commit("c1", { "a.txt": "1\n" });
    git("checkout", "-q", "-b", "feat");
    commit("c2", { "b.txt": "b\n" });
    git("checkout", "-q", "main");
    commit("c3", { "c.txt": "c\n" });
    git("merge", "-q", "--no-ff", "-m", "merge", "feat");
    const m = git("rev-parse", "HEAD");
    const r = await getCommit(dir, m);
    expect(r.commit.parents).toHaveLength(2);
    expect(r.files.map(f => f.path)).toEqual(["b.txt"]);
  });

  it("不正・存在しない sha は投げる", async () => {
    commit("c1", { "a.txt": "1\n" });
    await expect(getCommit(dir, "--all")).rejects.toThrow();
    await expect(getCommit(dir, "deadbeef")).rejects.toThrow();
  });
});

describe("getFileDiff", () => {
  it("commit: 追加・変更・削除・リネーム", async () => {
    commit("c1", { "m.txt": "old\n", "d.txt": "gone\n", "r.txt": "same\n" });
    git("mv", "r.txt", "r2.txt");
    write("m.txt", "new\n");
    write("n.txt", "added\n");
    git("rm", "-q", "d.txt");
    const c2 = commit("c2");

    expect(
      await getFileDiff(dir, { kind: "commit", sha: c2 }, "m.txt")
    ).toEqual({
      oldContent: "old\n",
      newContent: "new\n",
      binary: false,
      tooLarge: false,
    });
    expect(
      await getFileDiff(dir, { kind: "commit", sha: c2 }, "n.txt")
    ).toMatchObject({ oldContent: "", newContent: "added\n" });
    expect(
      await getFileDiff(dir, { kind: "commit", sha: c2 }, "d.txt")
    ).toMatchObject({ oldContent: "gone\n", newContent: "" });
    expect(
      await getFileDiff(dir, { kind: "commit", sha: c2 }, "r2.txt", "r.txt")
    ).toMatchObject({ oldContent: "same\n", newContent: "same\n" });
  });

  it("commit: 存在しない sha は投げる (空同士の差を返さない)", async () => {
    commit("c1", { "a.txt": "a\n" });
    await expect(
      getFileDiff(dir, { kind: "commit", sha: "deadbeef" }, "a.txt")
    ).rejects.toThrow("コミットが見つかりません");
  });

  it("commit: ルートコミットは old が空", async () => {
    const c1 = commit("c1", { "a.txt": "a\n" });
    expect(
      await getFileDiff(dir, { kind: "commit", sha: c1 }, "a.txt")
    ).toMatchObject({ oldContent: "", newContent: "a\n" });
  });

  it("staged / unstaged / untracked", async () => {
    commit("c1", { "a.txt": "head\n", "gone.txt": "g\n" });
    write("a.txt", "index\n");
    git("add", "a.txt");
    write("a.txt", "worktree\n");
    write("u.txt", "untracked\n");
    fs.rmSync(path.join(dir, "gone.txt"));

    expect(await getFileDiff(dir, { kind: "staged" }, "a.txt")).toMatchObject({
      oldContent: "head\n",
      newContent: "index\n",
    });
    expect(await getFileDiff(dir, { kind: "unstaged" }, "a.txt")).toMatchObject(
      {
        oldContent: "index\n",
        newContent: "worktree\n",
      }
    );
    // 作業ツリーから消えたファイルは new が空
    expect(
      await getFileDiff(dir, { kind: "unstaged" }, "gone.txt")
    ).toMatchObject({
      oldContent: "g\n",
      newContent: "",
    });
    expect(
      await getFileDiff(dir, { kind: "untracked" }, "u.txt")
    ).toMatchObject({
      oldContent: "",
      newContent: "untracked\n",
    });
  });

  it("unborn の staged は old が空", async () => {
    write("a.txt", "a\n");
    git("add", "a.txt");
    expect(await getFileDiff(dir, { kind: "staged" }, "a.txt")).toMatchObject({
      oldContent: "",
      newContent: "a\n",
    });
  });

  it("バイナリは内容を返さない", async () => {
    const c1 = commit("c1", { "b.bin": Buffer.from([1, 0, 2]) });
    expect(
      await getFileDiff(dir, { kind: "commit", sha: c1 }, "b.bin")
    ).toEqual({
      oldContent: "",
      newContent: "",
      binary: true,
      tooLarge: false,
    });
    write("w.bin", Buffer.from([0, 0]));
    expect(
      await getFileDiff(dir, { kind: "untracked" }, "w.bin")
    ).toMatchObject({
      binary: true,
    });
  });

  it("2MB 超は tooLarge", async () => {
    const big = "x".repeat(2 * 1024 * 1024 + 1);
    const c1 = commit("c1", { "big.txt": big });
    expect(
      await getFileDiff(dir, { kind: "commit", sha: c1 }, "big.txt")
    ).toEqual({
      oldContent: "",
      newContent: "",
      binary: false,
      tooLarge: true,
    });
    expect(
      await getFileDiff(dir, { kind: "untracked" }, "big.txt")
    ).toMatchObject({
      tooLarge: true,
    });
  });

  it("不正なパス・sha は投げる", async () => {
    commit("c1", { "a.txt": "a\n" });
    await expect(
      getFileDiff(dir, { kind: "untracked" }, "../x")
    ).rejects.toThrow();
    await expect(
      getFileDiff(dir, { kind: "staged" }, "a.txt", "--output=x")
    ).rejects.toThrow();
    await expect(
      getFileDiff(dir, { kind: "commit", sha: "--all" }, "a.txt")
    ).rejects.toThrow();
  });
});

describe("getFingerprint", () => {
  it("コミット・追跡ファイルの編集で変わり、何も無ければ安定", async () => {
    commit("c1", { "a.txt": "a\n" });
    const f1 = await getFingerprint(dir);
    expect(await getFingerprint(dir)).toBe(f1);
    write("a.txt", "edited\n");
    const f2 = await getFingerprint(dir);
    expect(f2).not.toBe(f1);
    commit("c2");
    const f3 = await getFingerprint(dir);
    expect(f3).not.toBe(f2);
    git("tag", "t");
    expect(await getFingerprint(dir)).not.toBe(f3);
  });

  it("既に変更済みのファイルをもう一度編集すると変わる", async () => {
    commit("c1", { "a.txt": "a\n" });
    write("a.txt", "edited\n");
    const f1 = await getFingerprint(dir);
    expect(await getFingerprint(dir)).toBe(f1);
    // 長さを変える (mtimeの粒度に頼らない)
    write("a.txt", "edited once more\n");
    expect(await getFingerprint(dir)).not.toBe(f1);
  });

  it("未追跡のファイルを編集すると変わる。未追跡のディレクトリに足しても変わる", async () => {
    commit("c1", { "a.txt": "a\n" });
    write("new/u.txt", "u\n");
    const f1 = await getFingerprint(dir);
    write("new/u.txt", "u longer\n");
    const f2 = await getFingerprint(dir);
    expect(f2).not.toBe(f1);
    write("new/v.txt", "v\n");
    expect(await getFingerprint(dir)).not.toBe(f2);
  });

  it("別の内容をステージし直すと変わる", async () => {
    commit("c1", { "a.txt": "a\n" });
    write("a.txt", "staged one\n");
    git("add", "a.txt");
    const f1 = await getFingerprint(dir);
    expect(await getFingerprint(dir)).toBe(f1);
    write("a.txt", "staged two\n");
    git("add", "a.txt");
    expect(await getFingerprint(dir)).not.toBe(f1);
  });

  it("同じコミットを指す別のブランチへ切り替えると変わる", async () => {
    commit("c1", { "a.txt": "a\n" });
    git("branch", "other");
    const f1 = await getFingerprint(dir);
    git("checkout", "-q", "other");
    const f2 = await getFingerprint(dir);
    expect(f2).not.toBe(f1);
    // detachedにしても変わる
    git("checkout", "-q", "--detach");
    expect(await getFingerprint(dir)).not.toBe(f2);
  });

  it("作業ツリーから消したファイルがあっても返り、安定している", async () => {
    commit("c1", { "a.txt": "a\n", "b.txt": "b\n" });
    fs.rmSync(path.join(dir, "a.txt"));
    const f1 = await getFingerprint(dir);
    expect(f1).toMatch(/^[0-9a-f]{64}$/);
    expect(await getFingerprint(dir)).toBe(f1);
  });

  it("unborn でも返る", async () => {
    expect(await getFingerprint(dir)).toMatch(/^[0-9a-f]{64}$/);
  });
});
