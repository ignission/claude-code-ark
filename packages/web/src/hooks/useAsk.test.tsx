// @vitest-environment jsdom

import type { AskResult, AskState } from "@ark/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type UseAsk, useAsk } from "./useAsk";

type Handler = (...args: unknown[]) => void;

/** socket の代わり。emit を記録し、テストから応答と push を流す */
function fakeSocket(connected = true) {
  const handlers = new Map<string, Set<Handler>>();
  const emitted: Array<{ event: string; args: unknown[] }> = [];
  return {
    connected,
    emitted,
    on(event: string, handler: Handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)?.add(handler);
    },
    off(event: string, handler: Handler) {
      handlers.get(event)?.delete(handler);
    },
    emit(event: string, ...args: unknown[]) {
      emitted.push({ event, args });
    },
    push(event: string, ...args: unknown[]) {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
    reply(event: string, value: unknown) {
      const call = emitted.findLast(e => e.event === event);
      if (!call) throw new Error(`${event} は送られていない`);
      (call.args.at(-1) as (value: unknown) => void)(value);
    },
  };
}

let container: HTMLDivElement;
let root: Root;
let current: UseAsk;

function Probe({ socket }: { socket: ReturnType<typeof fakeSocket> | null }) {
  current = useAsk(socket as never);
  return null;
}
function mount(socket: ReturnType<typeof fakeSocket> | null) {
  act(() => root.render(<Probe socket={socket} />));
}

const STATE: AskState = {
  messages: [{ id: "u1", role: "user", text: "やあ" }],
  busy: true,
  error: null,
};

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("useAsk", () => {
  it("つないだら会話を取り、push で入れ替え、再接続で取り直す", () => {
    const socket = fakeSocket();
    mount(socket);
    expect(socket.emitted.map(e => e.event)).toEqual(["ask:get"]);
    act(() => socket.reply("ask:get", STATE));
    expect(current.state).toEqual(STATE);
    act(() => socket.push("ask:state", { ...STATE, busy: false }));
    expect(current.state.busy).toBe(false);
    act(() => socket.push("connect"));
    expect(socket.emitted.filter(e => e.event === "ask:get")).toHaveLength(2);
  });

  it("聞く文を送る", () => {
    const socket = fakeSocket();
    mount(socket);
    act(() => current.send("1+1は?"));
    expect(socket.emitted.at(-1)).toMatchObject({
      event: "ask:send",
      args: [{ text: "1+1は?" }, expect.any(Function)],
    });
    act(() => socket.reply("ask:send", { ok: true } satisfies AskResult));
    expect(current.sendError).toBeNull();
  });

  it("サーバーに断られた理由を出し、次に送るときに消す", () => {
    const socket = fakeSocket();
    mount(socket);
    act(() => current.send("長い文"));
    act(() =>
      socket.reply("ask:send", {
        ok: false,
        error: "聞く文が長すぎます (8000文字まで)",
      } satisfies AskResult)
    );
    expect(current.sendError).toBe("聞く文が長すぎます (8000文字まで)");
    act(() => current.send("短い文"));
    expect(current.sendError).toBeNull();
  });

  it("つながっていなければ送らず、その旨を出す", () => {
    const socket = fakeSocket(false);
    mount(socket);
    act(() => current.reset());
    expect(socket.emitted).toEqual([]);
    expect(current.sendError).toBe("サーバーに未接続です");
  });
});
