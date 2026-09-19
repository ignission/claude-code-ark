/**
 * browser-speech - 音声モードが使うブラウザの音声API (認識・読み上げ・画面の点灯維持) の窓口。
 *
 * useVoiceMode はこの SpeechPort だけを通して音声APIに触る。テストでは偽物に差し替える。
 * TypeScript の lib.dom には SpeechRecognition のコンストラクタと navigator.audioSession が
 * 無いので、使う部分だけを型にしてある。
 *
 * iOS Safari で分かっていること (仕様の7章):
 * - 認識の開始はユーザー操作の中でしか許されないことがある (not-allowed)
 * - 発話の onend が来ないことがある → 発話ごとに見張りを置く
 * - 認識の後は音声の経路が録音用のままになり、読み上げが受話口から小さく鳴るおそれがある
 *   → navigator.audioSession があれば、読み上げの前は再生用、認識の前は録音用に切り替える
 */

export interface RecognitionHandlers {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onEnd: () => void;
  onError: (error: string) => void;
}

export interface SpeechPort {
  /** 認識を始める。前の認識が残っていれば捨てる */
  startRecognition: (handlers: RecognitionHandlers) => void;
  /** 認識を止める。聞き取った分は onFinal / onEnd で届く */
  stopRecognition: () => void;
  /** 認識を捨てる。以後、その認識からは何も届かない */
  abortRecognition: () => void;
  /** 無音の発話で読み上げを使える状態にする (ユーザー操作の中で呼ぶ) */
  unlockSpeech: () => void;
  /**
   * 文を順に読む。読んでいる途中なら後ろに足す。すべて読み終えたら onIdle を呼ぶ
   * (途中で足したときは、最後に渡した onIdle だけを呼ぶ)。
   * onend が来ずに見張りで次へ進んだときは onWatchdog を呼ぶ
   */
  speak: (
    sentences: string[],
    onIdle: () => void,
    onWatchdog?: () => void
  ) => void;
  /**
   * 読み上げを止め、残りを捨てる。onIdle は呼ばない。
   * speechSynthesis はページで1つなので、この窓口が読んでいる最中のときだけページの読み上げを止める
   * (音声モードを使っていない別セッションの後片付けで、表示中のセッションの読み上げを止めない)
   */
  cancelSpeech: () => void;
  /** 画面の消灯を止める。取れたら true */
  requestWakeLock: () => Promise<boolean>;
  releaseWakeLock: () => void;
}

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type RecognitionConstructor = new () => RecognitionLike;

/** 窓口が使うブラウザの部分。本物は window、テストでは偽物を渡す */
export interface SpeechEnvironment {
  SpeechRecognition?: RecognitionConstructor;
  webkitSpeechRecognition?: RecognitionConstructor;
  speechSynthesis?: SpeechSynthesis;
  SpeechSynthesisUtterance?: new (text?: string) => SpeechSynthesisUtterance;
  navigator: {
    wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinel> };
    /** Safari の Audio Session API。無いブラウザもある */
    audioSession?: { type: string };
  };
}

/** 発話の見張り。日本語の読み上げは1文字およそ150ミリ秒なので、倍の余裕を見る */
const WATCHDOG_MS_PER_CHAR = 300;
const WATCHDOG_MS_BASE = 3000;

export function watchdogMs(text: string): number {
  return text.length * WATCHDOG_MS_PER_CHAR + WATCHDOG_MS_BASE;
}

export function isVoiceModeSupported(
  env: SpeechEnvironment | undefined
): boolean {
  if (!env) return false;
  return Boolean(
    (env.SpeechRecognition ?? env.webkitSpeechRecognition) &&
      env.speechSynthesis &&
      env.SpeechSynthesisUtterance
  );
}

export function browserSpeechEnvironment(): SpeechEnvironment | undefined {
  if (typeof window === "undefined") return undefined;
  return window as unknown as SpeechEnvironment;
}

