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
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
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
 * Electron .app の `app.asar.unpacked/` 配下に同梱された claude バイナリの
 * 絶対パスを返す。**spawn 可能であることが確認できた場合のみ非 null を返す**
 * (existsSync + isFile + X_OK)。
 *
 * `@anthropic-ai/claude-code` の platform 依存パッケージ
 * (`@anthropic-ai/claude-code-<platform>-<arch>`) が standalone な `claude`
 * 実行ファイルを同梱しており、electron-builder の smartUnpack が native バイナリ
 * として自動的に `app.asar.unpacked/` 側へ展開する。Electron は
 * `child_process.spawn` に対して asar 透過化を **行わない** (asar は単一ファイル
 * なので path component として辿れず ENOTDIR) ため、unpacked 側の実体パスを
 * 明示的に解決する必要がある。
 *
 * Linux サーバ版 / non-Electron では `process.resourcesPath` が undefined のため
 * このフォールバックはスキップされる。
 *
 * spawn 可能性まで確認することで、戻り値を信用する側が「return non-null = spawn
 * 安全」と仮定できる。candidate が directory / 権限なし / 壊れたリンクの場合は
 * null を返し、上位の system claude フォールバックに委ねる。
 *
 * Windows (`.exe` サフィックス) は現状 Ark .app の build target に含まれない
 * ため未対応。将来 Windows 版を出す際は `.exe` を加味した分岐をここに追加する。
 */
/**
 * `@anthropic-ai/claude-code` の platform 依存パッケージ名 (拡張子なし) の候補。
 * musl 環境 (Alpine 等) では `claude-code-linux-<arch>-musl` が install されるため、
 * glibc/musl の確実な判定が難しいことを踏まえ両方を候補として返す
 * (実際に install / 存在する方だけが解決される)。
 */
export function claudeCodePlatformPkgNames(): string[] {
  const { platform, arch } = process;
  if (platform === "darwin") {
    // Apple Silicon を x64 Node/Electron (Rosetta) で動かすと process.arch=x64 になるが、
    // claude-code は darwin-arm64 を install する (x64 バイナリは Apple Silicon で動かない)。
    // arm64 を優先候補にし、実際に install された方を解決する。Intel Mac では arm64 が
    // 未 install なので x64 にフォールバックする。
    return ["claude-code-darwin-arm64", "claude-code-darwin-x64"];
  }
  if (platform === "linux") {
    const base = `claude-code-linux-${arch}`;
    return [base, `${base}-musl`];
  }
  return [`claude-code-${platform}-${arch}`];
}

