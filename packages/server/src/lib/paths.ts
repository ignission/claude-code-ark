/**
 * Ark のデータ・ログ・ファイル配置パス抽象。
 *
 * 環境による配置先:
 *   - 環境変数 `ARK_DATA_DIR` / `ARK_LOGS_DIR` が指定されればそれを優先
 *   - Electron では `configureAppPaths()` 経由で
 *     `ARK_DATA_DIR = app.getPath("userData")` /
 *     `ARK_LOGS_DIR = app.getPath("logs")` が明示的に設定される
 *   - CLI / PM2 等の通常起動（Linux + macOS + Windows）: `<cwd>/data` 配下
 *     （legacy 互換）
 *
 * 関連:
 *   - `database.ts` の DATA_DIR / DB_PATH
 *   - `file-upload-manager.ts` の BASE_DIR (旧 `/tmp/ark-files`)
 *   - `browser-manager.ts` の BROWSER_PIDFILE_DIR
 *   - `packages/desktop/src/main.ts`（環境変数注入元）
 */

import path from "node:path";

/**
 * データ保存先ディレクトリを返す。
 *
 * 優先順:
 *   1. `ARK_DATA_DIR` 環境変数（Electron は `configureAppPaths()` で明示設定）
 *   2. CLI / PM2 等 env unset 時: `<cwd>/data`（legacy 互換）
 */
export function getDataDir(): string {
  const envDir = process.env.ARK_DATA_DIR;
  if (envDir) return envDir;
  return path.join(process.cwd(), "data");
}

/**
 * Ark のログ出力先。
 *
 * 優先順:
 *   1. `ARK_LOGS_DIR` 環境変数（Electron は `configureAppPaths()` で明示設定）
 *   2. `getDataDir()/logs` （CLI / PM2 等の env unset 時）
 */
export function getLogsDir(): string {
  const envDir = process.env.ARK_LOGS_DIR;
  if (envDir) return envDir;
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
