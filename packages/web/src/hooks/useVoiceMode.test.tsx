// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveAuq } from "@/lib/ask-user-question-state";
import type { RecognitionHandlers, SpeechPort } from "@/lib/browser-speech";
import type { JsonlParsedEvent } from "@/lib/jsonl-event-parser";
import {
  CONFIRM_ON_SCREEN,
  CONTINUED_SUFFIX,
  REPLY_ON_SCREEN,
} from "@/lib/speech-text";
import {
  DEFAULT_VOICE_RATE,
  SETTLED_MS,
  SILENCE_MS,
  STORAGE_KEY_VOICE_RATE,
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
  rates: number[] = [];
  meter: {
    onLevel: (level: number) => void;
    onError: (error: string) => void;
  } | null = null;
  setRate(rate: number) {
    this.rates.push(rate);
  }
  startLevelMeter(
    onLevel: (level: number) => void,
    onError: (error: string) => void
  ) {
    this.calls.push("startLevelMeter");
    this.meter = { onLevel, onError };
  }
  stopLevelMeter() {
    this.calls.push("stopLevelMeter");
    this.meter = null;
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

function setVisibility(value: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

/** 話して送り、作業中にする */
function speakAndSend(text: string) {
  act(() => controls.enter());
  act(() => port.handlers?.onFinal(text));
  act(() => vi.advanceTimersByTime(2000));
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
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
      "startLevelMeter",
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
    act(() => controls.pushEvents(history, true));
    speakAndSend("テストを直して");
    act(() => controls.pushEvents(history, true));
    expect(port.spoken).toEqual([]);
    act(() =>
      controls.pushEvents(
        [...history, user("u2"), reply("a2", "直しました。")],
        true
      )
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
    // 認識を捨て、マイク (音量の計測) を手放し、読み上げと画面の点灯維持を止める
    expect(port.calls.slice(-4)).toEqual([
      "abortRecognition",
      "stopLevelMeter",
      "cancelSpeech",
      "releaseWakeLock",
    ]);
  });

  it("最初の履歴が届く前に入っても、後から届いた履歴は読まない", () => {
    act(() => controls.pushEvents([], false));
    speakAndSend("テストを直して");
    const history = [user("u1"), reply("a1", "前の返答。")];
    act(() => controls.pushEvents(history, true));
    expect(port.spoken).toEqual([]);
    act(() =>
      controls.pushEvents(
        [...history, user("u2"), reply("a2", "直しました。")],
        true
      )
    );
    expect(port.spoken).toEqual([["直しました。"]]);
  });

  it("画面が隠れたら一時停止し、その間に届いた返答や質問は再開のタップまで読まない", () => {
    const history = [user("u1")];
    act(() => controls.pushEvents(history, true));
    speakAndSend("テストを直して");
    setVisibility("hidden");
    expect(controls.state.phase).toBe("paused");
    act(() =>
      controls.pushEvents(
        [...history, reply("a1", "離れていた間の返答。")],
        true
      )
    );
    render({ activeAuq: AUQ, bridgeStatus: "AWAITING" });
    expect(port.spoken).toEqual([]);
    setVisibility("visible");
    expect(port.spoken).toEqual([]);
    // 再開したら、溜めた返答に続けて、一時停止中に出た質問も読む
    act(() => controls.resume());
    expect(port.spoken[0]).toEqual(["離れていた間の返答。"]);
    expect(port.spoken[1]?.[0]).toBe("Claudeから質問です。");
    port.finishSpeech();
    expect(controls.state.phase).toBe("screen");
  });

  it("質問を読んだ後に一時停止しても、再開したら聞き取らずに画面での操作へ戻る", () => {
    speakAndSend("テストを直して");
    render({ activeAuq: AUQ, bridgeStatus: "AWAITING" });
    port.finishSpeech();
    expect(controls.state.phase).toBe("screen");
    setVisibility("hidden");
    setVisibility("visible");
    const startsBefore = port.calls.filter(
      c => c === "startRecognition"
    ).length;
    act(() => controls.resume());
    expect(controls.state.phase).toBe("screen");
    expect(port.calls.filter(c => c === "startRecognition").length).toBe(
      startsBefore
    );
  });

  it("送らなかった指示は「送る」で送信待ちからやり直す", () => {
    act(() => controls.enter());
    act(() => port.handlers?.onFinal("テストを直して"));
    render({ isConnected: false });
    act(() => vi.advanceTimersByTime(2000));
    expect(controls.state.unsent).toBe("テストを直して");
    render({ isConnected: true });
    act(() => controls.retryUnsent());
    expect(controls.state.phase).toBe("confirming");
    act(() => vi.advanceTimersByTime(2000));
    expect(props.onSendMessage).toHaveBeenCalledWith("テストを直して");
    expect(controls.state.unsent).toBeNull();
  });

  it("追加で話して取り消した後に権限確認が出たら、画面での操作へ移る", () => {
    speakAndSend("テストを直して");
    render({ bridgeStatus: "THINK" });
    act(() => controls.tapMic());
    act(() => controls.cancel());
    expect(controls.state.phase).toBe("ready");
    render({ bridgeStatus: "AWAITING" });
    expect(port.spoken.at(-1)).toEqual([CONFIRM_ON_SCREEN]);
    port.finishSpeech();
    expect(controls.state.phase).toBe("screen");
  });

  it("確認が残ったまま帯から戻っても、また畳まない (終了に手が届くように)", () => {
    speakAndSend("テストを直して");
    render({ bridgeStatus: "AWAITING" });
    port.finishSpeech();
    expect(controls.state.phase).toBe("screen");
    act(() => controls.expand());
    expect(controls.state.phase).toBe("ready");
    expect(port.spoken).toHaveLength(1);
  });

  it("聞き取り中に出た権限確認は、取り消して待機に戻ったときに案内する", () => {
    speakAndSend("テストを直して");
    render({ bridgeStatus: "THINK" });
    act(() => controls.tapMic());
    render({ bridgeStatus: "AWAITING" });
    expect(port.spoken).toEqual([]);
    act(() => controls.cancel());
    expect(port.spoken.at(-1)).toEqual([CONFIRM_ON_SCREEN]);
  });

  it("同じ返答の本文が別々に届いても、読み上げは返答全体で300文字まで", () => {
    act(() => controls.pushEvents([user("u1")], true));
    speakAndSend("テストを直して");
    const block = `${"あ".repeat(249)}。`;
    const first = [user("u1"), user("u2"), reply("b1", block)];
    act(() => controls.pushEvents(first, true));
    act(() => controls.pushEvents([...first, reply("b2", block)], true));
    const spokenText = port.spoken.flat();
    expect(spokenText.at(-1)).toBe(CONTINUED_SUFFIX);
    const body = spokenText.filter(t => t !== CONTINUED_SUFFIX).join("");
    expect(body.length).toBeLessThanOrEqual(300);
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

  it("読み上げの速さは既定で1.3倍。切り替えると1.6→1.0→1.3と巡り、この端末に保存する", () => {
    expect(controls.rate).toBe(DEFAULT_VOICE_RATE);
    expect(port.rates.at(-1)).toBe(1.3);
    act(() => controls.cycleRate());
    expect(controls.rate).toBe(1.6);
    expect(port.rates.at(-1)).toBe(1.6);
    expect(localStorage.getItem(STORAGE_KEY_VOICE_RATE)).toBe("1.6");
    act(() => controls.cycleRate());
    expect(controls.rate).toBe(1);
    act(() => controls.cycleRate());
    expect(controls.rate).toBe(1.3);
  });

  it("保存した速さで始める", () => {
    act(() => root.unmount());
    localStorage.setItem(STORAGE_KEY_VOICE_RATE, "1.6");
    root = createRoot(container);
    render();
    expect(controls.rate).toBe(1.6);
  });

  it("聞き取り中はマイクの音量を画面へ届け、確定したら計測を止めて0に戻す", () => {
    const levels: number[] = [];
    const unsubscribe = controls.subscribeLevel(level => levels.push(level));
    act(() => controls.enter());
    act(() => port.meter?.onLevel(0.4));
    expect(levels).toEqual([0.4]);
    act(() => port.handlers?.onFinal("テストを直して"));
    expect(port.calls).toContain("stopLevelMeter");
    expect(levels.at(-1)).toBe(0);
    unsubscribe();
  });

  it("認識がマイクのエラーで止まったら、このセッションでは音量の計測をやめる", () => {
    act(() => controls.enter());
    act(() => port.handlers?.onError("audio-capture"));
    const before = port.calls.filter(c => c === "startLevelMeter").length;
    act(() => controls.tapMic());
    expect(port.calls.filter(c => c === "startLevelMeter").length).toBe(before);
  });

  it("マイクの音量が取れないときは、途中結果が届くたびに動かす", () => {
    const levels: number[] = [];
    controls.subscribeLevel(level => levels.push(level));
    act(() => controls.enter());
    act(() => port.meter?.onError("NotAllowedError"));
    act(() => port.handlers?.onInterim("テスト"));
    expect(levels.at(-1)).toBeGreaterThan(0);
    act(() => vi.advanceTimersByTime(300));
    expect(levels.at(-1)).toBe(0);
  });
});
