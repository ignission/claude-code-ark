import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTranscriptSinceMemo,
  hasConversationSince,
  type TranscriptSinceIo,
} from "./transcript-conversation-since.js";

const SINCE = Date.parse("2026-11-23T01:00:00.000Z");

function at(minutes: number): string {
  return new Date(SINCE + minutes * 60_000).toISOString();
}

function line(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

const user = (minutes: number) =>
  line({
    type: "user",
    timestamp: at(minutes),
    message: { role: "user", content: "続けて" },
  });
const assistant = (minutes: number) =>
  line({
    type: "assistant",
    timestamp: at(minutes),
    message: { role: "assistant", content: [{ type: "text", text: "はい" }] },
  });
const prLink = (minutes: number) =>
  line({ type: "pr-link", timestamp: at(minutes) });
const aiTitle = line({ type: "ai-title", aiTitle: "題名" });

function ioOf(
  text: string,
  truncated = false,
  stat = { size: text.length, mtimeMs: 1 }
): TranscriptSinceIo & { readTail: ReturnType<typeof vi.fn> } {
  return {
    pickLatestJsonl: () => "/p/current.jsonl",
    statFile: () => stat,
    readTail: vi.fn(() => ({ text, truncated })),
  };
}

function check(io: TranscriptSinceIo): boolean {
  return hasConversationSince("/r/app", "/cfg", SINCE, io);
}

beforeEach(() => {
  clearTranscriptSinceMemo();
});

describe("hasConversationSince", () => {
  it("休止にしたあとに会話のレコードがあれば動いた", () => {
    expect(check(ioOf([assistant(-5), user(3), assistant(4)].join("\n")))).toBe(
      true
    );
  });

  it("休止にしたあとに増えたのがメタデータだけなら動いていない", () => {
    const text = [user(-6), assistant(-5), aiTitle, prLink(2), ""].join("\n");
    expect(check(ioOf(text))).toBe(false);
  });

  it("会話が無い (/clear 直後) なら動いていない", () => {
    expect(check(ioOf([aiTitle, ""].join("\n")))).toBe(false);
  });

  it("切り詰めた範囲の中で休止の前のレコードに着かなければ、動いたとみなす", () => {
    // 先頭は行の途中なので捨てる。残りは休止のあとのメタデータだけ
    const text = ['xx", "type":"user"}', prLink(2)].join("\n");
    expect(check(ioOf(text, true))).toBe(true);
  });

  it("休止の前の巨大な行が範囲の先頭で切れても、範囲を広げて読み、メタデータだけなら動いていない", () => {
    const huge = line({
      type: "assistant",
      timestamp: at(-1),
      message: { role: "assistant", content: "x".repeat(300) },
    });
    const full = [huge, prLink(2)].join("\n");
    const io: TranscriptSinceIo = {
      pickLatestJsonl: () => "/p/current.jsonl",
      statFile: () => ({ size: full.length, mtimeMs: 1 }),
      // 最初の範囲では巨大な行の途中から、広げたら全体が読める
      readTail: (_file, maxBytes) =>
        maxBytes <= 256 * 1024
          ? { text: full.slice(full.length - 40), truncated: true }
          : { text: full, truncated: false },
    };
    expect(check(io)).toBe(false);
  });

  it("上限まで広げても切り詰めたまま決め手が無ければ、動いたとみなす", () => {
    const readTail = vi.fn((_file: string, _maxBytes: number) => ({
      text: ['xx", "type":"user"}', prLink(2)].join("\n"),
      truncated: true,
    }));
    expect(
      check({
        pickLatestJsonl: () => "/p/current.jsonl",
        statFile: () => ({ size: 1, mtimeMs: 1 }),
        readTail,
      })
    ).toBe(true);
    expect(readTail.mock.calls.at(-1)?.[1]).toBeGreaterThanOrEqual(
      16 * 1024 * 1024
    );
  });

  it("ファイル全体を読んで休止の前に着かなければ、動いていない", () => {
    expect(check(ioOf(prLink(2)))).toBe(false);
  });

  it("壊れた行と読めない timestamp は飛ばす", () => {
    const text = [
      assistant(-5),
      user(3),
      "{broken",
      line({ type: "pr-link", timestamp: "not a date" }),
    ].join("\n");
    expect(check(ioOf(text))).toBe(true);
  });

  it("ファイルが無ければ動いていない", () => {
    expect(
      hasConversationSince("/r/app", null, SINCE, {
        ...ioOf(""),
        pickLatestJsonl: () => null,
      })
    ).toBe(false);
  });

  it("大きさと mtime が同じなら読み直さない", () => {
    const io = ioOf([user(-1), prLink(2)].join("\n"));
    check(io);
    check(io);
    expect(io.readTail).toHaveBeenCalledTimes(1);
  });
});
