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

  it("ポートつきのlocalhostは、スキームつきとして読まれて補われない", () => {
    expect(normalizeUserUrl("localhost:3000")).toBe("localhost:3000");
    expect(() => validateBrowserUrl("localhost:3000")).toThrow();
  });
});
