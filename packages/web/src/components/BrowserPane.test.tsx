// @vitest-environment jsdom

import type { BrowserClientMessage } from "@ark/shared";
import { act, type ReactElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBrowserWsUrl } from "@/lib/auth-token";
import { BrowserPane } from "./BrowserPane";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  binaryType = "blob";
  readyState = FakeWebSocket.CONNECTING;
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { reason: string }) => void) | null = null;
  send = vi.fn<(data: string) => void>();
  close = vi.fn();
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  /** 送ったメッセージを、送った順に返す */
  sent(): BrowserClientMessage[] {
    return this.send.mock.calls.map(([data]) => JSON.parse(data));
  }
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  disconnect = vi.fn();
  constructor(readonly callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe() {}
  unobserve() {}
}

const sessionFixture = {
  id: "b1",
  targetUrl: "http://localhost:5173",
  createdAt: new Date(0),
};

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

class FakeMediaQueryList {
  matches = false;
  listeners = new Set<() => void>();
  constructor(readonly media: string) {}
  addEventListener(_type: string, listener: () => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: string, listener: () => void) {
    this.listeners.delete(listener);
  }
}

/**
 * 渡された部品を覚えておく `Blob`。`createImageBitmap` の偽物が、画像のバイト列から
 * 返すbitmapの寸法を決めるのに使う。
 */
class RecordingBlob extends Blob {
  readonly parts: BlobPart[];
  constructor(parts: BlobPart[] = [], options?: BlobPropertyBag) {
    super(parts, options);
    this.parts = parts;
  }
}

/** `frame` が画像の先頭バイトのあとに書いた寸法を読む。書かれていなければ1x1 */
function bitmapSize(blob: Blob): { width: number; height: number } {
  const part = (blob as RecordingBlob).parts?.[0];
  if (!(part instanceof Uint8Array) || part.length < 8) {
    return { width: 1, height: 1 };
  }
  const view = new DataView(part.buffer, part.byteOffset + 4, 4);
  return { width: view.getUint16(0), height: view.getUint16(2) };
}

/** ペインの寸法。jsdomはレイアウトを持たないので、テストごとに決める */
let paneSize = { width: 800, height: 600 };
/** canvasの矩形。`null` ならペインと同じ */
let canvasRect: Rect | null = null;
const drawImage = vi.fn();
/** `false` にすると、canvasの `getContext` が `null` を返す */
let contextAvailable = true;
let frameRequests = new Map<number, () => void>();
let nextFrameId = 1;
let mediaQueries: FakeMediaQueryList[] = [];
const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function mount(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mountedRoots.push({ root, container });
  return container;
}

function unmountAll() {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function viewportMessage(width: number, height: number, gen = 1) {
  return { data: JSON.stringify({ t: "viewport", width, height, gen }) };
}

interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const FULL: FrameRect = { x: 0, y: 0, width: 800, height: 600 };
const SMALL: FrameRect = { x: 10, y: 20, width: 30, height: 40 };
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const WEBP = [0x52, 0x49, 0x46, 0x46];

/**
 * サーバーが送るフレーム。11バイトのヘッダ (big-endian) のあとに画像が続く。
 * `pixels` は画像の画素数で、偽物の復号はこの寸法のbitmapを返す (既定は矩形と同じ)。
 * `image` を渡すと、画像のバイト列をそのまま使う。
 */
function frame(
  kind: 1 | 2 | 3,
  rect: FrameRect = FULL,
  {
    gen = 1,
    pixels = rect,
    image = [
      ...JPEG,
      pixels.width >> 8,
      pixels.width & 0xff,
      pixels.height >> 8,
      pixels.height & 0xff,
    ],
  }: {
    gen?: number;
    pixels?: { width: number; height: number };
    image?: number[];
  } = {}
) {
  const data = new ArrayBuffer(11 + image.length);
  const view = new DataView(data);
  view.setUint8(0, kind);
  view.setUint16(1, gen);
  view.setUint16(3, rect.x);
  view.setUint16(5, rect.y);
  view.setUint16(7, rect.width);
  view.setUint16(9, rect.height);
  new Uint8Array(data, 11).set(image);
  return { data };
}

/**
 * 描画して、WebSocketが開き、サーバーがビューポートの寸法を知らせたところまで進める。
 * `viewport` が `null` なら、寸法はまだ届いていない。
 */
function mountConnected(
  viewport: { width: number; height: number } | null = {
    width: 800,
    height: 600,
  }
) {
  const container = mount(<BrowserPane browserSession={sessionFixture} />);
  const ws = FakeWebSocket.instances[0];
  ws.readyState = FakeWebSocket.OPEN;
  act(() => {
    ws.onopen?.();
    if (viewport) {
      ws.onmessage?.(viewportMessage(viewport.width, viewport.height));
    }
  });
  ws.send.mockClear();
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  // canvasを置く領域。マウス、wheel、タッチはここで受ける (ツールバーは含まない)
  const surface = container.querySelector("canvas")
    ?.parentElement as HTMLDivElement;
  return { container, ws, textarea, surface };
}

/** ペインを隠す (寸法が0になり、ResizeObserverが知らせる) */
function hidePane() {
  paneSize = { width: 0, height: 0 };
  FakeResizeObserver.instances[0].callback();
}

function showPane() {
  paneSize = { width: 800, height: 600 };
  FakeResizeObserver.instances[0].callback();
}

function runFrame() {
  const pending = [...frameRequests.values()];
  frameRequests.clear();
  for (const run of pending) run();
}

function pasteEvent(text: string): Event {
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", {
    value: { getData: (type: string) => (type === "text/plain" ? text : "") },
  });
  return paste;
}

/** デコードの終わりをテストから決められる `createImageBitmap` に差し替える */
function holdDecodes() {
  const decodes: Array<{
    type: string;
    size: number;
    close: ReturnType<typeof vi.fn>;
    resolve(): void;
    reject(): void;
  }> = [];
  const decode = vi.fn(
    (blob: Blob) =>
      new Promise((resolve, reject) => {
        const close = vi.fn();
        decodes.push({
          type: blob.type,
          size: blob.size,
          close,
          resolve: () => resolve({ ...bitmapSize(blob), close }),
          reject: () => reject(new Error("decode failed")),
        });
      })
  );
  vi.stubGlobal("createImageBitmap", decode);
  return { decode, decodes };
}

function key(
  type: "keydown" | "keyup",
  init: KeyboardEventInit & { keyCode: number }
): KeyboardEvent {
  return new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
}

function mouse(type: string, init: MouseEventInit): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
}

function composition(type: string, data: string): CompositionEvent {
  return new CompositionEvent(type, { bubbles: true, data });
}

function input(isComposing: boolean): InputEvent {
  return new InputEvent("input", { bubbles: true, isComposing });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  FakeWebSocket.instances.length = 0;
  FakeResizeObserver.instances.length = 0;
  paneSize = { width: 800, height: 600 };
  canvasRect = null;
  frameRequests = new Map();
  nextFrameId = 1;
  mediaQueries = [];
  drawImage.mockReset();
  contextAvailable = true;
  vi.stubGlobal("Blob", RecordingBlob);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("devicePixelRatio", 1);
  vi.stubGlobal(
    "matchMedia",
    vi.fn((media: string) => {
      const query = new FakeMediaQueryList(media);
      mediaQueries.push(query);
      return query;
    })
  );
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => {
    const id = nextFrameId++;
    frameRequests.set(id, run);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frameRequests.delete(id);
  });
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async (blob: Blob) => ({ ...bitmapSize(blob), close: vi.fn() }))
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (canvasRect && this instanceof HTMLCanvasElement) {
        return canvasRect as DOMRect;
      }
      return {
        left: 10,
        top: 20,
        width: paneSize.width,
        height: paneSize.height,
      } as DOMRect;
    }
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() =>
    contextAvailable
      ? ({ drawImage } as unknown as CanvasRenderingContext2D)
      : null
  );
});

