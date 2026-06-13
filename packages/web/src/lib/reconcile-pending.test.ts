/**
 * reconcilePending の単体テスト。
 *
 * 純粋関数なので時刻 (now) を引数で渡せる。
 * helper を使い pending / event は経過秒数 (ago, ms) で記述する:
 *   pending("a", "hello", 100)        → 100ms 前に送信した "hello" pending
 *   userInput("hello", 50)            → 50ms 前にタイムスタンプを持つ user-input event
 */

import { describe, expect, it } from "vitest";
import type { JsonlParsedEvent } from "./jsonl-event-parser";
import { type PendingMessage, reconcilePending } from "./reconcile-pending";

const NOW = 1_700_000_000_000;

function pending(id: string, text: string, ago: number): PendingMessage {
  return { id, text, sentAt: NOW - ago };
}

function userInput(text: string, ago: number, id = "e"): JsonlParsedEvent {
  return { id, kind: "user-input", text, timestamp: NOW - ago };
}

function assistant(text: string, ago: number, id = "e"): JsonlParsedEvent {
  return { id, kind: "assistant-text", text, timestamp: NOW - ago };
}

describe("reconcilePending", () => {
  describe("基本動作", () => {
    it("空 pending は同じ参照を返す (再レンダ抑止)", () => {
      const empty: PendingMessage[] = [];
      expect(reconcilePending(empty, [], NOW)).toBe(empty);
    });

    it("マッチ無しなら同じ参照を返す", () => {
      const p = [pending("a", "hello", 100)];
      expect(reconcilePending(p, [], NOW)).toBe(p);
    });

    it("正規化テキスト完全一致で pending を除去", () => {
      const p = [pending("a", "hello", 100)];
      const evs = [userInput("hello", 50)];
      expect(reconcilePending(p, evs, NOW)).toEqual([]);
    });

    it("user-input 以外のイベントは無視する", () => {
      const p = [pending("a", "hello", 100)];
      const evs = [assistant("hello", 50)];
      expect(reconcilePending(p, evs, NOW)).toEqual(p);
    });
  });

  describe("テキスト正規化", () => {
    it("前後の空白・改行は無視して一致判定", () => {
      const p = [pending("a", "hello", 100)];
      const evs = [userInput("  hello  \n", 50)];
      expect(reconcilePending(p, evs, NOW)).toEqual([]);
    });

    it("連続する空白は 1 つにまとめて比較", () => {
      const p = [pending("a", "hello   world", 100)];
      const evs = [userInput("hello world", 50)];
      expect(reconcilePending(p, evs, NOW)).toEqual([]);
    });

    it("改行を空白として正規化して比較", () => {
      const p = [pending("a", "line1\nline2", 100)];
      const evs = [userInput("line1 line2", 50)];
      expect(reconcilePending(p, evs, NOW)).toEqual([]);
    });

    it("Unicode 分解形 (NFD) と合成形 (NFC) を同一視する", () => {
      // U+30D1 (NFC) ⇔ U+30CF + U+309A (NFD) のどちらも「パ」を表す
      const nfcText = "パ";
      const nfdText = "パ";
      expect(nfcText.normalize("NFD")).toBe(nfdText);
      const p = [pending("a", nfcText, 100)];
      const evs = [userInput(nfdText, 50)];
      expect(reconcilePending(p, evs, NOW)).toEqual([]);
    });
  });

  describe("時刻窓 (clock skew)", () => {
    it("event timestamp が sentAt - 1000ms より前なら一致対象外", () => {
      // p.sentAt = NOW - 100, threshold = sentAt - 1000 = NOW - 1100
      // event timestamp = NOW - 2000 < NOW - 1100 → 不一致
      const p = [pending("a", "hello", 100)];
      const evs = [userInput("hello", 2000)];
      expect(reconcilePending(p, evs, NOW)).toEqual(p);
    });

    it("clock skew 1秒以内の event は許容して一致させる", () => {
      // p.sentAt = NOW - 100, threshold = NOW - 1100
      // event timestamp = NOW - 500 > NOW - 1100 → 一致
      const p = [pending("a", "hello", 100)];
      const evs = [userInput("hello", 500)];
      expect(reconcilePending(p, evs, NOW)).toEqual([]);
    });

    it("sentAt より新しい event (queue 経由) も一致する", () => {
      const p = [pending("a", "hello", 5_000)]; // 5秒前送信
      const evs = [userInput("hello", 100)]; // 100ms 前に JSONL 反映
      expect(reconcilePending(p, evs, NOW)).toEqual([]);
    });
  });

  describe("1 対 1 マッチング (重複消費の防止)", () => {
    it("同一テキストの pending 2 件と event 1 件 → 1 件だけ除去", () => {
      const p1 = pending("a", "hello", 200); // より古い
      const p2 = pending("b", "hello", 100);
      const evs = [userInput("hello", 50)];
      const result = reconcilePending([p1, p2], evs, NOW);
      expect(result.length).toBe(1);
      // FIFO: 古い p1 (sentAt = NOW-200) が先に消費されるので b が残る
      expect(result[0].id).toBe("b");
    });

    it("同一テキストの event 2 件と pending 2 件 → 両方除去", () => {
      const p1 = pending("a", "hello", 200);
      const p2 = pending("b", "hello", 100);
      const evs = [userInput("hello", 80, "e1"), userInput("hello", 30, "e2")];
      const result = reconcilePending([p1, p2], evs, NOW);
      expect(result).toEqual([]);
    });
  });

  describe("タイムアウト", () => {
    it("10 分を超えた pending は match 不要で除去", () => {
      const p = [pending("a", "hello", 11 * 60_000)];
      expect(reconcilePending(p, [], NOW)).toEqual([]);
    });

    it("10 分以内の pending は match 無しなら残す", () => {
      const p = [pending("a", "hello", 9 * 60_000)];
      expect(reconcilePending(p, [], NOW)).toEqual(p);
    });
  });

  describe("FIFO フォールバック", () => {
    it("5秒以上経過 + 未マッチ + 未消費 event → FIFO で割り当て除去", () => {
      const p = [pending("a", "hello", 6_000)];
      const evs = [userInput("totally different text", 3_000)];
      expect(reconcilePending(p, evs, NOW)).toEqual([]);
    });

    it("5秒未満の pending は FIFO 発動しない", () => {
      const p = [pending("a", "hello", 3_000)];
      const evs = [userInput("totally different text", 2_000)];
      expect(reconcilePending(p, evs, NOW)).toEqual(p);
    });

    it("FIFO は古い pending から順に消費する", () => {
      const p1 = pending("a", "first", 10_000); // 10秒前 → FIFO対象
      const p2 = pending("b", "second", 8_000); // 8秒前 → FIFO対象
      const evs = [userInput("noise", 5_000)]; // 1件だけ
      const result = reconcilePending([p1, p2], evs, NOW);
      expect(result.length).toBe(1);
      expect(result[0].id).toBe("b"); // 古い p1 が消費されて b が残る
    });

    it("1st pass で消費済みの event は 2nd pass でも再利用されない", () => {
      // p1 は exact 一致で event[0] を消費。p2 は FIFO 対象だが event は全部消費済み
      const p1 = pending("a", "exact", 6_000);
      const p2 = pending("b", "fallback", 6_000);
      const evs = [userInput("exact", 3_000)]; // 1件しかない
      const result = reconcilePending([p1, p2], evs, NOW);
      expect(result.length).toBe(1);
      expect(result[0].id).toBe("b"); // FIFO は消費する event がないので残す
    });

    it("clock skew より古い event は FIFO 対象にも入らない", () => {
      const p = [pending("a", "hello", 6_000)]; // sentAt = NOW-6000, threshold = NOW-7000
      const evs = [userInput("noise", 8_000)]; // NOW-8000 < threshold
      expect(reconcilePending(p, evs, NOW)).toEqual(p);
    });
  });

  describe("混合シナリオ", () => {
    it("exact + FIFO + 残留 が同時にある状態を整合的に処理する", () => {
      const p1 = pending("a", "exact", 6_000); // exact 一致で消費
      const p2 = pending("b", "fallback", 6_000); // FIFO 対象、event 余りで消費
      const p3 = pending("c", "fresh", 1_000); // 5秒未満なので FIFO 対象外、event 完全一致無し
      const evs = [
        userInput("exact", 4_000, "e1"),
        userInput("noise-different", 3_000, "e2"),
      ];
      const result = reconcilePending([p1, p2, p3], evs, NOW);
      expect(result.map(p => p.id)).toEqual(["c"]);
    });

    it("queue 経由で複数の同文 pending が時間差で消化されるケース", () => {
      // 3 件まとめて submit、Claude が 1 件ずつ消化して JSONL に書き込んだ状況
      const p1 = pending("a", "same", 6_000);
      const p2 = pending("b", "same", 5_500);
      const p3 = pending("c", "same", 5_000);
      const evs = [
        userInput("same", 4_000, "e1"),
        userInput("same", 3_000, "e2"),
        userInput("same", 2_000, "e3"),
      ];
      expect(reconcilePending([p1, p2, p3], evs, NOW)).toEqual([]);
    });
  });
});
