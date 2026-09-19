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
let levelListener: ((level: number) => void) | null;

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

/** ボタンは表示文言ではなく data-testid で探す (文言を変えても配線のテストが壊れないように) */
function button(testId: string): HTMLButtonElement {
  const found = container.querySelector(`[data-testid="${testId}"]`);
  expect(found).not.toBeNull();
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
    onResume: vi.fn(),
    onRetryUnsent: vi.fn(),
    onDismissUnsent: vi.fn(),
    rate: 1.3,
    onCycleRate: vi.fn(),
    subscribeLevel: listener => {
      levelListener = listener;
      return () => {
        levelListener = null;
      };
    },
  };
  levelListener = null;
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
    act(() => button("voice-mode-talk").click());
    expect(handlers.onTapMic).toHaveBeenCalled();
  });

  it("聞き取り中は途中結果を出し、やめられる", () => {
    render({ phase: "listening", transcript: "テストを" });
    expect(container.textContent).toContain("聞いています");
    expect(container.textContent).toContain("テストを");
    act(() => button("voice-mode-stop-listening").click());
    expect(handlers.onCancel).toHaveBeenCalled();
  });

  it("送信待ちでは文を出し、取り消しとすぐ送るを押せる", () => {
    render({ phase: "confirming", transcript: "テストを直して" });
    expect(container.textContent).toContain("2秒後に送ります");
    expect(container.textContent).toContain("テストを直して");
    act(() => button("voice-mode-cancel-send").click());
    act(() => button("voice-mode-send-now").click());
    expect(handlers.onCancel).toHaveBeenCalled();
    expect(handlers.onSendNow).toHaveBeenCalled();
  });

  it("作業中はClaudeの状態を出し、追加で話せる", () => {
    render({ phase: "working" }, "TOOL");
    expect(container.textContent).toContain("作業しています");
    act(() => button("voice-mode-talk-more").click());
    expect(handlers.onTapMic).toHaveBeenCalled();
  });

  it("読み上げ中は読んでいる文を出し、タップで止められる", () => {
    render({
      phase: "speaking",
      speaking: ["直しました。", "テストも通りました。"],
    });
    expect(container.textContent).toContain("直しました。テストも通りました。");
    act(() => button("voice-mode-stop-speaking").click());
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

  it("一時停止中は再開ボタンを出す", () => {
    render({ phase: "paused" });
    expect(container.textContent).toContain("一時停止しています");
    act(() => button("voice-mode-resume").click());
    expect(handlers.onResume).toHaveBeenCalled();
  });

  it("送っていない指示を出し、送るか消すかを選べる", () => {
    render({ phase: "ready", unsent: "テストを直して" });
    expect(
      container.querySelector('[data-testid="voice-mode-unsent"]')?.textContent
    ).toContain("テストを直して");
    act(() => button("voice-mode-unsent-send").click());
    act(() => button("voice-mode-unsent-dismiss").click());
    expect(handlers.onRetryUnsent).toHaveBeenCalled();
    expect(handlers.onDismissUnsent).toHaveBeenCalled();
  });

  it("帯に畳んでいても、送っていない指示があることを出す", () => {
    render({ phase: "screen", unsent: "テストを直して" });
    expect(
      container.querySelector('[data-testid="voice-mode-minimized"]')
        ?.textContent
    ).toContain("未送信あり");
  });

  it("右上で読み上げの速さを切り替えられる", () => {
    render({ phase: "ready" });
    const rateButton = button("voice-mode-rate");
    expect(rateButton.textContent).toBe("1.3倍");
    act(() => rateButton.click());
    expect(handlers.onCycleRate).toHaveBeenCalled();
  });

  it("聞き取り中は、声の大きさに合わせて丸が伸び縮みする", () => {
    render({ phase: "listening" });
    const orb = container.querySelector(
      '[data-testid="voice-mode-orb"]'
    ) as HTMLElement;
    expect(orb.style.transform).toBe("scale(1)");
    act(() => levelListener?.(1));
    expect(orb.style.transform).toBe("scale(1.6)");
    act(() => levelListener?.(0));
    expect(orb.style.transform).toBe("scale(1)");
  });

  it("終了ボタンで抜ける", () => {
    render({ phase: "ready" });
    act(() => button("voice-mode-exit").click());
    expect(handlers.onExit).toHaveBeenCalled();
  });
});
