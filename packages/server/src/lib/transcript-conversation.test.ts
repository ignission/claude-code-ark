/**
 * readTranscriptConversationState の単体テスト。
 *
 * レコードの並びは実測に合わせる (Claude Code v2.1.276)。`/clear` 直後の JSONL に
 * 実際に入っていたのは mode / file-history-snapshot / system / attachment /
 * isMeta の user / `<command-name>/clear</command-name>` の user だけだった。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCwdCache } from "./claude-projects.js";
import {
  clearTranscriptConversationMemo,
  readTranscriptConversationState,
  type TranscriptConversationIo,
} from "./transcript-conversation.js";

const FILE = "/cfg/projects/-wt-app/current.jsonl";

/** 実測どおりの「/clear 直後」の中身 */
const AFTER_CLEAR_RECORDS = [
  { type: "mode", mode: "auto" },
  { type: "file-history-snapshot", messageId: "m1" },
  {
    type: "user",
    isMeta: true,
    message: {
      role: "user",
      content: "<local-command-caveat>Caveat: The messages below…",
    },
  },
  {
    type: "user",
    message: {
      role: "user",
      content: "<command-name>/clear</command-name>\n<command-message>clear",
    },
  },
  { type: "system", subtype: "local_command" },
  { type: "attachment", attachment: { type: "file" } },
  { type: "attachment", attachment: { type: "file" } },
];

function toJsonl(records: unknown[]): string {
  return `${records.map(r => JSON.stringify(r)).join("\n")}\n`;
}

/** 与えた本文を 1 ファイルとして返す io */
function ioReturning(
  body: string,
  overrides: Partial<TranscriptConversationIo> = {}
): TranscriptConversationIo {
  return {
    pickLatestJsonl: () => FILE,
    statFile: () => ({ size: Buffer.byteLength(body), mtimeMs: 1_000 }),
    readHead: (_file, maxBytes) => {
      const buffer = Buffer.from(body, "utf-8");
      const slice = buffer.subarray(0, maxBytes);
      return {
        text: slice.toString("utf-8"),
        truncated: buffer.length > maxBytes,
      };
    },
    ...overrides,
  };
}

const tmpDirs: string[] = [];

