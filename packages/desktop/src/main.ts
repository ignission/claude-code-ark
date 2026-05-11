/**
 * Ark Desktop - Electron メインプロセス
 *
 * `.app` 起動時に空きポートを確保し、`@ark/server` を同一プロセスで起動して
 * BrowserWindow に UI を表示する。Phase 2 の最小実装。
 *
 * 動作モード:
 *   - dev (ARK_DEV=1): サーバーを bootstrap で起動せず、Vite dev server
 *     (http://localhost:4000) のみ読み込む。Socket.IO 接続先は
 *     `packages/web/src/hooks/useSocket.ts` 内で `http://localhost:4001` に
 *     hardcode されているため、別途 `pnpm dev:server` を 4001 で起動する前提。
 *   - prod: 空きポートで `@ark/server` を埋め込み起動し、同 URL の UI を読み込む。
 *
 * フェーズ別 TODO:
 *   - F3 macOS 統合: app.dock / Tray / `app.getPath('userData')` を dataDir
 *     としてサーバーに渡す
 *   - F4 tmux/ttyd 同梱: extraResources の bin/ パスを binPaths として渡す
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ServerHandle, startServer } from "@ark/server";
import { app, BrowserWindow } from "electron";
import { getAvailablePort } from "./getAvailablePort.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 開発モード判定。`ARK_DEV=1` で Vite dev server (localhost:4000) を読み込み、
 * それ以外は同梱サーバーから配信される `127.0.0.1:<port>/` を読み込む。
 */
const isDev = process.env.ARK_DEV === "1";

let serverHandle: ServerHandle | null = null;
let mainWindow: BrowserWindow | null = null;

/**
 * BrowserWindow を生成し、UI をロードする。
 * dev: Vite が `http://localhost:4000` で配信する index.html を読み込む
 * prod: 同梱サーバーがリッスンする `http://127.0.0.1:<port>/` を読み込む
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
  serverHandle = await startServer({
    port,
    webStaticDir: resolveWebStaticDir(),
    // Electron は ephemeral port で毎回 port が変わるため、
    // `/tmp/ark-tunnel-state.json` の port を信用して proxy すると
    // 存在しない port を指してリモートアクセスが切れる。
    // よって auto-recovery 自体を無効化する。
    disableTunnelAutoRecovery: true,
    // F3/F4 で dataDir / binPaths を渡す
  });
  // NODE_ENV=production にしていないため、index.ts 側の旧パス fallback は
  // 走らない。`isDev=false` で Vite を経由しない場合は webStaticDir を渡す
  // 必要があるが、Electron 起動経路はすべてここで明示しているので OK。

  mainWindow = createWindow(serverHandle.port);
}

app
  .whenReady()
  .then(bootstrap)
  .catch(error => {
    console.error("[Ark Desktop] Failed to bootstrap:", error);
    app.quit();
  });

// macOS の慣習 (Dock に残す) はフェーズ 3 で実装する。
// 現状は全ウィンドウ閉鎖でアプリ終了。
app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverHandle) {
    mainWindow = createWindow(serverHandle.port);
  }
});

app.on("before-quit", async event => {
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
    console.error("[Ark Desktop] Failed to stop server:", error);
  }
  app.quit();
});
