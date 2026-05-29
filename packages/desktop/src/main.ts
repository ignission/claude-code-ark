/**
 * Ark Desktop - Electron メインプロセス
 *
 * `.app` 起動時に空きポートを確保し、`@ark/server` を同一プロセスで起動して
 * BrowserWindow に UI を表示する。Phase 3 でアプリメニュー / Tray / Dock /
 * macOS Application Support 配下へのデータパス移行を追加。
 *
 * 動作モード:
 *   - dev (ARK_DEV=1): サーバーを bootstrap で起動せず、Vite dev server
 *     (http://localhost:4000) のみ読み込む。Socket.IO 接続先は
 *     `packages/web/src/hooks/useSocket.ts` 内で `http://localhost:4001` に
 *     hardcode されているため、別途 `pnpm dev:server` を 4001 で起動する前提。
 *   - prod: 空きポートで `@ark/server` を埋め込み起動し、同 URL の UI を読み込む。
 *
 * データパス:
 *   - `app.setName("Ark")` を `app.whenReady()` 前に呼んで userData パスを
 *     `~/Library/Application Support/Ark/` に確定。
 *   - `process.env.ARK_DATA_DIR = app.getPath("userData")` を設定し、
 *     `@ark/server` 側の `paths.ts:getDataDir()` がそれを参照する。
 *   - これで F2 [P1-2]（Finder 起動 .app で `process.cwd()` が "/" になり書き込み
 *     不可になる問題）が解消される。
 *
 * ライフサイクル:
 *   - ウィンドウクローズ → メニューバー (Tray) からの復帰のため hide のみ
 *   - 明示的な Quit (メニュー / Tray / Cmd+Q) のみで `before-quit` 経由で停止
 *
 * フェーズ別 TODO:
 *   - F4 tmux/ttyd 同梱: extraResources の bin/ パスを binPaths として渡す
 *   - F4 PORT 安定化: `<userData>/server-port.json` で前回ポートを再利用
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// 型のみ import: ESM では `import type` は erase されるため、`@ark/server` の
// module-level singleton (db / fileUploadManager / browserManager) が import 評価
// 時に即時構築されない。`startServer` は `bootstrap()` 内で dynamic import で取得し、
// その時点では `configureAppPaths()` により `ARK_DATA_DIR` / `ARK_LOGS_DIR` が
// 設定済みであることを保証する。
import type { ServerHandle } from "@ark/server";
import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import log from "electron-log";
import { getAvailablePort } from "./getAvailablePort.js";
import { buildAppMenu } from "./menu.js";
import { createTray, destroyTray } from "./tray.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 開発モード判定。`ARK_DEV=1` で Vite dev server (localhost:4000) を読み込み、
 * それ以外は同梱サーバーから配信される `127.0.0.1:<port>/` を読み込む。
 */
const isDev = process.env.ARK_DEV === "1";

let serverHandle: ServerHandle | null = null;
let mainWindow: BrowserWindow | null = null;
/** before-quit → quit の流れか、close でのウィンドウ非表示かを区別するフラグ */
let isQuitting = false;
/**
 * bootstrap 完了フラグ。
 * `app.on("activate", ...)` が bootstrap 完了前に発火すると、
 * showMainWindow() 内で serverHandle 未設定のまま dev fallback port (4001) を
 * 使って空ウィンドウを生成してしまうのを防ぐ。
 */
let bootstrapped = false;

/**
 * `app.whenReady()` を待たずに有効な初期化処理。
 *
 * - `app.setName("Ark")`: `app.getPath("userData")` の末尾を `Ark/` に確定。
 *   これは `app.getPath` が呼ばれるより前に行う必要がある。
 * - `ARK_DATA_DIR` / `ARK_LOGS_DIR`: `@ark/server` が `paths.ts` 経由でこの
 *   環境変数を参照するため、`startServer()` 呼び出しより前に必ず設定する。
 *
 * **重要**: `@ark/server` 側の singleton (`db`, `fileUploadManager`) は
 * 構築時に `getDataDir()` / `getUploadsDir()` を遅延評価する作りになっており、
 * `startServer()` 呼び出し前に env を set すれば全プラットフォームで
 * Application Support / userData 配下に書き込みを向けられる。
 */
