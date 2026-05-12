/**
 * F8: 更新通知システム
 *
 * 起動時 + 24h ごとに GitHub Releases API から latest を取得し、
 * 現バージョンと比較。新版があれば main window に IPC で通知する。
 *
 * Apple Developer 登録なし (未署名配布) のため electron-updater は使えない。
 * 更新自体は `brew upgrade --cask ark` ユーザー操作で行う。
 *
 * 無効化: `ARK_DISABLE_UPDATE_CHECK=1` で env override 可能。
 * preferences.json (notifyUpdates=false) からの永続化無効化は F8-followup。
 */
import { app, type BrowserWindow } from "electron";
import log from "electron-log";

const RELEASES_API_URL =
  "https://api.github.com/repos/ignission/claude-code-ark/releases/latest";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const INITIAL_DELAY_MS = 5_000;
const FETCH_TIMEOUT_MS = 10_000;

export interface UpdateInfo {
  latestVersion: string;
  htmlUrl: string;
  publishedAt: string;
}

/**
 * semver の簡易比較。
 * - "v" prefix を除去
 * - "-prerelease" 等は捨てて MAJOR.MINOR.PATCH のみ比較
 * - 返り値: a < b → 負, a == b → 0, a > b → 正
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): [number, number, number] => {
    const cleaned = v.replace(/^v/, "").split("-")[0];
    const parts = cleaned.split(".").map(p => {
      const n = Number(p);
      return Number.isFinite(n) ? n : 0;
    });
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };
  const [a1, a2, a3] = parse(a);
  const [b1, b2, b3] = parse(b);
  return a1 - b1 || a2 - b2 || a3 - b3;
}

let checkTimer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;

async function fetchLatestRelease(): Promise<UpdateInfo | null> {
  try {
    const res = await fetch(RELEASES_API_URL, {
      headers: {
        "User-Agent": "ark-desktop",
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn("[update-checker] GitHub API returned non-OK:", res.status);
      return null;
    }
    const data = (await res.json()) as {
      tag_name?: string;
      html_url?: string;
      published_at?: string;
    };
    if (!data.tag_name || !data.html_url) return null;
    return {
      latestVersion: data.tag_name,
      htmlUrl: data.html_url,
      publishedAt: data.published_at ?? "",
    };
  } catch (err) {
    log.warn("[update-checker] fetch failed:", err);
    return null;
  }
}

async function checkAndNotify(mainWindow: BrowserWindow | null): Promise<void> {
  const info = await fetchLatestRelease();
  if (!info) return;
  const current = app.getVersion();
  if (compareSemver(info.latestVersion, current) <= 0) {
    log.info("[update-checker] up-to-date:", current);
    return;
  }
  log.info(
    "[update-checker] new version available:",
    info.latestVersion,
    "current:",
    current
  );
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("ark:update-available", info);
  }
}

/**
 * 更新チェッカーを起動する。起動 5 秒後の単発 check と、
 * 24h ごとの定期 check の両方をスケジュールする。
 *
 * @param getMainWindow check 実行時に IPC 送信先 BrowserWindow を取得する関数。
 *   ウィンドウは再生成される可能性があるため、呼び出しごとに取得する。
 */
export function startUpdateChecker(
  getMainWindow: () => BrowserWindow | null
): void {
  if (process.env.ARK_DISABLE_UPDATE_CHECK === "1") {
    log.info("[update-checker] disabled via ARK_DISABLE_UPDATE_CHECK");
    return;
  }
  // 起動直後にネットワーク確立を待つため少し遅延させる。
  initialTimer = setTimeout(() => {
    void checkAndNotify(getMainWindow());
  }, INITIAL_DELAY_MS);
  checkTimer = setInterval(() => {
    void checkAndNotify(getMainWindow());
  }, CHECK_INTERVAL_MS);
}

export function stopUpdateChecker(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}
