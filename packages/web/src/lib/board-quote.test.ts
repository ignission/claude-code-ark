import { describe, expect, it } from "vitest";
import { buildBoardQuoteDraft } from "./board-quote";

describe("buildBoardQuoteDraft", () => {
  it("図の名前とパスを1行目に、囲んだ文字を引用にして、空行で終える", () => {
    expect(
      buildBoardQuoteDraft({
        name: "購入の流れ",
        relPath: ".claude/diagrams/purchase.diagram.html",
        text: "注文を受ける\n在庫を引き当てる",
        truncated: false,
      })
    ).toBe(
      "ボード「購入の流れ」(.claude/diagrams/purchase.diagram.html) のこの部分について:\n" +
        "> 注文を受ける\n> 在庫を引き当てる\n\n"
    );
  });

  it("切られた引用には、途中までであることを最後の行に書く", () => {
    const draft = buildBoardQuoteDraft({
      name: "図",
      relPath: "a.diagram.html",
      text: "長い文",
      truncated: true,
    });
    expect(draft.endsWith("> 長い文\n> (長いので、ここまでを引用)\n\n")).toBe(
      true
    );
  });
});
