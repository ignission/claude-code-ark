// @vitest-environment jsdom

import type { BrowserClientMessage } from "@ark/shared";
import { act, type ReactElement } from "react";
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

/** ペインの寸法。jsdomはレイアウトを持たないので、テストごとに決める */
let paneSize = { width: 800, height: 600 };
/** canvasの矩形。`null` ならペインと同じ */
let canvasRect: Rect | null = null;
const drawImage = vi.fn();
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

function viewportMessage(width: number, height: number) {
  return { data: JSON.stringify({ t: "viewport", width, height }) };
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
  const surface = container.firstElementChild as HTMLDivElement;
  return { container, ws, textarea, surface };
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
          size: blob.size,
          close,
          resolve: () => resolve({ width: 800, height: 600, close }),
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
  drawImage.mockClear();
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
    vi.fn(async () => ({ width: 800, height: 600, close: vi.fn() }))
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
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => ({ drawImage }) as unknown as CanvasRenderingContext2D
  );
});

afterEach(() => {
  unmountAll();
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

  it("届いたフレームをcanvasに描く", async () => {
    const { container, ws } = mountConnected();
    act(() => ws.onmessage?.({ data: new ArrayBuffer(8) }));
    await flush();

    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
  });

  it("デコードは1枚ずつ行い、待っている間に届いたフレームは最新の1枚だけを残す", async () => {
    const { decode, decodes } = holdDecodes();
    const { ws } = mountConnected();
    act(() => {
      ws.onmessage?.({ data: new ArrayBuffer(8) });
      ws.onmessage?.({ data: new ArrayBuffer(16) });
      ws.onmessage?.({ data: new ArrayBuffer(24) });
    });
    expect(decode).toHaveBeenCalledTimes(1);

    decodes[0].resolve();
    await flush();
    expect(drawImage).toHaveBeenCalledTimes(1);
    // 間の1枚は飛ばす
    expect(decodes.map(d => d.size)).toEqual([8, 24]);

    decodes[1].resolve();
    await flush();
    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(decode).toHaveBeenCalledTimes(2);
    expect(decodes.every(d => d.close.mock.calls.length === 1)).toBe(true);
  });

  it("隠れている間はデコードせず、見えたときに最新の1枚だけをデコードする", async () => {
    const { decode, decodes } = holdDecodes();
    const { ws } = mountConnected();
    paneSize = { width: 0, height: 0 };
    act(() => {
      ws.onmessage?.({ data: new ArrayBuffer(8) });
      ws.onmessage?.({ data: new ArrayBuffer(16) });
    });
    expect(decode).not.toHaveBeenCalled();

    paneSize = { width: 800, height: 600 };
    act(() => FakeResizeObserver.instances[0].callback());
    expect(decodes.map(d => d.size)).toEqual([16]);
    decodes[0].resolve();
    await flush();
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it("デコードに失敗したフレームは捨てて続け、警告は接続ごとに1回だけ出す", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { decodes } = holdDecodes();
    const { ws } = mountConnected();
    for (const decoded of [false, false, true]) {
      act(() => ws.onmessage?.({ data: new ArrayBuffer(8) }));
      const last = decodes[decodes.length - 1];
      if (decoded) last.resolve();
      else last.reject();
      await flush();
    }

    expect(decodes).toHaveLength(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(drawImage).toHaveBeenCalledTimes(1);
  });

  it("`createImageBitmap` が同期で投げても、次のフレームを描ける", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const decode = vi.fn<() => Promise<unknown>>(() => {
      throw new Error("unsupported");
    });
    vi.stubGlobal("createImageBitmap", decode);
    const { ws } = mountConnected();
    act(() => ws.onmessage?.({ data: new ArrayBuffer(8) }));
    await flush();

    decode.mockImplementation(async () => ({
      width: 800,
      height: 600,
      close: vi.fn(),
    }));
    act(() => ws.onmessage?.({ data: new ArrayBuffer(8) }));
    await flush();
    expect(drawImage).toHaveBeenCalledTimes(1);
  });

  it("再接続のあとにデコードが終わった前の接続のフレームは、描かずに解放する", async () => {
    const { decodes } = holdDecodes();
    const { container, ws } = mountConnected();
    act(() => {
      ws.onmessage?.({ data: new ArrayBuffer(8) });
      // デコードを待つ間に届いた分は、つなぎ直したら捨てる
      ws.onmessage?.({ data: new ArrayBuffer(16) });
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
  });

  it("アンマウントのあとにデコードが終わったフレームは、描かずに解放する", async () => {
    const { decodes } = holdDecodes();
    const { ws } = mountConnected();
    act(() => ws.onmessage?.({ data: new ArrayBuffer(8) }));
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

  it("コピーのショートカットは普通のキーとして送る", () => {
    const { ws, textarea } = mountConnected();
    const down = key("keydown", {
      key: "c",
      code: "KeyC",
      keyCode: 67,
      ctrlKey: true,
    });
    act(() => textarea.dispatchEvent(down));

    expect(down.defaultPrevented).toBe(true);
    expect(ws.sent()).toMatchObject([
      { t: "key", type: "down", key: "c", modifiers: 2 },
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
    expect(ws.sent()).toEqual([
      { t: "resize", width: 800, height: 600, dpr: 2, mobile: false },
    ]);
    // 新しい倍率で聞き直す
    expect(first?.listeners.size).toBe(0);
    const second = mediaQueries.find(q => q.media === "(resolution: 2dppx)");
    expect(second?.listeners.size).toBe(1);

    unmountAll();
    expect(second?.listeners.size).toBe(0);
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