afterEach(() => {
  unmountAll();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BrowserPane", () => {
  it("buildBrowserWsUrl のURLへWebSocketを開き、接続中の表示を出す", () => {
    const container = mount(<BrowserPane browserSession={sessionFixture} />);

    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe(buildBrowserWsUrl("b1"));
    expect(ws.url).toContain("/browser/b1/ws");
    expect(ws.binaryType).toBe("arraybuffer");
    expect(container.textContent).toContain("接続中");

    ws.readyState = FakeWebSocket.OPEN;
    act(() => ws.onopen?.());
    expect(container.textContent).not.toContain("接続中");
  });

  it("開いたらペインの寸法を送り、寸法が変わるたびに送り直す", () => {
    mount(<BrowserPane browserSession={sessionFixture} />);
    const ws = FakeWebSocket.instances[0];
    ws.readyState = FakeWebSocket.OPEN;
    act(() => ws.onopen?.());

    expect(ws.sent()).toEqual([
      { t: "resize", width: 800, height: 600, dpr: 1, mobile: false },
    ]);

    paneSize = { width: 1024.4, height: 767.6 };
    act(() => FakeResizeObserver.instances[0].callback());
    expect(ws.sent()[1]).toEqual({
      t: "resize",
      width: 1024,
      height: 768,
      dpr: 1,
      mobile: false,
    });
  });

  it("隠れていて寸法が0の間は resize を送らない", () => {
    paneSize = { width: 0, height: 0 };
    mount(<BrowserPane browserSession={sessionFixture} />);
    const ws = FakeWebSocket.instances[0];
    ws.readyState = FakeWebSocket.OPEN;
    act(() => ws.onopen?.());
    act(() => FakeResizeObserver.instances[0].callback());

    expect(ws.send).not.toHaveBeenCalled();
  });

  it("canvasの寸法は `viewport` で決まり、その世代の最初の全画面を描くときに変える", async () => {
    const { container, ws } = mountConnected();
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    act(() => ws.onmessage?.(frame(1)));
    await flush();
    expect([canvas.width, canvas.height]).toEqual([800, 600]);

    // 手元の倍率が1.5以上なら2倍、それより低ければ等倍
    for (const [dpr, width, height] of [
      [2, 2002, 1400],
      [3, 2002, 1400],
      [1.5, 2002, 1400],
      [1.25, 1001, 700],
      [0.5, 1001, 700],
    ]) {
      vi.stubGlobal("devicePixelRatio", dpr);
      const gen = dpr * 100;
      const full = { x: 0, y: 0, width: 1001, height: 700 };
      act(() => {
        ws.onmessage?.(viewportMessage(1001, 700, gen));
        ws.onmessage?.(frame(1, full, { gen }));
      });
      await flush();
      expect([canvas.width, canvas.height]).toEqual([width, height]);
      expect(drawImage.mock.lastCall?.slice(1)).toEqual([0, 0, width, height]);
    }
  });

  it("2倍にすると画素数の上限を超えるビューポートは、等倍のcanvasにする", async () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const { container, ws } = mountConnected({ width: 3840, height: 2160 });
    const full = { x: 0, y: 0, width: 3840, height: 2160 };
    act(() => {
      ws.onmessage?.(frame(1, full));
      ws.onmessage?.(frame(3, { x: 100, y: 50, width: 304, height: 34 }));
    });
    await flush();
    await flush();

    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    expect([canvas.width, canvas.height]).toEqual([3840, 2160]);
    expect(drawImage.mock.calls.map(call => call.slice(1))).toEqual([
      [0, 0, 3840, 2160],
      [100, 50, 304, 34],
    ]);
  });

  it("世代が変わっても、新しい世代の全画面を描くまでは前の絵を消さない", async () => {
    const { decodes } = holdDecodes();
    const { container, ws, surface } = mountConnected();
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    act(() => ws.onmessage?.(frame(1)));
    decodes[0].resolve();
    await flush();
    // 描く時点のcanvasの寸法を控える
    const sizes: number[][] = [];
    drawImage.mockImplementation(() => {
      sizes.push([canvas.width, canvas.height]);
    });
    const setWidth = vi.spyOn(canvas, "width", "set");

    const full = { x: 0, y: 0, width: 1024, height: 768 };
    act(() => {
      ws.onmessage?.(viewportMessage(1024, 768, 2));
      ws.onmessage?.(frame(1, full, { gen: 2 }));
    });
    // 寸法を変えるとcanvasは消える。全画面の復号が終わるまで変えない
    expect([canvas.width, canvas.height]).toEqual([800, 600]);
    expect(setWidth).not.toHaveBeenCalled();

    // 座標の換算は、`viewport` が届いた時点で新しい寸法に替わる
    act(() =>
      surface.dispatchEvent(
        mouse("mousedown", { clientX: 410, clientY: 320, buttons: 1 })
      )
    );
    expect(ws.sent()).toMatchObject([
      { t: "resize", width: 800, height: 600 },
      { t: "mouse", type: "down", x: 512, y: 384 },
    ]);

    decodes[1].resolve();
    await flush();
    // 寸法を変えるのと描くのは同じ処理の中。空のcanvasが見える間が無い
    expect(sizes).toEqual([[1024, 768]]);
    expect(drawImage.mock.lastCall?.slice(1)).toEqual([0, 0, 1024, 768]);
  });

  it("同じ寸法のままなら、全画面を描くときにcanvasの寸法へ代入しない", async () => {
    const { container, ws } = mountConnected();
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    act(() => ws.onmessage?.(frame(1)));
    await flush();
    const setWidth = vi.spyOn(canvas, "width", "set");
    const setHeight = vi.spyOn(canvas, "height", "set");
    act(() => ws.onmessage?.(frame(1)));
    await flush();

    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(setWidth).not.toHaveBeenCalled();
    expect(setHeight).not.toHaveBeenCalled();
  });

  it("世代が同じまま寸法の違う `viewport` が届いたら、`refresh` を送り、次の全画面で寸法を変える", async () => {
    const { container, ws } = mountConnected();
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    act(() => ws.onmessage?.(frame(1)));
    await flush();

    act(() => ws.onmessage?.(viewportMessage(1024, 768, 1)));
    expect(ws.sent()).toEqual([{ t: "refresh" }]);
    expect([canvas.width, canvas.height]).toEqual([800, 600]);
    // 全画面が届くまで、矩形は描かない
    act(() => ws.onmessage?.(frame(3, SMALL)));
    await flush();
    expect(drawImage).toHaveBeenCalledTimes(1);

    act(() =>
      ws.onmessage?.(frame(1, { x: 0, y: 0, width: 1024, height: 768 }))
    );
    await flush();
    expect([canvas.width, canvas.height]).toEqual([1024, 768]);
  });

  it("読めない `viewport` は使わず、接続ごとに1回だけ警告して `refresh` を送る", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container, ws } = mountConnected();
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    const before = [canvas.width, canvas.height];
    for (const gen of [undefined, -1, 65536, 1.5, "1"]) {
      act(() =>
        ws.onmessage?.({
          data: JSON.stringify({ t: "viewport", width: 640, height: 480, gen }),
        })
      );
    }
    act(() =>
      ws.onmessage?.({
        data: JSON.stringify({ t: "viewport", width: 0, height: 480, gen: 2 }),
      })
    );

    expect([canvas.width, canvas.height]).toEqual(before);
    expect(warn).toHaveBeenCalledTimes(1);
    // 続けて届いた分は、間隔が空くまで送らない
    expect(ws.sent()).toEqual([{ t: "refresh" }]);
  });

  it("読めないJSONや、ほかの種類のメッセージでは `refresh` を送らない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ws } = mountConnected();
    act(() => {
      ws.onmessage?.({ data: "{" });
      ws.onmessage?.({ data: JSON.stringify({ t: "unknown" }) });
    });

    expect(ws.send).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("届いた全画面をcanvasの全体に描く", async () => {
    const { container, ws } = mountConnected();
    act(() => ws.onmessage?.(frame(1)));
    await flush();

    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(drawImage.mock.calls[0].slice(1)).toEqual([0, 0, 800, 600]);
    // canvasの寸法は、画像の寸法ではなくビューポートで決まる
    expect([canvas.width, canvas.height]).toEqual([800, 600]);
  });

  it("粗い全画面は、canvasの全体へ引き伸ばして描く", async () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const { container, ws } = mountConnected();
    // 画像はビューポートの半分の画素数
    act(() =>
      ws.onmessage?.(frame(2, FULL, { pixels: { width: 400, height: 300 } }))
    );
    await flush();

    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    expect([canvas.width, canvas.height]).toEqual([1600, 1200]);
    expect(drawImage.mock.calls[0][0]).toMatchObject({
      width: 400,
      height: 300,
    });
    expect(drawImage.mock.calls[0].slice(1)).toEqual([0, 0, 1600, 1200]);
  });

  it("矩形は、ヘッダの位置と寸法で描く", async () => {
    const { ws } = mountConnected();
    act(() => {
      ws.onmessage?.(frame(1));
      ws.onmessage?.(frame(3, { x: 100, y: 50, width: 304, height: 34 }));
    });
    await flush();
    await flush();

    expect(drawImage.mock.calls[1].slice(1)).toEqual([100, 50, 304, 34]);
  });

  it("canvasが2倍なら、矩形の位置と寸法も2倍にする", async () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const { ws } = mountConnected();
    act(() => {
      ws.onmessage?.(frame(1));
      ws.onmessage?.(frame(3, { x: 100, y: 50, width: 304, height: 34 }));
    });
    await flush();
    await flush();

    expect(drawImage.mock.calls[1].slice(1)).toEqual([200, 100, 608, 68]);
  });

  it("手元の倍率が整数でなくても、矩形はcanvasの画素の境目へちょうど描く", async () => {
    vi.stubGlobal("devicePixelRatio", 1.5);
    const { container, ws } = mountConnected({ width: 1001, height: 601 });
    act(() => {
      ws.onmessage?.(frame(1, { x: 0, y: 0, width: 1001, height: 601 }));
      // 画像は、ページの倍率 (2倍) の画素数で届く
      ws.onmessage?.(
        frame(
          3,
          { x: 3, y: 5, width: 2, height: 4 },
          { pixels: { width: 4, height: 8 } }
        )
      );
    });
    await flush();
    await flush();

    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    expect([canvas.width, canvas.height]).toEqual([2002, 1202]);
    expect(drawImage.mock.calls[1][0]).toMatchObject({ width: 4, height: 8 });
    expect(drawImage.mock.calls[1].slice(1)).toEqual([6, 10, 4, 8]);
  });

  it("世代の違うフレームと、`viewport` より前のフレームは描かない", async () => {
    const { decode } = holdDecodes();
    const { ws } = mountConnected(null);
    act(() => ws.onmessage?.(frame(1)));
    expect(decode).not.toHaveBeenCalled();

    act(() => {
      ws.onmessage?.(viewportMessage(800, 600, 7));
      ws.onmessage?.(frame(1, FULL, { gen: 6 }));
      ws.onmessage?.(frame(1, FULL, { gen: 8 }));
    });
    await flush();
    expect(decode).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();

    act(() => ws.onmessage?.(frame(1, FULL, { gen: 7 })));
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it("全画面が届くまで、矩形は描かない", async () => {
    const { decode } = holdDecodes();
    const { ws } = mountConnected();
    act(() => ws.onmessage?.(frame(3, SMALL)));
    expect(decode).not.toHaveBeenCalled();

    // 世代が変わったあとも、その世代の全画面を待つ
    act(() => {
      ws.onmessage?.(frame(1));
      ws.onmessage?.(viewportMessage(800, 600, 2));
      ws.onmessage?.(frame(3, SMALL, { gen: 2 }));
    });
    expect(decode).toHaveBeenCalledTimes(1);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("復号は1枚ずつ行い、待っている矩形を届いた順に全部描く", async () => {
    const { decode, decodes } = holdDecodes();
    const { ws } = mountConnected();
    act(() => {
      ws.onmessage?.(frame(1));
      ws.onmessage?.(frame(3, { x: 10, y: 0, width: 1, height: 1 }));
      ws.onmessage?.(frame(3, { x: 20, y: 0, width: 1, height: 1 }));
      ws.onmessage?.(frame(3, { x: 30, y: 0, width: 1, height: 1 }));
    });
    expect(decode).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 4; i++) {
      // 前の1枚を描き終えるまで、次の復号を始めない
      expect(decodes).toHaveLength(i + 1);
      decodes[i].resolve();
      await flush();
      expect(drawImage).toHaveBeenCalledTimes(i + 1);
    }
    expect(drawImage.mock.calls.map(call => call[1])).toEqual([0, 10, 20, 30]);
    expect(decodes.every(d => d.close.mock.calls.length === 1)).toBe(true);
  });

  it("全画面が届いたら、その前で待っていたフレームは復号せずに捨てる", async () => {
    const { decodes } = holdDecodes();
    const { ws } = mountConnected();
    act(() => {
      ws.onmessage?.(frame(1));
      ws.onmessage?.(frame(3, { x: 10, y: 0, width: 1, height: 1 }));
      ws.onmessage?.(frame(3, { x: 20, y: 0, width: 1, height: 1 }));
      ws.onmessage?.(frame(2));
      ws.onmessage?.(frame(3, { x: 30, y: 0, width: 1, height: 1 }));
    });
    for (let i = 0; i < 3; i++) {
      decodes[i].resolve();
      await flush();
    }

    // 復号の途中だった最初の全画面は描く。そのあとに粗い全画面が上書きする
    expect(decodes).toHaveLength(3);
    expect(drawImage.mock.calls.map(call => call.slice(1))).toEqual([
      [0, 0, 800, 600],
      [0, 0, 800, 600],
      [30, 0, 1, 1],
    ]);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("復号の途中で世代が変わったフレームは、描かずに解放する", async () => {
    const { decodes } = holdDecodes();
    const { ws } = mountConnected();
    act(() => {
      ws.onmessage?.(frame(1));
      ws.onmessage?.(frame(3, SMALL));
      ws.onmessage?.(viewportMessage(1024, 768, 2));
    });
    decodes[0].resolve();
    await flush();

    expect(drawImage).not.toHaveBeenCalled();
    expect(decodes).toHaveLength(1);
    expect(decodes[0].close).toHaveBeenCalledTimes(1);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("画像の先頭バイトで `Blob` の `type` を決め、ヘッダは渡さない", async () => {
    const { decodes } = holdDecodes();
    const { ws } = mountConnected();
    act(() => ws.onmessage?.(frame(1, FULL, { image: [...JPEG, 1, 2] })));
    decodes[0].resolve();
    await flush();
    act(() => ws.onmessage?.(frame(3, SMALL, { image: [...WEBP, 1, 2, 3] })));

    expect(decodes.map(d => [d.type, d.size])).toEqual([
      ["image/jpeg", 6],
      ["image/webp", 7],
    ]);
  });

  it("復号に失敗したら `refresh` を送り、次の全画面まで矩形を描かない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { decodes } = holdDecodes();
    const { ws } = mountConnected();
    act(() => {
      ws.onmessage?.(frame(1));
      ws.onmessage?.(frame(3, SMALL));
      ws.onmessage?.(frame(3, SMALL));
    });
    decodes[0].resolve();
    await flush();
    decodes[1].reject();
    await flush();

    expect(ws.sent()).toEqual([{ t: "refresh" }]);
    // 待っていた矩形も、あとから届く矩形も、穴の空いた絵には重ねない
    act(() => ws.onmessage?.(frame(3, SMALL)));
    await flush();
    expect(decodes).toHaveLength(2);

    act(() => {
      ws.onmessage?.(frame(1));
      ws.onmessage?.(frame(3, SMALL));
    });
    decodes[2].resolve();
    await flush();
    decodes[3].resolve();
    await flush();
    expect(drawImage).toHaveBeenCalledTimes(3);
    expect(ws.sent()).toEqual([{ t: "refresh" }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("復号の失敗が続いても、警告は接続ごとに1回だけ出す", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { decodes } = holdDecodes();
    const { ws } = mountConnected();
    for (const decoded of [false, false, true]) {
      act(() => ws.onmessage?.(frame(1)));
      const last = decodes[decodes.length - 1];
      if (decoded) last.resolve();
      else last.reject();
      await flush();
    }

    expect(decodes).toHaveLength(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(drawImage).toHaveBeenCalledTimes(1);
  });

  it("`createImageBitmap` が同期で投げても `refresh` を送り、次の全画面を描ける", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const decode = vi.fn<() => Promise<unknown>>(() => {
      throw new Error("unsupported");
    });
    vi.stubGlobal("createImageBitmap", decode);
    const { ws } = mountConnected();
    act(() => ws.onmessage?.(frame(1)));
    await flush();
    expect(ws.sent()).toEqual([{ t: "refresh" }]);

    decode.mockImplementation(async () => ({
      width: 800,
      height: 600,
      close: vi.fn(),
    }));
    act(() => ws.onmessage?.(frame(1)));
    await flush();
    expect(drawImage).toHaveBeenCalledTimes(1);
  });

  it("JPEGでもWebPでもない画像は復号せず、`refresh` を送る", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { decode } = holdDecodes();
    const { ws } = mountConnected();
    act(() =>
      ws.onmessage?.(frame(1, FULL, { image: [0x89, 0x50, 0x4e, 0x47] }))
    );
    await flush();

    expect(decode).not.toHaveBeenCalled();
    expect(ws.sent()).toEqual([{ t: "refresh" }]);
  });

  it("ヘッダを読めないフレームは取りこぼしとして `refresh` を送る", async () => {
    const { decode } = holdDecodes();
    const { ws } = mountConnected();
    act(() => ws.onmessage?.({ data: new ArrayBuffer(8) }));

    expect(decode).not.toHaveBeenCalled();
    expect(ws.sent()).toEqual([{ t: "refresh" }]);
  });

  it("待ち行列が上限を超えたら、行列を空にして `refresh` を送る", async () => {
    const { decodes } = holdDecodes();
    const { ws } = mountConnected();
    // 最初の全画面は復号の途中。そのあとの矩形が行列に溜まる
    act(() => {
      ws.onmessage?.(frame(1));
      for (let i = 0; i < 64; i++) ws.onmessage?.(frame(3, SMALL));
    });
    expect(ws.send).not.toHaveBeenCalled();

    act(() => ws.onmessage?.(frame(3, SMALL)));
    expect(ws.sent()).toEqual([{ t: "refresh" }]);

    decodes[0].resolve();
    await flush();
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(decodes).toHaveLength(1);
  });

  it("復号の失敗が続く間は、`refresh` を送る間隔を倍にしていき、8秒で止める", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { decodes } = holdDecodes();
    const { ws } = mountConnected();
    const fail = async () => {
      act(() => ws.onmessage?.(frame(1)));
      decodes[decodes.length - 1].reject();
      await flush();
    };
    const refreshes = () => ws.sent().filter(m => m.t === "refresh").length;

    await fail();
    expect(refreshes()).toBe(1);
    // 頼むたびに届く全画面が、毎回復号に失敗する
    let sent = 1;
    for (const interval of [1000, 2000, 4000, 8000, 8000, 8000]) {
      await fail();
      act(() => vi.advanceTimersByTime(interval - 1));
      expect(refreshes()).toBe(sent);
      act(() => vi.advanceTimersByTime(1));
      sent += 1;
      expect(refreshes()).toBe(sent);
    }
    // 頼んだあとに何も届かなければ、送り続けない
    act(() => vi.advanceTimersByTime(60_000));
    expect(refreshes()).toBe(sent);
  });

  it("1枚描けたら、`refresh` を送る間隔を元へ戻す", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { decodes } = holdDecodes();
    const { ws } = mountConnected();
    const receive = async (decoded: boolean) => {
      act(() => ws.onmessage?.(frame(1)));
      const last = decodes[decodes.length - 1];
      if (decoded) last.resolve();
      else last.reject();
      await flush();
    };
    const refreshes = () => ws.sent().filter(m => m.t === "refresh").length;

    await receive(false);
    await receive(false);
    await receive(false);
    await receive(true);
    expect(refreshes()).toBe(1);

    // 失敗の数え直し。1回目はすぐ、2回目は1秒後
    act(() => vi.advanceTimersByTime(600));
    await receive(false);
    expect(refreshes()).toBe(2);
    await receive(false);
    act(() => vi.advanceTimersByTime(999));
    expect(refreshes()).toBe(2);
    act(() => vi.advanceTimersByTime(1));
    expect(refreshes()).toBe(3);
  });

  it("復号の失敗のほかの理由で頼む `refresh` は、間隔を延ばさない", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { decodes } = holdDecodes();
    const { ws } = mountConnected();
    for (let i = 0; i < 3; i++) {
      act(() => ws.onmessage?.(frame(1)));
      decodes[i].reject();
      await flush();
    }
    // 復号の失敗の分は、前に送ってから2秒後まで待つ
    act(() => vi.advanceTimersByTime(100));
    expect(ws.sent()).toEqual([{ t: "refresh" }]);

    // ヘッダを読めないフレームの分は、前に送ってから500ms後に送る
    act(() => ws.onmessage?.({ data: new ArrayBuffer(8) }));
    act(() => vi.advanceTimersByTime(399));
    expect(ws.sent()).toEqual([{ t: "refresh" }]);
    act(() => vi.advanceTimersByTime(1));
    expect(ws.sent()).toEqual([{ t: "refresh" }, { t: "refresh" }]);
    act(() => vi.advanceTimersByTime(60_000));
    expect(ws.sent()).toHaveLength(2);
  });

  it("矩形の復号に失敗しても、全画面が待っていれば `refresh` を送らずに続きを描く", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { decodes } = holdDecodes();
    const { ws } = mountConnected();
    act(() => ws.onmessage?.(frame(1)));
    decodes[0].resolve();
    await flush();
    act(() => {
      // 1枚目の矩形は復号の途中。そのあとに全画面と矩形が届いて待つ
      ws.onmessage?.(frame(3, SMALL));
      ws.onmessage?.(frame(2));
      ws.onmessage?.(frame(3, { x: 30, y: 0, width: 1, height: 1 }));
    });
    decodes[1].reject();
    await flush();
    expect(ws.send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);

    // 待っていた全画面が絵を直し、そのあとの矩形も描く
    expect(decodes).toHaveLength(3);
    decodes[2].resolve();
    await flush();
    decodes[3].resolve();
    await flush();
    expect(drawImage.mock.calls.map(call => call.slice(1))).toEqual([
      [0, 0, 800, 600],
      [0, 0, 800, 600],
      [30, 0, 1, 1],
    ]);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("粗い全画面が届いたら、待っている `refresh` を取り消し、そのあとの矩形を重ねて描く", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { decodes } = holdDecodes();
    const { ws } = mountConnected();
    for (let i = 0; i < 2; i++) {
      act(() => ws.onmessage?.(frame(1)));
      decodes[i].reject();
      await flush();
    }
    expect(ws.sent()).toEqual([{ t: "refresh" }]);

    act(() => {
      ws.onmessage?.(frame(2, FULL, { pixels: { width: 400, height: 300 } }));
      ws.onmessage?.(frame(3, SMALL));
    });
    decodes[2].resolve();
    await flush();
    decodes[3].resolve();
    await flush();
    act(() => vi.advanceTimersByTime(60_000));

    expect(drawImage.mock.calls.map(call => call.slice(1))).toEqual([
      [0, 0, 800, 600],
      [10, 20, 30, 40],
    ]);
    expect(ws.sent()).toEqual([{ t: "refresh" }]);
  });

  it("世代が変わったら、待っている `refresh` を取り消す", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { decodes } = holdDecodes();
    const { ws } = mountConnected();
    for (let i = 0; i < 2; i++) {
      act(() => ws.onmessage?.(frame(1)));
      decodes[i].reject();
      await flush();
    }
    // 新しい世代の全画面は、頼まなくても届く
    act(() => ws.onmessage?.(viewportMessage(1024, 768, 2)));
    act(() => vi.advanceTimersByTime(60_000));

    expect(ws.sent()).toEqual([{ t: "refresh" }]);
  });

  it("隠れている間に `refresh` を送る時刻が来ても送らず、見えるようになったら1回送る", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { decodes } = holdDecodes();
    const { ws } = mountConnected();
    for (let i = 0; i < 2; i++) {
      act(() => ws.onmessage?.(frame(1)));
      decodes[i].reject();
      await flush();
    }
    act(() => hidePane());
    act(() => vi.advanceTimersByTime(60_000));
    expect(ws.sent()).toEqual([{ t: "refresh" }]);

    act(() => {
      showPane();
      FakeResizeObserver.instances[0].callback();
    });
    act(() => vi.advanceTimersByTime(60_000));
    expect(ws.sent().filter(m => m.t === "refresh")).toHaveLength(2);
  });

  it("canvasの描画先が取れなければ、取りこぼしとして `refresh` を送る", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { decodes } = holdDecodes();
    const { container, ws } = mountConnected({ width: 1024, height: 768 });
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    const before = [canvas.width, canvas.height];
    const full = { x: 0, y: 0, width: 1024, height: 768 };
    contextAvailable = false;
    act(() => {
      ws.onmessage?.(frame(1, full));
      ws.onmessage?.(frame(3, SMALL));
    });
    decodes[0].resolve();
    await flush();

    expect(drawImage).not.toHaveBeenCalled();
    expect(decodes[0].close).toHaveBeenCalledTimes(1);
    expect([canvas.width, canvas.height]).toEqual(before);
    expect(ws.sent()).toEqual([{ t: "refresh" }]);
    expect(warn).toHaveBeenCalledTimes(1);
    // 待っていた矩形は、描けなかった全画面に重ねない
    expect(decodes).toHaveLength(1);

    contextAvailable = true;
    act(() => ws.onmessage?.(frame(1, full)));
    decodes[1].resolve();
    await flush();
    expect(drawImage.mock.calls[0].slice(1)).toEqual([0, 0, 1024, 768]);
    expect([canvas.width, canvas.height]).toEqual([1024, 768]);
  });

  it("送るのを待っている間に全画面を描けたら、`refresh` は送らない", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { decodes } = holdDecodes();
    const { ws } = mountConnected();
    for (let i = 0; i < 2; i++) {
      act(() => ws.onmessage?.(frame(1)));
      decodes[i].reject();
      await flush();
    }
    act(() => ws.onmessage?.(frame(1)));
    decodes[2].resolve();
    await flush();
    act(() => vi.advanceTimersByTime(5000));

    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(ws.sent()).toEqual([{ t: "refresh" }]);
  });

  it("WebSocketが開いていなければ `refresh` を送らない", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { decodes } = holdDecodes();
    const { ws } = mountConnected();
    act(() => ws.onmessage?.(frame(1)));
    ws.readyState = FakeWebSocket.CLOSING;
    decodes[0].reject();
    await flush();

    expect(ws.send).not.toHaveBeenCalled();
  });

  it("隠れている間のフレームは復号せず、見えるようになったら `refresh` を1回送る", async () => {
    const { decode, decodes } = holdDecodes();
    const { ws } = mountConnected();
    act(() => ws.onmessage?.(frame(1)));
    decodes[0].resolve();
    await flush();

    act(() => {
      hidePane();
      ws.onmessage?.(frame(3, SMALL));
      ws.onmessage?.(frame(1));
      ws.onmessage?.(frame(3, SMALL));
    });
    await flush();
    expect(decode).toHaveBeenCalledTimes(1);
    expect(ws.send).not.toHaveBeenCalled();

    paneSize = { width: 800, height: 600 };
    act(() => {
      FakeResizeObserver.instances[0].callback();
      FakeResizeObserver.instances[0].callback();
    });
    expect(ws.sent().filter(m => m.t === "refresh")).toHaveLength(1);

    // 隠れている間に全画面を逃したので、次の全画面まで矩形は描かない
    act(() => ws.onmessage?.(frame(3, SMALL)));
    expect(decode).toHaveBeenCalledTimes(1);
    act(() => ws.onmessage?.(frame(1)));
    decodes[1].resolve();
    await flush();
    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(ws.sent().filter(m => m.t === "refresh")).toHaveLength(1);
  });

  it("隠れているかどうかは寸法の監視で知り、フレームのたびにレイアウトを読まない", async () => {
    const { ws } = mountConnected();
    const measure = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
    measure.mockClear();
    act(() => {
      ws.onmessage?.(frame(1));
      ws.onmessage?.(frame(3, SMALL));
      ws.onmessage?.(frame(3, SMALL));
    });
    await flush();
    await flush();
    await flush();

    expect(drawImage).toHaveBeenCalledTimes(3);
    expect(measure).not.toHaveBeenCalled();
  });

  it("隠れたままマウントされたら、見えるようになるまでフレームを復号しない", async () => {
    paneSize = { width: 0, height: 0 };
    const { decode } = holdDecodes();
    const { ws } = mountConnected();
    act(() => ws.onmessage?.(frame(1)));
    expect(decode).not.toHaveBeenCalled();

    act(() => showPane());
    expect(ws.sent().filter(m => m.t === "refresh")).toHaveLength(1);
    act(() => ws.onmessage?.(frame(1)));
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it("復号を待つフレームがあるまま隠れたら、復号せずに捨てて、見えたときに `refresh` を送る", async () => {
    const { decodes } = holdDecodes();
    const { ws } = mountConnected();
    act(() => {
      ws.onmessage?.(frame(1));
      ws.onmessage?.(frame(3, SMALL));
    });
    act(() => hidePane());
    decodes[0].resolve();
    await flush();
    expect(decodes).toHaveLength(1);
    expect(ws.send).not.toHaveBeenCalled();

    paneSize = { width: 800, height: 600 };
    act(() => FakeResizeObserver.instances[0].callback());
    expect(ws.sent().filter(m => m.t === "refresh")).toHaveLength(1);
  });

  it("見えるようになったときの `refresh` も、間隔を空けて送る", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { decodes } = holdDecodes();
    const { ws } = mountConnected();
    act(() => ws.onmessage?.(frame(1)));
    decodes[0].reject();
    await flush();
    ws.send.mockClear();

    act(() => {
      hidePane();
      ws.onmessage?.(frame(1));
    });
    act(() => showPane());
    expect(ws.sent().filter(m => m.t === "refresh")).toHaveLength(0);

    act(() => vi.advanceTimersByTime(500));
    expect(ws.sent().filter(m => m.t === "refresh")).toHaveLength(1);
  });

  it("送るのを待っている `refresh` は、アンマウントで取り消す", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { decodes } = holdDecodes();
    const { ws } = mountConnected();
    for (let i = 0; i < 2; i++) {
      act(() => ws.onmessage?.(frame(1)));
      decodes[i].reject();
      await flush();
    }
    unmountAll();
    act(() => vi.advanceTimersByTime(5000));

    expect(ws.sent()).toEqual([{ t: "refresh" }]);
  });

  it("再接続のあとに復号が終わった前の接続のフレームは、描かずに解放する", async () => {
    const { decodes } = holdDecodes();
    const { container, ws } = mountConnected();
    act(() => {
      ws.onmessage?.(frame(1));
      // 復号を待つ間に届いた分は、つなぎ直したら捨てる
      ws.onmessage?.(frame(3, SMALL));
      ws.onclose?.({ reason: "" });
    });
    const retry = Array.from(container.querySelectorAll("button")).find(
      b => b.textContent?.trim() === "再接続"
    );
    act(() => retry?.click());
    expect(FakeWebSocket.instances).toHaveLength(2);

    decodes[0].resolve();
    await flush();
    expect(drawImage).not.toHaveBeenCalled();
    expect(decodes).toHaveLength(1);
    expect(decodes[0].close).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances[1].send).not.toHaveBeenCalled();
  });

  it("再接続したら、前の接続のビューポートと世代を忘れる", async () => {
    const { decode } = holdDecodes();
    const { container, ws } = mountConnected();
    act(() => ws.onclose?.({ reason: "" }));
    const retry = Array.from(container.querySelectorAll("button")).find(
      b => b.textContent?.trim() === "再接続"
    );
    act(() => retry?.click());
    const next = FakeWebSocket.instances[1];
    next.readyState = FakeWebSocket.OPEN;
    act(() => {
      next.onopen?.();
      // 新しい接続の `viewport` が届くまでは、同じ世代の番号でも描かない
      next.onmessage?.(frame(1));
    });
    expect(decode).not.toHaveBeenCalled();

    act(() => {
      next.onmessage?.(viewportMessage(800, 600, 1));
      next.onmessage?.(frame(3, SMALL));
      next.onmessage?.(frame(1));
    });
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it("アンマウントのあとに復号が終わったフレームは、描かずに解放する", async () => {
    const { decodes } = holdDecodes();
    const { ws } = mountConnected();
    act(() => ws.onmessage?.(frame(1)));
    unmountAll();

    decodes[0].resolve();
    await flush();
    expect(drawImage).not.toHaveBeenCalled();
    expect(decodes[0].close).toHaveBeenCalledTimes(1);
  });

  it("文字のキーは key として送り、手元の入力欄には入れない", () => {
    const { ws, textarea } = mountConnected();
    const down = key("keydown", { key: "a", code: "KeyA", keyCode: 65 });
    act(() => {
      textarea.dispatchEvent(down);
      textarea.dispatchEvent(
        key("keyup", { key: "a", code: "KeyA", keyCode: 65 })
      );
    });

    expect(down.defaultPrevented).toBe(true);
    expect(ws.sent()).toEqual([
      {
        t: "key",
        type: "down",
        key: "a",
        code: "KeyA",
        keyCode: 65,
        text: "a",
        repeat: false,
        modifiers: 0,
      },
      {
        t: "key",
        type: "up",
        key: "a",
        code: "KeyA",
        keyCode: 65,
        repeat: false,
        modifiers: 0,
      },
    ]);
  });

  it("コピーのショートカットは、`copy` と、普通のキーの両方を送る", () => {
    const { ws, textarea } = mountConnected();
    const down = key("keydown", {
      key: "c",
      code: "KeyC",
      keyCode: 67,
      ctrlKey: true,
    });
    act(() => {
      textarea.dispatchEvent(down);
      // 押したままの繰り返しでは、もう読みに行かない
      textarea.dispatchEvent(
        key("keydown", {
          key: "c",
          code: "KeyC",
          keyCode: 67,
          ctrlKey: true,
          repeat: true,
        })
      );
      textarea.dispatchEvent(
        key("keyup", { key: "c", code: "KeyC", keyCode: 67, ctrlKey: true })
      );
    });

    expect(down.defaultPrevented).toBe(true);
    expect(ws.sent()).toMatchObject([
      { t: "copy" },
      { t: "key", type: "down", key: "c", modifiers: 2, repeat: false },
      { t: "key", type: "down", key: "c", modifiers: 2, repeat: true },
      { t: "key", type: "up", key: "c" },
    ]);
  });

  it("切り取りのショートカットは、リモートが切り取る前に読めるよう、`copy` を先に送る", () => {
    const { ws, textarea } = mountConnected();
    act(() => {
      textarea.dispatchEvent(
        key("keydown", { key: "x", code: "KeyX", keyCode: 88, metaKey: true })
      );
    });

    expect(ws.sent()).toMatchObject([
      { t: "copy" },
      { t: "key", type: "down", key: "x", modifiers: 4 },
    ]);
  });

  it("IMEが受け取ったキー (keyCode 229) は送らず、既定の動作も止めない", () => {
    const { ws, textarea } = mountConnected();
    const down = key("keydown", { key: "Process", code: "KeyA", keyCode: 229 });
    act(() => textarea.dispatchEvent(down));

    expect(down.defaultPrevented).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("Ctrl+V はキーとして送らず、paste イベントの文字列を送る", () => {
    const { ws, textarea } = mountConnected();
    const down = key("keydown", {
      key: "v",
      code: "KeyV",
      keyCode: 86,
      ctrlKey: true,
    });
    act(() => {
      textarea.dispatchEvent(down);
      // 修飾キーを先に離したときの up も送らない
      textarea.dispatchEvent(
        key("keyup", { key: "v", code: "KeyV", keyCode: 86 })
      );
    });
    expect(down.defaultPrevented).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();

    const paste = pasteEvent("貼る");
    act(() => textarea.dispatchEvent(paste));

    expect(paste.defaultPrevented).toBe(true);
    expect(ws.sent()).toEqual([{ t: "paste", text: "貼る" }]);
  });

  it("Chromeの順 (compositionend のあとに input) で確定を1回だけ送る", () => {
    const { ws, textarea } = mountConnected();
    act(() => {
      textarea.dispatchEvent(composition("compositionstart", ""));
      textarea.value = "あ";
      textarea.dispatchEvent(composition("compositionupdate", "あ"));
      textarea.dispatchEvent(input(true));
      textarea.value = "亜";
      textarea.dispatchEvent(composition("compositionend", "亜"));
      textarea.dispatchEvent(input(false));
    });

    expect(ws.sent()).toEqual([
      {
        t: "ime",
        type: "update",
        text: "あ",
        selectionStart: 1,
        selectionEnd: 1,
      },
      { t: "ime", type: "commit", text: "亜" },
    ]);
    expect(textarea.value).toBe("");
  });

  it("Firefoxの順 (input が compositionend より先) でも確定を1回だけ送る", () => {
    const { ws, textarea } = mountConnected();
    act(() => {
      textarea.dispatchEvent(composition("compositionstart", ""));
      textarea.value = "あ";
      textarea.dispatchEvent(composition("compositionupdate", "あ"));
      textarea.value = "亜";
      textarea.dispatchEvent(input(true));
      textarea.dispatchEvent(composition("compositionend", "亜"));
    });

    const commits = ws.sent().filter(m => m.t === "ime" && m.type === "commit");
    expect(commits).toEqual([{ t: "ime", type: "commit", text: "亜" }]);
    expect(textarea.value).toBe("");
  });

  it("変換を取り消したら cancel を送る", () => {
    const { ws, textarea } = mountConnected();
    act(() => {
      textarea.dispatchEvent(composition("compositionstart", ""));
      textarea.dispatchEvent(composition("compositionend", ""));
    });

    expect(ws.sent()).toEqual([{ t: "ime", type: "cancel" }]);
  });

  it("変換の途中でフォーカスが外れたら cancel を送り、遅れて来た確定は送らない", () => {
    const { ws, textarea } = mountConnected();
    act(() => {
      textarea.focus();
      textarea.dispatchEvent(composition("compositionstart", ""));
      textarea.value = "あ";
      textarea.blur();
      textarea.dispatchEvent(composition("compositionend", "あ"));
    });

    expect(ws.sent()).toEqual([{ t: "ime", type: "cancel" }]);
    expect(textarea.value).toBe("");
  });

  it("変換を経ない入力は input から確定として送る", () => {
    const { ws, textarea } = mountConnected();
    act(() => {
      textarea.value = "😀";
      textarea.dispatchEvent(input(false));
    });

    expect(ws.sent()).toEqual([{ t: "ime", type: "commit", text: "😀" }]);
    expect(textarea.value).toBe("");
  });

  it("押した位置をcanvasの左上からの座標で送り、入力欄をそこへ動かしてフォーカスする", () => {
    const { ws, textarea, surface } = mountConnected();
    const down = mouse("mousedown", {
      clientX: 110,
      clientY: 70,
      button: 0,
      buttons: 1,
      detail: 1,
    });
    act(() => surface.dispatchEvent(down));

    expect(down.defaultPrevented).toBe(true);
    expect(ws.sent()).toMatchObject([
      { t: "mouse", type: "down", x: 100, y: 50, button: 0, clickCount: 1 },
    ]);
    expect(textarea.style.left).toBe("100px");
    expect(textarea.style.top).toBe("50px");
    expect(document.activeElement).toBe(textarea);
  });

  it("座標は、canvasの矩形とサーバーが知らせたビューポートの寸法で換算する", () => {
    // ペインは (10, 20) の800x600、canvasは (30, 40) の400x300、ビューポートは1200x900
    canvasRect = { left: 30, top: 40, width: 400, height: 300 };
    const { ws, textarea, surface } = mountConnected({
      width: 1200,
      height: 900,
    });
    act(() => {
      surface.dispatchEvent(
        mouse("mousemove", { clientX: 50, clientY: 50, buttons: 0 })
      );
      runFrame();
    });
    expect(ws.sent()).toMatchObject([{ type: "move", x: 60, y: 30 }]);
    ws.send.mockClear();

    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 230,
      clientY: 190,
      deltaY: 120,
    });
    act(() => surface.dispatchEvent(wheel));
    // deltaはビューポートのCSSピクセルのまま送る
    expect(ws.sent()).toMatchObject([
      { type: "wheel", x: 600, y: 450, deltaY: 120 },
    ]);
    ws.send.mockClear();

    act(() =>
      surface.dispatchEvent(
        mouse("mousedown", { clientX: 130, clientY: 140, buttons: 1 })
      )
    );
    expect(ws.sent()).toMatchObject([
      // ビューポートがこのペインの寸法と違うので、先に自分の寸法を送る
      { t: "resize", width: 800, height: 600 },
      { t: "mouse", type: "down", x: 300, y: 300 },
    ]);
    // 入力欄はペインの左上から測る
    expect(textarea.style.left).toBe("120px");
    expect(textarea.style.top).toBe("120px");
  });

  it("手元の倍率は座標に使わない", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const { ws, surface } = mountConnected();
    act(() =>
      surface.dispatchEvent(
        mouse("mousedown", { clientX: 110, clientY: 70, buttons: 1 })
      )
    );

    expect(ws.sent()).toMatchObject([{ type: "down", x: 100, y: 50 }]);
  });

  it("ビューポートの寸法が届くまで、マウスとwheelは送らない", () => {
    const { ws, surface } = mountConnected(null);
    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 110,
      clientY: 70,
      deltaY: 120,
    });
    act(() => {
      surface.dispatchEvent(
        mouse("mousemove", { clientX: 20, clientY: 30, buttons: 0 })
      );
      runFrame();
      surface.dispatchEvent(
        mouse("mousedown", { clientX: 110, clientY: 70, buttons: 1 })
      );
      window.dispatchEvent(
        mouse("mouseup", { clientX: 110, clientY: 70, buttons: 0 })
      );
      surface.dispatchEvent(wheel);
    });

    expect(ws.send).not.toHaveBeenCalled();
    // 届いたら送る
    act(() => {
      ws.onmessage?.(viewportMessage(800, 600));
      surface.dispatchEvent(
        mouse("mousedown", { clientX: 110, clientY: 70, buttons: 1 })
      );
    });
    expect(ws.sent()).toMatchObject([{ type: "down", x: 100, y: 50 }]);
  });

  it("ビューポートの寸法がペインと同じなら、押してもresizeを送らない", () => {
    paneSize = { width: 800.4, height: 599.6 };
    const { ws, surface } = mountConnected();
    act(() =>
      surface.dispatchEvent(
        mouse("mousedown", { clientX: 110, clientY: 70, buttons: 1 })
      )
    );

    expect(ws.sent().map(m => m.t)).toEqual(["mouse"]);
  });

  it("ダブルクリックの2回目はclickCount: 2で送る", () => {
    const { ws, surface } = mountConnected();
    act(() => {
      surface.dispatchEvent(
        mouse("mousedown", { clientX: 110, clientY: 70, buttons: 1, detail: 2 })
      );
      window.dispatchEvent(
        mouse("mouseup", { clientX: 110, clientY: 70, buttons: 0, detail: 2 })
      );
    });

    expect(ws.sent()).toMatchObject([
      { type: "down", clickCount: 2 },
      { type: "up", clickCount: 2 },
    ]);
  });

  it("手元の倍率が変わったら、寸法が同じでもresizeを送り直す", () => {
    const { ws } = mountConnected();
    const first = mediaQueries.find(q => q.media === "(resolution: 1dppx)");
    expect(first?.listeners.size).toBe(1);

    vi.stubGlobal("devicePixelRatio", 2);
    act(() => {
      for (const listener of [...(first?.listeners ?? [])]) listener();
    });
    expect(ws.sent()[0]).toEqual({
      t: "resize",
      width: 800,
      height: 600,
      dpr: 2,
      mobile: false,
    });
    // 新しい倍率で聞き直す
    expect(first?.listeners.size).toBe(0);
    const second = mediaQueries.find(q => q.media === "(resolution: 2dppx)");
    expect(second?.listeners.size).toBe(1);

    unmountAll();
    expect(second?.listeners.size).toBe(0);
  });

  it("手元の倍率が変わってcanvasの倍率が変わったら、`refresh` を送り、次の全画面で画素数を変える", async () => {
    const { container, ws } = mountConnected();
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    act(() => ws.onmessage?.(frame(1)));
    await flush();

    vi.stubGlobal("devicePixelRatio", 2);
    const query = mediaQueries.find(q => q.media === "(resolution: 1dppx)");
    act(() => {
      for (const listener of [...(query?.listeners ?? [])]) listener();
    });
    // サーバーは倍率だけが変わっても世代を変えないので、こちらから頼む
    expect(ws.sent().map(m => m.t)).toEqual(["resize", "refresh"]);
    // 全画面を描くまでは、前の絵を残す。矩形は描かない
    expect([canvas.width, canvas.height]).toEqual([800, 600]);
    act(() => ws.onmessage?.(frame(3, SMALL)));
    await flush();
    expect(drawImage).toHaveBeenCalledTimes(1);

    act(() => {
      ws.onmessage?.(frame(1, FULL, { pixels: { width: 1600, height: 1200 } }));
      ws.onmessage?.(frame(3, SMALL));
    });
    await flush();
    await flush();
    expect([canvas.width, canvas.height]).toEqual([1600, 1200]);
    expect(drawImage.mock.calls.slice(1).map(call => call.slice(1))).toEqual([
      [0, 0, 1600, 1200],
      [20, 40, 60, 80],
    ]);
    expect(ws.sent().map(m => m.t)).toEqual(["resize", "refresh"]);
  });

  it("手元の倍率が変わっても、canvasの倍率が同じなら `refresh` を送らない", async () => {
    const { ws } = mountConnected();
    act(() => ws.onmessage?.(frame(1)));
    await flush();

    vi.stubGlobal("devicePixelRatio", 1.25);
    const query = mediaQueries.find(q => q.media === "(resolution: 1dppx)");
    act(() => {
      for (const listener of [...(query?.listeners ?? [])]) listener();
    });
    expect(ws.sent().map(m => m.t)).toEqual(["resize"]);
    // 矩形もそのまま描き続ける
    act(() => ws.onmessage?.(frame(3, SMALL)));
    await flush();
    expect(drawImage).toHaveBeenCalledTimes(2);
  });

  it("`viewport` が届く前に手元の倍率が変わっても、`refresh` を送らない", () => {
    const { ws } = mountConnected(null);
    vi.stubGlobal("devicePixelRatio", 2);
    const query = mediaQueries.find(q => q.media === "(resolution: 1dppx)");
    act(() => {
      for (const listener of [...(query?.listeners ?? [])]) listener();
    });

    expect(ws.sent().map(m => m.t)).toEqual(["resize"]);
  });

  it("`StrictMode` で2回つないでも、生きている接続は1つで、フレームを1回だけ描く", async () => {
    const container = mount(
      <StrictMode>
        <BrowserPane browserSession={sessionFixture} />
      </StrictMode>
    );
    expect(FakeWebSocket.instances).toHaveLength(2);
    const [stale, ws] = FakeWebSocket.instances;
    // 1回目の接続は、ハンドラを外して閉じてある
    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(stale.onopen).toBeNull();
    expect(stale.onmessage).toBeNull();
    expect(ws.close).not.toHaveBeenCalled();

    ws.readyState = FakeWebSocket.OPEN;
    act(() => {
      ws.onopen?.();
      ws.onmessage?.(viewportMessage(800, 600));
      ws.onmessage?.(frame(1));
      ws.onmessage?.(frame(3, SMALL));
    });
    await flush();
    await flush();

    expect(container.textContent).not.toContain("接続中");
    expect(stale.send).not.toHaveBeenCalled();
    expect(ws.sent()).toEqual([
      { t: "resize", width: 800, height: 600, dpr: 1, mobile: false },
    ]);
    expect(drawImage.mock.calls.map(call => call.slice(1))).toEqual([
      [0, 0, 800, 600],
      [10, 20, 30, 40],
    ]);

    // 隠れて戻ったときの `refresh` と、倍率が変わったときの `refresh` も、生きている接続へ1回ずつ
    ws.send.mockClear();
    act(() => {
      for (const observer of FakeResizeObserver.instances) {
        paneSize = { width: 0, height: 0 };
        observer.callback();
      }
      ws.onmessage?.(frame(3, SMALL));
      paneSize = { width: 800, height: 600 };
      for (const observer of FakeResizeObserver.instances) observer.callback();
    });
    expect(ws.sent().filter(m => m.t === "refresh")).toHaveLength(1);
    expect(stale.send).not.toHaveBeenCalled();
  });

  it("move は1フレームに最新の1回だけ送り、up の前に送り切る", () => {
    const { ws, surface } = mountConnected();
    act(() => {
      surface.dispatchEvent(mouse("mousemove", { clientX: 20, clientY: 30 }));
      surface.dispatchEvent(mouse("mousemove", { clientX: 30, clientY: 40 }));
    });
    expect(ws.send).not.toHaveBeenCalled();
    act(() => runFrame());
    expect(ws.sent()).toMatchObject([{ type: "move", x: 20, y: 20 }]);
    ws.send.mockClear();

    // 押している間は window で追う。ペインの上で動かしても二重に送らない
    act(() => {
      surface.dispatchEvent(
        mouse("mousedown", { clientX: 30, clientY: 40, buttons: 1 })
      );
      surface.dispatchEvent(
        mouse("mousemove", { clientX: 40, clientY: 50, buttons: 1 })
      );
      window.dispatchEvent(
        mouse("mousemove", { clientX: 2000, clientY: 50, buttons: 1 })
      );
      window.dispatchEvent(
        mouse("mouseup", { clientX: 2000, clientY: 50, buttons: 0 })
      );
    });
    expect(ws.sent().map(m => (m.t === "mouse" ? [m.type, m.x] : m))).toEqual([
      ["down", 20],
      ["move", 1990],
      ["up", 1990],
    ]);
    ws.send.mockClear();

    // 離したあとは window では追わない
    act(() => {
      window.dispatchEvent(mouse("mousemove", { clientX: 5, clientY: 5 }));
      runFrame();
    });
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("wheel は既定のスクロールを止めて送る", () => {
    const { ws, surface } = mountConnected();
    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 110,
      clientY: 70,
      deltaY: 120,
    });
    act(() => surface.dispatchEvent(wheel));

    expect(wheel.defaultPrevented).toBe(true);
    expect(ws.sent()).toMatchObject([
      { t: "mouse", type: "wheel", x: 100, y: 50, deltaY: 120 },
    ]);
  });

  it("サーバーの error のあとに切れたら理由を出し、再接続ボタンで繋ぎ直す", () => {
    const { container, ws } = mountConnected();
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          t: "error",
          message: "Chromiumが起動できません",
        }),
      });
    });
    // 理由を出すのは切れてから
    expect(container.textContent).not.toContain("Chromiumが起動できません");
    const onclose = ws.onclose;
    act(() => onclose?.({ reason: "" }));

    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Chromiumが起動できません"
    );
    const retry = Array.from(container.querySelectorAll("button")).find(
      b => b.textContent?.trim() === "再接続"
    );
    expect(retry).toBeDefined();

    act(() => retry?.click());
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].url).toBe(buildBrowserWsUrl("b1"));
    expect(container.textContent).toContain("接続中");
    // 前の接続は、ハンドラを外してから閉じる
    expect(ws.onclose).toBeNull();
    expect(ws.close).toHaveBeenCalledTimes(1);
  });

  it("理由が届かずに切れたら「切断されました」を出す", () => {
    const { container, ws } = mountConnected();
    act(() => ws.onclose?.({ reason: "" }));

    expect(container.textContent).toContain("切断されました");
  });

  it("サーバーのerrorが無ければ、closeの理由を出す", () => {
    const { container, ws } = mountConnected();
    act(() => ws.onclose?.({ reason: "セッションが見つかりません" }));

    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "セッションが見つかりません"
    );
  });

  it("サーバーのerrorがあれば、closeの理由より先に使う", () => {
    const { container, ws } = mountConnected();
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          t: "error",
          message: "ブラウザへ接続できません",
        }),
      });
      ws.onclose?.({ reason: "internal" });
    });

    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "ブラウザへ接続できません"
    );
  });

  it("つながっていない間のキーは、送らず、既定の動作も止めない", () => {
    const { ws, textarea } = mountConnected();
    act(() => textarea.focus());
    // 偽物のWebSocketは開いたままにして、ハンドラが送らないことを確かめる
    act(() => ws.onclose?.({ reason: "" }));
    // 再接続ボタンへTabで移れるよう、入力欄からフォーカスを外す
    expect(document.activeElement).not.toBe(textarea);

    const tab = key("keydown", { key: "Tab", code: "Tab", keyCode: 9 });
    const enter = key("keydown", { key: "Enter", code: "Enter", keyCode: 13 });
    act(() => {
      textarea.dispatchEvent(tab);
      textarea.dispatchEvent(
        key("keyup", { key: "Tab", code: "Tab", keyCode: 9 })
      );
      textarea.dispatchEvent(enter);
    });

    expect(tab.defaultPrevented).toBe(false);
    expect(enter.defaultPrevented).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("入力欄はポインタの操作を受けず、左上に置く", () => {
    const { textarea } = mountConnected();

    expect(textarea.className.split(" ")).toEqual(
      expect.arrayContaining(["pointer-events-none", "left-0", "top-0"])
    );
    expect(textarea.getAttribute("autocomplete")).toBe("off");
  });

  it("Cmd+VのあとVのupが来なくても、次のVはdownもupも送る", () => {
    const { ws, textarea } = mountConnected();
    const v = { key: "v", code: "KeyV", keyCode: 86 };
    const meta = { key: "Meta", code: "MetaLeft", keyCode: 91 };
    act(() => {
      textarea.dispatchEvent(key("keydown", { ...meta, metaKey: true }));
      // macOSは、Metaを押している間の文字キーのupを出さない
      textarea.dispatchEvent(key("keydown", { ...v, metaKey: true }));
      textarea.dispatchEvent(key("keyup", meta));
      textarea.dispatchEvent(key("keydown", v));
      textarea.dispatchEvent(key("keyup", v));
    });

    expect(
      ws.sent().map(m => (m.t === "key" ? `${m.type}:${m.code}` : m.t))
    ).toEqual(["down:MetaLeft", "up:MetaLeft", "down:KeyV", "up:KeyV"]);
  });

  it("Ctrl+VのCtrlを先に離しても、Vのupは送らない", () => {
    const { ws, textarea } = mountConnected();
    const v = { key: "v", code: "KeyV", keyCode: 86 };
    const control = { key: "Control", code: "ControlLeft", keyCode: 17 };
    act(() => {
      textarea.dispatchEvent(key("keydown", { ...control, ctrlKey: true }));
      textarea.dispatchEvent(key("keydown", { ...v, ctrlKey: true }));
      textarea.dispatchEvent(key("keyup", control));
      textarea.dispatchEvent(key("keyup", v));
    });

    expect(
      ws.sent().map(m => (m.t === "key" ? `${m.type}:${m.code}` : m.t))
    ).toEqual(["down:ControlLeft", "up:ControlLeft"]);
  });

  it("Shift+Insertはキーとして送らず、pasteイベントに任せる", () => {
    const { ws, textarea } = mountConnected();
    const insert = { key: "Insert", code: "Insert", keyCode: 45 };
    const down = key("keydown", { ...insert, shiftKey: true });
    act(() => {
      textarea.dispatchEvent(down);
      textarea.dispatchEvent(key("keyup", { ...insert, shiftKey: true }));
    });

    expect(down.defaultPrevented).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("長い貼り付けは、サーバーの上限に収まる長さへ分けて順に送る", () => {
    const { ws, textarea } = mountConnected();
    const text = `${"あ".repeat(49_999)}😀${"b".repeat(70_000)}`;
    act(() => textarea.dispatchEvent(pasteEvent(text)));

    const chunks = ws.sent().map(m => (m.t === "paste" ? m.text : ""));
    expect(chunks.map(chunk => chunk.length)).toEqual([49_999, 50_000, 20_002]);
    expect(chunks.join("")).toBe(text);
  });

  it("変換を確定したEnterのkeydownとkeyupは送らない", () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { ws, textarea } = mountConnected();
    const enter = { key: "Enter", code: "Enter", keyCode: 13 };
    const confirm = key("keydown", enter);
    act(() => {
      textarea.dispatchEvent(composition("compositionstart", ""));
      textarea.dispatchEvent(composition("compositionend", "亜"));
      now += 30;
      textarea.dispatchEvent(confirm);
      now += 50;
      textarea.dispatchEvent(key("keyup", enter));
    });

    expect(ws.sent()).toEqual([{ t: "ime", type: "commit", text: "亜" }]);
    // 手元の入力欄に改行を入れない (入るとinputが改行を送る)
    expect(confirm.defaultPrevented).toBe(true);
    ws.send.mockClear();

    // 確定から間が空いたEnterは、普通のキーとして送る
    act(() => {
      textarea.dispatchEvent(composition("compositionstart", ""));
      textarea.dispatchEvent(composition("compositionend", "亜"));
      now += 31;
      textarea.dispatchEvent(key("keydown", enter));
      textarea.dispatchEvent(key("keyup", enter));
    });
    expect(
      ws.sent().map(m => (m.t === "key" ? `${m.type}:${m.code}` : m.t))
    ).toEqual(["ime", "down:Enter", "up:Enter"]);
  });

  it("入力欄のフォーカスが外れたら、押したままのキーとボタンを離す", () => {
    const { ws, textarea, surface } = mountConnected();
    act(() => {
      surface.dispatchEvent(
        mouse("mousedown", { clientX: 110, clientY: 70, button: 0, buttons: 1 })
      );
      textarea.dispatchEvent(
        key("keydown", {
          key: "Shift",
          code: "ShiftLeft",
          keyCode: 16,
          shiftKey: true,
        })
      );
      textarea.dispatchEvent(
        key("keydown", { key: "A", code: "KeyA", keyCode: 65, shiftKey: true })
      );
      window.dispatchEvent(
        mouse("mousemove", { clientX: 210, clientY: 170, buttons: 1 })
      );
    });
    ws.send.mockClear();
    act(() => textarea.blur());

    expect(ws.sent()).toEqual([
      {
        t: "key",
        type: "up",
        key: "Shift",
        code: "ShiftLeft",
        keyCode: 16,
        repeat: false,
        modifiers: 0,
      },
      {
        t: "key",
        type: "up",
        key: "A",
        code: "KeyA",
        keyCode: 65,
        repeat: false,
        modifiers: 0,
      },
      // 持っていたmoveを先に送り、その位置で離す
      expect.objectContaining({ t: "mouse", type: "move", x: 200, y: 150 }),
      {
        t: "mouse",
        type: "up",
        x: 200,
        y: 150,
        button: 0,
        buttons: 0,
        clickCount: 1,
        deltaX: 0,
        deltaY: 0,
        modifiers: 0,
      },
    ]);
    ws.send.mockClear();

    // 離したあとに届いたupは、もう送らない
    act(() => {
      textarea.dispatchEvent(
        key("keyup", { key: "a", code: "KeyA", keyCode: 65 })
      );
      window.dispatchEvent(
        mouse("mouseup", { clientX: 210, clientY: 170, buttons: 0 })
      );
      window.dispatchEvent(new Event("blur"));
    });
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("ウィンドウのフォーカスが外れたら、押したままのキーとボタンを離す", () => {
    const { ws, textarea, surface } = mountConnected();
    act(() => {
      surface.dispatchEvent(
        mouse("mousedown", { clientX: 110, clientY: 70, button: 0, buttons: 1 })
      );
      surface.dispatchEvent(
        mouse("mousedown", { clientX: 110, clientY: 70, button: 2, buttons: 3 })
      );
      textarea.dispatchEvent(
        key("keydown", { key: "a", code: "KeyA", keyCode: 65 })
      );
    });
    ws.send.mockClear();
    act(() => window.dispatchEvent(new Event("blur")));

    expect(ws.sent()).toMatchObject([
      { t: "key", type: "up", code: "KeyA", modifiers: 0 },
      // 残りのボタンをbuttonsに入れる (右は2)
      { t: "mouse", type: "up", x: 100, y: 50, button: 0, buttons: 2 },
      { t: "mouse", type: "up", x: 100, y: 50, button: 2, buttons: 0 },
    ]);
  });

  it("切れたら、押したままの入力は離さずに忘れる", () => {
    const { ws, textarea, surface } = mountConnected();
    act(() => {
      surface.dispatchEvent(
        mouse("mousedown", { clientX: 110, clientY: 70, button: 0, buttons: 1 })
      );
      textarea.dispatchEvent(
        key("keydown", { key: "a", code: "KeyA", keyCode: 65 })
      );
    });
    ws.send.mockClear();
    // 偽物のWebSocketは開いたままにして、送ろうとしないことを確かめる
    act(() => ws.onclose?.({ reason: "" }));
    act(() => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(
        mouse("mouseup", { clientX: 110, clientY: 70, buttons: 0 })
      );
    });

    expect(ws.send).not.toHaveBeenCalled();
  });

  it("アンマウントでWebSocketと監視を片付ける", () => {
    const { ws, surface } = mountConnected();
    act(() =>
      surface.dispatchEvent(
        mouse("mousedown", { clientX: 30, clientY: 40, buttons: 1 })
      )
    );
    const removeListener = vi.spyOn(window, "removeEventListener");
    unmountAll();

    expect(ws.onclose).toBeNull();
    expect(ws.onmessage).toBeNull();
    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(FakeResizeObserver.instances[0].disconnect).toHaveBeenCalled();
    // 押したままアンマウントしても、window のリスナーを残さない
    const removed = removeListener.mock.calls.map(([type]) => type);
    expect(removed).toContain("mousemove");
    expect(removed).toContain("mouseup");
  });
});

const PAGE = {
  t: "page",
  url: "http://localhost:5173/",
  title: "アプリ",
  loading: false,
  canGoBack: true,
  canGoForward: false,
};

const TABS = {
  t: "tabs",
  tabs: [
    { id: "A", title: "アプリ", url: "http://localhost:5173/" },
    { id: "B", title: "", url: "about:blank" },
  ],
  activeId: "A",
};

const SELECT = {
  t: "select",
  id: 7,
  options: [
    { label: "赤", disabled: false, group: null },
    { label: "青", disabled: false, group: null },
    { label: "緑", disabled: true, group: null },
  ],
  selectedIndex: 0,
  rect: { x: 100, y: 50, width: 120, height: 24 },
};

function json(msg: unknown) {
  return { data: JSON.stringify(msg) };
}

function dialogMessage(
  kind: "alert" | "confirm" | "prompt" | "beforeunload",
  message = "よろしいですか?",
  defaultPrompt = ""
) {
  return json({ t: "dialog", kind, message, defaultPrompt });
}

function receive(ws: FakeWebSocket, ...messages: unknown[]) {
  act(() => {
    for (const msg of messages) ws.onmessage?.(json(msg));
  });
}

function urlField(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[aria-label="URL"]') as HTMLInputElement;
}

function labelled(container: HTMLElement, label: string): HTMLButtonElement {
  return container.querySelector(
    `button[aria-label="${label}"]`
  ) as HTMLButtonElement;
}

function named(container: HTMLElement, name: string): HTMLButtonElement {
  return [...container.querySelectorAll("button")].find(
    el => el.textContent === name
  ) as HTMLButtonElement;
}

function notice(container: HTMLElement): string | null {
  return container.querySelector("[data-browser-notice]")?.textContent ?? null;
}

function setValue(field: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  act(() => {
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

interface TouchInit {
  identifier: number;
  clientX: number;
  clientY: number;
}

/** jsdomは `Touch` を作れないので、要る値だけを持つイベントを作る */
function touch(
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  touches: TouchInit[],
  changedTouches: TouchInit[] = touches
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: touches },
    changedTouches: { value: changedTouches },
  });
  return event;
}

describe("BrowserPane のツールバー", () => {
  it("ツールバーは、寸法を測る領域の外に置く", () => {
    const { container, surface, textarea } = mountConnected();
    const field = urlField(container);

    expect(field).not.toBeNull();
    expect(surface.contains(field)).toBe(false);
    expect(surface.contains(textarea)).toBe(true);
    expect(container.firstElementChild?.contains(surface)).toBe(true);
  });

  it("`page` をツールバーに映し、ボタンで `nav` を送る", () => {
    const { container, ws } = mountConnected();
    expect(urlField(container).value).toBe("");
    expect(labelled(container, "戻る").disabled).toBe(true);

    receive(ws, PAGE);
    expect(urlField(container).value).toBe("http://localhost:5173/");
    expect(labelled(container, "進む").disabled).toBe(true);
    act(() => labelled(container, "戻る").click());
    act(() => labelled(container, "再読み込み").click());

    expect(ws.sent()).toEqual([
      { t: "nav", type: "back" },
      { t: "nav", type: "reload" },
    ]);
  });

  it("URLの入力欄で打ったキーは、リモートへ送らず、Enterで `goto` だけを送る", () => {
    const { container, ws } = mountConnected();
    receive(ws, PAGE);
    const field = urlField(container);
    act(() => field.focus());
    act(() => {
      field.dispatchEvent(
        key("keydown", { key: "a", code: "KeyA", keyCode: 65 })
      );
      field.dispatchEvent(
        key("keyup", { key: "a", code: "KeyA", keyCode: 65 })
      );
      field.dispatchEvent(pasteEvent("貼り付け"));
    });
    expect(ws.send).not.toHaveBeenCalled();

    setValue(field, "localhost:3000");
    // 入力の途中に `page` が続けて届いても、入力を保つ
    receive(ws, { ...PAGE, loading: true }, { ...PAGE, title: "別の題" });
    expect(field.value).toBe("localhost:3000");
    expect(document.activeElement).toBe(field);
    act(() => {
      field.dispatchEvent(
        key("keydown", { key: "Enter", code: "Enter", keyCode: 13 })
      );
    });

    expect(ws.sent()).toEqual([
      { t: "nav", type: "goto", url: "localhost:3000" },
    ]);
  });

  it("タブの並びは2つ以上のときだけ出し、押すと `tab` を送る", () => {
    const { container, ws } = mountConnected();
    receive(ws, { ...TABS, tabs: [TABS.tabs[0]] });
    expect(container.querySelector('[role="tablist"]')).toBeNull();

    receive(ws, TABS);
    const tabs = container.querySelectorAll<HTMLElement>('[role="tab"]');
    expect(tabs).toHaveLength(2);
    act(() => tabs[1].click());
    act(() => labelled(container, "新しいタブ").click());

    expect(ws.sent()).toEqual([
      { t: "tab", type: "activate", id: "B" },
      { t: "tab", type: "new" },
    ]);
  });

  it("つながっていない間は、ツールバーを無効にする", () => {
    const { container, ws } = mountConnected();
    receive(ws, PAGE);
    act(() => ws.onclose?.({ reason: "" }));

    expect(urlField(container).disabled).toBe(true);
    expect(labelled(container, "再読み込み").disabled).toBe(true);
  });

  it("再接続したら、前の接続のページ、タブ、ダイアログを忘れる", () => {
    const { container, ws } = mountConnected();
    receive(ws, PAGE, TABS);
    act(() => ws.onmessage?.(dialogMessage("alert")));
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();

    act(() => ws.onclose?.({ reason: "" }));
    // 切れている間は、ダイアログを出さない
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    act(() => named(container, "再接続").click());
    const next = FakeWebSocket.instances[1];
    next.readyState = FakeWebSocket.OPEN;
    act(() => next.onopen?.());

    expect(urlField(container).value).toBe("");
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("`notice` を1行で出し、4秒で消す。新しいものは前のものを置き換える", () => {
    vi.useFakeTimers();
    const { container, ws } = mountConnected();
    receive(ws, { t: "notice", message: "このURLは開けません" });
    const line = container.querySelector("[data-browser-notice]");
    expect(line?.getAttribute("role")).toBe("status");
    expect(notice(container)).toBe("このURLは開けません");

    act(() => vi.advanceTimersByTime(3000));
    receive(ws, { t: "notice", message: "タブを閉じられません" });
    expect(notice(container)).toBe("タブを閉じられません");
    // 前の知らせの時刻が来ても、新しい知らせは消さない
    act(() => vi.advanceTimersByTime(3000));
    expect(notice(container)).toBe("タブを閉じられません");
    act(() => vi.advanceTimersByTime(1000));
    expect(notice(container)).toBeNull();
    // 知らせを出しても、領域の寸法は変えない (送り直さない)
    expect(ws.send).not.toHaveBeenCalled();
  });
});

describe("BrowserPane のダイアログ", () => {
  it.each([
    ["alert", "OK", { t: "dialog", accept: true }],
    ["confirm", "OK", { t: "dialog", accept: true }],
    ["confirm", "キャンセル", { t: "dialog", accept: false }],
    ["beforeunload", "このページを離れる", { t: "dialog", accept: true }],
    ["beforeunload", "とどまる", { t: "dialog", accept: false }],
    ["prompt", "キャンセル", { t: "dialog", accept: false }],
  ] as const)("`%s` の %s で応答を送る", (kind, name, expected) => {
    const { container, ws, surface } = mountConnected();
    act(() => ws.onmessage?.(dialogMessage(kind)));
    const dialog = container.querySelector('[role="alertdialog"]');

    // canvasを置く領域の中に出す (アプリの全体は覆わない)
    expect(dialog && surface.contains(dialog)).toBe(true);
    act(() => named(container, name).click());
    expect(ws.sent()).toEqual([expected]);
  });

  it("`prompt` は、入力した文字列を付けて応答する", () => {
    const { container, ws } = mountConnected();
    receive(ws, PAGE);
    act(() => ws.onmessage?.(dialogMessage("prompt", "名前は?", "太郎")));
    const field = container.querySelector(
      '[role="alertdialog"] input'
    ) as HTMLInputElement;
    expect(field.value).toBe("太郎");
    expect(container.textContent).toContain("localhost:5173 の内容");

    setValue(field, "花子");
    // 同じダイアログがもう一度届いても、入力を保つ
    act(() => ws.onmessage?.(dialogMessage("prompt", "名前は?", "太郎")));
    expect(field.value).toBe("花子");
    act(() => {
      field.dispatchEvent(
        key("keydown", { key: "Enter", code: "Enter", keyCode: 13 })
      );
    });

    expect(ws.sent()).toEqual([
      { t: "dialog", accept: true, promptText: "花子" },
    ]);
  });

  it("応答しても閉じず、`dialogClosed` で閉じて、入力欄へフォーカスを戻す", () => {
    const { container, ws, textarea } = mountConnected();
    act(() => ws.onmessage?.(dialogMessage("confirm")));
    act(() => named(container, "OK").click());
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();

    receive(ws, { t: "dialogClosed" });
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(textarea);
  });

  it("表示中は、マウス、wheel、キー、貼り付け、変換、タッチをリモートへ送らない", () => {
    const { container, ws, surface, textarea } = mountConnected();
    act(() => ws.onmessage?.(dialogMessage("confirm")));
    const backdrop = container.querySelector(
      "[data-browser-overlay]"
    ) as HTMLElement;
    const start = touch("touchstart", [
      { identifier: 1, clientX: 110, clientY: 70 },
    ]);
    act(() => {
      backdrop.dispatchEvent(
        mouse("mousedown", { clientX: 110, clientY: 70, buttons: 1 })
      );
      window.dispatchEvent(
        mouse("mouseup", { clientX: 110, clientY: 70, buttons: 0 })
      );
      surface.dispatchEvent(
        mouse("mousemove", { clientX: 120, clientY: 80, buttons: 0 })
      );
      runFrame();
      surface.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX: 110,
          clientY: 70,
          deltaY: 120,
        })
      );
      backdrop.dispatchEvent(start);
      // Tabで透明の入力欄へ移っても、送らない
      textarea.focus();
      textarea.dispatchEvent(
        key("keydown", { key: "a", code: "KeyA", keyCode: 65 })
      );
      textarea.dispatchEvent(
        key("keyup", { key: "a", code: "KeyA", keyCode: 65 })
      );
      textarea.dispatchEvent(pasteEvent("貼り付け"));
      textarea.value = "あ";
      textarea.dispatchEvent(input(false));
      textarea.dispatchEvent(composition("compositionstart", ""));
      textarea.dispatchEvent(composition("compositionupdate", "か"));
      textarea.dispatchEvent(composition("compositionend", "か"));
    });

    expect(ws.send).not.toHaveBeenCalled();
    // ダイアログのボタンを指で押せるよう、既定の動作は止めない
    expect(start.defaultPrevented).toBe(false);
    expect(textarea.value).toBe("");
  });

  it("ダイアログが開いたら、押したままのキーを離す", () => {
    const { ws, textarea } = mountConnected();
    act(() => {
      textarea.focus();
      textarea.dispatchEvent(
        key("keydown", { key: "a", code: "KeyA", keyCode: 65 })
      );
    });
    ws.send.mockClear();
    act(() => ws.onmessage?.(dialogMessage("alert")));

    expect(ws.sent()).toMatchObject([{ t: "key", type: "up", key: "a" }]);
  });
});

describe("BrowserPane の選択リスト", () => {
  function listbox(container: HTMLElement): HTMLElement | null {
    return container.querySelector('[role="listbox"]');
  }

  it("`<select>` の位置を表示上の座標へ直して、その下に出す", () => {
    const { container, ws, surface } = mountConnected();
    receive(ws, SELECT);
    const list = listbox(container) as HTMLElement;

    expect(surface.contains(list)).toBe(true);
    expect(list.style.left).toBe("100px");
    expect(list.style.top).toBe("76px");
    expect(list.style.minWidth).toBe("120px");
    expect(document.activeElement).toBe(list);
  });

  it("canvasを中央に収めているときは、canvasの置き場所と倍率を足す", () => {
    // 800x600の領域に1600x600のビューポート。canvasは (0, 150) の800x300
    const { container, ws } = mountConnected({ width: 1600, height: 600 });
    receive(ws, SELECT);
    const list = listbox(container) as HTMLElement;

    expect(list.style.left).toBe("50px");
    // 150 + 50 * 0.5 + 24 * 0.5 + 間隔の2
    expect(list.style.top).toBe("189px");
    expect(list.style.minWidth).toBe("60px");
  });

  it("下にはみ出すなら、上に出す", () => {
    const { container, ws } = mountConnected();
    receive(ws, {
      ...SELECT,
      rect: { x: 100, y: 560, width: 120, height: 24 },
    });
    const list = listbox(container) as HTMLElement;

    expect(list.style.top).toBe("");
    expect(list.style.bottom).toBe("42px");
  });

  it("選択肢を押すと `selectChoose` を送って閉じ、入力欄へフォーカスを戻す", () => {
    const { container, ws, textarea } = mountConnected();
    receive(ws, SELECT);
    const options = container.querySelectorAll<HTMLElement>('[role="option"]');
    act(() => options[2].click());
    expect(ws.send).not.toHaveBeenCalled();
    act(() => options[1].click());

    expect(ws.sent()).toEqual([{ t: "selectChoose", id: 7, index: 1 }]);
    expect(listbox(container)).toBeNull();
    expect(document.activeElement).toBe(textarea);
  });

  it("開いている間のキーはリストが受け、矢印とEnterで選べる。リモートへは送らない", () => {
    const { container, ws } = mountConnected();
    receive(ws, SELECT);
    const list = listbox(container) as HTMLElement;
    act(() => {
      list.dispatchEvent(
        key("keydown", { key: "ArrowDown", code: "ArrowDown", keyCode: 40 })
      );
    });
    expect(ws.send).not.toHaveBeenCalled();
    act(() => {
      list.dispatchEvent(
        key("keydown", { key: "Enter", code: "Enter", keyCode: 13 })
      );
    });

    expect(ws.sent()).toEqual([{ t: "selectChoose", id: 7, index: 1 }]);
  });

  it("Escapeで `selectCancel` を送って閉じる", () => {
    const { container, ws } = mountConnected();
    receive(ws, SELECT);
    act(() => {
      listbox(container)?.dispatchEvent(
        key("keydown", { key: "Escape", code: "Escape", keyCode: 27 })
      );
    });

    expect(ws.sent()).toEqual([{ t: "selectCancel", id: 7 }]);
    expect(listbox(container)).toBeNull();
  });

  it("外を押すと `selectCancel` を送って閉じ、その押下はリモートへ送らない", () => {
    const { container, ws, surface } = mountConnected();
    receive(ws, SELECT);
    act(() => {
      surface.dispatchEvent(
        mouse("mousedown", { clientX: 500, clientY: 400, buttons: 1 })
      );
      window.dispatchEvent(
        mouse("mouseup", { clientX: 500, clientY: 400, buttons: 0 })
      );
    });

    expect(ws.sent()).toEqual([{ t: "selectCancel", id: 7 }]);
    expect(listbox(container)).toBeNull();
  });

  it("`selectClosed`、遷移、タブの切り替えでは、何も送らずに閉じる", () => {
    const { container, ws } = mountConnected();
    receive(ws, PAGE, TABS);
    ws.send.mockClear();

    receive(ws, SELECT, { t: "selectClosed", id: 6 });
    expect(listbox(container)).not.toBeNull();
    receive(ws, { t: "selectClosed", id: 7 });
    expect(listbox(container)).toBeNull();

    receive(ws, SELECT, { ...PAGE, url: "http://localhost:5173/next" });
    expect(listbox(container)).toBeNull();

    receive(ws, SELECT, { ...TABS, activeId: "B" });
    expect(listbox(container)).toBeNull();
    expect(ws.send).not.toHaveBeenCalled();
  });
});

describe("BrowserPane のコピー", () => {
  it("`clipboard` が届いたら、手元のクリップボードへ書く", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const { container, ws } = mountConnected();
    receive(ws, { t: "clipboard", text: "選んだ文字列" });
    await flush();

    expect(writeText).toHaveBeenCalledWith("選んだ文字列");
    expect(notice(container)).toBeNull();
  });

  it("書けなかったら「コピーできませんでした」を出す", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("NotAllowedError");
    });
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const { container, ws } = mountConnected();
    receive(ws, { t: "clipboard", text: "選んだ文字列" });
    await flush();

    expect(notice(container)).toBe("コピーできませんでした");
  });

  it("クリップボードが使えない (安全でないコンテキスト) ときも、同じ知らせを出す", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    const { container, ws } = mountConnected();
    receive(ws, { t: "clipboard", text: "選んだ文字列" });
    await flush();

    expect(notice(container)).toBe("コピーできませんでした");
  });
});

