/**
 * Ark Desktop - メニューバー (Tray) 常駐
 *
 * macOS Menu Bar (Linux / Windows ではシステムトレイ) に Ark のアイコンを置き、
 * ウィンドウ非表示中でもアプリの状態が見えるようにする。
 *
 * 注意: `Tray` インスタンスはローカル変数に逃すと GC 対象になり menubar から消える。
 * 必ず module-level の `trayInstance` で保持する。
 *
 * Phase 3 では `build-assets/tray-icon.png` を placeholder として用意する。
 * テンプレート画像 (`@2x.png` + suffix `Template`) は F4 final で正式アイコンに置き換える。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, Menu, nativeImage, Tray } from "electron";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TrayOptions {
  showMainWindow: () => void;
  quit: () => void;
}

// GC で消えるのを防ぐため module-level に保持。
let trayInstance: Tray | null = null;

/**
 * Tray アイコン用 PNG のパスを解決する。
 *
 * - packaged: `Resources/build-assets/tray-icon.png` (electron-builder の
 *   extraResources で配置)
 * - unpackaged: `<repo>/packages/desktop/build-assets/tray-icon.png`
 *
 * placeholder 段階では空ファイル / 欠落でもクラッシュしないよう
 * `nativeImage.createEmpty()` にフォールバックする。
 */
function resolveTrayIconPath(): string | null {
  const candidates: string[] = [];
  if (app.isPackaged) {
    candidates.push(
      path.join(process.resourcesPath, "build-assets", "tray-icon.png")
    );
  }
  // dev / unpackaged 経路
  candidates.push(
    path.resolve(__dirname, "..", "build-assets", "tray-icon.png")
  );
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Tray を生成し menubar に表示する。既に存在する場合は何もしない。
 */
export function createTray(options: TrayOptions): Tray {
  if (trayInstance) return trayInstance;

  const iconPath = resolveTrayIconPath();
  // placeholder 期間中、ファイルが無くてもクラッシュしないよう空 image にフォールバック。
  const image = iconPath
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();

  // macOS では「テンプレート画像」（黒のみのモノクロ PNG）として扱うことでダーク/ライト
  // モード両対応になる。placeholder アイコンが揃ったら true にする。
  if (process.platform === "darwin" && !image.isEmpty()) {
    image.setTemplateImage(true);
  }

  const tray = new Tray(image);
  tray.setToolTip("Ark");

  const menu = Menu.buildFromTemplate([
    {
      label: "Show Ark",
      click: () => options.showMainWindow(),
    },
    { type: "separator" },
    {
      label: "Quit Ark",
      click: () => options.quit(),
    },
  ]);
  tray.setContextMenu(menu);

  // 左クリックでも Show Ark を発火（macOS の通常挙動）。
  tray.on("click", () => options.showMainWindow());

  trayInstance = tray;
  return tray;
}

/**
 * Tray を破棄する。`before-quit` で呼ぶことで Quit 経路で menubar から確実に消える。
 */
export function destroyTray(): void {
  if (trayInstance) {
    trayInstance.destroy();
    trayInstance = null;
  }
}
