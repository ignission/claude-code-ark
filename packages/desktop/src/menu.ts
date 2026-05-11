/**
 * Ark Desktop - アプリケーションメニュー (macOS Menu Bar)
 *
 * macOS の慣習に従い、App / File / Edit / View / Window / Help の標準構造を組む。
 * Help から「Open Logs Folder」「Reset Data...」を提供する。Reset Data は破壊的操作
 * のため `dialog.showMessageBox` で確認を取る。
 *
 * F3 Step 5 で導入。クロスプラットフォーム互換のため Linux / Windows でも
 * 同じテンプレートで動くようにしている（macOS のみ先頭の App メニューを追加）。
 */
import path from "node:path";
import { getDataDir, getLogsDir } from "@ark/server";
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
        const dataDir = getDataDir();
        const result = await shell.openPath(dataDir);
        if (result) {
          dialog.showErrorBox("Open Data Folder Failed", result);
        }
      },
    },
    { type: "separator" },
    {
      label: "Reset Data...",
      click: async () => {
        const dataDir = getDataDir();
        const { response } = await dialog.showMessageBox({
          type: "warning",
          buttons: ["Cancel", "Reset"],
          defaultId: 0,
          cancelId: 0,
          title: "Reset Ark Data",
          message:
            "Ark の全データ（セッション履歴・アップロード等）を削除しますか?",
          detail: `${path.join(dataDir, "sessions.db")} とその周辺ファイルが削除されます。実行後はアプリを再起動してください。\n\nこの操作は元に戻せません。`,
        });
        if (response === 1) {
          // 実削除は F4 以降で実装する（tmux セッション側との整合確認が必要）。
          // Phase 3 では Folder を開いて手動削除を促す。
          await shell.openPath(dataDir);
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
