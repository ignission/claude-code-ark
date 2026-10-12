/**
 * browser-cdp-bridgeのテスト。CDPは呼び出しを記録する偽物で、
 * 視聴者のWebSocketはEventEmitterで代用する。
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ATTACH_ANSWER_TIMEOUT_MS,
  BACKPRESSURE_BYTES,
  BrowserCdpBridge,
  type CdpLike,
  ENTER_STEP_TIMEOUT_MS,
  OUTPUT_LIMIT_BYTES,
  POLL_INTERVAL_MS,
  type ViewerSocket,
} from "./browser-cdp-bridge.js";
import {
  CdpClient,
  type CdpSocket,
  SessionDetachedError,
} from "./browser-cdp-client.js";
import { buildSolidPng } from "./browser-frame-diff.testkit.js";
import { CAPTURE_TIMEOUT_MS } from "./browser-frame-pipeline.js";
import {
  COPY_EXPRESSION,
  COPY_TIMEOUT_MS,
  HISTORY_TIMEOUT_MS,
} from "./browser-page-controller.js";
import { SELECT_NOTIFY_INTERVAL_MS } from "./browser-select-controller.js";
import { SELECT_SHIM_SOURCE } from "./browser-select-shim.js";

interface CdpCall {
  method: string;
  params?: object;
  sessionId?: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeTarget {
  targetId: string;
  type: string;
  url?: string;
  title?: string;
  openerId?: string;
}

/**
 * 本物のCdpClientと同じく、`close()` はcloseのイベントをその場では出さない
 * (`disconnect()` で届ける)。`holdOn` したメソッドの応答は、`release` / `fail` で返すまで待たせる。
 *
 * 本物のChromiumと同じく、`Target.setDiscoverTargets` には、応答より先に、いまある
 * ターゲットの `Target.targetCreated` を返す。attachするたびに新しいsession (`S1`、`S2`、...) を返し、
 * 作ったターゲットのidは `T-new`、`T-new-2`、... とする。作った、閉じたことのイベントは
 * 自分では出さない (テストが `emitBrowser` で流す)。
 *
 * 本物のCdpClientと同じく、`Target.detachedFromTarget` を流すと、そのsessionで待たせている
 * 応答を失敗させる。`rejectSession` も同じ。sessionが切り離されても応答が返らない
 * (本物のChromiumの振る舞い) ことは、待たせた応答を返さないことで表す。
 */
function fakeCdp(options: { targets?: FakeTarget[] } = {}) {
  const calls: CdpCall[] = [];
  const listeners = new Map<
    string,
    Array<(params: unknown, sessionId?: string) => void>
  >();
  const closeListeners: Array<() => void> = [];
  const failing = new Set<string>();
  const holding = new Set<string>();
  const held: Array<{
    method: string;
    sessionId: string | undefined;
    answer: Deferred<unknown>;
    result: unknown;
  }> = [];
  const rejected: string[] = [];
  const deadlines = new Map<string, number | undefined>();
  let shots = 0;
  let sessions = 0;
  let created = 0;
  const targets = options.targets ?? [{ targetId: "T1", type: "page" }];
  let closing = false;
  let closed = false;

  const answers = new Map<string, unknown>();

  const resultOf = (method: string): unknown => {
    if (answers.has(method)) return answers.get(method);
    if (method === "Target.getTargets") {
      return { targetInfos: targets };
    }
    if (method === "Target.createTarget") {
      created++;
      return { targetId: created === 1 ? "T-new" : `T-new-${created}` };
    }
    if (method === "Target.attachToTarget") {
      return { sessionId: `S${++sessions}` };
    }
    // 何回目の取り直しかが分かる、小さな画像の代わり
    if (method === "Page.captureScreenshot") {
      return { data: Buffer.from(`shot-${++shots}`).toString("base64") };
    }
    return {};
  };

  const takeHeld = (method: string) => {
    const index = held.findIndex(entry => entry.method === method);
    if (index < 0) throw new Error(`${method} は待たせていません`);
    return held.splice(index, 1)[0];
  };

  const dispatch = (method: string, params: unknown, sessionId?: string) => {
    for (const listener of listeners.get(method) ?? []) {
      listener(params, sessionId);
    }
  };

  const rejectHeld = (sessionId: string) => {
    for (let i = held.length - 1; i >= 0; i--) {
      if (held[i].sessionId !== sessionId) continue;
      held.splice(i, 1)[0].answer.reject(new SessionDetachedError());
    }
  };

  const cdp = {
    get closed() {
      return closed;
    },
    // 失敗させる呼び出しも記録する (何を送ろうとしたかを確かめるため)
    send(
      method: string,
      params?: object,
      sessionId?: string,
      options?: { timeoutMs?: number }
    ) {
      if (closed || closing) return Promise.reject(new Error("closed"));
      calls.push({ method, params, sessionId });
      deadlines.set(method, options?.timeoutMs);
      if (failing.has(method)) {
        return Promise.reject(new Error(`${method}: failed`));
      }
      if (method === "Target.setDiscoverTargets") {
        for (const targetInfo of targets) {
          dispatch("Target.targetCreated", { targetInfo }, undefined);
        }
      }
      // 応答の中身は、呼ばれた順に決める
      const result = resultOf(method);
      if (holding.has(method)) {
        const answer = deferred<unknown>();
        held.push({ method, sessionId, answer, result });
        return answer.promise;
      }
      return Promise.resolve(result);
    },
    on(method: string, listener: (params: unknown, sid?: string) => void) {
      const list = listeners.get(method) ?? [];
      list.push(listener);
      listeners.set(method, list);
    },
    onClose(listener: () => void) {
      closeListeners.push(listener);
    },
    close: vi.fn(() => {
      closing = true;
    }),
    rejectSession(sessionId: string) {
      rejected.push(sessionId);
      rejectHeld(sessionId);
    },

    /**
     * `method` を最後に送ったときに渡された、応答の期限 (ミリ秒)。渡されなかったか、
     * 送っていなければ `undefined`。`forget` では消えない
     */
    deadlineOf: (method: string) => deadlines.get(method),

    /** `rejectSession` で名指しされたsessionを、呼ばれた順に返す */
    rejected: () => [...rejected],

    methods: () => calls.map(call => call.method),
    last(method: string) {
      const call = calls.findLast(c => c.method === method);
      return call && { params: call.params, sessionId: call.sessionId };
    },
    count: (method: string) => calls.filter(c => c.method === method).length,
    /** `method` の呼び出しを、呼ばれた順に返す */
    calls: (method: string) => calls.filter(c => c.method === method),
    /** 取り直し (`Page.captureScreenshot`) の引数を、呼ばれた順に返す */
    captures: () =>
      calls
        .filter(c => c.method === "Page.captureScreenshot")
        .map(c => c.params as CaptureParams),
    /** ここまでの呼び出しの記録を捨てる */
    forget() {
      calls.length = 0;
    },
    /** タブのsessionから来たイベントとして流す */
    emit(method: string, params: unknown, sessionId = "S1") {
      dispatch(method, params, sessionId);
    },
    /** ブラウザから来た (sessionの付かない) イベントとして流す */
    emitBrowser(method: string, params: unknown) {
      const detached = (params as { sessionId?: unknown } | null)?.sessionId;
      if (
        method === "Target.detachedFromTarget" &&
        typeof detached === "string"
      ) {
        rejectHeld(detached);
      }
      dispatch(method, params, undefined);
    },
    /** これ以降の `method` の応答を `result` にする */
    answer(method: string, result: unknown) {
      answers.set(method, result);
    },
    failOn(method: string) {
      failing.add(method);
    },
    stopFailing(method: string) {
      failing.delete(method);
    },
    /** これ以降の `method` の応答を、`release` / `fail` まで待たせる */
    holdOn(method: string) {
      holding.add(method);
    },
    stopHolding(method: string) {
      holding.delete(method);
    },
    /** 待たせている `method` のうち、いちばん古い1つを成功させる */
    release(method: string) {
      const entry = takeHeld(method);
      entry.answer.resolve(entry.result);
    },
    /** 待たせている `method` のうち、いちばん新しい1つを成功させる */
    releaseNewest(method: string) {
      const index = held.findLastIndex(entry => entry.method === method);
      if (index < 0) throw new Error(`${method} は待たせていません`);
      const [entry] = held.splice(index, 1);
      entry.answer.resolve(entry.result);
    },
    /** 待たせている `method` のうち、いちばん古い1つを失敗させる */
    fail(method: string) {
      takeHeld(method).answer.reject(new Error(`${method}: failed`));
    },
    /**
     * closeのイベントを届ける (Chromiumが落ちた、接続が切れた、`close()` が終わった)。
     * 本物と同じく、待っている応答を先に失敗させる。
     */
    disconnect() {
      if (closed) return;
      closed = true;
      for (const { answer } of held.splice(0)) {
        answer.reject(new Error("closed"));
      }
      for (const listener of closeListeners) listener();
    },
  };
  return cdp as typeof cdp & CdpLike;
}

const flush = () => vi.advanceTimersByTimeAsync(0);

/**
 * 定期の読み直しを始めさせない。定期の読み直しのほかを確かめるテストで、タイマーの数と
 * CDPの呼び出しの並びに、定期の読み直しのぶんを混ぜないため。`vi.restoreAllMocks` で戻る。
 */
function withoutPoll(): void {
  vi.spyOn(
    BrowserCdpBridge.prototype as unknown as { startPoll(): void },
    "startPoll"
  ).mockImplementation(() => {});
}

const ERROR_BODY = JSON.stringify({
  t: "error",
  message: "ブラウザとの接続が切れました",
});

type Rgb = [number, number, number];

interface CaptureParams {
  format: string;
  quality: number;
  clip: { x: number; y: number; width: number; height: number; scale: number };
}

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
/** 既定のビューポート (1280x900) の監視フレームの寸法 */
const MONITOR = { width: 160, height: 113 };
const FULL_RECT = { x: 0, y: 0, width: 1280, height: 900 };
const CAPTURE = "Page.captureScreenshot";

/**
 * 監視フレーム。`rgb` (既定は白) で塗り、`dots` の画素だけ黒くする。
 * `id` はackに使うフレームの番号。
 */
function monitorFrame(
  id: number,
  options: {
    dots?: Array<[number, number]>;
    rgb?: Rgb;
    size?: { width: number; height: number };
    metadata?: unknown;
  } = {}
) {
  const size = options.size ?? MONITOR;
  const png = buildSolidPng(
    size.width,
    size.height,
    options.rgb ?? WHITE,
    (options.dots ?? []).map(([x, y]) => ({ x, y, rgb: BLACK }))
  );
  return {
    data: png.toString("base64"),
    sessionId: id,
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
  };
}

/** 左上が (x, y) で幅w、高さhの範囲の画素 */
function block(
  x: number,
  y: number,
  w: number,
  h: number
): Array<[number, number]> {
  const dots: Array<[number, number]> = [];
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) dots.push([x + dx, y + dy]);
  }
  return dots;
}

/** 視聴者が受け取ったバイナリのフレームを、ヘッダと画像に分ける */
function parseFrame(frame: Buffer) {
  return {
    kind: frame[0],
    gen: frame.readUInt16BE(1),
    rect: {
      x: frame.readUInt16BE(3),
      y: frame.readUInt16BE(5),
      width: frame.readUInt16BE(7),
      height: frame.readUInt16BE(9),
    },
    image: frame.subarray(11).toString(),
  };
}

function viewportBody(width: number, height: number, gen: number): string {
  return JSON.stringify({ t: "viewport", width, height, gen });
}

/** タブが既定の1つ (`T1`。URLも題も分からない) だけのときの、一覧の通知 */
const ONE_TAB = {
  t: "tabs",
  tabs: [{ id: "T1", title: "", url: "" }],
  activeId: "T1",
};
const ONE_TAB_BODY = JSON.stringify(ONE_TAB);

function fakeViewer() {
  const viewer = new EventEmitter() as EventEmitter &
    ViewerSocket & {
      send: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
      receive(message: unknown): void;
      frames(): Buffer[];
      shots(): Array<ReturnType<typeof parseFrame>>;
      kinds(): number[];
      texts(): unknown[];
    };
  viewer.readyState = 1;
  viewer.bufferedAmount = 0;
  viewer.send = vi.fn();
  viewer.close = vi.fn();
  viewer.terminate = vi.fn();
  viewer.receive = message => {
    viewer.emit("message", Buffer.from(JSON.stringify(message)), false);
  };
  /** 受け取ったフレーム (バイナリ) を、届いた順に返す */
  viewer.frames = () =>
    viewer.send.mock.calls.map(([data]) => data).filter(Buffer.isBuffer);
  /** 受け取ったJSONのメッセージを、届いた順に返す */
  viewer.texts = () =>
    viewer.send.mock.calls
      .map(([data]) => data)
      .filter(data => typeof data === "string")
      .map(data => JSON.parse(data));
  /** 受け取ったフレームを、ヘッダを読んだ形で返す */
  viewer.shots = () => viewer.frames().map(parseFrame);
  /** 受け取ったフレームの種類 (1 = 鮮明な全画面、2 = 粗い全画面、3 = 矩形) */
  viewer.kinds = () => viewer.shots().map(shot => shot.kind);
  return viewer;
}

/** 視聴者が受け取ったerrorの数 */
function errorCount(viewer: ReturnType<typeof fakeViewer>): number {
  return viewer
    .texts()
    .filter(message => (message as { t?: unknown }).t === "error").length;
}
/**
 * 視聴者が `count` 人つながり、最初の全画面を受け取り終えた状態にする。
 * 続く全面の変化が「動いている」とみなされないよう、時間を空けてから返す。
 * ここまでの送信とCDPの呼び出しの記録は捨てる。
 */
async function started(count = 1) {
  const cdp = fakeCdp();
  const bridge = new BrowserCdpBridge(async () => cdp);
  const viewers = Array.from({ length: count }, () => fakeViewer());
  for (const viewer of viewers) bridge.attach(viewer);
  await flush();
  cdp.emit("Page.screencastFrame", monitorFrame(1));
  await vi.advanceTimersByTimeAsync(1000);
  for (const viewer of viewers) viewer.send.mockClear();
  cdp.forget();
  return { cdp, bridge, viewers, viewer: viewers[0] };
}

