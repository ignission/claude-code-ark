/**
 * Chromiumの実行ファイルを探す (HtmlScreenshotterが使う)
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Playwrightがブラウザを置く場所。環境変数、Linux、macOSの順に見る */
function playwrightCacheDirs(homeDir: string): string[] {
  const dirs: string[] = [];
  const custom = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (custom && custom !== "0") dirs.push(custom);
  dirs.push(path.join(homeDir, ".cache", "ms-playwright"));
  dirs.push(path.join(homeDir, "Library", "Caches", "ms-playwright"));
  return dirs;
}

/** 版のディレクトリ (`chrome-linux` など) から見た、実行ファイルの候補 */
const CHROME_BINARIES = [
  "chrome",
  "Chromium.app/Contents/MacOS/Chromium",
  "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
];
const HEADLESS_SHELL_BINARIES = ["headless_shell", "chrome-headless-shell"];

/** PATHに無いことが多い、macOSのアプリの置き場所 */
const MAC_APP_BINARIES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

/**
 * Playwrightのキャッシュから、いちばん新しい版の実行ファイルを探す。
 *
 * 版のディレクトリ (`chromium-1248`) の下の名前は、OSとCPUと版で変わる
 * (`chrome-linux`、`chrome-linux-arm64`、`chrome-mac`、`chrome-headless-shell-linux-arm64` など)。
 * 名前を決め打ちにせず、`chrome-` で始まるディレクトリをすべて見る。
 */
export function findInPlaywrightCache(
  cacheDir: string,
  prefix: "chromium-" | "chromium_headless_shell-",
  binaries: readonly string[]
): string | null {
  let versions: string[];
  try {
    versions = fs.readdirSync(cacheDir).filter(d => d.startsWith(prefix));
  } catch {
    return null;
  }
  // 版の番号は桁数が変わるので、文字列ではなく数として比べる
  const revision = (dir: string) =>
    Number.parseInt(dir.slice(prefix.length), 10) || 0;
  versions.sort((a, b) => revision(b) - revision(a));
  for (const version of versions) {
    let platforms: string[];
    try {
      platforms = fs
        .readdirSync(path.join(cacheDir, version))
        .filter(d => d.startsWith("chrome-"));
    } catch {
      continue;
    }
    for (const platform of platforms) {
      for (const binary of binaries) {
        const candidate = path.join(cacheDir, version, platform, binary);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

/**
 * Chromiumの実行ファイルを探す。
 *
 * snap版はpm2 / systemdの下で動かないことがあるので、Playwrightが入れたものを先に探す。
 * `headlessShell: true` なら、headless shellを優先し、無ければ通常のChromiumを使う。
 */
export function findChromiumExecutable(
  options: { headlessShell?: boolean } = {}
): string | null {
  const homeDir = process.env.HOME || os.homedir();
  for (const cacheDir of playwrightCacheDirs(homeDir)) {
    if (options.headlessShell) {
      const shell = findInPlaywrightCache(
        cacheDir,
        "chromium_headless_shell-",
        HEADLESS_SHELL_BINARIES
      );
      if (shell) return shell;
    }
    const chrome = findInPlaywrightCache(
      cacheDir,
      "chromium-",
      CHROME_BINARIES
    );
    if (chrome) return chrome;
  }

  // システムのChromium (snap版でないもの)
  for (const cmd of ["chromium-browser", "chromium", "google-chrome"]) {
    try {
      execFileSync("which", [cmd], { stdio: "pipe" });
      return cmd;
    } catch {
      // 見つからない
    }
  }
  for (const app of MAC_APP_BINARIES) {
    if (fs.existsSync(app)) return app;
  }

  return null;
}
