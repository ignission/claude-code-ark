/**
 * auq-screen-context のテスト
 *
 * buildAuqScreenContext は tmux capture-pane の生出力を AUQ カードの
 * 「直前の画面」表示用に整形する純粋関数。verbatim 原則 (内容の解釈・
 * パースをしない) を守り、行うのは末尾空行の除去とサイズ上限のみ。
 */

import { describe, expect, it } from "vitest";
import { buildAuqScreenContext } from "./auq-screen-context.js";

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
    expect(result!.length).toBeLessThanOrEqual(350);
    // 末尾 (最新) 側が残る
    expect(result!.endsWith("9".repeat(100))).toBe(true);
    // 行の途中で切らない (行単位で落とす)
    expect(result).toBe(lines.slice(7).join("\n"));
  });

  it("単一行が maxChars を超える場合は末尾側を切り出す", () => {
    const raw = `head-${"x".repeat(200)}`;
    const result = buildAuqScreenContext(raw, { maxChars: 50 });
    expect(result).toBe(raw.slice(-50));
  });
});
