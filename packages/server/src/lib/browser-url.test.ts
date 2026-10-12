import { describe, expect, it } from "vitest";
import {
  isBrowserUrlAllowed,
  MAX_BROWSER_URL_LENGTH,
  normalizeUserUrl,
  validateBrowserUrl,
} from "./browser-url.js";

describe("validateBrowserUrl", () => {
  it.each([
    "about:blank",
    "http://localhost:3000/a",
    "https://127.0.0.1:8443/",
    "https://example.com/a?b#c",
    "http://192.168.1.10:8080/",
  ])("%s を通す", url => {
    expect(() => validateBrowserUrl(url)).not.toThrow();
  });
  it.each([
    "file:///etc/passwd",
    "ftp://example.com/",
    "javascript:alert(1)",
    "not a url",
  ])("%s を拒否する", url => {
    expect(() => validateBrowserUrl(url)).toThrow();
  });

  it.each([
    ["about:blank", "about:blank"],
    ["http://localhost\\@evil.com", "http://localhost/@evil.com"],
    ["http:localhost", "http://localhost/"],
    ["http://local\nhost/", "http://localhost/"],
    ["http://ｌｏｃａｌｈｏｓｔ/", "http://localhost/"],
    ["http://loc\u00adalhost/", "http://localhost/"],
    ["http://127.1/", "http://127.0.0.1/"],
    ["http://2130706433/", "http://127.0.0.1/"],
    ["http://LOCALHOST:3000/a?b#c", "http://localhost:3000/a?b#c"],
    ["https://localhost/", "https://localhost/"],
    ["https://localhost", "https://localhost/"],
    [normalizeUserUrl(" http://localhost/ "), "http://localhost/"],
    ["https://example.com/a?b#c", "https://example.com/a?b#c"],
    [normalizeUserUrl("example.com"), "http://example.com/"],
    ["http://192.168.1.10:8080/", "http://192.168.1.10:8080/"],
    ["http://localhost.evil.com/", "http://localhost.evil.com/"],
    ["http://127.0.0.1.evil.com/", "http://127.0.0.1.evil.com/"],
    ["http://[::1]/", "http://[::1]/"],
    ["http:\\\\evil.com", "http://evil.com/"],
    [normalizeUserUrl("//evil.com"), "http://evil.com/"],
  ])("%j は、読んだあとの形 %s にして返す", (url, canonical) => {
    expect(validateBrowserUrl(url)).toBe(canonical);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,x",
    "file:///etc/passwd",
    "view-source:http://localhost/",
    "chrome://settings",
    "devtools://devtools/bundled/inspector.html",
    "blob:http://localhost/x",
    "ftp://example.com/",
    "http://localhost@evil.com/",
    "http://evil.com@localhost/",
    "http://user:pass@localhost/",
    "//evil.com",
    "about:blank#x",
    `http://localhost/${"a".repeat(5000)}`,
  ])("%j を拒否する", url => {
    expect(() => validateBrowserUrl(url)).toThrow();
  });

  it("長さの上限ちょうどは通し、1文字でも超えたら拒否する", () => {
    const fits = `http://localhost/${"a".repeat(MAX_BROWSER_URL_LENGTH - 17)}`;
    expect(fits).toHaveLength(MAX_BROWSER_URL_LENGTH);
    expect(validateBrowserUrl(fits)).toBe(fits);
    expect(() => validateBrowserUrl(`${fits}a`)).toThrow();
  });

  it("通したものは、ユーザー名の無いhttp(s)のURLになっている", () => {
    for (const url of [
      "http://localhost\\@evil.com",
      "http:localhost",
      "http://127.1/",
      "http://0x7f.1:8080/x",
      "HTTPS://Example.COM:8443/",
    ]) {
      const parsed = new URL(validateBrowserUrl(url));
      expect(["http:", "https:"]).toContain(parsed.protocol);
      expect(parsed.username).toBe("");
      expect(parsed.password).toBe("");
    }
  });
});

describe("isBrowserUrlAllowed", () => {
  it("開いてよいかを、投げずに返す", () => {
    expect(isBrowserUrlAllowed("http://localhost:3000/")).toBe(true);
    expect(isBrowserUrlAllowed("about:blank")).toBe(true);
    expect(isBrowserUrlAllowed("https://example.com/")).toBe(true);
    expect(isBrowserUrlAllowed("file:///etc/passwd")).toBe(false);
    expect(isBrowserUrlAllowed("")).toBe(false);
  });
});

describe("normalizeUserUrl", () => {
  it.each([
    ["127.0.0.1:3000/a", "http://127.0.0.1:3000/a"],
    ["localhost/a?b=1", "http://localhost/a?b=1"],
    ["  http://localhost:3000/  ", "http://localhost:3000/"],
    ["https://localhost", "https://localhost"],
    ["about:blank", "about:blank"],
    ["example.com", "http://example.com"],
    ["", "http://"],
  ])("%s は %s になる", (input, expected) => {
    expect(normalizeUserUrl(input)).toBe(expected);
  });

  it.each([
    ["localhost:3000", "http://localhost:3000"],
    ["127.0.0.1:8080/x", "http://127.0.0.1:8080/x"],
    ["localhost:3000?q=1", "http://localhost:3000?q=1"],
    ["localhost:3000#top", "http://localhost:3000#top"],
    ["  localhost:3000  ", "http://localhost:3000"],
  ])(
    "コロンのあとがポートの %s は、スキームなしとして %s になる",
    (input, expected) => {
      expect(normalizeUserUrl(input)).toBe(expected);
      expect(() => validateBrowserUrl(expected)).not.toThrow();
    }
  );

  it.each([
    "http://localhost:3000/",
    "https://127.0.0.1:8443/a",
    "about:blank",
    "javascript:alert(1)",
    "localhost:abc",
    "mailto:123@example.com",
  ])("コロンのあとがポートでない %s は、そのままにする", input => {
    expect(normalizeUserUrl(input)).toBe(input);
  });

  it("そのままにしたjavascript: は、開いてよいかの検査で断られる", () => {
    expect(() =>
      validateBrowserUrl(normalizeUserUrl("javascript:alert(1)"))
    ).toThrow();
  });
});
