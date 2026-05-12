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
import { getBundledBinDir } from "./paths.js";

/**
 * F5: Claude CLI 自動インストーラー (`packages/desktop/src/claude-installer.ts`)
 * によって `<userData>/claude-runtime/bin/claude` に同梱インストールされた
 * Claude CLI の絶対パスを返す。
 *
 * 解決順:
 *   1. `ARK_CLAUDE_RUNTIME_DIR` 環境変数（Electron main 側で
 *      `app.getPath("userData")/claude-runtime` を明示注入する想定）
 *   2. `ARK_DATA_DIR/claude-runtime`（フォールバック: ARK_DATA_DIR が
 *      Electron 経由で set 済みの場合、明示的な ARK_CLAUDE_RUNTIME_DIR が
 *      無くても同梱版を見つけられるようにする）
 *
 * いずれも未 set または `bin/claude` が存在しない場合は null を返し、
 * 呼び出し側は既存の検索ロジック（PATH / npm global / mise 等）にフォールバック。
 *
 * Note: server コードは Electron module を import しない設計のため、
 * userData パスは環境変数経由でしか取得できない。
 *
 * F5 known limitation (F0:B-2 / mac 実機検証待ち):
 * 同梱版 `<claude-runtime>/bin/claude` は npm install で生成される
 * Node shim (shebang `#!/usr/bin/env node`)。System PATH に node が
 * 無いと実行不能。Bundled Node を使う wrapping は F5-followup で対応。
 * 詳細は `packages/desktop/src/claude-installer.ts` 冒頭コメント参照。
 */
function getClaudeRuntimeBinPath(): string | null {
  const runtimeDir =
    process.env.ARK_CLAUDE_RUNTIME_DIR ??
    (process.env.ARK_DATA_DIR
      ? path.join(process.env.ARK_DATA_DIR, "claude-runtime")
      : null);
  if (!runtimeDir) return null;
  const candidate = path.join(runtimeDir, "bin", "claude");
  try {
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

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
 * `claude` コマンドの絶対パスを解決する。利用不可なら null。
 * 解決ロジックは checkClaudeCommandExists と同じ順序。tmux send-keys に
 * 絶対パスで claude を送ることで、pm2/systemd の PATH に claude が無い
 * 環境でも「command not found」にならないようにする。
 */
export function resolveClaudePath(): string | null {
  // 0. F5 同梱版: `<userData>/claude-runtime/bin/claude` を最優先
  // Electron desktop でユーザに余計なセットアップを求めずに済むよう、
  // システム claude より前に同梱インストール版をチェックする。
  const runtimeBin = getClaudeRuntimeBinPath();
  if (runtimeBin) return runtimeBin;

  try {
    const r = spawnSync("which", ["claude"], {
      stdio: "pipe",
      encoding: "utf-8",
    });
    if (r.status === 0 && r.stdout) {
      const resolved = r.stdout.trim();
      if (resolved) return resolved;
    }
  } catch {
    // fallthrough
  }

  const envPath = process.env.PATH ?? "";
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "claude");
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, ".local/bin/claude"),
    path.join(home, ".local/share/mise/shims/claude"),
    path.join(home, ".npm-global/bin/claude"),
    path.join(home, ".volta/bin/claude"),
    "/usr/local/bin/claude",
    "/usr/bin/claude",
    "/usr/sbin/claude",
    "/opt/claude/bin/claude",
    "/home/linuxbrew/.linuxbrew/bin/claude",
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {
      // ignore
    }
  }

  // nvm / fnm: 各 version 配下を走査
  const nvm = scanVersionedDir(
    path.join(home, ".nvm/versions/node"),
    "bin/claude"
  );
  if (nvm) return nvm;
  const fnmShare = scanVersionedDir(
    path.join(home, ".local/share/fnm/node-versions"),
    "installation/bin/claude"
  );
  if (fnmShare) return fnmShare;
  const fnm = scanVersionedDir(
    path.join(home, ".fnm/node-versions"),
    "bin/claude"
  );
  if (fnm) return fnm;

  return null;
}

