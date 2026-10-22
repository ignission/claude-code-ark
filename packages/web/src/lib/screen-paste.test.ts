// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  forwardLocalPaste,
  type PasteTarget,
  trackClipboardDelivery,
} from "./screen-paste";

function setup(
  readText: () => Promise<string>,
  connected = true,
  overrides: Partial<PasteTarget> = {}
) {
  const container = document.createElement("div");
  const canvas = document.createElement("canvas");
  container.append(canvas);
  document.body.append(container);
  const calls: string[] = [];
  const target: PasteTarget = {
    clipboardPasteFrom: vi.fn((text: string) => {
      calls.push(`clipboard:${text}`);
    }),
    sendKey: vi.fn((keysym: number, _code: string | null, down?: boolean) =>
      calls.push(
        `key:${keysym}${down === undefined ? "" : down ? ":down" : ":up"}`
      )
    ),
    ...overrides,
  };
  // noVNC と同じく canvas で keydown を聞く
  const canvasKeydown = vi.fn();
  canvas.addEventListener("keydown", canvasKeydown);
  const stop = forwardLocalPaste(
    container,
    () => (connected ? target : null),
    readText
  );
  const press = (init: KeyboardEventInit, type = "keydown") => {
    const event = new KeyboardEvent(type, {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    canvas.dispatchEvent(event);
    return event;
  };
  return { calls, canvasKeydown, press, stop, container };
}

/** Promise の連鎖 (読み取り → 送信の待ち → V) が流れ切るまで待つ */
async function flush() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("forwardLocalPaste", () => {
  it("Cmd+V で手元のクリップボードを送ってから V を押す", async () => {
    const { calls, canvasKeydown, press } = setup(() =>
      Promise.resolve("hello")
    );
    const event = press({ key: "v", metaKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(canvasKeydown).not.toHaveBeenCalled();
    await flush();
    expect(calls).toEqual(["clipboard:hello", "key:118"]);
  });

  it("Ctrl+V も同じに扱う", async () => {
    const { calls, press } = setup(() => Promise.resolve("x"));
    press({ key: "v", ctrlKey: true });
    await flush();
    expect(calls).toEqual(["clipboard:x", "key:118"]);
  });

  it("クリップボードを読めないときは V だけを押す", async () => {
    const { calls, press } = setup(() => Promise.reject(new Error("denied")));
    press({ key: "v", metaKey: true });
    await flush();
    expect(calls).toEqual(["key:118"]);
  });

  it("修飾キー無しの v と、ほかのショートカットは noVNC に流す", () => {
    const { canvasKeydown, press } = setup(() => Promise.resolve("x"));
    press({ key: "v" });
    press({ key: "c", metaKey: true });
    expect(canvasKeydown).toHaveBeenCalledTimes(2);
  });

  it("未接続のあいだは奪わない", () => {
    const { canvasKeydown, press } = setup(() => Promise.resolve("x"), false);
    const event = press({ key: "v", metaKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(canvasKeydown).toHaveBeenCalledTimes(1);
  });

  it("止めたあとは奪わない", () => {
    const { canvasKeydown, press, stop } = setup(() => Promise.resolve("x"));
    stop();
    press({ key: "v", metaKey: true });
    expect(canvasKeydown).toHaveBeenCalledTimes(1);
  });

  it("非ラテン配列で key が v でなくても、物理キーの V なら奪う", async () => {
    const { calls, press } = setup(() => Promise.resolve("x"));
    press({ key: "м", code: "KeyV", ctrlKey: true });
    await flush();
    expect(calls).toEqual(["clipboard:x", "key:118"]);
  });

  it("readText が同期で投げても V は押す", async () => {
    const { calls, press } = setup(() => {
      throw new Error("no clipboard");
    });
    press({ key: "v", metaKey: true });
    await flush();
    expect(calls).toEqual(["key:118"]);
  });

  it("読み取りを待つあいだに修飾キーを離したら、V の前後で押し直して離す", async () => {
    let resolve: (text: string) => void = () => {};
    const { calls, press } = setup(
      () => new Promise<string>(r => (resolve = r))
    );
    press({ key: "v", metaKey: true });
    press({ key: "Meta", metaKey: false }, "keyup");
    // readText は次のマイクロタスクで呼ばれるので、resolve が差し替わるまで待つ
    await flush();
    resolve("x");
    await flush();
    expect(calls).toEqual([
      "clipboard:x",
      "key:65515:down",
      "key:118",
      "key:65515:up",
    ]);
  });

  it("読み取りを待つあいだにフォーカスが外れても、修飾キーを押し直す", async () => {
    let resolve: (text: string) => void = () => {};
    const { calls, press } = setup(
      () => new Promise<string>(r => (resolve = r))
    );
    press({ key: "v", ctrlKey: true });
    window.dispatchEvent(new Event("blur"));
    // readText は次のマイクロタスクで呼ばれるので、resolve が差し替わるまで待つ
    await flush();
    resolve("x");
    await flush();
    expect(calls).toEqual([
      "clipboard:x",
      "key:65507:down",
      "key:118",
      "key:65507:up",
    ]);
  });

  it("本文が送られるまで V を待つ", async () => {
    let deliver: () => void = () => {};
    const { calls, press } = setup(() => Promise.resolve("x"), true, {
      clipboardPasteFrom: text => {
        calls.push(`clipboard:${text}`);
        return new Promise<void>(r => (deliver = r));
      },
    });
    press({ key: "v", metaKey: true });
    await flush();
    expect(calls).toEqual(["clipboard:x"]);
    deliver();
    await flush();
    expect(calls).toEqual(["clipboard:x", "key:118"]);
  });
});

describe("trackClipboardDelivery", () => {
  /** ClientCutText のヘッダー。length が負なら拡張で、flags が 9 バイト目 */
  function cutText(length: number, flags?: number): Uint8Array {
    const data = new Uint8Array(flags === undefined ? 8 : 12);
    data[0] = 6;
    new DataView(data.buffer).setInt32(4, length);
    if (flags !== undefined) data[8] = flags;
    return data;
  }

  function fakeSocket() {
    const sent: unknown[] = [];
    const ws = { send: (data: unknown) => void sent.push(data) };
    return { ws: ws as unknown as Pick<WebSocket, "send">, sent };
  }

  it("拡張でない ClientCutText が出たら解決し、送信はそのまま通す", async () => {
    const { ws, sent } = fakeSocket();
    const tracker = trackClipboardDelivery(ws);
    const message = cutText(0);
    let done = false;
    const wait = tracker
      .waitForDelivery(() => ws.send(message))
      .then(() => {
        done = true;
      });
    await wait;
    expect(done).toBe(true);
    expect(sent).toEqual([message]);
  });

  it("Notify では待ち続け、Provide で解決する", async () => {
    vi.useFakeTimers();
    try {
      const { ws } = fakeSocket();
      const tracker = trackClipboardDelivery(ws);
      let done = false;
      const wait = tracker
        .waitForDelivery(() => ws.send(cutText(-4, 0x08)))
        .then(() => {
          done = true;
        });
      await vi.advanceTimersByTimeAsync(100);
      expect(done).toBe(false);
      ws.send(cutText(-20, 0x10));
      await wait;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("本文が来なくても上限で解決する", async () => {
    vi.useFakeTimers();
    try {
      const { ws } = fakeSocket();
      const tracker = trackClipboardDelivery(ws);
      let done = false;
      const wait = tracker
        .waitForDelivery(() => {})
        .then(() => {
          done = true;
        });
      await vi.advanceTimersByTimeAsync(1000);
      await wait;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
