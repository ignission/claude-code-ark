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
  onclose: (() => void) | null = null;
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

/** ペインの寸法。jsdomはレイアウトを持たないので、テストごとに決める */
let paneSize = { width: 800, height: 600 };
const drawImage = vi.fn();
let frameRequests: Array<() => void> = [];
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

/** 描画して、WebSocketが開いたところまで進める */
function mountConnected() {
  const container = mount(<BrowserPane browserSession={sessionFixture} />);
  const ws = FakeWebSocket.instances[0];
  ws.readyState = FakeWebSocket.OPEN;
  act(() => ws.onopen?.());
  ws.send.mockClear();
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  const surface = container.firstElementChild as HTMLDivElement;
  return { container, ws, textarea, surface };
}

function runFrame() {
  const pending = frameRequests;
  frameRequests = [];
  for (const run of pending) run();
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
  frameRequests = [];
  drawImage.mockClear();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("devicePixelRatio", 1);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false }))
  );
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => {
    frameRequests.push(run);
    return frameRequests.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frameRequests = [];
  });
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 800, height: 600, close: vi.fn() }))
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        left: 10,
        top: 20,
        width: paneSize.width,
        height: paneSize.height,
      }) as DOMRect
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

  it("デコードが後から終わった古いフレームは描かない", async () => {
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    const resolvers: Array<(bitmap: unknown) => void> = [];
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(
        () =>
          new Promise(resolve => {
            resolvers.push(resolve);
          })
      )
    );
    const { ws } = mountConnected();
    act(() => {
      ws.onmessage?.({ data: new ArrayBuffer(8) });
      ws.onmessage?.({ data: new ArrayBuffer(8) });
    });
    const bitmap = () => {
      const close = vi.fn();
      closes.push(close);
      return { width: 800, height: 600, close };
    };

    resolvers[1](bitmap());
    await flush();
    resolvers[0](bitmap());
    await flush();

    expect(drawImage).toHaveBeenCalledTimes(1);
    // 描かなかったフレームも解放する
    expect(closes.every(close => close.mock.calls.length === 1)).toBe(true);
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

    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        getData: (type: string) => (type === "text/plain" ? "貼る" : ""),
      },
    });
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

  it("フレームの寸法が表示と違う間は、座標をフレームの寸法へ合わせる", async () => {
    // 表示は800x600、フレームは400x300 (寸法が反映される前)
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 400, height: 300, close: vi.fn() }))
    );
    const { ws, surface } = mountConnected();
    act(() => ws.onmessage?.({ data: new ArrayBuffer(8) }));
    await flush();

    act(() =>
      surface.dispatchEvent(
        mouse("mousedown", { clientX: 110, clientY: 70, buttons: 1 })
      )
    );
    expect(ws.sent()).toMatchObject([{ type: "down", x: 50, y: 25 }]);
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
    act(() => onclose?.());

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
    act(() => ws.onclose?.());

    expect(container.textContent).toContain("切断されました");
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
