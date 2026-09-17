import { describe, expect, it } from "vitest";
import { isPathWithin } from "./pathUtils";

describe("isPathWithin", () => {
  it("同じパスと配下のパスは含む", () => {
    expect(isPathWithin("/repos/app", "/repos/app")).toBe(true);
    expect(isPathWithin("/repos/app/.worktrees/feat", "/repos/app")).toBe(true);
  });

  it("名前の先頭が同じだけの別ディレクトリは含まない", () => {
    expect(isPathWithin("/repos/app-copy", "/repos/app")).toBe(false);
    expect(isPathWithin("/repos/app-copy/wt", "/repos/app")).toBe(false);
  });

  it("基準のパスが末尾のスラッシュを持っていても判定できる", () => {
    expect(isPathWithin("/repos/app/wt", "/repos/app/")).toBe(true);
    expect(isPathWithin("/repos/app-copy", "/repos/app/")).toBe(false);
  });
});
