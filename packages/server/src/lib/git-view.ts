/**
 * Git タブ用の読み取り専用 git ラッパー。
 * すべて execFile の非同期で呼び、worktree の index を書き換えない
 * (--no-optional-locks。Claude の git 操作と index.lock を取り合わない)。
 * 引数に入るユーザー入力は isValidSha / isSafeRelPath を通ったものだけにする。
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type {
  GitBranch,
  GitCommit,
  GitCommitDetail,
  GitDiffTarget,
  GitFileChange,
  GitFileDiff,
  GitRef,
  GitRefs,
  GitStatus,
} from "@ark/shared";
import { resolveReadablePath } from "./file-manager.js";

const GIT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
/** 差分で返す内容の上限 (片側あたり) */
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;
export const MAX_LOG_LIMIT = 500;

const FS = "\x1f";
const RS = "\x1e";

// ---- 入力の検証 ----

export function isValidSha(sha: unknown): sha is string {
  return typeof sha === "string" && /^[0-9a-f]{7,40}$/.test(sha);
}

/** worktree 内の相対パスとして安全か (オプション・絶対パス・親ディレクトリ参照を弾く) */
export function isSafeRelPath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.includes("\0")) return false;
  if (p.startsWith("/") || p.startsWith("-")) return false;
  if (p.split(/[\\/]/).includes("..")) return false;
  return true;
}

// ---- git の呼び出し ----

class GitRunError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly tooBig = false
  ) {
    super(message);
  }
}

function runGit(
  cwd: string,
  args: string[],
  opts: { maxBuffer?: number } = {}
): Promise<Buffer> {
  const full = [
    "-c",
    "core.quotepath=off",
    "-c",
    "core.fsmonitor=false",
    "--no-optional-locks",
    ...args,
  ];
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      full,
      {
        cwd,
        encoding: "buffer",
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
        timeout: GIT_TIMEOUT_MS,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        const errText = stderr.toString("utf8").trim();
        if (e.code === "ENOENT") {
          return reject(
            new GitRunError("git コマンドが見つかりません", errText)
          );
        }
        if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          return reject(new GitRunError("git の出力が大きすぎます", "", true));
        }
        if (e.killed) {
          return reject(new GitRunError("git がタイムアウトしました", errText));
        }
        if (/not a git repository/i.test(errText)) {
          return reject(
            new GitRunError("git リポジトリではありません", errText)
          );
        }
        const firstLine = errText.split("\n")[0] || e.message;
        reject(
          new GitRunError(`git の実行に失敗しました: ${firstLine}`, errText)
        );
      }
    );
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runGit(cwd, args)).toString("utf8");
}

/** 失敗を null に畳む (HEAD が無い等、想定内の失敗用)。git 不在・非リポジトリは投げる */
async function gitOrNull(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch (err) {
    if (
      err instanceof GitRunError &&
      (err.message.includes("見つかりません") ||
        err.message.includes("リポジトリではありません") ||
        err.message.includes("タイムアウト"))
    ) {
      throw err;
    }
    return null;
  }
}

// ---- ref ----

interface RefRow {
  sha: string;
  refname: string;
  peeled: string;
}

async function listRefRows(cwd: string, patterns: string[] = []) {
  const out = await git(cwd, [
    "for-each-ref",
    "--format=%(objectname)%00%(refname)%00%(*objectname)",
    ...patterns,
  ]);
  const rows: RefRow[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [sha, refname, peeled] = line.split("\0");
    if (sha && refname) rows.push({ sha, refname, peeled: peeled ?? "" });
  }
  return rows;
}

async function currentBranch(cwd: string): Promise<string | null> {
  const out = await gitOrNull(cwd, ["symbolic-ref", "-q", "--short", "HEAD"]);
  const name = out?.trim();
  return name ? name : null;
}

