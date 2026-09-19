/**
 * useVoiceMode - 音声モード (iPhone 向け) の状態と副作用をまとめるフック。
 *
 * 状態遷移は lib/voice-mode-machine.ts の純関数に任せ、ここは次の3つだけを持つ。
 * 1. reducer が返した副作用を SpeechPort で実行する
 * 2. 時間の経過 (送信待ちの2秒、無音の2秒、止まったままの5秒) を入力に変える
 * 3. 会話ビューから受け取った JSONL のイベント列から、ターンの終わりを拾う
 *
 * 副作用は dispatch の中で同期的に実行する。iOS は認識と読み上げの開始を
 * ユーザー操作の中でしか許さないので、タップ → reducer → 開始 を1つの呼び出しで終える。
 *
 * 仕様: docs/superpowers/specs/2026-09-19-voice-mode-design.md
 */

import type { BridgeSessionStatus } from "@ark/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ActiveAuq } from "@/lib/ask-user-question-state";
import {
  browserSpeechEnvironment,
  createSpeechPort,
  isVoiceModeSupported,
  type SpeechPort,
} from "@/lib/browser-speech";
import type { JsonlParsedEvent } from "@/lib/jsonl-event-parser";
import {
  CONTINUED_SUFFIX,
  questionsToSpeechSentences,
  SPEECH_MAX_CHARS,
  toSpeechSentences,
} from "@/lib/speech-text";
import {
  INITIAL_VOICE_STATE,
  reduceVoice,
  type SendGuard,
  type VoiceAction,
  type VoiceEffect,
  type VoiceState,
} from "@/lib/voice-mode-machine";
import {
  createTurnEndCursor,
  scanTurnEnds,
  type TurnEndCursor,
} from "@/lib/voice-turn-signals";

/** 途中結果がこの間変わらなければ、話し終えたとみなす (1.2秒では日本語の言い淀みで切れる) */
export const SILENCE_MS = 2000;
/**
 * 作業中なのに Claude が止まった状態がこの間続いたら、「返答は画面で」と言って待機に戻る。
 * Esc での中断・APIエラー・作業中の /clear・停止は end_turn を書かないので、この退路が要る
 */
export const SETTLED_MS = 5000;
const SETTLED_STATUSES: ReadonlySet<BridgeSessionStatus> = new Set([
  "IDLE",
  "READY",
  "ERR",
  "STOP",
]);

/** 読み上げの速さの選択肢。切り替えボタンはこの順に巡る */
export const VOICE_RATES = [1, 1.3, 1.6] as const;
/** 既定の速さ。iOS の標準 (1) は日本語だと遅く感じる */
export const DEFAULT_VOICE_RATE = 1.3;
export const STORAGE_KEY_VOICE_RATE = "ark-voice-rate";
/** マイクの音量が取れないとき、途中結果が届いてから丸を戻すまでの時間 */
const INTERIM_PULSE_MS = 200;
/** 聞き取りの後、音声の処理を休ませ終えたころに状態を診断へ残すまでの時間 */
const AUDIO_DIAGNOSTIC_DELAY_MS = 1000;

function readSavedRate(): number {
  try {
    const saved = Number(localStorage.getItem(STORAGE_KEY_VOICE_RATE));
    return (VOICE_RATES as readonly number[]).includes(saved)
      ? saved
      : DEFAULT_VOICE_RATE;
  } catch {
    return DEFAULT_VOICE_RATE;
  }
}

export interface UseVoiceModeOptions {
  /** このセッションの画面が表示中か。離れたら音声モードを終える */
  isActive: boolean;
  /** サーバーとの接続。切れていたら送らない */
  isConnected: boolean;
  bridgeStatus: BridgeSessionStatus | undefined;
  /** 回答待ちの質問カード (会話ビューから受け取る)。無ければ null */
  activeAuq: ActiveAuq | null;
  onSendMessage: (message: string) => void;
  /** 実機の挙動をサーバーのログに残す。本文は渡さない (文字数だけ) */
  onDiagnostic?: (kind: string, detail: string) => void;
  /** テスト用。未指定ならブラウザの音声APIを使う */
  port?: SpeechPort;
  /** テスト用。未指定ならブラウザの音声APIの有無で決める */
  supported?: boolean;
}

