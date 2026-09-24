// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeRFBInstance {
  target: HTMLElement;
  channel: unknown;
  options: unknown;
  listeners: Map<string, (event: { detail: unknown }) => void>;
  disconnect: ReturnType<typeof vi.fn>;
  scaleViewport: boolean;
  background: string;
}

const doubles = vi.hoisted(() => ({
  instances: [] as FakeRFBInstance[],
  // 次の RFB 生成だけを失敗させるフラグ（1回使うと自動で戻る）
  throwNextConstruct: false,
}));

vi.mock("@novnc/novnc", () => ({
  default: class FakeRFB {
    target: HTMLElement;
    channel: unknown;
    options: unknown;
    background = "";
    scaleViewport = false;
    disconnect = vi.fn();
    listeners = new Map<string, (event: { detail: unknown }) => void>();
    constructor(target: HTMLElement, channel: unknown, options: unknown) {
      if (doubles.throwNextConstruct) {
        doubles.throwNextConstruct = false;
        throw new Error("RFB init failed");
      }
      this.target = target;
      this.channel = channel;
      this.options = options;
      // 実物と同じく target の中に canvas を作り、サーバーのカーソルが
      // 届くまでは cursor を none にしておく
      const canvas = document.createElement("canvas");
      canvas.style.cursor = "none";
      target.append(canvas);
      // インスタンス自体を保持する（スナップショットのコピーだと、後から
      // 本体コードが設定する scaleViewport = true 等を観測できない）
      doubles.instances.push(this);
    }
    addEventListener(
      type: string,
      listener: (event: { detail: unknown }) => void
    ) {
      this.listeners.set(type, listener);
    }
    removeEventListener() {}
  },
}));

class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];
  binaryType = "blob";
  readyState = 0;
  url: string;
  close = vi.fn();
  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send() {}
}

import type { ScreenCredentialsResult } from "@ark/shared";

// jsdom はタッチ端末に見えるので、カーソルの保険を非タッチとして動かす
vi.mock("@/lib/screen-cursor", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/screen-cursor")>();
  return {
    ...actual,
    keepLocalCursorUntilServerCursor: (target: HTMLElement) =>
      actual.keepLocalCursorUntilServerCursor(target, { usesFallback: false }),
  };
});

import { ScreenPane } from "./ScreenPane";

const screenFixture = {
  id: "s1",
  name: "ビルド VM",
  sshHost: "build.example.internal",
  sshPort: 22,
  sshUser: "user",
  vncHost: "127.0.0.1",
  vncPort: 5900,
  vncUser: "user",
  createdAt: 0,
  updatedAt: 0,
};

function okCredentials(): ScreenCredentialsResult {
  return { kind: "ok", credentials: { username: "user", password: "pw" } };
}

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function mount(element: ReactElement): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mountedRoots.push({ root, container });
  return { container, root };
}