async function headSha(cwd: string): Promise<string | null> {
  const out = await gitOrNull(cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
  const sha = out?.trim();
  return sha ? sha : null;
}

/** sha → 付く ref の一覧 */
async function buildRefMap(cwd: string): Promise<Map<string, GitRef[]>> {
  const [rows, branch, head] = await Promise.all([
    listRefRows(cwd),
    currentBranch(cwd),
    headSha(cwd),
  ]);
  const map = new Map<string, GitRef[]>();
  const add = (sha: string, ref: GitRef) => {
    const list = map.get(sha);
    if (list) list.push(ref);
    else map.set(sha, [ref]);
  };
  for (const r of rows) {
    const target = r.peeled || r.sha;
    if (r.refname.startsWith("refs/heads/")) {
      const name = r.refname.slice("refs/heads/".length);
      add(target, { kind: name === branch ? "head" : "branch", name });
    } else if (r.refname.startsWith("refs/remotes/")) {
      if (r.refname.endsWith("/HEAD")) continue;
      add(target, {
        kind: "remote",
        name: r.refname.slice("refs/remotes/".length),
      });
    } else if (r.refname.startsWith("refs/tags/")) {
      add(target, { kind: "tag", name: r.refname.slice("refs/tags/".length) });
    } else if (r.refname === "refs/stash") {
      add(target, { kind: "stash", name: "stash" });
    }
  }
  if (head && branch === null) add(head, { kind: "head", name: "HEAD" });
  return map;
}

// ---- log ----

export async function getLog(
  cwd: string,
  skip: number,
  limit: number
): Promise<{ commits: GitCommit[]; hasMore: boolean }> {
  const lim = Math.min(Math.max(Math.trunc(limit) || 1, 1), MAX_LOG_LIMIT);
  const sk = Math.max(Math.trunc(skip) || 0, 0);
  const refMap = await buildRefMap(cwd);
  // 履歴が空 (unborn) のとき log は失敗するので空として扱う
  if ((await headSha(cwd)) === null && refMap.size === 0) {
    return { commits: [], hasMore: false };
  }
  const out = await git(cwd, [
    "log",
    "--exclude=refs/stash",
    "--all",
    "--date-order",
    `--skip=${sk}`,
    "-n",
    String(lim + 1),
    `--format=%H${FS}%P${FS}%an${FS}%ae${FS}%at${FS}%s${RS}`,
  ]);
  const commits: GitCommit[] = [];
  for (const rec of out.split(RS)) {
    const text = rec.replace(/^\n+/, "");
    if (!text) continue;
    const [sha, parents, authorName, authorEmail, at, subject] = text.split(FS);
    commits.push({
      sha,
      parents: parents ? parents.split(" ") : [],
      subject: subject ?? "",
      authorName,
      authorEmail,
      authorTime: Number(at) || 0,
      refs: refMap.get(sha) ?? [],
    });
  }
  const hasMore = commits.length > lim;
  return { commits: commits.slice(0, lim), hasMore };
}

// ---- refs ----

function parseTrack(track: string): { ahead: number; behind: number } | null {
  if (track === "gone") return null;
  const a = /ahead (\d+)/.exec(track);
  const b = /behind (\d+)/.exec(track);
  return { ahead: a ? Number(a[1]) : 0, behind: b ? Number(b[1]) : 0 };
}

export async function getRefs(cwd: string): Promise<GitRefs> {
  const [branchName, head, rows, branchOut, stashOut] = await Promise.all([
    currentBranch(cwd),
    headSha(cwd),
    listRefRows(cwd),
    git(cwd, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track,nobracket)",
      "refs/heads",
    ]),
    gitOrNull(cwd, ["stash", "list", `--format=%H${FS}%gd${FS}%gs`]),
  ]);

  const branches: GitBranch[] = [];
  for (const line of branchOut.split("\n")) {
    if (!line) continue;
    const [refname, sha, upstream, track] = line.split("\0");
    const name = refname.slice("refs/heads/".length);
    const b: GitBranch = { name, sha, current: name === branchName };
    if (upstream) {
      b.upstream = upstream;
      const t = parseTrack(track ?? "");
      if (t) {
        b.ahead = t.ahead;
        b.behind = t.behind;
      }
    }
    branches.push(b);
  }

  const remotes: GitRefs["remotes"] = [];
  const tags: GitRefs["tags"] = [];
  for (const r of rows) {
    if (r.refname.startsWith("refs/remotes/")) {
      if (r.refname.endsWith("/HEAD")) continue;
      remotes.push({
        name: r.refname.slice("refs/remotes/".length),
        sha: r.peeled || r.sha,
      });
    } else if (r.refname.startsWith("refs/tags/")) {
      tags.push({
        name: r.refname.slice("refs/tags/".length),
        sha: r.peeled || r.sha,
      });
    }
  }

  const stashes: GitRefs["stashes"] = [];
  for (const line of (stashOut ?? "").split("\n")) {
    if (!line) continue;
    const [sha, name, subject] = line.split(FS);
    stashes.push({ name, sha, subject: subject ?? "" });
  }

  return {
    head: { sha: head, branch: branchName },
    branches,
    remotes,
    tags,
    stashes,
  };
}

