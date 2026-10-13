/**
 * auq-screen-context のテスト
 *
 * buildAuqScreenContext は tmux capture-pane の生出力を AUQ カードの
 * 「直前の画面」表示用に整形する純粋関数。verbatim 原則 (内容の解釈・
 * パースをしない) を守り、行うのは末尾空行の除去とサイズ上限のみ。
 */

import { describe, expect, it } from "vitest";
import {
  buildAuqScreenContext,
  dropTrailingPromptBox,
} from "./auq-screen-context.js";

describe("buildAuqScreenContext", () => {
  it("null 入力は null を返す (capture-pane 失敗時)", () => {
    expect(buildAuqScreenContext(null)).toBeNull();
  });

  it("空文字・空白のみの入力は null を返す", () => {
    expect(buildAuqScreenContext("")).toBeNull();
    expect(buildAuqScreenContext("   \n\n  \t ")).toBeNull();
  });

  it("不正な上限指定でもサイズ上限の不変条件を破らない", () => {
    // maxChars: 0 は `slice(-0)` が全文を返すため、既定値へ丸める
    const raw = Array.from({ length: 200 }, (_, i) => `行${i}`).join("\n");

    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = buildAuqScreenContext(raw, { maxChars: bad, maxLines: bad });
      expect(out).not.toBeNull();
      expect((out as string).length).toBeLessThan(raw.length);
      expect((out as string).split("\n").length).toBeLessThanOrEqual(40);
    }
  });

  it("文字数上限の切り詰めでサロゲートペアを分断しない", () => {
    // 素の slice(-n) は境界の絵文字を片割れにして壊れた文字を作る
    const emoji = "🍎"; // U+1F34E = サロゲートペア（2 コード単位）
    const raw = emoji.repeat(50);

    for (let maxChars = 10; maxChars <= 21; maxChars += 1) {
      const out = buildAuqScreenContext(raw, { maxChars });
      expect(out).not.toBeNull();
      const text = out as string;
      expect(text.length).toBeLessThanOrEqual(maxChars);
      // 孤立サロゲートが残っていない = 全コードポイントが元の絵文字
      expect([...text].every(ch => ch === emoji)).toBe(true);
    }
  });

  it("末尾の空行は除去するが、内容は verbatim で保持する", () => {
    const raw = "● 認証方式は2案あります。\n  - JWT\n  - セッション\n\n\n";
    expect(buildAuqScreenContext(raw)).toBe(
      "● 認証方式は2案あります。\n  - JWT\n  - セッション"
    );
  });

  it("行内の先頭空白・罫線文字はそのまま残す (解釈しない)", () => {
    const raw = "╭─────╮\n│ > _ │\n╰─────╯";
    expect(buildAuqScreenContext(raw)).toBe(raw);
  });

  it("maxLines を超える場合は末尾側の行だけを残す", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i + 1}`);
    const result = buildAuqScreenContext(lines.join("\n"), { maxLines: 40 });
    expect(result).toBe(lines.slice(10).join("\n"));
  });

  it("maxChars を超える場合は古い行から落として上限内に収める", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(100));
    const result = buildAuqScreenContext(lines.join("\n"), {
      maxLines: 40,
      maxChars: 350,
    });
    expect(result).not.toBeNull();
    expect(result?.length).toBeLessThanOrEqual(350);
    // 末尾 (最新) 側が残る
    expect(result?.endsWith("9".repeat(100))).toBe(true);
    // 行の途中で切らない (行単位で落とす)
    expect(result).toBe(lines.slice(7).join("\n"));
  });

  it("単一行が maxChars を超える場合は末尾側を切り出す", () => {
    const raw = `head-${"x".repeat(200)}`;
    const result = buildAuqScreenContext(raw, { maxChars: 50 });
    expect(result).toBe(raw.slice(-50));
  });
});

describe("dropTrailingPromptBox", () => {
  const rule = "─".repeat(80);
  const status =
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt";

  it("末尾の入力欄の枠 (罫線2本と状態の行) から下を落とし、上の行は書き換えない", () => {
    const raw = [
      "● 作業中",
      "  ⎿ 出力  ",
      "",
      rule,
      "❯ ",
      rule,
      status,
      "",
      "",
    ].join("\n");
    expect(dropTrailingPromptBox(raw)).toBe("● 作業中\n  ⎿ 出力  \n");
  });

  it("入力欄が複数行でも、状態の行が複数あっても落とす", () => {
    const raw = [
      "出力",
      rule,
      "❯ 1行目",
      "  2行目",
      "  3行目",
      rule,
      status,
      "  もう1行",
    ].join("\n");
    expect(dropTrailingPromptBox(raw)).toBe("出力");
  });

  it("罫線が端末の幅より短い空白で終わっていても罫線とみなす", () => {
    const raw = ["出力", `${rule}  `, "❯ ", `${rule} `, status].join("\n");
    expect(dropTrailingPromptBox(raw)).toBe("出力");
  });

  it("罫線が無い画面 (確認の選択肢など) はそのまま返す", () => {
    const raw = ["Do you want to proceed?", "❯ 1. Yes", "  2. No"].join("\n");
    expect(dropTrailingPromptBox(raw)).toBe(raw);
  });

  it("罫線が1本だけなら落とさない", () => {
    const raw = ["出力", rule, "続きの出力"].join("\n");
    expect(dropTrailingPromptBox(raw)).toBe(raw);
  });

  it("下の罫線は、末尾から数えて空でない行が5行までの範囲で探す (空行は数えない)", () => {
    const footer = (count: number) =>
      Array.from({ length: count }, (_, i) => [`状態${i}`, ""]).flat();
    const within = ["出力", rule, "❯ ", rule, ...footer(5)].join("\n");
    expect(dropTrailingPromptBox(within)).toBe("出力");
    const beyond = ["出力", rule, "❯ ", rule, ...footer(6)].join("\n");
    expect(dropTrailingPromptBox(beyond)).toBe(beyond);
  });

  it("上の罫線は、下の罫線から15行までの範囲で探す", () => {
    const body = (count: number) =>
      Array.from({ length: count }, (_, i) => `入力${i}`);
    const within = ["出力", rule, ...body(14), rule, status].join("\n");
    expect(dropTrailingPromptBox(within)).toBe("出力");
    const beyond = ["出力", rule, ...body(15), rule, status].join("\n");
    expect(dropTrailingPromptBox(beyond)).toBe(beyond);
  });

  it("形の違う罫線 (出力の中の区切り線と枠の罫線) は組にしない", () => {
    const shorter = [
      "前の出力",
      "─".repeat(10),
      "大事な結果",
      rule,
      "❯ 1. Yes",
      "  2. No",
    ].join("\n");
    expect(dropTrailingPromptBox(shorter)).toBe(shorter);
    const indented = ["前の出力", `  ${rule}`, "結果", rule, status].join("\n");
    expect(dropTrailingPromptBox(indented)).toBe(indented);
  });

  it("折り返した罫線の端切れが数文字でも、合計の長さで形を比べる", () => {
    const part = "─".repeat(40);
    const tip = "─".repeat(5);
    const box = ["出力", part, tip, "❯ 入力", part, tip, status].join("\n");
    expect(dropTrailingPromptBox(box)).toBe("出力");
    // 合計が違えば組にしない (40 と 45)
    const mismatch = [
      "前の出力",
      part,
      "大事な結果",
      part,
      tip,
      "Yes",
      "No",
    ].join("\n");
    expect(dropTrailingPromptBox(mismatch)).toBe(mismatch);
  });

  it("端切れは状態の行に数えない (下の罫線の下に、空でない行が5行あっても落とす)", () => {
    const part = "─".repeat(40);
    const tip = "─".repeat(5);
    const footer = Array.from({ length: 5 }, (_, i) => `状態${i}`);
    const raw = ["出力", part, tip, "❯ ", part, tip, ...footer].join("\n");
    expect(dropTrailingPromptBox(raw)).toBe("出力");
  });

  it("幅を狭めて罫線が折り返していても、続く罫線の行を1本として落とす", () => {
    const part = "─".repeat(40);
    const last = "─".repeat(12);
    const raw = ["出力", part, last, "❯ 入力", part, last, status].join("\n");
    expect(dropTrailingPromptBox(raw)).toBe("出力");
  });

  it("文字の混じった行や短い線は罫線とみなさない", () => {
    const raw = ["出力", `── 見出し ${rule}`, "❯ ", "─────", status].join("\n");
    expect(dropTrailingPromptBox(raw)).toBe(raw);
  });

  it("落とすと何も残らないとき (起動直後の画面) はそのまま返す", () => {
    const raw = ["", rule, "❯ ", rule, status].join("\n");
    expect(dropTrailingPromptBox(raw)).toBe(raw);
  });

  it("落としたあとの末尾を画面末尾として整形できる", () => {
    const raw = [
      ...Array.from({ length: 20 }, (_, i) => `行${i}`),
      "",
      rule,
      "❯ ",
      rule,
      status,
    ].join("\n");
    expect(
      buildAuqScreenContext(dropTrailingPromptBox(raw), { maxLines: 3 })
    ).toBe("行17\n行18\n行19");
  });
});