export interface VoiceModeControls {
  state: VoiceState;
  /** このブラウザで音声モードを使えるか (認識と読み上げの両方がある) */
  supported: boolean;
  enter: () => void;
  exit: () => void;
  tapMic: () => void;
  cancel: () => void;
  sendNow: () => void;
  stopSpeaking: () => void;
  expand: () => void;
  /** 一時停止 (画面が隠れた) から戻る。ユーザー操作の中で呼ぶ */
  resume: () => void;
  /** 送らなかった指示を、送る直前の確認からやり直す */
  retryUnsent: () => void;
  /** 送らなかった指示を捨てる */
  dismissUnsent: () => void;
  /** 読み上げの速さ (VOICE_RATES のどれか) */
  rate: number;
  /** 読み上げの速さを次の選択肢へ切り替え、この端末に保存する */
  cycleRate: () => void;
  /**
   * 聞き取り中の音量 (0〜1) を受け取る。画面の描き替えの間隔で届くので、React の state に
   * 置かず、受け取った側が要素を直接動かす。戻り値で購読をやめる
   */
  subscribeLevel: (listener: (level: number) => void) => () => void;
  /**
   * 会話ビューの JSONL イベント列を受け取る (SplitChatPane の onEventsChange に渡す)。
   * hasSnapshot: 最初の履歴 (snapshot) が届いているか。届く前の空の列を起点にすると、
   * 後から届いた過去の履歴を新しい返答として読んでしまう
   */
  pushEvents: (
    events: readonly JsonlParsedEvent[],
    hasSnapshot: boolean
  ) => void;
}

