/**
 * Ark のデータ・ログ・ファイル配置パス抽象。
 *
 * 環境による配置先:
 *   - 環境変数 `ARK_DATA_DIR` / `ARK_LOGS_DIR` が指定されればそれを優先
 *   - macOS（Electron `.app`）: `~/Library/Application Support/Ark/` / `~/Library/Logs/Ark/`
 *   - Linux / Windows: `process.cwd()/data` 配下（既存互換、pm2 + repo-root 起動）
 *
 * Electron main プロセスは `app.getPath("userData")` / `app.getPath("logs")` を
 * `process.env.ARK_DATA_DIR` / `process.env.ARK_LOGS_DIR` に setEnv することで
 * 同梱サーバーの全データ書き込みを Application Support 配下に逃がす。
 *
 * 関連:
 *   - `database.ts` の DATA_DIR / DB_PATH
 *   - `file-upload-manager.ts` の BASE_DIR (旧 `/tmp/ark-files`)
 *   - `browser-manager.ts` の BROWSER_PIDFILE_DIR
 *   - `packages/desktop/src/main.ts`（環境変数注入元）
 */

import os from "node:os";
import path from "node:path";

/**
 * Ark の永続データ（SQLite, アップロード, ブラウザ pidfile 等）の置き場所。
 * 環境変数 `ARK_DATA_DIR` > macOS 標準 > Linux/Windows fallback（cwd ベース）の順で決定する。
 */
export function getDataDir(): string {
  const envDir = process.env.ARK_DATA_DIR;
  if (envDir) return envDir;
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Ark");
  }
  return path.join(process.cwd(), "data");
}

/**
 * Ark のログ出力先。
 * 環境変数 `ARK_LOGS_DIR` > macOS 標準 > データディレクトリ配下 logs/ の順で決定する。
 */
export function getLogsDir(): string {
  const envDir = process.env.ARK_LOGS_DIR;
  if (envDir) return envDir;
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Logs", "Ark");
  }
  return path.join(getDataDir(), "logs");
}

/**
 * ユーザがアップロードした一時ファイルの置き場所。
 * 旧 `/tmp/ark-files` から移行（cleanup は FileUploadManager 自身が 24h で実施）。
 */
export function getUploadsDir(): string {
  return path.join(getDataDir(), "files");
}

/**
 * Electron 環境で同梱バイナリ（tmux / ttyd 等）の配置ディレクトリ。
 *
 * F4 で `.app/Contents/Resources/bin` を `process.resourcesPath` 経由で返す実装に置き換える。
 * Phase 3 ではまだ同梱していないため常に null を返し、呼び出し側はシステム PATH に
 * フォールバックする。
 */
export function getBundledBinDir(): string | null {
  return null;
}