afterEach(() => {
  clearTranscriptConversationMemo();
  clearCwdCache();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("readTranscriptConversationState", () => {
  it("/clear 直後の形 (会話ゼロ) は no-conversation", () => {
    const io = ioReturning(toJsonl(AFTER_CLEAR_RECORDS));
    expect(readTranscriptConversationState("/wt/app", "/cfg", io)).toBe(
      "no-conversation"
    );
  });

  it("素の user メッセージがあれば has-conversation", () => {
    const io = ioReturning(
      toJsonl([
        ...AFTER_CLEAR_RECORDS,
        { type: "user", message: { role: "user", content: "テストを書いて" } },
      ])
    );
    expect(readTranscriptConversationState("/wt/app", "/cfg", io)).toBe(
      "has-conversation"
    );
  });

  it("assistant メッセージがあれば has-conversation", () => {
    const io = ioReturning(
      toJsonl([
        { type: "mode", mode: "auto" },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "はい" }],
          },
        },
      ])
    );
    expect(readTranscriptConversationState("/wt/app", "/cfg", io)).toBe(
      "has-conversation"
    );
  });

  it("自動コンパクトの要約は会話の続きなので has-conversation", () => {
    // 実測の形: type=user / isMeta=null / isCompactSummary=true / content は文字列
    const io = ioReturning(
      toJsonl([
        { type: "mode", mode: "auto" },
        {
          type: "user",
          isMeta: null,
          isCompactSummary: true,
          message: {
            role: "user",
            content:
              "This session is being continued from a previous conversation that ran out of context.",
          },
        },
      ])
    );
    expect(readTranscriptConversationState("/wt/app", "/cfg", io)).toBe(
      "has-conversation"
    );
  });

  it("slash command の出力 (<local-command-stdout>) は会話ではない", () => {
    const io = ioReturning(
      toJsonl([
        {
          type: "user",
          message: {
            role: "user",
            content: "<command-name>/model</command-name>",
          },
        },
        {
          type: "user",
          message: {
            role: "user",
            content: "<local-command-stdout>Set model to `Fable 5.1`",
          },
        },
      ])
    );
    expect(readTranscriptConversationState("/wt/app", "/cfg", io)).toBe(
      "no-conversation"
    );
  });

  it("壊れた JSON の行は飛ばして読み進める", () => {
    const io = ioReturning(
      [
        '{"type":"mode"',
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "こんにちは" },
        }),
        "",
      ].join("\n")
    );
    expect(readTranscriptConversationState("/wt/app", "/cfg", io)).toBe(
      "has-conversation"
    );
  });

  it("読めた行がすべて壊れていても、切り詰めていなければ no-conversation", () => {
    // 読めた行がすべて壊れている = 会話の証拠が無いだけなので no-conversation。
    // (切り詰めていない以上、この先にレコードは無い)
    const io = ioReturning('{"type":"mode"\n{"broken"\n');
    expect(readTranscriptConversationState("/wt/app", "/cfg", io)).toBe(
      "no-conversation"
    );
  });

  it("JSONL が無ければ unknown (既存の画面判定のまま)", () => {
    const io = ioReturning("", { pickLatestJsonl: () => null });
    expect(readTranscriptConversationState("/wt/app", "/cfg", io)).toBe(
      "unknown"
    );
  });

  it("ディレクトリが無く pickLatestJsonl が投げても unknown", () => {
    const io = ioReturning("", {
      pickLatestJsonl: () => {
        throw new Error("ENOENT: no such file or directory");
      },
    });
    expect(readTranscriptConversationState("/wt/app", "/cfg", io)).toBe(
      "unknown"
    );
  });

  it("読み取りが投げても unknown (削除レース)", () => {
    const io = ioReturning("", {
      readHead: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    expect(readTranscriptConversationState("/wt/app", "/cfg", io)).toBe(
      "unknown"
    );
  });

  it("worktreePath が空なら unknown (projects 直下を見に行かせない)", () => {
    const io = ioReturning(toJsonl(AFTER_CLEAR_RECORDS));
    expect(readTranscriptConversationState("", "/cfg", io)).toBe("unknown");
  });
});

describe("readTranscriptConversationState - 上限 32KB", () => {
  /** 会話でないレコードで先頭を埋める */
  function padding(bytes: number): unknown[] {
    const record = {
      type: "attachment",
      attachment: { type: "file", content: "x".repeat(200) },
    };
    const size = JSON.stringify(record).length + 1;
    return Array.from({ length: Math.ceil(bytes / size) }, () => record);
  }

  it("先頭に会話があれば、巨大ファイルでも打ち切って判定できる", () => {
    const body = toJsonl([
      { type: "user", message: { role: "user", content: "先頭の指示" } },
      ...padding(200 * 1024),
    ]);
    expect(Buffer.byteLength(body)).toBeGreaterThan(32 * 1024);
    const readHead = vi.fn((_file: string, maxBytes: number) => ({
      text: Buffer.from(body, "utf-8").subarray(0, maxBytes).toString("utf-8"),
      truncated: Buffer.byteLength(body) > maxBytes,
    }));
    const io = ioReturning(body, { readHead });
    expect(readTranscriptConversationState("/wt/app", "/cfg", io)).toBe(
      "has-conversation"
    );
    // 全文ではなく上限までしか要求していない
    expect(readHead).toHaveBeenCalledWith(expect.any(String), 32 * 1024);
  });

  it("上限まで会話が見つからなければ no-conversation ではなく unknown", () => {
    // 切り詰めた先に会話が続いているかもしれない。待機に落とすのは危ないので
    // 判定を放棄して既存の画面判定へ返す
    const io = ioReturning(toJsonl(padding(64 * 1024)));
    expect(readTranscriptConversationState("/wt/app", "/cfg", io)).toBe(
      "unknown"
    );
  });
});

