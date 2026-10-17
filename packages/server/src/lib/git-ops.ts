/**
 * Git タブの書き込み操作: ブランチの作成・名前変更・削除と、fetch / pull / push、
 * リモートのブランチの削除。読み取りは git-view.ts にあり、こちらは ref を書く。
 *
 * - 作業ツリーを書き換えるのは pull だけで、それも --ff-only に限る (競合や
 *   マージコミットを作らない。ローカルの変更とぶつかるなら git が断る)
 * - リモートの操作は認証の入力を待って固まらないよう、端末から切り離し、
 *   git と ssh のプロンプトを切る。時間がかかるので、読み取りより長い timeout を取る
 * - 引数に入るユーザー入力は、ブランチ名を check-ref-format で、リモート名を
 *   `git remote` の一覧で確かめてから渡す。名前の前には `--` を置く
 */

import { execFile, spawn } from "node:child_process";
import { isValidSha } from "./git-view.js";

const LOCAL_TIMEOUT_MS = 10_000;
export const REMOTE_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 4 * 1024 * 1024;

export class GitOpError extends Error {
  constructor(
    message: string,
    /** 未マージのブランチを -d 相当で消そうとした (強制なら消せる) */
    readonly notMerged = false
  ) {
    super(message);
  }
}

interface RunOptions {
  remote?: boolean;
}

interface RunResult {
  stdout: string;
  stderr: string;
}

function remoteEnv(): NodeJS.ProcessEnv {
  return {
    GIT_TERMINAL_PROMPT: "0",
    // 認証の情報を GUI の askpass でも聞かない。GIT_ASKPASS は core.askPass より
    // 優先される。credential helper は askpass より先に引かれるので、保存済みの
    // 認証はそのまま使える
    GIT_ASKPASS: "false",
    SSH_ASKPASS_REQUIRE: "never",
  };
}

function runGit(
  cwd: string,
  args: string[],
  opts: RunOptions = {}
): Promise<RunResult> {
  const remote = opts.remote === true;
  return new Promise((resolve, reject) => {
    // execFile は detached を spawn へ渡さないので、spawn で起こす。
    // リモートの操作は端末から切り離す (新しいセッションにする)。ssh は端末が無いと
    // パスフレーズやホスト鍵の確認を聞けずに失敗する。GIT_SSH_COMMAND で BatchMode を
    // 足す方法は、利用者の core.sshCommand を上書きしてしまう
    const child = spawn("git", ["-c", "core.quotepath=off", ...args], {
      cwd,
      detached: remote,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C", ...(remote ? remoteEnv() : {}) },
    });
    let stdout = "";
    let stderr = "";
    let size = 0;
    let failure: GitOpError | null = null;
    const kill = (err: GitOpError) => {
      failure ??= err;
      try {
        // detached なら ssh などの子までまとめて止める (プロセスグループごと)
        if (remote && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // 既に終わっている
      }
    };
    const collect = (append: (text: string) => void) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BUFFER)
        return kill(new GitOpError("git の出力が大きすぎます"));
      append(chunk.toString("utf8"));
    };
    child.stdout.on(
      "data",
      collect(t => (stdout += t))
    );
    child.stderr.on(
      "data",
      collect(t => (stderr += t))
    );
    const timer = setTimeout(
      () => kill(new GitOpError("git がタイムアウトしました")),
      remote ? REMOTE_TIMEOUT_MS : LOCAL_TIMEOUT_MS
    );
    child.on("error", err => {
      clearTimeout(timer);
      const code = (err as NodeJS.ErrnoException).code;
      reject(
        new GitOpError(
          code === "ENOENT"
            ? "git コマンドが見つかりません"
            : `git の実行に失敗しました: ${err.message}`
        )
      );
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code === 0) return resolve({ stdout, stderr });
      reject(
        new GitOpError(
          `git の実行に失敗しました: ${describeStderr(stderr) || `終了コード ${code}`}`
        )
      );
    });
  });
}

