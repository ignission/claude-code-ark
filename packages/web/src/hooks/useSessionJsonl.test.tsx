// @vitest-environment jsdom

import type { ClientToServerEvents, ServerToClientEvents } from "@ark/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Socket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type UseSessionJsonlResult, useSessionJsonl } from "./useSessionJsonl";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type Handler = (...args: unknown[]) => void;

/** on / off / emit だけを持つ socket の偽物。サーバーからの受信は fire で起こす */
class FakeSocket {
  private handlers = new Map<string, Set<Handler>>();
  emitted: Array<{ event: string; payload: unknown }> = [];

  on(event: string, handler: Handler) {
    const set = this.handlers.get(event) ?? new Set<Handler>();
    set.add(handler);
    this.handlers.set(event, set);
    return this;
  }

  off(event: string, handler: Handler) {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  emit(event: string, payload?: unknown) {
    this.emitted.push({ event, payload });
    return this;
  }

  fire(event: string, ...args: unknown[]) {
    act(() => {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    });
  }

  count(event: string): number {
    return this.emitted.filter(e => e.event === event).length;
  }
}

function assistantLine(uuid: string, text: string): string {
  return JSON.stringify({
    uuid,
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

let container: HTMLDivElement;
let root: Root;
let socket: FakeSocket;
let result: UseSessionJsonlResult;

function Probe() {
  result = useSessionJsonl(socket as unknown as TypedSocket, "s1");
  return null;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  socket = new FakeSocket();
  act(() => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useSessionJsonl の再接続", () => {
  it("再接続したら購読し直し、そのsnapshotで切断中に増えた行に追いつく", () => {
    expect(socket.count("session:jsonl-subscribe")).toBe(1);
    socket.fire("session:jsonl-snapshot", {
      sessionId: "s1",
      lines: [assistantLine("a1", "前の返答")],
    });
    expect(result.events).toHaveLength(1);

    // サーバーは切断時に購読を破棄するので、つなぎ直したら購読を送り直す
    socket.fire("connect");
    expect(socket.count("session:jsonl-subscribe")).toBe(2);
    expect(socket.emitted.at(-1)).toEqual({
      event: "session:jsonl-subscribe",
      payload: "s1",
    });

    socket.fire("session:jsonl-snapshot", {
      sessionId: "s1",
      lines: [
        assistantLine("a1", "前の返答"),
        assistantLine("a2", "切断中の返答"),
      ],
    });
    expect(result.events.map(e => e.id)).toEqual(["a1:a:0", "a2:a:0"]);
  });

  it("再接続したら読み込み行数を初期値に戻す (snapshotは既定の行数で届くため)", () => {
    act(() => result.loadMore());
    expect(result.loadedLimit).toBe(200);
    socket.fire("connect");
    expect(result.loadedLimit).toBe(100);
  });

  it("アンマウントした後は購読し直さない", () => {
    act(() => root.unmount());
    socket.fire("connect");
    expect(socket.count("session:jsonl-subscribe")).toBe(1);
    // afterEach の unmount が二重にならないよう、空の root を作り直す
    root = createRoot(container);
  });
});
