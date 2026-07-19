/**
 * worktree の trust boundary 検証 + realpath 正規化。
 *
 * 以前はこの判定が `startServer` のクロージャ内にあり、4 つの失敗要因
 * (パス長 / realpath 例外 / ディレクトリ・`.git` 不在 / allowedRepos 外) を
 * すべて素の `catch {}` で握り潰して単一の `null` に畳んでいた。
 * その結果「削除済み worktree を指している」のか「一過性の FS エラー」なのかが
 * 事後に一切追えず、`board scene の保存先 worktree が見つかりません` という
 * 同一のメッセージだけが残る状態だった。
 *
 * ここでは失敗要因を型で区別して返し、呼び出し側がログ・メッセージに
 * errno まで載せられるようにする。
 */

import { execFileSync } from "node:child_process";
import nodeFs from "node:fs";

/** realpathSync に異常に長い文字列を渡さないための上限 */
const MAX_WORKTREE_PATH_LENGTH = 4096;

export type WorktreeFailure =
  | { kind: "path-too-long" }
  /** パス自体が存在しない = worktree ごと削除されている */
  | { kind: "worktree-missing" }
  /** ENOENT 以外の FS エラー (EACCES / EMFILE 等)。一過性の可能性がある */
  | { kind: "fs-error"; code: string; message: string }
  | { kind: "not-directory" }
  /** ディレクトリはあるが `.git` が無い = git worktree ではない */
  | { kind: "not-a-worktree" }
  /** allowedRepos (--repos) の許可リスト外 */
  | { kind: "repo-not-allowed"; repoPath?: string };

export type ResolveRealPathResult =
  | { ok: true; realPath: string }
  | { ok: false; failure: WorktreeFailure };

export type CheckResult =
  | { ok: true }
  | { ok: false; failure: WorktreeFailure };

/** テストから FS エラーを注入するための最小インターフェース */
interface RealpathFs {
  realpathSync: (p: string) => string;
}

interface CheckFs {
  statSync: (p: string) => { isDirectory: () => boolean };
  existsSync: (p: string) => boolean;
  realpathSync: (p: string) => string;
}

/** errno を持つ例外から code を取り出す (無ければ "UNKNOWN") */
function errnoCode(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
}

function errnoMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * パスを realpath 正規化する。`/repo`・`/repo/.` 等の表記揺れを同一の実パスへ
 * 畳み込み、DB 主キー・キャッシュキー・room 名を worktree ごとに一意化する。
 * 実在しないパスはここで `worktree-missing` として弾かれる。
 */
export function resolveWorktreeRealPath(
  worktreePath: string,
  opts: { fs?: RealpathFs } = {}
): ResolveRealPathResult {
  if (worktreePath.length > MAX_WORKTREE_PATH_LENGTH) {
    return { ok: false, failure: { kind: "path-too-long" } };
  }
  const fs = opts.fs ?? nodeFs;
  try {
    return { ok: true, realPath: fs.realpathSync(worktreePath) };
  } catch (e) {
    const code = errnoCode(e);
    if (code === "ENOENT") {
      return { ok: false, failure: { kind: "worktree-missing" } };
    }
    return {
      ok: false,
      failure: { kind: "fs-error", code, message: errnoMessage(e) },
    };
  }
}

/**
 * realpath 済みのパスが「Ark が管理してよい worktree」かを判定する。
 * (1) ディレクトリであること
 * (2) git worktree であること (`.git` の存在で判定)
 * (3) allowedRepos 設定時は、そこから導出した repoPath が許可リストに含まれること
 */
export function checkManagedWorktree(
  realPath: string,
  opts: { allowedRepos: string[]; fs?: CheckFs }
): CheckResult {
  const fs = opts.fs ?? nodeFs;
  try {
    if (!fs.statSync(realPath).isDirectory()) {
      return { ok: false, failure: { kind: "not-directory" } };
    }
  } catch (e) {
    const code = errnoCode(e);
    if (code === "ENOENT") {
      return { ok: false, failure: { kind: "worktree-missing" } };
    }
    return {
      ok: false,
      failure: { kind: "fs-error", code, message: errnoMessage(e) },
    };
  }

  if (!fs.existsSync(`${realPath}/.git`)) {
    return { ok: false, failure: { kind: "not-a-worktree" } };
  }

  if (opts.allowedRepos.length === 0) return { ok: true };

  let derivedRepoPath: string | undefined;
  try {
    // execFileSync は shell を介さないため worktreePath のメタ文字
    // (`、$()、;、空白) によるコマンド注入を防げる。
    const stdout = execFileSync(
      "git",
      [
        "-C",
        realPath,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    ).toString();
    derivedRepoPath = stdout.trim().replace(/\/\.git\/?$/, "") || undefined;
  } catch {
    return { ok: false, failure: { kind: "repo-not-allowed" } };
  }
  if (!derivedRepoPath) {
    return { ok: false, failure: { kind: "repo-not-allowed" } };
  }

  let inAllowed = opts.allowedRepos.includes(derivedRepoPath);
  if (!inAllowed) {
    try {
      inAllowed = opts.allowedRepos.includes(fs.realpathSync(derivedRepoPath));
    } catch {
      inAllowed = false;
    }
  }
  return inAllowed
    ? { ok: true }
    : {
        ok: false,
        failure: { kind: "repo-not-allowed", repoPath: derivedRepoPath },
      };
}

/** 失敗要因を人間が読める 1 行に落とす (ログ・エラーメッセージ用) */
export function describeWorktreeFailure(failure: WorktreeFailure): string {
  switch (failure.kind) {
    case "path-too-long":
      return "パスが長すぎます";
    case "worktree-missing":
      return "worktree が削除されています (パスが存在しません)";
    case "fs-error":
      return `FS エラー (${failure.code}): ${failure.message}`;
    case "not-directory":
      return "ディレクトリではありません";
    case "not-a-worktree":
      return "git worktree ではありません (.git がありません)";
    case "repo-not-allowed":
      return failure.repoPath
        ? `許可リスト (--repos) 外のリポジトリです: ${failure.repoPath}`
        : "許可リスト (--repos) 外のリポジトリです";
  }
}