function configureAppPaths(): void {
  app.setName("Ark");
  // app.getPath は Electron の sync API。ready 前から userData / logs は有効。
  // 明示的に set された ARK_DATA_DIR / ARK_LOGS_DIR を尊重する。
  // 未設定時のみ Electron のデフォルトパスにフォールバック。
  // (テストや support reproduction で `ARK_DATA_DIR=/custom/path` を渡された際に
  //  silent に上書きされてしまうのを防ぐ)
  if (!process.env.ARK_DATA_DIR) {
    process.env.ARK_DATA_DIR = app.getPath("userData");
  }
  if (!process.env.ARK_LOGS_DIR) {
    process.env.ARK_LOGS_DIR = app.getPath("logs");
  }
  // F4 (決定事項 #12): Cloudflare Tunnel 機能を MVP スコープ外に。
  // `.app` 版ではリモートアクセス機能を無効化する。
  // 既に環境変数が set されている (例: 開発時に明示的に "true" にしたい) 場合は尊重。
  if (!process.env.ARK_FEATURE_TUNNEL) {
    process.env.ARK_FEATURE_TUNNEL = "false";
  }

  // F5: Claude CLI 同梱インストール先を server に伝える。
  // `@ark/server` 側 `system.ts:getClaudeRuntimeBinPath()` が
  // `<ARK_CLAUDE_RUNTIME_DIR>/bin/claude` を最優先で探す。
  // server は Electron module を import しない設計のため、env 経由で渡す。
  if (!process.env.ARK_CLAUDE_RUNTIME_DIR) {
    process.env.ARK_CLAUDE_RUNTIME_DIR = path.join(
      process.env.ARK_DATA_DIR ?? app.getPath("userData"),
      "claude-runtime"
    );
  }

  // electron-log の書き出し先を ARK_LOGS_DIR (override or Electron default) に揃える。
  // v5 系の resolvePathFn signature を使う。
  log.transports.file.resolvePathFn = () =>
    path.join(process.env.ARK_LOGS_DIR ?? app.getPath("logs"), "main.log");
  log.info("[Ark Desktop] configureAppPaths", {
    userData: process.env.ARK_DATA_DIR,
    logs: process.env.ARK_LOGS_DIR,
    platform: process.platform,
  });
}

/**
 * メインウィンドウへの参照を外部 (tray.ts など) から取得するためのアクセサ。
 * ウィンドウ未生成 / 破棄済みの場合は再構築する。
 */
export function showMainWindow(): void {
  // bootstrap 未完了時は tray/Dock/menu からの呼び出しでも空ウィンドウを開かない。
  // bootstrap が完了して createWindow が走るのを待つ (Electron の activate と同じガード)。
  if (!bootstrapped) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  // ウィンドウが破棄されている場合は再生成。
  // serverHandle が無い (dev mode / 未起動) ケースでは dev 用 4001 で開く。
  const port = serverHandle?.port ?? 4001;
  mainWindow = createWindow(port);
}

/**
 * BrowserWindow を生成し、UI をロードする。
 * dev: Vite が `http://localhost:4000` で配信する index.html を読み込む
 * prod: 同梱サーバーがリッスンする `http://127.0.0.1:<port>/` を読み込む
 *
 * クローズボタンは「Tray 常駐で hide のみ」とし、`before-quit` セットの
 * `isQuitting` が立った時のみ実際に終了させる。
 */
