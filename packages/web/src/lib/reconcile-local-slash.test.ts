/**
 * reconcileLocalSlash の単体テスト。
 *
 * 純粋関数なので時刻は引数 (sentAt / timestamp) で完結する。
 * helper で経過ミリ秒 (ago) を使って記述する:
 *   localCmd("a", "/clear", 100)      → 100ms 前に送った /clear のローカルカード
 *   recorded("/clear", 50)            → 50ms 前の timestamp を持つ記録イベント
 */

import { describe, expect, it } from "vitest";
import type { JsonlParsedEvent } from "./jsonl-event-parser";
import {
  type LocalSlashCommand,
  reconcileLocalSlash,
} from "./reconcile-local-slash";

const NOW = 1_700_000_000_000;

function localCmd(
  id: string,
  name: string,
  ago: number,
  args?: string
): LocalSlashCommand {
  return { id, name, args, sentAt: NOW - ago };
}

function recorded(
  name: string,
  ago: number,
  args?: string,
  id = "e"
): JsonlParsedEvent {
  return { id, kind: "slash-command", name, args, timestamp: NOW - ago };
}

function userInput(text: string, ago: number, id = "e"): JsonlParsedEvent {
  return { id, kind: "user-input", text, timestamp: NOW - ago };
}

describe("reconcileLocalSlash", () => {
  describe("基本動作", () => {
    it("空のローカルカードは同じ参照を返す (再レンダ抑止)", () => {
      const empty: LocalSlashCommand[] = [];
      expect(reconcileLocalSlash(empty, [])).toBe(empty);
    });

    it("記録が無ければ同じ参照を返す", () => {
      const local = [localCmd("a", "/clear", 100)];
      expect(reconcileLocalSlash(local, [])).toBe(local);
    });

    it("同じコマンドの記録が現れたらローカルカードを消す", () => {
      const local = [localCmd("a", "/clear", 100)];
      expect(reconcileLocalSlash(local, [recorded("/clear", 50)])).toEqual([]);
    });

    it("コマンド名が違う記録では消えない", () => {
      const local = [localCmd("a", "/clear", 100)];
      const next = reconcileLocalSlash(local, [recorded("/compact", 50)]);
      expect(next).toBe(local);
    });

    it("slash-command 以外のイベントは無視する", () => {
      const local = [localCmd("a", "/clear", 100)];
      const next = reconcileLocalSlash(local, [userInput("/clear", 50)]);
      expect(next).toBe(local);
    });
  });

  describe("1 対 1 の消費", () => {
    it("同じコマンドを 2 回送って記録が 1 件なら 1 枚残る", () => {
      const local = [
        localCmd("a", "/clear", 200),
        localCmd("b", "/clear", 100),
      ];
      const next = reconcileLocalSlash(local, [recorded("/clear", 50)]);
      expect(next).toHaveLength(1);
      expect(next[0].id).toBe("b");
    });

    it("記録が 2 件揃えば 2 枚とも消える", () => {
      const local = [
        localCmd("a", "/clear", 200),
        localCmd("b", "/clear", 100),
      ];
      const events = [
        recorded("/clear", 80, undefined, "e1"),
        recorded("/clear", 50, undefined, "e2"),
      ];
      expect(reconcileLocalSlash(local, events)).toEqual([]);
    });

    it("1 件の記録が複数のローカルカードを消さない (古い方から消費)", () => {
      const local = [
        localCmd("b", "/clear", 100),
        localCmd("a", "/clear", 200),
      ];
      const next = reconcileLocalSlash(local, [recorded("/clear", 50)]);
      expect(next.map(c => c.id)).toEqual(["b"]);
    });
  });

  describe("引数の突き合わせ", () => {
    it("引数まで一致したときだけ消える", () => {
      const local = [localCmd("a", "/compact", 100, "要約して")];
      expect(
        reconcileLocalSlash(local, [recorded("/compact", 50, "要約して")])
      ).toEqual([]);
    });

    it("引数が違えば残る", () => {
      const local = [localCmd("a", "/compact", 100, "要約して")];
      const next = reconcileLocalSlash(local, [
        recorded("/compact", 50, "短く"),
      ]);
      expect(next).toBe(local);
    });

    it("記録側の空引数 (undefined) とローカルの空文字を同一視する", () => {
      const local = [localCmd("a", "/clear", 100, "")];
      expect(reconcileLocalSlash(local, [recorded("/clear", 50)])).toEqual([]);
    });

    it("ローカルの undefined と記録側の空文字を同一視する", () => {
      const local = [localCmd("a", "/clear", 100)];
      expect(reconcileLocalSlash(local, [recorded("/clear", 50, "")])).toEqual(
        []
      );
    });

    it("引数の前後の空白は無視して一致判定", () => {
      const local = [localCmd("a", "/compact", 100, "要約  して")];
      const next = reconcileLocalSlash(local, [
        recorded("/compact", 50, " 要約 して "),
      ]);
      expect(next).toEqual([]);
    });

    it("引数付きのカードを引数無しの記録では消さない", () => {
      const local = [localCmd("a", "/compact", 100, "要約して")];
      const next = reconcileLocalSlash(local, [recorded("/compact", 50)]);
      expect(next).toBe(local);
    });
  });

  describe("時刻の扱い", () => {
    it("sentAt より前の記録 (過去の履歴) では消えない", () => {
      const local = [localCmd("a", "/clear", 100)];
      // 5 秒前の記録 = 送信より前 → 過去の /clear なので消費に使わない
      const next = reconcileLocalSlash(local, [recorded("/clear", 5_000)]);
      expect(next).toBe(local);
    });

    it("1 秒までの clock skew は許容する", () => {
      const local = [localCmd("a", "/clear", 100)];
      // 送信の 900ms 前 = skew 許容内
      const next = reconcileLocalSlash(local, [recorded("/clear", 1_000)]);
      expect(next).toEqual([]);
    });

    it("timestamp の無い記録は消費に使わない", () => {
      const local = [localCmd("a", "/clear", 100)];
      const next = reconcileLocalSlash(local, [
        { id: "e", kind: "slash-command", name: "/clear" },
      ]);
      expect(next).toBe(local);
    });
  });

  describe("記録が現れないコマンド", () => {
    it("時間が経ってもローカルカードは残したままにする", () => {
      // <local-command-stdout> だけで記録が残らないコマンドは、消すと
      // 実行の痕跡が会話から消えてしまうため時間切れでは片付けない
      const local = [localCmd("a", "/status", 30 * 60_000)];
      expect(reconcileLocalSlash(local, [])).toBe(local);
    });
  });
});
