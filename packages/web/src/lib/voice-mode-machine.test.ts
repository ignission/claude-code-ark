import { describe, expect, it } from "vitest";
import { CONFIRM_ON_SCREEN, REPLY_ON_SCREEN } from "./speech-text";
import {
  CONFIRM_MS,
  INITIAL_VOICE_STATE,
  reduceVoice,
  type VoiceAction,
  type VoiceEffect,
  type VoiceState,
} from "./voice-mode-machine";

/** actions を順に流し、最後の状態と、最後の action が出した副作用を返す */
function run(
  state: VoiceState,
  ...actions: VoiceAction[]
): { state: VoiceState; effects: VoiceEffect[] } {
  let current = state;
  let effects: VoiceEffect[] = [];
  for (const action of actions) {
    const next = reduceVoice(current, action);
    current = next.state;
    effects = next.effects;
  }
  return { state: current, effects };
}

const NOW = 1_000_000;
const listening = run(INITIAL_VOICE_STATE, { type: "enter" }).state;
const confirming = run(listening, {
  type: "final",
  text: "テストを直して",
  now: NOW,
}).state;
const working = run(confirming, { type: "commit", guard: null }).state;
const speakingReply = run(working, {
  type: "turnEnd",
  sentences: ["直しました。"],
}).state;

