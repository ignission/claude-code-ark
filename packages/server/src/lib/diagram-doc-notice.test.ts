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

  it("id に ] を含んでも10件打ち切り後の列挙が壊れない", () => {
    const before = new Map<string, DocBlock>();
    const after = new Map<string, DocBlock>();
    for (let i = 1; i <= 10; i += 1) {
      before.set(`p${i}`, block(`p${i}`, "まえ"));
      after.set(`p${i}`, block(`p${i}`, `あと${i}`));
    }
    const trickyId = "b]11";
    before.set(trickyId, block(trickyId, "まえ"));
    after.set(trickyId, block(trickyId, "あと11"));

    const lines = describeDocBodyChanges(before, after);
    expect(lines).toHaveLength(11);
    expect(lines[9]).toBe("[p10] あと10");
    expect(lines[10]).toBe("他に 1 件変更: b]11（board_read で引ける）");
  });

  it("id に制御文字を含んでも1行に収まる", () => {
    // SOH (制御文字) をエスケープ表記で埋め込まず String.fromCharCode で組み立てる
    const rawId = `p1${String.fromCharCode(10)}2`; // 改行 (LF) を含む id
    const before = new Map<string, DocBlock>();
    const after = new Map<string, DocBlock>([
      [
        rawId,
        { id: rawId, html: `<p data-ark-id="p1&#10;2">いま</p>`, text: "いま" },
      ],
    ]);

    const lines = describeDocBodyChanges(before, after);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(String.fromCharCode(10));
    expect(lines[0]).toBe("[p1 2] ブロックを追加: いま");
  });

  it("id が80文字を超えると切り詰められる", () => {
    const longId = "p".repeat(90);
    const before = new Map<string, DocBlock>();
    const after = map(block(longId, "いま"));

    const lines = describeDocBodyChanges(before, after);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`[${"p".repeat(79)}…] ブロックを追加: いま`);
  });

  it("id が無害化で全消去されると固定の代替文字列にする", () => {
    // 制御文字のみの id (SOH x2)。空白ではないので sanitizeText で全除去される
    const controlOnlyId = String.fromCharCode(1) + String.fromCharCode(2);
    const before = new Map<string, DocBlock>();
    const after = new Map<string, DocBlock>([
      [
        controlOnlyId,
        { id: controlOnlyId, html: `<p data-ark-id="">いま</p>`, text: "いま" },
      ],
    ]);

    const lines = describeDocBodyChanges(before, after);
    expect(lines).toEqual(["[(id不明)] ブロックを追加: いま"]);
  });

  it("10件打ち切り後の列挙行そのものも300文字で切る", () => {
    const before = new Map<string, DocBlock>();
    const after = new Map<string, DocBlock>();
    for (let i = 1; i <= 10; i += 1) {
      before.set(`p${i}`, block(`p${i}`, "まえ"));
      after.set(`p${i}`, block(`p${i}`, `あと${i}`));
    }
    // 長い id を20個追加し、列挙部分だけで300文字を大きく超えるようにする
    const longIdBase = "a".repeat(30);
    const longIds: string[] = [];
    for (let i = 1; i <= 20; i += 1) {
      const id = `${longIdBase}${String(i).padStart(2, "0")}`;
      longIds.push(id);
      before.set(id, block(id, "まえ"));
      after.set(id, block(id, "あと"));
    }

    const lines = describeDocBodyChanges(before, after);
    const overflowLine = lines[lines.length - 1];
    expect(lines).toHaveLength(11);
    expect(Array.from(overflowLine).length).toBeLessThanOrEqual(300);
    expect(overflowLine.endsWith("…")).toBe(true);
    expect(overflowLine).not.toContain(longIds[longIds.length - 1]);
  });
});
