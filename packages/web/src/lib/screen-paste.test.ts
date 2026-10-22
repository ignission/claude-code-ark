// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardLocalPaste, type PasteTarget } from "./screen-paste";

function setup(readText: () => Promise<string>, connected = true) {
  const container = document.createElement("div");
  const canvas = document.createElement("canvas");
  container.append(canvas);
  document.body.append(container);
  const calls: string[] = [];
  const target: PasteTarget = {
    clipboardPasteFrom: vi.fn(text => calls.push(`clipboard:${text}`)),
    sendKey: vi.fn(keysym => calls.push(`key:${keysym}`)),
  };
  // noVNC と同じく canvas で keydown を聞く
  const canvasKeydown = vi.fn();
  canvas.addEventListener("keydown", canvasKeydown);
  const stop = forwardLocalPaste(
    container,
    () => (connected ? target : null),
    readText
  );
  const press = (init: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    canvas.dispatchEvent(event);
    return event;
  };
  return { calls, canvasKeydown, press, stop, container };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
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
});