// ---- 変更ファイル ----

interface NameStatus {
  status: GitFileChange["status"];
  path: string;
  oldPath?: string;
}

const VALID_STATUS = new Set(["A", "M", "D", "R", "C", "T", "U"]);

/** `--name-status -z` の出力を読む */
function parseNameStatus(out: string): NameStatus[] {
  const tokens = out.split("\0");
  const result: NameStatus[] = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i++];
    if (!code) continue;
    const letter = code[0];
    const status = (
      VALID_STATUS.has(letter) ? letter : "M"
    ) as NameStatus["status"];
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[i++];
      const path = tokens[i++];
      if (path !== undefined) result.push({ status, path, oldPath });
    } else {
      const path = tokens[i++];
      if (path !== undefined) result.push({ status, path });
    }
  }
  return result;
}

/** `--numstat -z` の出力を、新しいパス → [added, removed] にする */
function parseNumstat(
  out: string
): Map<string, [number | null, number | null]> {
  const tokens = out.split("\0");
  const map = new Map<string, [number | null, number | null]>();
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i++];
    if (!head) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head);
    if (!m) continue;
    const added = m[1] === "-" ? null : Number(m[1]);
    const removed = m[2] === "-" ? null : Number(m[2]);
    let path = m[3];
    if (path === "") {
      // リネーム: 続く 2 トークンが元と先
      i++;
      path = tokens[i++] ?? "";
    }
    map.set(path, [added, removed]);
  }
  return map;
}

function mergeChanges(
  names: NameStatus[],
  nums: Map<string, [number | null, number | null]>
): GitFileChange[] {
  return names.map(n => {
    const [added, removed] = nums.get(n.path) ?? [null, null];
    const c: GitFileChange = { path: n.path, status: n.status, added, removed };
    if (n.oldPath !== undefined) c.oldPath = n.oldPath;
    return c;
  });
}

async function diffChanges(cwd: string, baseArgs: string[]) {
  const [names, nums] = await Promise.all([
    git(cwd, [...baseArgs, "--name-status", "-z", "-M"]),
    git(cwd, [...baseArgs, "--numstat", "-z", "-M"]),
  ]);
  return mergeChanges(parseNameStatus(names), parseNumstat(nums));
}

