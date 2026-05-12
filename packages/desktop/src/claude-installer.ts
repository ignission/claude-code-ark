/**
 * F5: Claude CLI 自動インストーラー (skeleton)
 *
 * 起動時に `claude` の存在を検出し、未インストールなら同梱 Node.js 経由で
 * `npm install -g @anthropic-ai/claude-code` を実行する。
 *
 * インストール先:
 *   - npm prefix: `<userData>/claude-runtime/`
 *   - 結果: `<userData>/claude-runtime/bin/claude` が生成される
 *
 * 同梱 Node.js:
 *   - production (packaged): `<process.resourcesPath>/bin/node`
 *     かつ `<process.resourcesPath>/bin/lib/node_modules/npm/bin/npm-cli.js`
 *   - dev / unpackaged: skip (system claude / system node に依存)
 *
 * 設計上の注記:
 *   - server コードは Electron module を import しない設計のため、
 *     インストール先パス情報は ARK_CLAUDE_RUNTIME_DIR 環境変数で server に渡す
 *     (`packages/server/src/lib/system.ts` の `getClaudeRuntimeBinPath()` が読む)
 *   - F0:B-2 の検証結果次第で方式 B (スタンドアロンバイナリ) や方式 C (brew install)
 *     に切り替え可能な作りにしておく (interface ベース)
 *   - 本ファイルは skeleton: 実際の Node 同梱は F0:B-2 結果待ちで F5-followup へ
 *     deferred。skeleton 段階では packaged 時に同梱 node が見つからなければ
 *     system claude (`@ark/server` の system.ts) にフォールバックする。
 *
 * F5 known limitation (F0:B-2 / mac 実機検証待ち):
 *
 * npm install で生成される `<claude-runtime>/bin/claude` は
 * `#!/usr/bin/env node` shebang を持つ shim script。
 * System PATH に node が無い環境では実行できない。
 *
 * 解決案 (F5-followup):
 *   1. wrapper script を同梱: `bin/claude` を上書きして
 *      `#!/<bundled-node-path>` に書き換える
 *   2. spawn 時に `<bundled-node> <claude-shim>` で起動する形に
 *      ttyd-manager / tmux-manager 等を改修
 *   3. Anthropic から bundled binary distribution が出るのを待つ
 *
 * mac 実機検証で実 install 後の `bin/claude` 内容を確認してから決定。
 */

import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import log from "electron-log";

/**
 * インストーラー呼び出し時のオプション。
 *
 * `onProgress` は renderer 側に IPC 経由で進捗を伝えるための callback。
 * F5 skeleton 段階では main 側で electron-log に出力するのみで、
 * F5-followup で IPC bridge を介して `ClaudeInstallProgressDialog.tsx` に
 * 配信する想定。
 */
export interface ClaudeInstallerOptions {
  /** 進捗イベント callback (renderer に IPC 経由で送る用) */
  onProgress?: (event: ClaudeInstallProgressEvent) => void;
}

/**
 * インストール進捗イベント。renderer 側の状態機械と一致するよう、
 * `ClaudeInstallProgressDialog.tsx` で同名の discriminated union を再現する。
 */
export type ClaudeInstallProgressEvent =
  | { type: "checking" }
  | { type: "already-installed"; path: string }
  | { type: "node-missing"; message: string }
  | { type: "installing"; output: string }
  | { type: "completed"; path: string }
  | { type: "failed"; error: string };

/**
 * 同梱 Node.js バイナリのパスを返す。
 *
 * - production (packaged): `<process.resourcesPath>/bin/node`
 * - dev / unpackaged: 常に null（system node 依存で OK）
 *
 * 存在チェック付き。`Resources/bin/node` を CI で配置する仕組みは F0:B-2 確定後に
 * F5-followup で実装する想定。
 */
