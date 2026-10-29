import { describe, expect, it } from "vitest";
import { BOARD_SESSION_CONTEXT } from "./board-session-start-hook.js";

describe("BOARD_SESSION_CONTEXT のボード", () => {
  it("書いた HTML を board_open で開け、形式は自由だと伝える", () => {
    expect(BOARD_SESSION_CONTEXT).toContain("board_open");
    expect(BOARD_SESSION_CONTEXT).toContain("自由に描く");
    expect(BOARD_SESSION_CONTEXT).toContain(".diagram.html");
  });

  it("撤去した規約 (デッキ・doc・コメント・作図規約) と、頼まれずに描かせる文言を残さない", () => {
    for (const removed of [
      "デッキ",
      "board_authoring_guide",
      "board_comments",
      "board_reply",
      "data-ark-author",
      "頼まれていなくても",
    ]) {
      expect(BOARD_SESSION_CONTEXT).not.toContain(removed);
    }
  });
});

describe("BOARD_SESSION_CONTEXT の分岐TODO", () => {
  it("保留した話題は todo_add で足すよう伝える", () => {
    expect(BOARD_SESSION_CONTEXT).toContain("todo_add");
    expect(BOARD_SESSION_CONTEXT).toContain("todo_list");
  });

  it("Claude 自身の判断では足さず、ユーザーに頼まれたときだけ足す", () => {
    expect(BOARD_SESSION_CONTEXT).not.toContain("保留・後回し・別件にしたとき");
    expect(BOARD_SESSION_CONTEXT).not.toContain("分岐TODOの判定");
    expect(BOARD_SESSION_CONTEXT).toContain("と言われたときは、todo_add");
  });
});
