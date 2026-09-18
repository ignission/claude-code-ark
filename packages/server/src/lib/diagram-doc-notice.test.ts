import { describe, expect, it } from "vitest";
import type { DocBlock } from "./diagram-doc-blocks.js";
import { describeDocBodyChanges } from "./diagram-doc-notice.js";

function block(id: string, text: string): DocBlock {
  return { id, html: `<p data-ark-id="${id}">${text}</p>`, text };
}
function map(...blocks: DocBlock[]): Map<string, DocBlock> {
  return new Map(blocks.map(b => [b.id, b]));
}

describe("describeDocBodyChanges", () => {
  it("変わったブロックだけを本文つきで返す", () => {
    const before = map(block("p1", "むかし"), block("p2", "そのまま"));
    const after = map(block("p1", "いま"), block("p2", "そのまま"));
    expect(describeDocBodyChanges(before, after)).toEqual(["[p1] いま"]);
  });

  it("追加と削除を述べる", () => {
    const before = map(block("p1", "あ"));
    const after = map(block("p1", "あ"), block("p2", "ふえた"));
    expect(describeDocBodyChanges(before, after)).toEqual([
      "[p2] ブロックを追加: ふえた",
    ]);
    expect(describeDocBodyChanges(after, before)).toEqual([
      "[p2] ブロックを削除",
    ]);
  });

  it("制御文字と改行を落として1行にする", () => {
    const before = map(block("p1", "むかし"));
    const after = new Map<string, DocBlock>([
      [
        "p1",
        {
          id: "p1",
          html: `<p data-ark-id="p1">あ<br>い</p>`,
          text: "あ\nい",
        },
      ],
    ]);
    expect(describeDocBodyChanges(before, after)).toEqual(["[p1] あ い"]);
  });

  it("1ブロック300文字で切る", () => {
    const before = map(block("p1", "みじかい"));
    const after = map(block("p1", "あ".repeat(400)));
    const lines = describeDocBodyChanges(before, after);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`[p1] ${"あ".repeat(299)}…`);
  });

  it("11件以上は10件で打ち切り、残りを id の列挙にする", () => {
    const before = new Map<string, DocBlock>();
    const after = new Map<string, DocBlock>();
    for (let i = 1; i <= 12; i += 1) {
      before.set(`p${i}`, block(`p${i}`, "まえ"));
      after.set(`p${i}`, block(`p${i}`, `あと${i}`));
    }
    const lines = describeDocBodyChanges(before, after);
    expect(lines).toHaveLength(11);
    expect(lines[9]).toBe("[p10] あと10");
    expect(lines[10]).toBe("他に 2 件変更: p11, p12（board_read で引ける）");
  });

  it("変更が無ければ空を返す", () => {
    const same = map(block("p1", "おなじ"));
    expect(describeDocBodyChanges(same, new Map(same))).toEqual([]);
  });
});
