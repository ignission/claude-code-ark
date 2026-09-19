/**
 * voice-mode-machine - 音声モードの状態遷移 (純関数)。
 *
 * 状態と入力 (タップ、認識結果、ターンの終わり、質問、読み上げ終了、画面の表示状態) から、
 * 次の状態と「実行してほしい副作用」の列を返す。副作用 (認識の開始、読み上げ、送信) は
 * useVoiceMode が同期的に実行する。iOS はユーザー操作の中でしか認識と読み上げを
 * 始めさせないため、タップ → reducer → 副作用 が同じ呼び出しの中で終わる必要がある。
 *
 * 仕様: docs/superpowers/specs/2026-09-19-voice-mode-design.md の4章
 */

import { CONFIRM_ON_SCREEN, REPLY_ON_SCREEN } from "./speech-text";

export type VoicePhase =
  | "off"
  | "ready"
  | "listening"
  | "confirming"
  | "working"
  | "speaking"
  | "screen"
  /**
   * 画面が隠れて止めた状態。隠れている間に届いた返答は溜め、勝手に喋らない
   * (iOS はユーザー操作なしの読み上げ・認識を許さないことがあり、戻った直後に喋り出すのも驚く)。
   * 再開のタップ (resume) で溜めた返答を読むか、聞き取りを始める
   */
  | "paused";

/** 読み上げが終わった後に移る先 */
export type AfterSpeech = "listen" | "ready" | "screen";

export interface VoiceState {
  phase: VoicePhase;
  /** 聞き取り中は途中結果、送信待ちでは送る文 */
  transcript: string;
  /** 送信待ちの締め切り (端末の時計の ms)。送信待ち以外は null */
  confirmDeadline: number | null;
  /** 読み上げている文 (画面に出す) */
  speaking: string[];
  afterSpeech: AfterSpeech;
  /** 聞き取り中・送信待ちに届いたターンの終わり。抜けた後に読む */
  heldSpeech: string[];
  /** 画面に出す一言 (エラー、送らなかった理由)。無ければ null */
  notice: string | null;
  /**
   * 送らなかった指示 (送る直前に確認・質問が出ていた、接続が切れていた)。
   * 画面での操作を経ても消さず、「送る」(retryUnsent) か「消す」(dismissUnsent) まで残す
   */
  unsent: string | null;
}

/** 送信待ちの猶予 */
export const CONFIRM_MS = 2000;

/**
 * 送る直前の確認の結果。null なら送ってよい。
 * `session:send` は無条件に C-u → 文字 → Enter を打つので、権限確認や質問が出ている最中に
 * 送るとその Enter が選択肢を確定させてしまう。切断中に送ると Socket.IO が溜めて前後して届く
 */
export type SendGuard = "awaiting" | "disconnected" | null;

export type VoiceAction =
  | { type: "enter" }
  | { type: "exit" }
  | { type: "hidden" }
  | { type: "tapMic" }
  | { type: "interim"; text: string }
  | { type: "final"; text: string; now: number }
  | { type: "silence"; now: number }
  | { type: "recognitionEnd"; now: number }
  | { type: "recognitionError"; error: string; auto: boolean }
  | { type: "cancel" }
  | { type: "commit"; guard: SendGuard }
  | { type: "turnEnd"; sentences: string[] }
  | { type: "question"; sentences: string[] }
  | { type: "awaiting" }
  | { type: "settled" }
  | { type: "speechDone" }
  | { type: "stopSpeaking" }
  | { type: "screenResolved" }
  | { type: "expand" }
  /** needsScreen: 再開した時点で質問カードか権限確認が残っている (画面での操作へ戻す) */
  | { type: "resume"; needsScreen: boolean }
  | { type: "retryUnsent"; now: number }
  | { type: "dismissUnsent" };

export type VoiceEffect =
  /** auto: 読み上げの後に自動で開くとき true (ユーザー操作の外なので iOS に拒否されうる) */
  | { type: "startRecognition"; auto: boolean }
  | { type: "stopRecognition" }
  | { type: "abortRecognition" }
  | { type: "unlockSpeech" }
  | { type: "speak"; sentences: string[] }
  | { type: "cancelSpeech" }
  | { type: "send"; text: string }
  | { type: "requestWakeLock" }
  | { type: "releaseWakeLock" };

export const INITIAL_VOICE_STATE: VoiceState = {
  phase: "off",
  transcript: "",
  confirmDeadline: null,
  speaking: [],
  afterSpeech: "listen",
  heldSpeech: [],
  notice: null,
  unsent: null,
};

interface Transition {
  state: VoiceState;
  effects: VoiceEffect[];
}

const unchanged = (state: VoiceState): Transition => ({ state, effects: [] });