/** path が spawn 可能な実行ファイル (存在 + 通常ファイル + X_OK) なら返す。でなければ null */
function executableOrNull(candidate: string): string | null {
  try {
    if (!existsSync(candidate)) return null;
    if (!statSync(candidate).isFile()) return null;
    accessSync(candidate, constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * 指定 node_modules ディレクトリ配下から `@anthropic-ai/claude-code-<platform>`
 * 同梱 claude バイナリを探す。flat レイアウト (electron-builder が hoist した場合) と
 * pnpm の isolated レイアウト (`.pnpm/@anthropic-ai+<pkg>@<ver>/node_modules/...`) の
 * 両方を探索する。**spawn 可能な実体のみ返す**。
 *
 * desktop bootstrap (`main.ts`) でも同じ判定が必要なため export する。
 */
export function findBundledClaudeBinary(nodeModulesDir: string): string | null {
  for (const pkg of claudeCodePlatformPkgNames()) {
    // 1) flat レイアウト
    const flat = executableOrNull(
      path.join(nodeModulesDir, "@anthropic-ai", pkg, "claude")
    );
    if (flat) return flat;
    // 2) pnpm isolated レイアウト (`.pnpm/@anthropic-ai+<pkg>@<ver>/node_modules/...`)
    const pnpmDir = path.join(nodeModulesDir, ".pnpm");
    try {
      for (const entry of readdirSync(pnpmDir)) {
        if (!entry.startsWith(`@anthropic-ai+${pkg}@`)) continue;
        const bin = executableOrNull(
          path.join(
            pnpmDir,
            entry,
            "node_modules",
            "@anthropic-ai",
            pkg,
            "claude"
          )
        );
        if (bin) return bin;
      }
    } catch {
      // .pnpm ディレクトリ無し (flat レイアウト) → 無視
    }
  }
  // 注: 主パッケージ `@anthropic-ai/claude-code` の public bin (bin/claude.exe) は
  // フォールバックに使わない。postinstall 未実行時 (pnpm の ignored build scripts 等)
  // この bin は「claude native binary not installed」と表示して exit 1 する stub であり、
  // X_OK は通るが起動しない。native 実体を持つ platform パッケージのみを信頼する。
  return null;
}

function resolveUnpackedBundledClaudeExecutablePath(): string | null {
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (!resourcesPath) return null;
  // Windows ターゲットは未サポート (Ark .app は darwin / linux のみ build する)
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return null;
  }
  return findBundledClaudeBinary(
    path.join(resourcesPath, "app.asar.unpacked", "node_modules")
  );
}

/**
 * node_modules に install された `@anthropic-ai/claude-code-<platform>-<arch>`
 * パッケージ同梱の claude バイナリを Node モジュール解決で見つけて返す。
 * **spawn 可能な場合のみ非 null** (isFile + X_OK)。
 *
 * standalone な `@ark/server` 実行 (`pnpm dev:server` / pm2 `node dist/cli.js`)
 * で system に claude が無くても動くようにするフォールバック。
 *
 * 重要: `which claude` より **前** で解決する。`@anthropic-ai/claude-code` の
 * 主パッケージは `node_modules/.bin/claude` に launcher を作るが、これは
 * postinstall (native binary 取得) が走っていないと壊れている。`which claude`
 * を先に引くとこの壊れた launcher を掴む恐れがあるため、platform パッケージの
 * 実体バイナリを直接解決して優先する。
 */
function resolveNodeModulesClaudeBinary(): string | null {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return null;
  }
  // platform パッケージ (`claude-code-<platform>-<arch>`) は主パッケージ
  // `@anthropic-ai/claude-code` の optionalDependency。`@ark/server` の直接依存は
  // 主パッケージのみなので、まず主パッケージを解決し、その文脈 (optionalDep を
  // 宣言している場所) から platform パッケージを解決する。これで pnpm の isolated
  // レイアウトでも確実に platform バイナリへ辿り着ける。
  const require = createRequire(import.meta.url);
  const requireFroms: NodeJS.Require[] = [require];
  try {
    const mainPkgJson = require.resolve(
      "@anthropic-ai/claude-code/package.json"
    );
    requireFroms.push(createRequire(mainPkgJson));
  } catch {
    // 主パッケージが見つからなければ root からの解決のみ試す
  }
  for (const pkg of claudeCodePlatformPkgNames()) {
    for (const req of requireFroms) {
      try {
        const pkgJson = req.resolve(`@anthropic-ai/${pkg}/package.json`);
        const bin = executableOrNull(
          path.join(path.dirname(pkgJson), "claude")
        );
        if (bin) return bin;
      } catch {
        // この候補/解決元では見つからない → 次へ
      }
    }
  }
  return null;
}

/**
 * `claude` コマンドの絶対パスを解決する。利用不可なら null。
 * 解決ロジックは checkClaudeCommandExists と同じ順序。tmux send-keys に
 * 絶対パスで claude を送ることで、pm2/systemd の PATH に claude が無い
 * 環境でも「command not found」にならないようにする。
 */
export function resolveClaudePath(): string | null {
  // -1. Electron .app の `app.asar.unpacked` に同梱された claude バイナリ
  // (`@anthropic-ai/claude-code-<platform>-<arch>`)。配布物に常に含まれるため、
  // system PATH に claude が無い .app 環境でも確実に解決できる。
  // 戻り値は spawn 可能性まで確認済み (isFile + X_OK)、null なら下流に委譲。
  const bundledBin = resolveUnpackedBundledClaudeExecutablePath();
  if (bundledBin) return bundledBin;

  // -0.5. node_modules に install された platform パッケージ同梱バイナリ。
  // standalone server で system claude 不在でも動くようにする。
  // `which claude` より前に引いて、壊れた .bin/claude launcher の誤検出を避ける。
  const nodeModulesBin = resolveNodeModulesClaudeBinary();
  if (nodeModulesBin) return nodeModulesBin;

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
  // resolveClaudePath() の高優先解決と整合させる。これらを見ないと、
  // 同梱バイナリのみが claude 供給源の環境 (.app / standalone server で
  // node_modules 同梱版のみ) で session は動くのに multiProfileSupported が
  // false になり、UI がプロファイル/usage 機能を誤って隠してしまう。
  if (resolveUnpackedBundledClaudeExecutablePath()) return true;
  if (resolveNodeModulesClaudeBinary()) return true;

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
    // 旧 ARK_MULTI_PROFILE_MACOS env override は **削除**:
    // bridge が unsupported のまま enable すると CLAUDE_CONFIG_DIR だけ
    // 切り替わり Keychain credentials は固定のままで、wrong account で
    // session が走る silent regression を起こすため。
    // F6-followup で `keychain-profile-bridge.ts` の mode に応じた判定に
    // 置き換える (例: bridge.mode !== "unsupported" なら true)。
    return false;
  }
  if (process.platform !== "linux") return false;
  return checkClaudeCommandExists() && checkTmuxCommandExists();
}