export function resolveBundledNodePath(): string | null {
  if (!app.isPackaged) return null;
  const candidate = path.join(process.resourcesPath, "bin", "node");
  try {
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * 同梱 npm CLI (`npm-cli.js`) のパスを返す。
 *
 * Node.js 公式 distribution には npm が同梱されており、tarball の構造は
 *   `node-v<X>-darwin-arm64/`
 *     ├── bin/node
 *     └── lib/node_modules/npm/bin/npm-cli.js
 * となっている。Resources/bin/ に node + lib/ をまるごと展開する前提。
 *
 * F5-followup で `build-assets/node/` 配置レイアウトを確定する際に、ここで
 * 期待する path が崩れないように注意する。
 */
export function resolveBundledNpmCliPath(nodeBin: string): string | null {
  // build-assets/README.md の想定レイアウト:
  //   `<process.resourcesPath>/bin/node`
  //   `<process.resourcesPath>/bin/lib/node_modules/npm/bin/npm-cli.js`
  // すなわち node と同階層の `bin/` 配下に `lib/` がぶら下がる構造。
  // `path.dirname(nodeBin)` = `<resources>/bin` を起点に lib/... を join する。
  const binDir = path.dirname(nodeBin);
  const candidate = path.join(
    binDir,
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js"
  );
  try {
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Claude CLI の同梱インストール先ディレクトリ。
 * 同名のディレクトリは server 側の `getClaudeRuntimeBinPath()` でも参照される
 * （`ARK_CLAUDE_RUNTIME_DIR` 経由）。
 *
 * server 側 `system.ts:getClaudeRuntimeBinPath()` と解決順を一致させる:
 *   1. `ARK_CLAUDE_RUNTIME_DIR` (明示的 override) を最優先
 *   2. `ARK_DATA_DIR/claude-runtime` (`configureAppPaths` でセットされる場合)
 *   3. `app.getPath("userData")/claude-runtime` (Electron default)
 *
 * env override が無視されると「installer は A に install、server は B を探す」
 * という不整合が発生するため、両者で同じロジックを使う。
 */
export function getClaudeRuntimeDir(): string {
  if (process.env.ARK_CLAUDE_RUNTIME_DIR) {
    return process.env.ARK_CLAUDE_RUNTIME_DIR;
  }
  if (process.env.ARK_DATA_DIR) {
    return path.join(process.env.ARK_DATA_DIR, "claude-runtime");
  }
  return path.join(app.getPath("userData"), "claude-runtime");
}

/**
 * Claude CLI の検出 (F5 同梱版のみ)。
 *
 * server 側の `system.ts:resolveClaudePath()` がより広い候補（PATH, mise, brew, nvm 等）
 * を探すため、main プロセス側ではまず同梱版のみチェックし、
 * 見つからなければ「インストールが必要 or system claude を使う」を判定する。
 */
export function detectClaudeCommand(): string | null {
  const runtimeBin = path.join(getClaudeRuntimeDir(), "bin", "claude");
  try {
    return fs.existsSync(runtimeBin) ? runtimeBin : null;
  } catch {
    return null;
  }
}

/**
 * System PATH 上に `claude` が既にインストール済みかを検出する。
 *
 * `which claude` の出力を見て、存在するパスを返す。`which` が無い環境や
 * `claude` が PATH に無い場合は null。
 *
 * server 側の `system.ts:checkClaudeCommandExists()` はより広い候補を探す
 * が、ここでは installer の早期 skip 判定用なので `which` ベースで十分。
 * import 循環を避けるため server module は使わない。
 */
export function detectSystemClaude(): string | null {
  try {
    const result = execSync("which claude", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const resolved = result.trim();
    if (!resolved) return null;
    return fs.existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Claude CLI を同梱 Node 経由で npm install する (skeleton)。
 *
 * 振る舞い:
 *   1. `checking` イベントを発火
 *   2. 既にインストール済みなら `already-installed` で早期 return
 *   3. 同梱 Node が無ければ `node-missing` を発火し、resolve(silent)
 *      (system claude へのフォールバックは server 側で行う)
 *   4. 同梱 npm-cli.js が無ければ `failed` を発火し、reject せず resolve
 *      (起動を継続させる)
 *   5. `<nodeBin> <npmCli> install -g --prefix <runtimeDir> @anthropic-ai/claude-code` を spawn
 *   6. 進捗 stdout/stderr を `installing` で逐次配信
 *   7. exit 0 かつ `bin/claude` 生成成功なら `completed`、それ以外は `failed`
 *
 * F5 skeleton では fatal な失敗でも reject しない方針: アプリ起動を止めないため、
 * 失敗時は log + onProgress のみで上位に伝え、呼び出し側 (`main.ts:bootstrap`) は
 * try/catch で全て吸収する。本格的なリトライ UI は F5-followup で `ClaudeInstallProgressDialog`
 * 側に実装する。
 */
export async function installClaudeCli(
  options: ClaudeInstallerOptions = {}
): Promise<void> {
  const { onProgress } = options;
  onProgress?.({ type: "checking" });

  // 1) 既にインストール済み (F5 同梱版) の場合は早期 return
  const existingPath = detectClaudeCommand();
  if (existingPath) {
    onProgress?.({ type: "already-installed", path: existingPath });
    return;
  }

  // 1.5) system PATH 上に claude があれば auto-install を skip し system 版を使う。
  // ユーザが既に brew / mise / npm 等で claude を入れている場合に
  // 二重インストールを避ける。server 側の resolveClaudePath() は同梱版が
  // 無ければ system 版を見つけられるため、ここで return しても起動は問題ない。
  const systemPath = detectSystemClaude();
  if (systemPath) {
    onProgress?.({ type: "already-installed", path: systemPath });
    log.info("[claude-installer] Using system claude:", systemPath);
    return;
  }

  // 2) 同梱 Node が無い場合 (dev mode / unpackaged / Resources/bin/node 未配置) は skip
  const nodeBin = resolveBundledNodePath();
  if (!nodeBin) {
    const message = app.isPackaged
      ? "Bundled Node.js not found at Resources/bin/node. F5 installer requires Node distribution to be bundled in CI (deferred to F5-followup). Falling back to system claude."
      : "Skipping bundled Node.js install in dev/unpackaged mode. Using system claude.";
    onProgress?.({ type: "node-missing", message });
    log.info("[claude-installer] node-missing", { message });
    return;
  }

  // 3) 同梱 npm-cli.js が無い場合は明示的に failed (起動は継続)
  const npmCli = resolveBundledNpmCliPath(nodeBin);
  if (!npmCli) {
    const error = `Bundled npm not found near ${nodeBin}. Need to bundle full Node distribution including lib/node_modules/npm.`;
    onProgress?.({ type: "failed", error });
    log.error("[claude-installer] failed", { error });
    return;
  }

  // 4) runtime ディレクトリを mkdir -p
  const runtimeDir = getClaudeRuntimeDir();
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
  } catch (err) {
    const error = `Failed to create runtime dir ${runtimeDir}: ${err instanceof Error ? err.message : String(err)}`;
    onProgress?.({ type: "failed", error });
    log.error("[claude-installer] mkdir failed", { error });
    return;
  }

  // 5) npm install を spawn
  log.info("[claude-installer] starting install", {
    nodeBin,
    npmCli,
    runtimeDir,
  });

  await new Promise<void>(resolve => {
    const proc = spawn(
      nodeBin,
      [
        npmCli,
        "install",
        "-g",
        "--prefix",
        runtimeDir,
        "@anthropic-ai/claude-code",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        // PATH に system node が含まれていても、`spawn(nodeBin, ...)` で
        // 同梱 node を直接指定しているため衝突しない。env はそのまま継承。
        env: { ...process.env },
      }
    );

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", chunk => {
      const text = chunk.toString();
      stdout += text;
      onProgress?.({ type: "installing", output: text });
    });
    proc.stderr?.on("data", chunk => {
      const text = chunk.toString();
      stderr += text;
      onProgress?.({ type: "installing", output: text });
    });

    proc.on("close", code => {
      if (code === 0) {
        const installedPath = path.join(runtimeDir, "bin", "claude");
        if (fs.existsSync(installedPath)) {
          onProgress?.({ type: "completed", path: installedPath });
          log.info("[claude-installer] completed", { path: installedPath });
        } else {
          const error = `npm install completed but ${installedPath} not found`;
          onProgress?.({ type: "failed", error });
          log.error("[claude-installer] post-install verification failed", {
            error,
          });
        }
      } else {
        const error = `npm install failed with exit code ${code}: ${stderr || stdout}`;
        onProgress?.({ type: "failed", error });
        log.error("[claude-installer] install failed", { code, stderr });
      }
      resolve();
    });

    proc.on("error", err => {
      const error = err instanceof Error ? err.message : String(err);
      onProgress?.({ type: "failed", error });
      log.error("[claude-installer] spawn error", { error });
      resolve();
    });
  });
}