function rerender(root: Root, element: ReactElement) {
  act(() => root.render(element));
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  doubles.instances.length = 0;
  doubles.throwNextConstruct = false;
  FakeWebSocket.instances.length = 0;
  vi.stubGlobal("WebSocket", FakeWebSocket);
  Object.defineProperty(window, "isSecureContext", {
    value: true,
    configurable: true,
  });
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

describe("ScreenPane", () => {
  it("credentials を取ってから RFB を作り、接続中の表示を出す", async () => {
    const requestCredentials = vi.fn().mockResolvedValue(okCredentials());
    const { container } = mount(
      <ScreenPane
        screen={screenFixture}
        requestCredentials={requestCredentials}
      />
    );
    await flush();

    expect(requestCredentials).toHaveBeenCalledWith("s1");
    expect(doubles.instances).toHaveLength(1);
    const rfb = doubles.instances[0];
    expect(rfb.channel).toBe(FakeWebSocket.instances[0]);
    expect(FakeWebSocket.instances[0].url).toContain("/screen/s1/ws");
    expect(FakeWebSocket.instances[0].binaryType).toBe("arraybuffer");
    expect(rfb.options).toEqual({
      credentials: { username: "user", password: "pw" },
    });
    expect(rfb.scaleViewport).toBe(true);
    expect(container.textContent).toContain("接続中");

    act(() => rfb.listeners.get("connect")?.({ detail: {} }));
    expect(container.textContent).not.toContain("接続中");
  });

  it("切断されたら WebSocket の close reason を出し、再接続ボタンで繋ぎ直す", async () => {
    const requestCredentials = vi.fn().mockResolvedValue(okCredentials());
    const { container } = mount(
      <ScreenPane
        screen={screenFixture}
        requestCredentials={requestCredentials}
      />
    );
    await flush();

    const ws = FakeWebSocket.instances[0];
    const firstRfb = doubles.instances[0];
    act(() => {
      ws.dispatchEvent(
        new CloseEvent("close", { code: 1011, reason: "Permission denied" })
      );
      firstRfb.listeners.get("disconnect")?.({
        detail: { clean: false },
      });
    });
    expect(container.textContent).toContain("Permission denied");

    const retry = Array.from(container.querySelectorAll("button")).find(
      b => b.textContent === "再接続"
    );
    act(() => retry?.click());
    await flush();
    expect(doubles.instances).toHaveLength(2);
    expect(requestCredentials).toHaveBeenCalledTimes(2);
    // 既に disconnect イベントが出た RFB を cleanup 側で重ねて切断しない
    expect(firstRfb.disconnect).not.toHaveBeenCalled();
  });

  it("接続中に screen が変わったら前の RFB を切断してから繋ぎ直す", async () => {
    const requestCredentials = vi.fn().mockResolvedValue(okCredentials());
    const { root } = mount(
      <ScreenPane
        screen={screenFixture}
        requestCredentials={requestCredentials}
      />
    );
    await flush();
    const firstRfb = doubles.instances[0];
    act(() => firstRfb.listeners.get("connect")?.({ detail: {} }));

    const otherScreen = { ...screenFixture, id: "s2" };
    rerender(
      root,
      <ScreenPane
        screen={otherScreen}
        requestCredentials={requestCredentials}
      />
    );
    await flush();

    // まだ disconnect イベントを出していない（＝生きていた）RFB は明示的に切断する
    expect(firstRfb.disconnect).toHaveBeenCalledTimes(1);
    expect(doubles.instances).toHaveLength(2);
    expect(requestCredentials).toHaveBeenCalledWith("s2");
  });

  it("認証失敗は securityfailure の理由を出す", async () => {
    const requestCredentials = vi.fn().mockResolvedValue(okCredentials());
    const { container } = mount(
      <ScreenPane
        screen={screenFixture}
        requestCredentials={requestCredentials}
      />
    );
    await flush();

    act(() => {
      doubles.instances[0].listeners.get("securityfailure")?.({
        detail: { status: 1, reason: "Authentication failed" },
      });
      doubles.instances[0].listeners.get("disconnect")?.({
        detail: { clean: false },
      });
    });
    expect(container.textContent).toContain("認証に失敗しました");
    expect(container.textContent).toContain("Authentication failed");
  });

  it("登録が消えていれば設定を促す", async () => {
    const requestCredentials = vi
      .fn()
      .mockResolvedValue({ kind: "unregistered" });
    const { container } = mount(
      <ScreenPane
        screen={screenFixture}
        requestCredentials={requestCredentials}
      />
    );
    await flush();
    expect(doubles.instances).toHaveLength(0);
    expect(container.textContent).toContain("画面の設定が見つかりません");
  });

  it("サーバーに届かなければ登録の案内ではなく再接続を促す", async () => {
    const requestCredentials = vi
      .fn()
      .mockResolvedValue({ kind: "unavailable" });
    const { container } = mount(
      <ScreenPane
        screen={screenFixture}
        requestCredentials={requestCredentials}
      />
    );
    await flush();
    expect(doubles.instances).toHaveLength(0);
    expect(container.textContent).toContain("サーバーに繋がりません");
    expect(container.textContent).not.toContain("画面の設定が見つかりません");
    const retry = Array.from(container.querySelectorAll("button")).find(
      b => b.textContent === "再接続"
    );
    expect(retry).toBeTruthy();
  });

  it("credentials 取得が失敗したら理由を出し、再接続ボタンで繋ぎ直せる", async () => {
    const requestCredentials = vi
      .fn()
      .mockRejectedValue(new Error("ネットワークエラー"));
    const { container } = mount(
      <ScreenPane
        screen={screenFixture}
        requestCredentials={requestCredentials}
      />
    );
    await flush();

    expect(doubles.instances).toHaveLength(0);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(container.textContent).toContain("ネットワークエラー");
    const retry = Array.from(container.querySelectorAll("button")).find(
      b => b.textContent === "再接続"
    );
    expect(retry).toBeTruthy();
  });

  it("RFB の初期化に失敗したら WebSocket を閉じて理由を出す", async () => {
    doubles.throwNextConstruct = true;
    const requestCredentials = vi.fn().mockResolvedValue(okCredentials());
    const { container } = mount(
      <ScreenPane
        screen={screenFixture}
        requestCredentials={requestCredentials}
      />
    );
    await flush();

    expect(doubles.instances).toHaveLength(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].close).toHaveBeenCalled();
    expect(container.textContent).toContain("RFB init failed");
  });

  it("requestCredentials の identity が変わっても繋ぎ直さない", async () => {
    const requestCredentials1 = vi.fn().mockResolvedValue(okCredentials());
    const { root } = mount(
      <ScreenPane
        screen={screenFixture}
        requestCredentials={requestCredentials1}
      />
    );
    await flush();
    expect(doubles.instances).toHaveLength(1);

    const requestCredentials2 = vi.fn().mockResolvedValue(okCredentials());
    rerender(
      root,
      <ScreenPane
        screen={screenFixture}
        requestCredentials={requestCredentials2}
      />
    );
    await flush();

    expect(doubles.instances).toHaveLength(1);
    expect(requestCredentials2).not.toHaveBeenCalled();
  });

  it("接続先 (同じ id) が編集されたら前の RFB を切断して繋ぎ直す", async () => {
    const requestCredentials = vi.fn().mockResolvedValue(okCredentials());
    const { root } = mount(
      <ScreenPane
        screen={screenFixture}
        requestCredentials={requestCredentials}
      />
    );
    await flush();
    const firstRfb = doubles.instances[0];
    act(() => firstRfb.listeners.get("connect")?.({ detail: {} }));

    // screen:list の再配信で別インスタンスになっただけ (内容は同じ) なら繋ぎ直さない
    rerender(
      root,
      <ScreenPane
        screen={{ ...screenFixture }}
        requestCredentials={requestCredentials}
      />
    );
    await flush();
    expect(doubles.instances).toHaveLength(1);

    rerender(
      root,
      <ScreenPane
        screen={{ ...screenFixture, vncPort: 5901 }}
        requestCredentials={requestCredentials}
      />
    );
    await flush();
    expect(firstRfb.disconnect).toHaveBeenCalledTimes(1);
    expect(doubles.instances).toHaveLength(2);
  });

  it("切断ボタンで RFB を切り、「切断しました」と再接続ボタンを出す", async () => {
    const requestCredentials = vi.fn().mockResolvedValue(okCredentials());
    const { container } = mount(
      <ScreenPane
        screen={screenFixture}
        requestCredentials={requestCredentials}
      />
    );
    await flush();
    const rfb = doubles.instances[0];
    act(() => rfb.listeners.get("connect")?.({ detail: {} }));

    // 実物の disconnect() は非同期に disconnect イベントを出す。それを模す
    rfb.disconnect.mockImplementation(() => {
      rfb.listeners.get("disconnect")?.({ detail: { clean: true } });
    });
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="切断"]'
    );
    expect(button).not.toBeNull();
    act(() => button?.click());
    await flush();

    expect(rfb.disconnect).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("切断しました");
    expect(container.querySelector('button[aria-label="切断"]')).toBeNull();
    const retry = Array.from(container.querySelectorAll("button")).find(
      b => b.textContent?.trim() === "再接続"
    );
    expect(retry).toBeDefined();
    act(() => retry?.click());
    await flush();
    expect(doubles.instances).toHaveLength(2);
  });

  it("接続中も再接続ボタンで繋ぎ直せる", async () => {
    const requestCredentials = vi.fn().mockResolvedValue(okCredentials());
    const { container } = mount(
      <ScreenPane
        screen={screenFixture}
        requestCredentials={requestCredentials}
      />
    );
    await flush();
    const firstRfb = doubles.instances[0];
    act(() => firstRfb.listeners.get("connect")?.({ detail: {} }));

    const retry = container.querySelector<HTMLButtonElement>(
      'button[aria-label="再接続"]'
    );
    expect(retry).not.toBeNull();
    act(() => retry?.click());
    await flush();
    expect(firstRfb.disconnect).toHaveBeenCalledTimes(1);
    expect(doubles.instances).toHaveLength(2);
    expect(requestCredentials).toHaveBeenCalledTimes(2);
  });

  it("credentials 待ちの間にアンマウントすると何も作らない", async () => {
    let resolveCredentials: ((value: ScreenCredentialsResult) => void) | null =
      null;
    const requestCredentials = vi.fn().mockImplementation(
      () =>
        new Promise<ScreenCredentialsResult>(resolve => {
          resolveCredentials = resolve;
        })
    );
    mount(
      <ScreenPane
        screen={screenFixture}
        requestCredentials={requestCredentials}
      />
    );
    await flush();
    expect(requestCredentials).toHaveBeenCalled();

    for (const { root, container } of mountedRoots.splice(0)) {
      act(() => root.unmount());
      container.remove();
    }

    resolveCredentials?.(okCredentials());
    await flush();

    expect(doubles.instances).toHaveLength(0);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("安全なコンテキストでなければ接続せずに案内する", async () => {
    Object.defineProperty(window, "isSecureContext", {
      value: false,
      configurable: true,
    });
    const requestCredentials = vi.fn();
    const { container } = mount(
      <ScreenPane
        screen={screenFixture}
        requestCredentials={requestCredentials}
      />
    );
    await flush();
    expect(requestCredentials).not.toHaveBeenCalled();
    expect(container.textContent).toContain("HTTPS");
  });

  it("サーバーがカーソルを送らない間はブラウザの矢印を出す", async () => {
    const requestCredentials = vi.fn().mockResolvedValue(okCredentials());
    const { container } = mount(
      <ScreenPane
        screen={screenFixture}
        requestCredentials={requestCredentials}
      />
    );
    await flush();
    const canvas = container.querySelector("canvas");
    expect(canvas?.style.cursor).toBe("default");
  });

  it("アンマウントで RFB を切断する", async () => {
    const requestCredentials = vi.fn().mockResolvedValue(okCredentials());
    mount(
      <ScreenPane
        screen={screenFixture}
        requestCredentials={requestCredentials}
      />
    );
    await flush();
    const rfb = doubles.instances[0];
    for (const { root, container } of mountedRoots.splice(0)) {
      act(() => root.unmount());
      container.remove();
    }
    expect(rfb.disconnect).toHaveBeenCalled();
  });
});
