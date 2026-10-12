/**
 * browser-cdp-bridgeのテスト。CDPは呼び出しを記録する偽物で、
 * 視聴者のWebSocketはEventEmitterで代用する。
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserCdpBridge,
  type CdpLike,
  parseClientMessage,
  toCdpCommand,
  type ViewerSocket,
} from "./browser-cdp-bridge.js";
import { buildSolidPng } from "./browser-frame-diff.testkit.js";

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

/**
 * 本物のCdpClientと同じく、`close()` はcloseのイベントをその場では出さない
 * (`disconnect()` で届ける)。`holdOn` したメソッドの応答は、`release` / `fail` で返すまで待たせる。
 */
function fakeCdp(
  options: { targets?: Array<{ targetId: string; type: string }> } = {}
) {
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
    answer: Deferred<unknown>;
    result: unknown;
  }> = [];
  let shots = 0;
  let closing = false;
  let closed = false;

  const resultOf = (method: string): unknown => {
    if (method === "Target.getTargets") {
      return {
        targetInfos: options.targets ?? [{ targetId: "T1", type: "page" }],
      };
    }
    if (method === "Target.createTarget") return { targetId: "T-new" };
    if (method === "Target.attachToTarget") return { sessionId: "S1" };
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

  const cdp = {
    get closed() {
      return closed;
    },
    // 失敗させる呼び出しも記録する (何を送ろうとしたかを確かめるため)
    send(method: string, params?: object, sessionId?: string) {
      if (closed || closing) return Promise.reject(new Error("closed"));
      calls.push({ method, params, sessionId });
      if (failing.has(method)) {
        return Promise.reject(new Error(`${method}: failed`));
      }
      // 応答の中身は、呼ばれた順に決める
      const result = resultOf(method);
      if (holding.has(method)) {
        const answer = deferred<unknown>();
        held.push({ method, answer, result });
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

    methods: () => calls.map(call => call.method),
    last(method: string) {
      const call = calls.findLast(c => c.method === method);
      return call && { params: call.params, sessionId: call.sessionId };
    },
    count: (method: string) => calls.filter(c => c.method === method).length,
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
      dispatch(method, params, undefined);
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
      "Target.getTargets",
      "Target.attachToTarget",
      "Page.enable",
      "Emulation.setFocusEmulationEnabled",
      "Emulation.setDeviceMetricsOverride",
      "Page.startScreencast",
    ]);
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
    expect(cdp.methods().slice(-3)).toEqual([
      "Emulation.setDeviceMetricsOverride",
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
      return { first, second, connect, bridge, viewer };
    }

    async function expectTornDown({
      first,
      second,
      connect,
      bridge,
      viewer,
    }: Awaited<ReturnType<typeof connected>>) {
      expect(viewer.send).toHaveBeenCalledWith(ERROR_BODY);
      expect(viewer.close).toHaveBeenCalledWith(1011, expect.any(String));
      expect(bridge.viewerCount).toBe(0);
      expect(first.close).toHaveBeenCalled();
      // 閉じた接続のcloseがあとから届いても、もう何も起きない
      first.disconnect();
      expect(errorCount(viewer)).toBe(1);
      bridge.attach(fakeViewer());
      await flush();
      expect(connect).toHaveBeenCalledTimes(2);
      expect(second.count("Target.attachToTarget")).toBe(1);
      expect(second.count("Page.startScreencast")).toBe(1);
    }

    it("タブのsessionがdetachされたら、CDPが切れたときと同じに扱う", async () => {
      const ctx = await connected();
      ctx.first.emitBrowser("Target.detachedFromTarget", {
        sessionId: "S1",
        targetId: "T1",
      });
      await expectTornDown(ctx);
    });

    it("タブがクラッシュしたら、CDPが切れたときと同じに扱う", async () => {
      const ctx = await connected();
      ctx.first.emit("Inspector.targetCrashed", undefined);
      await expectTornDown(ctx);
    });

    it("別のsessionのdetachとクラッシュは無視する", async () => {
      const { first, bridge, viewer } = await connected();
      first.emitBrowser("Target.detachedFromTarget", { sessionId: "S9" });
      first.emit("Inspector.targetCrashed", undefined, "S9");
      first.emitBrowser("Inspector.targetCrashed", undefined);
      await flush();
      expect(viewer.close).not.toHaveBeenCalled();
      expect(first.close).not.toHaveBeenCalled();
      expect(bridge.viewerCount).toBe(1);
    });

    it("準備の途中でタブがdetachされたら、視聴者へerrorを1回だけ送って接続を閉じる", async () => {
      const cdp = fakeCdp();
      cdp.holdOn("Page.enable");
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      cdp.emitBrowser("Target.detachedFromTarget", { sessionId: "S1" });
      cdp.release("Page.enable");
      await flush();
      expect(viewer.send).toHaveBeenCalledTimes(1);
      expect(viewer.close).toHaveBeenCalledTimes(1);
      expect(cdp.close).toHaveBeenCalled();
      expect(cdp.count("Page.startScreencast")).toBe(0);
      expect(bridge.viewerCount).toBe(0);
    });

    it("タブが1つも無ければ、about:blankで作ってattachする", async () => {
      const cdp = fakeCdp({ targets: [{ targetId: "W1", type: "worker" }] });
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      expect(cdp.methods().slice(0, 3)).toEqual([
        "Target.getTargets",
        "Target.createTarget",
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

    it("resizeの始め直しで失敗しても、全員をerrorで閉じる", async () => {
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
      cdp.fail("Page.startScreencast");
      await flush();
      expect(viewer.send).toHaveBeenCalledWith(
        expect.stringContaining('"t":"error"')
      );
      expect(viewer.close).toHaveBeenCalledTimes(1);
      expect(bridge.viewerCount).toBe(0);
      expect(cdp.close).toHaveBeenCalled();
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
      metadata: unknown = { deviceWidth: width, deviceHeight: height }
    ) =>
      monitorFrame(id, {
        size: { width: Math.ceil(width / 8), height: Math.ceil(height / 8) },
        metadata,
      });

    it("入った視聴者へ、フレームが無くても当てた寸法を世代つきで知らせる", async () => {
      const cdp = fakeCdp();
      const bridge = new BrowserCdpBridge(async () => cdp);
      const viewer = fakeViewer();
      bridge.attach(viewer);
      await flush();
      expect(viewer.send.mock.calls).toEqual([[viewportBody(1280, 900, 1)]]);
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
        [expect.any(Buffer)],
      ]);
      expect(viewer.shots()).toEqual([
        { kind: 1, gen: 1, rect: FULL_RECT, image: "shot-1" },
      ]);
    });

    it("メタデータの寸法が変わると世代が進み、その寸法をフレームより先に知らせる", async () => {
      const { cdp, viewer } = await started();
      cdp.emit("Page.screencastFrame", sized(2, 390, 700));
      await flush();
      expect(viewer.send.mock.calls).toEqual([
        [viewportBody(390, 700, 2)],
        [expect.any(Buffer)],
      ]);
      expect(viewer.shots()).toMatchObject([
        { kind: 1, gen: 2, rect: { x: 0, y: 0, width: 390, height: 700 } },
      ]);
      expect(cdp.captures()[0].clip).toEqual({
        x: 0,
        y: 0,
        width: 390,
        height: 700,
        scale: 1,
      });
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
      expect(viewer.texts()).toEqual([
        { t: "viewport", width: 1280, height: 900, gen: 1 },
      ]);
      expect(viewer.shots().map(shot => shot.gen)).toEqual([1]);
    });

    it("メタデータの寸法が読めなければ、最後に当てた寸法を使う", async () => {
      const { cdp, viewer } = await started();
      cdp.emit("Page.screencastFrame", sized(2, 390, 700));
      await flush();
      viewer.send.mockClear();
      cdp.emit(
        "Page.screencastFrame",
        monitorFrame(3, {
          metadata: { deviceWidth: Number.NaN, deviceHeight: "700" },
        })
      );
      await flush();
      expect(viewer.send.mock.calls).toEqual([
        [viewportBody(1280, 900, 3)],
        [expect.any(Buffer)],
      ]);
      expect(viewer.shots()).toMatchObject([
        { kind: 1, gen: 3, rect: FULL_RECT },
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
      const { cdp, bridge } = await started();
      cdp.emit("Page.screencastFrame", sized(2, 390, 700));
      await flush();
      const late = fakeViewer();
      bridge.attach(late);
      await flush();
      expect(late.send.mock.calls).toEqual([
        [viewportBody(390, 700, 2)],
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
      cdp.emit("Page.screencastFrame", sized(1, 390, 700));
      await flush();
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
      expect(fast.texts()).toEqual([
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
      first.release(CAPTURE);
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

    it("寸法は整数に丸め、取り直しの位置とヘッダと通知で同じ値を使う", async () => {
      const { cdp, viewer } = await started();
      cdp.emit(
        "Page.screencastFrame",
        monitorFrame(2, {
          size: { width: 49, height: 88 },
          metadata: { deviceWidth: 390.6, deviceHeight: 699.5 },
        })
      );
      await flush();
      expect(viewer.texts()).toEqual([
        { t: "viewport", width: 391, height: 700, gen: 2 },
      ]);
      expect(cdp.captures().map(c => c.clip)).toEqual([
        { x: 0, y: 0, width: 391, height: 700, scale: 1 },
      ]);
      expect(viewer.shots()).toMatchObject([
        { kind: 1, gen: 2, rect: { x: 0, y: 0, width: 391, height: 700 } },
      ]);
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
      // 当てた寸法のフレームが来たら、そこから使う。世代は1つだけ進む
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

    it("当てた寸法のフレームを見たあとは、メタデータの寸法が違っても使う", async () => {
      const { cdp, viewer } = await resized();
      cdp.emit("Page.screencastFrame", sized(7, 390, 700));
      await flush();
      cdp.emit("Page.screencastFrame", sized(8, 400, 700));
      await flush();
      expect(viewer.texts()).toEqual([
        { t: "viewport", width: 390, height: 700, gen: 2 },
        { t: "viewport", width: 400, height: 700, gen: 3 },
      ]);
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

    it("当てた寸法のフレームが来ないままでも、しばらくしたら届いたフレームを使う", async () => {
      const { cdp, viewer } = await resized();
      cdp.emit("Page.screencastFrame", sized(7, 1280, 900));
      await vi.advanceTimersByTimeAsync(999);
      cdp.emit("Page.screencastFrame", sized(8, 1280, 900));
      await flush();
      expect(viewer.send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      cdp.emit("Page.screencastFrame", sized(9, 1280, 900));
      await flush();
      expect(viewer.shots()).toMatchObject([{ kind: 1, rect: FULL_RECT }]);
    });

    it("寸法を当てられなかったら、届いたフレームをそのまま使う", async () => {
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
      s.cdp.emit("Page.screencastFrame", sized(7, 1280, 900));
      await flush();
      expect(s.viewer.shots()).toMatchObject([{ kind: 1, rect: FULL_RECT }]);
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

describe("toCdpCommand", () => {
  const mouse = {
    t: "mouse",
    x: 10,
    y: 20,
    button: 0,
    buttons: 1,
    clickCount: 1,
    deltaX: 0,
    deltaY: 0,
    modifiers: 8,
  } as const;

  it("mouse downはmousePressedとleft", () => {
    expect(toCdpCommand({ ...mouse, type: "down" })).toEqual({
      method: "Input.dispatchMouseEvent",
      params: {
        type: "mousePressed",
        x: 10,
        y: 20,
        button: "left",
        buttons: 1,
        clickCount: 1,
        modifiers: 8,
      },
    });
  });

  it("mouse upはmouseReleased、範囲外のbuttonはnone", () => {
    expect(
      toCdpCommand({ ...mouse, type: "up", button: 2 })?.params
    ).toMatchObject({ type: "mouseReleased", button: "right" });
    expect(
      toCdpCommand({ ...mouse, type: "up", button: 1 })?.params
    ).toMatchObject({ button: "middle" });
    expect(
      toCdpCommand({ ...mouse, type: "up", button: 9 })?.params
    ).toMatchObject({ button: "none" });
  });

  it("mouse moveのbuttonはbuttonsから決める", () => {
    expect(
      toCdpCommand({ ...mouse, type: "move", button: 0, buttons: 2 })?.params
    ).toMatchObject({ type: "mouseMoved", button: "right" });
    expect(
      toCdpCommand({ ...mouse, type: "move", buttons: 4 })?.params
    ).toMatchObject({ button: "middle" });
    expect(
      toCdpCommand({ ...mouse, type: "move", buttons: 0 })?.params
    ).toMatchObject({ button: "none" });
  });

  it("wheelはmouseWheelとdelta", () => {
    expect(
      toCdpCommand({
        ...mouse,
        type: "wheel",
        buttons: 0,
        deltaX: 1,
        deltaY: 120,
      })?.params
    ).toMatchObject({
      type: "mouseWheel",
      button: "none",
      deltaX: 1,
      deltaY: 120,
    });
  });

  it("textのあるkey downはkeyDown、無ければrawKeyDown、upはtextを落とす", () => {
    const key = {
      t: "key",
      key: "a",
      code: "KeyA",
      keyCode: 65,
      repeat: false,
      modifiers: 0,
    } as const;
    expect(toCdpCommand({ ...key, type: "down", text: "a" })).toEqual({
      method: "Input.dispatchKeyEvent",
      params: {
        type: "keyDown",
        key: "a",
        code: "KeyA",
        modifiers: 0,
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65,
        text: "a",
        unmodifiedText: "a",
        autoRepeat: false,
      },
    });
    expect(toCdpCommand({ ...key, type: "down" })?.params).toMatchObject({
      type: "rawKeyDown",
    });
    const up = toCdpCommand({ ...key, type: "up", text: "a" })
      ?.params as Record<string, unknown>;
    expect(up.type).toBe("keyUp");
    expect(up.text).toBeUndefined();
  });

  it("imeとpaste", () => {
    expect(
      toCdpCommand({
        t: "ime",
        type: "update",
        text: "にほ",
        selectionStart: 2,
        selectionEnd: 2,
      })
    ).toEqual({
      method: "Input.imeSetComposition",
      params: { text: "にほ", selectionStart: 2, selectionEnd: 2 },
    });
    expect(toCdpCommand({ t: "ime", type: "commit", text: "日本" })).toEqual({
      method: "Input.insertText",
      params: { text: "日本" },
    });
    expect(toCdpCommand({ t: "ime", type: "cancel" })).toEqual({
      method: "Input.imeSetComposition",
      params: { text: "", selectionStart: 0, selectionEnd: 0 },
    });
    expect(toCdpCommand({ t: "paste", text: "x" })).toEqual({
      method: "Input.insertText",
      params: { text: "x" },
    });
  });

  it("resizeはnull", () => {
    expect(
      toCdpCommand({ t: "resize", width: 1, height: 1, dpr: 1, mobile: false })
    ).toBeNull();
  });
  it("refreshはnull", () => {
    expect(toCdpCommand({ t: "refresh" })).toBeNull();
  });
});

describe("parseClientMessage", () => {
  it("正しいメッセージを通す", () => {
    expect(parseClientMessage('{"t":"paste","text":"x"}')).toEqual({
      t: "paste",
      text: "x",
    });
  });

  it("知らない列は落とす", () => {
    expect(
      parseClientMessage('{"t":"ime","type":"cancel","method":"Browser.close"}')
    ).toEqual({ t: "ime", type: "cancel" });
  });

  it("refreshは、ほかの列を落として通す", () => {
    expect(parseClientMessage('{"t":"refresh"}')).toEqual({ t: "refresh" });
    expect(
      parseClientMessage('{"t":"refresh","method":"Browser.close"}')
    ).toEqual({ t: "refresh" });
  });

  it.each([
    ["壊れたJSON", "{"],
    ["オブジェクトでないJSON", "null"],
    ["未知のt", '{"t":"eval","code":"x"}'],
    [
      "数値でない座標",
      '{"t":"mouse","type":"down","x":"1","y":2,"button":0,"buttons":1,"clickCount":1,"deltaX":0,"deltaY":0,"modifiers":0}',
    ],
    [
      "未知のtype",
      '{"t":"mouse","type":"drag","x":1,"y":2,"button":0,"buttons":1,"clickCount":1,"deltaX":0,"deltaY":0,"modifiers":0}',
    ],
    ["文字列でないtext", '{"t":"paste","text":1}'],
    ["真偽値でないmobile", '{"t":"resize","width":1,"height":1,"dpr":1}'],
  ])("%s を拒否する", (_name, raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });

  it("長すぎるtextを拒否する", () => {
    expect(
      parseClientMessage(
        JSON.stringify({ t: "paste", text: "a".repeat(100_001) })
      )
    ).toBeNull();
  });

  it("keyとcodeは64文字まで。textは長くてよい", () => {
    const key = {
      t: "key",
      type: "down",
      key: "a",
      code: "KeyA",
      keyCode: 65,
      repeat: false,
      modifiers: 0,
    };
    const parse = (extra: object) =>
      parseClientMessage(JSON.stringify({ ...key, ...extra }));
    expect(parse({ key: "k".repeat(64), code: "c".repeat(64) })).not.toBeNull();
    expect(parse({ key: "k".repeat(65) })).toBeNull();
    expect(parse({ code: "c".repeat(65) })).toBeNull();
    expect(parse({ text: "t".repeat(100_000) })).not.toBeNull();
    expect(parse({ text: "t".repeat(100_001) })).toBeNull();
  });
});
