/**
 * Git Worktree Utilities
 *
 * Provides safe wrappers around git worktree commands.
 * All paths are validated to prevent command injection.
 */

import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { RepoInfo, Worktree } from "@ark/shared";
import { getErrorMessage } from "./errors.js";

const execAsync = promisify(exec);

// Validate path to prevent command injection
function validatePath(inputPath: string): string {
  // Normalize and resolve the path
  const resolved = path.resolve(inputPath);

  // Check for dangerous characters
  if (/[;&|`$(){}[\]<>!"']/.test(resolved)) {
    throw new Error("Invalid characters in path");
  }

  return resolved;
}

// Validate branch name
function validateBranchName(branch: string): string {
  // Git branch naming rules
  if (!/^[a-zA-Z0-9._\-/]+$/.test(branch)) {
    throw new Error("Invalid branch name");
  }

  // Prevent dangerous patterns
  if (branch.startsWith("-") || branch.includes("..")) {
    throw new Error("Invalid branch name pattern");
  }

  return branch;
}

// Check if a directory is a git repository
export async function isGitRepository(dirPath: string): Promise<boolean> {
  const safePath = validatePath(dirPath);

  try {
    await execAsync("git rev-parse --is-inside-work-tree", {
      cwd: safePath,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 現在のブランチ名を取得
 * @param dirPath - Gitリポジトリのパス
 * @returns ブランチ名（detached HEADの場合はHEADを返す）
 */
async function getCurrentBranch(dirPath: string): Promise<string> {
  const safePath = validatePath(dirPath);

  try {
    const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", {
      cwd: safePath,
    });
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

/** スキップするディレクトリ名のセット */
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".cache",
  ".npm",
  ".yarn",
  ".pnpm",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  "target",
]);

/**
 * fd/findコマンドを使ってGitリポジトリを効率的に探索
 *
 * fdコマンド（高速）を優先的に使用し、失敗した場合はfindにフォールバックします。
 *
 * @param basePath - 探索を開始するベースパス（バリデーション済み）
 * @returns 発見されたリポジトリ情報の配列
 * @throws fd/findコマンドが両方失敗した場合
 */
async function scanWithFind(basePath: string): Promise<RepoInfo[]> {
  let stdout: string;

  // まずfdを試す（高速）
  try {
    const result = await execAsync(
      `fd -t d -H --no-ignore -E node_modules -E .cache -E vendor -E __pycache__ -E .venv -E target -E dist -E build "^\\.git$" "${basePath}" 2>/dev/null`,
      { maxBuffer: 10 * 1024 * 1024 }
    );
    stdout = result.stdout;
  } catch {
    // fdが失敗したらfindにフォールバック
    const result = await execAsync(
      `find "${basePath}" -type d -name ".git" 2>/dev/null`,
      { maxBuffer: 10 * 1024 * 1024 } // 大きなディレクトリツリーに対応
    );
    stdout = result.stdout;
  }

  const gitDirs = stdout.trim().split("\n").filter(Boolean);

  if (gitDirs.length === 0) {
    return [];
  }

  // .gitディレクトリの親ディレクトリがリポジトリパス
  // ブランチ取得は省略して即座に返す（UIで後から取得可能）
  return gitDirs.map(gitDir => {
    const repoPath = path.dirname(gitDir);
    return {
      path: repoPath,
      name: path.basename(repoPath),
      branch: "",
    };
  });
}

/**
 * 指定したパス配下のGitリポジトリを再帰的に探索
 *
 * findコマンドを使用して効率的に探索し、失敗した場合は
 * 再帰探索にフォールバックします。
 *
 * @param basePath - 探索を開始するベースパス
 * @param maxDepth - 最大探索階層数（デフォルト: 3、フォールバック時のみ使用）
 * @returns 発見されたリポジトリ情報の配列
 *
 * @example
 * ```typescript
 * const repos = await scanRepositories('/Users/username/dev');
 * // => [{ path: '/Users/username/dev/project1', name: 'project1', branch: 'main' }, ...]
 * ```
 */
export async function scanRepositories(
  basePath: string,
  maxDepth: number = 3
): Promise<RepoInfo[]> {
  const safePath = validatePath(basePath);

  // ベースパスが存在するか確認
  try {
    const stats = await fs.promises.stat(safePath);
    if (!stats.isDirectory()) {
      throw new Error("指定されたパスはディレクトリではありません");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("指定されたパスが存在しません");
    }
    throw error;
  }

  // findコマンドを使った探索を試行
  try {
    const repos = await scanWithFind(safePath);
    // パスでソートして返す
    return repos.sort((a, b) => a.path.localeCompare(b.path));
  } catch {
    // findコマンドが失敗した場合は再帰探索にフォールバック
    console.warn(
      "findコマンドによる探索に失敗しました。再帰探索にフォールバックします。"
    );
  }

  // フォールバック: 既存の再帰探索ロジック
  const repos: RepoInfo[] = [];

  /**
   * 再帰的にディレクトリを探索
   * @param currentPath - 現在探索中のパス
   * @param depth - 現在の深さ
   */
  async function scan(currentPath: string, depth: number): Promise<void> {
    // 最大深度に達したら終了
    if (depth > maxDepth) {
      return;
    }

    // ディレクトリの内容を取得
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
    } catch {
      // アクセス権限がない場合などはスキップ
      return;
    }

    // .gitディレクトリが存在するかチェック
    const hasGitDir = entries.some(
      entry => entry.isDirectory() && entry.name === ".git"
    );

    if (hasGitDir) {
      // Gitリポジトリを発見
      const branch = await getCurrentBranch(currentPath);
      repos.push({
        path: currentPath,
        name: path.basename(currentPath),
        branch,
      });
      // リポジトリ内部は探索しない（サブモジュール等は除外）
      return;
    }

    // サブディレクトリを探索
    const subdirs = entries.filter(
      entry =>
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        !SKIP_DIRECTORIES.has(entry.name)
    );

    // 並列で探索（同時実行数を制限）
    const CONCURRENCY_LIMIT = 10;
    for (let i = 0; i < subdirs.length; i += CONCURRENCY_LIMIT) {
      const batch = subdirs.slice(i, i + CONCURRENCY_LIMIT);
      await Promise.all(
        batch.map(entry => scan(path.join(currentPath, entry.name), depth + 1))
      );
    }
  }

  await scan(safePath, 1);

  // パスでソートして返す
  return repos.sort((a, b) => a.path.localeCompare(b.path));
}

// Get the root of the git repository
export async function getGitRoot(dirPath: string): Promise<string> {
  const safePath = validatePath(dirPath);

  const { stdout } = await execAsync("git rev-parse --show-toplevel", {
    cwd: safePath,
  });

  return stdout.trim();
}

// List all worktrees for a repository
export async function listWorktrees(repoPath: string): Promise<Worktree[]> {
  const safePath = validatePath(repoPath);

  // Check if it's a git repository
  if (!(await isGitRepository(safePath))) {
    throw new Error("Not a git repository");
  }

  const { stdout } = await execAsync("git worktree list --porcelain", {
    cwd: safePath,
  });

  const worktrees: Worktree[] = [];
  const lines = stdout.trim().split("\n");

  let current: Partial<Worktree> = {};

  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      current.path = line.substring(9);
      current.id = Buffer.from(current.path)
        .toString("base64")
        .replace(/[/+=]/g, "");
    } else if (line.startsWith("HEAD ")) {
      current.commit = line.substring(5);
    } else if (line.startsWith("branch ")) {
      // refs/heads/branch-name -> branch-name
      current.branch = line.substring(7).replace("refs/heads/", "");
    } else if (line === "bare") {
      current.isBare = true;
    } else if (line === "detached") {
      current.branch = "(detached)";
    } else if (line === "") {
      // End of worktree entry
      if (current.path) {
        worktrees.push({
          id: current.id || "",
          path: current.path,
          branch: current.branch || "unknown",
          commit: current.commit || "",
          isMain: worktrees.length === 0, // First worktree is main
          isBare: current.isBare || false,
        });
      }
      current = {};
    }
  }

  // Handle last entry if no trailing newline
  if (current.path) {
    worktrees.push({
      id: current.id || "",
      path: current.path,
      branch: current.branch || "unknown",
      commit: current.commit || "",
      isMain: worktrees.length === 0,
      isBare: current.isBare || false,
    });
  }

  // ディレクトリが存在しないworktreeを除外（削除済みworktreeのゴミ防止）
  return worktrees.filter(w => w.isBare || fs.existsSync(w.path));
}

/**
 * ローカルブランチが存在するか確認する
 *
 * `git show-ref --verify --quiet` は「存在しない」場合に exit 1 を返す。
 * それ以外の失敗（リポジトリ異常等）は「存在しない」と区別して伝播する。
 */
async function branchExists(gitRoot: string, branch: string): Promise<boolean> {
  // shell へ渡す前に必ず検証する（呼び出し元に依存しない防御境界）
  const safeBranch = validateBranchName(branch);
  try {
    await execAsync(
      `git show-ref --verify --quiet "refs/heads/${safeBranch}"`,
      { cwd: gitRoot }
    );
    return true;
  } catch (error) {
    if ((error as { code?: number | string }).code === 1) {
      return false;
    }
    throw error;
  }
}

/**
 * ローカルブランチを安全に後始末する (Issue #213 ①)
 *
 * - baseRef から到達可能（固有コミットなし）なら削除しても情報は失われない → 削除
 * - いずれかのリモートブランチから到達可能なら remote-tracking ref から復元できる → 削除
 * - それ以外（固有コミットを持つ可能性あり）は削除せず理由を返す
 *
 * 到達可能性は `git merge-base --is-ancestor` で明示的に検証する
 * （`git branch -d` の成否に頼ると HEAD/upstream の状態に暗黙依存するため）。
 */
async function cleanupLocalBranch(
  gitRoot: string,
  branch: string,
  baseRef = "HEAD"
): Promise<{ deleted: boolean; keptReason?: string }> {
  // 呼び出し元によらず、shell へ渡す前に必ず検証する（多重防御）
  const safeBranch = validateBranchName(branch);
  const safeBaseRef = baseRef === "HEAD" ? "HEAD" : validateBranchName(baseRef);

  const keep = (reason: string) => {
    console.warn(`[Git] ${reason}`);
    return { deleted: false, keptReason: reason };
  };

  // 1) baseRef からの到達可能性を判定する。`merge-base --is-ancestor` は
  //    「ancestor ではない」場合のみ exit 1 を返すため、それ以外の失敗は
  //    リポジトリ異常として区別し、以降のブランチ操作を重ねない
  let reachableFromBase = false;
  try {
    await execAsync(
      `git merge-base --is-ancestor "${safeBranch}" "${safeBaseRef}"`,
      { cwd: gitRoot }
    );
    reachableFromBase = true;
  } catch (error) {
    if ((error as { code?: number | string }).code !== 1) {
      return keep(
        `ブランチ '${safeBranch}' の到達可能性の判定に失敗しました: ${getErrorMessage(error)}`
      );
    }
  }

  if (reachableFromBase) {
    // 固有コミットなし → 削除しても情報は失われない
    try {
      await execAsync(`git branch -D "${safeBranch}"`, { cwd: gitRoot });
      console.log(
        `[Git] ${safeBaseRef} に取り込み済みのブランチ '${safeBranch}' を削除しました`
      );
      return { deleted: true };
    } catch (error) {
      // 削除失敗は「未マージ」と誤分類せず、失敗として明示する
      return keep(
        `ブランチ '${safeBranch}' の削除に失敗しました: ${getErrorMessage(error)}`
      );
    }
  }

  // 2) いずれかのリモートブランチから到達可能なら remote-tracking ref から復元できる → 削除
  //    確認の失敗と削除の失敗は理由を分けて記録する
  let remoteContains = false;
  try {
    const { stdout } = await execAsync(
      `git branch -r --contains "${safeBranch}"`,
      { cwd: gitRoot }
    );
    remoteContains = stdout.trim().length > 0;
  } catch (error) {
    return keep(
      `ブランチ '${safeBranch}' のリモート取り込み状況の確認に失敗しました: ${getErrorMessage(error)}`
    );
  }

  if (remoteContains) {
    try {
      await execAsync(`git branch -D "${safeBranch}"`, { cwd: gitRoot });
      console.log(
        `[Git] リモート取り込み済みブランチ '${safeBranch}' を削除しました`
      );
      return { deleted: true };
    } catch (error) {
      return keep(
        `ブランチ '${safeBranch}' の削除に失敗しました: ${getErrorMessage(error)}`
      );
    }
  }

  return keep(
    `ブランチ '${safeBranch}' は未マージのコミットを持つ可能性があるため削除しませんでした（不要な場合は git branch -D ${safeBranch} で削除してください）`
  );
}

// Create a new worktree
export async function createWorktree(
  repoPath: string,
  branchName: string,
  baseBranch?: string
): Promise<Worktree> {
  const safePath = validatePath(repoPath);
  const safeBranch = validateBranchName(branchName);

  // Get the repository root
  const gitRoot = await getGitRoot(safePath);

  // Generate worktree path (sibling directory)
  const repoName = path.basename(gitRoot);
  const parentDir = path.dirname(gitRoot);
  const worktreePath = path.join(
    parentDir,
    `${repoName}-${safeBranch.replace(/\//g, "-")}`
  );

  // Check if path already exists
  if (fs.existsSync(worktreePath)) {
    throw new Error(
      `作成先ディレクトリが既に存在します: ${worktreePath}（前回の worktree 削除の残骸の可能性があります。不要であれば削除してから再試行してください）`
    );
  }

  const baseRef = baseBranch ? validateBranchName(baseBranch) : "HEAD";

  // 同名ブランチが既に存在する場合の扱い (Issue #213 ②)
  // - 別 worktree で使用中 → 明確なエラー
  // - baseRef/リモートに取り込み済み（固有コミットなし）→ 削除して新規作成（残骸ブランチからの再作成を防ぐ）
  // - 固有コミットを持つ可能性あり → 既存ブランチに attach して作業を引き継ぐ
  let attachExisting = false;
  if (await branchExists(gitRoot, safeBranch)) {
    const worktrees = await listWorktrees(gitRoot);
    const inUse = worktrees.find(w => w.branch === safeBranch);
    if (inUse) {
      throw new Error(
        `ブランチ '${safeBranch}' は既に別の worktree で使用中です: ${inUse.path}`
      );
    }

    const cleanup = await cleanupLocalBranch(gitRoot, safeBranch, baseRef);
    if (!cleanup.deleted) {
      attachExisting = true;
      console.log(
        `[Git] 既存ブランチ '${safeBranch}' を再利用して worktree を作成します${
          baseBranch ? `（baseBranch '${baseBranch}' は使用されません）` : ""
        }`
      );
    }
  }

  try {
    if (attachExisting) {
      await execAsync(`git worktree add "${worktreePath}" "${safeBranch}"`, {
        cwd: gitRoot,
      });
    } else {
      // Create the worktree with a new branch
      await execAsync(
        `git worktree add -b "${safeBranch}" "${worktreePath}" ${baseRef}`,
        {
          cwd: gitRoot,
        }
      );
    }
  } catch (error) {
    console.error(
      `[Git] worktree の作成に失敗しました (branch=${safeBranch}, path=${worktreePath}): ${getErrorMessage(error)}`
    );
    throw error;
  }

  // Get the created worktree info
  const worktrees = await listWorktrees(gitRoot);
  const created = worktrees.find(w => w.path === worktreePath);

  if (!created) {
    throw new Error("Failed to create worktree");
  }

  return created;
}

/** deleteWorktree の結果（ブランチ後始末の内訳） */
export interface DeleteWorktreeResult {
  /**
   * ローカルブランチ後始末の結果
   * - deleted: ブランチを削除した
   * - kept: ブランチを保持した（理由は branchKeptReason）
   * - skipped: 後始末対象なし（detached 等）
   */
  branchCleanup: "deleted" | "kept" | "skipped";
  /** 後始末対象のブランチ名（skipped の場合は undefined） */
  branch?: string;
  /** ブランチを保持した理由（kept の場合のみ） */
  branchKeptReason?: string;
}

// Delete a worktree
export async function deleteWorktree(
  repoPath: string,
  worktreePath: string
): Promise<DeleteWorktreeResult> {
  const safePath = validatePath(repoPath);
  const safeWorktreePath = validatePath(worktreePath);

  // Get the repository root
  const gitRoot = await getGitRoot(safePath);

  // Verify the worktree exists
  const worktrees = await listWorktrees(gitRoot);
  const worktree = worktrees.find(w => w.path === safeWorktreePath);

  if (!worktree) {
    throw new Error("Worktree not found");
  }

  if (worktree.isMain) {
    throw new Error("Cannot delete the main worktree");
  }

  // Remove the worktree
  try {
    await execAsync(`git worktree remove "${safeWorktreePath}" --force`, {
      cwd: gitRoot,
    });
  } catch (error) {
    console.error(
      `[Git] worktree の削除に失敗しました (${safeWorktreePath}): ${getErrorMessage(error)}`
    );
    // 後始末 (Issue #213 ④) は「Directory not empty」（削除途中の残骸）に限定する。
    // locked worktree や権限問題等、git が明示的に拒否したケースまで rm -rf しない
    if (!/directory not empty/i.test(getErrorMessage(error))) {
      throw error;
    }
    // 残骸ディレクトリを削除し、stale な管理情報を prune で整理する
    // （残骸が残ると、次回作成時に「作成先ディレクトリが既に存在します」で詰まる）
    try {
      if (fs.existsSync(safeWorktreePath)) {
        await fs.promises.rm(safeWorktreePath, {
          recursive: true,
          force: true,
        });
      }
      await execAsync("git worktree prune", { cwd: gitRoot });
    } catch (cleanupError) {
      console.error(
        `[Git] worktree の後始末に失敗しました (${safeWorktreePath}): ${getErrorMessage(cleanupError)}`
      );
      throw error;
    }
    if (fs.existsSync(safeWorktreePath)) {
      throw error;
    }
    console.log(`[Git] worktree の残骸を後始末しました (${safeWorktreePath})`);
  }

  // ローカルブランチの後始末 (Issue #213 ①)。detached 等は対象外
  const branch = worktree.branch;
  if (!branch || branch === "(detached)" || branch === "unknown") {
    return { branchCleanup: "skipped" };
  }

  // ブランチ名の検証だけを限定的に catch する。worktree 自体は削除済みなので
  // 名前不正は保持扱いに留め、それ以外の未知の例外は握りつぶさず伝播させる
  try {
    validateBranchName(branch);
  } catch {
    const reason = `ブランチ名 '${branch}' が不正なため後始末をスキップしました`;
    console.warn(`[Git] ${reason}`);
    return { branch, branchCleanup: "kept", branchKeptReason: reason };
  }

  const cleanup = await cleanupLocalBranch(gitRoot, branch);
  return {
    branch,
    branchCleanup: cleanup.deleted ? "deleted" : "kept",
    branchKeptReason: cleanup.keptReason,
  };
}

// Get list of branches
export async function listBranches(repoPath: string): Promise<string[]> {
  const safePath = validatePath(repoPath);

  const { stdout } = await execAsync(
    "git branch -a --format='%(refname:short)'",
    {
      cwd: safePath,
    }
  );

  return stdout
    .trim()
    .split("\n")
    .filter(b => b && !b.startsWith("origin/HEAD"));
}
