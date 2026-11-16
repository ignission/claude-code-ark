import { describe, expect, it } from "vitest";
import {
  blankBoardName,
  buildHandOffMessage,
  isClaudeFree,
  notesPathOf,
  readDiagramNoteOpMessage,
} from "./board-notes";
import { requestChatSend, takeChatSends } from "./chat-draft-store";

describe("readDiagramNoteOpMessage", () => {
  it("付箋の操作と図の幅を読む", () => {
    expect(
      readDiagramNoteOpMessage({
        type: "ark:diagram-note-op",
        op: { type: "move", id: "n1", x: 1, y: 2 },
        viewWidth: 900,
      })
    ).toEqual({ op: { type: "move", id: "n1", x: 1, y: 2 }, viewWidth: 900 });
  });

  it("別の種類、知らない操作、id の無い操作は読まない", () => {
    expect(readDiagramNoteOpMessage({ type: "ark:diagram-pinch" })).toBeNull();
    expect(
      readDiagramNoteOpMessage({
        type: "ark:diagram-note-op",
        op: { type: "send", id: "n1" },
      })
    ).toBeNull();
    expect(
      readDiagramNoteOpMessage({
        type: "ark:diagram-note-op",
        op: { type: "delete", id: "x".repeat(65) },
      })
    ).toBeNull();
    expect(
      readDiagramNoteOpMessage({ type: "ark:diagram-note-op", op: null })
    ).toBeNull();
  });
});

describe("Claudeに渡す", () => {
  it("定型文に、付箋のファイルと図のパスを入れる。チャットへの返事は1行と頼む", () => {
    const message = buildHandOffMessage(".claude/diagrams/plan.diagram.html");
    expect(notesPathOf(".claude/diagrams/plan.diagram.html")).toBe(
      ".claude/diagrams/plan.notes.json"
    );
    expect(message).toContain("`.claude/diagrams/plan.notes.json`");
    expect(message).toContain("`.claude/diagrams/plan.diagram.html`");
    expect(message).toContain("チャットには1行だけ");
    // tmux へ1行で打ち込むので、改行を入れない
    expect(message).not.toContain("\n");
  });

  it("渡せるのは Claude が手すきのときだけ", () => {
    expect(isClaudeFree(undefined)).toBe(true);
    expect(isClaudeFree("IDLE")).toBe(true);
    expect(isClaudeFree("READY")).toBe(true);
    for (const status of [
      "THINK",
      "TOOL",
      "AWAITING",
      "ERR",
      "STOP",
    ] as const) {
      expect(isClaudeFree(status)).toBe(false);
    }
  });

  it("送る文は入力欄の下書きとは別に積まれ、受け取ると消える", () => {
    requestChatSend("/wt", "1通目");
    requestChatSend("/wt", "2通目");
    expect(takeChatSends("/other")).toEqual([]);
    expect(takeChatSends("/wt")).toEqual(["1通目", "2通目"]);
    expect(takeChatSends("/wt")).toEqual([]);
  });
});

describe("白紙のボードの名前", () => {
  it("作った日時を入れる", () => {
    expect(blankBoardName(new Date(2026, 10, 14, 9, 5))).toBe(
      "ホワイトボード 11/14 09:05"
    );
  });
});
