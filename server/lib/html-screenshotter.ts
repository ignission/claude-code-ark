/**
 * HTML スクリーンショッター
 *
 * Playwright (headless Chromium) でローカル HTML ファイルをレンダリングし、
 * PNG バイナリを返す。シングルトンで Chromium ブラウザを使い回し、idle 5分で自動 close。
 */

import { type Browser, chromium } from "playwright-core";
import { findChromiumExecutable } from "./browser-manager.js";
import { getErrorMessage } from "./errors.js";

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_VIEWPORT_WIDTH = 1280;
const DEFAULT_VIEWPORT_HEIGHT = 800;

export interface ScreenshotOptions {
  fullPage?: boolean;
  viewportWidth?: number;
}

class HtmlScreenshotter {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  async screenshot(
    filePath: string,
    opts: ScreenshotOptions = {}
  ): Promise<Buffer> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      viewport: {
        width: opts.viewportWidth ?? DEFAULT_VIEWPORT_WIDTH,
        height: DEFAULT_VIEWPORT_HEIGHT,
      },
      deviceScaleFactor: 2,
    });
    try {
      const page = await context.newPage();
      // file:// で読み込み（self-contained HTML を前提）
      // networkidle ではフォント読み込み等を待つが、外部リソース無しの HTML では即時完了する
      await page.goto(`file://${filePath}`, {
        waitUntil: "networkidle",
        timeout: 30_000,
      });
      const buf = await page.screenshot({
        type: "png",
        fullPage: opts.fullPage ?? true,
      });
      this.scheduleIdleClose();
      return buf;
    } finally {
      await context.close();
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.launching) return this.launching;
    const executablePath = findChromiumExecutable({ headlessShell: true });
    this.launching = chromium
      .launch({
        headless: true,
        executablePath: executablePath ?? undefined,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      })
      .then(b => {
        this.browser = b;
        this.launching = null;
        b.on("disconnected", () => {
          if (this.browser === b) this.browser = null;
        });
        return b;
      })
      .catch(e => {
        this.launching = null;
        throw new Error(
          `Chromium 起動失敗: ${getErrorMessage(e)}。` +
            "Playwright Chromium がインストールされていない可能性があります " +
            "(pnpm exec playwright install chromium-headless-shell)"
        );
      });
    return this.launching;
  }

  private scheduleIdleClose() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const b = this.browser;
      this.browser = null;
      b?.close().catch(() => {
        // close 失敗は無視（既に死んでいる等）
      });
    }, IDLE_TIMEOUT_MS);
  }

  async shutdown(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const b = this.browser;
    this.browser = null;
    if (b) {
      await b.close().catch(() => {});
    }
  }
}

export const htmlScreenshotter = new HtmlScreenshotter();
