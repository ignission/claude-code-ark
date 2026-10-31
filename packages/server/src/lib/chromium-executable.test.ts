import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findInPlaywrightCache } from "./chromium-executable.js";

describe("findInPlaywrightCache", () => {
  let cache: string;
  const touch = (...parts: string[]) => {
    const file = path.join(cache, ...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
    return file;
  };
  beforeEach(() => {
    cache = fs.mkdtempSync(path.join(os.tmpdir(), "ark-pw-cache-"));
  });
  afterEach(() => {
    fs.rmSync(cache, { recursive: true, force: true });
  });
  const CHROME = [
    "chrome",
    "Chromium.app/Contents/MacOS/Chromium",
    "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ];

  it("版の番号を数として比べ、いちばん新しいものを返す", () => {
    touch("chromium-999", "chrome-linux", "chrome");
    const newest = touch("chromium-1248", "chrome-linux", "chrome");
    expect(findInPlaywrightCache(cache, "chromium-", CHROME)).toBe(newest);
  });

  it("OSやCPUで変わるディレクトリ名を決め打ちにしない", () => {
    const arm = touch("chromium-1248", "chrome-linux-arm64", "chrome");
    expect(findInPlaywrightCache(cache, "chromium-", CHROME)).toBe(arm);
  });

  it("macOSのアプリの形を見つける", () => {
    const mac = touch(
      "chromium-1248",
      "chrome-mac-arm64",
      "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
    );
    expect(findInPlaywrightCache(cache, "chromium-", CHROME)).toBe(mac);
  });

  it("新しい版に実行ファイルが無ければ、次に新しい版を見る", () => {
    fs.mkdirSync(path.join(cache, "chromium-1300", "chrome-linux"), {
      recursive: true,
    });
    const older = touch("chromium-1248", "chrome-linux", "chrome");
    expect(findInPlaywrightCache(cache, "chromium-", CHROME)).toBe(older);
  });

  it("headless shellは通常のChromiumとして拾わない", () => {
    touch(
      "chromium_headless_shell-1248",
      "chrome-headless-shell-linux-arm64",
      "chrome-headless-shell"
    );
    expect(findInPlaywrightCache(cache, "chromium-", CHROME)).toBeNull();
    expect(
      findInPlaywrightCache(cache, "chromium_headless_shell-", [
        "headless_shell",
        "chrome-headless-shell",
      ])
    ).toContain("chrome-headless-shell-linux-arm64");
  });

  it("キャッシュが無ければnull", () => {
    expect(
      findInPlaywrightCache(path.join(cache, "none"), "chromium-", CHROME)
    ).toBeNull();
  });
});
