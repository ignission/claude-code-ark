import { describe, expect, it, vi } from "vitest";
import { createFileApi } from "./file-api";

type Handler = (...args: unknown[]) => void;

/** emit の ack を握れる偽 socket。ackMode が "silent" なら timeout エラーを返す */
function createFakeSocket(ackMode: "silent" | "reply" = "reply") {
  const listeners = new Map<string, Set<Handler>>();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const socket = {
    emit: vi.fn((event: string, payload: unknown) => {
      emitted.push({ event, payload });
    }),
    timeout: vi.fn(() => ({
      emit: (event: string, payload: unknown, cb: Handler) => {
        emitted.push({ event, payload });
        if (ackMode === "silent") cb(new Error("timeout"));
        else cb(null, { ok: true, entries: [], truncated: false });
      },
    })),
    on: vi.fn((event: string, fn: Handler) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(fn);
    }),
    off: vi.fn((event: string, fn: Handler) => {
      listeners.get(event)?.delete(fn);
    }),
  };
  const fire = (event: string, ...args: unknown[]) => {
    for (const fn of [...(listeners.get(event) ?? [])]) fn(...args);
  };
  const count = (event: string) => listeners.get(event)?.size ?? 0;
  return { socket, emitted, fire, count };
}

// biome-ignore lint/suspicious/noExplicitAny: 偽 socket を渡すため
const asSocket = (s: unknown) => s as any;

describe("createFileApi", () => {
  it("ack が返らないとき list は ok: false に畳む", async () => {
    const f = createFakeSocket("silent");
    const api = createFileApi(asSocket(f.socket), "s1");
    const r = await api.list("");
    expect(r.ok).toBe(false);
    expect(f.socket.timeout).toHaveBeenCalledWith(5000);
  });

  it("write の timeout は code: error に畳む", async () => {
    const f = createFakeSocket("silent");
    const api = createFileApi(asSocket(f.socket), "s1");
    const r = await api.write("a.ts", "x", 1);
    expect(r).toMatchObject({ ok: false, code: "error" });
  });

  it("ack が返れば応答をそのまま返す", async () => {
    const f = createFakeSocket();
    const api = createFileApi(asSocket(f.socket), "s1");
    expect(await api.list("src")).toEqual({
      ok: true,
      entries: [],
      truncated: false,
    });
    expect(f.emitted[0]).toEqual({
      event: "file:list",
      payload: { sessionId: "s1", dirPath: "src" },
    });
  });

  it("subscribe は sessionId と filePath で file:updated を絞る", () => {
    const f = createFakeSocket();
    const api = createFileApi(asSocket(f.socket), "s1");
    const cb = vi.fn();
    api.subscribe("a.ts", cb);
    f.fire("file:updated", { sessionId: "s2", filePath: "a.ts" });
    f.fire("file:updated", { sessionId: "s1", filePath: "b.ts" });
    expect(cb).not.toHaveBeenCalled();
    f.fire("file:updated", { sessionId: "s1", filePath: "a.ts" });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("connect のたびに file:subscribe を張り直す", () => {
    const f = createFakeSocket();
    const api = createFileApi(asSocket(f.socket), "s1");
    api.subscribe("a.ts", vi.fn());
    f.fire("connect");
    const subs = f.emitted.filter(e => e.event === "file:subscribe");
    expect(subs).toHaveLength(2);
  });

  it("解除すると listener を外し file:unsubscribe を送る", () => {
    const f = createFakeSocket();
    const api = createFileApi(asSocket(f.socket), "s1");
    const dispose = api.subscribe("a.ts", vi.fn());
    expect(f.count("file:updated")).toBe(1);
    expect(f.count("connect")).toBe(1);
    dispose();
    expect(f.count("file:updated")).toBe(0);
    expect(f.count("connect")).toBe(0);
    expect(f.socket.emit).toHaveBeenLastCalledWith("file:unsubscribe", {
      sessionId: "s1",
      filePath: "a.ts",
    });
  });
});
