/**
 * auq-hook-bridge のテスト
 *
 * PendingAuq が screen (hook 受信時の tmux 画面 verbatim スナップショット)
 * を保持し、再接続時の再送 (getPending) でも返せることを検証する。
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("./database.js", () => ({
  db: {
    getSetting: vi.fn(() => null),
    setSetting: vi.fn(),
  },
}));

vi.mock("./paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/ark-test-data"),
}));

import { AuqHookBridge } from "./auq-hook-bridge.js";

describe("AuqHookBridge - screen スナップショット", () => {
  it("setPending で渡した screen を getPending が返す", () => {
    const bridge = new AuqHookBridge();
    const questions = [{ question: "どちらにしますか?" }];
    bridge.setPending("s1", questions, "直前の行1\n直前の行2");

    const pending = bridge.getPending("s1");
    expect(pending).not.toBeNull();
    expect(pending!.questions).toBe(questions);
    expect(pending!.screen).toBe("直前の行1\n直前の行2");
  });

  it("screen が null (capture 失敗) でも保持できる", () => {
    const bridge = new AuqHookBridge();
    bridge.setPending("s1", [], null);
    expect(bridge.getPending("s1")!.screen).toBeNull();
  });

  it("同一セッションの再 setPending で screen も上書きされる", () => {
    const bridge = new AuqHookBridge();
    bridge.setPending("s1", [], "古い画面");
    bridge.setPending("s1", [], "新しい画面");
    expect(bridge.getPending("s1")!.screen).toBe("新しい画面");
  });
});