describe("reduceVoice", () => {
  it("入ると、読み上げの解錠・画面の点灯維持・認識の開始をこの順に指示する", () => {
    const { state, effects } = run(INITIAL_VOICE_STATE, { type: "enter" });
    expect(state.phase).toBe("listening");
    expect(effects).toEqual([
      { type: "unlockSpeech" },
      { type: "requestWakeLock" },
      { type: "startRecognition", auto: false },
    ]);
  });

  it("音声モードの外では入る以外の入力を無視する", () => {
    const { state, effects } = run(INITIAL_VOICE_STATE, { type: "tapMic" });
    expect(state).toBe(INITIAL_VOICE_STATE);
    expect(effects).toEqual([]);
  });

  it("認識が確定したら、2秒の送信待ちに入る", () => {
    expect(confirming.phase).toBe("confirming");
    expect(confirming.transcript).toBe("テストを直して");
    expect(confirming.confirmDeadline).toBe(NOW + CONFIRM_MS);
  });

  it("空の確定は待機に戻る", () => {
    const { state } = run(listening, { type: "final", text: "  ", now: NOW });
    expect(state.phase).toBe("ready");
  });

  it("無音が続いたら途中結果で確定し、認識を止める", () => {
    const { state, effects } = run(
      listening,
      { type: "interim", text: "途中まで" },
      { type: "silence", now: NOW }
    );
    expect(state.phase).toBe("confirming");
    expect(state.transcript).toBe("途中まで");
    expect(effects).toEqual([{ type: "stopRecognition" }]);
  });

  it("認識が何も聞き取らずに終わったら待機、途中結果があれば送信待ち", () => {
    expect(
      run(listening, { type: "recognitionEnd", now: NOW }).state.phase
    ).toBe("ready");
    expect(
      run(
        listening,
        { type: "interim", text: "途中" },
        { type: "recognitionEnd", now: NOW }
      ).state.phase
    ).toBe("confirming");
  });

  it("送信待ち中に遅れて確定が届いたら、文を置き換えて2秒を取り直す", () => {
    const { state } = run(confirming, {
      type: "final",
      text: "テストを直してから出して",
      now: NOW + 500,
    });
    expect(state.transcript).toBe("テストを直してから出して");
    expect(state.confirmDeadline).toBe(NOW + 500 + CONFIRM_MS);
  });

  it("送ると作業中になり、認識を捨ててから送信を指示する", () => {
    const { state, effects } = run(confirming, { type: "commit", guard: null });
    expect(state.phase).toBe("working");
    expect(effects).toEqual([
      { type: "abortRecognition" },
      { type: "send", text: "テストを直して" },
    ]);
  });

  it("送る直前に確認が出ていたら送らず、画面での操作へ案内する", () => {
    const held = run(confirming, { type: "commit", guard: "awaiting" });
    expect(held.effects).not.toContainEqual({
      type: "send",
      text: "テストを直して",
    });
    expect(held.state.phase).toBe("speaking");
    expect(held.state.speaking).toEqual([CONFIRM_ON_SCREEN]);
    expect(held.state.unsent).toBe("テストを直して");
    expect(held.state.notice).toBe("確認が出ていたので送っていません");
    const done = run(held.state, { type: "speechDone" });
    expect(done.state.phase).toBe("screen");
    expect(run(done.state, { type: "screenResolved" }).state.phase).toBe(
      "working"
    );
  });

  it("接続が切れていたら送らず、文を画面に残して待機に戻る", () => {
    const { state, effects } = run(confirming, {
      type: "commit",
      guard: "disconnected",
    });
    expect(state.phase).toBe("ready");
    expect(state.unsent).toBe("テストを直して");
    expect(state.notice).toBe("接続が切れていたので送っていません");
    expect(effects).toEqual([{ type: "abortRecognition" }]);
  });

  it("取り消すと待機に戻り、認識を捨てる", () => {
    const { state, effects } = run(confirming, { type: "cancel" });
    expect(state.phase).toBe("ready");
    expect(effects).toEqual([{ type: "abortRecognition" }]);
  });

  it("作業中にターンの終わりが届いたら読み上げ、読み終えたら自動で聞き取りを試す", () => {
    expect(speakingReply.phase).toBe("speaking");
    expect(speakingReply.speaking).toEqual(["直しました。"]);
    const { state, effects } = run(speakingReply, { type: "speechDone" });
    expect(state.phase).toBe("listening");
    expect(effects).toEqual([{ type: "startRecognition", auto: true }]);
  });

  it("自動の聞き取りをiOSに拒否されたら、何も言わずに待機に落ちる", () => {
    const auto = run(speakingReply, { type: "speechDone" }).state;
    const { state } = run(auto, {
      type: "recognitionError",
      error: "not-allowed",
      auto: true,
    });
    expect(state.phase).toBe("ready");
    expect(state.notice).toBeNull();
  });

  it("タップで始めた聞き取りが拒否されたら、設定を確かめるよう出す", () => {
    const { state } = run(listening, {
      type: "recognitionError",
      error: "not-allowed",
      auto: false,
    });
    expect(state.phase).toBe("ready");
    expect(state.notice).toContain("iPhoneの設定");
  });

  it("聞き取り中に届いたターンの終わりは溜め、聞き取りが終わってから読む", () => {
    const held = run(listening, {
      type: "turnEnd",
      sentences: ["別の返答。"],
    }).state;
    expect(held.phase).toBe("listening");
    expect(held.heldSpeech).toEqual(["別の返答。"]);
    const { state, effects } = run(held, { type: "recognitionEnd", now: NOW });
    expect(state.phase).toBe("speaking");
    expect(effects).toEqual([{ type: "speak", sentences: ["別の返答。"] }]);
  });

  it("読み上げ中に届いたターンの終わりは後ろに続ける", () => {
    const { state, effects } = run(speakingReply, {
      type: "turnEnd",
      sentences: ["続きです。"],
    });
    expect(state.speaking).toEqual(["直しました。", "続きです。"]);
    expect(effects).toEqual([{ type: "speak", sentences: ["続きです。"] }]);
  });

  it("読み上げ中にタップすると止めて待機に戻る", () => {
    const { state, effects } = run(speakingReply, { type: "stopSpeaking" });
    expect(state.phase).toBe("ready");
    expect(effects).toEqual([{ type: "cancelSpeech" }]);
  });

  it("質問が来たら読み上げ、読み終えたら画面での操作へ移る", () => {
    const asked = run(working, {
      type: "question",
      sentences: ["Claudeから質問です。"],
    }).state;
    expect(asked.phase).toBe("speaking");
    expect(asked.afterSpeech).toBe("screen");
    expect(run(asked, { type: "speechDone" }).state.phase).toBe("screen");
  });

  it("送信待ち中に質問が来たら送らず、認識を捨てて質問を読む", () => {
    const { state, effects } = run(confirming, {
      type: "question",
      sentences: ["Claudeから質問です。"],
    });
    expect(state.phase).toBe("speaking");
    expect(state.unsent).toBe("テストを直して");
    expect(state.notice).toBe("質問が来たので送っていません");
    expect(effects).toEqual([
      { type: "abortRecognition" },
      { type: "speak", sentences: ["Claudeから質問です。"] },
    ]);
  });

  it("作業中に権限確認が出たら、画面での確認が要ると言って画面での操作へ移る", () => {
    const { state } = run(working, { type: "awaiting" });
    expect(state.speaking).toEqual([CONFIRM_ON_SCREEN]);
    expect(state.afterSpeech).toBe("screen");
    expect(run(listening, { type: "awaiting" }).state.phase).toBe("listening");
  });

  it("作業中なのに止まったままなら、返答は画面でと言って待機に戻る", () => {
    const settled = run(working, { type: "settled" }).state;
    expect(settled.speaking).toEqual([REPLY_ON_SCREEN]);
    expect(run(settled, { type: "speechDone" }).state.phase).toBe("ready");
  });

  it("作業中でも話せる", () => {
    const { state, effects } = run(working, { type: "tapMic" });
    expect(state.phase).toBe("listening");
    expect(effects).toEqual([{ type: "startRecognition", auto: false }]);
  });

  it("畳んだ帯をタップすると待機に戻る", () => {
    const screen = run(
      working,
      { type: "awaiting" },
      { type: "speechDone" }
    ).state;
    expect(screen.phase).toBe("screen");
    expect(run(screen, { type: "expand" }).state.phase).toBe("ready");
  });

  it("画面が隠れたら認識と読み上げを止めて一時停止にする", () => {
    const { state, effects } = run(speakingReply, { type: "hidden" });
    expect(state.phase).toBe("paused");
    expect(effects).toEqual([
      { type: "abortRecognition" },
      { type: "cancelSpeech" },
    ]);
  });

  it("一時停止中に届いた返答は読まずに溜め、再開のタップで読む", () => {
    const paused = run(working, { type: "hidden" }).state;
    const held = run(paused, {
      type: "turnEnd",
      sentences: ["離れていた間の返答。"],
    });
    expect(held.state.phase).toBe("paused");
    expect(held.effects).toEqual([]);
    const resumed = run(held.state, { type: "resume", needsScreen: false });
    expect(resumed.state.phase).toBe("speaking");
    expect(resumed.effects).toEqual([
      { type: "speak", sentences: ["離れていた間の返答。"] },
    ]);
  });

  it("溜めた返答が無ければ、再開のタップで聞き取りを始める", () => {
    const paused = run(working, { type: "hidden" }).state;
    const { state, effects } = run(paused, {
      type: "resume",
      needsScreen: false,
    });
    expect(state.phase).toBe("listening");
    expect(effects).toEqual([{ type: "startRecognition", auto: false }]);
  });

  it("一時停止中は、作業中の退路や権限確認で勝手に喋らない", () => {
    const paused = run(working, { type: "hidden" }).state;
    expect(run(paused, { type: "settled" }).effects).toEqual([]);
    expect(run(paused, { type: "awaiting" }).effects).toEqual([]);
    expect(run(paused, { type: "tapMic" }).state.phase).toBe("paused");
  });

  it("終えると、認識・読み上げ・画面の点灯維持をすべて止める", () => {
    const { state, effects } = run(speakingReply, { type: "exit" });
    expect(state).toEqual(INITIAL_VOICE_STATE);
    expect(effects).toEqual([
      { type: "abortRecognition" },
      { type: "cancelSpeech" },
      { type: "releaseWakeLock" },
    ]);
  });

  it("送らなかった指示は、画面での操作を経ても「送る」か「消す」まで残る", () => {
    const held = run(
      confirming,
      { type: "commit", guard: "awaiting" },
      { type: "speechDone" }
    ).state;
    expect(held.phase).toBe("screen");
    const resolved = run(held, { type: "screenResolved" }).state;
    expect(resolved.unsent).toBe("テストを直して");
    const expanded = run(held, { type: "expand" }).state;
    expect(expanded.unsent).toBe("テストを直して");
    const retried = run(resolved, { type: "retryUnsent", now: NOW });
    expect(retried.state.phase).toBe("confirming");
    expect(retried.state.transcript).toBe("テストを直して");
    expect(retried.state.confirmDeadline).toBe(NOW + CONFIRM_MS);
    expect(retried.state.unsent).toBeNull();
    expect(run(resolved, { type: "dismissUnsent" }).state.unsent).toBeNull();
  });

  it("送れたら未送信の指示を消す", () => {
    const withUnsent: VoiceState = { ...confirming, unsent: "前の指示" };
    const { state } = run(withUnsent, { type: "commit", guard: null });
    expect(state.unsent).toBeNull();
  });

  it("再開した時点で質問や確認が残っていれば、聞き取らずに画面での操作へ戻る", () => {
    const paused = run(working, { type: "hidden" }).state;
    const { state, effects } = run(paused, {
      type: "resume",
      needsScreen: true,
    });
    expect(state.phase).toBe("screen");
    expect(effects).toEqual([]);
    const withHeld = run(paused, {
      type: "turnEnd",
      sentences: ["返答。"],
    }).state;
    const resumed = run(withHeld, { type: "resume", needsScreen: true });
    expect(resumed.state.afterSpeech).toBe("screen");
  });
});
