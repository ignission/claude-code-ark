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
import type { RepoInfo, Worktree } from "../../shared/types.js";

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
    throw new Error(`Directory already exists: ${worktreePath}`);
  }

  // Create the worktree with a new branch
  const baseRef = baseBranch ? validateBranchName(baseBranch) : "HEAD";

  await execAsync(
    `git worktree add -b "${safeBranch}" "${worktreePath}" ${baseRef}`,
    {
      cwd: gitRoot,
    }
  );

  // Get the created worktree info
  const worktrees = await listWorktrees(gitRoot);
  const created = worktrees.find(w => w.path === worktreePath);

  if (!created) {
    throw new Error("Failed to create worktree");
  }

  return created;
}

// Delete a worktree
export async function deleteWorktree(
  repoPath: string,
  worktreePath: string
): Promise<void> {
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
  await execAsync(`git worktree remove "${safeWorktreePath}" --force`, {
    cwd: gitRoot,
  });

  // Also delete the branch if it was created for this worktree
  try {
    await execAsync(`git branch -D "${worktree.branch}"`, {
      cwd: gitRoot,
    });
  } catch {
    // Branch might be used elsewhere, ignore error
  }
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
