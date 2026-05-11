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
 * F4 で実装: Electron packaged 環境では `process.resourcesPath` が
 * `.app/Contents/Resources` を指すため、`Resources/bin` を返す。CLI / PM2 等の
 * 通常起動（process.resourcesPath が未定義）では null を返し、呼び出し側は
 * システム PATH にフォールバックする。
 *
 * 加えて、テスト/開発で同梱バイナリパスを差し替えたい場合のため
 * 環境変数 `ARK_BUNDLED_BIN_DIR` でも上書き可能とする（指定があれば最優先）。
 *
 * 注意: Electron の `process.resourcesPath` は packaged アプリでのみ有効。
 * `electron .` のような開発実行や、Electron 以外の Node プロセスでは
 * `process.resourcesPath` 自体は string として空文字または親プロセスから
 * 引き継がれた値を持つことがあるため、Electron であることを `process.versions.electron`
 * で同時に検証する。
 */
export function getBundledBinDir(): string | null {
  const override = process.env.ARK_BUNDLED_BIN_DIR;
  if (override) return override;

  // Electron 環境判定: `process.versions.electron` が存在し、かつ
  // `process.resourcesPath` が有効な文字列であれば packaged Electron とみなす。
  const isElectron = Boolean(process.versions?.electron);
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  if (isElectron && resourcesPath && typeof resourcesPath === "string") {
    return path.join(resourcesPath, "bin");
  }
  return null;
}