function speak(
  state: VoiceState,
  sentences: string[],
  afterSpeech: AfterSpeech,
  effects: VoiceEffect[] = [],
  notice: string | null = null
): Transition {
  return {
    state: {
      ...state,
      phase: "speaking",
      transcript: "",
      confirmDeadline: null,
      speaking: sentences,
      afterSpeech,
      notice,
    },
    effects: [...effects, { type: "speak", sentences }],
  };
}

/** 待機へ。溜めていた返答があれば、待機ではなく読み上げに入る */
function toReady(
  state: VoiceState,
  effects: VoiceEffect[] = [],
  notice: string | null = null
): Transition {
  if (state.heldSpeech.length > 0) {
    return speak(
      { ...state, heldSpeech: [] },
      state.heldSpeech,
      "listen",
      effects,
      notice
    );
  }
  return {
    state: {
      ...state,
      phase: "ready",
      transcript: "",
      confirmDeadline: null,
      speaking: [],
      notice,
    },
    effects,
  };
}

function confirm(
  state: VoiceState,
  text: string,
  now: number,
  effects: VoiceEffect[] = []
): Transition {
  return {
    state: {
      ...state,
      phase: "confirming",
      transcript: text,
      confirmDeadline: now + CONFIRM_MS,
      notice: null,
    },
    effects,
  };
}

/** 認識のエラーを画面の一言にする。黙って待機に戻せばよいものは null */
export function recognitionErrorNotice(
  error: string,
  auto: boolean
): string | null {
  switch (error) {
    case "no-speech":
    case "aborted":
      return null;
    case "not-allowed":
    case "service-not-allowed":
      // 読み上げの後に自動で開こうとして拒否されたのは想定内。タップを待つだけ
      return auto
        ? null
        : "マイクか音声入力が許可されていません。iPhoneの設定で、Safariのマイクと音声入力 (Siri) を確かめてください";
    case "network":
      return "音声認識につながりません (network)";
    case "audio-capture":
      return "マイクが使えません (audio-capture)";
    default:
      return `音声認識が止まりました (${error})`;
  }
}

