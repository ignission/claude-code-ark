import { describe, expect, it } from "vitest";
import {
  findStaleChromiumPids,
  validateBrowserUrl,
} from "./browser-manager.js";

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
});

describe("validateBrowserUrl", () => {
  it.each([
    "about:blank",
    "http://localhost:3000/a",
    "https://127.0.0.1:8443/",
  ])("%s を通す", url => {
    expect(() => validateBrowserUrl(url)).not.toThrow();
  });
  it.each([
    "file:///etc/passwd",
    "http://example.com/",
    "javascript:alert(1)",
    "not a url",
  ])("%s を拒否する", url => {
    expect(() => validateBrowserUrl(url)).toThrow();
  });
});