export function createSpeechPort(env: SpeechEnvironment): SpeechPort {
  let recognition: RecognitionLike | null = null;
  let queue: string[] = [];
  /** 発話の世代。止めたときに進め、古い発話からの onend を無視する */
  let generation = 0;
  let speakingNow = false;
  let onIdle: (() => void) | null = null;
  let onWatchdog: (() => void) | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let wakeLock: WakeLockSentinel | null = null;
  let wakeLockWanted = false;
  /** 点灯維持の要求の番号。抜けて入り直したときに、古い要求で取れた分を手放すため */
  let wakeLockRequest = 0;

  const setAudioSession = (type: "playback" | "play-and-record") => {
    const session = env.navigator.audioSession;
    if (!session) return;
    try {
      session.type = type;
    } catch {
      // 未対応の値は無視する (経路の切り替えは補助で、無くても読み上げはできる)
    }
  };

  const detach = (rec: RecognitionLike) => {
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
  };

  const clearWatchdog = () => {
    if (watchdog !== null) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  };

  const japaneseVoice = (synth: SpeechSynthesis) =>
    synth
      .getVoices()
      .find(voice =>
        voice.lang.replace("_", "-").toLowerCase().startsWith("ja")
      );

  const speakNext = () => {
    const synth = env.speechSynthesis;
    const Utterance = env.SpeechSynthesisUtterance;
    const text = queue.shift();
    if (text === undefined || !synth || !Utterance) {
      speakingNow = false;
      const done = onIdle;
      onIdle = null;
      done?.();
      return;
    }
    speakingNow = true;
    setAudioSession("playback");
    generation++;
    const mine = generation;
    let settled = false;
    const utterance = new Utterance(text);
    utterance.lang = "ja-JP";
    const voice = japaneseVoice(synth);
    if (voice) utterance.voice = voice;
    const finish = () => {
      if (settled || mine !== generation) return;
      settled = true;
      clearWatchdog();
      speakNext();
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    watchdog = setTimeout(() => {
      if (settled || mine !== generation) return;
      settled = true;
      watchdog = null;
      onWatchdog?.();
      // 止まった発話を片付けてから次へ。cancel で遅れて来る onend は settled で無視される
      synth.cancel();
      speakNext();
    }, watchdogMs(text));
    synth.speak(utterance);
  };

  return {
    startRecognition(handlers) {
      if (recognition) {
        detach(recognition);
        recognition.abort();
        recognition = null;
      }
      const Recognition = env.SpeechRecognition ?? env.webkitSpeechRecognition;
      if (!Recognition) {
        handlers.onError("unsupported");
        return;
      }
      setAudioSession("play-and-record");
      const rec = new Recognition();
      rec.lang = "ja-JP";
      rec.continuous = false;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.onresult = event => {
        let finalText = "";
        let interimText = "";
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i];
          const transcript = result[0]?.transcript ?? "";
          if (result.isFinal) finalText += transcript;
          else interimText += transcript;
        }
        if (finalText) handlers.onFinal(finalText);
        else if (interimText) handlers.onInterim(interimText);
      };
      rec.onerror = event => handlers.onError(event.error);
      rec.onend = () => {
        if (recognition === rec) recognition = null;
        handlers.onEnd();
      };
      recognition = rec;
      try {
        rec.start();
      } catch (err) {
        detach(rec);
        recognition = null;
        handlers.onError(
          err instanceof DOMException ? err.name : "start-failed"
        );
      }
    },
    stopRecognition() {
      recognition?.stop();
    },
    abortRecognition() {
      if (!recognition) return;
      detach(recognition);
      recognition.abort();
      recognition = null;
    },
    unlockSpeech() {
      const synth = env.speechSynthesis;
      const Utterance = env.SpeechSynthesisUtterance;
      if (!synth || !Utterance) return;
      const utterance = new Utterance("");
      utterance.volume = 0;
      synth.speak(utterance);
    },
    speak(sentences, idle, watchdogHandler) {
      onIdle = idle;
      onWatchdog = watchdogHandler ?? null;
      queue.push(...sentences);
      if (!speakingNow) speakNext();
    },
    cancelSpeech() {
      const owning = speakingNow;
      queue = [];
      generation++;
      clearWatchdog();
      speakingNow = false;
      onIdle = null;
      if (owning) env.speechSynthesis?.cancel();
    },
    async requestWakeLock() {
      const lock = env.navigator.wakeLock;
      if (!lock) return false;
      wakeLockWanted = true;
      wakeLockRequest++;
      const mine = wakeLockRequest;
      try {
        const sentinel = await lock.request("screen");
        if (!wakeLockWanted || mine !== wakeLockRequest) {
          // 取れる前に解放を頼まれていたか、後から出した要求がある。古い要求で取れた分は手放す
          void sentinel.release().catch(() => undefined);
          return wakeLockWanted;
        }
        const previous = wakeLock;
        wakeLock = sentinel;
        if (previous) void previous.release().catch(() => undefined);
        return true;
      } catch {
        return false;
      }
    },
    releaseWakeLock() {
      wakeLockWanted = false;
      const current = wakeLock;
      wakeLock = null;
      if (current) void current.release().catch(() => undefined);
    },
  };
}
