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
  const held: Array<{ method: string; answer: Deferred<unknown> }> = [];
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
    return {};
  };

  const takeHeld = (method: string) => {
    const index = held.findIndex(entry => entry.method === method);
    if (index < 0) throw new Error(`${method} は待たせていません`);
    return held.splice(index, 1)[0].answer;
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
      if (holding.has(method)) {
        const answer = deferred<unknown>();
        held.push({ method, answer });
        return answer.promise;
      }
      return Promise.resolve(resultOf(method));
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
    /** これ以降の `method` の応答を、`release` / `fail` まで待たせる */
    holdOn(method: string) {
      holding.add(method);
    },
    stopHolding(method: string) {
      holding.delete(method);
    },
    /** 待たせている `method` のうち、いちばん古い1つを成功させる */
    release(method: string) {
      takeHeld(method).resolve(resultOf(method));
    },
    /** 待たせている `method` のうち、いちばん古い1つを失敗させる */
    fail(method: string) {
      takeHeld(method).reject(new Error(`${method}: failed`));
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

function frame(text: string, id: number) {
  return { data: Buffer.from(text).toString("base64"), sessionId: id };
}

function fakeViewer() {
  const viewer = new EventEmitter() as EventEmitter &
    ViewerSocket & {
      send: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
      receive(message: unknown): void;
    };
  viewer.readyState = 1;
  viewer.bufferedAmount = 0;
  viewer.send = vi.fn();
  viewer.close = vi.fn();
  viewer.terminate = vi.fn();
  viewer.receive = message => {
    viewer.emit("message", Buffer.from(JSON.stringify(message)), false);
  };
  return viewer;
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
        format: "jpeg",
        quality: 80,
        maxWidth: 1280,
        maxHeight: 900,
        everyNthFrame: 1,
      },
      sessionId: "S1",
    });
  });

  it("フレームをバイナリで配り、ackを返す", async () => {
    const cdp = fakeCdp();
    const bridge = new BrowserCdpBridge(async () => cdp);
    const viewer = fakeViewer();
    bridge.attach(viewer);
    await vi.runAllTimersAsync();
    cdp.emit("Page.screencastFrame", {
      data: Buffer.from("jpeg").toString("base64"),
      sessionId: 7,
    });
    expect(viewer.send).toHaveBeenCalledWith(Buffer.from("jpeg"));
    expect(cdp.last("Page.screencastFrameAck")).toEqual({
      params: { sessionId: 7 },
      sessionId: "S1",
    });
  });

  it("あとから入った視聴者へ、最後のフレームをすぐ送る", async () => {
    const cdp = fakeCdp();
    const bridge = new BrowserCdpBridge(async () => cdp);
    bridge.attach(fakeViewer());
    await vi.runAllTimersAsync();
    cdp.emit("Page.screencastFrame", {
      data: Buffer.from("jpeg").toString("base64"),
      sessionId: 1,
    });
    const late = fakeViewer();
    bridge.attach(late);
    await vi.runAllTimersAsync();
    expect(late.send).toHaveBeenCalledWith(Buffer.from("jpeg"));
    expect(cdp.count("Page.startScreencast")).toBe(1);
  });

  it("視聴者が詰まっている間はackを返さず、空いたら返す", async () => {
    const cdp = fakeCdp();
    const bridge = new BrowserCdpBridge(async () => cdp);
    const viewer = fakeViewer();
    bridge.attach(viewer);
    await vi.runAllTimersAsync();
    viewer.bufferedAmount = 2_000_000;
    cdp.emit("Page.screencastFrame", { data: "", sessionId: 8 });
    await vi.advanceTimersByTimeAsync(200);
    expect(viewer.send).not.toHaveBeenCalled();
    expect(cdp.count("Page.screencastFrameAck")).toBe(0);
    viewer.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(50);
    expect(cdp.count("Page.screencastFrameAck")).toBe(1);
  });

  it("詰まっている間に届いたフレームは、空いたときにすべてackする", async () => {
    const cdp = fakeCdp();
    const bridge = new BrowserCdpBridge(async () => cdp);
    const viewer = fakeViewer();
    bridge.attach(viewer);
    await vi.runAllTimersAsync();
    viewer.bufferedAmount = 2_000_000;
    cdp.emit("Page.screencastFrame", {
      data: Buffer.from("old").toString("base64"),
      sessionId: 1,
    });
    cdp.emit("Page.screencastFrame", {
      data: Buffer.from("new").toString("base64"),
      sessionId: 2,
    });
    viewer.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(50);
    // 配るのは最後の1枚だけ。ackは受け取った分をすべて返す
    expect(viewer.send).toHaveBeenCalledTimes(1);
    expect(viewer.send).toHaveBeenCalledWith(Buffer.from("new"));
    expect(cdp.count("Page.screencastFrameAck")).toBe(2);
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

  it("screencastを止めたら最後のフレームを捨てる", async () => {
    const cdp = fakeCdp();
    const bridge = new BrowserCdpBridge(async () => cdp);
    const viewer = fakeViewer();
    bridge.attach(viewer);
    await vi.runAllTimersAsync();
    cdp.emit("Page.screencastFrame", {
      data: Buffer.from("jpeg").toString("base64"),
      sessionId: 1,
    });
    viewer.emit("close");
    await vi.runAllTimersAsync();
    const late = fakeViewer();
    bridge.attach(late);
    await vi.runAllTimersAsync();
    expect(late.send).not.toHaveBeenCalled();
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
      maxWidth: 780,
      maxHeight: 1400,
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
      expect(viewer.send).not.toHaveBeenCalled();
      expect(viewer.close).not.toHaveBeenCalled();
      expect(bridge.viewerCount).toBe(1);
      second.emit("Page.screencastFrame", frame("jpeg", 1));
      expect(viewer.send).toHaveBeenCalledWith(Buffer.from("jpeg"));
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

    it("CDPが切れたら、resizeとackの見直しのタイマーを消す", async () => {
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
      cdp.emit("Page.screencastFrame", frame("jpeg", 1));
      expect(vi.getTimerCount()).toBe(2);
      cdp.disconnect();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("resetしたら、resizeとackの見直しのタイマーを消す", async () => {
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
      cdp.emit("Page.screencastFrame", frame("jpeg", 1));
      bridge.reset();
      expect(vi.getTimerCount()).toBe(0);
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
      expect(viewer.send).toHaveBeenCalledTimes(1);
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
        expect(viewer.send).toHaveBeenCalledTimes(1);
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
      cdp.emit("Page.screencastFrame", frame("jpeg", 3));
      expect(b.send).toHaveBeenCalledWith(Buffer.from("jpeg"));
      expect(cdp.count("Page.screencastFrameAck")).toBe(1);
    });
  });

  describe("遅れた視聴者", () => {
    it("飛ばされた視聴者は、空いたときに最後の1枚を1回だけ受け取る", async () => {
      const cdp = fakeCdp();
      const bridge = new BrowserCdpBridge(async () => cdp);
      const fast = fakeViewer();
      const slow = fakeViewer();
      bridge.attach(fast);
      bridge.attach(slow);
      await flush();
      slow.bufferedAmount = 2_000_000;
      cdp.emit("Page.screencastFrame", frame("one", 1));
      cdp.emit("Page.screencastFrame", frame("two", 2));
      expect(fast.send).toHaveBeenCalledTimes(2);
      expect(slow.send).not.toHaveBeenCalled();
      expect(cdp.count("Page.screencastFrameAck")).toBe(2);
      await vi.advanceTimersByTimeAsync(200);
      expect(slow.send).not.toHaveBeenCalled();
      slow.bufferedAmount = 0;
      await vi.advanceTimersByTimeAsync(50);
      expect(slow.send).toHaveBeenCalledTimes(1);
      expect(slow.send).toHaveBeenCalledWith(Buffer.from("two"));
      // 全員が受け取ったら見直しをやめる。同じ1枚を二度送らず、ackも重ねない
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(500);
      expect(fast.send).toHaveBeenCalledTimes(2);
      expect(slow.send).toHaveBeenCalledTimes(1);
      expect(cdp.count("Page.screencastFrameAck")).toBe(2);
      cdp.emit("Page.screencastFrame", frame("three", 3));
      expect(fast.send).toHaveBeenCalledTimes(3);
      expect(slow.send).toHaveBeenCalledTimes(2);
      expect(slow.send).toHaveBeenLastCalledWith(Buffer.from("three"));
    });

    it("入ったときに詰まっていた視聴者も、空いたときに最後の1枚を受け取る", async () => {
      const cdp = fakeCdp();
      const bridge = new BrowserCdpBridge(async () => cdp);
      const first = fakeViewer();
      bridge.attach(first);
      await flush();
      cdp.emit("Page.screencastFrame", frame("jpeg", 1));
      const late = fakeViewer();
      late.bufferedAmount = 2_000_000;
      bridge.attach(late);
      await vi.advanceTimersByTimeAsync(200);
      expect(late.send).not.toHaveBeenCalled();
      late.bufferedAmount = 0;
      await vi.advanceTimersByTimeAsync(50);
      expect(late.send).toHaveBeenCalledTimes(1);
      expect(late.send).toHaveBeenCalledWith(Buffer.from("jpeg"));
      expect(first.send).toHaveBeenCalledTimes(1);
      expect(cdp.count("Page.screencastFrameAck")).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("遅れた視聴者が去ったら、見直しをやめる", async () => {
      const cdp = fakeCdp();
      const bridge = new BrowserCdpBridge(async () => cdp);
      const fast = fakeViewer();
      const slow = fakeViewer();
      bridge.attach(fast);
      bridge.attach(slow);
      await flush();
      slow.bufferedAmount = 2_000_000;
      cdp.emit("Page.screencastFrame", frame("jpeg", 1));
      slow.emit("close");
      await vi.advanceTimersByTimeAsync(50);
      expect(vi.getTimerCount()).toBe(0);
      expect(fast.send).toHaveBeenCalledTimes(1);
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
      cdp.emit("Page.screencastFrame", frame("jpeg", 1));
      await flush();
      expect(cdp.count("Input.insertText")).toBe(1);
      expect(viewer.send).toHaveBeenCalledTimes(1);
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

  describe("視聴者への送信が投げたとき", () => {
    const boom = () => {
      throw new Error("send failed");
    };

    it("フレームは残りの視聴者へ配ってackし、投げた視聴者だけを外す", async () => {
      const cdp = fakeCdp();
      const bridge = new BrowserCdpBridge(async () => cdp);
      const broken = fakeViewer();
      const healthy = fakeViewer();
      bridge.attach(broken);
      bridge.attach(healthy);
      await flush();
      broken.send.mockImplementation(boom);
      expect(() =>
        cdp.emit("Page.screencastFrame", frame("jpeg", 1))
      ).not.toThrow();
      expect(healthy.send).toHaveBeenCalledWith(Buffer.from("jpeg"));
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
      expect(() =>
        cdp.emit("Page.screencastFrame", frame("jpeg", 1))
      ).not.toThrow();
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
