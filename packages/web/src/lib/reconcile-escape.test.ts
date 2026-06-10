/**
 * reconcileEscape の単体テスト。Esc 押下時の 4 分岐を網羅する。
 */

import { describe, expect, it } from "vitest";
import { type EscapeContext, reconcileEscape } from "./reconcile-escape";

const base: EscapeContext = {
  inputValue: "",
  slashOpen: false,
  lastSubmitted: "",
};

describe("reconcileEscape", () => {
  describe("分岐 1: スラッシュ補完が開いているとき", () => {
    it("最優先で補完を閉じる (他状態に依存しない)", () => {
      expect(
        reconcileEscape({ ...base, slashOpen: true, inputValue: "/foo" })
      ).toEqual({ kind: "close-slash" });
    });

    it("入力欄が空でも lastSubmitted があっても close-slash 優先", () => {
      expect(
        reconcileEscape({
          slashOpen: true,
          inputValue: "",
          lastSubmitted: "prev",
        })
      ).toEqual({ kind: "close-slash" });
    });
  });

  describe("分岐 2: 入力欄に文字があるとき", () => {
    it("clear-input を返し tmux 送信はしない", () => {
      expect(reconcileEscape({ ...base, inputValue: "draft" })).toEqual({
        kind: "clear-input",
      });
    });

    it("lastSubmitted が残っていても 入力中なら clear-input が優先", () => {
      // 「直前送信後にユーザが新しいテキストを打ち始めた」状態。
      // Esc は新しい入力を消すだけにとどめ、Claude 側へは送らない。
      expect(
        reconcileEscape({
          inputValue: "new draft",
          slashOpen: false,
          lastSubmitted: "old prompt",
        })
      ).toEqual({ kind: "clear-input" });
    });

    it("空白だけでも length > 0 なら clear-input 扱い", () => {
      expect(reconcileEscape({ ...base, inputValue: " " })).toEqual({
        kind: "clear-input",
      });
    });
  });

  describe("分岐 3: 入力欄空 + 直前送信あり", () => {
    it("interrupt + restore + removePendingText を返す", () => {
      expect(reconcileEscape({ ...base, lastSubmitted: "中止テスト" })).toEqual(
        {
          kind: "interrupt",
          restore: "中止テスト",
          removePendingText: "中止テスト",
        }
      );
    });
  });

  describe("分岐 4: 入力欄空 + 直前送信なし", () => {
    it("純粋な interrupt (restore=null, removePendingText=null)", () => {
      expect(reconcileEscape(base)).toEqual({
        kind: "interrupt",
        restore: null,
        removePendingText: null,
      });
    });
  });

  describe("分岐の優先順位", () => {
    it("優先度: close-slash > clear-input > interrupt", () => {
      // 全条件揃った状態でも close-slash が勝つ
      expect(
        reconcileEscape({
          slashOpen: true,
          inputValue: "draft",
          lastSubmitted: "prev",
        })
      ).toEqual({ kind: "close-slash" });
    });

    it("close-slash 不発時に clear-input が勝つ", () => {
      expect(
        reconcileEscape({
          slashOpen: false,
          inputValue: "draft",
          lastSubmitted: "prev",
        })
      ).toEqual({ kind: "clear-input" });
    });
  });
});
