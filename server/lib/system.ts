/**
 * System Capability Detection
 *
 * 起動環境がプロファイル切替機能をサポートするか判定するヘルパー。
 *
 * 条件:
 *   - process.platform === "linux"
 *   - `claude` CLI が見つかる（PATH または既知の候補ディレクトリ）
 *
 * macOS / Windows は Keychain 依存のため非対応。
 *
 * 注: pm2 等のサービスマネージャ経由で起動された場合、ログインシェルと
 * PATH が異なるため `which claude` だけだと検知漏れする。`~/.local/bin`
 * 等の典型的な場所も直接チェックする。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `<baseDir>/<version>/<suffix>` の形式で claude が存在するかを走査する。
 * nvm / fnm のように Node.js バージョンごとに bin が別ディレクトリになる
 * 場合の検出に使う。
 */
function existsInVersionedDirs(baseDir: string, suffix: string): boolean {
  try {
    const entries = readdirSync(baseDir);
    for (const entry of entries) {
      const candidate = path.join(baseDir, entry, suffix);
      try {
        if (existsSync(candidate)) return true;
      } catch {
        // ignore
      }
    }
  } catch {
    // baseDir が存在しない等は無視
  }
  return false;
}

/**
 * `claude` コマンドが利用可能か。
 * 1. `which claude` (PATH チェック)
 * 2. process.env.PATH を分解して各 dir で確認
 *    (pm2 等で which が機能しない / login PATH と異なる場合をカバー)
 * 3. 既知の候補ディレクトリ (mise shims, npm global, apt/dpkg, brew 等)
 */
export function checkClaudeCommandExists(): boolean {
  try {
    const r = spawnSync("which", ["claude"], { stdio: "pipe" });
    if (r.status === 0) return true;
  } catch {
    // fallthrough
  }

  // process.env.PATH を辿る (which が使えない環境向けの補完)
  const envPath = process.env.PATH ?? "";
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "claude");
    try {
      if (existsSync(candidate)) return true;
    } catch {
      // ignore individual stat errors
    }
  }

  const home = os.homedir();
  const candidates = [
    // ユーザローカル
    path.join(home, ".local/bin/claude"),
    path.join(home, ".local/share/mise/shims/claude"),
    path.join(home, ".npm-global/bin/claude"),
    path.join(home, ".volta/bin/claude"),
    // システム標準
    "/usr/local/bin/claude",
    "/usr/bin/claude",
    "/usr/sbin/claude",
    "/opt/claude/bin/claude",
    // Homebrew (Linux)
    "/home/linuxbrew/.linuxbrew/bin/claude",
  ];
  if (
    candidates.some(p => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    })
  ) {
    return true;
  }

  // nvm / fnm: Node.js バージョンごとに bin が別ディレクトリになるので
  // ベースディレクトリを走査して各 version 配下の bin/claude を確認する
  if (
    existsInVersionedDirs(path.join(home, ".nvm/versions/node"), "bin/claude")
  ) {
    return true;
  }
  if (
    existsInVersionedDirs(
      path.join(home, ".local/share/fnm/node-versions"),
      "installation/bin/claude"
    )
  ) {
    return true;
  }
  if (
    existsInVersionedDirs(path.join(home, ".fnm/node-versions"), "bin/claude")
  ) {
    return true;
  }

  return false;
}

/**
 * `tmux` コマンドが利用可能か。
 * 1. `which tmux` (PATH チェック)
 * 2. process.env.PATH を分解して各 dir で確認
 *    (pm2 等で which が機能しない / login PATH と異なる場合をカバー)
 * 3. 既知の候補ディレクトリ
 */
export function checkTmuxCommandExists(): boolean {
  try {
    const r = spawnSync("which", ["tmux"], { stdio: "pipe" });
    if (r.status === 0) return true;
  } catch {
    // fallthrough
  }

  // process.env.PATH を辿る (which が使えない環境向けの補完)
  const envPath = process.env.PATH ?? "";
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "tmux");
    try {
      if (existsSync(candidate)) return true;
    } catch {
      // ignore
    }
  }

  // 既知の候補ディレクトリ
  const candidates = [
    "/usr/bin/tmux",
    "/usr/local/bin/tmux",
    "/opt/homebrew/bin/tmux",
    "/home/linuxbrew/.linuxbrew/bin/tmux",
  ];
  return candidates.some(p => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  });
}

/**
 * プロファイル切替機能のサポート判定。
 * Linux + claude CLI + tmux が3つ揃った時のみ true。
 * (UsageCollector も tmux を必要とするため tmux チェックも含める)
 */
export function detectMultiProfileSupported(): boolean {
  if (process.platform !== "linux") return false;
  return checkClaudeCommandExists() && checkTmuxCommandExists();
}
