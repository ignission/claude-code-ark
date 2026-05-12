/**
 * Ark Desktop - アプリケーションメニュー (macOS Menu Bar)
 *
 * macOS の慣習に従い、App / File / Edit / View / Window / Help の標準構造を組む。
 * Help から「Open Logs Folder」「Open Data Folder」を提供する。
 *
 * F3 Step 5 で導入。クロスプラットフォーム互換のため Linux / Windows でも
 * 同じテンプレートで動くようにしている（macOS のみ先頭の App メニューを追加）。
 *
 * 「Reset Data」相当の自動削除機能は F4 以降で実装予定。Phase 3 では Folder を
 * 開いてユーザーに手動削除を促すのみだったため、誤解を招く `Reset Data...` ラベル
 * を撤去して `Open Data Folder` 単独に整理した（F3 review 指摘事項）。
 */
// `@ark/server` は static import しない。
// import 評価時に `@ark/server` の module-level singleton (db / fileUploadManager /
// browserManager) が即時構築されると、`configureAppPaths()` で set される
// `ARK_DATA_DIR` / `ARK_LOGS_DIR` より先に singleton がパスを確定してしまい、
// Finder 起動の .app では `process.cwd()/data` (= `/data`) に紐付いて失敗する。
// click ハンドラ内で dynamic import することで、メニュー操作タイミングまで
// 評価を遅延させる。
import {
  app,
  dialog,
  Menu,
  type MenuItemConstructorOptions,
  shell,
} from "electron";

interface AppMenuOptions {
  showMainWindow: () => void;
  quit: () => void;
}

/**
 * `Menu.buildFromTemplate` 用のテンプレートを構築する。
 */
export function buildAppMenu(options: AppMenuOptions): Menu {
  const isMac = process.platform === "darwin";

  const appSubmenu: MenuItemConstructorOptions[] = [
    { role: "about" },
    { type: "separator" },
    { role: "services" },
    { type: "separator" },
    { role: "hide" },
    { role: "hideOthers" },
    { role: "unhide" },
    { type: "separator" },
    {
      label: "Quit Ark",
      accelerator: "Cmd+Q",
      click: () => options.quit(),
    },
  ];

  const fileSubmenu: MenuItemConstructorOptions[] = [
    {
      label: "Show Window",
      accelerator: isMac ? "Cmd+1" : "Ctrl+1",
      click: () => options.showMainWindow(),
    },
    { type: "separator" },
    isMac
      ? { role: "close" }
      : { label: "Quit Ark", click: () => options.quit() },
  ];

  const editSubmenu: MenuItemConstructorOptions[] = [
    { role: "undo" },
    { role: "redo" },
    { type: "separator" },
    { role: "cut" },
    { role: "copy" },
    { role: "paste" },
    ...(isMac
      ? ([
          { role: "pasteAndMatchStyle" },
          { role: "delete" },
          { role: "selectAll" },
          { type: "separator" },
          {
            label: "Speech",
            submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }],
          },
        ] as MenuItemConstructorOptions[])
      : ([
          { role: "delete" },
          { type: "separator" },
          { role: "selectAll" },
        ] as MenuItemConstructorOptions[])),
  ];

  const viewSubmenu: MenuItemConstructorOptions[] = [
    { role: "reload" },
    { role: "forceReload" },
    { role: "toggleDevTools" },
    { type: "separator" },
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
  ];

  const windowSubmenu: MenuItemConstructorOptions[] = isMac
    ? [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
      ]
    : [{ role: "minimize" }, { role: "zoom" }, { role: "close" }];

  const helpSubmenu: MenuItemConstructorOptions[] = [
    {
      label: "Open Logs Folder",
      click: async () => {
        // `ARK_LOGS_DIR` の override を尊重するため `@ark/server` の解決器を使う。
        // `app.getPath("logs")` を直に使うとサーバー側が書き出している実体パスと
        // ずれる可能性がある。
        // dynamic import: import 評価を click まで遅延させ、`@ark/server` の
        // module-level singleton 構築が `configureAppPaths()` 後に走ることを保証する。
        const { getLogsDir } = await import("@ark/server");
        const logsDir = getLogsDir();
        const result = await shell.openPath(logsDir);
        if (result) {
          // 失敗時のみ非空文字列でエラーメッセージが返る。
          dialog.showErrorBox("Open Logs Folder Failed", result);
        }
      },
    },
    {
      label: "Open Data Folder",
      click: async () => {
        // `ARK_DATA_DIR` の override を尊重するため `@ark/server` の解決器を使う。
        // 自動削除 (Reset Data) 機能は F4 以降で別途実装するため、現状は Folder を
        // 開くだけにとどめる。F3 review でラベルと挙動の乖離を指摘されたため、
        // 旧「Reset Data...」エントリは撤去した。
        // dynamic import: 上記 "Open Logs Folder" と同じ理由。
        const { getDataDir } = await import("@ark/server");
        const dataDir = getDataDir();
        const result = await shell.openPath(dataDir);
        if (result) {
          dialog.showErrorBox("Open Data Folder Failed", result);
        }
      },
    },
  ];

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ label: app.name, submenu: appSubmenu }] : []),
    { label: "File", submenu: fileSubmenu },
    { label: "Edit", submenu: editSubmenu },
    { label: "View", submenu: viewSubmenu },
    { label: "Window", submenu: windowSubmenu, role: "windowMenu" },
    { label: "Help", submenu: helpSubmenu, role: "help" },
  ];

  return Menu.buildFromTemplate(template);
}
