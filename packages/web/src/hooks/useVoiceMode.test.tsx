// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveAuq } from "@/lib/ask-user-question-state";
import type { RecognitionHandlers, SpeechPort } from "@/lib/browser-speech";
import type { JsonlParsedEvent } from "@/lib/jsonl-event-parser";
import { CONFIRM_ON_SCREEN, REPLY_ON_SCREEN } from "@/lib/speech-text";
import {
  SETTLED_MS,
  SILENCE_MS,
  type UseVoiceModeOptions,
  useVoiceMode,
  type VoiceModeControls,
} from "./useVoiceMode";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class FakePort implements SpeechPort {
  calls: string[] = [];
  handlers: RecognitionHandlers | null = null;
  spoken: string[][] = [];
  private idle: (() => void) | null = null;
  startRecognition(handlers: RecognitionHandlers) {
    this.calls.push("startRecognition");
    this.handlers = handlers;
  }
  stopRecognition() {
    this.calls.push("stopRecognition");
  }
  abortRecognition() {
    this.calls.push("abortRecognition");
    this.handlers = null;
  }
  unlockSpeech() {
    this.calls.push("unlockSpeech");
  }
  speak(sentences: string[], onIdle: () => void) {
    this.calls.push("speak");
    this.spoken.push(sentences);
    this.idle = onIdle;
  }
  cancelSpeech() {
    this.calls.push("cancelSpeech");
    this.idle = null;
  }
  async requestWakeLock() {
    this.calls.push("requestWakeLock");
    return true;
  }
  releaseWakeLock() {
    this.calls.push("releaseWakeLock");
  }
  finishSpeech() {
    const idle = this.idle;
    this.idle = null;
    act(() => idle?.());
  }
}

const user = (id: string): JsonlParsedEvent => ({
  id,
  kind: "user-input",
  text: "指示",
});
const reply = (id: string, text: string): JsonlParsedEvent => ({
  id,
  kind: "assistant-text",
  text,
  endTurn: true,
});
const AUQ: ActiveAuq = {
  toolUseId: "hook:1",
  questions: [
    {
      question: "どちらにしますか？",
      multiSelect: false,
      options: [{ label: "A" }, { label: "B" }],
    },
  ],
};

let container: HTMLDivElement;
let root: Root;
let port: FakePort;
let controls: VoiceModeControls;
let props: UseVoiceModeOptions;

function Probe(options: UseVoiceModeOptions) {
  controls = useVoiceMode(options);
  return null;
}

function render(overrides: Partial<UseVoiceModeOptions> = {}) {
  props = { ...props, ...overrides };
  act(() => root.render(<Probe {...props} />));
}

