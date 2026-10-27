// @vitest-environment jsdom

import type { Todo } from "@ark/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useTodos } from "./useTodos";

type Handler = (...args: unknown[]) => void;
type Reply = (event: string, payload: unknown) => unknown;

/** socket の代わり。ack 付き emit に reply の戻り値を返し、push を流せる */
function fakeSocket(reply: Reply) {
  const handlers = new Map<string, Set<Handler>>();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  return {
    emitted,
    on(event: string, handler: Handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)?.add(handler);
    },
    off(event: string, handler: Handler) {
      handlers.get(event)?.delete(handler);
    },
    timeout: () => ({
      emit(event: string, payload: unknown, cb: Handler) {
        emitted.push({ event, payload });
        cb(null, reply(event, payload));
      },
    }),
    push(event: string) {
      for (const handler of handlers.get(event) ?? []) handler();
    },
  };
}

const todo = (id: string, worktreePath: string, done = false): Todo => ({
  id,
  worktreePath,
  text: `todo ${id}`,
  note: null,
  createdAt: 1,
  doneAt: done ? 2 : null,
  startedWorktreePath: null,
  startedAt: null,
});

let latest: ReturnType<typeof useTodos>;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function Harness({ socket }: { socket: ReturnType<typeof fakeSocket> }) {
  // biome-ignore lint/suspicious/noExplicitAny: 偽socketを渡すため
  latest = useTodos(socket as any);
  return null;
}

async function render(socket: ReturnType<typeof fakeSocket>) {
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => root?.render(<Harness socket={socket} />));
}

const flush = () => act(async () => {});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container = null;
});

describe("useTodos", () => {
  it("接続時に一覧を読み、worktree ごとの未完了件数を出す", async () => {
    const socket = fakeSocket(() => ({
      ok: true,
      todos: [todo("1", "/w/a"), todo("2", "/w/a"), todo("3", "/w/b", true)],
    }));
    await render(socket);
    expect(socket.emitted[0]).toEqual({ event: "todo:list", payload: {} });
    expect(latest.todos).toHaveLength(3);
    expect(latest.openCountByWorktree.get("/w/a")).toBe(2);
    expect(latest.openCountByWorktree.get("/w/b")).toBeUndefined();
  });

  it("todo:changed で読み直す", async () => {
    let calls = 0;
    const socket = fakeSocket(() => ({
      ok: true,
      todos: calls++ === 0 ? [] : [todo("1", "/w/a")],
    }));
    await render(socket);
    expect(latest.todos).toHaveLength(0);
    socket.push("todo:changed");
    await flush();
    expect(latest.todos).toHaveLength(1);
  });

  it("再接続 (connect) で読み直す", async () => {
    let calls = 0;
    const socket = fakeSocket(() => ({
      ok: true,
      todos: calls++ === 0 ? [] : [todo("1", "/w/a")],
    }));
    await render(socket);
    expect(latest.todos).toHaveLength(0);
    socket.push("connect");
    await flush();
    expect(latest.todos).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("読み直しが重なったとき、先に出した要求の返答が遅れて届いても新しい一覧が残る", async () => {
    const pending: Handler[] = [];
    const handlers = new Map<string, Set<Handler>>();
    const socket = {
      on(event: string, handler: Handler) {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)?.add(handler);
      },
      off(event: string, handler: Handler) {
        handlers.get(event)?.delete(handler);
      },
      timeout: () => ({
        emit(_event: string, _payload: unknown, cb: Handler) {
          pending.push(cb);
        },
      }),
    };
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () =>
      // biome-ignore lint/suspicious/noExplicitAny: 偽socketを渡すため
      root?.render(<Harness socket={socket as any} />)
    );
    // 初回の読み込み (pending[0]) が返らないうちに todo:changed で2回目を出す
    act(() => {
      for (const h of handlers.get("todo:changed") ?? []) h();
    });
    expect(pending).toHaveLength(2);

    // 新しい要求の返答が先に届き、古い要求の返答が最後に届く
    await act(async () =>
      pending[1](null, { ok: true, todos: [todo("new", "/w/a")] })
    );
    await act(async () => pending[0](null, { ok: true, todos: [] }));
    expect(latest.todos.map(t => t.id)).toEqual(["new"]);
  });

  it("setDone の失敗を error に入れ、楽観更新はしない", async () => {
    const socket = fakeSocket(event =>
      event === "todo:list"
        ? { ok: true, todos: [todo("1", "/w/a")] }
        : { ok: false, error: "TODO が見つかりません" }
    );
    await render(socket);
    act(() => latest.setDone("1", true));
    await flush();
    expect(socket.emitted.at(-1)).toEqual({
      event: "todo:set-done",
      payload: { id: "1", done: true },
    });
    expect(latest.error).toBe("TODO が見つかりません");
    expect(latest.todos[0].doneAt).toBeNull();
  });

  it("remove の失敗を error に入れる", async () => {
    const socket = fakeSocket(event =>
      event === "todo:list"
        ? { ok: true, todos: [] }
        : { ok: false, error: "削除できません" }
    );
    await render(socket);
    act(() => latest.remove("1"));
    await flush();
    expect(socket.emitted.at(-1)).toEqual({
      event: "todo:delete",
      payload: { id: "1" },
    });
    expect(latest.error).toBe("削除できません");
  });

  it("setStarted は todo:set-started を送り、失敗を error に入れる", async () => {
    const socket = fakeSocket(event =>
      event === "todo:list"
        ? { ok: true, todos: [todo("1", "/w/a")] }
        : { ok: false, error: "TODO が見つかりません" }
    );
    await render(socket);
    act(() => latest.setStarted("1", "/w/a"));
    await flush();
    expect(socket.emitted.at(-1)).toEqual({
      event: "todo:set-started",
      payload: { id: "1", worktreePath: "/w/a" },
    });
    expect(latest.error).toBe("TODO が見つかりません");
  });

  it("ack が来ないときは応答なしのエラーに畳む", async () => {
    const socket = fakeSocket(() => ({ ok: true, todos: [] }));
    socket.timeout = () => ({
      emit(_e: string, _p: unknown, cb: Handler) {
        cb(new Error("timeout"));
      },
    });
    await render(socket);
    expect(latest.error).toBe("サーバーから応答がありません");
  });
});
