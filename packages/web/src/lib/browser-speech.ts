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
 * - 認識の途中結果はなかなか届かない → 話している間の動きは、別に開いたマイクの音量で見せる。
 *   マイクは聞き取り中だけ開く (開いたまま読み上げると、声が受話口から小さく鳴るため)
 * - 音声セッションを録音用 (play-and-record) にしたまま AudioContext が動いていると、マイクの
 *   トラックを止めても iOS はマイクを使用中と表示し続ける (実機で確認)。聞き取りを終えたら
 *   音声セッションを自動 (auto) に戻し、AudioContext を休ませ、音声モードを抜けたら閉じる
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
  /**
   * 無音の発話で読み上げを使える状態にし、音量を測る音声の処理も起こしておく
   * (iOS はどちらもユーザー操作の中でしか始めさせないので、タップの中で呼ぶ)
   */
  unlockSpeech: () => void;
  /** 読み上げの速さ (1 が標準)。次に読む発話から効く */
  setRate: (rate: number) => void;
  /**
   * マイクを開き、音量 (0〜1) を画面の描き替えの間隔で届ける。前の計測が残っていれば止める。
   * マイクが取れなければ onError にエラー名を渡す
   */
  startLevelMeter: (
    onLevel: (level: number) => void,
    onError: (error: string) => void
  ) => void;
  /** 音量の計測を止め、マイクを手放し、音声の処理を休ませる */
  stopLevelMeter: () => void;
  /**
   * 音声モードを抜けるときに、マイク・音声の処理・音声セッションをすべて手放す。
   * 次に入るときは unlockSpeech で作り直す
   */
  releaseAudio: () => void;
  /** 音声セッションと音声の処理の状態を、診断ログ用の1行で返す */
  describeAudio: () => string;
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
  AudioContext?: new () => AudioContext;
  webkitAudioContext?: new () => AudioContext;
  requestAnimationFrame?: (callback: () => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
  navigator: {
    wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinel> };
    /** Safari の Audio Session API。無いブラウザもある */
    audioSession?: { type: string; state?: string };
    mediaDevices?: {
      getUserMedia: (
        constraints: MediaStreamConstraints
      ) => Promise<MediaStream>;
    };
  };
}

/**
 * 音量の感度。話し声の RMS は 0.05〜0.25 程度なので、4倍して 0〜1 に収める
 * (これより大きい声は 1 に張り付く)
 */
const LEVEL_GAIN = 4;
/** requestAnimationFrame が無い環境 (テスト) での計測間隔 */
const METER_FALLBACK_MS = 16;

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
  let rate = 1;
  let audioContext: AudioContext | null = null;
  let meterStream: MediaStream | null = null;
  let meterNodes: AudioNode[] = [];
  let meterFrame: number | ReturnType<typeof setTimeout> | null = null;
  /** 音量の計測の世代。止めたときに進め、遅れて取れたマイクや古いループを捨てる */
  let meterGeneration = 0;

  const scheduleFrame = (callback: () => void) =>
    env.requestAnimationFrame
      ? env.requestAnimationFrame(callback)
      : setTimeout(callback, METER_FALLBACK_MS);
  const cancelFrame = (handle: number | ReturnType<typeof setTimeout>) => {
    if (env.cancelAnimationFrame && typeof handle === "number") {
      env.cancelAnimationFrame(handle);
    } else {
      clearTimeout(handle);
    }
  };
  const releaseStream = (stream: MediaStream) => {
    for (const track of stream.getTracks()) track.stop();
  };

  const stopLevelMeter = () => {
    meterGeneration++;
    if (meterFrame !== null) {
      cancelFrame(meterFrame);
      meterFrame = null;
    }
    for (const node of meterNodes) {
      try {
        node.disconnect();
      } catch {
        // つながっていないノードの disconnect は無視する
      }
    }
    meterNodes = [];
    if (meterStream) {
      releaseStream(meterStream);
      meterStream = null;
    }
    // 動いたままだと iOS がマイクを使用中と表示し続けるので休ませる
    if (audioContext?.state === "running") {
      void audioContext.suspend().catch(() => undefined);
    }
  };

  const setAudioSession = (type: "playback" | "play-and-record" | "auto") => {
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
      if (speakingNow) setAudioSession("auto");
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
    utterance.rate = rate;
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
        setAudioSession("auto");
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
      setAudioSession("auto");
    },
    unlockSpeech() {
      const Context = env.AudioContext ?? env.webkitAudioContext;
      if (Context) {
        try {
          audioContext ??= new Context();
          void audioContext.resume().catch(() => undefined);
        } catch {
          // 音量の表示は補助。起こせなくても読み上げと認識は続ける
        }
      }
      const synth = env.speechSynthesis;
      const Utterance = env.SpeechSynthesisUtterance;
      if (!synth || !Utterance) return;
      const utterance = new Utterance("");
      utterance.volume = 0;
      synth.speak(utterance);
    },
    setRate(next) {
      rate = next;
    },
    startLevelMeter(onLevel, onError) {
      stopLevelMeter();
      const getUserMedia = env.navigator.mediaDevices?.getUserMedia;
      const context = audioContext;
      if (!getUserMedia || !context) {
        onError("unsupported");
        return;
      }
      meterGeneration++;
      const mine = meterGeneration;
      void context.resume().catch(() => undefined);
      getUserMedia
        .call(env.navigator.mediaDevices, {
          audio: { echoCancellation: true, noiseSuppression: true },
        })
        .then(stream => {
          if (mine !== meterGeneration) {
            releaseStream(stream);
            return;
          }
          meterStream = stream;
          const source = context.createMediaStreamSource(stream);
          const analyser = context.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);
          meterNodes = [source, analyser];
          const samples = new Uint8Array(analyser.fftSize);
          const tick = () => {
            if (mine !== meterGeneration) return;
            analyser.getByteTimeDomainData(samples);
            let sum = 0;
            for (const sample of samples) {
              const centered = (sample - 128) / 128;
              sum += centered * centered;
            }
            const rms = Math.sqrt(sum / samples.length);
            onLevel(Math.min(1, rms * LEVEL_GAIN));
            meterFrame = scheduleFrame(tick);
          };
          tick();
        })
        .catch(err => {
          if (mine !== meterGeneration) return;
          onError(
            err instanceof DOMException ? err.name : "getusermedia-failed"
          );
        });
    },
    stopLevelMeter,
    releaseAudio() {
      stopLevelMeter();
      const context = audioContext;
      audioContext = null;
      if (context) void context.close().catch(() => undefined);
      setAudioSession("auto");
    },
    describeAudio() {
      const session = env.navigator.audioSession;
      const sessionText = session
        ? [session.type, session.state].filter(Boolean).join("/")
        : "none";
      return `session=${sessionText} context=${audioContext?.state ?? "none"}`;
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