function createWindow(port: number): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      // F8: preload を有効化。renderer に `window.electronAPI` を inject し、
      // `ark:update-available` の IPC 受信を可能にする。
      // preload は CJS (dist/preload.js)、main は ESM (dist/main.js)。
      sandbox: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  const url = isDev ? "http://localhost:4000/" : `http://127.0.0.1:${port}/`;
  void win.loadURL(url);

  win.on("close", event => {
    // close-to-tray は macOS のみ。Linux/Windows では従来通り close で終了。
    if (process.platform !== "darwin") {
      return; // 通常クローズに任せる
    }
    // Quit 経路でなければ閉じずに hide。Tray から復帰可能。
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on("closed", () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  return win;
}

/**
 * `.app` の Resources/ に同梱された web 静的ファイルのパスを解決する。
 *
 * - dev (ARK_DEV=1): Vite dev server を使うため null を返す (静的配信なし)
 * - prod packaged: electron-builder が `extraResources` で
 *   `Contents/Resources/app/web/` に配置する想定。process.resourcesPath は
 *   `Contents/Resources` を指す
 * - prod unpackaged (`tsx src/main.ts` 等の素の Node 実行): リポジトリ内の
 *   `packages/web/dist` を fallback として使う。Phase 2 ではここはほぼ
 *   `pnpm --filter @ark/desktop dev` 経由で hit するため Vite を優先する
 *   作りにしているが、念のため非 dev 経路でも動かしやすくしておく。
 */
function resolveWebStaticDir(): string | undefined {
  if (isDev) return undefined;
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app", "web");
  }
  // Unpackaged な production 実行を想定した fallback。
  return path.resolve(__dirname, "../../web/dist");
}

async function bootstrap(): Promise<void> {
  // === fail-fast 前提条件チェック (bootstrap 副作用前) ===
  // 配布物不整合 (.app 同梱 claude binary 欠落) は ここで検知する。
  // installer 削除後は同梱 claude が唯一の保証経路で、欠落していると tmux セッション
  // 作成時まで障害が遅延する。さらに resolveClaudePath() が PATH 経由 system claude
  // (ユーザーが別途入れた version) にフォールバックし、同梱版と version が乖離した
  // 状態で動く危険もある。配布物不整合 (smartUnpack ルール変更 / 取り込み漏れ /
  // chmod 抜け) は配布側のバグなので、起動時点で確実に検知 + ユーザー通知する。
  // dev / unpackaged モードでは同梱 binary は存在しないので skip。
  //
  // 配置: tray / menu / server を起こす前に置くことで、半初期化状態を作らない
  // (codex P1 指摘対応)。
  if (app.isPackaged) {
    // glibc / musl (Alpine) で platform パッケージ名が異なるため両候補を確認する。
    // electron-builder の smartUnpack で install 済みの方だけが存在する。
    const base = `claude-code-${process.platform}-${process.arch}`;
    const pkgNames =
      process.platform === "linux" ? [base, `${base}-musl`] : [base];
    const candidatePaths = pkgNames.map(pkg =>
      path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        "@anthropic-ai",
        pkg,
        "claude"
      )
    );
    const verified = candidatePaths.find(p => {
      try {
        if (!fs.statSync(p).isFile()) return false;
        // X_OK: chmod 抜けや権限ビットの誤りも検知する。
        fs.accessSync(p, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
    if (verified) {
      log.info(`[Ark Desktop] bundled claude binary verified: ${verified}`);
    } else {
      const detail = candidatePaths.join("\n");
      log.error(
        `[Ark Desktop] bundled claude binary missing or not executable. checked:\n${detail}`
      );
      try {
        const { dialog } = await import("electron");
        dialog.showErrorBox(
          "Ark: bundled Claude CLI が見つかりません",
          `配布物の取り込み漏れが疑われます。Ark.app の再インストールをお試しください。\n\n参照パス:\n${detail}\n\n詳細はログを確認してください。`
        );
      } catch {
        // dialog 表示自体に失敗しても fail-fast 自体は継続する
      }
      throw new Error(
        `bundled claude binary not found in any of: ${candidatePaths.join(", ")}`
      );
    }
  }

  // F8: preload から外部 URL 起動を受け取って shell.openExternal に委譲する。
  // 同一 channel は重複登録不可のため、idempotent に register。
  ipcMain.handle("ark:open-external", async (_event, url: string) => {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      log.warn("[Ark Desktop] open-external rejected non-http(s):", url);
      return;
    }
    await shell.openExternal(url);
  });

  // アプリメニュー / Dock メニュー / Tray を ready 後に組み立てる。
  Menu.setApplicationMenu(
    buildAppMenu({ showMainWindow, quit: () => app.quit() })
  );

  if (process.platform === "darwin" && app.dock) {
    app.dock.setMenu(
      Menu.buildFromTemplate([
        { label: "Open Ark", click: () => showMainWindow() },
      ])
    );
  }

  // Tray は globalref しないと GC で消えるため tray.ts 側で module-level に保持。
  createTray({
    showMainWindow,
    quit: () => app.quit(),
    // 埋め込みサーバ URL を Tray の「Open Web URL...」から開けるよう露出する。
    // dev mode (`ARK_DEV=1`) / サーバ未起動時は null を返し、Tray 側で no-op になる。
    getServerUrl: () =>
      serverHandle ? `http://127.0.0.1:${serverHandle.port}/` : null,
  });

  // F5 (Claude CLI 自動インストール) は廃止 (issue #183 close, #186 で代替):
  // `@anthropic-ai/claude-code` 付属の standalone claude binary が
  // `app.asar.unpacked/node_modules/@anthropic-ai/claude-code-darwin-arm64/claude`
  // に常に同梱されており、tmux send-keys 経路でも resolveClaudePath() 経由で
  // 絶対パスで起動されるため、ユーザーへの追加 install (Node bundle + npm install)
  // は不要になった。配布物不整合の早期検知は bootstrap 冒頭の claude binary verify で実施。

  // F6: Keychain プロファイル bridge 初期化 (skeleton)
  // 現状 skeleton のため "unsupported" モードで動作。F0:B-3 検証結果次第で
  // passthrough / bridge モードに分岐する想定 (F6-followup)。
  // F6-followup: server (or socket handler) から bridge を呼び出せるように
  // (profile:create / profile:update / profile:delete / repo:set-profile /
  // session:restart-with-profile のハンドラから bridge を呼ぶ)。
  try {
    const { createKeychainProfileBridge } = await import(
      "./keychain-profile-bridge.js"
    );
    const keychainBridge = createKeychainProfileBridge();
    log.info("[Ark Desktop] keychain-bridge mode:", keychainBridge.mode);
    // F6-followup: server に bridge を inject する (現状はインスタンス生成のみ)。
    void keychainBridge;
  } catch (err) {
    log.error("[Ark Desktop] keychain-bridge init threw", err);
  }

  if (isDev) {
    // dev mode: 別途 `pnpm dev:server` が 4001 で起動している前提。
    // useSocket.ts の dev 分岐が `http://localhost:4001` に hardcode で
    // 接続するため、ここで ephemeral port にサーバーを起動すると
    // Socket.IO の接続先がミスマッチして UI が空になる。
    mainWindow = createWindow(4001);
    bootstrapped = true;
    return;
  }

  // production: サーバーを埋め込み起動する
  // ARK_PORT 環境変数があれば固定ポート、未指定なら動的取得 (通常起動)。
  // 公開された設定項目として扱い、リバースプロキシ前提のセットアップや CI smoke
  // test (issue #181) など、外側から listen ポートを固定したい全ユースケースで使う。
  //
  // バリデーションは「十進数字のみ (`1e3` / `0x50` / `1.5` は不可) かつ 1..65535」
  // を厳格に課す (`Number()` 単独だと指数表記や 16 進表記を通してしまうため)。
  // 明示設定が不正なら静かに動的取得へ落とさず throw する: silent fallback だと
  // reverse proxy が固定ポートを前提にしているのに別ポートで listen して壊れる。
  const envPortRaw = process.env.ARK_PORT;
  let port: number;
  if (envPortRaw === undefined) {
    port = await getAvailablePort();
  } else {
    // 空文字も「明示的に不正値が入った」と見なして fail-fast する。
    // 設定テンプレートの埋め込みミス (`ARK_PORT=""`) を silent fallback で
    // 隠さず、利用側に固定ポート前提が崩れたことを即座に伝える。
    if (!/^[1-9][0-9]*$/.test(envPortRaw)) {
      throw new Error(
        `Invalid ARK_PORT: '${envPortRaw}'. 要件: 1..65535 の十進整数 (空文字 / 先頭 0 / 指数表記 / 16 進表記は不可)`
      );
    }
    const parsed = Number(envPortRaw);
    if (parsed < 1 || parsed > 65535) {
      throw new Error(`ARK_PORT out of range: ${parsed}. 要件: 1..65535`);
    }
    port = parsed;
  }
  // dynamic import: ここで初めて `@ark/server` を評価することで、
  // module-level singleton (db / fileUploadManager / browserManager) が
  // `configureAppPaths()` で set 済みの `ARK_DATA_DIR` / `ARK_LOGS_DIR` を
  // 読み取った状態で構築される。static import にすると import 評価が
  // module top で走り、`configureAppPaths()` より前に singleton が
  // `process.cwd()/data` (Finder 起動時は `/data`) に紐付いてしまう。
  const { startServer } = await import("@ark/server");
  serverHandle = await startServer({
    port,
    webStaticDir: resolveWebStaticDir(),
    // Electron は ephemeral port で毎回 port が変わるため、
    // `/tmp/ark-tunnel-state.json` の port を信用して proxy すると
    // 存在しない port を指してリモートアクセスが切れる。
    // よって auto-recovery 自体を無効化する。
    disableTunnelAutoRecovery: true,
    // F4 で binPaths を渡す
  });
  log.info("[Ark Desktop] server started", { port: serverHandle.port });

  mainWindow = createWindow(serverHandle.port);
  bootstrapped = true;

  // F8: 更新通知システムを起動。GitHub Releases API を 24h ごとに polling し、
  // 新版があれば mainWindow に `ark:update-available` IPC を送信する。
  // mainWindow は閉じる/再生成されうるため、最新参照を返すクロージャを渡す。
  // `ARK_DISABLE_UPDATE_CHECK=1` で無効化可能 (preferences 永続化は F8-followup)。
  try {
    const { startUpdateChecker } = await import("./update-checker.js");
    startUpdateChecker(() => mainWindow);
  } catch (err) {
    log.error("[Ark Desktop] update-checker init threw", err);
  }
}

// `app.whenReady()` 前に呼ぶ必要のあるパス系初期化を即時実行。
configureAppPaths();

app
  .whenReady()
  .then(bootstrap)
  .catch(error => {
    log.error("[Ark Desktop] Failed to bootstrap:", error);
    console.error("[Ark Desktop] Failed to bootstrap:", error);
    app.quit();
  });

// macOS では Dock / Tray から復帰できるよう、全ウィンドウ閉鎖でも quit しない。
// その他プラットフォームは従来通り。
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  // Dock アイコンクリック等での復帰。
  // bootstrap 未完了時は何もしない。serverHandle 未設定のまま showMainWindow()
  // を呼ぶと dev fallback の 4001 で BrowserWindow を生成してしまい、
  // production の埋め込みサーバ port を取り逃して空ウィンドウになる。
  // bootstrap 完了後に自前で mainWindow を作るので無視で問題ない。
  if (!bootstrapped) return;
  showMainWindow();
});

app.on("before-quit", async event => {
  isQuitting = true;
  destroyTray();

  // F8: 更新チェッカーの timer を停止。間隔タイマーが残ると quit 後も
  // event loop が抜けず、プロセスが終了しない可能性がある。
  try {
    const { stopUpdateChecker } = await import("./update-checker.js");
    stopUpdateChecker();
  } catch (err) {
    log.error("[Ark Desktop] update-checker stop threw", err);
  }

  // 既に停止済みなら何もしない。stop() は idempotent。
  if (!serverHandle) return;
  // stop は非同期だが before-quit は同期前提のため、event.preventDefault()
  // で一時的にキャンセルし、停止完了後に再度 app.quit() を呼ぶ。
  event.preventDefault();
  const handle = serverHandle;
  serverHandle = null;
  try {
    await handle.stop();
  } catch (error) {
    log.error("[Ark Desktop] Failed to stop server:", error);
    console.error("[Ark Desktop] Failed to stop server:", error);
  }
  app.quit();
});
