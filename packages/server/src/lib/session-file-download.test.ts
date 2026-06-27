import { describe, expect, it } from "vitest";
import {
  buildFileAllowlistFromTexts,
  isFilePathAllowed,
  normalizeRequestedFilePath,
} from "./session-file-download.js";

describe("session-file-download allowlist", () => {
  it("transcript 内に出現したパスは許可する", () => {
    const allowlist = buildFileAllowlistFromTexts([
      'assistant: {"text":"created /tmp/result.png"}',
    ]);
    expect(isFilePathAllowed("/tmp/result.png", allowlist)).toBe(true);
  });

  it("transcript 外のパスは拒否する", () => {
    const allowlist = buildFileAllowlistFromTexts(["created /tmp/result.png"]);
    expect(isFilePathAllowed("/tmp/other.png", allowlist)).toBe(false);
  });

  it("allowlist パスを接頭辞にした traversal は拒否する", () => {
    const allowlist = buildFileAllowlistFromTexts(["created /tmp/allowed.png"]);
    expect(
      isFilePathAllowed("/tmp/allowed.png/../../etc/passwd", allowlist)
    ).toBe(false);
  });

  it("リクエストパスは正規化して照合する", () => {
    const allowlist = buildFileAllowlistFromTexts(["created /tmp/result.png"]);
    expect(normalizeRequestedFilePath("/tmp/work/../result.png")).toBe(
      "/tmp/result.png"
    );
    expect(isFilePathAllowed("/tmp/work/../result.png", allowlist)).toBe(true);
  });

  it("相対パスは照合対象外", () => {
    const allowlist = buildFileAllowlistFromTexts(["created /tmp/result.png"]);
    expect(isFilePathAllowed("tmp/result.png", allowlist)).toBe(false);
  });
});
