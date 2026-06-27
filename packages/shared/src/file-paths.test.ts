import { describe, expect, it } from "vitest";
import {
  extractFilePaths,
  isImagePath,
  splitTextWithFilePaths,
} from "./file-paths";

describe("isImagePath", () => {
  it("画像拡張子は大小文字を無視して true", () => {
    expect(isImagePath("/home/admin/a.PNG")).toBe(true);
    expect(isImagePath("/tmp/b.jpeg")).toBe(true);
    expect(isImagePath("/tmp/c.webp")).toBe(true);
  });

  it("非画像拡張子と拡張子なしは false", () => {
    expect(isImagePath("/home/admin/report.pdf")).toBe(false);
    expect(isImagePath("/home/admin/README")).toBe(false);
  });
});

describe("splitTextWithFilePaths", () => {
  it("画像と非画像の複数パスを分解する", () => {
    expect(
      splitTextWithFilePaths(
        "files: /home/admin/a.png and /tmp/report.csv done"
      )
    ).toEqual([
      { type: "text", value: "files: " },
      { type: "file", value: "/home/admin/a.png" },
      { type: "text", value: " and " },
      { type: "file", value: "/tmp/report.csv" },
      { type: "text", value: " done" },
    ]);
  });

  it("罫線テーブル内の絶対パスを検出する", () => {
    const text = [
      "┌────┬────┐",
      "│ /home/admin/stanby-sponsors-page-pc-1440.png │ 842K │",
      "└────┴────┘",
    ].join("\n");
    expect(extractFilePaths(text)).toEqual([
      "/home/admin/stanby-sponsors-page-pc-1440.png",
    ]);
  });

  it("prose 中の相対パスは検出しない", () => {
    expect(
      splitTextWithFilePaths("src/foo.ts and docs/spec.md are relative")
    ).toEqual([
      { type: "text", value: "src/foo.ts and docs/spec.md are relative" },
    ]);
  });

  it("末尾の句読点と閉じ括弧はパスに含めない", () => {
    expect(splitTextWithFilePaths("see (/tmp/result.json).")).toEqual([
      { type: "text", value: "see (" },
      { type: "file", value: "/tmp/result.json" },
      { type: "text", value: ")." },
    ]);
  });

  it("拡張子なしは検出しない", () => {
    expect(splitTextWithFilePaths("output: /home/admin/result")).toEqual([
      { type: "text", value: "output: /home/admin/result" },
    ]);
  });

  it("http URL 内のパス部分は検出しない", () => {
    expect(splitTextWithFilePaths("https://example.com/a.png")).toEqual([
      { type: "text", value: "https://example.com/a.png" },
    ]);
  });
});
