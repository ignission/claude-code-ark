import { describe, expect, it } from "vitest";
import { BOARD_SESSION_CONTEXT } from "./board-session-start-hook.js";

describe("BOARD_SESSION_CONTEXT のボード", () => {
  it("書いた HTML を board_open で開け、形式は自由だと伝える", () => {
    expect(BOARD_SESSION_CONTEXT).toContain("board_open");
    expect(BOARD_SESSION_CONTEXT).toContain("draw freely");
    expect(BOARD_SESSION_CONTEXT).toContain(".diagram.html");
  });

  it("撤去した規約 (デッキ・doc・コメント・作図規約) と、頼まれずに描かせる文言を残さない", () => {
    for (const removed of [
      "deck",
      "board_authoring_guide",
      "board_comments",
      "board_reply",
      "data-ark-author",
      "even if not asked",
      "proactively",
    ]) {
      expect(BOARD_SESSION_CONTEXT).not.toContain(removed);
    }
  });
});

describe("BOARD_SESSION_CONTEXT の分岐TODO", () => {
  it("子タスクは自分で worktree を作らず task_start で起こすよう伝える", () => {
    expect(BOARD_SESSION_CONTEXT).toContain("task_start");
  });

  it("保留した話題は todo_add で足すよう伝える", () => {
    expect(BOARD_SESSION_CONTEXT).toContain("todo_add");
    expect(BOARD_SESSION_CONTEXT).toContain("todo_list");
  });

  it("Claude 自身の判断では足さず、ユーザーに頼まれたときだけ足す", () => {
    expect(BOARD_SESSION_CONTEXT).not.toContain("When you put a topic on hold");
    expect(BOARD_SESSION_CONTEXT).not.toContain("on your own judgment");
    expect(BOARD_SESSION_CONTEXT).toContain("When the user says");
  });
});

describe("BOARD_SESSION_CONTEXT の次の一手", () => {
  it("作業の終わりに next_actions で選択肢を出すよう伝える", () => {
    expect(BOARD_SESSION_CONTEXT).toContain("next_actions");
    expect(BOARD_SESSION_CONTEXT).toContain("Every time you finish");
    expect(BOARD_SESSION_CONTEXT).toContain(
      "before you write your final reply"
    );
  });

  it("遅延読み込みの道具でも呼べるよう、ToolSearch で読み込むことを伝える", () => {
    expect(BOARD_SESSION_CONTEXT).toContain("ToolSearch");
  });

  it("返答では選択肢に触れさせない", () => {
    expect(BOARD_SESSION_CONTEXT).toContain("do not mention the buttons");
  });

  it("次の一手が無いときと、質問をしているときは出さなくてよいと伝える", () => {
    expect(BOARD_SESSION_CONTEXT).toContain("Skip it only when");
  });
});