describe("BrowserPane のタッチ", () => {
  it("`touchstart` は既定の動作を止め、ビューポートの座標と小さい番号で送り、入力欄にフォーカスする", () => {
    const { ws, surface, textarea } = mountConnected();
    const start = touch("touchstart", [
      { identifier: -1234567, clientX: 110, clientY: 70 },
    ]);
    act(() => {
      surface.dispatchEvent(start);
    });

    expect(start.defaultPrevented).toBe(true);
    expect(ws.sent()).toEqual([
      {
        t: "touch",
        type: "start",
        points: [{ id: 0, x: 100, y: 50 }],
        modifiers: 0,
      },
    ]);
    expect(textarea.style.left).toBe("100px");
    expect(textarea.style.top).toBe("50px");
    expect(document.activeElement).toBe(textarea);
  });

  it("座標はマウスと同じく、canvasの矩形とビューポートの寸法で換算し、先に寸法を主張する", () => {
    canvasRect = { left: 30, top: 40, width: 400, height: 300 };
    const { ws, surface } = mountConnected({ width: 1200, height: 900 });
    act(() => {
      surface.dispatchEvent(
        touch("touchstart", [{ identifier: 5, clientX: 130, clientY: 140 }])
      );
    });

    expect(ws.sent()).toMatchObject([
      { t: "resize", width: 800, height: 600 },
      { t: "touch", type: "start", points: [{ id: 0, x: 300, y: 300 }] },
    ]);
  });

  it("`touchmove` は1フレームに最新の1回だけ送り、`touchend` の前に送り切る", () => {
    const { ws, surface } = mountConnected();
    act(() => {
      surface.dispatchEvent(
        touch("touchstart", [{ identifier: 9, clientX: 110, clientY: 70 }])
      );
    });
    ws.send.mockClear();

    const move = touch("touchmove", [
      { identifier: 9, clientX: 120, clientY: 80 },
    ]);
    act(() => {
      surface.dispatchEvent(move);
      surface.dispatchEvent(
        touch("touchmove", [{ identifier: 9, clientX: 130, clientY: 90 }])
      );
    });
    expect(move.defaultPrevented).toBe(true);
    expect(ws.send).not.toHaveBeenCalled();
    act(() => runFrame());
    expect(ws.sent()).toMatchObject([
      { type: "move", points: [{ id: 0, x: 120, y: 70 }] },
    ]);
    ws.send.mockClear();

    const end = touch(
      "touchend",
      [],
      [{ identifier: 9, clientX: 140, clientY: 100 }]
    );
    act(() => {
      surface.dispatchEvent(
        touch("touchmove", [{ identifier: 9, clientX: 140, clientY: 100 }])
      );
      surface.dispatchEvent(end);
      runFrame();
    });

    expect(end.defaultPrevented).toBe(true);
    expect(ws.sent()).toEqual([
      {
        t: "touch",
        type: "move",
        points: [{ id: 0, x: 130, y: 80 }],
        modifiers: 0,
      },
      { t: "touch", type: "end", points: [], modifiers: 0 },
    ]);
  });

  it("指ごとに同じ番号を使い続け、`end` と `cancel` には残っている指を載せる", () => {
    const { ws, surface } = mountConnected();
    const a = { identifier: 1001, clientX: 110, clientY: 70 };
    const b = { identifier: 1002, clientX: 210, clientY: 170 };
    const c = { identifier: 1003, clientX: 310, clientY: 270 };
    act(() => {
      surface.dispatchEvent(touch("touchstart", [a]));
      surface.dispatchEvent(touch("touchstart", [a, b], [b]));
      surface.dispatchEvent(touch("touchend", [b], [a]));
      // 空いた番号は、次の指が使う
      surface.dispatchEvent(touch("touchstart", [b, c], [c]));
      surface.dispatchEvent(touch("touchcancel", [c], [b]));
    });

    expect(
      ws.sent().map(m => (m.t === "touch" ? [m.type, m.points] : m))
    ).toEqual([
      ["start", [{ id: 0, x: 100, y: 50 }]],
      [
        "start",
        [
          { id: 0, x: 100, y: 50 },
          { id: 1, x: 200, y: 150 },
        ],
      ],
      ["end", [{ id: 1, x: 200, y: 150 }]],
      [
        "start",
        [
          { id: 1, x: 200, y: 150 },
          { id: 0, x: 300, y: 250 },
        ],
      ],
      ["cancel", [{ id: 0, x: 300, y: 250 }]],
    ]);
  });

  it("11本目からの指は送らない", () => {
    const { ws, surface } = mountConnected();
    const fingers = Array.from({ length: 11 }, (_, i) => ({
      identifier: 500 + i,
      clientX: 20 + i * 10,
      clientY: 30,
    }));
    act(() => {
      surface.dispatchEvent(touch("touchstart", fingers));
    });
    const [start] = ws.sent();

    expect(start.t === "touch" && start.points.map(p => p.id)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  it("1回の押下で、タッチとマウスの両方を送らない", () => {
    const { ws, surface } = mountConnected();
    const finger = { identifier: 3, clientX: 110, clientY: 70 };
    const down = mouse("mousedown", { clientX: 110, clientY: 70, buttons: 1 });
    act(() => {
      surface.dispatchEvent(touch("touchstart", [finger]));
      surface.dispatchEvent(touch("touchend", [], [finger]));
      // 既定の動作を止めても、ブラウザがマウスのイベントを合成してきたとき
      surface.dispatchEvent(
        mouse("mousemove", { clientX: 110, clientY: 70, buttons: 0 })
      );
      runFrame();
      surface.dispatchEvent(down);
      window.dispatchEvent(
        mouse("mouseup", { clientX: 110, clientY: 70, buttons: 0 })
      );
    });

    expect(ws.sent().map(m => m.t)).toEqual(["touch", "touch"]);
    // フォーカスは入力欄に残す
    expect(down.defaultPrevented).toBe(true);
  });

  it("ビューポートの寸法が届くまでと、つながっていない間は、送らない", () => {
    const { ws, surface } = mountConnected(null);
    const finger = { identifier: 3, clientX: 110, clientY: 70 };
    act(() => {
      surface.dispatchEvent(touch("touchstart", [finger]));
      surface.dispatchEvent(touch("touchend", [], [finger]));
    });
    expect(ws.send).not.toHaveBeenCalled();

    act(() => {
      ws.onmessage?.(viewportMessage(800, 600));
      ws.onclose?.({ reason: "" });
    });
    const start = touch("touchstart", [finger]);
    act(() => {
      surface.dispatchEvent(start);
    });
    // 再接続ボタンを指で押せるよう、既定の動作は止めない
    expect(start.defaultPrevented).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("入力欄のフォーカスが外れたら、触れたままの指を取り消す", () => {
    const { ws, surface, textarea } = mountConnected();
    const finger = { identifier: 3, clientX: 110, clientY: 70 };
    act(() => {
      surface.dispatchEvent(touch("touchstart", [finger]));
    });
    ws.send.mockClear();
    act(() => {
      textarea.blur();
      // 取り消したあとに届いた分は、もう送らない
      surface.dispatchEvent(touch("touchend", [], [finger]));
    });

    expect(ws.sent()).toEqual([
      { t: "touch", type: "cancel", points: [], modifiers: 0 },
    ]);
  });
});

describe("BrowserPane の縦横比", () => {
  it("ビューポートが領域の寸法と同じなら、canvasは領域の全体を使う", () => {
    const { container } = mountConnected();
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;

    expect(canvas.style.width).toBe("");
    expect(canvas.style.height).toBe("");
    expect(canvas.className.split(" ")).toEqual(
      expect.arrayContaining(["h-full", "w-full"])
    );
  });

  it("寸法が違えば、引き伸ばさず、縦横比を保って中央に収める", () => {
    const { container, ws } = mountConnected({ width: 1600, height: 600 });
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;

    expect(canvas.style.position).toBe("absolute");
    expect(canvas.style.left).toBe("0px");
    expect(canvas.style.top).toBe("150px");
    expect(canvas.style.width).toBe("800px");
    expect(canvas.style.height).toBe("300px");

    // 寸法が揃ったら、全体を使う形に戻す
    act(() => ws.onmessage?.(viewportMessage(800, 600, 2)));
    expect(canvas.style.position).toBe("");
    expect(canvas.style.width).toBe("");
    expect(canvas.style.top).toBe("");
  });

  it("領域の寸法が変わったら、収め直す", () => {
    const { container } = mountConnected({ width: 400, height: 800 });
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    expect(canvas.style.left).toBe("250px");
    expect(canvas.style.width).toBe("300px");

    act(() => {
      paneSize = { width: 400, height: 400 };
      FakeResizeObserver.instances[0].callback();
    });
    expect(canvas.style.left).toBe("100px");
    expect(canvas.style.width).toBe("200px");
    expect(canvas.style.height).toBe("400px");
  });

  it("余白に届いた操作は送らない", () => {
    // 領域は (10, 20) の800x600。canvasは上下に150の余白を置いた (10, 170) の800x300
    canvasRect = { left: 10, top: 170, width: 800, height: 300 };
    const { ws, surface, textarea } = mountConnected({
      width: 1600,
      height: 600,
    });
    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 110,
      clientY: 70,
      deltaY: 120,
    });
    act(() => {
      surface.dispatchEvent(
        mouse("mousemove", { clientX: 110, clientY: 70, buttons: 0 })
      );
      runFrame();
      surface.dispatchEvent(
        mouse("mousedown", { clientX: 110, clientY: 70, buttons: 1 })
      );
      window.dispatchEvent(
        mouse("mouseup", { clientX: 110, clientY: 70, buttons: 0 })
      );
      surface.dispatchEvent(wheel);
    });

    expect(ws.send).not.toHaveBeenCalled();
    // ペインがスクロールしたり、文字が選ばれたりはしない
    expect(wheel.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(textarea);

    // canvasの上なら送る。入力欄は領域の左上から測る
    act(() => {
      surface.dispatchEvent(
        mouse("mousedown", { clientX: 110, clientY: 320, buttons: 1 })
      );
    });
    expect(ws.sent()).toMatchObject([
      { t: "resize", width: 800, height: 600 },
      { t: "mouse", type: "down", x: 200, y: 300 },
    ]);
    expect(textarea.style.left).toBe("100px");
    expect(textarea.style.top).toBe("300px");
    ws.send.mockClear();

    // 余白で始まったタッチも送らない。既定の動作は止める
    const start = touch("touchstart", [
      { identifier: 1, clientX: 110, clientY: 500 },
    ]);
    act(() => {
      surface.dispatchEvent(start);
      surface.dispatchEvent(
        touch("touchend", [], [{ identifier: 1, clientX: 110, clientY: 500 }])
      );
    });
    expect(start.defaultPrevented).toBe(true);
    expect(ws.send).not.toHaveBeenCalled();
  });
});
