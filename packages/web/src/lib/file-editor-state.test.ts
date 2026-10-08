import { describe, expect, it } from "vitest";
import { decideOnDiskChange, detectLineEnding } from "./file-editor-state";

describe("decideOnDiskChange", () => {
  it("mtime が手元と 1ms 以内なら無視する (自分の保存の反響)", () => {
    expect(
      decideOnDiskChange({ loadedMtimeMs: 100, diskMtimeMs: 100, dirty: false })
    ).toBe("ignore");
    expect(
      decideOnDiskChange({
        loadedMtimeMs: 100.4,
        diskMtimeMs: 101.2,
        dirty: true,
      })
    ).toBe("ignore");
  });

  it("mtime が違い、編集中なら競合を見せる", () => {
    expect(
      decideOnDiskChange({ loadedMtimeMs: 100, diskMtimeMs: 250, dirty: true })
    ).toBe("show-conflict");
  });

  it("mtime が違い、未編集なら黙って読み直す", () => {
    expect(
      decideOnDiskChange({ loadedMtimeMs: 100, diskMtimeMs: 250, dirty: false })
    ).toBe("reload-silently");
    // 古い時刻へ戻った場合 (git checkout など) も読み直す
    expect(
      decideOnDiskChange({ loadedMtimeMs: 100, diskMtimeMs: 50, dirty: false })
    ).toBe("reload-silently");
  });
});

describe("detectLineEnding", () => {
  it("CRLF のファイルは CRLF", () => {
    expect(detectLineEnding("a\r\nb\r\n")).toBe("\r\n");
  });

  it("LF のファイルと改行の無いファイルは LF", () => {
    expect(detectLineEnding("a\nb\n")).toBe("\n");
    expect(detectLineEnding("abc")).toBe("\n");
    expect(detectLineEnding("")).toBe("\n");
  });

  it("混在は最初の改行で決める", () => {
    expect(detectLineEnding("a\r\nb\nc\n")).toBe("\r\n");
    expect(detectLineEnding("a\nb\r\n")).toBe("\n");
  });
});