/** versioned dir 配下から最初に見つかった絶対パスを返す */
function scanVersionedDir(baseDir: string, suffix: string): string | null {
  try {
    const entries = readdirSync(baseDir);
    for (const entry of entries) {
      const candidate = path.join(baseDir, entry, suffix);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * `claude` コマンドが利用可能か。
 * 1. `which claude` (PATH チェック)
 * 2. process.env.PATH を分解して各 dir で確認
 *    (pm2 等で which が機能しない / login PATH と異なる場合をカバー)
 * 3. 既知の候補ディレクトリ (mise shims, npm global, apt/dpkg, brew 等)
 */
export function checkClaudeCommandExists(): boolean {
  // 0. F5 同梱版: `<userData>/claude-runtime/bin/claude`
  // resolveClaudePath() と同じく最優先でチェックし、Electron desktop で
  // システム claude 未インストールでもプロファイル切替が利用可能になる
  // ようにする。
  if (getClaudeRuntimeBinPath()) return true;

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
 * `tmux` コマンドの絶対パスを解決する。利用不可なら null。
 * 0. `getBundledBinDir()` 配下の `tmux` を最優先で確認
 *    （Electron packaged アプリでは `.app/Contents/Resources/bin/tmux` を使う）
 * 1. `which tmux` (PATH チェック)
 * 2. process.env.PATH を分解して各 dir で確認
 *    (pm2 等で which が機能しない / login PATH と異なる場合をカバー)
 * 3. 既知の候補ディレクトリ
 *
 * 子プロセス起動時に絶対パスを使うと、pm2/systemd で PATH に tmux が
 * 含まれていない環境でも spawnSync が ENOENT にならない。
 */
export function resolveTmuxPath(): string | null {
  // 0. 同梱バイナリ優先 (F4: Electron packaged 環境向け)
  const bundledDir = getBundledBinDir();
  if (bundledDir) {
    const bundled = path.join(bundledDir, "tmux");
    try {
      if (existsSync(bundled)) return bundled;
    } catch {
      // ignore: 通常の解決ロジックにフォールバック
    }
  }

  try {
    const r = spawnSync("which", ["tmux"], {
      stdio: "pipe",
      encoding: "utf-8",
    });
    if (r.status === 0 && r.stdout) {
      const resolved = r.stdout.trim();
      if (resolved) return resolved;
    }
  } catch {
    // fallthrough
  }

  // process.env.PATH を辿る
  const envPath = process.env.PATH ?? "";
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "tmux");
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }

  // 既知の候補ディレクトリ
  const candidates = [
    "/usr/bin/tmux",
    "/usr/local/bin/tmux",
    "/bin/tmux",
    "/opt/homebrew/bin/tmux",
    "/home/linuxbrew/.linuxbrew/bin/tmux",
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

/** `tmux` コマンドが利用可能か。 */
export function checkTmuxCommandExists(): boolean {
  return resolveTmuxPath() !== null;
}

/**
 * `pm2` コマンドの絶対パスを解決する。利用不可なら null。
 * pm2 自身が pm2/systemd 経由でArkを起動しているケースでも、
 * 子プロセスのPATHにユーザーローカルのpm2が含まれないことがあるため、
 * resolveClaudePath / resolveTmuxPath と同じ多段フォールバックで解決する。
 */
export function resolvePm2Path(): string | null {
  try {
    const r = spawnSync("which", ["pm2"], {
      stdio: "pipe",
      encoding: "utf-8",
    });
    if (r.status === 0 && r.stdout) {
      const resolved = r.stdout.trim();
      if (resolved) return resolved;
    }
  } catch {
    // fallthrough
  }

  const envPath = process.env.PATH ?? "";
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "pm2");
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, ".local/bin/pm2"),
    path.join(home, ".local/share/mise/shims/pm2"),
    path.join(home, ".npm-global/bin/pm2"),
    path.join(home, ".volta/bin/pm2"),
    "/usr/local/bin/pm2",
    "/usr/bin/pm2",
    "/opt/pm2/bin/pm2",
    "/home/linuxbrew/.linuxbrew/bin/pm2",
    "/opt/homebrew/bin/pm2",
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * プロファイル切替機能のサポート判定。
 * Linux + claude CLI + tmux が3つ揃った時のみ true。
 * (UsageCollector も tmux を必要とするため tmux チェックも含める)
 *
 * F6 (F0:B-3 検証待ち): macOS は既存制約 C-3 のためデフォルト false。
 * `ARK_MULTI_PROFILE_MACOS=1` で強制 enable できる (検証/開発用)。
 * 本実装 (検証結果に応じた分岐) は F6-followup で
 * `packages/desktop/src/keychain-profile-bridge.ts` と連携して追加する。
 */
export function detectMultiProfileSupported(): boolean {
  if (process.platform === "darwin") {
    // F6 (F0:B-3 検証待ち): デフォルト false。
    // ARK_MULTI_PROFILE_MACOS=1 で強制 enable (検証用 / Keychain bridge 実装後に
    // デフォルト判定へ移行する想定)。
    if (process.env.ARK_MULTI_PROFILE_MACOS === "1") {
      return checkClaudeCommandExists() && checkTmuxCommandExists();
    }
    return false; // F6-followup で false 削除予定
  }
  if (process.platform !== "linux") return false;
  return checkClaudeCommandExists() && checkTmuxCommandExists();
}