export async function getStatus(cwd: string): Promise<GitStatus> {
  const [staged, unstaged, untrackedOut] = await Promise.all([
    diffChanges(cwd, ["diff", "--no-ext-diff", "--cached"]),
    diffChanges(cwd, ["diff", "--no-ext-diff"]),
    git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const untracked: GitFileChange[] = untrackedOut
    .split("\0")
    .filter(Boolean)
    .map(path => ({ path, status: "?" as const, added: null, removed: null }));
  return { staged, unstaged, untracked };
}

// ---- コミット詳細 ----

export async function getCommit(
  cwd: string,
  sha: string
): Promise<{ commit: GitCommitDetail; files: GitFileChange[] }> {
  if (!isValidSha(sha)) throw new Error("コミットの指定が不正です");
  const resolved = (
    await git(cwd, ["rev-parse", "--verify", "-q", `${sha}^{commit}`]).catch(
      err => {
        if (
          err instanceof GitRunError &&
          err.message.includes("失敗しました")
        ) {
          throw new Error("コミットが見つかりません");
        }
        throw err;
      }
    )
  ).trim();

  const [out, refMap] = await Promise.all([
    git(cwd, [
      "show",
      "-s",
      `--format=%H${FS}%P${FS}%an${FS}%ae${FS}%at${FS}%cn${FS}%ct${FS}%s${FS}%b`,
      resolved,
    ]),
    buildRefMap(cwd),
  ]);
  const parts = out.split(FS);
  const [h, parents, an, ae, at, cn, ct, subject] = parts;
  const body = parts.slice(8).join(FS).replace(/\n+$/, "");
  const parentList = parents ? parents.split(" ") : [];
  const commit: GitCommitDetail = {
    sha: h,
    parents: parentList,
    subject: subject ?? "",
    authorName: an,
    authorEmail: ae,
    authorTime: Number(at) || 0,
    committerName: cn,
    committerTime: Number(ct) || 0,
    body,
    refs: refMap.get(h) ?? [],
  };

  // マージは第 1 親との差、ルートは空との差
  const base =
    parentList.length === 0
      ? ["diff-tree", "--root", "--no-commit-id", "-r"]
      : ["diff", "--no-ext-diff", `${resolved}^1`];
  const files = await diffChanges(cwd, [...base, resolved]);
  return { commit, files };
}

// ---- ファイルの差分 ----

const MISSING_RE =
  /does not exist|exists on disk, but not in|not a valid object name|bad revision|unknown revision|invalid object name|bad object/i;

type Side = { data: Buffer } | { tooLarge: true };

async function readBlob(cwd: string, spec: string): Promise<Side> {
  try {
    const data = await runGit(cwd, ["cat-file", "blob", spec], {
      maxBuffer: MAX_DIFF_BYTES + 1,
    });
    if (data.length > MAX_DIFF_BYTES) return { tooLarge: true };
    return { data };
  } catch (err) {
    if (err instanceof GitRunError) {
      if (err.tooBig) return { tooLarge: true };
      if (MISSING_RE.test(err.stderr)) return { data: Buffer.alloc(0) };
    }
    throw err;
  }
}

async function readWorkingFile(cwd: string, relPath: string): Promise<Side> {
  let abs: string;
  try {
    abs = await resolveReadablePath(cwd, relPath);
  } catch (err) {
    // 作業ツリーから消えたファイル
    if (err instanceof Error && err.message.includes("見つかりません")) {
      return { data: Buffer.alloc(0) };
    }
    throw err;
  }
  const st = await stat(abs);
  if (!st.isFile()) return { data: Buffer.alloc(0) };
  if (st.size > MAX_DIFF_BYTES) return { tooLarge: true };
  return { data: await readFile(abs) };
}

function pathSpec(rev: string, p: string): string {
  if (p.startsWith(":")) throw new Error("パスが不正です");
  return `${rev}:${p}`;
}

/** index (ステージ 0) の blob を指す。パスが ":" 始まりでも ":0:" 以降は ref 扱いにならない */
function indexSpec(p: string): string {
  return `:0:${p}`;
}

export async function getFileDiff(
  cwd: string,
  target: GitDiffTarget,
  path: string,
  oldPath?: string
): Promise<GitFileDiff> {
  if (
    !isSafeRelPath(path) ||
    (oldPath !== undefined && !isSafeRelPath(oldPath))
  ) {
    throw new Error("パスが不正です");
  }
  const from = oldPath ?? path;
  const empty = (): Side => ({ data: Buffer.alloc(0) });
  let oldSide: Side;
  let newSide: Side;

  switch (target.kind) {
    case "commit": {
      if (!isValidSha(target.sha)) throw new Error("コミットの指定が不正です");
      [oldSide, newSide] = await Promise.all([
        readBlob(cwd, pathSpec(`${target.sha}^1`, from)),
        readBlob(cwd, pathSpec(target.sha, path)),
      ]);
      break;
    }
    case "staged":
      [oldSide, newSide] = await Promise.all([
        readBlob(cwd, pathSpec("HEAD", from)),
        readBlob(cwd, indexSpec(path)),
      ]);
      break;
    case "unstaged":
      [oldSide, newSide] = await Promise.all([
        readBlob(cwd, indexSpec(path)),
        readWorkingFile(cwd, path),
      ]);
      break;
    case "untracked":
      oldSide = empty();
      newSide = await readWorkingFile(cwd, path);
      break;
    default:
      throw new Error("差分の対象が不正です");
  }

  if ("tooLarge" in oldSide || "tooLarge" in newSide) {
    return { oldContent: "", newContent: "", binary: false, tooLarge: true };
  }
  const isBinary = (b: Buffer) => b.subarray(0, BINARY_SNIFF_BYTES).includes(0);
  if (isBinary(oldSide.data) || isBinary(newSide.data)) {
    return { oldContent: "", newContent: "", binary: true, tooLarge: false };
  }
  return {
    oldContent: oldSide.data.toString("utf8"),
    newContent: newSide.data.toString("utf8"),
    binary: false,
    tooLarge: false,
  };
}

// ---- 指紋 ----

export async function getFingerprint(cwd: string): Promise<string> {
  const [head, refs, status] = await Promise.all([
    headSha(cwd),
    git(cwd, ["for-each-ref"]),
    git(cwd, ["status", "--porcelain=v1", "-z"]),
  ]);
  return createHash("sha256")
    .update(head ?? "")
    .update("\0")
    .update(refs)
    .update("\0")
    .update(status)
    .digest("hex");
}
