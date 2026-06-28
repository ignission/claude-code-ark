import { describe, expect, it } from "vitest";
import { isMermaidCodeClass } from "./mermaid-block-utils";

describe("isMermaidCodeClass", () => {
  it("language-mermaid を含むと true", () => {
    expect(isMermaidCodeClass("language-mermaid")).toBe(true);
  });
  it("他言語は false", () => {
    expect(isMermaidCodeClass("language-ts")).toBe(false);
  });
  it("className 無しは false", () => {
    expect(isMermaidCodeClass(undefined)).toBe(false);
  });
});
