import { describe, expect, it } from "vitest";
import type { DocBlock } from "./diagram-doc-blocks.js";
import { describeDocBodyChanges } from "./diagram-doc-notice.js";

function block(id: string, text: string): DocBlock {
  return {
    id,
    html: `<p data-ark-id="${id}" data-ark-author="human">${text}</p>`,
    text,
  };
}
function map(...blocks: DocBlock[]): Map<string, DocBlock> {
  return new Map(blocks.map(b => [b.id, b]));
}

/** data-ark-author の付かないブロック (エージェントの出力、外部からの書き換え) */
function unmarkedBlock(id: string, text: string): DocBlock {
  return { id, html: `<p data-ark-id="${id}">${text}</p>`, text };
}

describe("describeDocBodyChanges", () => {
  it("変わったブロックだけを本文つきで返す", () => {
    const before = map(block("p1", "むかし"), block("p2", "そのまま"));
    const after = map(block("p1", "いま"), block("p2", "そのまま"));
    expect(describeDocBodyChanges(before, after).lines).toEqual(["[p1] いま"]);
  });

  it("追加と削除を述べる", () => {
    const before = map(block("p1", "あ"));
    const after = map(block("p1", "あ"), block("p2", "ふえた"));
    expect(describeDocBodyChanges(before, after).lines).toEqual([
      "[p2] ブロックを追加: ふえた",
    ]);
    expect(describeDocBodyChanges(after, before).lines).toEqual([
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
          html: `<p data-ark-id="p1" data-ark-author="human">あ<br>い</p>`,
          text: "あ\nい",
        },
      ],
    ]);
    expect(describeDocBodyChanges(before, after).lines).toEqual(["[p1] あ い"]);
  });

  it("1ブロック300文字で切る", () => {
    const before = map(block("p1", "みじかい"));
    const after = map(block("p1", "あ".repeat(400)));
    const lines = describeDocBodyChanges(before, after).lines;
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
    const lines = describeDocBodyChanges(before, after).lines;
    expect(lines).toHaveLength(11);
    expect(lines[9]).toBe("[p10] あと10");
    expect(lines[10]).toBe("他に 2 件変更: p11, p12（board_read で引ける）");
  });

  it("変更が無ければ空を返す", () => {
    const same = map(block("p1", "おなじ"));
    expect(describeDocBodyChanges(same, new Map(same)).lines).toEqual([]);
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

    const lines = describeDocBodyChanges(before, after).lines;
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
        {
          id: rawId,
          html: `<p data-ark-id="p1&#10;2" data-ark-author="human">いま</p>`,
          text: "いま",
        },
      ],
    ]);

    const lines = describeDocBodyChanges(before, after).lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(String.fromCharCode(10));
    expect(lines[0]).toBe("[p1 2] ブロックを追加: いま");
  });

  it("id が80文字を超えると切り詰められる", () => {
    const longId = "p".repeat(90);
    const before = new Map<string, DocBlock>();
    const after = map(block(longId, "いま"));

    const lines = describeDocBodyChanges(before, after).lines;
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
        {
          id: controlOnlyId,
          html: `<p data-ark-id="" data-ark-author="human">いま</p>`,
          text: "いま",
        },
      ],
    ]);

    const lines = describeDocBodyChanges(before, after).lines;
    expect(lines).toEqual(["[(id不明)] ブロックを追加: いま"]);
  });

  it("10件打ち切り後の列挙行は300文字に収まり、末尾の board_read 誘導は残る", () => {
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

    const lines = describeDocBodyChanges(before, after).lines;
    const overflowLine = lines[lines.length - 1];
    expect(lines).toHaveLength(11);
    expect(Array.from(overflowLine).length).toBeLessThanOrEqual(300);
    // id 列挙がどれだけ長くても、board_read への誘導文言は必ず末尾に残る
    expect(overflowLine.endsWith("（board_read で引ける）")).toBe(true);
    // 列挙が実際に切れたことが省略記号で分かる
    expect(overflowLine).toContain("…");
    // 切り詰められた分の id はもう含まれない
    expect(overflowLine).not.toContain(longIds[longIds.length - 1]);
  });

  it("human 印のあるブロックだけなら allHuman が立ち、行は汚れない", () => {
    const before = map(block("p1", "むかし"));
    const after = map(block("p1", "いま"));

    const changes = describeDocBodyChanges(before, after);
    expect(changes.lines).toEqual(["[p1] いま"]);
    expect(changes.allHuman).toBe(true);
  });

  it("human 印の無いブロックには印を付け、allHuman を下ろす", () => {
    const before = map(block("p1", "むかし"), block("p2", "むかし"));
    const after = map(
      block("p1", "いま"),
      unmarkedBlock("p2", "外から変わった")
    );

    const changes = describeDocBodyChanges(before, after);
    expect(changes.lines).toEqual([
      "[p1] いま",
      "[p2] (human 印なし) 外から変わった",
    ]);
    expect(changes.allHuman).toBe(false);
  });

  it("追加されたブロックにも human 印の有無が出る", () => {
    const before = new Map<string, DocBlock>();
    const after = map(unmarkedBlock("p1", "ふえた"));

    const changes = describeDocBodyChanges(before, after);
    expect(changes.lines).toEqual([
      "[p1] (human 印なし) ブロックを追加: ふえた",
    ]);
    expect(changes.allHuman).toBe(false);
  });

  it("削除は印を付けないが、記録が残らないので allHuman も立てない", () => {
    const before = map(block("p1", "あ"), block("p2", "きえる"));
    const after = map(block("p1", "あ"));

    const changes = describeDocBodyChanges(before, after);
    expect(changes.lines).toEqual(["[p2] ブロックを削除"]);
    expect(changes.allHuman).toBe(false);
  });

  it("変更が無ければ allHuman は立てない", () => {
    const same = map(block("p1", "おなじ"));

    const changes = describeDocBodyChanges(same, new Map(same));
    expect(changes.lines).toEqual([]);
    expect(changes.allHuman).toBe(false);
  });

  it("10件で打ち切られても、打ち切られた側の印なしを allHuman に数える", () => {
    const before = new Map<string, DocBlock>();
    const after = new Map<string, DocBlock>();
    for (let i = 1; i <= 10; i += 1) {
      before.set(`p${i}`, block(`p${i}`, "まえ"));
      after.set(`p${i}`, block(`p${i}`, `あと${i}`));
    }
    // 11件目 (列挙に畳まれて行が残らない) だけ印が無い
    before.set("p11", block("p11", "まえ"));
    after.set("p11", unmarkedBlock("p11", "あと11"));

    const changes = describeDocBodyChanges(before, after);
    expect(changes.lines).toHaveLength(11);
    expect(changes.allHuman).toBe(false);
  });

  it("列挙が切れても件数はそのまま正しく出る", () => {
    const before = new Map<string, DocBlock>();
    const after = new Map<string, DocBlock>();
    for (let i = 1; i <= 10; i += 1) {
      before.set(`p${i}`, block(`p${i}`, "まえ"));
      after.set(`p${i}`, block(`p${i}`, `あと${i}`));
    }
    const longIdBase = "a".repeat(30);
    const restCount = 20;
    for (let i = 1; i <= restCount; i += 1) {
      const id = `${longIdBase}${String(i).padStart(2, "0")}`;
      before.set(id, block(id, "まえ"));
      after.set(id, block(id, "あと"));
    }

    const lines = describeDocBodyChanges(before, after).lines;
    const overflowLine = lines[lines.length - 1];
    // id 列挙は300文字に収めるため切られても、実際の残り件数 (N) はそのまま出す
    expect(overflowLine.startsWith(`他に ${restCount} 件変更: `)).toBe(true);
  });
});