export function reduceVoice(
  state: VoiceState,
  action: VoiceAction
): Transition {
  if (action.type === "enter") {
    if (state.phase !== "off") return unchanged(state);
    return {
      state: { ...INITIAL_VOICE_STATE, phase: "listening" },
      effects: [
        { type: "unlockSpeech" },
        { type: "requestWakeLock" },
        { type: "startRecognition", auto: false },
      ],
    };
  }
  if (state.phase === "off") return unchanged(state);

  switch (action.type) {
    case "exit":
      return {
        state: INITIAL_VOICE_STATE,
        effects: [
          { type: "abortRecognition" },
          { type: "cancelSpeech" },
          { type: "releaseWakeLock" },
        ],
      };
    case "hidden":
      return {
        state: {
          ...state,
          phase: "paused",
          transcript: "",
          confirmDeadline: null,
          speaking: [],
          notice: null,
        },
        effects: [{ type: "abortRecognition" }, { type: "cancelSpeech" }],
      };
    case "resume":
      if (state.phase !== "paused") return unchanged(state);
      if (state.heldSpeech.length > 0) {
        return speak(
          { ...state, heldSpeech: [] },
          state.heldSpeech,
          action.needsScreen ? "screen" : "listen"
        );
      }
      if (action.needsScreen) {
        return { state: { ...state, phase: "screen" }, effects: [] };
      }
      return {
        state: { ...state, phase: "listening", transcript: "", notice: null },
        effects: [{ type: "startRecognition", auto: false }],
      };
    case "tapMic":
      if (state.phase !== "ready" && state.phase !== "working") {
        return unchanged(state);
      }
      return {
        state: { ...state, phase: "listening", transcript: "", notice: null },
        effects: [{ type: "startRecognition", auto: false }],
      };
    case "interim":
      if (state.phase !== "listening") return unchanged(state);
      return { state: { ...state, transcript: action.text }, effects: [] };
    case "final": {
      const text = action.text.trim();
      if (state.phase === "listening") {
        return text ? confirm(state, text, action.now) : toReady(state);
      }
      if (state.phase === "confirming" && text) {
        return confirm(state, text, action.now);
      }
      return unchanged(state);
    }
    case "silence": {
      const text = state.transcript.trim();
      if (state.phase !== "listening" || !text) return unchanged(state);
      return confirm(state, text, action.now, [{ type: "stopRecognition" }]);
    }
    case "recognitionEnd": {
      if (state.phase !== "listening") return unchanged(state);
      const text = state.transcript.trim();
      return text ? confirm(state, text, action.now) : toReady(state);
    }
    case "recognitionError":
      if (state.phase !== "listening") return unchanged(state);
      return toReady(
        state,
        [],
        recognitionErrorNotice(action.error, action.auto)
      );
    case "cancel":
      if (state.phase !== "listening" && state.phase !== "confirming") {
        return unchanged(state);
      }
      return toReady(state, [{ type: "abortRecognition" }]);
    case "commit": {
      if (state.phase !== "confirming") return unchanged(state);
      const text = state.transcript;
      const stop: VoiceEffect = { type: "abortRecognition" };
      if (action.guard === "awaiting") {
        return speak(
          { ...state, unsent: text },
          [CONFIRM_ON_SCREEN],
          "screen",
          [stop],
          "確認が出ていたので送っていません"
        );
      }
      if (action.guard === "disconnected") {
        return toReady(
          { ...state, unsent: text },
          [stop],
          "接続が切れていたので送っていません"
        );
      }
      const sent: VoiceEffect[] = [stop, { type: "send", text }];
      if (state.heldSpeech.length > 0) {
        return speak(
          { ...state, heldSpeech: [] },
          state.heldSpeech,
          "listen",
          sent
        );
      }
      return {
        state: {
          ...state,
          phase: "working",
          transcript: "",
          confirmDeadline: null,
          notice: null,
        },
        effects: sent,
      };
    }
    case "retryUnsent":
      if (
        state.unsent === null ||
        (state.phase !== "ready" &&
          state.phase !== "working" &&
          state.phase !== "screen")
      ) {
        return unchanged(state);
      }
      // 送る直前の確認をもう一度通すため、送信待ちからやり直す
      return confirm({ ...state, unsent: null }, state.unsent, action.now);
    case "dismissUnsent":
      if (state.unsent === null) return unchanged(state);
      return { state: { ...state, unsent: null, notice: null }, effects: [] };
    case "turnEnd":
      if (action.sentences.length === 0) return unchanged(state);
      if (
        state.phase === "listening" ||
        state.phase === "confirming" ||
        state.phase === "paused"
      ) {
        return {
          state: {
            ...state,
            heldSpeech: [...state.heldSpeech, ...action.sentences],
          },
          effects: [],
        };
      }
      if (state.phase === "speaking") {
        return {
          state: {
            ...state,
            speaking: [...state.speaking, ...action.sentences],
            afterSpeech: "listen",
          },
          effects: [{ type: "speak", sentences: action.sentences }],
        };
      }
      return speak(state, action.sentences, "listen");
    case "question": {
      // 一時停止中は読まない。useVoiceMode が再開した後に改めて渡す
      if (action.sentences.length === 0 || state.phase === "paused") {
        return unchanged(state);
      }
      if (state.phase === "speaking") {
        return {
          state: {
            ...state,
            speaking: [...state.speaking, ...action.sentences],
            afterSpeech: "screen",
          },
          effects: [{ type: "speak", sentences: action.sentences }],
        };
      }
      const interrupted =
        state.phase === "listening" || state.phase === "confirming";
      const wasConfirming = state.phase === "confirming";
      return speak(
        wasConfirming ? { ...state, unsent: state.transcript } : state,
        action.sentences,
        "screen",
        interrupted ? [{ type: "abortRecognition" }] : [],
        wasConfirming ? "質問が来たので送っていません" : null
      );
    }
    case "awaiting":
      if (state.phase !== "working" && state.phase !== "ready") {
        return unchanged(state);
      }
      return speak(state, [CONFIRM_ON_SCREEN], "screen");
    case "settled":
      if (state.phase !== "working") return unchanged(state);
      return speak(state, [REPLY_ON_SCREEN], "ready");
    case "speechDone":
      if (state.phase !== "speaking") return unchanged(state);
      if (state.afterSpeech === "listen") {
        return {
          state: {
            ...state,
            phase: "listening",
            transcript: "",
            speaking: [],
            notice: null,
          },
          effects: [{ type: "startRecognition", auto: true }],
        };
      }
      if (state.afterSpeech === "screen") {
        return {
          state: { ...state, phase: "screen", speaking: [] },
          effects: [],
        };
      }
      return toReady(state, [], state.notice);
    case "stopSpeaking":
      if (state.phase !== "speaking") return unchanged(state);
      if (state.afterSpeech === "screen") {
        return {
          state: { ...state, phase: "screen", speaking: [] },
          effects: [{ type: "cancelSpeech" }],
        };
      }
      return toReady({ ...state, heldSpeech: [] }, [{ type: "cancelSpeech" }]);
    case "screenResolved":
      if (state.phase !== "screen") return unchanged(state);
      return {
        state: { ...state, phase: "working", notice: null },
        effects: [],
      };
    case "expand":
      if (state.phase !== "screen") return unchanged(state);
      return toReady(state);
  }
}
