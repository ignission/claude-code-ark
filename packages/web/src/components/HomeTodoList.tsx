/**
 * HomeTodoList - ホームに置いた、まだ始めていない TODO を一覧の先頭に並べる「未着手」
 *
 * 決まりは `lib/home-session.ts` にある。ここは描くだけで、状態は持たない。
 * 1 件も無ければ何も出さない。
 */

import type { Todo } from "@ark/shared";
import { CirclePlay } from "lucide-react";
import { m } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { getBaseName } from "@/utils/pathUtils";

interface HomeTodoListProps {
  /** "sidebar" = PCの一覧、"card" = モバイルの一覧 */
  variant: "sidebar" | "card";
  todos: readonly Todo[];
  /** その TODO を始める */
  onStart: (todo: Todo) => void;
}

export function HomeTodoList({ variant, todos, onStart }: HomeTodoListProps) {
  if (todos.length === 0) return null;
  const card = variant === "card";
  return (
    <section data-home-todos="" className={card ? "mb-3" : "mb-2"}>
      <h2
        className={cn(
          "flex h-7 items-center gap-2 font-semibold text-muted-foreground",
          card ? "px-1 text-[13px]" : "px-2.5 text-[11px] tracking-[0.06em]"
        )}
      >
        <span>{m.session.home.notStarted}</span>
        <span className="font-mono text-[11px] tabular-nums">
          {todos.length}
        </span>
      </h2>
      <ul className={cn("flex flex-col", card ? "gap-2" : "gap-px")}>
        {todos.map(todo => (
          <li key={todo.id}>
            <button
              type="button"
              onClick={() => onStart(todo)}
              title={m.session.home.startTodo}
              className={cn(
                "flex w-full items-start gap-2 rounded-md text-left transition-colors hover:bg-sidebar-accent",
                card
                  ? "min-h-12 border border-border bg-card px-3 py-2.5"
                  : "px-2.5 py-1.5"
              )}
            >
              <CirclePlay
                className={cn(
                  "mt-0.5 shrink-0 text-muted-foreground",
                  card ? "size-5" : "size-4"
                )}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "line-clamp-2 text-foreground",
                    card ? "text-[15px]" : "text-[13px]"
                  )}
                >
                  {todo.text}
                </span>
                {todo.repoPath && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {getBaseName(todo.repoPath)}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