/**
 * stderr から理由の行を取り出す。push の拒否は `To <remote>` の行から始まり、
 * pull は fetch の進み具合から始まるので、先頭の行では理由が分からない。
 * fatal: / error: / 拒否の行を優先し (2 行まで)、無ければ hint: 以外の最初の行
 */
export function describeStderr(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("hint:"));
  const reasons = lines.filter(
    line => /^(fatal|error):/.test(line) || /\[(remote )?rejected\]/.test(line)
  );
  return (reasons.length > 0 ? reasons.slice(0, 2) : lines.slice(0, 1)).join(
    " / "
  );
}

/** 終了コードだけを見たいとき (merge-base --is-ancestor など)。git が無い等は投げる */
function exitCode(cwd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: LOCAL_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C" } },
      err => {
        if (!err) return resolve(0);
        const code = (err as { code?: unknown }).code;
        if (typeof code === "number") return resolve(code);
        reject(new GitOpError(`git の実行に失敗しました: ${err.message}`));
      }
    );
  });
}

// ---- 入力の検証 ----

/**
 * ブランチ名として正しいか。check-ref-format には `--` が無いので、
 * `-` で始まる名前はここで先に弾く (オプションとして読まれる)
 */
export async function assertBranchName(
  cwd: string,
  name: unknown
): Promise<string> {
  if (typeof name !== "string" || name.trim() === "") {
    throw new GitOpError("ブランチ名を入力してください");
  }
  if (name.startsWith("-") || name.includes("\0")) {
    throw new GitOpError(`ブランチ名として使えません: ${name}`);
  }
  // --branch は `@` や `@{-1}` を実在のブランチ名へ展開して通すので、
  // 展開されずにそのまま返ってきた名前だけを受け付ける
  const out = await runGit(cwd, ["check-ref-format", "--branch", name]).catch(
    () => null
  );
  if (out?.stdout.trim() !== name) {
    throw new GitOpError(`ブランチ名として使えません: ${name}`);
  }
  return name;
}

async function listRemotes(cwd: string): Promise<string[]> {
  const { stdout } = await runGit(cwd, ["remote"]);
  return stdout.split("\n").filter(Boolean);
}

async function assertRemote(cwd: string, remote: unknown): Promise<string> {
  if (
    typeof remote !== "string" ||
    !(await listRemotes(cwd)).includes(remote)
  ) {
    throw new GitOpError(`リモートが見つかりません: ${String(remote)}`);
  }
  return remote;
}

