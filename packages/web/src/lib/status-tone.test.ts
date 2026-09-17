import { describe, expect, it } from "vitest";
import {
  presentStatus,
  resolveStatusKey,
  resolveStatusStrip,
  SECTION_LABELS,
  SECTION_ORDER,
  type StatusKey,
} from "./status-tone";

describe("resolveStatusKey", () => {
  it("セッションが無ければ未起動", () => {
    expect(resolveStatusKey(false, undefined)).toBe("NOT_STARTED");
    expect(resolveStatusKey(false, "IDLE")).toBe("NOT_STARTED");
  });
  it("セッションがあって状態が未着なら UNKNOWN", () => {
    expect(resolveStatusKey(true, undefined)).toBe("UNKNOWN");
  });
  it("セッションがあれば BridgeSessionStatus をそのまま使う", () => {
    expect(resolveStatusKey(true, "AWAITING")).toBe("AWAITING");
  });
});

describe("presentStatus", () => {
  const cases: [StatusKey, string, string, string, number][] = [
    ["AWAITING", "awaiting", "確認待ち", "your-turn", 1],
    ["ERR", "error", "問題", "your-turn", 2],
    ["IDLE", "idle", "入力待ち", "your-turn", 3],
    ["TOOL", "busy", "作業中", "working", 4],
    ["THINK", "busy", "作業中", "working", 4],
    ["READY", "neutral", "待機", "resting", 5],
    ["STOP", "neutral", "停止", "resting", 6],
    ["NOT_STARTED", "neutral", "未起動", "resting", 7],
    ["UNKNOWN", "neutral", "", "resting", 8],
  ];
  it.each(cases)(
    "%s → %s / %s / %s / %i",
    (key, tone, label, section, priority) => {
      const p = presentStatus(key);
      expect(p.tone).toBe(tone);
      expect(p.label).toBe(label);
      expect(p.section).toBe(section);
      expect(p.priority).toBe(priority);
    }
  );
  it("未起動だけ枠線のチップにする", () => {
    expect(presentStatus("NOT_STARTED").outlined).toBe(true);
    expect(presentStatus("IDLE").outlined).toBe(false);
  });
  it("入力待ちは成功を意味するチェックの形を使わない", () => {
    expect(presentStatus("IDLE").icon).toBe("message");
  });
});

describe("セクション", () => {
  it("あなたの番 → 作業中 → 休止中 の順", () => {
    expect(SECTION_ORDER).toEqual(["your-turn", "working", "resting"]);
    expect(SECTION_ORDER.map(s => SECTION_LABELS[s])).toEqual([
      "あなたの番",
      "作業中",
      "休止中",
    ]);
  });
});

describe("resolveStatusStrip", () => {
  const base = {
    bridgeStatus: undefined,
    hasActiveAuq: false,
    isConnected: true,
    viewMode: "chat" as const,
  };
  it("切断中はほかの状態より優先する", () => {
    expect(
      resolveStatusStrip({
        ...base,
        bridgeStatus: "AWAITING",
        isConnected: false,
      })
    ).toEqual({
      tone: "error",
      text: "サーバーとつながっていません",
      offerChat: false,
    });
  });
  it("質問カードがあれば「質問があります」", () => {
    expect(
      resolveStatusStrip({
        ...base,
        bridgeStatus: "AWAITING",
        hasActiveAuq: true,
      })
    ).toEqual({ tone: "awaiting", text: "質問があります", offerChat: false });
  });
  it("質問カードが無ければ「確認を求めています」", () => {
    expect(resolveStatusStrip({ ...base, bridgeStatus: "AWAITING" })).toEqual({
      tone: "awaiting",
      text: "確認を求めています",
      offerChat: false,
    });
  });
  it("会話以外のモードでは会話へ戻るボタンを出す", () => {
    expect(
      resolveStatusStrip({
        ...base,
        bridgeStatus: "AWAITING",
        viewMode: "terminal",
      })?.offerChat
    ).toBe(true);
    expect(
      resolveStatusStrip({
        ...base,
        bridgeStatus: "AWAITING",
        viewMode: "board",
      })?.offerChat
    ).toBe(true);
  });
  it("作業中とエラーの文言", () => {
    expect(resolveStatusStrip({ ...base, bridgeStatus: "THINK" })?.text).toBe(
      "考えています"
    );
    expect(resolveStatusStrip({ ...base, bridgeStatus: "TOOL" })?.text).toBe(
      "作業しています"
    );
    expect(resolveStatusStrip({ ...base, bridgeStatus: "ERR" })?.text).toBe(
      "問題が起きています"
    );
  });
  it("入力待ち・待機・停止・未着では出さない", () => {
    for (const bridgeStatus of ["IDLE", "READY", "STOP", undefined] as const) {
      expect(resolveStatusStrip({ ...base, bridgeStatus })).toBeNull();
    }
  });
});
