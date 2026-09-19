// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_VOICE_STATE, type VoiceState } from "@/lib/voice-mode-machine";
import {
  VoiceModeOverlay,
  type VoiceModeOverlayProps,
} from "./VoiceModeOverlay";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let handlers: Omit<VoiceModeOverlayProps, "state" | "bridgeStatus">;

function render(
  state: Partial<VoiceState>,
  bridgeStatus?: VoiceModeOverlayProps["bridgeStatus"]
) {
  act(() =>
    root.render(
      <VoiceModeOverlay
        state={{ ...INITIAL_VOICE_STATE, ...state }}
        bridgeStatus={bridgeStatus}
        {...handlers}
      />
    )
  );
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    b =>
      b.textContent?.includes(label) || b.getAttribute("aria-label") === label
  );
  expect(found).toBeDefined();
  return found as HTMLButtonElement;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  handlers = {
    onExit: vi.fn(),
    onTapMic: vi.fn(),
    onCancel: vi.fn(),
    onSendNow: vi.fn(),
    onStopSpeaking: vi.fn(),
    onExpand: vi.fn(),
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("VoiceModeOverlay", () => {
  it("音声モードの外では何も描かない", () => {
    render({ phase: "off" });
    expect(container.innerHTML).toBe("");
  });

  it("待機では話すボタンを出す", () => {
    render({ phase: "ready", notice: "マイクが使えません (audio-capture)" });
    expect(container.textContent).toContain("タップして話す");
    expect(container.textContent).toContain("マイクが使えません");
    act(() => button("話す").click());
    expect(handlers.onTapMic).toHaveBeenCalled();
  });

  it("聞き取り中は途中結果を出し、やめられる", () => {
    render({ phase: "listening", transcript: "テストを" });
    expect(container.textContent).toContain("聞いています");
    expect(container.textContent).toContain("テストを");
    act(() => button("やめる").click());
    expect(handlers.onCancel).toHaveBeenCalled();
  });

  it("送信待ちでは文を出し、取り消しとすぐ送るを押せる", () => {
    render({ phase: "confirming", transcript: "テストを直して" });
    expect(container.textContent).toContain("2秒後に送ります");
    expect(container.textContent).toContain("テストを直して");
    act(() => button("取り消す").click());
    act(() => button("すぐ送る").click());
    expect(handlers.onCancel).toHaveBeenCalled();
    expect(handlers.onSendNow).toHaveBeenCalled();
  });

  it("作業中はClaudeの状態を出し、追加で話せる", () => {
    render({ phase: "working" }, "TOOL");
    expect(container.textContent).toContain("作業しています");
    act(() => button("追加で話す").click());
    expect(handlers.onTapMic).toHaveBeenCalled();
  });

  it("読み上げ中は読んでいる文を出し、タップで止められる", () => {
    render({
      phase: "speaking",
      speaking: ["直しました。", "テストも通りました。"],
    });
    expect(container.textContent).toContain("直しました。テストも通りました。");
    act(() => button("タップで止める").click());
    expect(handlers.onStopSpeaking).toHaveBeenCalled();
  });

  it("画面で操作するときは帯に畳み、タップで戻る", () => {
    render({ phase: "screen" });
    expect(
      container.querySelector('[data-testid="voice-mode-overlay"]')
    ).toBeNull();
    const bar = container.querySelector('[data-testid="voice-mode-minimized"]');
    expect(bar?.textContent).toContain("画面で操作してください");
    act(() => (bar as HTMLButtonElement).click());
    expect(handlers.onExpand).toHaveBeenCalled();
  });

  it("終了ボタンで抜ける", () => {
    render({ phase: "ready" });
    act(() => button("音声モードを終える").click());
    expect(handlers.onExit).toHaveBeenCalled();
  });
});
