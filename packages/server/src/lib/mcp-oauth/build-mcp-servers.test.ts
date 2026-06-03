import { describe, expect, it } from "vitest";
import { normalizeAuthScheme } from "./build-mcp-servers.js";

describe("normalizeAuthScheme", () => {
  // mcp.atlassian.com 等の edge は auth-scheme を case-sensitive 判定し、
  // 小文字 "bearer" を 401 拒否する。canonical な "Bearer" に揃える。
  it("小文字 bearer を Bearer に正規化する", () => {
    expect(normalizeAuthScheme("bearer")).toBe("Bearer");
  });

  it("大文字 BEARER を Bearer に正規化する", () => {
    expect(normalizeAuthScheme("BEARER")).toBe("Bearer");
  });

  it("既に Bearer ならそのまま", () => {
    expect(normalizeAuthScheme("Bearer")).toBe("Bearer");
  });

  it("前後の空白を除去する", () => {
    expect(normalizeAuthScheme("  bearer  ")).toBe("Bearer");
  });

  it("空文字は Bearer にフォールバックする", () => {
    expect(normalizeAuthScheme("")).toBe("Bearer");
  });

  it("未知の scheme は先頭大文字化する", () => {
    expect(normalizeAuthScheme("dpop")).toBe("Dpop");
  });
});
