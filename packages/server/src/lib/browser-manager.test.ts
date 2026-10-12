import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionRestore,
  findInPlaywrightCache,
  findStaleChromiumPids,
  parseDevToolsEndpoint,
  waitForDevToolsEndpoint,
} from "./browser-manager.js";

const ENDPOINT = "ws://127.0.0.1:9222/devtools/browser/0a1b-2c3d";

describe("parseDevToolsEndpoint", () => {
  it("自分のポートのエンドポイントを取り出す", () => {
    const text = `[warn] something\n\nDevTools listening on ${ENDPOINT}\n`;
    expect(parseDevToolsEndpoint(text, 9222)).toBe(ENDPOINT);
  });
  it("CRLFの行末でも取り出す", () => {
    expect(
      parseDevToolsEndpoint(`DevTools listening on ${ENDPOINT}\r\n`, 9222)
    ).toBe(ENDPOINT);
  });
  it("行が終わるまでは取り出さない (途中で切れたidを使わない)", () => {
    expect(
      parseDevToolsEndpoint(`DevTools listening on ${ENDPOINT}`, 9222)
    ).toBeNull();
  });
  it("別のポートは受け付けない", () => {
    expect(
      parseDevToolsEndpoint(`DevTools listening on ${ENDPOINT}\n`, 9223)
    ).toBeNull();
    // 前方一致で92220を9222と読まない
    expect(
      parseDevToolsEndpoint(
        "DevTools listening on ws://127.0.0.1:92220/devtools/browser/x\n",
        9222
      )
    ).toBeNull();
  });
  it("127.0.0.1以外のホストは受け付けない", () => {
    expect(
      parseDevToolsEndpoint(
        "DevTools listening on ws://0.0.0.0:9222/devtools/browser/x\n",
        9222
      )
    ).toBeNull();
    expect(
      parseDevToolsEndpoint(
        "DevTools listening on ws://127.0.0.1.example.com:9222/devtools/browser/x\n",
        9222
      )
    ).toBeNull();
  });
  it("行が無ければnull", () => {
    expect(
      parseDevToolsEndpoint("Cannot start http server for devtools.\n", 9222)
    ).toBeNull();
  });
});

describe("waitForDevToolsEndpoint", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeChild() {
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
    };
    child.stderr = new EventEmitter();
    return child;
  }

  it("stderrの行が2つのチャンクに分かれて届いても、エンドポイントを返す", async () => {
    const child = fakeChild();
    const result = waitForDevToolsEndpoint(child, 9222, 10000);
    child.stderr.emit("data", Buffer.from("\nDevTools listening on ws://127."));
    child.stderr.emit(
      "data",
      Buffer.from("0.0.1:9222/devtools/browser/0a1b-2c3d\n")
    );
    await expect(result).resolves.toBe(ENDPOINT);
    // 終わったら、待つ間のリスナーを残さない
    expect(child.stderr.listenerCount("data")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
  });

  it("時間切れのエラーにstderrの末尾を付ける", async () => {
    const child = fakeChild();
    const result = waitForDevToolsEndpoint(child, 9222, 10000);
    const assertion = expect(result).rejects.toThrow(
      /タイムアウト[\s\S]*Cannot start http server for devtools/
    );
    child.stderr.emit(
      "data",
      Buffer.from("Cannot start http server for devtools.\n")
    );
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
  });

  it("別のポートの行では起動したとみなさず、時間切れになる", async () => {
    const child = fakeChild();
    const result = waitForDevToolsEndpoint(child, 9223, 10000);
    const assertion = expect(result).rejects.toThrow("タイムアウト");
    child.stderr.emit(
      "data",
      Buffer.from(`DevTools listening on ${ENDPOINT}\n`)
    );
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
  });

  it("待つ間に終了したらrejectする", async () => {
    const child = fakeChild();
    const result = waitForDevToolsEndpoint(child, 9222, 10000);
    child.stderr.emit("data", Buffer.from("error while loading libnss3.so\n"));
    child.emit("exit", 127);
    await expect(result).rejects.toThrow(
      /起動の途中で終了しました \(code: 127\)[\s\S]*libnss3/
    );
  });

  it("起動できなければrejectする", async () => {
    const child = fakeChild();
    const result = waitForDevToolsEndpoint(child, 9222, 10000);
    child.emit("error", new Error("spawn ENOENT"));
    await expect(result).rejects.toThrow("spawn ENOENT");
  });
});

describe("findStaleChromiumPids", () => {
  const dir = "/data/browser-profile";
  const ps = [
    `  101 /opt/chrome --headless=new --user-data-dir=${dir} --remote-debugging-port=9222 about:blank`,
    `  102 /opt/chrome --type=renderer --user-data-dir=${dir}`,
    "  103 /opt/chrome --headless=new --user-data-dir=/other/profile",
    `  104 /opt/chrome --user-data-dir=${dir}-backup`,
    "  105 vim notes.txt",
  ].join("\n");

  it("同じプロファイルを使う親プロセスだけを拾う", () => {
    expect(findStaleChromiumPids(ps, dir)).toEqual([101]);
  });
  it("自分の子は拾わない", () => {
    expect(findStaleChromiumPids(ps, dir, 101)).toEqual([]);
  });
  it("空白を含むプロファイルの場所でも拾う", () => {
    const spaced = "/Users/x/Library/Application Support/Ark/browser-profile";
    const output = [
      `  201 /Applications/Chromium.app/Contents/MacOS/Chromium --headless=new --user-data-dir=${spaced} --remote-debugging-port=9222 -- about:blank`,
      `  202 /Applications/Chromium.app/Contents/MacOS/Chromium Helper --type=renderer --user-data-dir=${spaced}`,
      `  203 /Applications/Chromium.app/Contents/MacOS/Chromium --user-data-dir=${spaced}-backup`,
      `  204 /Applications/Chromium.app/Contents/MacOS/Chromium --user-data-dir=${spaced}`,
    ].join("\n");
    expect(findStaleChromiumPids(output, spaced)).toEqual([201, 204]);
  });
  it("引数の途中に同じ文字列があっても、引数の先頭でなければ拾わない", () => {
    const output = `  301 /opt/tool --note=x--user-data-dir=${dir}`;
    expect(findStaleChromiumPids(output, dir)).toEqual([]);
  });
});

describe("clearSessionRestore", () => {
  it("セッションの記録だけを消し、ほかのプロファイルのデータは残す", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ark-profile-"));
    try {
      const sessions = path.join(dir, "Default", "Sessions");
      fs.mkdirSync(sessions, { recursive: true });
      fs.writeFileSync(path.join(sessions, "Session_1"), "x");
      fs.writeFileSync(path.join(dir, "Default", "Cookies"), "c");
      clearSessionRestore(dir);
      expect(fs.existsSync(sessions)).toBe(false);
      expect(fs.existsSync(path.join(dir, "Default", "Cookies"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("プロファイルがまだ無くても投げない", () => {
    expect(() =>
      clearSessionRestore(path.join(os.tmpdir(), "ark-profile-none"))
    ).not.toThrow();
  });
});

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