/** 話して送り、作業中にする */
function speakAndSend(text: string) {
  act(() => controls.enter());
  act(() => port.handlers?.onFinal(text));
  act(() => vi.advanceTimersByTime(2000));
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  port = new FakePort();
  props = {
    isActive: true,
    isConnected: true,
    bridgeStatus: "IDLE",
    activeAuq: null,
    onSendMessage: vi.fn(),
    port,
    supported: true,
  };
  render();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("useVoiceMode", () => {
  it("入ると、タップの処理の中で読み上げの解錠・画面の点灯維持・認識の開始を行う", () => {
    act(() => controls.enter());
    expect(port.calls).toEqual([
      "unlockSpeech",
      "requestWakeLock",
      "startRecognition",
    ]);
    expect(controls.state.phase).toBe("listening");
  });

  it("話して2秒待つと送る", () => {
    act(() => controls.enter());
    act(() => port.handlers?.onFinal("テストを直して"));
    expect(controls.state.phase).toBe("confirming");
    expect(props.onSendMessage).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(2000));
    expect(props.onSendMessage).toHaveBeenCalledWith("テストを直して");
    expect(controls.state.phase).toBe("working");
  });

  it("送る直前に確認が出ていたら送らず、画面での確認が要ると読む", () => {
    act(() => controls.enter());
    act(() => port.handlers?.onFinal("テストを直して"));
    render({ bridgeStatus: "AWAITING" });
    act(() => vi.advanceTimersByTime(2000));
    expect(props.onSendMessage).not.toHaveBeenCalled();
    expect(port.spoken.at(-1)).toEqual([CONFIRM_ON_SCREEN]);
  });

  it("接続が切れていたら送らない", () => {
    act(() => controls.enter());
    act(() => port.handlers?.onFinal("テストを直して"));
    render({ isConnected: false });
    act(() => vi.advanceTimersByTime(2000));
    expect(props.onSendMessage).not.toHaveBeenCalled();
    expect(controls.state.phase).toBe("ready");
  });

  it("途中結果が2秒変わらなければ、認識を止めて送信待ちに入る", () => {
    act(() => controls.enter());
    act(() => port.handlers?.onInterim("途中まで"));
    act(() => vi.advanceTimersByTime(SILENCE_MS));
    expect(port.calls).toContain("stopRecognition");
    expect(controls.state.phase).toBe("confirming");
    expect(controls.state.transcript).toBe("途中まで");
  });

  it("入る前の返答は読まず、入った後のターンの終わりを読み、読み終えたら自動で聞き取る", () => {
    const history = [user("u1"), reply("a1", "前の返答。")];
    act(() => controls.pushEvents(history));
    speakAndSend("テストを直して");
    act(() => controls.pushEvents(history));
    expect(port.spoken).toEqual([]);
    act(() =>
      controls.pushEvents([...history, user("u2"), reply("a2", "直しました。")])
    );
    expect(port.spoken).toEqual([["直しました。"]]);
    expect(controls.state.phase).toBe("speaking");
    const startsBefore = port.calls.filter(
      c => c === "startRecognition"
    ).length;
    port.finishSpeech();
    expect(port.calls.filter(c => c === "startRecognition").length).toBe(
      startsBefore + 1
    );
    expect(controls.state.phase).toBe("listening");
  });

  it("作業中にClaudeが止まったまま5秒経ったら、返答は画面でと読む", () => {
    speakAndSend("テストを直して");
    expect(controls.state.phase).toBe("working");
    act(() => vi.advanceTimersByTime(SETTLED_MS));
    expect(port.spoken.at(-1)).toEqual([REPLY_ON_SCREEN]);
  });

  it("Claudeが動き出したら、止まったままの判定をやり直す", () => {
    speakAndSend("テストを直して");
    act(() => vi.advanceTimersByTime(SETTLED_MS - 1000));
    render({ bridgeStatus: "THINK" });
    act(() => vi.advanceTimersByTime(SETTLED_MS));
    expect(port.spoken).toEqual([]);
  });

  it("質問が来たら読み、読み終えたら畳む。質問が解決したら作業中に戻る", () => {
    speakAndSend("テストを直して");
    render({ activeAuq: AUQ, bridgeStatus: "AWAITING" });
    expect(port.spoken.at(-1)?.[0]).toBe("Claudeから質問です。");
    port.finishSpeech();
    expect(controls.state.phase).toBe("screen");
    render({ activeAuq: null, bridgeStatus: "THINK" });
    expect(controls.state.phase).toBe("working");
  });

  it("同じ質問は二度読まない", () => {
    speakAndSend("テストを直して");
    render({ activeAuq: AUQ, bridgeStatus: "AWAITING" });
    port.finishSpeech();
    render({ activeAuq: { ...AUQ }, bridgeStatus: "AWAITING" });
    expect(port.spoken).toHaveLength(1);
  });

  it("セッションの画面から離れたら終える", () => {
    act(() => controls.enter());
    render({ isActive: false });
    expect(controls.state.phase).toBe("off");
    expect(port.calls.slice(-3)).toEqual([
      "abortRecognition",
      "cancelSpeech",
      "releaseWakeLock",
    ]);
  });

  it("画面が隠れたら止めて待機にする", () => {
    act(() => controls.enter());
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(controls.state.phase).toBe("ready");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  it("診断を送る", () => {
    const onDiagnostic = vi.fn();
    render({ onDiagnostic });
    act(() => controls.enter());
    act(() => port.handlers?.onError("not-allowed"));
    expect(onDiagnostic).toHaveBeenCalledWith(
      "recognition-error",
      "not-allowed"
    );
  });
});
