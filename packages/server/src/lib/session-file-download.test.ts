import { describe, expect, it } from "vitest";
import {
  buildFileAllowlistFromTexts,
  collectGeneratedTextsFromTranscript,
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

describe("collectGeneratedTextsFromTranscript (出所限定)", () => {
  const line = (obj: unknown) => JSON.stringify(obj);

  it("assistant の text 出力からはパスを拾う", () => {
    const jsonl = line({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "生成しました /tmp/shot.png" }],
      },
    });
    const allowlist = buildFileAllowlistFromTexts(
      collectGeneratedTextsFromTranscript(jsonl)
    );
    expect(isFilePathAllowed("/tmp/shot.png", allowlist)).toBe(true);
  });

  it("tool_result(tool 出力)からはパスを拾う", () => {
    const jsonl = line({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "saved to /tmp/result.pdf" }],
      },
    });
    const allowlist = buildFileAllowlistFromTexts(
      collectGeneratedTextsFromTranscript(jsonl)
    );
    expect(isFilePathAllowed("/tmp/result.pdf", allowlist)).toBe(true);
  });

  it("user 入力(string content)のパスは除外する", () => {
    const jsonl = line({
      type: "user",
      message: { role: "user", content: "このパスを見て /etc/secret.png" },
    });
    const allowlist = buildFileAllowlistFromTexts(
      collectGeneratedTextsFromTranscript(jsonl)
    );
    expect(isFilePathAllowed("/etc/secret.png", allowlist)).toBe(false);
  });

  it("user 入力(text ブロック)のパスは除外する", () => {
    const jsonl = line({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "/home/me/input.png を確認" }],
      },
    });
    const allowlist = buildFileAllowlistFromTexts(
      collectGeneratedTextsFromTranscript(jsonl)
    );
    expect(isFilePathAllowed("/home/me/input.png", allowlist)).toBe(false);
  });

  it("壊れた JSONL 行はスキップして処理を継続する", () => {
    const jsonl = [
      "{壊れた行",
      line({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok /tmp/ok.png" }],
        },
      }),
    ].join("\n");
    const allowlist = buildFileAllowlistFromTexts(
      collectGeneratedTextsFromTranscript(jsonl)
    );
    expect(isFilePathAllowed("/tmp/ok.png", allowlist)).toBe(true);
  });
});