describe("BrowserCdpBridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    withoutPoll();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("最初の視聴者でタブへattachし、screencastを始める", async () => {
    const cdp = fakeCdp();
    const bridge = new BrowserCdpBridge(async () => cdp);
    bridge.attach(fakeViewer());
    await vi.runAllTimersAsync();
    expect(cdp.methods()).toEqual([
      "Target.setDiscoverTargets",
      "Target.getTargets",
      "Target.activateTarget",
      "Target.attachToTarget",
      "Page.enable",
      "Emulation.setFocusEmulationEnabled",
      "Emulation.setDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
      "Runtime.enable",
      "Runtime.addBinding",
      "Page.addScriptToEvaluateOnNewDocument",
      "Runtime.evaluate",
      "Page.getNavigationHistory",
      "Page.startScreencast",
    ]);
    // つなぐタブを前面にする (前面でないタブは描画されない)
    expect(cdp.last("Target.activateTarget")?.params).toEqual({
      targetId: "T1",
    });
    expect(cdp.last("Target.attachToTarget")?.params).toEqual({
      targetId: "T1",
      flatten: true,
    });
    expect(cdp.last("Emulation.setDeviceMetricsOverride")).toEqual({
      params: { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
      sessionId: "S1",
    });
    expect(cdp.last("Page.startScreencast")).toEqual({
      params: {
        format: "png",
        maxWidth: 160,
        maxHeight: 113,
        everyNthFrame: 1,
      },
      sessionId: "S1",
    });
  });

  it("監視フレームは視聴者へ送らず、取り直しを待たずにackを返す", async () => {
    const cdp = fakeCdp();
    cdp.holdOn(CAPTURE);
    const bridge = new BrowserCdpBridge(async () => cdp);
    const viewer = fakeViewer();
    bridge.attach(viewer);
    await vi.runAllTimersAsync();
    cdp.emit("Page.screencastFrame", monitorFrame(7));
    expect(cdp.last("Page.screencastFrameAck")).toEqual({
      params: { sessionId: 7 },
      sessionId: "S1",
    });
    await flush();
    expect(viewer.frames()).toEqual([]);
    cdp.release(CAPTURE);
    await flush();
    // 届くのは取り直した画だけ
    expect(viewer.shots().map(shot => shot.image)).toEqual(["shot-1"]);
  });

  it("あとから入った視聴者にだけ、鮮明な全画面を取り直して送る", async () => {
    const cdp = fakeCdp();
    const bridge = new BrowserCdpBridge(async () => cdp);
    const first = fakeViewer();
    bridge.attach(first);
    await vi.runAllTimersAsync();
    cdp.emit("Page.screencastFrame", monitorFrame(1));
    await flush();
    const late = fakeViewer();
    bridge.attach(late);
    await vi.runAllTimersAsync();
    expect(late.shots()).toEqual([
      { kind: 1, gen: 1, rect: FULL_RECT, image: "shot-2" },
    ]);
    expect(first.frames()).toHaveLength(1);
    expect(cdp.count("Page.startScreencast")).toBe(1);
  });

  it("視聴者が詰まっていてもackは返し、取り直しは空くまで待つ", async () => {
    const cdp = fakeCdp();
    const bridge = new BrowserCdpBridge(async () => cdp);
    const viewer = fakeViewer();
    bridge.attach(viewer);
    await vi.runAllTimersAsync();
    viewer.bufferedAmount = 2_000_000;
    cdp.emit("Page.screencastFrame", monitorFrame(8));
    expect(cdp.count("Page.screencastFrameAck")).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(viewer.frames()).toEqual([]);
    expect(cdp.count(CAPTURE)).toBe(0);
    viewer.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(50);
    expect(viewer.kinds()).toEqual([1]);
    expect(cdp.count(CAPTURE)).toBe(1);
  });

  it("詰まっている間の変化は溜めておき、空いたときに1回で取り直す", async () => {
    const { cdp, viewer } = await started();
    viewer.bufferedAmount = 2_000_000;
    cdp.emit("Page.screencastFrame", monitorFrame(2, { dots: [[10, 10]] }));
    cdp.emit(
      "Page.screencastFrame",
      monitorFrame(3, {
        dots: [
          [10, 10],
          [12, 10],
        ],
      })
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(cdp.count("Page.screencastFrameAck")).toBe(2);
    expect(cdp.count(CAPTURE)).toBe(0);
    viewer.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(50);
    // 2つの変化を囲む1つの矩形。何も飛ばされていないので、全画面にはならない
    expect(cdp.captures().map(c => c.clip)).toEqual([
      { x: 72, y: 71, width: 40, height: 25, scale: 1 },
    ]);
    expect(viewer.kinds()).toEqual([3]);
  });

  it("視聴者が0人になったらscreencastを止め、戻ったら始める", async () => {
    const cdp = fakeCdp();
    const bridge = new BrowserCdpBridge(async () => cdp);
    const viewer = fakeViewer();
    bridge.attach(viewer);
    await vi.runAllTimersAsync();
    viewer.emit("close");
    await vi.runAllTimersAsync();
    expect(cdp.count("Page.stopScreencast")).toBe(1);
    expect(bridge.viewerCount).toBe(0);
    bridge.attach(fakeViewer());
    await vi.runAllTimersAsync();
    expect(cdp.count("Page.startScreencast")).toBe(2);
    expect(cdp.count("Target.attachToTarget")).toBe(1);
  });

  it("screencastを止めたら監視の状態を捨て、始め直した最初の監視フレームで全画面を送る", async () => {
    const cdp = fakeCdp();
    const bridge = new BrowserCdpBridge(async () => cdp);
    const viewer = fakeViewer();
    bridge.attach(viewer);
    await vi.runAllTimersAsync();
    cdp.emit("Page.screencastFrame", monitorFrame(1));
    await flush();
    viewer.emit("close");
    await vi.runAllTimersAsync();
    const late = fakeViewer();
    bridge.attach(late);
    await vi.runAllTimersAsync();
    // 止める前の監視フレームをもとに取り直さない
    expect(late.frames()).toEqual([]);
    expect(cdp.count(CAPTURE)).toBe(1);
    cdp.emit("Page.screencastFrame", monitorFrame(2));
    await flush();
    expect(late.kinds()).toEqual([1]);
  });

  it("resizeを丸めてデバウンスし、screencastを同じ寸法で始め直す", async () => {
    const cdp = fakeCdp();
    const bridge = new BrowserCdpBridge(async () => cdp);
    const viewer = fakeViewer();
    bridge.attach(viewer);
    await vi.runAllTimersAsync();
    viewer.receive({
      t: "resize",
      width: 100,
      height: 700,
      dpr: 3,
      mobile: true,
    });
    viewer.receive({
      t: "resize",
      width: 390.4,
      height: 700,
      dpr: 3,
      mobile: true,
    });
    await vi.advanceTimersByTimeAsync(149);
    expect(cdp.count("Emulation.setDeviceMetricsOverride")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();
    expect(cdp.last("Emulation.setDeviceMetricsOverride")?.params).toEqual({
      width: 390,
      height: 700,
      deviceScaleFactor: 2,
      mobile: true,
    });
    // mobileになったので、タッチのエミュレーションも有効にする
    expect(cdp.methods().slice(-4)).toEqual([
      "Emulation.setDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
      "Page.stopScreencast",
      "Page.startScreencast",
    ]);
    expect(cdp.last("Page.startScreencast")?.params).toMatchObject({
      maxWidth: 49,
      maxHeight: 88,
    });
  });

  it("入力をCDPへ変換して送り、rejectされても視聴者を切らない", async () => {
    const cdp = fakeCdp();
    cdp.failOn("Input.insertText");
    const bridge = new BrowserCdpBridge(async () => cdp);
    const viewer = fakeViewer();
    bridge.attach(viewer);
    await vi.runAllTimersAsync();
    viewer.receive({ t: "paste", text: "日本語" });
    await vi.runAllTimersAsync();
    expect(cdp.last("Input.insertText")).toEqual({
      params: { text: "日本語" },
      sessionId: "S1",
    });
    expect(viewer.close).not.toHaveBeenCalled();
  });

  it("バイナリと不正なメッセージは無視する", async () => {
    const cdp = fakeCdp();
    const bridge = new BrowserCdpBridge(async () => cdp);
    const viewer = fakeViewer();
    bridge.attach(viewer);
    await vi.runAllTimersAsync();
    const before = cdp.methods().length;
    viewer.emit("message", Buffer.from('{"t":"paste","text":"x"}'), true);
    viewer.emit("message", Buffer.from('{"t":"eval","code":"x"}'), false);
    viewer.emit("message", Buffer.from("{"), false);
    await vi.runAllTimersAsync();
    expect(cdp.methods().length).toBe(before);
    expect(viewer.close).not.toHaveBeenCalled();
  });

  it("CDPが切れたら視聴者へerrorを送って閉じ、次のattachでつなぎ直す", async () => {
    const first = fakeCdp();
    const second = fakeCdp();
    const connect = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const bridge = new BrowserCdpBridge(connect);
    const viewer = fakeViewer();
    bridge.attach(viewer);
    await vi.runAllTimersAsync();
    first.disconnect();
    expect(viewer.send).toHaveBeenCalledWith(
      JSON.stringify({ t: "error", message: "ブラウザとの接続が切れました" })
    );
    expect(viewer.close).toHaveBeenCalledWith(1011, expect.any(String));
    expect(bridge.viewerCount).toBe(0);
    bridge.attach(fakeViewer());
    await vi.runAllTimersAsync();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(second.count("Page.startScreencast")).toBe(1);
  });

  it("つなげなければ視聴者へerrorを送って閉じる", async () => {
    const bridge = new BrowserCdpBridge(async () => {
      throw new Error("ECONNREFUSED");
    });
    const viewer = fakeViewer();
    bridge.attach(viewer);
    await vi.runAllTimersAsync();
    expect(viewer.send).toHaveBeenCalledWith(
      expect.stringContaining('"t":"error"')
    );
    expect(viewer.close).toHaveBeenCalled();
    expect(bridge.viewerCount).toBe(0);
  });

  it("つなげなかったあとのattachは、つなぎ直す", async () => {
    const cdp = fakeCdp();
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(cdp);
    const bridge = new BrowserCdpBridge(connect);
    bridge.attach(fakeViewer());
    await vi.runAllTimersAsync();
    bridge.attach(fakeViewer());
    await vi.runAllTimersAsync();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(cdp.count("Page.startScreencast")).toBe(1);
  });

  it("navigateはつないでいなくてもPage.navigateを送る", async () => {
    const cdp = fakeCdp();
    const bridge = new BrowserCdpBridge(async () => cdp);
    await bridge.navigate("http://localhost:3000/");
    expect(cdp.last("Page.navigate")).toEqual({
      params: { url: "http://localhost:3000/" },
      sessionId: "S1",
    });
    expect(cdp.count("Page.startScreencast")).toBe(0);
  });

  it("同時のattachとnavigateは接続を1本にまとめる", async () => {
    const cdp = fakeCdp();
    const connect = vi.fn().mockResolvedValue(cdp);
    const bridge = new BrowserCdpBridge(connect);
    bridge.attach(fakeViewer());
    bridge.attach(fakeViewer());
    await bridge.navigate("http://localhost:3000/");
    await vi.runAllTimersAsync();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(cdp.count("Target.attachToTarget")).toBe(1);
    expect(cdp.count("Page.startScreencast")).toBe(1);
  });

  it("resetはCDPを閉じ、視聴者をterminateする", async () => {
    const first = fakeCdp();
    const second = fakeCdp();
    const connect = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const bridge = new BrowserCdpBridge(connect);
    const viewer = fakeViewer();
    bridge.attach(viewer);
    await vi.runAllTimersAsync();
    bridge.reset();
    expect(first.close).toHaveBeenCalled();
    expect(viewer.terminate).toHaveBeenCalled();
    expect(viewer.close).not.toHaveBeenCalled();
    expect(bridge.viewerCount).toBe(0);
    bridge.attach(fakeViewer());
    await vi.runAllTimersAsync();
    expect(second.count("Page.startScreencast")).toBe(1);
  });

  describe("競合", () => {
    it("connect() を待つ間にresetされたら、終わった接続を閉じて使わない", async () => {
      const pending = deferred<CdpLike>();
      const first = fakeCdp();
      const second = fakeCdp();
      const connect = vi
        .fn()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce(second);
      const bridge = new BrowserCdpBridge(connect);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      bridge.reset();
      expect(viewer.terminate).toHaveBeenCalled();
      const next = fakeViewer();
      bridge.attach(next);
      await flush();
      pending.resolve(first);
      await flush();
      expect(first.close).toHaveBeenCalled();
      expect(first.methods()).toEqual([]);
      // 捨てた接続の失敗は、新しい視聴者に響かせない
      expect(viewer.send).not.toHaveBeenCalled();
      expect(next.close).not.toHaveBeenCalled();
      expect(bridge.viewerCount).toBe(1);
      expect(second.count("Page.startScreencast")).toBe(1);
    });

    it("resetのあとに遅れて届いた古い接続のcloseは、新しい接続に響かない", async () => {
      const first = fakeCdp();
      const second = fakeCdp();
      const connect = vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second);
      const bridge = new BrowserCdpBridge(connect);
      bridge.attach(fakeViewer());
      await flush();
      bridge.reset();
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      first.disconnect();
      await flush();
      expect(errorCount(viewer)).toBe(0);
      expect(viewer.close).not.toHaveBeenCalled();
      expect(bridge.viewerCount).toBe(1);
      second.emit("Page.screencastFrame", monitorFrame(1));
      await flush();
      expect(viewer.kinds()).toEqual([1]);
      expect(second.count("Page.screencastFrameAck")).toBe(1);
    });

    it("準備の途中でCDPが切れたら、視聴者へerrorを1回だけ送り、次のattachでつなぎ直す", async () => {
      const first = fakeCdp();
      const second = fakeCdp();
      const connect = vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second);
      first.holdOn("Page.enable");
      const bridge = new BrowserCdpBridge(connect);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      expect(first.count("Page.enable")).toBe(1);
      first.disconnect();
      await flush();
      expect(viewer.send).toHaveBeenCalledTimes(1);
      expect(viewer.send).toHaveBeenCalledWith(ERROR_BODY);
      expect(viewer.close).toHaveBeenCalledTimes(1);
      expect(bridge.viewerCount).toBe(0);
      bridge.attach(fakeViewer());
      await flush();
      expect(connect).toHaveBeenCalledTimes(2);
      expect(second.count("Page.startScreencast")).toBe(1);
    });

    it("つないでいる間に去った視聴者のためにscreencastを始めない", async () => {
      const pending = deferred<CdpLike>();
      const cdp = fakeCdp();
      const bridge = new BrowserCdpBridge(() => pending.promise);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      viewer.emit("close");
      pending.resolve(cdp);
      await flush();
      expect(bridge.viewerCount).toBe(0);
      expect(cdp.count("Page.startScreencast")).toBe(0);
      expect(viewer.send).not.toHaveBeenCalled();
      // つないだタブは、次の視聴者がそのまま使う
      bridge.attach(fakeViewer());
      await flush();
      expect(cdp.count("Target.attachToTarget")).toBe(1);
      expect(cdp.count("Page.startScreencast")).toBe(1);
    });

    it("CDPが切れたら、resizeと視聴者の空き待ちのタイマーを消す", async () => {
      const cdp = fakeCdp();
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      viewer.receive({
        t: "resize",
        width: 500,
        height: 500,
        dpr: 1,
        mobile: false,
      });
      viewer.bufferedAmount = 2_000_000;
      cdp.emit("Page.screencastFrame", monitorFrame(1));
      expect(vi.getTimerCount()).toBe(2);
      cdp.disconnect();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("resetしたら、resizeと視聴者の空き待ちのタイマーを消す", async () => {
      const cdp = fakeCdp();
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      viewer.receive({
        t: "resize",
        width: 500,
        height: 500,
        dpr: 1,
        mobile: false,
      });
      viewer.bufferedAmount = 2_000_000;
      cdp.emit("Page.screencastFrame", monitorFrame(1));
      bridge.reset();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("準備の途中に受けたresizeは、タブが使えるようになったときに当てる", async () => {
      const cdp = fakeCdp();
      cdp.holdOn("Emulation.setDeviceMetricsOverride");
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      expect(cdp.count("Emulation.setDeviceMetricsOverride")).toBe(1);
      viewer.receive({
        t: "resize",
        width: 500,
        height: 600,
        dpr: 1,
        mobile: false,
      });
      // デバウンスが先に明ける。タブはまだ使えない
      await vi.advanceTimersByTimeAsync(200);
      expect(cdp.count("Emulation.setDeviceMetricsOverride")).toBe(1);
      cdp.stopHolding("Emulation.setDeviceMetricsOverride");
      cdp.release("Emulation.setDeviceMetricsOverride");
      await vi.runAllTimersAsync();
      expect(cdp.count("Emulation.setDeviceMetricsOverride")).toBe(2);
      expect(cdp.last("Emulation.setDeviceMetricsOverride")?.params).toEqual({
        width: 500,
        height: 600,
        deviceScaleFactor: 1,
        mobile: false,
      });
      // screencastは新しい寸法で1回だけ始める。始め直しはしない
      expect(cdp.count("Page.startScreencast")).toBe(1);
      expect(cdp.count("Page.stopScreencast")).toBe(0);
      expect(cdp.last("Page.startScreencast")?.params).toMatchObject({
        maxWidth: 63,
        maxHeight: 75,
      });
    });

    it("切れる前に受けたresizeは、つなぎ直した接続でscreencastを始め直さない", async () => {
      const first = fakeCdp();
      const second = fakeCdp();
      const connect = vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second);
      const bridge = new BrowserCdpBridge(connect);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      viewer.receive({
        t: "resize",
        width: 500,
        height: 500,
        dpr: 1,
        mobile: false,
      });
      first.disconnect();
      bridge.attach(fakeViewer());
      await vi.advanceTimersByTimeAsync(1000);
      // 寸法は覚えていて、新しい接続の準備で1回だけ当てる
      expect(second.count("Emulation.setDeviceMetricsOverride")).toBe(1);
      expect(second.last("Emulation.setDeviceMetricsOverride")?.params).toEqual(
        { width: 500, height: 500, deviceScaleFactor: 1, mobile: false }
      );
      expect(second.count("Page.stopScreencast")).toBe(0);
      expect(second.count("Page.startScreencast")).toBe(1);
    });
  });

  describe("タブが使えなくなったとき", () => {
    async function connected() {
      const cdp = fakeCdp();
      const connect = vi.fn().mockResolvedValue(cdp);
      const bridge = new BrowserCdpBridge(connect);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      cdp.forget();
      return { cdp, connect, bridge, viewer };
    }

    /** 視聴者を切らず、接続も捨てずに、作り直したタブへ移っている */
    async function expectMoved({
      cdp,
      connect,
      bridge,
      viewer,
    }: Awaited<ReturnType<typeof connected>>) {
      await flush();
      expect(errorCount(viewer)).toBe(0);
      expect(viewer.close).not.toHaveBeenCalled();
      expect(viewer.terminate).not.toHaveBeenCalled();
      expect(bridge.viewerCount).toBe(1);
      expect(cdp.close).not.toHaveBeenCalled();
      expect(connect).toHaveBeenCalledTimes(1);
      expect(cdp.last("Target.createTarget")?.params).toEqual({
        url: "about:blank",
      });
      expect(cdp.last("Target.attachToTarget")?.params).toEqual({
        targetId: "T-new",
        flatten: true,
      });
      expect(cdp.last("Page.startScreencast")?.sessionId).toBe("S2");
      // 新しいタブの画面が届く
      cdp.emit("Page.screencastFrame", monitorFrame(1), "S2");
      await flush();
      expect(viewer.shots()).toMatchObject([{ kind: 1, gen: 2 }]);
    }

    it("タブのsessionがdetachされても視聴者を切らず、残りが無ければabout:blankを作って移る", async () => {
      const ctx = await connected();
      ctx.cdp.emitBrowser("Target.detachedFromTarget", {
        sessionId: "S1",
        targetId: "T1",
      });
      ctx.cdp.emitBrowser("Target.targetDestroyed", { targetId: "T1" });
      await expectMoved(ctx);
      // 消えたsessionへは、止める、離れるを送らない。閉じ直しもしない
      expect(ctx.cdp.count("Page.stopScreencast")).toBe(0);
      expect(ctx.cdp.count("Target.detachFromTarget")).toBe(0);
      expect(ctx.cdp.count("Target.closeTarget")).toBe(0);
    });

    it("タブがクラッシュしたら、sessionを離し、そのタブを閉じてから、視聴者を切らずに移る", async () => {
      const ctx = await connected();
      ctx.cdp.emit("Inspector.targetCrashed", undefined);
      await expectMoved(ctx);
      expect(ctx.cdp.methods().slice(0, 4)).toEqual([
        "Page.stopScreencast",
        "Target.detachFromTarget",
        "Target.closeTarget",
        "Target.createTarget",
      ]);
      expect(ctx.cdp.last("Target.closeTarget")?.params).toEqual({
        targetId: "T1",
      });
    });

    it("タブがクラッシュしたら、視聴者へ知らせる。ふつうのdetachでは知らせない", async () => {
      const crashed = await connected();
      crashed.cdp.emit("Inspector.targetCrashed", undefined);
      await expectMoved(crashed);
      expect(crashed.viewer.texts()).toContainEqual({
        t: "notice",
        message: "タブがクラッシュしました",
      });

      const detached = await connected();
      detached.cdp.emitBrowser("Target.detachedFromTarget", {
        sessionId: "S1",
        targetId: "T1",
      });
      await expectMoved(detached);
      expect(detached.viewer.texts()).not.toContainEqual({
        t: "notice",
        message: "タブがクラッシュしました",
      });
    });

    it("クラッシュしたタブを閉じられなくても、移る", async () => {
      const ctx = await connected();
      ctx.cdp.failOn("Target.closeTarget");
      ctx.cdp.emit("Inspector.targetCrashed", undefined);
      await expectMoved(ctx);
    });

    it("別のsessionのdetachとクラッシュは無視する", async () => {
      const { cdp, bridge, viewer } = await connected();
      cdp.emitBrowser("Target.detachedFromTarget", { sessionId: "S9" });
      cdp.emit("Inspector.targetCrashed", undefined, "S9");
      cdp.emitBrowser("Inspector.targetCrashed", undefined);
      await flush();
      expect(viewer.close).not.toHaveBeenCalled();
      expect(cdp.close).not.toHaveBeenCalled();
      expect(cdp.methods()).toEqual([]);
      expect(bridge.viewerCount).toBe(1);
    });

    it("準備の途中でタブがdetachされたら、視聴者を切らずに、ほかのタブで準備をやり直す", async () => {
      const cdp = fakeCdp();
      cdp.holdOn("Page.enable");
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      // 待っていた `Page.enable` の応答は、もう返らない
      cdp.stopHolding("Page.enable");
      cdp.emitBrowser("Target.detachedFromTarget", { sessionId: "S1" });
      cdp.emitBrowser("Target.targetDestroyed", { targetId: "T1" });
      await flush();
      expect(errorCount(viewer)).toBe(0);
      expect(viewer.close).not.toHaveBeenCalled();
      expect(cdp.close).not.toHaveBeenCalled();
      expect(bridge.viewerCount).toBe(1);
      // 消えたタブでは準備を続けない
      expect(cdp.count("Emulation.setFocusEmulationEnabled")).toBe(1);
      expect(cdp.last("Emulation.setFocusEmulationEnabled")?.sessionId).toBe(
        "S2"
      );
      expect(cdp.last("Target.attachToTarget")?.params).toMatchObject({
        targetId: "T-new",
      });
      expect(cdp.count("Page.startScreencast")).toBe(1);
      expect(cdp.last("Page.startScreencast")?.sessionId).toBe("S2");
    });

    it("どのタブでも準備できなければ、視聴者へerrorを1回だけ送って接続を閉じる", async () => {
      const cdp = fakeCdp();
      cdp.failOn("Page.enable");
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      // いまあるタブ、作ったabout:blankの順に試す
      expect(cdp.count("Target.attachToTarget")).toBe(2);
      expect(cdp.count("Target.createTarget")).toBe(1);
      expect(errorCount(viewer)).toBe(1);
      expect(viewer.close).toHaveBeenCalledTimes(1);
      expect(cdp.close).toHaveBeenCalled();
      expect(cdp.count("Page.startScreencast")).toBe(0);
      expect(bridge.viewerCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("タブが1つも無ければ、about:blankで作ってattachする", async () => {
      const cdp = fakeCdp({ targets: [{ targetId: "W1", type: "worker" }] });
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      expect(cdp.methods().slice(0, 5)).toEqual([
        "Target.setDiscoverTargets",
        "Target.getTargets",
        "Target.createTarget",
        "Target.activateTarget",
        "Target.attachToTarget",
      ]);
      expect(cdp.last("Target.createTarget")?.params).toEqual({
        url: "about:blank",
      });
      expect(cdp.last("Target.attachToTarget")?.params).toEqual({
        targetId: "T-new",
        flatten: true,
      });
      expect(cdp.count("Page.startScreencast")).toBe(1);
      expect(viewer.close).not.toHaveBeenCalled();
    });
  });

  describe("screencastを始められなかったとき", () => {
    it("同時に入っていた視聴者も含めて、全員をerrorで閉じてつなぎ直せる状態にする", async () => {
      const first = fakeCdp();
      const second = fakeCdp();
      const connect = vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second);
      first.failOn("Page.startScreencast");
      const bridge = new BrowserCdpBridge(connect);
      const a = fakeViewer();
      const b = fakeViewer();
      bridge.attach(a);
      bridge.attach(b);
      await flush();
      for (const viewer of [a, b]) {
        expect(errorCount(viewer)).toBe(1);
        expect(viewer.send).toHaveBeenCalledWith(
          expect.stringContaining('"t":"error"')
        );
        expect(viewer.close).toHaveBeenCalledTimes(1);
      }
      expect(bridge.viewerCount).toBe(0);
      expect(first.close).toHaveBeenCalled();
      bridge.attach(fakeViewer());
      await flush();
      expect(connect).toHaveBeenCalledTimes(2);
      expect(second.count("Page.startScreencast")).toBe(1);
    });

    it("resizeの始め直しで失敗したら、視聴者を切らずに、ほかのタブへ移る", async () => {
      const cdp = fakeCdp();
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      cdp.holdOn("Page.startScreencast");
      viewer.receive({
        t: "resize",
        width: 500,
        height: 500,
        dpr: 1,
        mobile: false,
      });
      await vi.advanceTimersByTimeAsync(150);
      expect(cdp.count("Page.startScreencast")).toBe(2);
      cdp.stopHolding("Page.startScreencast");
      cdp.fail("Page.startScreencast");
      await flush();
      expect(errorCount(viewer)).toBe(0);
      expect(viewer.close).not.toHaveBeenCalled();
      expect(bridge.viewerCount).toBe(1);
      expect(cdp.close).not.toHaveBeenCalled();
      // タブは1つしか無かったので、about:blankを作って移る
      expect(cdp.last("Target.attachToTarget")?.params).toMatchObject({
        targetId: "T-new",
      });
      expect(cdp.last("Page.startScreencast")?.sessionId).toBe("S2");
    });

    it("寸法の設定と停止だけが失敗したときは、視聴者を切らない", async () => {
      const cdp = fakeCdp();
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      cdp.failOn("Emulation.setDeviceMetricsOverride");
      cdp.failOn("Page.stopScreencast");
      const resize = {
        t: "resize",
        width: 500,
        height: 500,
        dpr: 1,
        mobile: false,
      };
      viewer.receive(resize);
      await vi.advanceTimersByTimeAsync(150);
      expect(viewer.close).not.toHaveBeenCalled();
      expect(bridge.viewerCount).toBe(1);
      // 当たらなかった寸法は、同じ寸法がもう一度来たら当て直す
      viewer.receive(resize);
      await vi.advanceTimersByTimeAsync(150);
      expect(cdp.count("Emulation.setDeviceMetricsOverride")).toBe(3);
    });

    it("去った視聴者のための開始が遅れて失敗しても、いまの視聴者に響かない", async () => {
      const cdp = fakeCdp();
      cdp.holdOn("Page.startScreencast");
      const bridge = new BrowserCdpBridge(async () => cdp);
      const a = fakeViewer();
      bridge.attach(a);
      await flush();
      a.emit("close");
      await flush();
      const b = fakeViewer();
      bridge.attach(b);
      await flush();
      expect(cdp.count("Page.startScreencast")).toBe(2);
      cdp.fail("Page.startScreencast");
      await flush();
      cdp.release("Page.startScreencast");
      await flush();
      expect(b.close).not.toHaveBeenCalled();
      expect(cdp.close).not.toHaveBeenCalled();
      expect(bridge.viewerCount).toBe(1);
      cdp.emit("Page.screencastFrame", monitorFrame(3));
      await flush();
      expect(b.kinds()).toEqual([1]);
      expect(cdp.count("Page.screencastFrameAck")).toBe(1);
    });
  });

  describe("遅れた視聴者", () => {
    it("詰まった視聴者は矩形を飛ばされ、空いたら鮮明な全画面を受け取る", async () => {
      const { cdp, viewers } = await started(2);
      const [fast, slow] = viewers;
      slow.bufferedAmount = 2_000_000;
      cdp.emit("Page.screencastFrame", monitorFrame(2, { dots: [[10, 10]] }));
      await flush();
      expect(fast.kinds()).toEqual([3]);
      expect(slow.frames()).toEqual([]);
      // 詰まっている間も、詰まっていない視聴者には矩形が届き続け、全画面は届かない
      cdp.emit(
        "Page.screencastFrame",
        monitorFrame(3, {
          dots: [
            [10, 10],
            [100, 80],
          ],
        })
      );
      await vi.advanceTimersByTimeAsync(200);
      expect(fast.kinds()).toEqual([3, 3]);
      expect(slow.frames()).toEqual([]);
      slow.bufferedAmount = 0;
      await vi.advanceTimersByTimeAsync(50);
      expect(slow.shots()).toMatchObject([{ kind: 1, rect: FULL_RECT }]);
      expect(fast.kinds()).toEqual([3, 3]);
      // 全員が揃ったら見直しをやめる
      expect(vi.getTimerCount()).toBe(0);
      cdp.emit(
        "Page.screencastFrame",
        monitorFrame(4, {
          dots: [
            [10, 10],
            [100, 80],
            [50, 50],
          ],
        })
      );
      await flush();
      expect(fast.kinds()).toEqual([3, 3, 3]);
      expect(slow.kinds()).toEqual([1, 3]);
    });

    it("入ったときに詰まっていた視聴者も、空いたときに全画面を受け取る", async () => {
      const { cdp, bridge, viewer: first } = await started();
      const late = fakeViewer();
      late.bufferedAmount = 2_000_000;
      bridge.attach(late);
      await vi.advanceTimersByTimeAsync(200);
      expect(late.frames()).toEqual([]);
      expect(cdp.count(CAPTURE)).toBe(0);
      late.bufferedAmount = 0;
      await vi.advanceTimersByTimeAsync(50);
      expect(late.kinds()).toEqual([1]);
      expect(first.frames()).toEqual([]);
      expect(cdp.count(CAPTURE)).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("遅れた視聴者が去ったら、見直しをやめる", async () => {
      const { cdp, viewers } = await started(2);
      const [fast, slow] = viewers;
      slow.bufferedAmount = 2_000_000;
      cdp.emit("Page.screencastFrame", monitorFrame(2, { dots: [[10, 10]] }));
      await flush();
      expect(vi.getTimerCount()).toBe(1);
      slow.emit("close");
      await vi.advanceTimersByTimeAsync(50);
      expect(vi.getTimerCount()).toBe(0);
      expect(fast.kinds()).toEqual([3]);
    });
  });

  describe("視聴者の出入り", () => {
    it("去った視聴者から届いた入力はCDPへ送らない", async () => {
      const cdp = fakeCdp();
      const bridge = new BrowserCdpBridge(async () => cdp);
      const gone = fakeViewer();
      bridge.attach(gone);
      bridge.attach(fakeViewer());
      await flush();
      gone.emit("close");
      gone.receive({ t: "paste", text: "x" });
      gone.receive({
        t: "resize",
        width: 500,
        height: 500,
        dpr: 1,
        mobile: false,
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(cdp.count("Input.insertText")).toBe(0);
      expect(cdp.count("Emulation.setDeviceMetricsOverride")).toBe(1);
    });

    it("errorで閉じた視聴者から届いた入力は、つなぎ直した接続へ送らない", async () => {
      const first = fakeCdp();
      const second = fakeCdp();
      const connect = vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second);
      const bridge = new BrowserCdpBridge(connect);
      const closed = fakeViewer();
      bridge.attach(closed);
      await flush();
      first.disconnect();
      bridge.attach(fakeViewer());
      await flush();
      closed.receive({ t: "paste", text: "x" });
      await flush();
      expect(second.count("Input.insertText")).toBe(0);
    });

    it("同じ視聴者を二度attachしても、1人として扱う", async () => {
      const cdp = fakeCdp();
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      bridge.attach(viewer);
      await flush();
      expect(bridge.viewerCount).toBe(1);
      expect(viewer.listenerCount("message")).toBe(1);
      viewer.receive({ t: "paste", text: "x" });
      cdp.emit("Page.screencastFrame", monitorFrame(1));
      await flush();
      expect(cdp.count("Input.insertText")).toBe(1);
      expect(viewer.frames()).toHaveLength(1);
    });

    it("いまと同じ寸法のresizeでは、screencastを始め直さない", async () => {
      const cdp = fakeCdp();
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      // 丸めた結果が既定の1280x900と同じになる
      viewer.receive({
        t: "resize",
        width: 1280.3,
        height: 900,
        dpr: 0.5,
        mobile: false,
      });
      await vi.advanceTimersByTimeAsync(150);
      expect(cdp.count("Emulation.setDeviceMetricsOverride")).toBe(1);
      expect(cdp.count("Page.stopScreencast")).toBe(0);
      expect(cdp.count("Page.startScreencast")).toBe(1);
      const resize = {
        t: "resize",
        width: 500,
        height: 500,
        dpr: 1,
        mobile: false,
      };
      viewer.receive(resize);
      await vi.advanceTimersByTimeAsync(150);
      expect(cdp.count("Page.startScreencast")).toBe(2);
      viewer.receive(resize);
      await vi.advanceTimersByTimeAsync(150);
      expect(cdp.count("Emulation.setDeviceMetricsOverride")).toBe(2);
      expect(cdp.count("Page.startScreencast")).toBe(2);
    });
  });

  describe("ビューポートの通知", () => {
    const sized = (
      id: number,
      width: number,
      height: number,
      dots: Array<[number, number]> = []
    ) =>
      monitorFrame(id, {
        size: { width: Math.ceil(width / 8), height: Math.ceil(height / 8) },
        metadata: { deviceWidth: width, deviceHeight: height },
        dots,
      });
    const resize = (width: number, height: number) => ({
      t: "resize",
      width,
      height,
      dpr: 1,
      mobile: false,
    });

    it("入った視聴者へ、フレームが無くても当てた寸法を世代つきで知らせる", async () => {
      const cdp = fakeCdp();
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      expect(viewer.send.mock.calls).toEqual([
        [viewportBody(1280, 900, 1)],
        [ONE_TAB_BODY],
      ]);
    });

    it("最初の監視フレームで、寸法、鮮明な全画面の順に届く", async () => {
      const cdp = fakeCdp();
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      cdp.emit("Page.screencastFrame", monitorFrame(1));
      await flush();
      expect(cdp.captures()).toEqual([
        {
          format: "jpeg",
          quality: 80,
          clip: { ...FULL_RECT, scale: 1 },
          captureBeyondViewport: false,
          optimizeForSpeed: true,
        },
      ]);
      expect(cdp.last(CAPTURE)?.sessionId).toBe("S1");
      expect(viewer.send.mock.calls).toEqual([
        [viewportBody(1280, 900, 1)],
        [ONE_TAB_BODY],
        [expect.any(Buffer)],
      ]);
      expect(viewer.shots()).toEqual([
        { kind: 1, gen: 1, rect: FULL_RECT, image: "shot-1" },
      ]);
    });

    it("メタデータの寸法が当てた寸法と違う監視フレームは、ackだけ返して使わない", async () => {
      const { cdp, viewer } = await started();
      cdp.emit("Page.screencastFrame", sized(2, 390, 700));
      await vi.advanceTimersByTimeAsync(1000);
      expect(cdp.last("Page.screencastFrameAck")?.params).toEqual({
        sessionId: 2,
      });
      expect(cdp.count(CAPTURE)).toBe(0);
      expect(viewer.send).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      // 世代もビューポートも変わっていない。次の変化は、同じ世代の矩形で届く
      cdp.emit("Page.screencastFrame", monitorFrame(3, { dots: [[10, 10]] }));
      await flush();
      expect(viewer.texts()).toEqual([]);
      expect(viewer.shots()).toMatchObject([
        { kind: 3, gen: 1, rect: { x: 72, y: 71, width: 24, height: 25 } },
      ]);
    });

    it("矩形を取り直している間に出る、その矩形の寸法の監視フレームでは、何も取り直さない", async () => {
      const { cdp, viewer } = await started();
      cdp.emit("Page.screencastFrame", sized(2, 1280, 900, [[10, 10]]));
      await flush();
      expect(cdp.captures().map(c => c.clip)).toEqual([
        { x: 72, y: 71, width: 24, height: 25, scale: 1 },
      ]);
      // 取り直しの間、Chromiumは画面を取り直す範囲の寸法にし、その画のフレームを出す
      cdp.emit(
        "Page.screencastFrame",
        monitorFrame(3, {
          size: { width: 3, height: 3 },
          rgb: BLACK,
          metadata: { deviceWidth: 24, deviceHeight: 25 },
        })
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(cdp.count("Page.screencastFrameAck")).toBe(2);
      expect(cdp.count(CAPTURE)).toBe(1);
      expect(viewer.texts()).toEqual([]);
      expect(viewer.shots()).toMatchObject([{ kind: 3, gen: 1 }]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("寸法が変わらない間は知らせ直さない", async () => {
      const cdp = fakeCdp();
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      cdp.emit("Page.screencastFrame", sized(1, 1280, 900));
      await flush();
      cdp.emit("Page.screencastFrame", sized(2, 1280, 900));
      await flush();
      // 入ったときの1回だけ。当てた寸法とフレームの寸法が同じなら、世代も進まない
      expect(textsOf(viewer, "viewport")).toEqual([
        { t: "viewport", width: 1280, height: 900, gen: 1 },
      ]);
      expect(viewer.shots().map(shot => shot.gen)).toEqual([1]);
    });

    it("メタデータの寸法が読めないフレームも使い、世代は進めない", async () => {
      const { cdp, viewer } = await started();
      cdp.emit(
        "Page.screencastFrame",
        monitorFrame(2, {
          dots: [[10, 10]],
          metadata: { deviceWidth: Number.NaN, deviceHeight: "700" },
        })
      );
      await flush();
      expect(viewer.texts()).toEqual([]);
      expect(viewer.shots()).toMatchObject([
        { kind: 3, gen: 1, rect: { x: 72, y: 71, width: 24, height: 25 } },
      ]);
    });

    it("resizeで世代が増え、新しい寸法を新しい世代のフレームより先に知らせる", async () => {
      const { cdp, viewer } = await started();
      viewer.receive({
        t: "resize",
        width: 390,
        height: 700,
        dpr: 2,
        mobile: true,
      });
      await vi.advanceTimersByTimeAsync(150);
      expect(viewer.send).not.toHaveBeenCalled();
      // メタデータの無い監視フレーム。当てた寸法を使う
      cdp.emit(
        "Page.screencastFrame",
        monitorFrame(2, { size: { width: 49, height: 88 } })
      );
      await flush();
      expect(viewer.send.mock.calls).toEqual([
        [viewportBody(390, 700, 2)],
        [expect.any(Buffer)],
      ]);
      expect(viewer.shots()).toMatchObject([
        { kind: 1, gen: 2, rect: { x: 0, y: 0, width: 390, height: 700 } },
      ]);
    });

    it("resizeの前に始めた取り直しの結果は、古い世代のまま送らない", async () => {
      const { cdp, viewer } = await started();
      cdp.holdOn(CAPTURE);
      cdp.emit("Page.screencastFrame", monitorFrame(2, { dots: [[10, 10]] }));
      await flush();
      viewer.receive({
        t: "resize",
        width: 390,
        height: 700,
        dpr: 1,
        mobile: false,
      });
      await vi.advanceTimersByTimeAsync(150);
      cdp.release(CAPTURE);
      await flush();
      expect(viewer.send).not.toHaveBeenCalled();
    });

    it("あとから入った視聴者へ、全画面より先に知らせる", async () => {
      const { cdp, bridge, viewer } = await started();
      viewer.receive(resize(390, 700));
      await vi.advanceTimersByTimeAsync(150);
      cdp.emit("Page.screencastFrame", sized(2, 390, 700));
      await flush();
      const late = fakeViewer();
      bridge.attach(late);
      await flush();
      expect(late.send.mock.calls).toEqual([
        [viewportBody(390, 700, 2)],
        [ONE_TAB_BODY],
        [expect.any(Buffer)],
      ]);
      expect(late.shots()).toMatchObject([{ kind: 1, gen: 2 }]);
    });

    it("詰まっていた視聴者は、空いたときに全画面より先に寸法を受け取る", async () => {
      const cdp = fakeCdp();
      const bridge = new BrowserCdpBridge(async () => cdp);
      const fast = fakeViewer();
      const slow = fakeViewer();
      bridge.attach(fast);
      bridge.attach(slow);
      await flush();
      slow.send.mockClear();
      slow.bufferedAmount = 2_000_000;
      fast.receive(resize(390, 700));
      await vi.advanceTimersByTimeAsync(150);
      cdp.emit("Page.screencastFrame", sized(1, 390, 700));
      await flush();
      fast.receive(resize(640, 480));
      await vi.advanceTimersByTimeAsync(150);
      cdp.emit("Page.screencastFrame", sized(2, 640, 480));
      await flush();
      expect(slow.send).not.toHaveBeenCalled();
      slow.bufferedAmount = 0;
      await vi.advanceTimersByTimeAsync(50);
      // 途中の寸法は飛ばす。受け取るフレームの寸法だけを知らせる
      expect(slow.send.mock.calls).toEqual([
        [viewportBody(640, 480, 3)],
        [expect.any(Buffer)],
      ]);
      expect(slow.shots()).toMatchObject([{ kind: 1, gen: 3 }]);
      expect(textsOf(fast, "viewport")).toEqual([
        { t: "viewport", width: 1280, height: 900, gen: 1 },
        { t: "viewport", width: 390, height: 700, gen: 2 },
        { t: "viewport", width: 640, height: 480, gen: 3 },
      ]);
      expect(fast.shots().map(shot => shot.gen)).toEqual([2, 3]);
    });

    it("入ったときの通知が投げた視聴者は外し、screencastを始めない", async () => {
      const cdp = fakeCdp();
      const bridge = new BrowserCdpBridge(async () => cdp);
      const broken = fakeViewer();
      broken.send.mockImplementation(() => {
        throw new Error("send failed");
      });
      bridge.attach(broken);
      await flush();
      expect(broken.terminate).toHaveBeenCalled();
      expect(bridge.viewerCount).toBe(0);
      expect(cdp.count("Page.startScreencast")).toBe(0);
    });
  });

  describe("視聴者への送信が投げたとき", () => {
    const boom = () => {
      throw new Error("send failed");
    };

    it("フレームは残りの視聴者へ送り、投げた視聴者だけを外す", async () => {
      const cdp = fakeCdp();
      const bridge = new BrowserCdpBridge(async () => cdp);
      const broken = fakeViewer();
      const healthy = fakeViewer();
      bridge.attach(broken);
      bridge.attach(healthy);
      await flush();
      broken.send.mockImplementation(boom);
      cdp.emit("Page.screencastFrame", monitorFrame(1));
      await flush();
      expect(healthy.kinds()).toEqual([1]);
      expect(cdp.count("Page.screencastFrameAck")).toBe(1);
      expect(broken.terminate).toHaveBeenCalled();
      expect(bridge.viewerCount).toBe(1);
      expect(cdp.count("Page.stopScreencast")).toBe(0);
    });

    it("最後の視聴者が投げたら、screencastを止める", async () => {
      const cdp = fakeCdp();
      const bridge = new BrowserCdpBridge(async () => cdp);
      const broken = fakeViewer();
      bridge.attach(broken);
      await flush();
      broken.send.mockImplementation(boom);
      cdp.emit("Page.screencastFrame", monitorFrame(1));
      await flush();
      expect(broken.terminate).toHaveBeenCalled();
      expect(bridge.viewerCount).toBe(0);
      expect(cdp.count("Page.stopScreencast")).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("切断の通知は、残りの視聴者へ届ける", async () => {
      const cdp = fakeCdp();
      const bridge = new BrowserCdpBridge(async () => cdp);
      const broken = fakeViewer();
      const healthy = fakeViewer();
      bridge.attach(broken);
      bridge.attach(healthy);
      await flush();
      broken.send.mockImplementation(boom);
      expect(() => cdp.disconnect()).not.toThrow();
      expect(broken.terminate).toHaveBeenCalled();
      expect(healthy.send).toHaveBeenCalledWith(ERROR_BODY);
      expect(healthy.close).toHaveBeenCalledWith(1011, expect.any(String));
      expect(bridge.viewerCount).toBe(0);
    });
  });
  describe("差分転送", () => {
    const frames = (cdp: ReturnType<typeof fakeCdp>) => ({
      dots: (id: number, dots: Array<[number, number]>) =>
        cdp.emit("Page.screencastFrame", monitorFrame(id, { dots })),
      fill: (id: number, rgb: Rgb) =>
        cdp.emit("Page.screencastFrame", monitorFrame(id, { rgb })),
    });

    it("小さな変化は、広げた矩形だけを取り直して送る", async () => {
      const { cdp, viewer } = await started();
      frames(cdp).dots(2, [[80, 56]]);
      await flush();
      const rect = { x: 632, y: 438, width: 24, height: 24 };
      expect(cdp.captures()).toEqual([
        {
          format: "jpeg",
          quality: 80,
          clip: { ...rect, scale: 1 },
          captureBeyondViewport: false,
          optimizeForSpeed: true,
        },
      ]);
      expect(viewer.send.mock.calls).toHaveLength(1);
      expect(viewer.shots()).toEqual([
        { kind: 3, gen: 1, rect, image: "shot-2" },
      ]);
    });

    it("面積の大きい矩形も矩形のまま取り直す", async () => {
      const { cdp, viewer } = await started();
      frames(cdp).dots(2, block(20, 20, 60, 40));
      await flush();
      const rect = { x: 152, y: 151, width: 496, height: 335 };
      expect(cdp.captures()).toMatchObject([
        { format: "jpeg", quality: 80, clip: { ...rect, scale: 1 } },
      ]);
      expect(viewer.shots()).toMatchObject([{ kind: 3, rect }]);
    });

    it("離れた2か所の変化は、2回取り直して順に送る", async () => {
      const { cdp, viewer } = await started();
      frames(cdp).dots(2, [
        [10, 10],
        [150, 100],
      ]);
      await flush();
      const rects = [
        { x: 72, y: 71, width: 24, height: 25 },
        { x: 1192, y: 788, width: 24, height: 25 },
      ];
      expect(cdp.captures().map(c => c.clip)).toEqual(
        rects.map(rect => ({ ...rect, scale: 1 }))
      );
      expect(viewer.shots()).toEqual([
        { kind: 3, gen: 1, rect: rects[0], image: "shot-2" },
        { kind: 3, gen: 1, rect: rects[1], image: "shot-3" },
      ]);
    });

    it("取り直しの最中に来た変化は、終わってから1回にまとめて取り直す", async () => {
      const { cdp, viewer } = await started();
      cdp.holdOn(CAPTURE);
      frames(cdp).dots(2, [[10, 10]]);
      await flush();
      expect(cdp.count(CAPTURE)).toBe(1);
      frames(cdp).dots(3, [
        [10, 10],
        [100, 80],
      ]);
      frames(cdp).dots(4, [
        [10, 10],
        [100, 80],
        [102, 80],
      ]);
      await vi.advanceTimersByTimeAsync(200);
      // 同時に2本は走らせない
      expect(cdp.count(CAPTURE)).toBe(1);
      cdp.release(CAPTURE);
      await flush();
      expect(cdp.captures().map(c => c.clip)).toEqual([
        { x: 72, y: 71, width: 24, height: 25, scale: 1 },
        { x: 792, y: 629, width: 40, height: 25, scale: 1 },
      ]);
      cdp.release(CAPTURE);
      await flush();
      expect(viewer.kinds()).toEqual([3, 3]);
      expect(cdp.count(CAPTURE)).toBe(2);
    });

    it("変化が広いと鮮明な全画面になり、すぐまた全面が変わると粗い全画面になる", async () => {
      const { cdp, viewer } = await started();
      frames(cdp).dots(2, block(0, 0, 160, 60));
      await flush();
      expect(cdp.captures()).toMatchObject([
        { format: "jpeg", quality: 80, clip: { ...FULL_RECT, scale: 1 } },
      ]);
      frames(cdp).fill(3, BLACK);
      await flush();
      expect(cdp.captures()[1]).toMatchObject({
        format: "jpeg",
        quality: 50,
        clip: { ...FULL_RECT, scale: 0.5 },
      });
      expect(viewer.shots()).toMatchObject([
        { kind: 1, rect: FULL_RECT },
        { kind: 2, rect: FULL_RECT },
      ]);
    });

    it("粗い全画面の縮尺は、ページへ伝えている倍率で割る", async () => {
      const { cdp, viewer } = await started();
      viewer.receive({
        t: "resize",
        width: 1280,
        height: 900,
        dpr: 2,
        mobile: false,
      });
      await vi.advanceTimersByTimeAsync(150);
      frames(cdp).fill(2, WHITE);
      await flush();
      frames(cdp).fill(3, BLACK);
      await flush();
      expect(cdp.captures().map(c => c.clip.scale)).toEqual([1, 0.25]);
      expect(viewer.kinds()).toEqual([1, 2]);
    });

    it("粗い全画面は、最短の間隔より詰めて送らない", async () => {
      const { cdp, viewer } = await started();
      frames(cdp).fill(2, BLACK);
      await flush();
      frames(cdp).fill(3, WHITE);
      await flush();
      expect(viewer.kinds()).toEqual([1, 2]);
      frames(cdp).fill(4, BLACK);
      await vi.advanceTimersByTimeAsync(99);
      expect(cdp.count(CAPTURE)).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(cdp.count(CAPTURE)).toBe(3);
      expect(viewer.kinds()).toEqual([1, 2, 2]);
    });

    it("粗い全画面のあと静かになったら、鮮明な全画面を1枚送る", async () => {
      const { cdp, viewer } = await started();
      frames(cdp).fill(2, BLACK);
      await flush();
      frames(cdp).fill(3, WHITE);
      await vi.advanceTimersByTimeAsync(249);
      expect(viewer.kinds()).toEqual([1, 2]);
      await vi.advanceTimersByTimeAsync(1);
      expect(viewer.kinds()).toEqual([1, 2, 1]);
      expect(cdp.captures()[2]).toMatchObject({
        quality: 80,
        clip: { ...FULL_RECT, scale: 1 },
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(viewer.frames()).toHaveLength(3);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("refreshを送った視聴者にだけ、全画面を送り直す", async () => {
      const { cdp, viewers } = await started(2);
      const [asking, other] = viewers;
      asking.receive({ t: "refresh" });
      await flush();
      expect(asking.shots()).toMatchObject([{ kind: 1, rect: FULL_RECT }]);
      expect(other.frames()).toEqual([]);
      // 送り直しの依頼は入力ではない。CDPへ送るのは取り直しだけ
      expect(cdp.methods()).toEqual([CAPTURE]);
    });

    it("取り直しがrejectしても視聴者を切らず、次の機会に全画面を取り直す", async () => {
      const { cdp, bridge, viewer } = await started();
      cdp.failOn(CAPTURE);
      frames(cdp).dots(2, [[10, 10]]);
      await flush();
      expect(viewer.send).not.toHaveBeenCalled();
      expect(viewer.close).not.toHaveBeenCalled();
      expect(viewer.terminate).not.toHaveBeenCalled();
      expect(bridge.viewerCount).toBe(1);
      cdp.stopFailing(CAPTURE);
      await vi.advanceTimersByTimeAsync(50);
      expect(viewer.shots()).toMatchObject([{ kind: 1, rect: FULL_RECT }]);
      expect(cdp.captures().at(-1)?.clip).toEqual({ ...FULL_RECT, scale: 1 });
    });

    it("取り直しが返らなければ時間で諦め、全画面を取り直す。遅れた結果は送らない", async () => {
      const { cdp, bridge, viewer } = await started();
      cdp.holdOn(CAPTURE);
      frames(cdp).dots(2, [[10, 10]]);
      await vi.advanceTimersByTimeAsync(2999);
      expect(cdp.count(CAPTURE)).toBe(1);
      await vi.advanceTimersByTimeAsync(1 + 50);
      expect(cdp.count(CAPTURE)).toBe(2);
      expect(cdp.captures()[1].clip).toEqual({ ...FULL_RECT, scale: 1 });
      expect(bridge.viewerCount).toBe(1);
      // 諦めた1回目が返っても送らない
      cdp.release(CAPTURE);
      await flush();
      expect(viewer.frames()).toEqual([]);
      cdp.release(CAPTURE);
      await flush();
      expect(viewer.shots()).toMatchObject([{ kind: 1, image: "shot-3" }]);
    });

    it("視聴者が0人になったら、進行中の取り直しの結果を送らず、タイマーも残さない", async () => {
      const { cdp, viewer } = await started();
      cdp.holdOn(CAPTURE);
      frames(cdp).fill(2, BLACK);
      await flush();
      expect(cdp.count(CAPTURE)).toBe(1);
      viewer.emit("close");
      expect(vi.getTimerCount()).toBe(0);
      cdp.release(CAPTURE);
      await vi.advanceTimersByTimeAsync(5000);
      expect(viewer.send).not.toHaveBeenCalled();
      expect(cdp.count(CAPTURE)).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("古い接続の取り直しが遅れて返っても、つなぎ直した接続の視聴者へ送らない", async () => {
      const first = fakeCdp();
      const second = fakeCdp();
      const connect = vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second);
      const bridge = new BrowserCdpBridge(connect);
      first.holdOn(CAPTURE);
      bridge.attach(fakeViewer());
      await flush();
      first.emit("Page.screencastFrame", monitorFrame(1));
      await flush();
      expect(first.count(CAPTURE)).toBe(1);
      bridge.reset();
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      second.emit("Page.screencastFrame", monitorFrame(1));
      await flush();
      expect(viewer.frames()).toHaveLength(1);
      // 古い接続で待っていた取り直しは、離れるときに片づけてある
      expect(first.rejected()).toEqual(["S1"]);
      await flush();
      expect(viewer.frames()).toHaveLength(1);
      expect(second.count(CAPTURE)).toBe(1);
    });

    it("CDPが切れて取り直しが失敗しても、タイマーを残さない", async () => {
      const { cdp, viewer } = await started();
      cdp.holdOn(CAPTURE);
      frames(cdp).dots(2, [[10, 10]]);
      await flush();
      cdp.disconnect();
      await flush();
      expect(viewer.send).toHaveBeenCalledWith(ERROR_BODY);
      expect(viewer.frames()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("復号できない監視フレームは、全面の変化として扱う", async () => {
      const { cdp, viewer } = await started();
      cdp.emit("Page.screencastFrame", {
        data: Buffer.from("not a png").toString("base64"),
        sessionId: 2,
      });
      expect(cdp.count("Page.screencastFrameAck")).toBe(1);
      await flush();
      expect(cdp.captures().map(c => c.clip)).toEqual([
        { ...FULL_RECT, scale: 1 },
      ]);
      expect(viewer.kinds()).toEqual([1]);
    });
  });

  describe("メタデータ", () => {
    const framed = (
      id: number,
      metadata: unknown,
      dots: Array<[number, number]> = []
    ) => monitorFrame(id, { metadata, dots });

    it("スクロールした位置を取り直しの位置に足し、ヘッダには足さない", async () => {
      const { cdp, viewer } = await started();
      const metadata = {
        offsetTop: 0,
        pageScaleFactor: 1,
        deviceWidth: 1280,
        deviceHeight: 900,
        scrollOffsetX: 0,
        scrollOffsetY: 300,
      };
      cdp.emit("Page.screencastFrame", framed(2, metadata, [[80, 56]]));
      await flush();
      const rect = { x: 632, y: 438, width: 24, height: 24 };
      expect(cdp.captures().map(c => c.clip)).toEqual([
        { ...rect, y: rect.y + 300, scale: 1 },
      ]);
      expect(viewer.shots()).toMatchObject([{ kind: 3, rect }]);
    });

    it("つなぎ直したら、前の接続でスクロールした位置を使わない", async () => {
      const first = fakeCdp();
      const second = fakeCdp();
      const connect = vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second);
      const bridge = new BrowserCdpBridge(connect);
      bridge.attach(fakeViewer());
      await flush();
      first.emit(
        "Page.screencastFrame",
        framed(1, { scrollOffsetX: 0, scrollOffsetY: 300 })
      );
      await flush();
      expect(first.captures()[0].clip).toEqual({
        ...FULL_RECT,
        y: 300,
        scale: 1,
      });
      first.disconnect();
      bridge.attach(fakeViewer());
      await flush();
      second.emit("Page.screencastFrame", monitorFrame(1));
      await flush();
      expect(second.captures().map(c => c.clip)).toEqual([
        { ...FULL_RECT, scale: 1 },
      ]);
    });

    it("寸法は整数に丸めてから、当てた寸法と比べる", async () => {
      const { cdp, viewer } = await started();
      // 丸めると1280x900。当てた寸法のフレームとして使う
      cdp.emit(
        "Page.screencastFrame",
        framed(2, { deviceWidth: 1279.6, deviceHeight: 899.5 }, [[80, 56]])
      );
      await flush();
      expect(viewer.shots()).toMatchObject([{ kind: 3, gen: 1 }]);
      // 丸めると1280x901。当てた寸法と違うので使わない
      cdp.emit(
        "Page.screencastFrame",
        framed(3, { deviceWidth: 1280.4, deviceHeight: 900.6 })
      );
      await flush();
      expect(cdp.count(CAPTURE)).toBe(1);
      expect(viewer.texts()).toEqual([]);
    });

    it("1に満たない寸法は使わず、最後に当てた寸法を使う", async () => {
      const { cdp, viewer } = await started();
      cdp.emit(
        "Page.screencastFrame",
        framed(2, { deviceWidth: 0.6, deviceHeight: 900 }, [[80, 56]])
      );
      cdp.emit(
        "Page.screencastFrame",
        framed(3, { deviceWidth: 1280, deviceHeight: -900 })
      );
      await flush();
      // 寸法は変わっていない扱い。世代は進まず、矩形だけが届く (点が出たときと消えたとき)
      expect(viewer.texts()).toEqual([]);
      expect(viewer.shots()).toMatchObject([
        { kind: 3, gen: 1 },
        { kind: 3, gen: 1 },
      ]);
    });
  });

  describe("resizeの直後", () => {
    const sized = (id: number, width: number, height: number) =>
      monitorFrame(id, {
        size: { width: Math.ceil(width / 8), height: Math.ceil(height / 8) },
        metadata: { deviceWidth: width, deviceHeight: height },
      });

    async function resized() {
      const s = await started();
      // 始め直しの応答が返る前に、止めたscreencastのフレームが届く
      s.cdp.holdOn("Page.stopScreencast");
      s.cdp.holdOn("Page.startScreencast");
      s.viewer.receive({
        t: "resize",
        width: 390,
        height: 700,
        dpr: 1,
        mobile: false,
      });
      await vi.advanceTimersByTimeAsync(150);
      return s;
    }

    it("止めたscreencastの遅れたフレームは使わず、ackだけ返す", async () => {
      const { cdp, viewer } = await resized();
      cdp.emit("Page.screencastFrame", sized(7, 1280, 900));
      await flush();
      expect(cdp.last("Page.screencastFrameAck")?.params).toEqual({
        sessionId: 7,
      });
      expect(cdp.count(CAPTURE)).toBe(0);
      expect(viewer.send).not.toHaveBeenCalled();
      // 当てた寸法のフレームは使う。世代はresizeで1つ進んだだけ
      cdp.emit("Page.screencastFrame", sized(8, 390, 700));
      cdp.release("Page.stopScreencast");
      cdp.release("Page.startScreencast");
      await flush();
      expect(viewer.send.mock.calls).toEqual([
        [viewportBody(390, 700, 2)],
        [expect.any(Buffer)],
      ]);
      expect(cdp.captures().map(c => c.clip)).toEqual([
        { x: 0, y: 0, width: 390, height: 700, scale: 1 },
      ]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("当てた寸法のフレームを見たあとも、メタデータの寸法が違うフレームは使わない", async () => {
      const { cdp, viewer } = await resized();
      cdp.emit("Page.screencastFrame", sized(7, 390, 700));
      await flush();
      cdp.emit("Page.screencastFrame", sized(8, 400, 700));
      await vi.advanceTimersByTimeAsync(1000);
      expect(cdp.count(CAPTURE)).toBe(1);
      expect(viewer.texts()).toEqual([
        { t: "viewport", width: 390, height: 700, gen: 2 },
      ]);
      expect(viewer.kinds()).toEqual([1]);
    });

    it("メタデータの寸法が読めないフレームは、当てた寸法のものとして使う", async () => {
      const { cdp, viewer } = await resized();
      cdp.emit(
        "Page.screencastFrame",
        monitorFrame(7, { size: { width: 49, height: 88 } })
      );
      await flush();
      expect(viewer.shots()).toMatchObject([
        { kind: 1, gen: 2, rect: { x: 0, y: 0, width: 390, height: 700 } },
      ]);
    });

    it("止めたscreencastの遅れたフレームは、どれだけ時間がたっても使わない", async () => {
      const { cdp, viewer } = await resized();
      cdp.emit("Page.screencastFrame", sized(7, 1280, 900));
      await vi.advanceTimersByTimeAsync(5000);
      cdp.emit("Page.screencastFrame", sized(8, 1280, 900));
      await flush();
      expect(cdp.count("Page.screencastFrameAck")).toBe(2);
      expect(cdp.count(CAPTURE)).toBe(0);
      expect(viewer.send).not.toHaveBeenCalled();
      cdp.emit("Page.screencastFrame", sized(9, 390, 700));
      await flush();
      expect(viewer.shots()).toMatchObject([
        { kind: 1, gen: 2, rect: { x: 0, y: 0, width: 390, height: 700 } },
      ]);
    });

    it("寸法を当てられず、違う寸法のフレームだけが30枚続いたら、1回だけ記録して使い始める", async () => {
      const s = await started();
      s.cdp.failOn("Emulation.setDeviceMetricsOverride");
      s.viewer.receive({
        t: "resize",
        width: 390,
        height: 700,
        dpr: 1,
        mobile: false,
      });
      await vi.advanceTimersByTimeAsync(150);
      const mismatchWarnings = () =>
        vi
          .mocked(console.warn)
          .mock.calls.filter(([message]) =>
            String(message).includes("1280x900")
          );
      for (let id = 1; id <= 29; id++) {
        s.cdp.emit("Page.screencastFrame", sized(id, 1280, 900));
      }
      await flush();
      expect(s.cdp.count("Page.screencastFrameAck")).toBe(29);
      expect(s.cdp.count(CAPTURE)).toBe(0);
      expect(mismatchWarnings()).toHaveLength(0);
      s.cdp.emit("Page.screencastFrame", sized(30, 1280, 900));
      s.cdp.emit("Page.screencastFrame", sized(31, 1280, 900));
      await flush();
      expect(mismatchWarnings()).toHaveLength(1);
      expect(String(mismatchWarnings()[0][0])).toContain("390x700");
      // ビューポートは当てようとした寸法のまま。フレームの寸法には合わせない
      expect(s.viewer.texts()).toEqual([
        { t: "viewport", width: 390, height: 700, gen: 2 },
      ]);
      expect(s.viewer.shots()).toMatchObject([
        { kind: 1, gen: 2, rect: { x: 0, y: 0, width: 390, height: 700 } },
      ]);
    });

    it("寸法を見ずに使い始めても、screencastを始め直したら見直す", async () => {
      const { cdp, viewer } = await resized();
      for (let id = 1; id <= 30; id++) {
        cdp.emit("Page.screencastFrame", sized(id, 1280, 900));
      }
      await flush();
      expect(cdp.count(CAPTURE)).toBe(1);
      viewer.receive({
        t: "resize",
        width: 640,
        height: 480,
        dpr: 1,
        mobile: false,
      });
      await vi.advanceTimersByTimeAsync(150);
      cdp.emit("Page.screencastFrame", sized(31, 1280, 900));
      await vi.advanceTimersByTimeAsync(1000);
      expect(cdp.count(CAPTURE)).toBe(1);
      cdp.emit("Page.screencastFrame", sized(32, 640, 480));
      await flush();
      expect(cdp.captures().at(-1)?.clip).toEqual({
        x: 0,
        y: 0,
        width: 640,
        height: 480,
        scale: 1,
      });
    });
  });

  describe("ダイアログ", () => {
    const OPENING = "Page.javascriptDialogOpening";
    const CLOSED = "Page.javascriptDialogClosed";
    const opening = { type: "alert", message: "hi", url: "about:blank" };

    it("開いているあいだは取り直さず、閉じたら全画面を取り直す", async () => {
      const { cdp, bridge, viewer } = await started();
      cdp.emit(OPENING, opening);
      cdp.emit("Page.screencastFrame", monitorFrame(2, { dots: [[10, 10]] }));
      viewer.receive({ t: "refresh" });
      const late = fakeViewer();
      bridge.attach(late);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(cdp.count(CAPTURE)).toBe(0);
      // 監視フレームのackは止めない
      expect(cdp.count("Page.screencastFrameAck")).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      cdp.emit(CLOSED, { result: true, userInput: "" });
      await flush();
      expect(cdp.captures().map(c => c.clip)).toEqual([
        { ...FULL_RECT, scale: 1 },
      ]);
      expect(viewer.kinds()).toEqual([1]);
      expect(late.kinds()).toEqual([1]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("別のsessionのダイアログは無視する", async () => {
      const { cdp, viewer } = await started();
      cdp.emit(OPENING, opening, "S-other");
      cdp.emitBrowser(OPENING, opening);
      cdp.emit("Page.screencastFrame", monitorFrame(2, { dots: [[10, 10]] }));
      await flush();
      expect(viewer.kinds()).toEqual([3]);
    });

    it("開いたときに走っていた取り直しは時間切れに任せ、試し直さない", async () => {
      const { cdp, viewer } = await started();
      cdp.holdOn(CAPTURE);
      cdp.emit("Page.screencastFrame", monitorFrame(2, { dots: [[10, 10]] }));
      await flush();
      cdp.emit(OPENING, opening);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(cdp.count(CAPTURE)).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      cdp.stopHolding(CAPTURE);
      cdp.emit(CLOSED, { result: true, userInput: "" });
      await flush();
      expect(cdp.count(CAPTURE)).toBe(2);
      expect(viewer.kinds()).toEqual([1]);
    });

    it("視聴者が居なくなって戻っても、開いているあいだは取り直さない", async () => {
      const { cdp, bridge, viewer } = await started();
      cdp.emit(OPENING, opening);
      viewer.emit("close");
      const back = fakeViewer();
      bridge.attach(back);
      await flush();
      cdp.emit("Page.screencastFrame", monitorFrame(2));
      await vi.advanceTimersByTimeAsync(5000);
      expect(cdp.count(CAPTURE)).toBe(0);
      cdp.emit(CLOSED, { result: true, userInput: "" });
      await flush();
      expect(back.kinds()).toEqual([1]);
    });

    it("接続が切れたら、開いていたことを忘れる", async () => {
      const first = fakeCdp();
      const second = fakeCdp();
      const connect = vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second);
      const bridge = new BrowserCdpBridge(connect);
      bridge.attach(fakeViewer());
      await flush();
      first.emit(OPENING, opening);
      first.disconnect();
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      second.emit("Page.screencastFrame", monitorFrame(1));
      await flush();
      expect(viewer.kinds()).toEqual([1]);
      // 捨てた接続から遅れて届いたダイアログは、いまの接続に響かない
      first.emit(OPENING, opening);
      second.emit(
        "Page.screencastFrame",
        monitorFrame(2, { dots: [[10, 10]] })
      );
      await flush();
      expect(viewer.kinds()).toEqual([1, 3]);
    });
  });
});

const HISTORY = "Page.getNavigationHistory";
const NAVIGATED = "Page.frameNavigated";
const A_URL = "http://localhost:3000/a";
const B_URL = "http://localhost:3000/b";
const C_URL = "http://localhost:3000/c";
/** Arkが遷移させない、履歴のエントリのURL */
const REFUSED_URL = "chrome-error://chromewebdata/";
/** ホストがlocalhostでない、遷移させてよいURL */
const EXTERNAL_URL = "https://example.com/";

/** `urls` を順にたどり、いま `currentIndex` 番目にいる履歴。エントリのidは10、11、... */
function historyOf(currentIndex: number, urls: string[]) {
  return {
    currentIndex,
    entries: urls.map((url, i) => ({ id: 10 + i, url, title: `T${i}` })),
  };
}

function pageBody(
  url: string,
  title: string,
  extra: { loading?: boolean; canGoBack?: boolean; canGoForward?: boolean } = {}
) {
  return {
    t: "page",
    url,
    title,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    ...extra,
  };
}

/** 視聴者が受け取ったJSONのうち、種類が `t` のもの */
function textsOf(viewer: ReturnType<typeof fakeViewer>, t: string) {
  return viewer.texts().filter(m => (m as { t?: unknown }).t === t);
}

/** メインフレーム (ターゲットと同じid) の遷移のイベント */
function navigatedTo(url: string) {
  return { frame: { id: "T1", url } };
}

/**
 * `started` と同じだが、ページの状態 (`urls` の `currentIndex` 番目) が分かっている。
 */
async function startedOn(currentIndex: number, urls: string[], count = 1) {
  const cdp = fakeCdp();
  cdp.answer(HISTORY, historyOf(currentIndex, urls));
  const bridge = new BrowserCdpBridge(async () => cdp);
  const viewers = Array.from({ length: count }, () => fakeViewer());
  for (const viewer of viewers) bridge.attach(viewer);
  await flush();
  cdp.emit("Page.screencastFrame", monitorFrame(1));
  await vi.advanceTimersByTimeAsync(1000);
  for (const viewer of viewers) viewer.send.mockClear();
  cdp.forget();
  return { cdp, bridge, viewers, viewer: viewers[0] };
}

describe("BrowserCdpBridge: ページの操作", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    withoutPoll();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("ページの状態", () => {
    it("入った視聴者へ、寸法のあとにページの状態を知らせる", async () => {
      const cdp = fakeCdp();
      cdp.answer(HISTORY, historyOf(1, [A_URL, B_URL, C_URL]));
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      expect(cdp.last(HISTORY)).toEqual({ params: undefined, sessionId: "S1" });
      expect(viewer.texts()).toEqual([
        { t: "viewport", width: 1280, height: 900, gen: 1 },
        pageBody(B_URL, "T1", { canGoBack: true, canGoForward: true }),
        ONE_TAB,
      ]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("あとから入った視聴者にも、寸法のあとに知らせる。先にいた視聴者へは送り直さない", async () => {
      const { bridge, viewer } = await startedOn(0, [A_URL]);
      const late = fakeViewer();
      bridge.attach(late);
      await flush();
      expect(late.texts().map(m => (m as { t: string }).t)).toEqual([
        "viewport",
        "page",
        "tabs",
      ]);
      expect(late.texts()[1]).toEqual(pageBody(A_URL, "T0"));
      expect(viewer.texts()).toEqual([]);
    });

    it("履歴を読めなければ、ページの状態は知らせない", async () => {
      const cdp = fakeCdp();
      cdp.failOn(HISTORY);
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      expect(textsOf(viewer, "page")).toEqual([]);
      expect(viewer.close).not.toHaveBeenCalled();
    });

    it("遷移したらURLをすぐ知らせ、100ms後に履歴を1回読んでタイトルを知らせる", async () => {
      const { cdp, viewers } = await startedOn(0, [A_URL], 2);
      cdp.answer(HISTORY, historyOf(1, [A_URL, B_URL]));
      cdp.emit("Page.frameStartedLoading", { frameId: "T1" });
      cdp.emit(NAVIGATED, navigatedTo(B_URL));
      cdp.emit("Page.loadEventFired", { timestamp: 1 });
      cdp.emit("Page.frameStoppedLoading", { frameId: "T1" });
      for (const viewer of viewers) {
        expect(viewer.texts()).toEqual([
          pageBody(A_URL, "T0", { loading: true }),
          pageBody(B_URL, "T0", { loading: true }),
          pageBody(B_URL, "T0"),
        ]);
      }
      await vi.advanceTimersByTimeAsync(99);
      expect(cdp.count(HISTORY)).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(cdp.count(HISTORY)).toBe(1);
      for (const viewer of viewers) {
        expect(viewer.texts().at(-1)).toEqual(
          pageBody(B_URL, "T1", { canGoBack: true })
        );
      }
      expect(vi.getTimerCount()).toBe(0);
    });

    it("文書の中の遷移でも読み直す。読み込みの開始だけでは読み直さない", async () => {
      const { cdp, viewer } = await startedOn(0, [A_URL]);
      cdp.emit("Page.frameStartedLoading", { frameId: "T1" });
      await vi.advanceTimersByTimeAsync(200);
      expect(cdp.count(HISTORY)).toBe(0);
      cdp.emit("Page.navigatedWithinDocument", {
        frameId: "T1",
        url: `${A_URL}#x`,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(cdp.count(HISTORY)).toBe(1);
      expect(textsOf(viewer, "page").at(-2)).toMatchObject({
        url: `${A_URL}#x`,
      });
    });

    it("サブフレームと別のsessionのイベントでは、何も知らせず、読み直さない", async () => {
      const { cdp, viewer } = await startedOn(0, [A_URL]);
      cdp.emit(NAVIGATED, {
        frame: { id: "F-sub", parentId: "T1", url: B_URL },
      });
      cdp.emit("Page.frameStoppedLoading", { frameId: "F-sub" });
      cdp.emit(NAVIGATED, navigatedTo(B_URL), "S-other");
      cdp.emitBrowser(NAVIGATED, navigatedTo(B_URL));
      await vi.advanceTimersByTimeAsync(200);
      expect(viewer.texts()).toEqual([]);
      expect(cdp.count(HISTORY)).toBe(0);
    });

    it("履歴の読み直しが失敗したら前のタイトルを保ち、次のイベントで読み直す", async () => {
      const { cdp, viewer } = await startedOn(0, [A_URL]);
      cdp.failOn(HISTORY);
      cdp.emit(NAVIGATED, navigatedTo(B_URL));
      await vi.advanceTimersByTimeAsync(100);
      expect(viewer.texts()).toEqual([pageBody(B_URL, "T0")]);
      expect(vi.getTimerCount()).toBe(0);
      cdp.stopFailing(HISTORY);
      cdp.answer(HISTORY, historyOf(1, [A_URL, B_URL]));
      cdp.emit("Page.loadEventFired", { timestamp: 1 });
      await vi.advanceTimersByTimeAsync(100);
      expect(viewer.texts().at(-1)).toEqual(
        pageBody(B_URL, "T1", { canGoBack: true })
      );
    });

    it("遅れて返った古い読み直しは、新しい読み直しの結果を上書きしない", async () => {
      const { cdp, viewer } = await startedOn(0, [A_URL]);
      cdp.holdOn(HISTORY);
      cdp.answer(HISTORY, historyOf(1, [A_URL, B_URL]));
      cdp.emit(NAVIGATED, navigatedTo(B_URL));
      await vi.advanceTimersByTimeAsync(100);
      cdp.answer(HISTORY, historyOf(2, [A_URL, B_URL, C_URL]));
      cdp.emit(NAVIGATED, navigatedTo(C_URL));
      await vi.advanceTimersByTimeAsync(100);
      cdp.releaseNewest(HISTORY);
      await flush();
      cdp.release(HISTORY);
      await flush();
      expect(viewer.texts().at(-1)).toEqual(
        pageBody(C_URL, "T2", { canGoBack: true })
      );
    });

    it("読み直しを始めたあとに遷移したら、その結果は使わず、読み直す", async () => {
      const { cdp, viewer } = await startedOn(0, [A_URL]);
      cdp.holdOn(HISTORY);
      cdp.emit("Page.loadEventFired", { timestamp: 1 });
      await vi.advanceTimersByTimeAsync(100);
      expect(cdp.count(HISTORY)).toBe(1);
      cdp.answer(HISTORY, historyOf(1, [A_URL, B_URL]));
      cdp.emit(NAVIGATED, navigatedTo(B_URL));
      // 遷移より前に始めた読み直しが、いまごろ返る (いまのエントリは前のページ)
      cdp.release(HISTORY);
      await flush();
      expect(viewer.texts()).toEqual([pageBody(B_URL, "T0")]);
      cdp.stopHolding(HISTORY);
      await vi.advanceTimersByTimeAsync(100);
      expect(cdp.count(HISTORY)).toBe(2);
      expect(viewer.texts()).toEqual([
        pageBody(B_URL, "T0"),
        pageBody(B_URL, "T1", { canGoBack: true }),
      ]);
    });

    it("読み直しを始めたあとに文書の中で遷移しても、その結果は使わない", async () => {
      const { cdp, viewer } = await startedOn(0, [A_URL]);
      cdp.holdOn(HISTORY);
      cdp.emit("Page.loadEventFired", { timestamp: 1 });
      await vi.advanceTimersByTimeAsync(100);
      cdp.emit("Page.navigatedWithinDocument", {
        frameId: "T1",
        url: `${A_URL}#x`,
      });
      cdp.release(HISTORY);
      await flush();
      expect(viewer.texts()).toEqual([pageBody(`${A_URL}#x`, "T0")]);
    });

    it("読み直しを始めたあとの、URLを変えないイベントでは、その結果を使う", async () => {
      const { cdp, viewer } = await startedOn(0, [A_URL]);
      cdp.holdOn(HISTORY);
      cdp.answer(HISTORY, historyOf(1, [A_URL, B_URL]));
      cdp.emit(NAVIGATED, navigatedTo(B_URL));
      await vi.advanceTimersByTimeAsync(100);
      cdp.emit("Page.loadEventFired", { timestamp: 1 });
      cdp.release(HISTORY);
      await flush();
      expect(viewer.texts().at(-1)).toEqual(
        pageBody(B_URL, "T1", { canGoBack: true })
      );
    });

    it("つないで最初の読み直しが失敗したら、200ms、400ms、800ms後に読み直し、そこでやめる", async () => {
      const cdp = fakeCdp();
      cdp.failOn(HISTORY);
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      expect(cdp.count(HISTORY)).toBe(1);
      for (const [wait, count] of [
        [199, 1],
        [1, 2],
        [399, 2],
        [1, 3],
        [799, 3],
        [1, 4],
        [10_000, 4],
      ]) {
        await vi.advanceTimersByTimeAsync(wait);
        expect(cdp.count(HISTORY)).toBe(count);
      }
      // やめたあとも、次のイベントでは読み直す
      cdp.stopFailing(HISTORY);
      cdp.answer(HISTORY, historyOf(0, [A_URL]));
      cdp.emit("Page.loadEventFired", { timestamp: 1 });
      await vi.advanceTimersByTimeAsync(100);
      expect(textsOf(viewer, "page")).toEqual([pageBody(A_URL, "T0")]);
    });

    it("失敗した最初の読み直しは、イベントが無くても、読めたところで知らせる", async () => {
      const cdp = fakeCdp();
      cdp.failOn(HISTORY);
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      await vi.advanceTimersByTimeAsync(200);
      cdp.stopFailing(HISTORY);
      cdp.answer(HISTORY, historyOf(0, [A_URL]));
      await vi.advanceTimersByTimeAsync(400);
      expect(textsOf(viewer, "page")).toEqual([pageBody(A_URL, "T0")]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(cdp.count(HISTORY)).toBe(3);
    });

    it("失敗した読み直しをやり直す前にイベントが来たら、そちらの読み直しに任せる", async () => {
      const cdp = fakeCdp();
      cdp.failOn(HISTORY);
      const bridge = new BrowserCdpBridge(async () => cdp);
      bridge.attach(fakeViewer());
      await flush();
      cdp.emit("Page.loadEventFired", { timestamp: 1 });
      await vi.advanceTimersByTimeAsync(100);
      expect(cdp.count(HISTORY)).toBe(2);
      // イベントのあとの失敗から、また200msで始める
      await vi.advanceTimersByTimeAsync(199);
      expect(cdp.count(HISTORY)).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(cdp.count(HISTORY)).toBe(3);
    });

    it("一度読めたあとの失敗では、やり直さない", async () => {
      const { cdp } = await startedOn(0, [A_URL]);
      cdp.failOn(HISTORY);
      cdp.emit(NAVIGATED, navigatedTo(B_URL));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(cdp.count(HISTORY)).toBe(1);
    });

    it("resetしたら、失敗した読み直しのやり直しを消す", async () => {
      const cdp = fakeCdp();
      cdp.failOn(HISTORY);
      const bridge = new BrowserCdpBridge(async () => cdp);
      bridge.attach(fakeViewer());
      await flush();
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      bridge.reset();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("タブから離れたら、失敗した読み直しのやり直しを消す", async () => {
      const cdp = fakeCdp();
      cdp.failOn(HISTORY);
      const bridge = new BrowserCdpBridge(async () => cdp);
      bridge.attach(fakeViewer());
      await flush();
      // 移った先のタブでは読める
      cdp.stopFailing(HISTORY);
      cdp.emitBrowser("Target.detachedFromTarget", { sessionId: "S1" });
      cdp.emitBrowser("Target.targetDestroyed", { targetId: "T1" });
      await flush();
      expect(cdp.last(HISTORY)?.sessionId).toBe("S2");
      cdp.forget();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(cdp.count(HISTORY)).toBe(0);
    });

    it("視聴者が居ない間の遷移も追い、戻った視聴者へいまの状態を知らせる", async () => {
      const { cdp, bridge, viewer } = await startedOn(0, [A_URL]);
      viewer.emit("close");
      cdp.answer(HISTORY, historyOf(1, [A_URL, B_URL]));
      cdp.emit(NAVIGATED, navigatedTo(B_URL));
      await vi.advanceTimersByTimeAsync(100);
      const back = fakeViewer();
      bridge.attach(back);
      await flush();
      expect(textsOf(back, "page")).toEqual([
        pageBody(B_URL, "T1", { canGoBack: true }),
      ]);
    });

    it("接続が切れたら、読み直しの待ちを消し、前のページの状態を忘れる", async () => {
      const first = fakeCdp();
      first.answer(HISTORY, historyOf(0, [A_URL]));
      const second = fakeCdp();
      const connect = vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second);
      const bridge = new BrowserCdpBridge(connect);
      bridge.attach(fakeViewer());
      await flush();
      first.emit(NAVIGATED, navigatedTo(B_URL));
      expect(vi.getTimerCount()).toBe(1);
      first.disconnect();
      expect(vi.getTimerCount()).toBe(0);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      // 捨てた接続から遅れて届いた遷移は、いまの接続に響かない
      first.emit(NAVIGATED, navigatedTo(C_URL));
      await vi.advanceTimersByTimeAsync(200);
      expect(textsOf(viewer, "page")).toEqual([]);
      expect(second.count(HISTORY)).toBe(1);
    });

    it("resetしたら、読み直しの待ちを消す", async () => {
      const { cdp, bridge } = await startedOn(0, [A_URL]);
      cdp.emit(NAVIGATED, navigatedTo(B_URL));
      bridge.reset();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("タブから離れたあとに返った読み直しは使わない", async () => {
      const { cdp, viewer } = await startedOn(0, [A_URL]);
      cdp.holdOn(HISTORY);
      cdp.emit(NAVIGATED, navigatedTo(B_URL));
      await vi.advanceTimersByTimeAsync(100);
      viewer.send.mockClear();
      cdp.stopHolding(HISTORY);
      cdp.answer(HISTORY, historyOf(0, ["about:blank"]));
      // 前のタブの読み直しは、sessionが切り離されて失敗する。
      // 移った先のタブの状態として届かない
      cdp.emitBrowser("Target.detachedFromTarget", { sessionId: "S1" });
      cdp.emitBrowser("Target.targetDestroyed", { targetId: "T1" });
      await flush();
      expect(
        textsOf(viewer, "page").filter(
          m => (m as { url: string }).url !== "about:blank"
        )
      ).toEqual([]);
    });

    it("状態の通知が投げた視聴者だけを外し、残りへは届ける", async () => {
      const { cdp, viewers } = await startedOn(0, [A_URL], 2);
      viewers[0].send.mockImplementation(() => {
        throw new Error("send failed");
      });
      cdp.emit(NAVIGATED, navigatedTo(B_URL));
      expect(viewers[0].terminate).toHaveBeenCalled();
      expect(viewers[1].texts()).toEqual([pageBody(B_URL, "T0")]);
      await vi.advanceTimersByTimeAsync(100);
      expect(viewers[0].send).toHaveBeenCalledTimes(1);
    });
  });

  describe("遷移", () => {
    const NAVIGATE = "Page.navigate";
    const NOTICE = {
      t: "notice",
      message: "http://またはhttps://のURLだけを開けます",
    };

    it.each([
      ["127.0.0.1:3000/a", "http://127.0.0.1:3000/a"],
      ["  localhost/a  ", "http://localhost/a"],
      ["https://localhost:8443/", "https://localhost:8443/"],
      ["about:blank", "about:blank"],
      ["https://localhost", "https://localhost/"],
      ["LOCALHOST:3000", "http://localhost:3000/"],
      ["http://127.1/", "http://127.0.0.1/"],
      ["http://localhost\\@evil.com", "http://localhost/@evil.com"],
      ["http:localhost", "http://localhost/"],
      ["example.com", "http://example.com/"],
      ["https://example.com/a?b#c", "https://example.com/a?b#c"],
      ["192.168.1.10:8080", "http://192.168.1.10:8080/"],
    ])(
      "gotoの %s は、確かめたあとの形の %s へ遷移する",
      async (url, expected) => {
        const { cdp, viewer } = await started();
        viewer.receive({ t: "nav", type: "goto", url });
        expect(cdp.last(NAVIGATE)).toEqual({
          params: { url: expected },
          sessionId: "S1",
        });
        expect(viewer.texts()).toEqual([]);
      }
    );

    it.each([
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,x",
      "ftp://example.com/",
      "http://example.com@localhost/",
      "http://localhost@example.com/",
      "",
    ])("gotoの %s は遷移せず、送った視聴者にだけ理由を返す", async url => {
      const { cdp, viewers } = await started(2);
      viewers[0].receive({ t: "nav", type: "goto", url });
      await flush();
      expect(cdp.methods()).toEqual([]);
      expect(viewers[0].texts()).toEqual([NOTICE]);
      expect(viewers[1].texts()).toEqual([]);
      expect(viewers[0].close).not.toHaveBeenCalled();
    });

    it("backとforwardは、履歴の隣のエントリへ移る", async () => {
      const { cdp, viewer } = await startedOn(1, [A_URL, B_URL, C_URL]);
      viewer.receive({ t: "nav", type: "back" });
      await flush();
      expect(cdp.last("Page.navigateToHistoryEntry")).toEqual({
        params: { entryId: 10 },
        sessionId: "S1",
      });
      viewer.receive({ t: "nav", type: "forward" });
      await flush();
      expect(cdp.last("Page.navigateToHistoryEntry")).toEqual({
        params: { entryId: 12 },
        sessionId: "S1",
      });
      expect(cdp.count(HISTORY)).toBe(2);
    });

    it("履歴の端では、backもforwardも何もしない", async () => {
      const { cdp, viewer } = await startedOn(0, [A_URL]);
      viewer.receive({ t: "nav", type: "back" });
      viewer.receive({ t: "nav", type: "forward" });
      await flush();
      expect(cdp.methods()).toEqual([HISTORY, HISTORY]);
      expect(viewer.texts()).toEqual([]);
    });

    it("backとforwardの先が開いてよいURLでなければ移らず、送った視聴者にだけ理由を返す", async () => {
      const { cdp, viewers } = await startedOn(
        1,
        [REFUSED_URL, B_URL, REFUSED_URL],
        2
      );
      viewers[0].receive({ t: "nav", type: "back" });
      await flush();
      expect(viewers[0].texts()).toEqual([NOTICE]);
      viewers[0].receive({ t: "nav", type: "forward" });
      await flush();
      expect(viewers[0].texts()).toEqual([NOTICE, NOTICE]);
      expect(viewers[1].texts()).toEqual([]);
      expect(cdp.methods()).toEqual([HISTORY, HISTORY]);
    });

    it("backとforwardは、ホストがlocalhostでないエントリへも移る", async () => {
      const { cdp, viewer } = await startedOn(1, [
        EXTERNAL_URL,
        B_URL,
        EXTERNAL_URL,
      ]);
      viewer.receive({ t: "nav", type: "back" });
      await flush();
      expect(cdp.last("Page.navigateToHistoryEntry")?.params).toEqual({
        entryId: 10,
      });
      viewer.receive({ t: "nav", type: "forward" });
      await flush();
      expect(cdp.last("Page.navigateToHistoryEntry")?.params).toEqual({
        entryId: 12,
      });
      expect(viewer.texts()).toEqual([]);
    });

    it("遷移させないページに居ても、開いてよいURLへは戻れる", async () => {
      const { cdp, viewer } = await startedOn(1, [A_URL, REFUSED_URL]);
      viewer.receive({ t: "nav", type: "back" });
      await flush();
      expect(cdp.last("Page.navigateToHistoryEntry")?.params).toEqual({
        entryId: 10,
      });
      expect(viewer.texts()).toEqual([]);
    });

    it("履歴を読めなければ、backは何もしない", async () => {
      const { cdp, viewer } = await startedOn(1, [A_URL, B_URL]);
      cdp.failOn(HISTORY);
      viewer.receive({ t: "nav", type: "back" });
      await flush();
      cdp.stopFailing(HISTORY);
      cdp.answer(HISTORY, {});
      viewer.receive({ t: "nav", type: "back" });
      await flush();
      expect(cdp.count("Page.navigateToHistoryEntry")).toBe(0);
      expect(viewer.close).not.toHaveBeenCalled();
    });

    it("履歴を読んでいる間に接続が切れたら、backは移らない", async () => {
      const { cdp, viewer } = await startedOn(1, [A_URL, B_URL]);
      cdp.holdOn(HISTORY);
      viewer.receive({ t: "nav", type: "back" });
      cdp.emitBrowser("Target.detachedFromTarget", { sessionId: "S1" });
      await flush();
      expect(cdp.count("Page.navigateToHistoryEntry")).toBe(0);
    });

    it("reloadとstop", async () => {
      const { cdp, viewer } = await started();
      viewer.receive({ t: "nav", type: "reload" });
      viewer.receive({ t: "nav", type: "stop" });
      expect(cdp.methods()).toEqual(["Page.reload", "Page.stopLoading"]);
      expect(cdp.last("Page.reload")?.sessionId).toBe("S1");
      expect(cdp.last("Page.stopLoading")?.sessionId).toBe("S1");
    });

    it("遷移がrejectされても視聴者を切らない", async () => {
      const { cdp, viewer } = await started();
      for (const method of [NAVIGATE, "Page.reload", "Page.stopLoading"]) {
        cdp.failOn(method);
      }
      viewer.receive({ t: "nav", type: "goto", url: A_URL });
      viewer.receive({ t: "nav", type: "reload" });
      viewer.receive({ t: "nav", type: "stop" });
      await flush();
      expect(viewer.close).not.toHaveBeenCalled();
      expect(viewer.terminate).not.toHaveBeenCalled();
    });

    it("タブの準備が終わる前の遷移は捨てる", async () => {
      const cdp = fakeCdp();
      cdp.holdOn("Emulation.setDeviceMetricsOverride");
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      viewer.receive({ t: "nav", type: "goto", url: A_URL });
      viewer.receive({ t: "nav", type: "reload" });
      cdp.release("Emulation.setDeviceMetricsOverride");
      await flush();
      expect(cdp.count(NAVIGATE)).toBe(0);
      expect(cdp.count("Page.reload")).toBe(0);
    });
  });

  describe("ダイアログの表示と応答", () => {
    const OPENING = "Page.javascriptDialogOpening";
    const CLOSED = "Page.javascriptDialogClosed";
    const HANDLE = "Page.handleJavaScriptDialog";
    const prompt = {
      type: "prompt",
      message: "名前は?",
      defaultPrompt: "ark",
      url: A_URL,
    };
    const PROMPT_BODY = {
      t: "dialog",
      id: 1,
      kind: "prompt",
      message: "名前は?",
      defaultPrompt: "ark",
    };

    it("開いたら全員へ知らせ、閉じたら全員へ知らせる", async () => {
      const { cdp, viewers } = await started(2);
      cdp.emit(OPENING, prompt);
      for (const viewer of viewers) {
        expect(viewer.texts()).toEqual([PROMPT_BODY]);
      }
      cdp.emit(CLOSED, { result: true, userInput: "x" });
      for (const viewer of viewers) {
        expect(viewer.texts().at(-1)).toEqual({ t: "dialogClosed" });
      }
    });

    it("開いている間に入った視聴者へ、寸法、ページの状態、ダイアログ、タブの一覧の順に知らせる", async () => {
      const { cdp, bridge, viewer } = await startedOn(0, [A_URL]);
      cdp.emit(OPENING, prompt);
      const late = fakeViewer();
      bridge.attach(late);
      await flush();
      expect(late.texts()).toEqual([
        { t: "viewport", width: 1280, height: 900, gen: 1 },
        pageBody(A_URL, "T0"),
        PROMPT_BODY,
        ONE_TAB,
      ]);
      expect(viewer.texts()).toEqual([PROMPT_BODY]);
    });

    it("閉じたあとに入った視聴者へは知らせない", async () => {
      const { cdp, bridge } = await started();
      cdp.emit(OPENING, prompt);
      cdp.emit(CLOSED, { result: false, userInput: "" });
      const late = fakeViewer();
      bridge.attach(late);
      await flush();
      expect(textsOf(late, "dialog")).toEqual([]);
    });

    it("準備の途中に開いたダイアログも、入った視聴者へ知らせる", async () => {
      const cdp = fakeCdp();
      cdp.holdOn("Emulation.setDeviceMetricsOverride");
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      cdp.emit(OPENING, prompt);
      expect(viewer.texts()).toEqual([]);
      cdp.release("Emulation.setDeviceMetricsOverride");
      await flush();
      expect(viewer.texts()).toEqual([
        { t: "viewport", width: 1280, height: 900, gen: 1 },
        PROMPT_BODY,
        ONE_TAB,
      ]);
    });

    it("応答をPage.handleJavaScriptDialogにする", async () => {
      const { cdp, viewer } = await started();
      cdp.emit(OPENING, prompt);
      viewer.receive({ t: "dialog", id: 1, accept: true, promptText: "x" });
      expect(cdp.last(HANDLE)).toEqual({
        params: { accept: true, promptText: "x" },
        sessionId: "S1",
      });
      viewer.receive({ t: "dialog", id: 1, accept: false });
      expect(cdp.last(HANDLE)?.params).toEqual({ accept: false });
    });

    it("開いていないときの応答は無視する", async () => {
      const { cdp, viewer } = await started();
      viewer.receive({ t: "dialog", id: 1, accept: true });
      cdp.emit(OPENING, prompt);
      cdp.emit(CLOSED, { result: true, userInput: "" });
      viewer.receive({ t: "dialog", id: 1, accept: true });
      expect(cdp.count(HANDLE)).toBe(0);
    });

    it("前のダイアログへの遅れた応答を、次のダイアログへ渡さない", async () => {
      const { cdp, viewers } = await started(2);
      cdp.emit(OPENING, { type: "confirm", message: "消しますか?" });
      viewers[0].receive({ t: "dialog", id: 1, accept: true });
      cdp.emit(CLOSED, { result: true, userInput: "" });
      cdp.emit(OPENING, { type: "confirm", message: "本当に消しますか?" });
      // 2人目の応答は、1つ目のダイアログを見て押したもの
      viewers[1].receive({ t: "dialog", id: 1, accept: true });
      expect(cdp.count(HANDLE)).toBe(1);
      expect(
        textsOf(viewers[1], "dialog").map(m => (m as { id: number }).id)
      ).toEqual([1, 2]);

      viewers[1].receive({ t: "dialog", id: 2, accept: false });
      expect(cdp.count(HANDLE)).toBe(2);
      expect(cdp.last(HANDLE)?.params).toEqual({ accept: false });
    });

    it("番号の無い応答と、まだ振っていない番号の応答は捨てる", async () => {
      const { cdp, viewer } = await started();
      cdp.emit(OPENING, prompt);
      viewer.receive({ t: "dialog", accept: true });
      viewer.receive({ t: "dialog", id: 2, accept: true });
      viewer.receive({ t: "dialog", id: 0, accept: true });
      expect(cdp.count(HANDLE)).toBe(0);
    });

    it("入り直した視聴者へは、開いているダイアログを同じ番号で知らせる", async () => {
      const { cdp, bridge, viewer } = await started();
      cdp.emit(OPENING, prompt);
      const late = fakeViewer();
      bridge.attach(late);
      await flush();
      expect(textsOf(late, "dialog")).toEqual([PROMPT_BODY]);
      expect(textsOf(viewer, "dialog")).toEqual([PROMPT_BODY]);
    });

    it("接続をつなぎ直しても、番号は重ならない", async () => {
      const first = fakeCdp();
      const second = fakeCdp();
      const connect = vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second);
      const bridge = new BrowserCdpBridge(connect);
      bridge.attach(fakeViewer());
      await flush();
      first.emit(OPENING, prompt);
      first.disconnect();
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      second.emit(OPENING, prompt);
      expect(textsOf(viewer, "dialog")).toEqual([{ ...PROMPT_BODY, id: 2 }]);
      viewer.receive({ t: "dialog", id: 1, accept: true });
      expect(second.count(HANDLE)).toBe(0);
      viewer.receive({ t: "dialog", id: 2, accept: true });
      expect(second.count(HANDLE)).toBe(1);
    });

    it("ほかの視聴者が先に答えていて応答がrejectされても、視聴者を切らない", async () => {
      const { cdp, viewers } = await started(2);
      cdp.emit(OPENING, prompt);
      viewers[0].receive({ t: "dialog", id: 1, accept: true });
      cdp.failOn(HANDLE);
      viewers[1].receive({ t: "dialog", id: 1, accept: false });
      await flush();
      expect(cdp.count(HANDLE)).toBe(2);
      expect(viewers[1].close).not.toHaveBeenCalled();
      expect(viewers[1].terminate).not.toHaveBeenCalled();
    });

    it("長いメッセージは10,000文字で切り、知らない種類はalertにする", async () => {
      const { cdp, viewer } = await started();
      cdp.emit(OPENING, {
        type: "future",
        message: "m".repeat(10_001),
        defaultPrompt: "d".repeat(10_001),
      });
      expect(viewer.texts()).toEqual([
        {
          t: "dialog",
          id: 1,
          kind: "alert",
          message: "m".repeat(10_000),
          defaultPrompt: "d".repeat(10_000),
        },
      ]);
    });

    it("形の違うイベントでも、空のalertとして知らせる", async () => {
      const { cdp, viewer } = await started();
      cdp.emit(OPENING, undefined);
      expect(viewer.texts()).toEqual([
        { t: "dialog", id: 1, kind: "alert", message: "", defaultPrompt: "" },
      ]);
    });

    it("開いていないのに閉じたと届いても、知らせない", async () => {
      const { cdp, viewer } = await started();
      cdp.emit(CLOSED, { result: true, userInput: "" });
      expect(viewer.texts()).toEqual([]);
    });

    it("別のsessionのダイアログは知らせない", async () => {
      const { cdp, viewer } = await started();
      cdp.emit(OPENING, prompt, "S-other");
      cdp.emitBrowser(OPENING, prompt);
      viewer.receive({ t: "dialog", id: 1, accept: true });
      expect(viewer.texts()).toEqual([]);
      expect(cdp.count(HANDLE)).toBe(0);
    });

    it("接続が切れたら、開いていたダイアログを忘れる", async () => {
      const first = fakeCdp();
      const second = fakeCdp();
      const connect = vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second);
      const bridge = new BrowserCdpBridge(connect);
      bridge.attach(fakeViewer());
      await flush();
      first.emit(OPENING, prompt);
      first.disconnect();
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      expect(textsOf(viewer, "dialog")).toEqual([]);
      viewer.receive({ t: "dialog", id: 1, accept: true });
      expect(second.count(HANDLE)).toBe(0);
    });
  });

  describe("コピー", () => {
    const EVALUATE = "Runtime.evaluate";
    const selected = (value: unknown) => ({
      result: { type: "string", value },
    });

    it("固定の式で選択を読み、送った視聴者にだけ返す", async () => {
      const { cdp, viewers } = await started(2);
      cdp.answer(EVALUATE, selected("選んだ文字"));
      viewers[0].receive({ t: "copy", expression: "document.cookie" });
      await flush();
      expect(cdp.last(EVALUATE)).toEqual({
        params: {
          expression: COPY_EXPRESSION,
          returnByValue: true,
          timeout: 1000,
        },
        sessionId: "S1",
      });
      expect(viewers[0].texts()).toEqual([
        { t: "clipboard", text: "選んだ文字" },
      ]);
      expect(viewers[1].texts()).toEqual([]);
    });

    it.each([
      ["空の選択", selected("")],
      ["文字列でない値", selected(1)],
      ["例外", { result: { type: "object" }, exceptionDetails: {} }],
      ["空の応答", {}],
    ])("%s では返さない", async (_name, result) => {
      const { cdp, viewer } = await started();
      cdp.answer(EVALUATE, result);
      viewer.receive({ t: "copy" });
      await flush();
      expect(cdp.count(EVALUATE)).toBe(1);
      expect(viewer.texts()).toEqual([]);
    });

    it("評価がrejectされても視聴者を切らない", async () => {
      const { cdp, viewer } = await started();
      cdp.failOn(EVALUATE);
      viewer.receive({ t: "copy" });
      await flush();
      expect(viewer.texts()).toEqual([]);
      expect(viewer.close).not.toHaveBeenCalled();
    });

    it("100万文字で切る", async () => {
      const { cdp, viewer } = await started();
      cdp.answer(EVALUATE, selected("a".repeat(1_000_001)));
      viewer.receive({ t: "copy" });
      await flush();
      const [message] = viewer.texts() as Array<{ text: string }>;
      expect(message.text).toHaveLength(1_000_000);
    });

    it("ダイアログが開いている間は評価しない", async () => {
      const { cdp, viewer } = await started();
      cdp.emit("Page.javascriptDialogOpening", { type: "alert", message: "" });
      viewer.receive({ t: "copy" });
      await flush();
      expect(cdp.count(EVALUATE)).toBe(0);
    });

    it("前のコピーを読んでいる間は、だれのコピーも評価しない。返ったら、また受け付ける", async () => {
      const { cdp, viewers } = await started(2);
      cdp.answer(EVALUATE, selected("x"));
      cdp.holdOn(EVALUATE);
      viewers[0].receive({ t: "copy" });
      viewers[0].receive({ t: "copy" });
      viewers[1].receive({ t: "copy" });
      await flush();
      expect(cdp.count(EVALUATE)).toBe(1);
      cdp.release(EVALUATE);
      await flush();
      expect(viewers[0].texts()).toEqual([{ t: "clipboard", text: "x" }]);
      expect(viewers[1].texts()).toEqual([]);
      viewers[1].receive({ t: "copy" });
      await flush();
      expect(cdp.count(EVALUATE)).toBe(2);
    });

    it("評価がrejectされたあとは、また受け付ける", async () => {
      const { cdp, viewer } = await started();
      cdp.holdOn(EVALUATE);
      viewer.receive({ t: "copy" });
      cdp.fail(EVALUATE);
      await flush();
      viewer.receive({ t: "copy" });
      await flush();
      expect(cdp.count(EVALUATE)).toBe(2);
    });

    it("送信が詰まっている視聴者へは、コピーの結果を送らない。小さな知らせは送る", async () => {
      const { cdp, viewer } = await started();
      cdp.answer(EVALUATE, selected("x".repeat(1000)));
      viewer.bufferedAmount = 1_000_000;
      viewer.receive({ t: "copy" });
      await flush();
      viewer.receive({ t: "nav", type: "goto", url: "file:///etc/passwd" });
      await flush();
      expect(viewer.texts()).toEqual([
        { t: "notice", message: "http://またはhttps://のURLだけを開けます" },
      ]);
      viewer.bufferedAmount = 999_999;
      viewer.receive({ t: "copy" });
      await flush();
      expect(textsOf(viewer, "clipboard")).toHaveLength(1);
    });

    it("読んでいる間に去った視聴者へは返さない", async () => {
      const { cdp, viewers } = await started(2);
      cdp.answer(EVALUATE, selected("x"));
      cdp.holdOn(EVALUATE);
      viewers[0].receive({ t: "copy" });
      viewers[0].emit("close");
      cdp.release(EVALUATE);
      await flush();
      expect(viewers[0].texts()).toEqual([]);
      expect(viewers[1].texts()).toEqual([]);
    });
  });
});

describe("COPY_EXPRESSION", () => {
  /** ページの `document` と `getSelection` を差し替えて、式を評価する */
  function evaluate(document: unknown, getSelection: () => unknown): unknown {
    return new Function(
      "document",
      "getSelection",
      `return ${COPY_EXPRESSION};`
    )(document, getSelection);
  }
  const noSelection = () => "";

  it("フォーカスが無ければ、文書の選択を返す", () => {
    expect(evaluate({ activeElement: null }, () => "文書の選択")).toBe(
      "文書の選択"
    );
  });

  it.each(["INPUT", "TEXTAREA"])(
    "フォーカスが %s にあれば、valueの選択範囲を返す",
    tagName => {
      const el = {
        tagName,
        type: "text",
        value: "0123456789",
        selectionStart: 2,
        selectionEnd: 5,
      };
      expect(evaluate({ activeElement: el }, noSelection)).toBe("234");
    }
  );

  it("パスワードの欄からは読まない", () => {
    const el = {
      tagName: "INPUT",
      type: "password",
      value: "secret",
      selectionStart: 0,
      selectionEnd: 6,
    };
    expect(evaluate({ activeElement: el }, () => "secret")).toBe("");
  });

  it("選択範囲を持たない欄 (numberなど) では、文書の選択を返す", () => {
    const el = {
      tagName: "INPUT",
      type: "number",
      value: "42",
      selectionStart: null,
      selectionEnd: null,
    };
    expect(evaluate({ activeElement: el }, () => "外の選択")).toBe("外の選択");
  });

  it("shadow DOMと同じオリジンのiframeの中のフォーカスをたどる", () => {
    const input = {
      tagName: "INPUT",
      type: "text",
      value: "abcdef",
      selectionStart: 1,
      selectionEnd: 3,
    };
    const host = { tagName: "X-HOST", shadowRoot: { activeElement: input } };
    const frame = {
      tagName: "IFRAME",
      contentDocument: { activeElement: host },
    };
    expect(evaluate({ activeElement: frame }, noSelection)).toBe("bc");
  });

  it("選択が無ければ空の文字列を返す", () => {
    expect(evaluate({ activeElement: null }, () => null)).toBe("");
  });

  it("途中で例外が出ても、投げずに空の文字列を返す", () => {
    const frame = {
      tagName: "IFRAME",
      get contentDocument(): never {
        throw new Error("cross-origin");
      },
    };
    expect(evaluate({ activeElement: frame }, noSelection)).toBe("");
    expect(
      evaluate({ activeElement: null }, () => {
        throw new Error("no selection");
      })
    ).toBe("");
  });

  it("100万文字で切る", () => {
    expect(
      evaluate({ activeElement: null }, () => "a".repeat(1_000_001))
    ).toHaveLength(1_000_000);
  });
});

const ACTIVATE = "Target.activateTarget";
const ATTACH = "Target.attachToTarget";
const CLOSE_TARGET = "Target.closeTarget";
const CREATE_TARGET = "Target.createTarget";
const DETACH = "Target.detachFromTarget";
const START_CAST = "Page.startScreencast";
const STOP_CAST = "Page.stopScreencast";

function tabUrl(id: string): string {
  return `http://localhost:3000/${id}`;
}

function target(id: string, extra: Partial<FakeTarget> = {}): FakeTarget {
  return {
    targetId: id,
    type: "page",
    url: tabUrl(id),
    title: `${id}の題`,
    ...extra,
  };
}

function tabOf(id: string) {
  return { id, title: `${id}の題`, url: tabUrl(id) };
}

function tabsBody(ids: string[], activeId: string) {
  return { t: "tabs", tabs: ids.map(tabOf), activeId };
}

const BLANK_TAB = { id: "T-new", title: "", url: "about:blank" };

/** タブへつなぐときの、CDPの呼び出しの並び */
const ENTER_CALLS = [
  ACTIVATE,
  ATTACH,
  "Page.enable",
  "Emulation.setFocusEmulationEnabled",
  "Emulation.setDeviceMetricsOverride",
  "Emulation.setTouchEmulationEnabled",
  "Runtime.enable",
  "Runtime.addBinding",
  "Page.addScriptToEvaluateOnNewDocument",
  "Runtime.evaluate",
  HISTORY,
  START_CAST,
];

/**
 * `started` と同じだが、タブが `ids` のぶんだけあり、最初の1つ (session `S1`) を映している。
 */
async function startedWithTabs(ids = ["T1", "T2", "T3"], count = 1) {
  const cdp = fakeCdp({ targets: ids.map(id => target(id)) });
  const connect = vi.fn().mockResolvedValue(cdp);
  const bridge = new BrowserCdpBridge(connect);
  const viewers = Array.from({ length: count }, () => fakeViewer());
  for (const viewer of viewers) bridge.attach(viewer);
  await flush();
  cdp.emit("Page.screencastFrame", monitorFrame(1));
  await vi.advanceTimersByTimeAsync(1000);
  for (const viewer of viewers) viewer.send.mockClear();
  cdp.forget();
  return { cdp, connect, bridge, viewers, viewer: viewers[0] };
}

describe("BrowserCdpBridge: タブ", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    withoutPoll();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** 視聴者を切らず、接続も捨てていない */
  function expectKept(ctx: Awaited<ReturnType<typeof startedWithTabs>>) {
    for (const viewer of ctx.viewers) {
      expect(errorCount(viewer)).toBe(0);
      expect(viewer.close).not.toHaveBeenCalled();
      expect(viewer.terminate).not.toHaveBeenCalled();
    }
    expect(ctx.bridge.viewerCount).toBe(ctx.viewers.length);
    expect(ctx.cdp.close).not.toHaveBeenCalled();
    expect(ctx.connect).toHaveBeenCalledTimes(1);
  }

  describe("一覧", () => {
    it("つなぐときにターゲットの発見を頼み、入った視聴者へ、寸法、ページの状態、一覧の順に知らせる", async () => {
      const cdp = fakeCdp({ targets: [target("T1"), target("T2")] });
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      expect(cdp.last("Target.setDiscoverTargets")).toEqual({
        params: { discover: true },
        sessionId: undefined,
      });
      expect(viewer.texts()).toEqual([
        { t: "viewport", width: 1280, height: 900, gen: 1 },
        pageBody(tabUrl("T1"), "T1の題"),
        tabsBody(["T1", "T2"], "T1"),
      ]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("あとから入った視聴者にも知らせる。先にいた視聴者へは送り直さない", async () => {
      const { bridge, viewer } = await startedWithTabs();
      const late = fakeViewer();
      bridge.attach(late);
      await flush();
      expect(textsOf(late, "tabs")).toEqual([
        tabsBody(["T1", "T2", "T3"], "T1"),
      ]);
      expect(viewer.texts()).toEqual([]);
    });

    it("pageでないターゲットと、DevToolsと拡張機能のページは一覧に出さない", async () => {
      const cdp = fakeCdp({
        targets: [
          target("W1", { type: "service_worker" }),
          target("D1", { url: "devtools://devtools/bundled/x.html" }),
          target("E1", { url: "chrome-extension://abc/page.html" }),
          target("T1"),
        ],
      });
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      expect(cdp.last(ATTACH)?.params).toMatchObject({ targetId: "T1" });
      expect(textsOf(viewer, "tabs")).toEqual([tabsBody(["T1"], "T1")]);
    });

    it("タブが増えた、変わった、消えたことを、100msにまとめて全員へ知らせる", async () => {
      const { cdp, viewers } = await startedWithTabs(["T1", "T2"], 2);
      cdp.emitBrowser("Target.targetCreated", { targetInfo: target("T3") });
      cdp.emitBrowser("Target.targetInfoChanged", {
        targetInfo: target("T2", { title: "変えた題" }),
      });
      await vi.advanceTimersByTimeAsync(99);
      for (const viewer of viewers) expect(viewer.texts()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      const expected = {
        t: "tabs",
        tabs: [tabOf("T1"), { ...tabOf("T2"), title: "変えた題" }, tabOf("T3")],
        activeId: "T1",
      };
      for (const viewer of viewers) expect(viewer.texts()).toEqual([expected]);
      cdp.emitBrowser("Target.targetDestroyed", { targetId: "T2" });
      await vi.advanceTimersByTimeAsync(100);
      for (const viewer of viewers) {
        expect(viewer.texts().at(-1)).toEqual(tabsBody(["T1", "T3"], "T1"));
      }
      expect(vi.getTimerCount()).toBe(0);
    });

    it("見える列が変わらない更新と、追っていないターゲットのイベントでは知らせない", async () => {
      const { cdp, viewer } = await startedWithTabs(["T1", "T2"]);
      cdp.emitBrowser("Target.targetInfoChanged", {
        targetInfo: { ...target("T1"), attached: true },
      });
      cdp.emitBrowser("Target.targetCreated", {
        targetInfo: target("W1", { type: "worker" }),
      });
      cdp.emitBrowser("Target.targetInfoChanged", { targetInfo: target("T9") });
      cdp.emitBrowser("Target.targetDestroyed", { targetId: "W1" });
      cdp.emitBrowser("Target.targetCreated", undefined);
      cdp.emitBrowser("Target.targetDestroyed", {});
      await vi.advanceTimersByTimeAsync(200);
      expect(viewer.texts()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("映しているタブの題が変わったら、履歴を読み直してページの状態を知らせる", async () => {
      const { cdp, viewer } = await startedWithTabs(["T1", "T2"]);
      cdp.answer(HISTORY, {
        currentIndex: 0,
        entries: [{ id: 1, url: tabUrl("T1"), title: "新しい題" }],
      });
      cdp.emitBrowser("Target.targetInfoChanged", {
        targetInfo: target("T1", { title: "新しい題" }),
      });
      // ほかのタブの題では読み直さない
      cdp.emitBrowser("Target.targetInfoChanged", {
        targetInfo: target("T2", { title: "よその題" }),
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(cdp.count(HISTORY)).toBe(1);
      expect(cdp.last(HISTORY)?.sessionId).toBe("S1");
      expect(textsOf(viewer, "page")).toEqual([
        pageBody(tabUrl("T1"), "新しい題"),
      ]);
    });

    it("接続が切れたら、知らせる待ちを消す", async () => {
      const { cdp } = await startedWithTabs();
      cdp.emitBrowser("Target.targetCreated", { targetInfo: target("T4") });
      // 前面へ戻すコマンドの応答を待つ間のタイマーは、応答が返れば消える
      await flush();
      expect(vi.getTimerCount()).toBe(1);
      cdp.disconnect();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("resetしたら、知らせる待ちを消す", async () => {
      const { cdp, bridge } = await startedWithTabs();
      cdp.emitBrowser("Target.targetCreated", { targetInfo: target("T4") });
      bridge.reset();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("切り替え", () => {
    it("前のタブの監視を止めて離れ、新しいタブで同じ準備をして監視を始める", async () => {
      const ctx = await startedWithTabs();
      const { cdp, viewer } = ctx;
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      await flush();
      expect(cdp.methods()).toEqual([STOP_CAST, DETACH, ...ENTER_CALLS]);
      expect(cdp.last(STOP_CAST)?.sessionId).toBe("S1");
      expect(cdp.last(DETACH)).toEqual({
        params: { sessionId: "S1" },
        sessionId: undefined,
      });
      expect(cdp.last(ACTIVATE)?.params).toEqual({ targetId: "T2" });
      expect(cdp.last(ATTACH)?.params).toEqual({
        targetId: "T2",
        flatten: true,
      });
      for (const method of ENTER_CALLS.slice(2)) {
        expect(cdp.last(method)?.sessionId).toBe("S2");
      }
      expect(cdp.last("Emulation.setDeviceMetricsOverride")?.params).toEqual({
        width: 1280,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      expectKept(ctx);
    });

    it("全員へ、進めた世代の寸法、新しいタブのページの状態、一覧、鮮明な全画面の順に届く", async () => {
      const ctx = await startedWithTabs(["T1", "T2", "T3"], 2);
      const { cdp, viewers } = ctx;
      viewers[1].receive({ t: "tab", type: "activate", id: "T2" });
      await flush();
      for (const viewer of viewers) {
        expect(viewer.send.mock.calls.map(([data]) => data)).toEqual([
          JSON.stringify({ t: "viewport", width: 1280, height: 900, gen: 2 }),
          JSON.stringify(pageBody(tabUrl("T2"), "T2の題")),
          JSON.stringify(tabsBody(["T1", "T2", "T3"], "T2")),
        ]);
      }
      cdp.emit("Page.screencastFrame", monitorFrame(1), "S2");
      await flush();
      for (const viewer of viewers) {
        expect(viewer.shots()).toMatchObject([
          { kind: 1, gen: 2, rect: FULL_RECT },
        ]);
        expect(viewer.send.mock.calls.at(-1)?.[0]).toBeInstanceOf(Buffer);
      }
      expect(cdp.last(CAPTURE)?.sessionId).toBe("S2");
      expectKept(ctx);
    });

    it("前のタブのsessionから遅れて届いた監視フレームは、ackも返さず使わない", async () => {
      const { cdp, viewer } = await startedWithTabs();
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      await flush();
      cdp.forget();
      cdp.emit("Page.screencastFrame", monitorFrame(9), "S1");
      await flush();
      expect(cdp.methods()).toEqual([]);
      expect(viewer.frames()).toEqual([]);
    });

    it("前のタブで始めた取り直しが遅れて返っても、送らない", async () => {
      const { cdp, viewer } = await startedWithTabs();
      cdp.holdOn(CAPTURE);
      cdp.emit("Page.screencastFrame", monitorFrame(2, { dots: [[10, 10]] }));
      await flush();
      expect(cdp.count(CAPTURE)).toBe(1);
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      await flush();
      // 前のタブで待っていた取り直しは、離れるときに片づけてある
      expect(cdp.rejected()).toEqual(["S1"]);
      expect(viewer.frames()).toEqual([]);
      cdp.stopHolding(CAPTURE);
      cdp.emit("Page.screencastFrame", monitorFrame(1), "S2");
      await flush();
      expect(viewer.shots()).toMatchObject([{ kind: 1, gen: 2 }]);
    });

    it("前のタブのsessionのイベントは、切り替えたあとのタブに響かない", async () => {
      const { cdp, viewer } = await startedWithTabs();
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      await flush();
      viewer.send.mockClear();
      cdp.forget();
      cdp.emit(NAVIGATED, { frame: { id: "T1", url: B_URL } }, "S1");
      cdp.emit(
        "Page.javascriptDialogOpening",
        { type: "alert", message: "前のタブ" },
        "S1"
      );
      cdp.emit("Inspector.targetCrashed", undefined, "S1");
      cdp.emitBrowser("Target.detachedFromTarget", { sessionId: "S1" });
      await vi.advanceTimersByTimeAsync(200);
      expect(viewer.texts()).toEqual([]);
      expect(cdp.methods()).toEqual([]);
    });

    it("切り替えのあいだに届いた入力、遷移、コピーは捨てる。終わったら新しいタブへ送る", async () => {
      const { cdp, viewer } = await startedWithTabs();
      cdp.holdOn("Page.enable");
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      await flush();
      cdp.forget();
      viewer.receive({ t: "paste", text: "捨てる" });
      viewer.receive({ t: "nav", type: "reload" });
      viewer.receive({ t: "nav", type: "goto", url: "localhost:3000" });
      viewer.receive({ t: "dialog", id: 1, accept: true });
      viewer.receive({ t: "copy" });
      await flush();
      expect(cdp.methods()).toEqual([]);
      cdp.stopHolding("Page.enable");
      cdp.release("Page.enable");
      await flush();
      // 溜めておいて、あとから送ることもしない
      expect(cdp.count("Input.insertText")).toBe(0);
      expect(cdp.count("Page.reload")).toBe(0);
      expect(cdp.count("Page.navigate")).toBe(0);
      viewer.receive({ t: "paste", text: "届く" });
      expect(cdp.last("Input.insertText")).toEqual({
        params: { text: "届く" },
        sessionId: "S2",
      });
    });

    it("切り替えのあいだに続けて来た切り替えは、終わってから最後の1つだけ行う", async () => {
      const ctx = await startedWithTabs(["T1", "T2", "T3", "T4"]);
      const { cdp, viewer } = ctx;
      cdp.holdOn("Page.enable");
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      await flush();
      viewer.receive({ t: "tab", type: "activate", id: "T3" });
      viewer.receive({ t: "tab", type: "activate", id: "T1" });
      viewer.receive({ t: "tab", type: "activate", id: "T4" });
      await flush();
      expect(cdp.count(ATTACH)).toBe(1);
      cdp.stopHolding("Page.enable");
      cdp.release("Page.enable");
      await flush();
      expect(
        cdp
          .methods()
          .map((method, i) => (method === ATTACH ? i : -1))
          .filter(i => i >= 0)
      ).toHaveLength(2);
      expect(cdp.last(ATTACH)?.params).toMatchObject({ targetId: "T4" });
      expect(textsOf(viewer, "tabs").at(-1)).toEqual(
        tabsBody(["T1", "T2", "T3", "T4"], "T4")
      );
      // 切り替えのたびに世代が進む
      expect(textsOf(viewer, "viewport").at(-1)).toMatchObject({ gen: 3 });
      expectKept(ctx);
    });

    it("一覧に無いid、いま映しているタブへの切り替えは何もしない", async () => {
      const { cdp, viewer } = await startedWithTabs();
      viewer.receive({ t: "tab", type: "activate", id: "T9" });
      viewer.receive({ t: "tab", type: "activate", id: "T1" });
      viewer.receive({ t: "tab", type: "close", id: "T9" });
      await flush();
      expect(cdp.methods()).toEqual([]);
      expect(viewer.texts()).toEqual([]);
    });

    it("ダイアログが開いていたタブを閉じたら、閉じたと知らせ、移った先のタブでは取り直す", async () => {
      const { cdp, viewer } = await startedWithTabs();
      cdp.emit("Page.javascriptDialogOpening", { type: "alert", message: "m" });
      viewer.send.mockClear();
      viewer.receive({ t: "tab", type: "close", id: "T1" });
      await flush();
      expect(textsOf(viewer, "dialogClosed")).toHaveLength(1);
      expect(textsOf(viewer, "dialog")).toEqual([]);
      cdp.emit("Page.screencastFrame", monitorFrame(1), "S2");
      await flush();
      expect(viewer.shots()).toMatchObject([{ kind: 1, gen: 2 }]);
      // 新しいタブでは、ダイアログへの応答を送らない
      viewer.receive({ t: "dialog", id: 1, accept: true });
      expect(cdp.count("Page.handleJavaScriptDialog")).toBe(0);
    });

    it("切り替えのあいだに受けたresizeは、新しいタブの準備が終わったときに当てる", async () => {
      const { cdp, viewer } = await startedWithTabs();
      cdp.holdOn("Emulation.setDeviceMetricsOverride");
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      await flush();
      viewer.receive({
        t: "resize",
        width: 500,
        height: 600,
        dpr: 1,
        mobile: false,
      });
      await vi.advanceTimersByTimeAsync(200);
      cdp.stopHolding("Emulation.setDeviceMetricsOverride");
      cdp.release("Emulation.setDeviceMetricsOverride");
      await flush();
      expect(cdp.last("Emulation.setDeviceMetricsOverride")).toEqual({
        params: {
          width: 500,
          height: 600,
          deviceScaleFactor: 1,
          mobile: false,
        },
        sessionId: "S2",
      });
      expect(cdp.last(START_CAST)?.params).toMatchObject({
        maxWidth: 63,
        maxHeight: 75,
      });
      expect(textsOf(viewer, "viewport").at(-1)).toMatchObject({
        width: 500,
        height: 600,
      });
    });

    it("切り替える前に受けて待っていたresizeも、新しいタブに当たる", async () => {
      const { cdp, viewer } = await startedWithTabs();
      viewer.receive({
        t: "resize",
        width: 500,
        height: 600,
        dpr: 1,
        mobile: false,
      });
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      await vi.advanceTimersByTimeAsync(200);
      expect(cdp.last("Emulation.setDeviceMetricsOverride")).toEqual({
        params: {
          width: 500,
          height: 600,
          deviceScaleFactor: 1,
          mobile: false,
        },
        sessionId: "S2",
      });
      expect(cdp.count(START_CAST)).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("切り替えのあいだに入った視聴者も、終わったら寸法、ページの状態、一覧、全画面を受け取る", async () => {
      const { cdp, bridge } = await startedWithTabs();
      cdp.holdOn("Page.enable");
      bridge.attach(fakeViewer());
      await flush();
      cdp.forget();
      const first = fakeViewer();
      bridge.attach(first);
      await flush();
      first.receive({ t: "tab", type: "activate", id: "T2" });
      await flush();
      const late = fakeViewer();
      bridge.attach(late);
      await flush();
      expect(late.close).not.toHaveBeenCalled();
      cdp.stopHolding("Page.enable");
      cdp.release("Page.enable");
      await flush();
      expect(late.texts().map(m => (m as { t: string }).t)).toEqual([
        "viewport",
        "page",
        "tabs",
      ]);
      expect(late.texts().at(-1)).toEqual(tabsBody(["T1", "T2", "T3"], "T2"));
      cdp.emit("Page.screencastFrame", monitorFrame(1), "S2");
      await flush();
      expect(late.kinds()).toEqual([1]);
    });

    it("視聴者が居ない間に終わった切り替えでは、監視を始めない。戻った視聴者で始める", async () => {
      const { cdp, bridge, viewer } = await startedWithTabs();
      cdp.holdOn("Page.enable");
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      await flush();
      viewer.emit("close");
      cdp.stopHolding("Page.enable");
      cdp.release("Page.enable");
      await flush();
      expect(cdp.count(START_CAST)).toBe(0);
      const back = fakeViewer();
      bridge.attach(back);
      await flush();
      expect(cdp.last(START_CAST)?.sessionId).toBe("S2");
      expect(textsOf(back, "tabs")).toEqual([
        tabsBody(["T1", "T2", "T3"], "T2"),
      ]);
    });

    it("navigateは、切り替えが終わるのを待って、新しいタブを遷移させる", async () => {
      const { cdp, bridge, viewer } = await startedWithTabs();
      cdp.holdOn("Page.enable");
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      await flush();
      const done = bridge.navigate("http://localhost:3000/");
      await flush();
      expect(cdp.count("Page.navigate")).toBe(0);
      cdp.stopHolding("Page.enable");
      cdp.release("Page.enable");
      await done;
      expect(cdp.last("Page.navigate")).toEqual({
        params: { url: "http://localhost:3000/" },
        sessionId: "S2",
      });
    });

    it("準備の途中に新しいタブで開いたダイアログは、準備が終わったときに、途中で入った視聴者にも届く", async () => {
      const { cdp, bridge, viewer } = await startedWithTabs();
      cdp.holdOn("Emulation.setDeviceMetricsOverride");
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      await flush();
      cdp.emit(
        "Page.javascriptDialogOpening",
        { type: "alert", message: "新しいタブ" },
        "S2"
      );
      const late = fakeViewer();
      bridge.attach(late);
      await flush();
      expect(textsOf(late, "dialog")).toEqual([]);
      cdp.stopHolding("Emulation.setDeviceMetricsOverride");
      cdp.release("Emulation.setDeviceMetricsOverride");
      await flush();
      expect(late.texts().map(m => (m as { t: string }).t)).toEqual([
        "viewport",
        "page",
        "dialog",
        "tabs",
      ]);
      // 開いている間は取り直さない
      cdp.emit("Page.screencastFrame", monitorFrame(1), "S2");
      await flush();
      expect(cdp.count(CAPTURE)).toBe(0);
    });

    it("待たせておく操作には上限があり、超えたぶんは捨てる", async () => {
      const { cdp, viewer } = await startedWithTabs(["T1"]);
      cdp.holdOn(CREATE_TARGET);
      for (let i = 0; i < 100; i++) viewer.receive({ t: "tab", type: "new" });
      await flush();
      cdp.stopHolding(CREATE_TARGET);
      cdp.release(CREATE_TARGET);
      await vi.advanceTimersByTimeAsync(1000);
      // 走っていた1つと、待っていたぶん。タブの数の上限 (20) にも届く
      expect(cdp.count(CREATE_TARGET)).toBe(19);
      expect(textsOf(viewer, "notice")).toHaveLength(14);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("切り替えのあいだにCDPが切れたら、視聴者へerrorを1回だけ送り、タイマーを残さない", async () => {
      const { cdp, bridge, viewer } = await startedWithTabs();
      cdp.holdOn("Page.enable");
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      viewer.receive({ t: "tab", type: "activate", id: "T3" });
      await flush();
      cdp.disconnect();
      await vi.advanceTimersByTimeAsync(1000);
      expect(errorCount(viewer)).toBe(1);
      expect(viewer.close).toHaveBeenCalledTimes(1);
      expect(bridge.viewerCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("切り替えのあいだにresetしても、遅れた応答で何も起きない", async () => {
      const { cdp, bridge, viewer } = await startedWithTabs();
      cdp.holdOn("Page.enable");
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      await flush();
      bridge.reset();
      cdp.forget();
      viewer.send.mockClear();
      cdp.disconnect();
      await vi.advanceTimersByTimeAsync(1000);
      expect(cdp.methods()).toEqual([]);
      expect(viewer.send).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("ページが開いたタブ", () => {
    it("いま映しているタブが開いたタブへ、自動で切り替える", async () => {
      const ctx = await startedWithTabs(["T1", "T2"]);
      const { cdp, viewer } = ctx;
      cdp.emitBrowser("Target.targetCreated", {
        targetInfo: target("T9", { openerId: "T1" }),
      });
      await flush();
      expect(cdp.methods()).toEqual([STOP_CAST, DETACH, ...ENTER_CALLS]);
      expect(cdp.last(ATTACH)?.params).toMatchObject({ targetId: "T9" });
      expect(textsOf(viewer, "tabs")).toEqual([
        tabsBody(["T1", "T2", "T9"], "T9"),
      ]);
      await vi.advanceTimersByTimeAsync(200);
      expect(textsOf(viewer, "tabs")).toHaveLength(1);
      expectKept(ctx);
    });

    it("ほかのタブが開いたタブへは切り替えず、一覧にだけ出す", async () => {
      const { cdp, viewer } = await startedWithTabs(["T1", "T2"]);
      cdp.emitBrowser("Target.targetCreated", {
        targetInfo: target("T9", { openerId: "T2" }),
      });
      await vi.advanceTimersByTimeAsync(100);
      // 切り替えない。映しているタブを前面へ戻して、全画面を取り直すだけ
      expect(cdp.methods()).toEqual([ACTIVATE, CAPTURE]);
      expect(cdp.last(ACTIVATE)?.params).toEqual({ targetId: "T1" });
      expect(viewer.texts()).toEqual([tabsBody(["T1", "T2", "T9"], "T1")]);
    });

    it("上限を超えていても、ページが開いたタブは一覧に出して切り替える", async () => {
      const ids = Array.from({ length: 20 }, (_, i) => `T${i + 1}`);
      const { cdp, viewer } = await startedWithTabs(ids);
      cdp.emitBrowser("Target.targetCreated", {
        targetInfo: target("T99", { openerId: "T1" }),
      });
      await flush();
      expect(textsOf(viewer, "tabs")).toEqual([
        tabsBody([...ids, "T99"], "T99"),
      ]);
    });
  });

  describe("閉じる", () => {
    it("映していないタブを閉じても、切り替えない", async () => {
      const ctx = await startedWithTabs();
      const { cdp, viewer } = ctx;
      viewer.receive({ t: "tab", type: "close", id: "T3" });
      await flush();
      expect(cdp.methods()).toEqual([CLOSE_TARGET]);
      expect(cdp.last(CLOSE_TARGET)).toEqual({
        params: { targetId: "T3" },
        sessionId: undefined,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(viewer.texts()).toEqual([tabsBody(["T1", "T2"], "T1")]);
      // Chromiumが消えたと知らせてきても、知らせ直さない
      cdp.emitBrowser("Target.targetDestroyed", { targetId: "T3" });
      await vi.advanceTimersByTimeAsync(100);
      expect(viewer.texts()).toHaveLength(1);
      expectKept(ctx);
    });

    it("閉じられなかったタブは、一覧に残す", async () => {
      const { cdp, viewer } = await startedWithTabs();
      cdp.failOn(CLOSE_TARGET);
      viewer.receive({ t: "tab", type: "close", id: "T3" });
      await vi.advanceTimersByTimeAsync(200);
      expect(viewer.texts()).toEqual([]);
      expect(viewer.close).not.toHaveBeenCalled();
    });

    it("いま映しているタブを閉じたら、直前のタブへ移る", async () => {
      const ctx = await startedWithTabs();
      const { cdp, viewer } = ctx;
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      await flush();
      cdp.forget();
      viewer.send.mockClear();
      viewer.receive({ t: "tab", type: "close", id: "T2" });
      await flush();
      expect(cdp.methods()).toEqual([
        STOP_CAST,
        DETACH,
        CLOSE_TARGET,
        ...ENTER_CALLS,
      ]);
      expect(cdp.last(CLOSE_TARGET)?.params).toEqual({ targetId: "T2" });
      expect(cdp.last(ATTACH)?.params).toMatchObject({ targetId: "T1" });
      expect(textsOf(viewer, "tabs")).toEqual([tabsBody(["T1", "T3"], "T1")]);
      expect(textsOf(viewer, "viewport")).toMatchObject([{ gen: 3 }]);
      // 閉じたタブについて遅れて届くイベントでは、もう何も起きない
      cdp.forget();
      cdp.emitBrowser("Target.detachedFromTarget", { sessionId: "S2" });
      cdp.emitBrowser("Target.targetDestroyed", { targetId: "T2" });
      await vi.advanceTimersByTimeAsync(200);
      expect(cdp.methods()).toEqual([]);
      expect(textsOf(viewer, "tabs")).toHaveLength(1);
      expectKept(ctx);
    });

    it("先頭のタブを閉じたら、直後のタブへ移る", async () => {
      const ctx = await startedWithTabs();
      const { cdp, viewer } = ctx;
      viewer.receive({ t: "tab", type: "close", id: "T1" });
      await flush();
      expect(cdp.last(ATTACH)?.params).toMatchObject({ targetId: "T2" });
      expect(textsOf(viewer, "tabs")).toEqual([tabsBody(["T2", "T3"], "T2")]);
      expectKept(ctx);
    });

    it("最後の1つを閉じたら、about:blankを作って移る", async () => {
      const ctx = await startedWithTabs(["T1"]);
      const { cdp, viewer } = ctx;
      viewer.receive({ t: "tab", type: "close", id: "T1" });
      await flush();
      expect(cdp.methods()).toEqual([
        STOP_CAST,
        DETACH,
        CLOSE_TARGET,
        CREATE_TARGET,
        ...ENTER_CALLS,
      ]);
      expect(cdp.last(CREATE_TARGET)?.params).toEqual({ url: "about:blank" });
      expect(cdp.last(ATTACH)?.params).toMatchObject({ targetId: "T-new" });
      expect(textsOf(viewer, "tabs")).toEqual([
        { t: "tabs", tabs: [BLANK_TAB], activeId: "T-new" },
      ]);
      expect(textsOf(viewer, "page")).toEqual([pageBody("about:blank", "")]);
      expectKept(ctx);
    });
  });

  describe("新しいタブ", () => {
    it("about:blankを作って切り替える", async () => {
      const ctx = await startedWithTabs(["T1", "T2"]);
      const { cdp, viewer } = ctx;
      viewer.receive({ t: "tab", type: "new" });
      await flush();
      expect(cdp.methods()).toEqual([
        CREATE_TARGET,
        STOP_CAST,
        DETACH,
        ...ENTER_CALLS,
      ]);
      expect(cdp.last(CREATE_TARGET)).toEqual({
        params: { url: "about:blank" },
        sessionId: undefined,
      });
      expect(cdp.last(ATTACH)?.params).toMatchObject({ targetId: "T-new" });
      expect(textsOf(viewer, "tabs")).toEqual([
        {
          t: "tabs",
          tabs: [tabOf("T1"), tabOf("T2"), BLANK_TAB],
          activeId: "T-new",
        },
      ]);
      // Chromiumが作ったと知らせてきても、二重には並べない
      cdp.emitBrowser("Target.targetCreated", {
        targetInfo: {
          targetId: "T-new",
          type: "page",
          url: "about:blank",
          title: "",
        },
      });
      await vi.advanceTimersByTimeAsync(200);
      expect(textsOf(viewer, "tabs")).toHaveLength(1);
      expectKept(ctx);
    });

    it("作れなければ、いまのタブのままにする", async () => {
      const ctx = await startedWithTabs(["T1", "T2"]);
      const { cdp, viewer } = ctx;
      cdp.failOn(CREATE_TARGET);
      viewer.receive({ t: "tab", type: "new" });
      await flush();
      expect(cdp.methods()).toEqual([CREATE_TARGET]);
      viewer.receive({ t: "paste", text: "x" });
      expect(cdp.last("Input.insertText")?.sessionId).toBe("S1");
      expectKept(ctx);
    });

    it("タブが20個あれば作らず、頼んだ視聴者にだけ理由を返す", async () => {
      const ids = Array.from({ length: 20 }, (_, i) => `T${i + 1}`);
      const { cdp, viewers } = await startedWithTabs(ids, 2);
      viewers[0].receive({ t: "tab", type: "new" });
      await flush();
      expect(cdp.methods()).toEqual([]);
      expect(viewers[0].texts()).toEqual([
        { t: "notice", message: "タブが多すぎます" },
      ]);
      expect(viewers[1].texts()).toEqual([]);
    });

    it("19個なら作れる。続けて頼まれたぶんは、20個になったあとは断る", async () => {
      const ids = Array.from({ length: 19 }, (_, i) => `T${i + 1}`);
      const { cdp, viewer } = await startedWithTabs(ids);
      viewer.receive({ t: "tab", type: "new" });
      viewer.receive({ t: "tab", type: "new" });
      await flush();
      await flush();
      expect(cdp.count(CREATE_TARGET)).toBe(1);
      expect(textsOf(viewer, "notice")).toHaveLength(1);
    });
  });

  describe("いまのタブが消えたとき", () => {
    it("ページが自分で閉じたら、視聴者を切らずに直前のタブへ移る", async () => {
      const ctx = await startedWithTabs();
      const { cdp, viewer } = ctx;
      viewer.receive({ t: "tab", type: "activate", id: "T3" });
      await flush();
      cdp.forget();
      viewer.send.mockClear();
      cdp.emitBrowser("Target.detachedFromTarget", {
        sessionId: "S2",
        targetId: "T3",
      });
      cdp.emitBrowser("Target.targetDestroyed", { targetId: "T3" });
      await flush();
      // 消えたsessionへは何も送らない
      expect(cdp.methods()).toEqual(ENTER_CALLS);
      expect(cdp.last(ATTACH)?.params).toMatchObject({ targetId: "T2" });
      expect(textsOf(viewer, "tabs")).toEqual([tabsBody(["T1", "T2"], "T2")]);
      expect(textsOf(viewer, "viewport")).toMatchObject([{ gen: 3 }]);
      cdp.emit("Page.screencastFrame", monitorFrame(1), "S3");
      await flush();
      expect(viewer.kinds()).toEqual([1]);
      await vi.advanceTimersByTimeAsync(200);
      expect(textsOf(viewer, "tabs")).toHaveLength(1);
      expectKept(ctx);
    });

    it("消えたことだけが先に届いても (detachの知らせが無くても) 移る", async () => {
      const ctx = await startedWithTabs();
      const { cdp } = ctx;
      cdp.emitBrowser("Target.targetDestroyed", { targetId: "T1" });
      await flush();
      expect(cdp.methods()).toEqual(ENTER_CALLS);
      expect(cdp.last(ATTACH)?.params).toMatchObject({ targetId: "T2" });
      expectKept(ctx);
    });

    it("消えたあいだの入力は捨て、ダイアログが開いていたら閉じたと知らせる", async () => {
      const { cdp, viewer } = await startedWithTabs();
      cdp.emit("Page.javascriptDialogOpening", { type: "alert", message: "m" });
      cdp.holdOn(ATTACH);
      viewer.send.mockClear();
      cdp.emitBrowser("Target.detachedFromTarget", { sessionId: "S1" });
      expect(textsOf(viewer, "dialogClosed")).toHaveLength(1);
      cdp.forget();
      viewer.receive({ t: "paste", text: "x" });
      await flush();
      expect(cdp.count("Input.insertText")).toBe(0);
    });

    it("クラッシュしたら、sessionを離し、そのタブを閉じてから隣のタブへ移る", async () => {
      const ctx = await startedWithTabs();
      const { cdp, viewer } = ctx;
      cdp.emit("Inspector.targetCrashed", undefined);
      await flush();
      expect(cdp.methods()).toEqual([
        STOP_CAST,
        DETACH,
        CLOSE_TARGET,
        ...ENTER_CALLS,
      ]);
      expect(cdp.last(CLOSE_TARGET)?.params).toEqual({ targetId: "T1" });
      expect(cdp.last(ATTACH)?.params).toMatchObject({ targetId: "T2" });
      expect(textsOf(viewer, "tabs")).toEqual([tabsBody(["T2", "T3"], "T2")]);
      expectKept(ctx);
    });

    it("選んだタブへつなげなければ次の候補へ、どれもだめならabout:blankを作る", async () => {
      const ctx = await startedWithTabs();
      const { cdp, viewer } = ctx;
      cdp.failOn(ACTIVATE);
      cdp.emitBrowser("Target.detachedFromTarget", { sessionId: "S1" });
      cdp.emitBrowser("Target.targetDestroyed", { targetId: "T1" });
      await flush();
      expect(cdp.count(ACTIVATE)).toBe(3);
      expect(cdp.count(CREATE_TARGET)).toBe(1);
      // 作ったタブへもつなげないので、接続が切れたときと同じに扱う
      expect(errorCount(viewer)).toBe(1);
      expect(viewer.close).toHaveBeenCalledTimes(1);
      expect(cdp.close).toHaveBeenCalled();
      expect(ctx.bridge.viewerCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("つなぐ途中で消えた候補は飛ばして、次の候補へ移る", async () => {
      const ctx = await startedWithTabs();
      const { cdp, viewer } = ctx;
      cdp.holdOn(ATTACH);
      viewer.receive({ t: "tab", type: "close", id: "T1" });
      await flush();
      expect(cdp.last(ATTACH)?.params).toMatchObject({ targetId: "T2" });
      cdp.emitBrowser("Target.targetDestroyed", { targetId: "T2" });
      cdp.stopHolding(ATTACH);
      cdp.fail(ATTACH);
      await flush();
      expect(cdp.last(ATTACH)?.params).toMatchObject({ targetId: "T3" });
      expect(textsOf(viewer, "tabs").at(-1)).toEqual(tabsBody(["T3"], "T3"));
      expectKept(ctx);
    });

    it("about:blankも作れなければ、視聴者へerrorを送って接続を閉じ、次のattachでつなぎ直す", async () => {
      const first = fakeCdp();
      const second = fakeCdp();
      const connect = vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second);
      const bridge = new BrowserCdpBridge(connect);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      first.failOn(CREATE_TARGET);
      first.emitBrowser("Target.detachedFromTarget", { sessionId: "S1" });
      first.emitBrowser("Target.targetDestroyed", { targetId: "T1" });
      await flush();
      expect(viewer.send).toHaveBeenCalledWith(ERROR_BODY);
      expect(viewer.close).toHaveBeenCalledWith(1011, expect.any(String));
      expect(first.close).toHaveBeenCalled();
      expect(bridge.viewerCount).toBe(0);
      first.disconnect();
      expect(errorCount(viewer)).toBe(1);
      bridge.attach(fakeViewer());
      await flush();
      expect(connect).toHaveBeenCalledTimes(2);
      expect(second.count(START_CAST)).toBe(1);
    });
  });
});

const EVALUATE = "Runtime.evaluate";
const BINDING_CALLED = "Runtime.bindingCalled";
const TOUCH_EMULATION = "Emulation.setTouchEmulationEnabled";
const TOUCH_EVENT = "Input.dispatchTouchEvent";
const SELECT_OPTIONS = [
  { label: "りんご", disabled: false, group: null },
  { label: "みかん", disabled: false, group: null },
  { label: "ぶどう", disabled: true, group: "果物" },
];
const SELECT_RECT = { x: 10, y: 20, width: 120, height: 24 };

/** ページのスクリプトがbindingを呼んだときのイベント。`pageId` はページの中のid */
function selectCalled(pageId: number, extra: Record<string, unknown> = {}) {
  return {
    name: "__arkSelect",
    payload: JSON.stringify({
      id: pageId,
      options: SELECT_OPTIONS,
      selectedIndex: 1,
      rect: SELECT_RECT,
      ...extra,
    }),
    executionContextId: 1,
  };
}

function selectBody(id: number) {
  return {
    t: "select",
    id,
    options: SELECT_OPTIONS,
    selectedIndex: 1,
    rect: SELECT_RECT,
  };
}

/** 次の `<select>` の知らせが受け付けられるところまで、時刻だけを進める (タイマーは動かさない) */
function nextSelectNotice(): void {
  vi.setSystemTime(Date.now() + SELECT_NOTIFY_INTERVAL_MS);
}

describe("BrowserCdpBridge: <select>", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    withoutPoll();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("タブの準備で、Runtimeを有効にしてからbindingを足し、スクリプトを入れる", async () => {
    const cdp = fakeCdp();
    const bridge = new BrowserCdpBridge(async () => cdp);
    bridge.attach(fakeViewer());
    await flush();
    const methods = cdp.methods();
    const order = [
      "Emulation.setDeviceMetricsOverride",
      "Runtime.enable",
      "Runtime.addBinding",
      "Page.addScriptToEvaluateOnNewDocument",
      EVALUATE,
      "Page.startScreencast",
    ].map(method => methods.indexOf(method));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order).not.toContain(-1);
    expect(cdp.last("Runtime.enable")).toEqual({
      params: undefined,
      sessionId: "S1",
    });
    expect(cdp.last("Runtime.addBinding")).toEqual({
      params: { name: "__arkSelect" },
      sessionId: "S1",
    });
    expect(cdp.last("Page.addScriptToEvaluateOnNewDocument")).toEqual({
      params: { source: SELECT_SHIM_SOURCE },
      sessionId: "S1",
    });
    expect(cdp.last(EVALUATE)).toEqual({
      params: {
        expression: SELECT_SHIM_SOURCE,
        awaitPromise: false,
        returnByValue: true,
        timeout: COPY_TIMEOUT_MS,
      },
      sessionId: "S1",
    });
  });

  it("いまの文書へスクリプトを入れる評価が返らなくても、準備は終わる", async () => {
    const cdp = fakeCdp();
    cdp.holdOn(EVALUATE);
    const bridge = new BrowserCdpBridge(async () => cdp);
    const viewer = fakeViewer();
    bridge.attach(viewer);
    await flush();
    expect(cdp.count("Page.startScreencast")).toBe(1);
    expect(textsOf(viewer, "tabs")).toHaveLength(1);
  });

  it("ページの知らせを、ブリッジが振った番号で全員へ送る", async () => {
    const { cdp, viewers } = await started(2);
    cdp.emit(BINDING_CALLED, selectCalled(7));
    for (const viewer of viewers) {
      expect(viewer.texts()).toEqual([selectBody(1)]);
    }
    expect(cdp.methods()).toEqual([]);
  });

  it("送信が詰まっている視聴者へは、選択肢も、その選択が閉じたことも送らない", async () => {
    const { cdp, viewers } = await started(2);
    const [open, stuck] = viewers;
    stuck.bufferedAmount = BACKPRESSURE_BYTES;
    cdp.emit(BINDING_CALLED, selectCalled(7));
    expect(open.texts()).toEqual([selectBody(1)]);
    expect(stuck.texts()).toEqual([]);

    // 空いても、知らせていない選択の閉じたことは送らない
    stuck.bufferedAmount = 0;
    open.receive({ t: "selectCancel", id: 1 });
    expect(open.texts().at(-1)).toEqual({ t: "selectClosed", id: 1 });
    expect(stuck.texts()).toEqual([]);

    // 次の選択は届き、その閉じたことも届く
    nextSelectNotice();
    cdp.emit(BINDING_CALLED, selectCalled(8));
    open.receive({ t: "selectCancel", id: 2 });
    expect(stuck.texts()).toEqual([
      selectBody(2),
      { t: "selectClosed", id: 2 },
    ]);
    expect(stuck.close).not.toHaveBeenCalled();
    expect(stuck.terminate).not.toHaveBeenCalled();
  });

  it("詰まっている視聴者が入ったときも、開いている選択は送らない", async () => {
    const { cdp, bridge } = await started();
    cdp.emit(BINDING_CALLED, selectCalled(7));
    const late = fakeViewer();
    late.bufferedAmount = BACKPRESSURE_BYTES;
    bridge.attach(late);
    await flush();
    expect(textsOf(late, "select")).toEqual([]);
    expect(textsOf(late, "tabs")).toHaveLength(1);
  });

  it("ページが大きな知らせを続けて呼んでも、詰まった視聴者には積もらず、ほかの視聴者へも間隔を空ける", async () => {
    const { cdp, viewers } = await started(2);
    const [open, stuck] = viewers;
    stuck.bufferedAmount = BACKPRESSURE_BYTES;
    const large = {
      options: Array.from({ length: 1000 }, () => ({
        label: "x".repeat(500),
        disabled: false,
        group: null,
      })),
      selectedIndex: 0,
    };
    for (let i = 0; i < 20; i++) {
      cdp.emit(BINDING_CALLED, selectCalled(i, large));
    }
    expect(textsOf(open, "select")).toHaveLength(1);
    for (let i = 0; i < 20; i++) {
      nextSelectNotice();
      cdp.emit(BINDING_CALLED, selectCalled(100 + i, large));
    }
    expect(textsOf(open, "select")).toHaveLength(21);
    const queued = stuck.send.mock.calls.reduce(
      (sum, [data]) => sum + Buffer.byteLength(data as string | Buffer),
      0
    );
    expect(queued).toBe(0);
    expect(stuck.close).not.toHaveBeenCalled();
  });

  it("別のsessionの知らせと、別の名前のbindingは無視する", async () => {
    const { cdp, viewer } = await started();
    cdp.emit(BINDING_CALLED, selectCalled(7), "S9");
    cdp.emitBrowser(BINDING_CALLED, selectCalled(7));
    cdp.emit(BINDING_CALLED, { ...selectCalled(7), name: "__other" });
    expect(viewer.texts()).toEqual([]);
  });

  it.each([
    ["JSONでないペイロード", { name: "__arkSelect", payload: "{" }],
    ["文字列でないペイロード", { name: "__arkSelect", payload: { id: 1 } }],
    [
      "多すぎる選択肢",
      selectCalled(7, {
        options: Array.from({ length: 1001 }, () => SELECT_OPTIONS[0]),
      }),
    ],
    ["選択肢の無い知らせ", selectCalled(7, { options: [], selectedIndex: -1 })],
    [
      "有限でない位置",
      selectCalled(7, { rect: { x: null, y: 0, width: 1, height: 1 } }),
    ],
  ])("%s を捨てる", async (_name, params) => {
    const { cdp, viewer } = await started();
    cdp.emit(BINDING_CALLED, params);
    expect(viewer.texts()).toEqual([]);
    expect(cdp.methods()).toEqual([]);
  });

  it("長いラベルを切り、位置をビューポートの中へ収める", async () => {
    const { cdp, viewer } = await started();
    cdp.emit(
      BINDING_CALLED,
      selectCalled(7, {
        options: [{ label: "x".repeat(600), disabled: false, group: null }],
        selectedIndex: 0,
        rect: { x: 1200, y: -10, width: 200, height: 30 },
      })
    );
    const [message] = viewer.texts() as Array<{
      options: Array<{ label: string }>;
      rect: unknown;
    }>;
    expect(message.options[0].label).toHaveLength(500);
    expect(message.rect).toEqual({ x: 1200, y: 0, width: 80, height: 20 });
  });

  it("選ぶと、数だけを埋めた式を評価し、全員へ閉じたと知らせる", async () => {
    const { cdp, viewers } = await started(2);
    cdp.emit(BINDING_CALLED, selectCalled(7));
    viewers[1].receive({ t: "selectChoose", id: 1, index: 0 });
    expect(cdp.methods()).toEqual([EVALUATE]);
    expect(cdp.last(EVALUATE)).toEqual({
      params: {
        expression: "window.__arkSelectChoose(7, 0)",
        awaitPromise: false,
        returnByValue: true,
        timeout: COPY_TIMEOUT_MS,
      },
      sessionId: "S1",
    });
    for (const viewer of viewers) {
      expect(viewer.texts()).toEqual([
        selectBody(1),
        { t: "selectClosed", id: 1 },
      ]);
    }
  });

  it("評価が失敗しても、返らなくても、閉じる", async () => {
    const { cdp, viewer } = await started();
    cdp.failOn(EVALUATE);
    cdp.emit(BINDING_CALLED, selectCalled(7));
    viewer.receive({ t: "selectChoose", id: 1, index: 0 });
    await flush();
    cdp.stopFailing(EVALUATE);
    cdp.holdOn(EVALUATE);
    nextSelectNotice();
    cdp.emit(BINDING_CALLED, selectCalled(8));
    viewer.receive({ t: "selectChoose", id: 2, index: 0 });
    await flush();
    expect(textsOf(viewer, "selectClosed")).toEqual([
      { t: "selectClosed", id: 1 },
      { t: "selectClosed", id: 2 },
    ]);
    expect(errorCount(viewer)).toBe(0);
  });

  it.each([
    ["古い番号", { id: 1, index: 0 }],
    ["ページの中のid", { id: 8, index: 0 }],
    ["範囲外の添字", { id: 2, index: 3 }],
    ["無効な選択肢", { id: 2, index: 2 }],
  ])("%s での選択は無視する", async (_name, choice) => {
    const { cdp, viewer } = await started();
    cdp.emit(BINDING_CALLED, selectCalled(7));
    nextSelectNotice();
    cdp.emit(BINDING_CALLED, selectCalled(8));
    viewer.send.mockClear();
    viewer.receive({ t: "selectChoose", ...choice });
    expect(cdp.methods()).toEqual([]);
    expect(viewer.texts()).toEqual([]);
  });

  it("開いている間の新しい知らせは、前のものを閉じてから置き換える", async () => {
    const { cdp, viewer } = await started();
    cdp.emit(BINDING_CALLED, selectCalled(7));
    nextSelectNotice();
    cdp.emit(BINDING_CALLED, selectCalled(8));
    expect(viewer.texts()).toEqual([
      selectBody(1),
      { t: "selectClosed", id: 1 },
      selectBody(2),
    ]);
  });

  it("取り消すと、ページの中の要素を捨てさせ、全員へ閉じたと知らせる", async () => {
    const { cdp, viewers } = await started(2);
    cdp.emit(BINDING_CALLED, selectCalled(7));
    viewers[0].receive({ t: "selectCancel", id: 1 });
    expect(cdp.last(EVALUATE)?.params).toMatchObject({
      expression: "window.__arkSelectCancel(7)",
    });
    expect(viewers[1].texts().at(-1)).toEqual({ t: "selectClosed", id: 1 });
    // 閉じたあとの選択は無視する
    cdp.forget();
    viewers[1].receive({ t: "selectChoose", id: 1, index: 0 });
    expect(cdp.methods()).toEqual([]);
  });

  it("メインフレームが遷移したら閉じる。iframeの遷移では閉じない", async () => {
    const { cdp, viewer } = await started();
    cdp.emit(BINDING_CALLED, selectCalled(7));
    cdp.emit(NAVIGATED, { frame: { id: "F2", parentId: "T1", url: A_URL } });
    expect(textsOf(viewer, "selectClosed")).toEqual([]);
    cdp.emit(NAVIGATED, navigatedTo(A_URL));
    expect(viewer.texts().slice(0, 2)).toEqual([
      selectBody(1),
      { t: "selectClosed", id: 1 },
    ]);
    cdp.forget();
    viewer.receive({ t: "selectChoose", id: 1, index: 0 });
    expect(cdp.count(EVALUATE)).toBe(0);
  });

  it("ダイアログが開いたら閉じる", async () => {
    const { cdp, viewer } = await started();
    cdp.emit(BINDING_CALLED, selectCalled(7));
    cdp.emit("Page.javascriptDialogOpening", { type: "alert", message: "m" });
    expect(viewer.texts().map(m => (m as { t: string }).t)).toEqual([
      "select",
      "selectClosed",
      "dialog",
    ]);
  });

  it("タブを切り替えたら閉じ、次のタブでは続きの番号を振る", async () => {
    const { cdp, viewer } = await startedWithTabs();
    cdp.emit(BINDING_CALLED, selectCalled(7));
    viewer.receive({ t: "tab", type: "activate", id: "T2" });
    expect(viewer.texts()).toEqual([
      selectBody(1),
      { t: "selectClosed", id: 1 },
    ]);
    await flush();
    viewer.send.mockClear();
    cdp.forget();
    // 前のタブのsessionから遅れて届いた知らせは使わない
    cdp.emit(BINDING_CALLED, selectCalled(9), "S1");
    // 前のタブの番号では選べない
    viewer.receive({ t: "selectChoose", id: 1, index: 0 });
    expect(viewer.texts()).toEqual([]);
    cdp.emit(BINDING_CALLED, selectCalled(0), "S2");
    expect(viewer.texts()).toEqual([selectBody(2)]);
    viewer.receive({ t: "selectChoose", id: 2, index: 0 });
    expect(cdp.last(EVALUATE)).toMatchObject({
      params: { expression: "window.__arkSelectChoose(0, 0)" },
      sessionId: "S2",
    });
  });

  it("切り替えの途中の選択と、準備の途中の知らせは捨てる", async () => {
    const { cdp, viewer } = await startedWithTabs();
    cdp.holdOn("Emulation.setDeviceMetricsOverride");
    viewer.receive({ t: "tab", type: "activate", id: "T2" });
    await flush();
    viewer.send.mockClear();
    cdp.emit(BINDING_CALLED, selectCalled(3), "S2");
    viewer.receive({ t: "selectChoose", id: 1, index: 0 });
    viewer.receive({ t: "selectCancel", id: 1 });
    cdp.release("Emulation.setDeviceMetricsOverride");
    await flush();
    expect(textsOf(viewer, "select")).toEqual([]);
    // 評価したのは、新しいタブへスクリプトを入れる1回だけ
    expect(cdp.count(EVALUATE)).toBe(1);
    expect(cdp.last(EVALUATE)?.params).toMatchObject({
      expression: SELECT_SHIM_SOURCE,
    });
  });

  it("接続が切れたら、閉じたと知らせてからerrorを送る", async () => {
    const { cdp, viewer } = await started();
    cdp.emit(BINDING_CALLED, selectCalled(7));
    cdp.disconnect();
    expect(viewer.texts()).toEqual([
      selectBody(1),
      { t: "selectClosed", id: 1 },
      JSON.parse(ERROR_BODY),
    ]);
  });

  it("開いている間に入った視聴者へ、寸法、ページの状態、タブの一覧、選択の順に知らせる", async () => {
    const { cdp, bridge, viewer } = await startedOn(0, [A_URL]);
    cdp.emit(BINDING_CALLED, selectCalled(7));
    const late = fakeViewer();
    bridge.attach(late);
    await flush();
    expect(late.texts()).toEqual([
      { t: "viewport", width: 1280, height: 900, gen: 1 },
      pageBody(A_URL, "T0"),
      ONE_TAB,
      selectBody(1),
    ]);
    expect(viewer.texts()).toEqual([selectBody(1)]);
  });

  it("閉じたあとに入った視聴者へは知らせない", async () => {
    const { cdp, bridge, viewer } = await started();
    cdp.emit(BINDING_CALLED, selectCalled(7));
    viewer.receive({ t: "selectCancel", id: 1 });
    const late = fakeViewer();
    bridge.attach(late);
    await flush();
    expect(textsOf(late, "select")).toEqual([]);
  });
});

describe("BrowserCdpBridge: タッチ", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    withoutPoll();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const touch = {
    t: "touch",
    type: "start",
    points: [{ id: 0, x: 10.4, y: 20.6 }],
    modifiers: 0,
  };
  const resize = (mobile: boolean, width = 400) => ({
    t: "resize",
    width,
    height: 800,
    dpr: 2,
    mobile,
  });
  const TOUCH_ON = { enabled: true, maxTouchPoints: 5 };

  it("タッチを、映しているタブのタッチのイベントへ変換する", async () => {
    const { cdp, viewer } = await started();
    viewer.receive(touch);
    viewer.receive({ ...touch, type: "end", points: [] });
    expect(cdp.methods()).toEqual([TOUCH_EVENT, TOUCH_EVENT]);
    expect(cdp.last(TOUCH_EVENT)).toEqual({
      params: { type: "touchEnd", touchPoints: [], modifiers: 0 },
      sessionId: "S1",
    });
    viewer.receive(touch);
    expect(cdp.last(TOUCH_EVENT)?.params).toEqual({
      type: "touchStart",
      touchPoints: [{ x: 10, y: 21, id: 0 }],
      modifiers: 0,
    });
  });

  it("タッチの失敗で視聴者を切らない", async () => {
    const { cdp, viewer, bridge } = await started();
    cdp.failOn(TOUCH_EVENT);
    viewer.receive(touch);
    await flush();
    expect(bridge.viewerCount).toBe(1);
    expect(errorCount(viewer)).toBe(0);
  });

  it("切り替えの途中のタッチは捨てる", async () => {
    const { cdp, viewer } = await startedWithTabs();
    cdp.holdOn("Target.attachToTarget");
    viewer.receive({ t: "tab", type: "activate", id: "T2" });
    await flush();
    viewer.receive(touch);
    cdp.release("Target.attachToTarget");
    await flush();
    expect(cdp.count(TOUCH_EVENT)).toBe(0);
  });

  it("mobileでなければ、タブの準備で、寸法のあとにタッチのエミュレーションを無効にする", async () => {
    const cdp = fakeCdp();
    const bridge = new BrowserCdpBridge(async () => cdp);
    bridge.attach(fakeViewer());
    await vi.runAllTimersAsync();
    const methods = cdp.methods();
    expect(methods.indexOf(TOUCH_EMULATION)).toBe(
      methods.indexOf("Emulation.setDeviceMetricsOverride") + 1
    );
    expect(cdp.calls(TOUCH_EMULATION)).toEqual([
      { method: TOUCH_EMULATION, params: { enabled: false }, sessionId: "S1" },
    ]);
  });

  it("mobileなら、タブの準備で、寸法のあとにタッチのエミュレーションを有効にする", async () => {
    const cdp = fakeCdp();
    const bridge = new BrowserCdpBridge(async () => cdp);
    const viewer = fakeViewer();
    bridge.attach(viewer);
    viewer.receive(resize(true));
    await vi.runAllTimersAsync();
    const methods = cdp.methods();
    expect(methods.indexOf(TOUCH_EMULATION)).toBe(
      methods.indexOf("Emulation.setDeviceMetricsOverride") + 1
    );
    expect(cdp.count(TOUCH_EMULATION)).toBe(1);
    expect(cdp.last(TOUCH_EMULATION)).toEqual({
      params: TOUCH_ON,
      sessionId: "S1",
    });
  });

  it("寸法の適用でmobileが変わったときだけ、有効、無効を切り替える", async () => {
    const { cdp, viewer } = await started();
    viewer.receive(resize(true));
    await vi.advanceTimersByTimeAsync(150);
    expect(cdp.count(TOUCH_EMULATION)).toBe(1);
    expect(cdp.last(TOUCH_EMULATION)).toEqual({
      params: TOUCH_ON,
      sessionId: "S1",
    });
    // mobileのまま寸法だけが変わった
    viewer.receive(resize(true, 500));
    await vi.advanceTimersByTimeAsync(150);
    expect(cdp.count("Emulation.setDeviceMetricsOverride")).toBe(2);
    expect(cdp.count(TOUCH_EMULATION)).toBe(1);
    viewer.receive(resize(false, 500));
    await vi.advanceTimersByTimeAsync(150);
    expect(cdp.count(TOUCH_EMULATION)).toBe(2);
    expect(cdp.last(TOUCH_EMULATION)?.params).toEqual({ enabled: false });
    // mobileでないまま寸法だけが変わった
    viewer.receive(resize(false, 600));
    await vi.advanceTimersByTimeAsync(150);
    expect(cdp.count(TOUCH_EMULATION)).toBe(2);
  });

  it("mobileのままタブを替えたら、新しいタブでも有効にする", async () => {
    const { cdp, viewer } = await startedWithTabs();
    viewer.receive(resize(true));
    await vi.advanceTimersByTimeAsync(150);
    cdp.forget();
    viewer.receive({ t: "tab", type: "activate", id: "T2" });
    await flush();
    expect(cdp.count(TOUCH_EMULATION)).toBe(1);
    expect(cdp.last(TOUCH_EMULATION)).toEqual({
      params: TOUCH_ON,
      sessionId: "S2",
    });
  });

  it("準備の途中でmobileになったら、準備が終わったときに有効にする", async () => {
    const cdp = fakeCdp();
    cdp.holdOn("Runtime.addBinding");
    const bridge = new BrowserCdpBridge(async () => cdp);
    const viewer = fakeViewer();
    bridge.attach(viewer);
    await flush();
    viewer.receive(resize(true));
    await vi.advanceTimersByTimeAsync(150);
    // 準備では、そのときの寸法 (mobileでない) に合わせて無効にしてある
    expect(cdp.calls(TOUCH_EMULATION).map(call => call.params)).toEqual([
      { enabled: false },
    ]);
    cdp.release("Runtime.addBinding");
    await flush();
    expect(cdp.count(TOUCH_EMULATION)).toBe(2);
    expect(cdp.last(TOUCH_EMULATION)?.params).toEqual(TOUCH_ON);
  });

  it("有効にできなくても視聴者を切らず、次に寸法を当てるときに送り直す", async () => {
    const { cdp, viewer, bridge } = await started();
    cdp.failOn(TOUCH_EMULATION);
    viewer.receive(resize(true));
    await vi.advanceTimersByTimeAsync(150);
    expect(bridge.viewerCount).toBe(1);
    expect(errorCount(viewer)).toBe(0);
    cdp.stopFailing(TOUCH_EMULATION);
    viewer.receive(resize(true, 500));
    await vi.advanceTimersByTimeAsync(150);
    expect(cdp.count(TOUCH_EMULATION)).toBe(2);
    expect(cdp.last(TOUCH_EMULATION)?.params).toEqual(TOUCH_ON);
  });
});

describe("BrowserCdpBridge: 応答が返らないタブ", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    withoutPoll();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** 視聴者を切らず、接続も捨てずに、`targetId` のタブ (session `sessionId`) を映している */
  function expectShowing(
    ctx: Awaited<ReturnType<typeof startedWithTabs>>,
    targetId: string,
    sessionId: string
  ) {
    const { cdp, viewer, bridge, connect } = ctx;
    expect(errorCount(viewer)).toBe(0);
    expect(viewer.close).not.toHaveBeenCalled();
    expect(viewer.terminate).not.toHaveBeenCalled();
    expect(bridge.viewerCount).toBe(1);
    expect(cdp.close).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(cdp.last(ATTACH)?.params).toMatchObject({ targetId });
    expect(cdp.last(START_CAST)?.sessionId).toBe(sessionId);
    expect(textsOf(viewer, "tabs").at(-1)).toMatchObject({
      activeId: targetId,
    });
    // 入力が届く
    cdp.forget();
    viewer.receive({ t: "paste", text: "x" });
    expect(cdp.last("Input.insertText")?.sessionId).toBe(sessionId);
  }

  describe("準備の途中で消えたタブ", () => {
    it("Page.enableの応答が二度と返らなくても、もとのタブへ戻り、視聴者を切らない", async () => {
      const ctx = await startedWithTabs();
      const { cdp, viewer } = ctx;
      cdp.holdOn("Page.enable");
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      await flush();
      expect(cdp.last("Page.enable")?.sessionId).toBe("S2");
      cdp.stopHolding("Page.enable");
      cdp.emitBrowser("Target.detachedFromTarget", {
        sessionId: "S2",
        targetId: "T2",
      });
      cdp.emitBrowser("Target.targetDestroyed", { targetId: "T2" });
      await flush();
      // 消えたsessionへは、準備の続きも、離れるためのコマンドも送らない
      expect(cdp.count("Emulation.setFocusEmulationEnabled")).toBe(1);
      expect(
        cdp.methods().filter(method => method === DETACH || method === ATTACH)
      ).toEqual([DETACH, ATTACH, ATTACH]);
      expectShowing(ctx, "T1", "S3");
      await vi.advanceTimersByTimeAsync(5000);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("消えたという知らせしか届かなくても、応答を待たずに戻り、待っていたコマンドを片づける", async () => {
      const ctx = await startedWithTabs();
      const { cdp, viewer } = ctx;
      cdp.holdOn("Page.enable");
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      await flush();
      cdp.stopHolding("Page.enable");
      cdp.emitBrowser("Target.targetDestroyed", { targetId: "T2" });
      await flush();
      expect(cdp.rejected()).toContain("S2");
      expectShowing(ctx, "T1", "S3");
      await vi.advanceTimersByTimeAsync(5000);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("最初のタブの準備の途中で消えて応答が返らなくても、作ったタブを映す", async () => {
      const cdp = fakeCdp();
      cdp.holdOn("Page.enable");
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      cdp.stopHolding("Page.enable");
      cdp.emitBrowser("Target.detachedFromTarget", { sessionId: "S1" });
      cdp.emitBrowser("Target.targetDestroyed", { targetId: "T1" });
      await flush();
      expect(errorCount(viewer)).toBe(0);
      expect(bridge.viewerCount).toBe(1);
      expect(cdp.last(ATTACH)?.params).toMatchObject({ targetId: "T-new" });
      expect(cdp.last(START_CAST)?.sessionId).toBe("S2");
      await vi.advanceTimersByTimeAsync(5000);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("時間切れ", () => {
    it.each([
      "Page.enable",
      "Emulation.setFocusEmulationEnabled",
      "Emulation.setDeviceMetricsOverride",
      TOUCH_EMULATION,
    ])(
      "%s が3秒返らなければ、そのタブをあきらめて、もとのタブへ戻る",
      async method => {
        const ctx = await startedWithTabs();
        const { cdp, viewer } = ctx;
        cdp.holdOn(method);
        viewer.receive({ t: "tab", type: "activate", id: "T2" });
        await flush();
        cdp.stopHolding(method);
        await vi.advanceTimersByTimeAsync(2999);
        expect(cdp.count(ATTACH)).toBe(1);
        // 待っている間の入力は捨てる
        viewer.receive({ t: "paste", text: "x" });
        expect(cdp.count("Input.insertText")).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
        // あきらめたタブのsessionは離す
        expect(cdp.calls(DETACH).map(call => call.params)).toEqual([
          { sessionId: "S1" },
          { sessionId: "S2" },
        ]);
        expect(cdp.rejected()).toContain("S2");
        expectShowing(ctx, "T1", "S3");
        await vi.advanceTimersByTimeAsync(5000);
        expect(vi.getTimerCount()).toBe(0);
      }
    );

    it("前面にするコマンドが返らなければ、次の候補へ進む", async () => {
      const ctx = await startedWithTabs();
      const { cdp, viewer } = ctx;
      cdp.holdOn(ACTIVATE);
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      await flush();
      cdp.stopHolding(ACTIVATE);
      await vi.advanceTimersByTimeAsync(3000);
      expect(cdp.count(ATTACH)).toBe(1);
      expectShowing(ctx, "T1", "S2");
      await vi.advanceTimersByTimeAsync(5000);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("つなぐコマンドが返らなければ次の候補へ進み、遅れて付いたsessionは離す", async () => {
      const ctx = await startedWithTabs();
      const { cdp, viewer } = ctx;
      cdp.holdOn(ATTACH);
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      await flush();
      cdp.stopHolding(ATTACH);
      await vi.advanceTimersByTimeAsync(3000);
      expectShowing(ctx, "T1", "S3");
      cdp.forget();
      cdp.release(ATTACH);
      await flush();
      expect(cdp.calls(DETACH).map(call => call.params)).toEqual([
        { sessionId: "S2" },
      ]);
      expect(ctx.bridge.viewerCount).toBe(1);
    });

    it("どのタブも返らなければ、作ったタブまで試してから、視聴者へerrorを1回送る", async () => {
      const cdp = fakeCdp({ targets: [target("T1"), target("T2")] });
      cdp.holdOn("Page.enable");
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await vi.advanceTimersByTimeAsync(3000 * 3);
      expect(cdp.calls(ATTACH).map(call => call.params)).toMatchObject([
        { targetId: "T1" },
        { targetId: "T2" },
        { targetId: "T-new" },
      ]);
      expect(errorCount(viewer)).toBe(1);
      expect(bridge.viewerCount).toBe(0);
      expect(cdp.close).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("準備の途中で接続を捨てたら、タイマーを残さない", async () => {
      const cdp = fakeCdp();
      cdp.holdOn("Page.enable");
      const bridge = new BrowserCdpBridge(async () => cdp);
      bridge.attach(fakeViewer());
      await flush();
      expect(vi.getTimerCount()).toBe(1);
      bridge.reset();
      expect(vi.getTimerCount()).toBe(0);
      cdp.disconnect();
      await flush();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("前面にするコマンドを待つ間に接続を捨てても、タイマーを残さない", async () => {
      const cdp = fakeCdp();
      cdp.holdOn(ACTIVATE);
      const bridge = new BrowserCdpBridge(async () => cdp);
      bridge.attach(fakeViewer());
      await flush();
      expect(vi.getTimerCount()).toBe(1);
      bridge.reset();
      expect(vi.getTimerCount()).toBe(0);
      cdp.disconnect();
      await flush();
    });
  });

  describe("応答が返らない、ブラウザへのコマンド", () => {
    it("閉じるコマンドが返らなくても、時間切れのあとに、続く操作を行う", async () => {
      const ctx = await startedWithTabs();
      const { cdp, viewer } = ctx;
      cdp.holdOn(CLOSE_TARGET);
      viewer.receive({ t: "tab", type: "close", id: "T3" });
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      await vi.advanceTimersByTimeAsync(ENTER_STEP_TIMEOUT_MS - 1);
      expect(cdp.count(CLOSE_TARGET)).toBe(1);
      expect(cdp.count(ATTACH)).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expectShowing(ctx, "T2", "S2");
      // 閉じられたか分からないので、一覧をChromiumから取り直す
      await vi.advanceTimersByTimeAsync(1000);
      expect(cdp.count("Target.getTargets")).toBe(1);
      expect(textsOf(viewer, "tabs").at(-1)).toEqual(
        tabsBody(["T1", "T2", "T3"], "T2")
      );
      expect(vi.getTimerCount()).toBe(0);
    });

    it("新しいタブを作るコマンドが返らなければ、いまのタブを映したまま、続く操作を行う", async () => {
      const ctx = await startedWithTabs();
      const { cdp, viewer } = ctx;
      cdp.holdOn(CREATE_TARGET);
      viewer.receive({ t: "tab", type: "new" });
      viewer.receive({ t: "tab", type: "close", id: "T3" });
      await vi.advanceTimersByTimeAsync(ENTER_STEP_TIMEOUT_MS - 1);
      expect(cdp.count(CLOSE_TARGET)).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(cdp.last(CLOSE_TARGET)?.params).toEqual({ targetId: "T3" });
      expect(cdp.count(ATTACH)).toBe(0);
      expect(errorCount(viewer)).toBe(0);
      expect(ctx.bridge.viewerCount).toBe(1);
    });

    it("前面へ戻すコマンドが返らなくても、続く操作を行う", async () => {
      const ctx = await startedWithTabs();
      const { cdp, viewer } = ctx;
      cdp.holdOn(ACTIVATE);
      // ほかのタブが開いたタブ。切り替えず、映しているタブを前面へ戻す
      cdp.emitBrowser("Target.targetCreated", {
        targetInfo: target("T4", { openerId: "T2" }),
      });
      await flush();
      expect(cdp.last(ACTIVATE)?.params).toEqual({ targetId: "T1" });
      viewer.receive({ t: "tab", type: "close", id: "T3" });
      await vi.advanceTimersByTimeAsync(ENTER_STEP_TIMEOUT_MS - 1);
      expect(cdp.count(CLOSE_TARGET)).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(cdp.count(CLOSE_TARGET)).toBe(1);
      expect(errorCount(viewer)).toBe(0);
    });

    it("一覧の取り直しが返らなくても、続く操作を行う", async () => {
      const ctx = await startedWithTabs();
      const { cdp, viewer } = ctx;
      cdp.failOn(CLOSE_TARGET);
      cdp.holdOn("Target.getTargets");
      viewer.receive({ t: "tab", type: "close", id: "T3" });
      await vi.advanceTimersByTimeAsync(200);
      expect(cdp.count("Target.getTargets")).toBe(1);
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      await vi.advanceTimersByTimeAsync(ENTER_STEP_TIMEOUT_MS - 1);
      expect(cdp.count(ATTACH)).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expectShowing(ctx, "T2", "S2");
    });

    it("最初の一覧が返らなければ、視聴者へerrorを1回送り、タイマーを残さない", async () => {
      const cdp = fakeCdp();
      cdp.holdOn("Target.getTargets");
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await vi.advanceTimersByTimeAsync(ENTER_STEP_TIMEOUT_MS);
      expect(errorCount(viewer)).toBe(1);
      expect(bridge.viewerCount).toBe(0);
      expect(cdp.close).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("待っている間に接続が切れても、resetしても、タイマーを残さない", async () => {
      for (const drop of ["disconnect", "reset"] as const) {
        const { cdp, bridge, viewer } = await startedWithTabs();
        cdp.holdOn(CLOSE_TARGET);
        viewer.receive({ t: "tab", type: "close", id: "T3" });
        await flush();
        expect(vi.getTimerCount()).toBe(1);
        if (drop === "reset") bridge.reset();
        cdp.disconnect();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(ENTER_STEP_TIMEOUT_MS * 2);
        expect(vi.getTimerCount()).toBe(0);
      }
    });
  });

  describe("タブから離れるとき", () => {
    it("離れるsessionで待っているコマンドを片づけてから、止める、離れるを送る", async () => {
      const { cdp, viewer } = await startedWithTabs();
      cdp.holdOn("Input.insertText");
      viewer.receive({ t: "paste", text: "x" });
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      await flush();
      expect(cdp.rejected()).toEqual(["S1"]);
      expect(cdp.count(STOP_CAST)).toBe(1);
      // sessionが切り離されたための失敗は、記録しない
      expect(console.warn).not.toHaveBeenCalled();
    });

    it("sessionが切り離されて失敗した履歴の読み直しは、記録もやり直しもしない", async () => {
      const cdp = fakeCdp({ targets: [target("T1"), target("T2")] });
      cdp.holdOn(HISTORY);
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      cdp.stopHolding(HISTORY);
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      await vi.advanceTimersByTimeAsync(2000);
      expect(cdp.count(HISTORY)).toBe(2);
      expect(console.warn).not.toHaveBeenCalled();
    });
  });

  describe("screencastを始められなかったタブ", () => {
    it("切り替えた直後に始められなければ、視聴者を切らずに、もとのタブへ戻る", async () => {
      const ctx = await startedWithTabs();
      const { cdp, viewer } = ctx;
      cdp.holdOn(START_CAST);
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      await flush();
      cdp.stopHolding(START_CAST);
      cdp.fail(START_CAST);
      await flush();
      expect(cdp.calls(DETACH).map(call => call.params)).toEqual([
        { sessionId: "S1" },
        { sessionId: "S2" },
      ]);
      expectShowing(ctx, "T1", "S3");
    });

    it("始められなかったタブへは戻らず、どこでも始められなければ、作ったタブまで試してerrorを1回送る", async () => {
      const cdp = fakeCdp({ targets: [target("T1"), target("T2")] });
      cdp.failOn(START_CAST);
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      expect(cdp.calls(ATTACH).map(call => call.params)).toMatchObject([
        { targetId: "T1" },
        { targetId: "T2" },
        { targetId: "T-new" },
      ]);
      expect(cdp.count(CREATE_TARGET)).toBe(1);
      expect(errorCount(viewer)).toBe(1);
      expect(viewer.close).toHaveBeenCalledTimes(1);
      expect(bridge.viewerCount).toBe(0);
      expect(cdp.close).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("始められたあとは、前に始められなかったタブへも戻れる", async () => {
      const ctx = await startedWithTabs(["T1", "T2"]);
      const { cdp, viewer } = ctx;
      cdp.holdOn(START_CAST);
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      await flush();
      // T2では始められず、T1へ戻って始められた
      cdp.fail(START_CAST);
      await flush();
      cdp.release(START_CAST);
      cdp.stopHolding(START_CAST);
      await flush();
      // T1が消えたら、T2へ移る
      cdp.emitBrowser("Target.detachedFromTarget", { sessionId: "S3" });
      cdp.emitBrowser("Target.targetDestroyed", { targetId: "T1" });
      await flush();
      expect(cdp.count(CREATE_TARGET)).toBe(0);
      expectShowing(ctx, "T2", "S4");
    });
  });

  describe("ダイアログが開いている間のタブの操作", () => {
    it("切り替えと新しいタブを断って理由を返し、閉じたら受ける", async () => {
      const ctx = await startedWithTabs(["T1", "T2"], 2);
      const { cdp, viewers } = ctx;
      const [viewer, other] = viewers;
      cdp.emit("Page.javascriptDialogOpening", { type: "alert", message: "m" });
      for (const each of viewers) each.send.mockClear();
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      viewer.receive({ t: "tab", type: "new" });
      await flush();
      const notice = {
        t: "notice",
        message: "ダイアログに応答してから切り替えてください",
      };
      expect(viewer.texts()).toEqual([notice, notice]);
      expect(other.texts()).toEqual([]);
      expect(cdp.methods()).toEqual([]);
      cdp.emit("Page.javascriptDialogClosed", {});
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      await flush();
      expect(cdp.last(ATTACH)?.params).toMatchObject({ targetId: "T2" });
    });

    it("映しているタブは閉じられる", async () => {
      const { cdp, viewer } = await startedWithTabs(["T1", "T2"]);
      cdp.emit("Page.javascriptDialogOpening", { type: "alert", message: "m" });
      viewer.send.mockClear();
      viewer.receive({ t: "tab", type: "close", id: "T1" });
      await flush();
      expect(cdp.last(CLOSE_TARGET)?.params).toEqual({ targetId: "T1" });
      expect(cdp.last(ATTACH)?.params).toMatchObject({ targetId: "T2" });
      expect(textsOf(viewer, "notice")).toEqual([]);
      expect(textsOf(viewer, "dialogClosed")).toHaveLength(1);
    });
  });

  describe("切り替えないタブができたとき", () => {
    it("映しているタブを前面へ戻し、鮮明な全画面を送り直す", async () => {
      const { cdp, viewers } = await startedWithTabs(["T1", "T2"], 2);
      cdp.emitBrowser("Target.targetCreated", {
        targetInfo: target("T9"),
      });
      await flush();
      expect(cdp.methods()).toEqual([ACTIVATE, CAPTURE]);
      expect(cdp.last(ACTIVATE)).toEqual({
        params: { targetId: "T1" },
        sessionId: undefined,
      });
      for (const viewer of viewers) {
        expect(viewer.shots()).toMatchObject([{ kind: 1, rect: FULL_RECT }]);
      }
    });

    it("切り替えの途中にできたら、切り替えた先を前面へ戻す", async () => {
      const { cdp, viewer } = await startedWithTabs();
      cdp.holdOn("Page.enable");
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      await flush();
      cdp.emitBrowser("Target.targetCreated", { targetInfo: target("T9") });
      await flush();
      expect(cdp.count(ACTIVATE)).toBe(1);
      cdp.stopHolding("Page.enable");
      cdp.release("Page.enable");
      await flush();
      expect(cdp.calls(ACTIVATE).map(call => call.params)).toEqual([
        { targetId: "T2" },
        { targetId: "T2" },
      ]);
      expect(cdp.methods().at(-1)).toBe(ACTIVATE);
    });
  });

  describe("クラッシュしたタブ", () => {
    it("閉じる前にsessionを離す (閉じられなくても残さない)", async () => {
      const ctx = await startedWithTabs();
      const { cdp } = ctx;
      cdp.failOn(CLOSE_TARGET);
      cdp.emit("Inspector.targetCrashed", undefined);
      await flush();
      expect(cdp.methods().slice(0, 3)).toEqual([
        STOP_CAST,
        DETACH,
        CLOSE_TARGET,
      ]);
      expect(cdp.last(DETACH)?.params).toEqual({ sessionId: "S1" });
      expectShowing(ctx, "T2", "S2");
    });
  });

  describe("<select>の準備ができないタブ", () => {
    it.each([
      "Runtime.enable",
      "Runtime.addBinding",
      "Page.addScriptToEvaluateOnNewDocument",
    ])("%s が失敗しても、警告を1回出して、タブは映す", async method => {
      const cdp = fakeCdp();
      cdp.failOn(method);
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      expect(cdp.count(START_CAST)).toBe(1);
      expect(errorCount(viewer)).toBe(0);
      expect(textsOf(viewer, "tabs")).toHaveLength(1);
      expect(cdp.count(EVALUATE)).toBe(0);
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("<select>")
      );
    });

    it("返らなければ、時間切れのあとに、タブを映す", async () => {
      const cdp = fakeCdp();
      cdp.holdOn("Runtime.addBinding");
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await vi.advanceTimersByTimeAsync(2999);
      expect(cdp.count(START_CAST)).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(cdp.count(START_CAST)).toBe(1);
      expect(cdp.count(ATTACH)).toBe(1);
      expect(errorCount(viewer)).toBe(0);
      expect(console.warn).toHaveBeenCalledTimes(1);
    });

    it("準備の途中でsessionが切り離されたら、そのタブはあきらめて、ほかのタブを映す", async () => {
      const cdp = fakeCdp({ targets: [target("T1"), target("T2")] });
      cdp.holdOn("Runtime.enable");
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      cdp.stopHolding("Runtime.enable");
      cdp.emitBrowser("Target.detachedFromTarget", { sessionId: "S1" });
      cdp.emitBrowser("Target.targetDestroyed", { targetId: "T1" });
      await flush();
      expect(errorCount(viewer)).toBe(0);
      expect(cdp.last(ATTACH)?.params).toMatchObject({ targetId: "T2" });
      expect(cdp.last(START_CAST)?.sessionId).toBe("S2");
    });
  });

  describe("タッチのエミュレーション", () => {
    const resize = (mobile: boolean) => ({
      t: "resize",
      width: 400,
      height: 800,
      dpr: 2,
      mobile,
    });

    it("mobileで準備したタブへ、mobileでなくなってから戻ったら、無効にし直す", async () => {
      const { cdp, viewer } = await startedWithTabs(["T1", "T2"]);
      viewer.receive(resize(true));
      await vi.advanceTimersByTimeAsync(150);
      viewer.receive({ t: "tab", type: "activate", id: "T2" });
      await flush();
      viewer.receive(resize(false));
      await vi.advanceTimersByTimeAsync(150);
      cdp.forget();
      viewer.receive({ t: "tab", type: "activate", id: "T1" });
      await flush();
      expect(cdp.calls(TOUCH_EMULATION)).toEqual([
        {
          method: TOUCH_EMULATION,
          params: { enabled: false },
          sessionId: "S3",
        },
      ]);
    });
  });
});

describe("BrowserCdpBridge: 視聴者へのJSONの上限", () => {
  const OPENING = "Page.javascriptDialogOpening";
  const OVERFLOW_BODY = {
    t: "error",
    message: "回線が詰まったため切断しました",
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    withoutPoll();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("送信バッファが上限を超えた視聴者は、状態のJSONを送らずに、errorで閉じる", async () => {
    const { cdp, bridge, viewers } = await started(2);
    const [open, stuck] = viewers;
    stuck.bufferedAmount = OUTPUT_LIMIT_BYTES + 1;
    cdp.emit(OPENING, { type: "alert", message: "m" });

    expect(textsOf(open, "dialog")).toHaveLength(1);
    expect(stuck.texts()).toEqual([OVERFLOW_BODY]);
    expect(stuck.close).toHaveBeenCalledWith(1011, OVERFLOW_BODY.message);
    expect(bridge.viewerCount).toBe(1);
    expect(open.close).not.toHaveBeenCalled();

    // 外した視聴者へは、もう何も送らない
    stuck.send.mockClear();
    cdp.emit("Page.javascriptDialogClosed", { result: true, userInput: "" });
    expect(stuck.send).not.toHaveBeenCalled();
    expect(open.texts().at(-1)).toEqual({ t: "dialogClosed" });
  });

  it("上限ちょうどまでは、詰まっていても状態のJSONを送る", async () => {
    const { cdp, bridge, viewer } = await started();
    viewer.bufferedAmount = OUTPUT_LIMIT_BYTES;
    cdp.emit(OPENING, { type: "alert", message: "m" });
    expect(textsOf(viewer, "dialog")).toHaveLength(1);
    expect(viewer.close).not.toHaveBeenCalled();
    expect(bridge.viewerCount).toBe(1);
  });

  it("読まない視聴者へタブの一覧を送り続けても、上限で閉じて、そこで止まる", async () => {
    const { cdp, bridge, viewers } = await startedWithTabs(["T1", "T2"], 2);
    const [open, stuck] = viewers;
    // 送ったぶんだけ、送信バッファに積もる視聴者
    stuck.send.mockImplementation((data: Buffer | string) => {
      stuck.bufferedAmount += Buffer.byteLength(data);
    });
    stuck.bufferedAmount = OUTPUT_LIMIT_BYTES - 50_000;
    let sent = 0;
    for (; sent < 100 && bridge.viewerCount === 2; sent++) {
      const i = sent;
      cdp.emitBrowser("Target.targetInfoChanged", {
        targetInfo: target("T2", {
          title: `${i}`.padEnd(2000, "t"),
          url: `http://localhost/${i}`.padEnd(10_000, "u"),
        }),
      });
      // 一覧の知らせは100msにまとめられる
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(bridge.viewerCount).toBe(1);
    // 1通は、切り詰めた題とURLのぶん (10KBほど) しか積もらない
    expect(sent).toBeGreaterThan(4);
    expect(stuck.close).toHaveBeenCalledWith(1011, OVERFLOW_BODY.message);
    // 上限と、最後の1通ぶん (題とURLは切り詰めてある) より先へは積もらない
    expect(stuck.bufferedAmount).toBeLessThan(OUTPUT_LIMIT_BYTES + 20_000);
    expect(open.close).not.toHaveBeenCalled();
  });

  it("タブを替えたときの寸法の知らせも、上限を超えた視聴者へは送らずに閉じる", async () => {
    const { bridge, viewers } = await startedWithTabs(["T1", "T2"], 2);
    const [open, stuck] = viewers;
    stuck.bufferedAmount = OUTPUT_LIMIT_BYTES + 1;
    open.receive({ t: "tab", type: "activate", id: "T2" });
    await flush();
    expect(stuck.texts()).toEqual([OVERFLOW_BODY]);
    expect(bridge.viewerCount).toBe(1);
    expect(textsOf(open, "viewport")).toHaveLength(1);
  });
});

describe("BrowserCdpBridge: CDPの応答の期限", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    withoutPoll();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("タブの準備のコマンドに、待つ時間と同じ期限を付ける", async () => {
    const cdp = fakeCdp();
    const bridge = new BrowserCdpBridge(async () => cdp);
    bridge.attach(fakeViewer());
    await flush();
    for (const method of [
      "Target.getTargets",
      ACTIVATE,
      "Page.enable",
      "Emulation.setFocusEmulationEnabled",
      "Emulation.setDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
      "Runtime.enable",
      "Runtime.addBinding",
      "Page.addScriptToEvaluateOnNewDocument",
    ]) {
      expect([method, cdp.deadlineOf(method)]).toEqual([
        method,
        ENTER_STEP_TIMEOUT_MS,
      ]);
    }
  });

  it("attachの応答は、待つのをやめたあとに付いたsessionを離せるよう、長く待つ", async () => {
    const cdp = fakeCdp();
    const bridge = new BrowserCdpBridge(async () => cdp);
    bridge.attach(fakeViewer());
    await flush();
    expect(cdp.deadlineOf(ATTACH)).toBe(ATTACH_ANSWER_TIMEOUT_MS);
    expect(ATTACH_ANSWER_TIMEOUT_MS).toBeGreaterThan(ENTER_STEP_TIMEOUT_MS);
  });

  it("取り直し、履歴の読み直し、タブの操作にも期限を付ける", async () => {
    const { cdp, viewer } = await startedWithTabs();
    expect(cdp.deadlineOf(CAPTURE)).toBe(CAPTURE_TIMEOUT_MS);
    expect(cdp.deadlineOf(HISTORY)).toBe(HISTORY_TIMEOUT_MS);
    viewer.receive({ t: "tab", type: "new" });
    await flush();
    expect(cdp.deadlineOf(CREATE_TARGET)).toBe(ENTER_STEP_TIMEOUT_MS);
  });

  /**
   * 取り直し (`Page.captureScreenshot`) にだけ応答しないChromium。ほかのコマンドには
   * すぐ応答する。本物のCdpClientをつないで、待ちの数を見る
   */
  function chromiumWithoutCaptures() {
    const emitter = new EventEmitter();
    let captures = 0;
    const receive = (message: object) =>
      emitter.emit("message", JSON.stringify(message));
    const resultOf = (method: string): object => {
      if (method === "Target.getTargets") {
        return { targetInfos: [{ targetId: "T1", type: "page" }] };
      }
      if (method === ATTACH) return { sessionId: "S1" };
      return {};
    };
    const socket = {
      send(data: string) {
        const { id, method } = JSON.parse(data) as {
          id: number;
          method: string;
        };
        if (method === CAPTURE) {
          captures++;
          return;
        }
        queueMicrotask(() => receive({ id, result: resultOf(method) }));
      },
      close: () => emitter.emit("close"),
      on: (event: string, listener: (...args: never[]) => void) =>
        emitter.on(event, listener),
    } as unknown as CdpSocket;
    return { socket, receive, captures: () => captures };
  }

  it("取り直しが返らないままやり直しを重ねても、CDPの接続に待ちが積もらない", async () => {
    const chromium = chromiumWithoutCaptures();
    const client = new CdpClient(chromium.socket);
    const bridge = new BrowserCdpBridge(async () => client);
    const viewer = fakeViewer();
    bridge.attach(viewer);
    await flush();
    chromium.receive({
      method: "Page.screencastFrame",
      params: monitorFrame(1),
      sessionId: "S1",
    });
    await vi.advanceTimersByTimeAsync(150_000);

    expect(chromium.captures()).toBeGreaterThanOrEqual(20);
    // 残るのは、いま応答を待っている取り直しの1つまで
    expect(client.pendingCount).toBeLessThanOrEqual(1);
    expect(errorCount(viewer)).toBe(0);

    bridge.reset();
    expect(client.pendingCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("BrowserCdpBridge: 定期の読み直し", () => {
  const GET_TARGETS = "Target.getTargets";
  const OPENING = "Page.javascriptDialogOpening";
  const CLOSED = "Page.javascriptDialogClosed";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** `title` を題にした、`id` のタブの履歴 */
  function titled(id: string, title: string) {
    return {
      currentIndex: 0,
      entries: [{ id: 1, url: tabUrl(id), title }],
    };
  }

  function pollWarnings(): unknown[][] {
    return vi
      .mocked(console.warn)
      .mock.calls.filter(([text]) => String(text).includes("定期の読み直し"));
  }

  it("1000msごとに、映しているタブの履歴と、タブの一覧を読む", async () => {
    const { cdp } = await startedWithTabs();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);
    expect(cdp.methods()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(cdp.calls(HISTORY)).toMatchObject([{ sessionId: "S1" }]);
    expect(cdp.calls(GET_TARGETS)).toMatchObject([{ sessionId: undefined }]);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(cdp.count(HISTORY)).toBe(4);
    expect(cdp.count(GET_TARGETS)).toBe(4);
    expect(
      cdp.methods().filter(m => m !== HISTORY && m !== GET_TARGETS)
    ).toEqual([]);
  });

  it("スクリプトが変えた題を、次の読み直しで1回だけ知らせる", async () => {
    const { cdp, viewers } = await startedWithTabs(["T1", "T2"], 2);
    cdp.answer(HISTORY, titled("T1", "スクリプトの題"));
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    for (const viewer of viewers) {
      expect(viewer.texts()).toEqual([
        pageBody(tabUrl("T1"), "スクリプトの題"),
      ]);
    }
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
    for (const viewer of viewers) expect(viewer.texts()).toHaveLength(1);
  });

  it("映していないタブの題が変わったら、一覧を1回だけ知らせる", async () => {
    const { cdp, viewer } = await startedWithTabs();
    cdp.answer(GET_TARGETS, {
      targetInfos: [
        target("T1"),
        target("T2", { title: "裏の題" }),
        target("T3"),
      ],
    });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);
    expect(viewer.texts()).toEqual([
      {
        t: "tabs",
        tabs: [tabOf("T1"), { ...tabOf("T2"), title: "裏の題" }, tabOf("T3")],
        activeId: "T1",
      },
    ]);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
    expect(viewer.texts()).toHaveLength(1);
  });

  it("一覧に足りないタブを足し、もう無いタブを外す", async () => {
    const { cdp, viewer } = await startedWithTabs();
    cdp.answer(GET_TARGETS, {
      targetInfos: [target("T1"), target("T3"), target("T4")],
    });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);
    expect(viewer.texts()).toEqual([tabsBody(["T1", "T3", "T4"], "T1")]);
    expect(cdp.count(ATTACH)).toBe(0);
  });

  it("視聴者が居なくなったら読まず、タイマーも残さない。入り直したら、また読む", async () => {
    const { cdp, bridge, viewer } = await startedWithTabs();
    expect(vi.getTimerCount()).toBe(1);
    viewer.emit("close");
    expect(vi.getTimerCount()).toBe(0);
    cdp.forget();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
    expect(cdp.methods()).toEqual([]);
    bridge.attach(fakeViewer());
    await flush();
    cdp.forget();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(cdp.count(HISTORY)).toBe(1);
    expect(cdp.count(GET_TARGETS)).toBe(1);
  });

  it("視聴者が1人でも残っていれば、読み続ける", async () => {
    const { cdp, viewers } = await startedWithTabs(["T1"], 2);
    viewers[0].emit("close");
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(cdp.count(HISTORY)).toBe(1);
  });

  it("ダイアログが開いている間は読まず、閉じたら、また読む", async () => {
    const { cdp } = await startedWithTabs();
    cdp.emit(OPENING, { type: "alert", message: "x" });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
    expect(cdp.count(HISTORY)).toBe(0);
    expect(cdp.count(GET_TARGETS)).toBe(0);
    cdp.emit(CLOSED, {});
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(cdp.count(HISTORY)).toBe(1);
    expect(cdp.count(GET_TARGETS)).toBe(1);
  });

  it("切り替えの途中は読まず、つなぎ終えたら、新しいタブを読む", async () => {
    const { cdp, viewer } = await startedWithTabs();
    cdp.holdOn("Page.enable");
    viewer.receive({ t: "tab", type: "activate", id: "T2" });
    await flush();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    expect(cdp.count(HISTORY)).toBe(0);
    expect(cdp.count(GET_TARGETS)).toBe(0);
    cdp.stopHolding("Page.enable");
    cdp.release("Page.enable");
    await flush();
    cdp.forget();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(cdp.calls(HISTORY)).toMatchObject([{ sessionId: "S2" }]);
    expect(cdp.count(GET_TARGETS)).toBe(1);
  });

  it("タブを動かす操作が走っている間は、一覧を読まない", async () => {
    const { cdp, viewer } = await startedWithTabs();
    cdp.holdOn(CLOSE_TARGET);
    viewer.receive({ t: "tab", type: "close", id: "T3" });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    expect(cdp.count(GET_TARGETS)).toBe(0);
    cdp.stopHolding(CLOSE_TARGET);
    cdp.release(CLOSE_TARGET);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(cdp.count(GET_TARGETS)).toBe(1);
  });

  it("履歴の応答が返らない間は、次の読み直しを重ねない。時間切れのあとは、また読む", async () => {
    const { cdp, viewer } = await startedWithTabs();
    cdp.holdOn(HISTORY);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(cdp.count(HISTORY)).toBe(1);
    expect(cdp.count(GET_TARGETS)).toBe(1);
    await vi.advanceTimersByTimeAsync(ENTER_STEP_TIMEOUT_MS - 1);
    expect(cdp.count(HISTORY)).toBe(1);
    expect(cdp.count(GET_TARGETS)).toBe(1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(cdp.count(HISTORY)).toBe(2);
    expect(cdp.count(GET_TARGETS)).toBe(2);
    expect(errorCount(viewer)).toBe(0);
    expect(cdp.count(ATTACH)).toBe(0);
  });

  it("一覧の応答が返らない間も、次の読み直しを重ねない", async () => {
    const { cdp } = await startedWithTabs();
    cdp.holdOn(GET_TARGETS);
    await vi.advanceTimersByTimeAsync(
      POLL_INTERVAL_MS + ENTER_STEP_TIMEOUT_MS - 1
    );
    expect(cdp.count(HISTORY)).toBe(1);
    expect(cdp.count(GET_TARGETS)).toBe(1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(cdp.count(GET_TARGETS)).toBe(2);
  });

  it("読めなくても、視聴者を切らず、タブも替えず、記録は30秒に1回まで", async () => {
    const { cdp, bridge, viewer, connect } = await startedWithTabs();
    cdp.failOn(HISTORY);
    cdp.failOn(GET_TARGETS);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 29);
    expect(cdp.count(HISTORY)).toBe(29);
    expect(pollWarnings()).toHaveLength(1);
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(pollWarnings()).toHaveLength(2);
    expect(errorCount(viewer)).toBe(0);
    expect(viewer.texts()).toEqual([]);
    expect(bridge.viewerCount).toBe(1);
    expect(cdp.close).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(
      cdp.methods().filter(m => m !== HISTORY && m !== GET_TARGETS)
    ).toEqual([]);
    // 読めるようになったら、また当てる
    cdp.stopFailing(HISTORY);
    cdp.answer(HISTORY, titled("T1", "あとの題"));
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(textsOf(viewer, "page")).toEqual([
      pageBody(tabUrl("T1"), "あとの題"),
    ]);
  });

  it("接続が切れたら、タイマーを残さない (応答を待っている間でも)", async () => {
    const { cdp } = await startedWithTabs();
    cdp.holdOn(HISTORY);
    cdp.holdOn(GET_TARGETS);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(vi.getTimerCount()).toBeGreaterThan(1);
    cdp.disconnect();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 40);
    expect(vi.getTimerCount()).toBe(0);
    expect(pollWarnings()).toEqual([]);
  });

  it("応答を待つ間に接続が切れても、つなぎ直したあとは、また読む", async () => {
    const first = fakeCdp();
    const second = fakeCdp();
    const connect = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const bridge = new BrowserCdpBridge(connect);
    bridge.attach(fakeViewer());
    await flush();
    first.holdOn(HISTORY);
    first.holdOn(GET_TARGETS);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(first.count(GET_TARGETS)).toBe(2);
    first.disconnect();
    bridge.attach(fakeViewer());
    await flush();
    second.forget();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(second.calls(HISTORY)).toMatchObject([{ sessionId: "S1" }]);
    expect(second.count(GET_TARGETS)).toBe(1);
  });

  it("resetしたら、タイマーを残さない", async () => {
    const { cdp, bridge } = await startedWithTabs();
    cdp.holdOn(HISTORY);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    bridge.reset();
    expect(vi.getTimerCount()).toBe(0);
    cdp.disconnect();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("どのタブにもつなげなくなって接続を捨てたときも、タイマーを残さない", async () => {
    const { cdp, viewer } = await startedWithTabs(["T1"]);
    cdp.failOn(ATTACH);
    cdp.emitBrowser("Target.targetDestroyed", { targetId: "T1" });
    await flush();
    expect(errorCount(viewer)).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("応答を待つ間に視聴者が居なくなって入り直しても、読み直しを重ねない", async () => {
    const { cdp, bridge, viewer } = await startedWithTabs();
    cdp.holdOn(HISTORY);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    viewer.emit("close");
    bridge.attach(fakeViewer());
    await flush();
    cdp.forget();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(cdp.count(HISTORY)).toBe(0);
  });
});
