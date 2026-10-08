/**
 * Git タブ用の読み取り専用 git ラッパー。
 * すべて execFile の非同期で呼び、worktree の index を書き換えない
 * (--no-optional-locks。Claude の git 操作と index.lock を取り合わない)。
 * 引数に入るユーザー入力は isValidSha / isSafeRelPath を通ったものだけにする。
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
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
  const [stagedAll, unstagedAll, untrackedOut] = await Promise.all([
    diffChanges(cwd, ["diff", "--no-ext-diff", "--cached"]),
    diffChanges(cwd, ["diff", "--no-ext-diff"]),
    git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  // 競合中 (unmerged) のパスはindexにステージ0が無く、どちらのdiffにもUで出る
  // (作業ツリー側にはoursとの差のMも重ねて出る)。未ステージに1回だけUとして出す
  const unmerged = new Set<string>();
  for (const f of [...stagedAll, ...unstagedAll]) {
    if (f.status === "U") unmerged.add(f.path);
  }
  const staged = stagedAll.filter(f => !unmerged.has(f.path));
  const unstaged: GitFileChange[] = [
    ...[...unmerged].sort().map(p => ({
      path: p,
      status: "U" as const,
      added: null,
      removed: null,
    })),
    ...unstagedAll.filter(f => !unmerged.has(f.path)),
  ];
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

const isGone = (err: unknown) => {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/**
 * 作業ツリーのファイルを読む。シンボリックリンクはたどらず、行き先の文字列を内容にする
 * (indexのblobが持つのも行き先の文字列。たどるとworktreeの外も読めてしまう)。
 * 境界は親ディレクトリで確かめる: 親の実体がworktreeの中にあることを見てから、
 * 最後の要素だけをlstatする
 */
async function readWorkingFile(cwd: string, relPath: string): Promise<Side> {
  let parent: string;
  try {
    parent = await resolveReadablePath(cwd, path.dirname(relPath));
  } catch (err) {
    // 作業ツリーから消えたディレクトリ
    if (err instanceof Error && err.message.includes("見つかりません")) {
      return { data: Buffer.alloc(0) };
    }
    throw err;
  }
  const abs = path.join(parent, path.basename(relPath));
  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink()) return { data: Buffer.from(await readlink(abs)) };
    if (!st.isFile()) return { data: Buffer.alloc(0) };
    if (st.size > MAX_DIFF_BYTES) return { tooLarge: true };
    return { data: await readFile(abs) };
  } catch (err) {
    // 作業ツリーから消えたファイル
    if (isGone(err)) return { data: Buffer.alloc(0) };
    throw err;
  }
}

/**
 * 競合中 (unmerged) のパスの「元」のblob。ours (ステージ2)、無ければbase (ステージ1)。
 * 競合していなければnull、競合していてどちらも無ければ (相手だけが足した等) 空文字
 */
async function unmergedBase(cwd: string, p: string): Promise<string | null> {
  const out = await git(cwd, [
    "--literal-pathspecs",
    "ls-files",
    "-u",
    "-z",
    "--",
    p,
  ]);
  const stages = new Map<string, string>();
  for (const entry of out.split("\0")) {
    // <mode> <sha> <stage>\t<path>
    const m = /^\d+ ([0-9a-f]+) ([123])\t(.*)$/s.exec(entry);
    if (m && m[3] === p) stages.set(m[2], m[1]);
  }
  if (stages.size === 0) return null;
  return stages.get("2") ?? stages.get("1") ?? "";
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
    case "unstaged": {
      // 競合中はindexにステージ0が無い (":0:path" は失敗する)。oursと作業ツリー
      // (競合の印が入ったファイル) の差を見せる
      const base = await unmergedBase(cwd, path);
      if (base !== null) {
        [oldSide, newSide] = await Promise.all([
          base === "" ? empty() : readBlob(cwd, base),
          readWorkingFile(cwd, path),
        ]);
      } else if (target.kind === "staged") {
        [oldSide, newSide] = await Promise.all([
          readBlob(cwd, pathSpec("HEAD", from)),
          readBlob(cwd, indexSpec(path)),
        ]);
      } else {
        [oldSide, newSide] = await Promise.all([
          readBlob(cwd, indexSpec(path)),
          readWorkingFile(cwd, path),
        ]);
      }
      break;
    }
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

/** 指紋のためにlstatするパスの上限 */
const MAX_FINGERPRINT_STATS = 2000;
const STAT_CHUNK = 200;

/** `status --porcelain=v1 -z` から、作業ツリー側が変わっているパスと未追跡のパスを拾う */
function worktreeDirtyPaths(status: string): string[] {
  const tokens = status.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length < 4) continue;
    const x = token[0];
    const y = token[1];
    // リネーム・コピーは元のパスが次のトークンに続く
    if (x === "R" || x === "C" || y === "R" || y === "C") i++;
    if (y !== " ") paths.push(token.slice(3));
  }
  return paths;
}

/** パスのmtimeと大きさ。消えていれば決まった印 */
async function statMark(cwd: string, rel: string): Promise<string> {
  const abs = path.resolve(cwd, rel);
  if (!isSafeRelPath(rel) || !abs.startsWith(cwd + path.sep)) return "invalid";
  try {
    const st = await lstat(abs);
    return `${st.mtimeMs}:${st.size}`;
  } catch (err) {
    return isGone(err) ? "missing" : "error";
  }
}

/**
 * 「読み直すべきか」を決める指紋。HEAD・いまのブランチ・ref・statusに加えて、
 * - indexのblob (ステージし直すとstatusの出力は同じまま中身が変わる)
 * - 作業ツリー側が変わっているパスと未追跡のパスのmtimeと大きさ
 *   (変更済みのファイルをさらに編集してもstatusの出力は変わらない)
 * を混ぜる。lstatは2,000パスまで
 */
export async function getFingerprint(cwd: string): Promise<string> {
  const [head, branch, refs, status, stagedRaw, worktreeRaw] =
    await Promise.all([
      headSha(cwd),
      // detachedでは失敗する (空として扱う)。同じコミットを指す別のブランチへ
      // 切り替えてもHEADのshaは変わらない
      gitOrNull(cwd, ["symbolic-ref", "-q", "HEAD"]),
      git(cwd, ["for-each-ref"]),
      // 未追跡のディレクトリを1行に畳ませない (中にファイルが増えても変わるように)
      git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      git(cwd, ["diff", "--cached", "--raw", "-z", "--no-abbrev"]),
      git(cwd, ["diff", "--raw", "-z", "--no-abbrev"]),
    ]);

  const hash = createHash("sha256");
  for (const part of [
    head ?? "",
    branch?.trim() ?? "",
    refs,
    status,
    stagedRaw,
    worktreeRaw,
  ]) {
    hash.update(part).update("\0");
  }

  const root = path.resolve(cwd);
  const paths = worktreeDirtyPaths(status).slice(0, MAX_FINGERPRINT_STATS);
  for (let i = 0; i < paths.length; i += STAT_CHUNK) {
    const chunk = paths.slice(i, i + STAT_CHUNK);
    const marks = await Promise.all(chunk.map(p => statMark(root, p)));
    chunk.forEach((p, j) => {
      hash.update(p).update("\0").update(marks[j]).update("\0");
    });
  }
  return hash.digest("hex");
}
