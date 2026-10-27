/**
 * 分岐TODOの一覧を持つ。Dashboard で 1 回だけ使い、TODO タブ・サイドバーの件数・
 * モバイルへ配る。正本はサーバーで、todo:changed と再接続のたびに読み直す
 * (リロード・再接続で状態を失わないよう、クライアントは一覧を保存しない)
 */

import type {
  ClientToServerEvents,
  ServerToClientEvents,
  Todo,
} from "@ark/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Socket } from "socket.io-client";
import { createTodoApi } from "@/lib/todo-api";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function useTodos(socket: TypedSocket | null) {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const api = useMemo(() => (socket ? createTodoApi(socket) : null), [socket]);

  useEffect(() => {
    if (!socket || !api) return;
    let cancelled = false;
    // 読み直しは重なりうる。最後に出した要求の返答だけを反映する
    let latestSeq = 0;
    const reload = () => {
      const seq = ++latestSeq;
      api.list().then(res => {
        if (cancelled || seq !== latestSeq) return;
        if (res.ok) {
          setTodos(res.todos);
          setError(null);
        } else {
          setError(res.error);
        }
      });
    };
    reload();
    socket.on("todo:changed", reload);
    socket.on("connect", reload);
    return () => {
      cancelled = true;
      socket.off("todo:changed", reload);
      socket.off("connect", reload);
    };
  }, [socket, api]);

  const setDone = useCallback(
    (id: string, done: boolean) => {
      api?.setDone(id, done).then(res => {
        if (!res.ok) setError(res.error);
      });
    },
    [api]
  );
  const remove = useCallback(
    (id: string) => {
      api?.remove(id).then(res => {
        if (!res.ok) setError(res.error);
      });
    },
    [api]
  );

  const setStarted = useCallback(
    (id: string, worktreePath: string) => {
      api?.setStarted(id, worktreePath).then(res => {
        if (!res.ok) setError(res.error);
      });
    },
    [api]
  );

  const openCountByWorktree = useMemo(() => {
    const counts = new Map<string, number>();
    for (const todo of todos) {
      if (todo.doneAt !== null) continue;
      counts.set(todo.worktreePath, (counts.get(todo.worktreePath) ?? 0) + 1);
    }
    return counts;
  }, [todos]);

  return { todos, error, setDone, remove, setStarted, openCountByWorktree };
}
