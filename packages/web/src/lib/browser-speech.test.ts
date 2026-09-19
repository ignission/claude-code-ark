// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSpeechPort,
  isVoiceModeSupported,
  type RecognitionHandlers,
  type SpeechEnvironment,
  watchdogMs,
} from "./browser-speech";

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  static throwOnStart = false;
  lang = "";
  continuous = true;
  interimResults = false;
  maxAlternatives = 0;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  stopped = false;
  aborted = false;
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    if (FakeRecognition.throwOnStart) {
      throw new DOMException("already started", "InvalidStateError");
    }
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  abort() {
    this.aborted = true;
  }
  emit(results: Array<{ transcript: string; isFinal: boolean }>) {
    this.onresult?.({
      results: results.map(r =>
        Object.assign([{ transcript: r.transcript }], { isFinal: r.isFinal })
      ),
    });
  }
}

class FakeUtterance {
  lang = "";
  volume = 1;
  voice: unknown = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

class FakeSynthesis {
  spoken: FakeUtterance[] = [];
  cancelled = 0;
  speak(utterance: FakeUtterance) {
    this.spoken.push(utterance);
  }
  cancel() {
    this.cancelled++;
  }
  getVoices() {
    return [
      { lang: "en-US", name: "Samantha" },
      { lang: "ja-JP", name: "Kyoko" },
    ];
  }
}

let synth: FakeSynthesis;
let audioSession: { type: string };
let released: number;
let env: SpeechEnvironment;

function handlers(): RecognitionHandlers & {
  log: string[];
} {
  const log: string[] = [];
  return {
    log,
    onInterim: text => log.push(`interim:${text}`),
    onFinal: text => log.push(`final:${text}`),
    onEnd: () => log.push("end"),
    onError: error => log.push(`error:${error}`),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeRecognition.instances = [];
  FakeRecognition.throwOnStart = false;
  synth = new FakeSynthesis();
  audioSession = { type: "auto" };
  released = 0;
  env = {
    webkitSpeechRecognition:
      FakeRecognition as unknown as SpeechEnvironment["webkitSpeechRecognition"],
    speechSynthesis: synth as unknown as SpeechSynthesis,
    SpeechSynthesisUtterance:
      FakeUtterance as unknown as SpeechEnvironment["SpeechSynthesisUtterance"],
    navigator: {
      audioSession,
      wakeLock: {
        request: async () =>
          ({
            release: async () => {
              released++;
            },
          }) as unknown as WakeLockSentinel,
      },
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isVoiceModeSupported", () => {
  it("認識と読み上げの両方があるときだけ使える", () => {
    expect(isVoiceModeSupported(env)).toBe(true);
    expect(
      isVoiceModeSupported({ ...env, webkitSpeechRecognition: undefined })
    ).toBe(false);
    expect(isVoiceModeSupported({ ...env, speechSynthesis: undefined })).toBe(
      false
    );
    expect(isVoiceModeSupported(undefined)).toBe(false);
  });
});

describe("createSpeechPort の認識", () => {
  it("日本語・1回きり・途中結果ありで始め、録音用の経路に切り替える", () => {
    const port = createSpeechPort(env);
    port.startRecognition(handlers());
    const rec = FakeRecognition.instances[0];
    expect(rec.started).toBe(true);
    expect(rec.lang).toBe("ja-JP");
    expect(rec.continuous).toBe(false);
    expect(rec.interimResults).toBe(true);
    expect(audioSession.type).toBe("play-and-record");
  });

  it("途中結果と確定を分けて届ける", () => {
    const port = createSpeechPort(env);
    const h = handlers();
    port.startRecognition(h);
    const rec = FakeRecognition.instances[0];
    rec.emit([{ transcript: "テスト", isFinal: false }]);
    rec.emit([{ transcript: "テストを直して", isFinal: true }]);
    rec.onend?.();
    expect(h.log).toEqual(["interim:テスト", "final:テストを直して", "end"]);
  });

  it("捨てた認識からは何も届かない", () => {
    const port = createSpeechPort(env);
    const h = handlers();
    port.startRecognition(h);
    const rec = FakeRecognition.instances[0];
    port.abortRecognition();
    expect(rec.aborted).toBe(true);
    expect(rec.onend).toBeNull();
    expect(h.log).toEqual([]);
  });

  it("開始で例外が出たらエラーとして届ける", () => {
    FakeRecognition.throwOnStart = true;
    const port = createSpeechPort(env);
    const h = handlers();
    port.startRecognition(h);
    expect(h.log).toEqual(["error:InvalidStateError"]);
  });

  it("認識が無い環境ではエラーとして届ける", () => {
    const port = createSpeechPort({
      ...env,
      webkitSpeechRecognition: undefined,
    });
    const h = handlers();
    port.startRecognition(h);
    expect(h.log).toEqual(["error:unsupported"]);
  });
});

describe("createSpeechPort の読み上げ", () => {
  it("文を1つずつ順に読み、読み終えたら onIdle を呼ぶ。読む前に再生用の経路へ切り替える", () => {
    const port = createSpeechPort(env);
    const onIdle = vi.fn();
    port.speak(["一文目。", "二文目。"], onIdle);
    expect(audioSession.type).toBe("playback");
    expect(synth.spoken.map(u => u.text)).toEqual(["一文目。"]);
    expect(synth.spoken[0].lang).toBe("ja-JP");
    expect(synth.spoken[0].voice).toEqual({ lang: "ja-JP", name: "Kyoko" });
    synth.spoken[0].onend?.();
    expect(synth.spoken.map(u => u.text)).toEqual(["一文目。", "二文目。"]);
    expect(onIdle).not.toHaveBeenCalled();
    synth.spoken[1].onend?.();
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("onend が来なくても、見張りの時間が過ぎたら次へ進む", () => {
    const port = createSpeechPort(env);
    const onIdle = vi.fn();
    const onWatchdog = vi.fn();
    port.speak(["止まる文。", "次の文。"], onIdle, onWatchdog);
    vi.advanceTimersByTime(watchdogMs("止まる文。"));
    expect(onWatchdog).toHaveBeenCalledTimes(1);
    expect(synth.cancelled).toBe(1);
    expect(synth.spoken.map(u => u.text)).toEqual(["止まる文。", "次の文。"]);
    // 見張りで進んだ後に古い発話の onend が遅れて来ても、二重に進まない
    synth.spoken[0].onend?.();
    expect(synth.spoken).toHaveLength(2);
  });

  it("止めたら残りを捨て、onIdle を呼ばない", () => {
    const port = createSpeechPort(env);
    const onIdle = vi.fn();
    port.speak(["一文目。", "二文目。"], onIdle);
    port.cancelSpeech();
    synth.spoken[0].onend?.();
    expect(synth.spoken).toHaveLength(1);
    expect(synth.cancelled).toBe(1);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("読み上げの解錠は無音の空の発話で行う", () => {
    const port = createSpeechPort(env);
    port.unlockSpeech();
    expect(synth.spoken[0].text).toBe("");
    expect(synth.spoken[0].volume).toBe(0);
  });
});

describe("createSpeechPort の画面の点灯維持", () => {
  it("取れたら true を返し、解放で release を呼ぶ", async () => {
    const port = createSpeechPort(env);
    await expect(port.requestWakeLock()).resolves.toBe(true);
    port.releaseWakeLock();
    await vi.runAllTimersAsync();
    expect(released).toBe(1);
  });

  it("APIが無ければ false を返す", async () => {
    const port = createSpeechPort({ ...env, navigator: {} });
    await expect(port.requestWakeLock()).resolves.toBe(false);
  });

  it("取れる前に抜けて入り直しても、点灯維持を1つも残さない", async () => {
    const resolvers: Array<(sentinel: WakeLockSentinel) => void> = [];
    let heldLocks = 0;
    const makeSentinel = () => {
      heldLocks++;
      return {
        release: async () => {
          heldLocks--;
        },
      } as unknown as WakeLockSentinel;
    };
    const port = createSpeechPort({
      ...env,
      navigator: {
        wakeLock: {
          request: () =>
            new Promise<WakeLockSentinel>(resolve => resolvers.push(resolve)),
        },
      },
    });
    const first = port.requestWakeLock();
    port.releaseWakeLock();
    const second = port.requestWakeLock();
    resolvers[0](makeSentinel());
    resolvers[1](makeSentinel());
    await first;
    await second;
    await vi.runAllTimersAsync();
    expect(heldLocks).toBe(1);
    port.releaseWakeLock();
    await vi.runAllTimersAsync();
    expect(heldLocks).toBe(0);
  });

  it("取れる前に解放を頼まれていたら、取れた直後に手放す", async () => {
    const port = createSpeechPort(env);
    const pending = port.requestWakeLock();
    port.releaseWakeLock();
    await pending;
    await vi.runAllTimersAsync();
    expect(released).toBe(1);
  });
});

describe("createSpeechPort の読み上げの持ち主", () => {
  it("自分が読んでいないときに止めても、ページの読み上げは止めない (別セッションの読み上げを巻き込まない)", () => {
    const idle = createSpeechPort(env);
    const other = createSpeechPort(env);
    other.speak(["表示中のセッションの返答。"], vi.fn());
    idle.cancelSpeech();
    expect(synth.cancelled).toBe(0);
    other.cancelSpeech();
    expect(synth.cancelled).toBe(1);
  });
});
