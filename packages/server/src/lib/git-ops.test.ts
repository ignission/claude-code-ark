import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertBranchName,
  createBranch,
  deleteBranch,
  deleteRemoteBranch,
  describeStderr,
  fetchAll,
  GitOpError,
  pullFastForward,
  pushBranch,
  renameBranch,
  sourceOfTrackingRef,
} from "./git-ops.js";

let root: string;
/** 操作する worktree */
let dir: string;
/** リモート役の bare リポジトリ */
let bare: string;

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();
}
const git = (...args: string[]) => gitIn(dir, ...args);

function commitIn(cwd: string, msg: string, file = "a.txt") {
  fs.writeFileSync(path.join(cwd, file), `${msg}\n`);
  gitIn(cwd, "add", "-A");
  gitIn(cwd, "commit", "-q", "-m", msg);
  return gitIn(cwd, "rev-parse", "HEAD");
}
const commit = (msg: string) => commitIn(dir, msg);

const hasRef = (ref: string, cwd = dir) => {
  try {
    gitIn(cwd, "rev-parse", "--verify", "-q", ref);
    return true;
  } catch {
    return false;
  }
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ark-go-")));
  dir = path.join(root, "work");
  bare = path.join(root, "remote.git");
  fs.mkdirSync(dir);
  gitIn(root, "init", "-q", "--bare", "-b", "main", bare);
  git("init", "-q", "-b", "main");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", bare);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("describeStderr", () => {
  it("push の拒否の行を、To の行より先に取る", () => {
    const stderr = [
      "To /tmp/remote.git",
      " ! [rejected]        main -> main (fetch first)",
      "error: failed to push some refs to '/tmp/remote.git'",
      "hint: Updates were rejected because the remote contains work",
    ].join("\n");
    expect(describeStderr(stderr)).toBe(
      "! [rejected]        main -> main (fetch first) / error: failed to push some refs to '/tmp/remote.git'"
    );
  });
  it("理由の行が無ければ hint 以外の最初の行", () => {
    expect(describeStderr("hint: x\nsomething went wrong\n")).toBe(
      "something went wrong"
    );
    expect(describeStderr("")).toBe("");
  });
});

describe("sourceOfTrackingRef", () => {
  it("refspec を逆にたどる", () => {
    const std = ["+refs/heads/*:refs/remotes/origin/*"];
    expect(sourceOfTrackingRef("refs/remotes/origin/feat/x", std)).toBe(
      "refs/heads/feat/x"
    );
    expect(
      sourceOfTrackingRef("refs/remotes/origin/review/topic", [
        "+refs/heads/*:refs/remotes/origin/review/*",
      ])
    ).toBe("refs/heads/topic");
    expect(
      sourceOfTrackingRef("refs/remotes/origin/main", [
        "+refs/heads/main:refs/remotes/origin/main",
      ])
    ).toBe("refs/heads/main");
    expect(
      sourceOfTrackingRef("refs/remotes/origin/x", [
        "^refs/heads/x",
        "+refs/heads/main:refs/remotes/origin/main",
      ])
    ).toBeNull();
  });
});

describe("assertBranchName", () => {
  it("正しい名前を通し、不正な名前を日本語で断る", async () => {
    commit("c1");
    await expect(assertBranchName(dir, "feat/x")).resolves.toBe("feat/x");
    for (const bad of ["", " ", "-x", "a..b", "a b", "a~1", "@{-1}", 1]) {
      await expect(assertBranchName(dir, bad)).rejects.toThrow(GitOpError);
    }
  });
});

