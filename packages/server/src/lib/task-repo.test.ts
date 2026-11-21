import { describe, expect, it } from "vitest";
import { resolveTaskRepo } from "./task-repo.js";

const candidates = [
  "/dev/github.com/acme/app",
  "/dev/github.com/acme/app-ios",
  "/dev/github.com/acme/tool",
  "/dev/github.com/other/tool",
];

describe("resolveTaskRepo", () => {
  it("絶対パスは候補と一致すればそのまま返す", () => {
    expect(resolveTaskRepo("/dev/github.com/acme/app/", candidates)).toBe(
      "/dev/github.com/acme/app"
    );
  });

  it("候補に無い絶対パスは受け付けない", () => {
    expect(() => resolveTaskRepo("/etc", candidates)).toThrow(
      "not a repository Ark knows"
    );
  });

  it("末尾の並びで 1 つに決まれば返す", () => {
    expect(resolveTaskRepo("app", candidates)).toBe("/dev/github.com/acme/app");
    expect(resolveTaskRepo("acme/tool", candidates)).toBe(
      "/dev/github.com/acme/tool"
    );
    expect(resolveTaskRepo("github.com/other/tool", candidates)).toBe(
      "/dev/github.com/other/tool"
    );
  });

  it("区切りの途中では一致させない", () => {
    expect(() => resolveTaskRepo("pp", candidates)).toThrow("does not match");
    expect(() => resolveTaskRepo("ios", candidates)).toThrow("does not match");
  });

  it("複数に一致したら選ばず、候補を返す", () => {
    expect(() => resolveTaskRepo("tool", candidates)).toThrow(
      "ambiguous. Candidates: /dev/github.com/acme/tool, /dev/github.com/other/tool"
    );
  });

  it("空の指定と、候補が無い場合は失敗する", () => {
    expect(() => resolveTaskRepo("  ", candidates)).toThrow("repo is empty");
    expect(() => resolveTaskRepo("app", [])).toThrow("no repository list");
  });
});
