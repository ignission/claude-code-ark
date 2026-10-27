/**
 * 分岐TODO の socket ハンドラ (すべて ack)。足すのは Claude (todo_add) だけで、
 * ここは人間の操作 (一覧・完了・削除) を受ける。
 * socket のペイロードは信頼できないので、形を確かめてから DB に渡す。
 * ハンドラ内の throw はプロセスを落とすため、全体を try/catch で包む。
 */

import type { TodoListResponse, TodoOpResponse } from "@ark/shared";
import type { SessionDatabase } from "./database.js";

export interface TodoHandlersDeps {
  db: Pick<
    SessionDatabase,
    "listTodos" | "setTodoDone" | "setTodoStarted" | "deleteTodo"
  >;
  /** 完了・削除のあとに呼ぶ (全クライアントへ todo:changed を配る) */
  onChanged: () => void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

const NOT_FOUND = "TODO が見つかりません";

export function createTodoHandlers(deps: TodoHandlersDeps) {
  function op(
    parse: (data: Record<string, unknown>) => (() => boolean) | null
  ) {
    return (data: unknown, cb: unknown): void => {
      if (typeof cb !== "function") return;
      const reply = cb as (r: TodoOpResponse) => void;
      if (!isRecord(data)) return;
      const run = parse(data);
      if (!run) return;
      try {
        if (!run()) {
          reply({ ok: false, error: NOT_FOUND });
          return;
        }
        deps.onChanged();
        reply({ ok: true });
      } catch (err) {
        reply({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
  }

  return {
    list(_data: unknown, cb: unknown): void {
      if (typeof cb !== "function") return;
      const reply = cb as (r: TodoListResponse) => void;
      try {
        reply({ ok: true, todos: deps.db.listTodos() });
      } catch (err) {
        reply({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    setDone: op(data =>
      typeof data.id === "string" && typeof data.done === "boolean"
        ? () => deps.db.setTodoDone(data.id as string, data.done as boolean)
        : null
    ),
    setStarted: op(data =>
      typeof data.id === "string" && typeof data.worktreePath === "string"
        ? () =>
            deps.db.setTodoStarted(
              data.id as string,
              data.worktreePath as string
            ) !== null
        : null
    ),
    delete: op(data =>
      typeof data.id === "string"
        ? () => deps.db.deleteTodo(data.id as string)
        : null
    ),
  };
}

/**
 * worktree:create に todoId が添えられていたとき、作った worktree をそのTODOの
 * 始めた先として記録し、変更を知らせる。TODO が無い・更新に失敗しても投げない
 * (worktree の作成とセッションの起動は止めない)。
 */
export function recordStartedForCreatedWorktree(
  deps: {
    db: Pick<SessionDatabase, "setTodoStarted">;
    onChanged: () => void;
  },
  todoId: unknown,
  worktreePath: string
): void {
  if (typeof todoId !== "string") return;
  try {
    if (deps.db.setTodoStarted(todoId, worktreePath) !== null) {
      deps.onChanged();
    }
  } catch (err) {
    console.error(
      `[Todo] 始めた先の記録に失敗しました (todo=${todoId}, worktree=${worktreePath}): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