export function useVoiceMode(options: UseVoiceModeOptions): VoiceModeControls {
  const { isActive, bridgeStatus, activeAuq } = options;
  const [port] = useState<SpeechPort>(
    () =>
      options.port ??
      createSpeechPort(browserSpeechEnvironment() ?? { navigator: {} })
  );
  const [supported] = useState(
    () => options.supported ?? isVoiceModeSupported(browserSpeechEnvironment())
  );
  const [state, setState] = useState<VoiceState>(INITIAL_VOICE_STATE);
  const stateRef = useRef(state);
  // タイマーの中から最新の props を読むため (送る直前の確認は、そのときの状態で行う)
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });
  const eventsRef = useRef<readonly JsonlParsedEvent[]>([]);
  const hasSnapshotRef = useRef(false);
  const cursorRef = useRef<TurnEndCursor | null>(null);
  /** 最初の履歴が届く前に入った。届いた時点の列を起点にする */
  const baselinePendingRef = useRef(false);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dispatchRef = useRef<(action: VoiceAction) => void>(() => undefined);
  /** 今出ている権限確認を案内済みか。確認が消えたら外す */
  const awaitingAnnouncedRef = useRef(false);
  /** 読み上げている返答で使った文字数。同じ返答の続きが届いたら残りだけ読む */
  const speechBudgetRef = useRef({ used: 0, exhausted: false });
  const [rate, setRate] = useState(readSavedRate);
  const levelListenersRef = useRef(new Set<(level: number) => void>());
  /** 今の聞き取りでマイクの音量が届いているか。届かなければ途中結果で動かす */
  const meterWorkingRef = useRef(false);
  /**
   * 認識がマイクのエラーで止まった。別に開いたマイクと取り合った可能性があるので、
   * このセッションでは音量の計測をやめて認識を優先する
   */
  const meterDisabledRef = useRef(false);
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioDiagnosticTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  const diagnose = useCallback((kind: string, detail = "") => {
    optionsRef.current.onDiagnostic?.(kind, detail);
  }, []);

  const clearSilence = useCallback(() => {
    if (silenceTimerRef.current !== null) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const emitLevel = useCallback((level: number) => {
    for (const listener of levelListenersRef.current) listener(level);
  }, []);

  /** 音量の計測を止めてマイクを手放し、丸を元の大きさに戻す */
  const stopMeter = useCallback(() => {
    if (pulseTimerRef.current !== null) {
      clearTimeout(pulseTimerRef.current);
      pulseTimerRef.current = null;
    }
    port.stopLevelMeter();
    emitLevel(0);
  }, [port, emitLevel]);

  const runEffect = useCallback(
    (effect: VoiceEffect) => {
      const dispatch = (action: VoiceAction) => dispatchRef.current(action);
      switch (effect.type) {
        case "startRecognition": {
          const auto = effect.auto;
          diagnose("listen", auto ? "auto" : "tap");
          meterWorkingRef.current = false;
          // 認識が終わった (開始で同期的に失敗した場合を含む)。その後に音量の計測を始めると、
          // 止める人がいないマイクが残る
          let recognitionSettled = false;
          port.startRecognition({
            onInterim: text => {
              dispatch({ type: "interim", text });
              clearSilence();
              silenceTimerRef.current = setTimeout(() => {
                silenceTimerRef.current = null;
                dispatch({ type: "silence", now: Date.now() });
              }, SILENCE_MS);
              // マイクの音量が取れないときは、途中結果が届くたびに丸を動かす
              if (!meterWorkingRef.current) {
                emitLevel(0.7);
                if (pulseTimerRef.current !== null) {
                  clearTimeout(pulseTimerRef.current);
                }
                pulseTimerRef.current = setTimeout(() => {
                  pulseTimerRef.current = null;
                  emitLevel(0);
                }, INTERIM_PULSE_MS);
              }
            },
            onFinal: text => {
              recognitionSettled = true;
              clearSilence();
              stopMeter();
              diagnose("final", `${text.length}文字`);
              // マイクを手放した後の音声の状態を残す (iOS のマイク表示が消えないときの手がかり)
              if (audioDiagnosticTimerRef.current !== null) {
                clearTimeout(audioDiagnosticTimerRef.current);
              }
              audioDiagnosticTimerRef.current = setTimeout(() => {
                audioDiagnosticTimerRef.current = null;
                diagnose("audio", `after-listen ${port.describeAudio()}`);
              }, AUDIO_DIAGNOSTIC_DELAY_MS);
              dispatch({ type: "final", text, now: Date.now() });
            },
            onEnd: () => {
              recognitionSettled = true;
              clearSilence();
              stopMeter();
              dispatch({ type: "recognitionEnd", now: Date.now() });
            },
            onError: error => {
              recognitionSettled = true;
              clearSilence();
              stopMeter();
              diagnose("recognition-error", auto ? `${error} (auto)` : error);
              if (error === "audio-capture" && !meterDisabledRef.current) {
                meterDisabledRef.current = true;
                diagnose("meter-disabled", error);
              }
              dispatch({ type: "recognitionError", error, auto });
            },
          });
          if (!recognitionSettled && !meterDisabledRef.current) {
            port.startLevelMeter(
              level => {
                if (!meterWorkingRef.current) {
                  meterWorkingRef.current = true;
                  diagnose("meter", "ok");
                }
                emitLevel(level);
              },
              error => diagnose("meter-error", error)
            );
          }
          return;
        }
        case "stopRecognition":
          port.stopRecognition();
          stopMeter();
          return;
        case "abortRecognition":
          clearSilence();
          port.abortRecognition();
          stopMeter();
          return;
        case "unlockSpeech":
          port.unlockSpeech();
          return;
        case "speak": {
          const startedAt = Date.now();
          diagnose("speak", `${effect.sentences.join("").length}文字`);
          port.speak(
            effect.sentences,
            () => {
              diagnose("speak-done", `${Date.now() - startedAt}ms`);
              dispatch({ type: "speechDone" });
            },
            () => diagnose("speak-watchdog")
          );
          return;
        }
        case "cancelSpeech":
          port.cancelSpeech();
          return;
        case "send":
          diagnose("send", `${effect.text.length}文字`);
          optionsRef.current.onSendMessage(effect.text);
          return;
        case "requestWakeLock":
          void port
            .requestWakeLock()
            .then(ok => diagnose("wakelock", ok ? "ok" : "unavailable"));
          return;
        case "releaseWakeLock":
          port.releaseWakeLock();
          return;
        case "releaseAudio":
          diagnose("audio", `exit ${port.describeAudio()}`);
          port.releaseAudio();
          return;
      }
    },
    [port, diagnose, clearSilence, emitLevel, stopMeter]
  );

  const dispatch = useCallback(
    (action: VoiceAction) => {
      const previous = stateRef.current;
      const { state: next, effects } = reduceVoice(previous, action);
      if (next !== previous) {
        stateRef.current = next;
        setState(next);
        // 入った時点の履歴は読まない。最初の履歴がまだ届いていなければ、届いた時点を起点にする。
        // 抜けたら忘れる
        if (previous.phase === "off") {
          if (hasSnapshotRef.current) {
            cursorRef.current = createTurnEndCursor(eventsRef.current);
          } else {
            cursorRef.current = null;
            baselinePendingRef.current = true;
          }
        }
        if (next.phase === "off") {
          cursorRef.current = null;
          baselinePendingRef.current = false;
        }
      }
      for (const effect of effects) runEffect(effect);
    },
    [runEffect]
  );
  useEffect(() => {
    dispatchRef.current = dispatch;
  }, [dispatch]);

  /** 送る直前の確認。カウントダウンが0になった時点 (入った時点ではない) の状態で決める */
  const commitNow = useCallback(() => {
    const current = optionsRef.current;
    const guard: SendGuard =
      current.bridgeStatus === "AWAITING" || current.activeAuq !== null
        ? "awaiting"
        : !current.isConnected
          ? "disconnected"
          : null;
    if (guard) diagnose("send-held", guard);
    // 送る直前の確認で「画面で確認が必要です」と言うので、同じ確認をもう一度案内しない
    if (guard === "awaiting" && current.bridgeStatus === "AWAITING") {
      awaitingAnnouncedRef.current = true;
    }
    dispatch({ type: "commit", guard });
  }, [dispatch, diagnose]);

  // 送信待ちの2秒
  useEffect(() => {
    if (state.phase !== "confirming" || state.confirmDeadline === null) return;
    const timer = setTimeout(
      commitNow,
      Math.max(0, state.confirmDeadline - Date.now())
    );
    return () => clearTimeout(timer);
  }, [state.phase, state.confirmDeadline, commitNow]);

  // セッションの画面から離れたら終える。モバイルはセッションごとに画面を常駐させて
  // 隠すだけなので、セッションの切り替えもここで拾える
  useEffect(() => {
    if (!isActive) dispatch({ type: "exit" });
  }, [isActive, dispatch]);

  // 質問 (AskUserQuestion)。同じ質問は一度だけ読む。抜けたら忘れ、入り直したら今の質問を読む。
  // 一時停止中は読まず、再開した後に読む
  const spokenAuqRef = useRef<string | null>(null);
  const isOff = state.phase === "off";
  const isPaused = state.phase === "paused";
  useEffect(() => {
    if (isOff) {
      spokenAuqRef.current = null;
      return;
    }
    if (isPaused) return;
    if (!activeAuq || spokenAuqRef.current === activeAuq.toolUseId) return;
    spokenAuqRef.current = activeAuq.toolUseId;
    diagnose("question", `${activeAuq.questions.length}問`);
    dispatch({
      type: "question",
      sentences: questionsToSpeechSentences(activeAuq.questions),
    });
  }, [isOff, isPaused, activeAuq, dispatch, diagnose]);

  // 権限確認など (質問カードの無い AWAITING) と、画面での操作が済んだこと。
  // 1回の確認につき1度だけ案内する。確認が残ったまま帯から戻った直後にまた畳むと、
  // 全画面の「終了」に手が届かなくなるため。聞き取り中に出た確認は、聞き取りを抜けてから案内する
  useEffect(() => {
    if (bridgeStatus !== "AWAITING") awaitingAnnouncedRef.current = false;
    if (
      bridgeStatus === "AWAITING" &&
      !activeAuq &&
      !awaitingAnnouncedRef.current &&
      (state.phase === "working" || state.phase === "ready")
    ) {
      awaitingAnnouncedRef.current = true;
      dispatch({ type: "awaiting" });
    }
    if (state.phase === "screen" && bridgeStatus !== "AWAITING" && !activeAuq) {
      dispatch({ type: "screenResolved" });
    }
  }, [state.phase, bridgeStatus, activeAuq, dispatch]);

  // 作業中なのに Claude が止まったまま。状態が変わるたびに数え直す
  useEffect(() => {
    if (
      state.phase !== "working" ||
      !bridgeStatus ||
      !SETTLED_STATUSES.has(bridgeStatus)
    ) {
      return;
    }
    const timer = setTimeout(() => dispatch({ type: "settled" }), SETTLED_MS);
    return () => clearTimeout(timer);
  }, [state.phase, bridgeStatus, dispatch]);

  // 画面が隠れたら止める。戻ったら画面の点灯維持を取り直す (隠れると外れるため)
  useEffect(() => {
    if (isOff) return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        diagnose("hidden");
        dispatch({ type: "hidden" });
      } else {
        void port.requestWakeLock();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [isOff, port, dispatch, diagnose]);

  // 読み上げの速さを窓口へ渡す
  useEffect(() => {
    port.setRate(rate);
  }, [port, rate]);

  // アンマウント (セッションの停止・削除) で止める
  useEffect(
    () => () => {
      clearSilence();
      if (audioDiagnosticTimerRef.current !== null) {
        clearTimeout(audioDiagnosticTimerRef.current);
      }
      port.releaseAudio();
      port.abortRecognition();
      port.cancelSpeech();
      port.releaseWakeLock();
    },
    [port, clearSilence]
  );

  const pushEvents = useCallback(
    (events: readonly JsonlParsedEvent[], hasSnapshot: boolean) => {
      eventsRef.current = events;
      hasSnapshotRef.current = hasSnapshot;
      if (baselinePendingRef.current) {
        if (!hasSnapshot) return;
        baselinePendingRef.current = false;
        cursorRef.current = createTurnEndCursor(events);
        return;
      }
      const cursor = cursorRef.current;
      if (!cursor) return;
      const { cursor: next, turnEnd } = scanTurnEnds(cursor, events);
      cursorRef.current = next;
      if (!turnEnd) return;
      diagnose("turn-end", `${turnEnd.text.length}文字`);
      // 読み上げの上限は返答全体で数える (本文ブロックが別々に届いても超えない)
      if (!turnEnd.continues) {
        speechBudgetRef.current = { used: 0, exhausted: false };
      }
      const budget = speechBudgetRef.current;
      if (budget.exhausted) return;
      const remaining = SPEECH_MAX_CHARS - budget.used;
      const sentences =
        remaining > 0
          ? toSpeechSentences(turnEnd.text, remaining)
          : [CONTINUED_SUFFIX];
      budget.exhausted = sentences.at(-1) === CONTINUED_SUFFIX;
      budget.used += sentences
        .filter(sentence => sentence !== CONTINUED_SUFFIX)
        .reduce((sum, sentence) => sum + sentence.length, 0);
      dispatch({ type: "turnEnd", sentences });
    },
    [dispatch, diagnose]
  );

  const enter = useCallback(() => dispatch({ type: "enter" }), [dispatch]);
  const exit = useCallback(() => dispatch({ type: "exit" }), [dispatch]);
  const tapMic = useCallback(() => dispatch({ type: "tapMic" }), [dispatch]);
  const cancel = useCallback(() => dispatch({ type: "cancel" }), [dispatch]);
  const stopSpeaking = useCallback(
    () => dispatch({ type: "stopSpeaking" }),
    [dispatch]
  );
  const expand = useCallback(() => dispatch({ type: "expand" }), [dispatch]);
  // 再開した時点で質問カードか権限確認が残っていれば、聞き取らずに画面での操作へ戻す
  // (聞き取りの全画面が回答カードを覆わないように)
  const resume = useCallback(() => {
    const current = optionsRef.current;
    dispatch({
      type: "resume",
      needsScreen:
        current.activeAuq !== null || current.bridgeStatus === "AWAITING",
    });
  }, [dispatch]);
  const retryUnsent = useCallback(
    () => dispatch({ type: "retryUnsent", now: Date.now() }),
    [dispatch]
  );
  const dismissUnsent = useCallback(
    () => dispatch({ type: "dismissUnsent" }),
    [dispatch]
  );

  const cycleRate = useCallback(() => {
    setRate(current => {
      const index = (VOICE_RATES as readonly number[]).indexOf(current);
      const next = VOICE_RATES[(index + 1) % VOICE_RATES.length];
      try {
        localStorage.setItem(STORAGE_KEY_VOICE_RATE, String(next));
      } catch {
        // 保存できなくても、この画面の間は切り替えた速さで読む
      }
      return next;
    });
  }, []);
  const subscribeLevel = useCallback((listener: (level: number) => void) => {
    levelListenersRef.current.add(listener);
    return () => {
      levelListenersRef.current.delete(listener);
    };
  }, []);

  return {
    state,
    supported,
    rate,
    cycleRate,
    subscribeLevel,
    enter,
    exit,
    tapMic,
    cancel,
    sendNow: commitNow,
    stopSpeaking,
    expand,
    resume,
    retryUnsent,
    dismissUnsent,
    pushEvents,
  };
}