describe("readTranscriptConversationState - メモ化", () => {
  it("大きさと mtime が同じあいだは読み直さない", () => {
    const body = toJsonl(AFTER_CLEAR_RECORDS);
    const io = ioReturning(body);
    const readHead = vi.spyOn(io, "readHead");
    for (let i = 0; i < 5; i++) {
      expect(readTranscriptConversationState("/wt/app", "/cfg", io)).toBe(
        "no-conversation"
      );
    }
    expect(readHead).toHaveBeenCalledTimes(1);
  });

  it("大きさが変われば読み直す (会話が足された)", () => {
    const empty = toJsonl(AFTER_CLEAR_RECORDS);
    const withMessage = toJsonl([
      ...AFTER_CLEAR_RECORDS,
      { type: "user", message: { role: "user", content: "やりなおして" } },
    ]);
    let body = empty;
    const io: TranscriptConversationIo = {
      pickLatestJsonl: () => FILE,
      statFile: () => ({ size: Buffer.byteLength(body), mtimeMs: 1_000 }),
      readHead: () => ({ text: body, truncated: false }),
    };
    expect(readTranscriptConversationState("/wt/app", "/cfg", io)).toBe(
      "no-conversation"
    );
    body = withMessage;
    expect(readTranscriptConversationState("/wt/app", "/cfg", io)).toBe(
      "has-conversation"
    );
  });

  it("has-conversation は覆らないので、以後そのファイルは読まない", () => {
    // JSONL は追記しかされないため、一度会話が入ったら消えることはない
    const body = toJsonl([
      { type: "user", message: { role: "user", content: "最初の指示" } },
    ]);
    let size = Buffer.byteLength(body);
    const readHead = vi.fn(() => ({ text: body, truncated: false }));
    const io: TranscriptConversationIo = {
      pickLatestJsonl: () => FILE,
      statFile: () => ({ size, mtimeMs: size }),
      readHead,
    };
    expect(readTranscriptConversationState("/wt/app", "/cfg", io)).toBe(
      "has-conversation"
    );
    size += 4_096;
    expect(readTranscriptConversationState("/wt/app", "/cfg", io)).toBe(
      "has-conversation"
    );
    expect(readHead).toHaveBeenCalledTimes(1);
  });
});

describe("readTranscriptConversationState - 既定の io", () => {
  function makeConfigDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ark-conversation-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("configDir 配下の projects/<encodeProjectDir(worktree)> を実ファイルで読む", () => {
    const configDir = makeConfigDir();
    const worktreePath = "/home/me/dev/app";
    const dir = path.join(configDir, "projects", "-home-me-dev-app");
    fs.mkdirSync(dir, { recursive: true });

    // 会話がまだ無い (= /clear 直後)
    fs.writeFileSync(
      path.join(dir, "a.jsonl"),
      toJsonl(AFTER_CLEAR_RECORDS.map(r => ({ ...r, cwd: worktreePath })))
    );
    expect(readTranscriptConversationState(worktreePath, configDir)).toBe(
      "no-conversation"
    );

    // 会話が足されたら追従する
    clearTranscriptConversationMemo();
    fs.appendFileSync(
      path.join(dir, "a.jsonl"),
      toJsonl([
        {
          type: "user",
          cwd: worktreePath,
          message: { role: "user", content: "続きをお願い" },
        },
      ])
    );
    expect(readTranscriptConversationState(worktreePath, configDir)).toBe(
      "has-conversation"
    );
  });

  it("projects ディレクトリが無ければ unknown", () => {
    expect(
      readTranscriptConversationState("/does/not/exist", makeConfigDir())
    ).toBe("unknown");
  });
});
