// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({
  instances: [] as Array<{
    target: HTMLElement;
    channel: unknown;
    options: unknown;
    listeners: Map<string, (event: { detail: unknown }) => void>;
    disconnect: ReturnType<typeof vi.fn>;
    scaleViewport: boolean;
  }>,
}));

vi.mock("@novnc/novnc", () => ({
  default: class FakeRFB {
    scaleViewport = false;
    background = "";
    disconnect = vi.fn();
    listeners = new Map<string, (event: { detail: unknown }) => void>();
    constructor(target: HTMLElement, channel: unknown, options: unknown) {
      doubles.instances.push({
        target,
        channel,
        options,
        listeners: this.listeners,
        disconnect: this.disconnect,
        scaleViewport: false,
      });
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
  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send() {}
  close() {}
}

import { ScreenPane } from "./ScreenPane";

const screen = {
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

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function mount(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mountedRoots.push({ root, container });
  return container;
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
    const requestCredentials = vi
      .fn()
      .mockResolvedValue({ username: "user", password: "pw" });
    const container = mount(
      <ScreenPane screen={screen} requestCredentials={requestCredentials} />
    );
    await flush();

    expect(requestCredentials).toHaveBeenCalledWith("s1");
    expect(doubles.instances).toHaveLength(1);
    const rfb = doubles.instances[0];
    expect(rfb.channel).toBe(FakeWebSocket.instances[0]);
    expect(FakeWebSocket.instances[0].url).toContain("/screen/s1/ws");
    expect(rfb.options).toEqual({
      credentials: { username: "user", password: "pw" },
    });
    expect(container.textContent).toContain("接続中");

    act(() => rfb.listeners.get("connect")?.({ detail: {} }));
    expect(container.textContent).not.toContain("接続中");
  });

  it("切断されたら WebSocket の close reason を出し、再接続ボタンで繋ぎ直す", async () => {
    const requestCredentials = vi
      .fn()
      .mockResolvedValue({ username: "user", password: "pw" });
    const container = mount(
      <ScreenPane screen={screen} requestCredentials={requestCredentials} />
    );
    await flush();

    const ws = FakeWebSocket.instances[0];
    act(() => {
      ws.dispatchEvent(
        new CloseEvent("close", { code: 1011, reason: "Permission denied" })
      );
      doubles.instances[0].listeners.get("disconnect")?.({
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
  });

  it("認証失敗は securityfailure の理由を出す", async () => {
    const requestCredentials = vi
      .fn()
      .mockResolvedValue({ username: "user", password: "pw" });
    const container = mount(
      <ScreenPane screen={screen} requestCredentials={requestCredentials} />
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

  it("credentials が無ければ設定を促す", async () => {
    const requestCredentials = vi.fn().mockResolvedValue(null);
    const container = mount(
      <ScreenPane screen={screen} requestCredentials={requestCredentials} />
    );
    await flush();
    expect(doubles.instances).toHaveLength(0);
    expect(container.textContent).toContain("画面の設定が見つかりません");
  });

  it("安全なコンテキストでなければ接続せずに案内する", async () => {
    Object.defineProperty(window, "isSecureContext", {
      value: false,
      configurable: true,
    });
    const requestCredentials = vi.fn();
    const container = mount(
      <ScreenPane screen={screen} requestCredentials={requestCredentials} />
    );
    await flush();
    expect(requestCredentials).not.toHaveBeenCalled();
    expect(container.textContent).toContain("HTTPS");
  });

  it("アンマウントで RFB を切断する", async () => {
    const requestCredentials = vi
      .fn()
      .mockResolvedValue({ username: "user", password: "pw" });
    mount(
      <ScreenPane screen={screen} requestCredentials={requestCredentials} />
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
