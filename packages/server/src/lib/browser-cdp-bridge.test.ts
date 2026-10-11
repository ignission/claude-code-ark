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

function fakeCdp() {
  const calls: CdpCall[] = [];
  const listeners = new Map<
    string,
    Array<(params: unknown, sessionId?: string) => void>
  >();
  const closeListeners: Array<() => void> = [];
  const failing = new Set<string>();
  let closed = false;

  const disconnect = () => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener();
  };

  const cdp = {
    get closed() {
      return closed;
    },
    // 失敗させる呼び出しも記録する (何を送ろうとしたかを確かめるため)
    send(method: string, params?: object, sessionId?: string) {
      if (closed) return Promise.reject(new Error("closed"));
      calls.push({ method, params, sessionId });
      if (failing.has(method)) {
        return Promise.reject(new Error(`${method}: failed`));
      }
      if (method === "Target.getTargets") {
        return Promise.resolve({
          targetInfos: [{ targetId: "T1", type: "page" }],
        });
      }
      if (method === "Target.attachToTarget") {
        return Promise.resolve({ sessionId: "S1" });
      }
      return Promise.resolve({});
    },
    on(method: string, listener: (params: unknown, sid?: string) => void) {
      const list = listeners.get(method) ?? [];
      list.push(listener);
      listeners.set(method, list);
    },
    onClose(listener: () => void) {
      closeListeners.push(listener);
    },
    close: vi.fn(disconnect),

    methods: () => calls.map(call => call.method),
    last(method: string) {
      const call = calls.findLast(c => c.method === method);
      return call && { params: call.params, sessionId: call.sessionId };
    },
    count: (method: string) => calls.filter(c => c.method === method).length,
    /** タブのsessionから来たイベントとして流す */
    emit(method: string, params: unknown) {
      for (const listener of listeners.get(method) ?? []) {
        listener(params, "S1");
      }
    },
    failOn(method: string) {
      failing.add(method);
    },
    /** Chromiumが落ちた、または接続が切れた状態を模す */
    disconnect,
  };
  return cdp as typeof cdp & CdpLike;
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
});