describe("createBranch / renameBranch", () => {
  it("sha から作り、チェックアウトはしない", async () => {
    const c1 = commit("c1");
    commit("c2");
    await createBranch(dir, "topic", c1);
    expect(git("rev-parse", "topic")).toBe(c1);
    expect(git("symbolic-ref", "--short", "HEAD")).toBe("main");
  });

  it("既にある名前・不正な起点は断る", async () => {
    const c1 = commit("c1");
    await expect(createBranch(dir, "main", c1)).rejects.toThrow("既にあります");
    await expect(createBranch(dir, "x", "--all")).rejects.toThrow("起点");
  });

  it("名前を変える。いまのブランチも変えられる", async () => {
    commit("c1");
    git("branch", "old");
    await renameBranch(dir, "old", "new");
    expect(hasRef("refs/heads/old")).toBe(false);
    expect(hasRef("refs/heads/new")).toBe(true);
    await renameBranch(dir, "main", "trunk");
    expect(git("symbolic-ref", "--short", "HEAD")).toBe("trunk");
  });

  it("無いブランチ・既にある名前へは変えない", async () => {
    commit("c1");
    git("branch", "a");
    await expect(renameBranch(dir, "nope", "b")).rejects.toThrow(
      "見つかりません"
    );
    await expect(renameBranch(dir, "a", "main")).rejects.toThrow(
      "既にあります"
    );
  });
});

describe("deleteBranch", () => {
  it("HEAD に取り込み済みなら消し、消す前の sha を返す", async () => {
    const c1 = commit("c1");
    git("branch", "done");
    commit("c2");
    await expect(deleteBranch(dir, "done", false)).resolves.toEqual({
      sha: c1,
    });
    expect(hasRef("refs/heads/done")).toBe(false);
  });

  it("どこにも取り込まれていなければ notMerged で断り、force なら消す", async () => {
    commit("c1");
    git("checkout", "-q", "-b", "wip");
    const wip = commit("wip");
    git("checkout", "-q", "main");
    const err = await deleteBranch(dir, "wip", false).catch(e => e);
    expect(err).toBeInstanceOf(GitOpError);
    expect(err.notMerged).toBe(true);
    expect(hasRef("refs/heads/wip")).toBe(true);
    await expect(deleteBranch(dir, "wip", true)).resolves.toEqual({ sha: wip });
    expect(hasRef("refs/heads/wip")).toBe(false);
  });

  it("消す前の追跡先を返し、それを渡して作り直すと追跡先も戻る", async () => {
    commit("c1");
    git("checkout", "-q", "-b", "topic");
    commit("t");
    git("push", "-q", "origin", "topic:release");
    git("branch", "--set-upstream-to=origin/release");
    git("checkout", "-q", "main");
    const res = await deleteBranch(dir, "topic", false);
    expect(res.upstream).toEqual({
      remote: "origin",
      merge: "refs/heads/release",
    });
    expect(() => git("config", "--get", "branch.topic.remote")).toThrow();
    await createBranch(dir, "topic", res.sha, res.upstream);
    expect(git("rev-parse", "--abbrev-ref", "topic@{upstream}")).toBe(
      "origin/release"
    );
  });

  it("作り直すときの追跡先: 形が不正なら断り、リモートが無ければ追跡先なしで作る", async () => {
    const c1 = commit("c1");
    await expect(
      createBranch(dir, "x", c1, { remote: "origin", merge: "x" })
    ).rejects.toThrow("追跡先が不正です");
    expect(hasRef("refs/heads/x")).toBe(false);
    await createBranch(dir, "y", c1, { remote: "gone", merge: "refs/heads/y" });
    expect(hasRef("refs/heads/y")).toBe(true);
    expect(() => git("config", "--get", "branch.y.remote")).toThrow();
  });

  it("リモートのブランチに取り込まれていれば消せる", async () => {
    commit("c1");
    git("checkout", "-q", "-b", "pushed");
    commit("p");
    git("push", "-q", "origin", "pushed");
    git("checkout", "-q", "main");
    await expect(deleteBranch(dir, "pushed", false)).resolves.toBeDefined();
  });

  it("rebase の途中のブランチは消さない (HEAD が detached でも)", async () => {
    commit("c1");
    git("checkout", "-q", "-b", "feat");
    fs.writeFileSync(path.join(dir, "a.txt"), "feat\n");
    git("commit", "-qam", "feat");
    git("checkout", "-q", "main");
    fs.writeFileSync(path.join(dir, "a.txt"), "main\n");
    git("commit", "-qam", "main");
    git("checkout", "-q", "feat");
    expect(() => git("rebase", "main")).toThrow();
    await expect(deleteBranch(dir, "feat", true)).rejects.toThrow(GitOpError);
    expect(hasRef("refs/heads/feat")).toBe(true);
  });

  it("いまのブランチと、別の worktree で使っているブランチは消さない", async () => {
    commit("c1");
    await expect(deleteBranch(dir, "main", true)).rejects.toThrow("使用中");
    const other = path.join(root, "other");
    git("worktree", "add", "-q", "-b", "side", other);
    await expect(deleteBranch(dir, "side", true)).rejects.toThrow("使用中");
    expect(hasRef("refs/heads/side")).toBe(true);
  });
});

