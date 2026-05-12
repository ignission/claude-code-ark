/**
 * F8: Electron preload script
 *
 * contextBridge 経由で renderer 側に IPC イベントを公開する。
 * contextIsolation=true / sandbox=false 前提。
 *
 * 出力形式は CJS (Electron が preload を CJS で読むため)。
 * build.mjs は src/main.ts (ESM) と src/preload.ts (CJS) を別々に bundle する。
 */
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

interface UpdateInfo {
  latestVersion: string;
  htmlUrl: string;
  publishedAt: string;
}

contextBridge.exposeInMainWorld("electronAPI", {
  /**
   * 更新通知 IPC subscriber を登録する。
   * 返り値の関数を呼び出すと unsubscribe される。
   */
  onUpdateAvailable: (callback: (info: UpdateInfo) => void) => {
    const listener = (_event: IpcRendererEvent, info: UpdateInfo) =>
      callback(info);
    ipcRenderer.on("ark:update-available", listener);
    return () => {
      ipcRenderer.removeListener("ark:update-available", listener);
    };
  },
  /**
   * 外部 URL をデフォルトブラウザで開く。Electron 内ウィンドウを開かせない。
   * shell.openExternal は main プロセス側にあるため IPC で委譲する。
   */
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke("ark:open-external", url),
});