async function refSha(cwd: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(cwd, ["rev-parse", "--verify", "-q", ref]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function localBranchExists(cwd: string, name: string): Promise<boolean> {
  return (await refSha(cwd, `refs/heads/${name}`)) !== null;
}

/** ブランチが作業ツリー (このworktree・別のworktree) で使われていればそのパス */
async function checkedOutAt(cwd: string, name: string): Promise<string | null> {
  const { stdout } = await runGit(cwd, [
    "for-each-ref",
    "--format=%(worktreepath)",
    `refs/heads/${name}`,
  ]);
  return stdout.trim() || null;
}

// ---- ローカルのブランチ ----

/** ブランチの追跡先 (`branch.<name>.remote` と `branch.<name>.merge`) */
export interface BranchUpstream {
  remote: string;
  merge: string;
}

async function configValue(cwd: string, key: string): Promise<string | null> {
  const out = await runGit(cwd, ["config", "--get", key]).catch(() => null);
  return out?.stdout.trim() || null;
}

async function readUpstream(
  cwd: string,
  branch: string
): Promise<BranchUpstream | undefined> {
  const [remote, merge] = await Promise.all([
    configValue(cwd, `branch.${branch}.remote`),
    configValue(cwd, `branch.${branch}.merge`),
  ]);
  return remote && merge ? { remote, merge } : undefined;
}

/** 戻すときに受け取った追跡先を確かめる。リモートは設定にあるもの (`.` はローカル) だけ */
async function parseUpstream(
  cwd: string,
  v: unknown
): Promise<BranchUpstream | undefined> {
  if (v === undefined || v === null) return undefined;
  const u = v as Partial<BranchUpstream>;
  if (
    typeof u.remote !== "string" ||
    typeof u.merge !== "string" ||
    !u.merge.startsWith("refs/") ||
    /[\0\n]/.test(u.merge) ||
    (u.remote !== "." && !(await listRemotes(cwd)).includes(u.remote))
  ) {
    throw new GitOpError("追跡先が不正です");
  }
  return { remote: u.remote, merge: u.merge };
}

/**
 * startPoint (sha) から name を作る。チェックアウトはしない。
 * upstream は削除を元に戻すときに渡す (消す前の追跡先を戻す)
 */
export async function createBranch(
  cwd: string,
  name: unknown,
  startPoint: unknown,
  upstream?: unknown
): Promise<void> {
  const branch = await assertBranchName(cwd, name);
  if (!isValidSha(startPoint)) throw new GitOpError("起点のコミットが不正です");
  const track = await parseUpstream(cwd, upstream);
  if (await localBranchExists(cwd, branch)) {
    throw new GitOpError(`ブランチ ${branch} は既にあります`);
  }
  await runGit(cwd, ["branch", "--no-track", "--", branch, startPoint]);
  if (track) {
    await runGit(cwd, [
      "config",
      "--",
      `branch.${branch}.remote`,
      track.remote,
    ]);
    await runGit(cwd, ["config", "--", `branch.${branch}.merge`, track.merge]);
  }
}

export async function renameBranch(
  cwd: string,
  from: unknown,
  to: unknown
): Promise<void> {
  const oldName = await assertBranchName(cwd, from);
  const newName = await assertBranchName(cwd, to);
  if (!(await localBranchExists(cwd, oldName))) {
    throw new GitOpError(`ブランチ ${oldName} が見つかりません`);
  }
  if (await localBranchExists(cwd, newName)) {
    throw new GitOpError(`ブランチ ${newName} は既にあります`);
  }
  await runGit(cwd, ["branch", "-m", "--", oldName, newName]);
}

/**
 * 消しても失われるコミットが無いか。HEAD かいずれかのリモートのブランチから
 * 届くなら、消しても辿り直せる (`git branch -d` の成否は upstream の有無で
 * 変わるので頼らない。git.ts の cleanupLocalBranch と同じ考え)
 */
async function isMerged(cwd: string, name: string): Promise<boolean> {
  const ref = `refs/heads/${name}`;
  const code = await exitCode(cwd, [
    "merge-base",
    "--is-ancestor",
    ref,
    "HEAD",
  ]);
  if (code === 0) return true;
  if (code !== 1)
    throw new GitOpError(`ブランチ ${name} の取り込みを確かめられません`);
  const { stdout } = await runGit(cwd, [
    "for-each-ref",
    "--count=1",
    "--contains",
    ref,
    "--format=%(refname)",
    "refs/remotes",
  ]);
  return stdout.trim() !== "";
}

/**
 * ブランチを消し、消す前の sha と追跡先を返す (元に戻すときに使う)。
 * force でなければ、取り込まれていないブランチは notMerged の失敗で断る。
 * いまのブランチと、別の worktree で使われているブランチは消さない
 */
export async function deleteBranch(
  cwd: string,
  name: unknown,
  force: boolean
): Promise<{ sha: string; upstream?: BranchUpstream }> {
  const branch = await assertBranchName(cwd, name);
  const sha = await refSha(cwd, `refs/heads/${branch}`);
  if (!sha) throw new GitOpError(`ブランチ ${branch} が見つかりません`);
  const at = await checkedOutAt(cwd, branch);
  if (at) {
    throw new GitOpError(`ブランチ ${branch} は作業ツリーで使用中です (${at})`);
  }
  if (!force && !(await isMerged(cwd, branch))) {
    throw new GitOpError(
      `ブランチ ${branch} には、どこにも取り込まれていないコミットがあります`,
      true
    );
  }
  const upstream = await readUpstream(cwd, branch);
  await runGit(cwd, ["branch", "-D", "--", branch]);
  return upstream ? { sha, upstream } : { sha };
}

// ---- リモート ----

export async function fetchAll(cwd: string): Promise<void> {
  await runGit(cwd, ["fetch", "--all", "--prune"], { remote: true });
}

/**
 * いまのブランチを fast-forward だけで進める。作業ツリーを書くのはこの操作だけ。
 * 設定で変わる挙動を引数で打ち消す: merge.autostash はローカルの変更を退避して戻すときに
 * 競合の印を残したまま成功で終わり、branch.<name>.mergeOptions の --squash は HEAD を
 * 進めずに変更をステージする。どちらも fast-forward ではないので切る (ぶつかるなら git に断らせる)
 */
export async function pullFastForward(cwd: string): Promise<void> {
  const { stdout } = await runGit(cwd, [
    "symbolic-ref",
    "-q",
    "--short",
    "HEAD",
  ]).catch(() => ({ stdout: "" }));
  if (!stdout.trim())
    throw new GitOpError("ブランチにいないので pull できません");
  await runGit(
    cwd,
    ["pull", "--ff-only", "--no-rebase", "--no-autostash", "--no-squash"],
    {
      remote: true,
    }
  );
}

/** upstream の無いブランチを push する先。origin、無ければ最初のリモート */
async function defaultRemote(cwd: string): Promise<string> {
  const remotes = await listRemotes(cwd);
  if (remotes.length === 0) throw new GitOpError("リモートがありません");
  return remotes.includes("origin") ? "origin" : remotes[0];
}

/**
 * name を push する。追跡先がリモートにあればその先へ、無ければ既定のリモートの同名へ
 * push して追跡先にする。追跡先は設定 (branch.<name>.remote / merge) から直に読む
 * (for-each-ref の upstream は fetch の refspec の外にあると空になり、追跡先があるのに
 * 別の名前へ push して設定を上書きしてしまう)。ローカルの追跡先 (`.`) は変えない。force はしない
 */
export async function pushBranch(
  cwd: string,
  name: unknown
): Promise<{ remote: string; remoteBranch: string }> {
  const branch = await assertBranchName(cwd, name);
  if (!(await localBranchExists(cwd, branch))) {
    throw new GitOpError(`ブランチ ${branch} が見つかりません`);
  }
  const upstream = await readUpstream(cwd, branch);
  if (
    upstream &&
    upstream.remote !== "." &&
    upstream.merge.startsWith("refs/heads/")
  ) {
    await runGit(
      cwd,
      ["push", "--", upstream.remote, `refs/heads/${branch}:${upstream.merge}`],
      { remote: true }
    );
    return {
      remote: upstream.remote,
      remoteBranch: upstream.merge.slice("refs/heads/".length),
    };
  }
  const remote = await defaultRemote(cwd);
  await runGit(
    cwd,
    [
      "push",
      // 追跡先があるとき (ローカルのブランチを追っている) は上書きしない
      ...(upstream ? [] : ["-u"]),
      "--",
      remote,
      `refs/heads/${branch}:refs/heads/${branch}`,
    ],
    { remote: true }
  );
  return { remote, remoteBranch: branch };
}

/** リモートの既定のブランチ (`<remote>/HEAD` の指す先)。取っていなければ null */
async function remoteDefaultBranch(
  cwd: string,
  remote: string
): Promise<string | null> {
  const { stdout } = await runGit(cwd, [
    "for-each-ref",
    "--format=%(symref)",
    `refs/remotes/${remote}/HEAD`,
  ]);
  const target = stdout.trim();
  const prefix = `refs/remotes/${remote}/`;
  return target.startsWith(prefix) ? target.slice(prefix.length) : null;
}

/** リモートのブランチを消す。リモートの既定のブランチは消さない */
export async function deleteRemoteBranch(
  cwd: string,
  remote: unknown,
  name: unknown
): Promise<void> {
  const remoteName = await assertRemote(cwd, remote);
  const branch = await assertBranchName(cwd, name);
  if ((await remoteDefaultBranch(cwd, remoteName)) === branch) {
    throw new GitOpError(
      `${remoteName}/${branch} はリモートの既定のブランチなので消せません`
    );
  }
  await runGit(cwd, ["push", "--", remoteName, `:refs/heads/${branch}`], {
    remote: true,
  });
}