describe("リモート", () => {
  it("upstream の無いブランチは origin へ push して upstream にする", async () => {
    commit("c1");
    await expect(pushBranch(dir, "main")).resolves.toEqual({
      remote: "origin",
      remoteBranch: "main",
    });
    expect(git("rev-parse", "--abbrev-ref", "main@{upstream}")).toBe(
      "origin/main"
    );
    // いまのブランチでなくても push できる
    git("branch", "topic");
    await pushBranch(dir, "topic");
    expect(hasRef("refs/heads/topic", bare)).toBe(true);
  });

  it("upstream があればその名前へ push する", async () => {
    commit("c1");
    git("push", "-q", "origin", "main:release");
    git("branch", "--set-upstream-to=origin/release", "main");
    const c2 = commit("c2");
    await expect(pushBranch(dir, "main")).resolves.toEqual({
      remote: "origin",
      remoteBranch: "release",
    });
    expect(gitIn(bare, "rev-parse", "release")).toBe(c2);
  });

  it("追跡先が fetch の refspec の外にあっても、設定の追跡先へ push する", async () => {
    commit("c1");
    git("push", "-q", "origin", "main", "main:release");
    git(
      "config",
      "remote.origin.fetch",
      "+refs/heads/main:refs/remotes/origin/main"
    );
    git("branch", "topic");
    git("config", "branch.topic.remote", "origin");
    git("config", "branch.topic.merge", "refs/heads/release");
    git("checkout", "-q", "topic");
    const t = commit("t");
    await expect(pushBranch(dir, "topic")).resolves.toEqual({
      remote: "origin",
      remoteBranch: "release",
    });
    expect(gitIn(bare, "rev-parse", "release")).toBe(t);
    expect(hasRef("refs/heads/topic", bare)).toBe(false);
    expect(git("config", "--get", "branch.topic.merge")).toBe(
      "refs/heads/release"
    );
  });

  it("ローカルのブランチを追っているブランチは、追跡先を変えずに push する", async () => {
    commit("c1");
    git("branch", "--track", "child", "main");
    await pushBranch(dir, "child");
    expect(hasRef("refs/heads/child", bare)).toBe(true);
    expect(git("config", "--get", "branch.child.remote")).toBe(".");
  });

  it("fast-forward できない push は失敗を返す (force しない)", async () => {
    commit("c1");
    await pushBranch(dir, "main");
    // 別の clone から先に進める
    const other = path.join(root, "clone");
    gitIn(root, "clone", "-q", bare, other);
    gitIn(other, "config", "commit.gpgsign", "false");
    const theirs = commitIn(other, "theirs", "b.txt");
    gitIn(other, "push", "-q", "origin", "main");
    commit("ours");
    await expect(pushBranch(dir, "main")).rejects.toThrow("[rejected]");
    expect(gitIn(bare, "rev-parse", "main")).toBe(theirs);
  });

  it("fetch で取り込み、pull は fast-forward だけで進める", async () => {
    commit("c1");
    await pushBranch(dir, "main");
    const other = path.join(root, "clone");
    gitIn(root, "clone", "-q", bare, other);
    gitIn(other, "config", "commit.gpgsign", "false");
    const theirs = commitIn(other, "theirs", "b.txt");
    gitIn(other, "push", "-q", "origin", "main");

    await fetchAll(dir);
    expect(git("rev-parse", "origin/main")).toBe(theirs);
    await pullFastForward(dir);
    expect(git("rev-parse", "HEAD")).toBe(theirs);

    // 分岐したら pull は断る (マージコミットを作らない)
    const more = commitIn(other, "more", "b.txt");
    gitIn(other, "push", "-q", "origin", "main");
    const ours = commit("ours");
    await expect(pullFastForward(dir)).rejects.toThrow(GitOpError);
    expect(git("rev-parse", "HEAD")).toBe(ours);
    expect(more).not.toBe(ours);
  });

  it("merge.autostash が有効でも、ローカルの変更とぶつかる pull は断る", async () => {
    commit("c1");
    await pushBranch(dir, "main");
    const other = path.join(root, "clone");
    gitIn(root, "clone", "-q", bare, other);
    gitIn(other, "config", "commit.gpgsign", "false");
    commitIn(other, "theirs");
    gitIn(other, "push", "-q", "origin", "main");
    git("config", "merge.autostash", "true");
    fs.writeFileSync(path.join(dir, "a.txt"), "local edit\n");
    const before = git("rev-parse", "HEAD");
    await expect(pullFastForward(dir)).rejects.toThrow(GitOpError);
    expect(git("rev-parse", "HEAD")).toBe(before);
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe(
      "local edit\n"
    );
    expect(git("diff", "--name-only", "--diff-filter=U")).toBe("");
  });

  it("mergeOptions に --squash があっても、pull は HEAD を進める", async () => {
    commit("c1");
    await pushBranch(dir, "main");
    const other = path.join(root, "clone");
    gitIn(root, "clone", "-q", bare, other);
    gitIn(other, "config", "commit.gpgsign", "false");
    const theirs = commitIn(other, "theirs", "b.txt");
    gitIn(other, "push", "-q", "origin", "main");
    git("config", "branch.main.mergeOptions", "--squash");
    await pullFastForward(dir);
    expect(git("rev-parse", "HEAD")).toBe(theirs);
    expect(git("status", "--porcelain")).toBe("");
  });

  it("認証を求められても askpass を呼ばずに失敗する (core.askPass があっても)", async () => {
    commit("c1");
    // 常に 401 を返す HTTP のリモート
    const server = http.createServer((_req, res) => {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="x"' });
      res.end();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      const marker = path.join(root, "askpass-called");
      const askpass = path.join(root, "askpass.sh");
      fs.writeFileSync(askpass, `#!/bin/sh\ntouch "${marker}"\necho x\n`, {
        mode: 0o755,
      });
      git("config", "core.askPass", askpass);
      git("config", "credential.helper", "");
      git("remote", "set-url", "origin", `http://127.0.0.1:${port}/x.git`);
      await expect(fetchAll(dir)).rejects.toThrow(GitOpError);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      server.close();
    }
  });

  it("利用者の core.sshCommand を使い、端末から切り離して動かす", async () => {
    commit("c1");
    git("remote", "set-url", "origin", "ssh://example.invalid/x.git");
    const out = path.join(root, "ssh-result");
    const fake = path.join(root, "fake-ssh.sh");
    fs.writeFileSync(
      fake,
      `#!/bin/sh\n( exec 3</dev/tty ) 2>/dev/null && echo has-tty > "${out}" || echo no-tty > "${out}"\nexit 1\n`,
      { mode: 0o755 }
    );
    git("config", "core.sshCommand", fake);
    await expect(fetchAll(dir)).rejects.toThrow(GitOpError);
    expect(fs.readFileSync(out, "utf8").trim()).toBe("no-tty");
  });

  it("detached では pull しない", async () => {
    const c1 = commit("c1");
    git("checkout", "-q", "--detach", c1);
    await expect(pullFastForward(dir)).rejects.toThrow("ブランチにいない");
  });

  it("fetch --prune で消えたリモートのブランチを片付ける", async () => {
    commit("c1");
    git("push", "-q", "origin", "main", "main:gone");
    await fetchAll(dir);
    gitIn(bare, "branch", "-D", "gone");
    await fetchAll(dir);
    expect(hasRef("refs/remotes/origin/gone")).toBe(false);
  });

  it("リモートのブランチを消す。既定のブランチと知らないリモートは断る", async () => {
    commit("c1");
    git("push", "-q", "origin", "main", "main:topic");
    await fetchAll(dir);
    git("remote", "set-head", "origin", "main");

    await deleteRemoteBranch(dir, "origin", "origin/topic");
    expect(hasRef("refs/heads/topic", bare)).toBe(false);
    expect(hasRef("refs/remotes/origin/topic")).toBe(false);

    await expect(
      deleteRemoteBranch(dir, "origin", "origin/main")
    ).rejects.toThrow("既定のブランチ");
    await expect(
      deleteRemoteBranch(dir, "--upload-pack=x", "--upload-pack=x/topic")
    ).rejects.toThrow("リモートが見つかりません");
    // 別のリモートの追跡ブランチは指せない
    await expect(
      deleteRemoteBranch(dir, "origin", "other/main")
    ).rejects.toThrow("不正です");
    expect(hasRef("refs/heads/main", bare)).toBe(true);
  });

  it("- で始まるリモートの名前でも push とリモートの削除ができる", async () => {
    commit("c1");
    git("remote", "remove", "origin");
    git("remote", "add", "--", "-dash", bare);
    await expect(pushBranch(dir, "main")).resolves.toEqual({
      remote: "-dash",
      remoteBranch: "main",
    });
    git("push", "-q", "--", "-dash", "main:topic");
    await fetchAll(dir);
    await deleteRemoteBranch(dir, "-dash", "-dash/topic");
    expect(hasRef("refs/heads/topic", bare)).toBe(false);
  });

  it("fetch の refspec をたどって、追跡ブランチの元のブランチを消す", async () => {
    commit("c1");
    git("push", "-q", "origin", "main", "main:topic", "main:review/topic");
    git(
      "config",
      "remote.origin.fetch",
      "+refs/heads/*:refs/remotes/origin/review/*"
    );
    await fetchAll(dir);
    // origin/review/topic の元は topic (review/topic ではない)
    await deleteRemoteBranch(dir, "origin", "origin/review/topic");
    expect(hasRef("refs/heads/topic", bare)).toBe(false);
    expect(hasRef("refs/heads/review/topic", bare)).toBe(true);
  });

  it("手元に origin/HEAD が無くても、リモートの HEAD が指すブランチは消さない", async () => {
    commit("c1");
    git("push", "-q", "origin", "main");
    await fetchAll(dir);
    // 新しい git は fetch で origin/HEAD を作る (remote.<name>.followRemoteHEAD)。消しておく
    git("remote", "set-head", "origin", "--delete");
    expect(hasRef("refs/remotes/origin/HEAD")).toBe(false);
    await expect(
      deleteRemoteBranch(dir, "origin", "origin/main")
    ).rejects.toThrow("既定のブランチ");
    expect(hasRef("refs/heads/main", bare)).toBe(true);
  });

  it("fetch の設定でたどれない追跡ブランチは消さない", async () => {
    commit("c1");
    git("push", "-q", "origin", "main", "main:topic");
    git("update-ref", "refs/remotes/origin/stray", git("rev-parse", "HEAD"));
    git(
      "config",
      "remote.origin.fetch",
      "+refs/heads/main:refs/remotes/origin/main"
    );
    await expect(
      deleteRemoteBranch(dir, "origin", "origin/stray")
    ).rejects.toThrow("特定できません");
  });

  it("リモートの無いリポジトリで push すると理由を返す", async () => {
    git("remote", "remove", "origin");
    commit("c1");
    await expect(pushBranch(dir, "main")).rejects.toThrow(
      "リモートがありません"
    );
  });
});
