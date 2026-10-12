import { describe, expect, it } from "vitest";
import { normalizeUserUrl, validateBrowserUrl } from "./browser-url.js";

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
