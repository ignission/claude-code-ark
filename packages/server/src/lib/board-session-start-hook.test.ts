import { describe, expect, it } from "vitest";
import { BOARD_SESSION_CONTEXT } from "./board-session-start-hook.js";

describe("BOARD_SESSION_CONTEXT の data-ark-author=human 規約", () => {
  it("human は人間が手を入れた本文であって、決定そのものではないと述べる", () => {
    expect(BOARD_SESSION_CONTEXT).toContain("手を入れた");
    expect(BOARD_SESSION_CONTEXT).toContain("決定かどうかは");
  });

  it("human が無いブロックを人間の決定として扱わない、という古い断定は残っていない", () => {
    expect(BOARD_SESSION_CONTEXT).not.toContain("人間の決定として扱わない");
  });

  it("自分の書き手印（claude）は付けないと述べる", () => {
    expect(BOARD_SESSION_CONTEXT).toContain("自分の書き手印は付けない");
    expect(BOARD_SESSION_CONTEXT).not.toContain(
      'data-ark-author="claude" を付け'
    );
  });

  it("容器ブロックには human が付かない旨を述べる", () => {
    // 言い回しが変わっても壊れにくいよう、1つの完全一致ではなく2つの要素で見る。
    expect(BOARD_SESSION_CONTEXT).toContain("容器ブロック");
    expect(BOARD_SESSION_CONTEXT).toContain("付かない");
  });
});

describe("BOARD_SESSION_CONTEXT の説明図", () => {
  it("頼まれていなくても、込み入った説明は 1 ページに 1 つのデッキで出すよう伝える", () => {
    expect(BOARD_SESSION_CONTEXT).toContain("込み入った説明");
    expect(BOARD_SESSION_CONTEXT).toContain("説明図（デッキ）");
    expect(BOARD_SESSION_CONTEXT).toContain("1 ページに 1 つのこと");
    expect(BOARD_SESSION_CONTEXT).toContain(
      "理由や経緯はページではなくチャットに書く"
    );
    expect(BOARD_SESSION_CONTEXT).toContain("短い答えで済むならチャットで返す");
  });
});

describe("BOARD_SESSION_CONTEXT の分岐TODO", () => {
  it("保留した話題は todo_add で足すよう伝える", () => {
    expect(BOARD_SESSION_CONTEXT).toContain("todo_add");
    expect(BOARD_SESSION_CONTEXT).toContain("todo_list");
  });

  it("Claude 自身の判断では足さず、ユーザーの頼みか Ark の判定のときだけ足す", () => {
    expect(BOARD_SESSION_CONTEXT).not.toContain("保留・後回し・別件にしたとき");
    expect(BOARD_SESSION_CONTEXT).toContain(
      "Ark の分岐TODOの判定に頼まれたとき"
    );
  });
});
