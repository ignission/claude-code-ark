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
import path from "node:path";
import { fileURLToPath } from "node:url";
// 型のみ import: ESM では `import type` は erase されるため、`@ark/server` の
// module-level singleton (db / fileUploadManager / browserManager) が import 評価
// 時に即時構築されない。`startServer` は `bootstrap()` 内で dynamic import で取得し、
// その時点では `configureAppPaths()` により `ARK_DATA_DIR` / `ARK_LOGS_DIR` が
// 設定済みであることを保証する。
import type { ServerHandle } from "@ark/server";
import { app, BrowserWindow, Menu } from "electron";
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
      // Phase 2 では preload は使わない。F3 以降で IPC を追加する場合に導入。
      sandbox: false,
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

  if (isDev) {
    // dev mode: 別途 `pnpm dev:server` が 4001 で起動している前提。
    // useSocket.ts の dev 分岐が `http://localhost:4001` に hardcode で
    // 接続するため、ここで ephemeral port にサーバーを起動すると
    // Socket.IO の接続先がミスマッチして UI が空になる。
    mainWindow = createWindow(4001);
    return;
  }

  // production: サーバーを埋め込み起動する
  const port = await getAvailablePort();
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
  showMainWindow();
});

app.on("before-quit", async event => {
  isQuitting = true;
  destroyTray();

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
