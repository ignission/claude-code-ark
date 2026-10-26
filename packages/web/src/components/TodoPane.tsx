/**
 * 分岐TODOのペイン。会話で保留にした話題を Claude が todo_add で足し、ここで人間が
 * 完了・削除する (Claude は消せない)。表示は「このセッション」と「すべて」を切り替える。
 * 一覧の正本はサーバーで、Dashboard の useTodos から受け取る
 */

import type { Todo } from "@ark/shared";
import { Check, X } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";

interface TodoPaneProps {
  todos: Todo[];
  worktreePath: string;
  error: string | null;
  onSetDone: (id: string, done: boolean) => void;
  onRemove: (id: string) => void;
  /** worktree の表示名。セッションが無い (worktree を消した) ときは null */
  worktreeLabel: (worktreePath: string) => string | null;
  /** 「すべて」で別の worktree の見出しを押したとき、そのセッションを開く */
  onOpenWorktree?: (worktreePath: string) => void;
}

type Scope = "session" | "all";

function TodoRow({
  todo,
  onSetDone,
  onRemove,
}: {
  todo: Todo;
  onSetDone: (id: string, done: boolean) => void;
  onRemove: (id: string) => void;
}) {
  const done = todo.doneAt !== null;
  return (
    <li className="group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-muted">
      <button
        type="button"
        aria-label={done ? "未完了に戻す" : "完了にする"}
        onClick={() => onSetDone(todo.id, !done)}
        className={cn(
          "mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded border",
          done
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground/50"
        )}
      >
        {done ? <Check className="size-3.5" aria-hidden="true" /> : null}
      </button>
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-sm",
            done && "text-muted-foreground line-through"
          )}
        >
          {todo.text}
        </p>
        {todo.note && (
          <p className="mt-0.5 text-xs text-muted-foreground">{todo.note}</p>
        )}
      </div>
      <button
        type="button"
        aria-label="TODO を消す"
        onClick={() => onRemove(todo.id)}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 [@media(hover:none)]:opacity-100 hover:bg-background hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </li>
  );
}

export function TodoPane(props: TodoPaneProps) {
  const [scope, setScope] = useState<Scope>("session");
  const [showDone, setShowDone] = useState(false);

  const own = useMemo(
    () => props.todos.filter(t => t.worktreePath === props.worktreePath),
    [props.todos, props.worktreePath]
  );
  const open = own.filter(t => t.doneAt === null);
  const done = own.filter(t => t.doneAt !== null);

  // 「すべて」: 未完了だけを worktree ごとにまとめる。このセッションを先頭にする
  const groups = useMemo(() => {
    const map = new Map<string, Todo[]>();
    for (const todo of props.todos) {
      if (todo.doneAt !== null) continue;
      const list = map.get(todo.worktreePath) ?? [];
      list.push(todo);
      map.set(todo.worktreePath, list);
    }
    return [...map.entries()].sort(([a], [b]) =>
      a === props.worktreePath
        ? -1
        : b === props.worktreePath
          ? 1
          : a.localeCompare(b)
    );
  }, [props.todos, props.worktreePath]);

  const rowProps = { onSetDone: props.onSetDone, onRemove: props.onRemove };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-1 px-3 pb-2 text-xs">
        {(["session", "all"] as const).map(value => (
          <button
            key={value}
            type="button"
            aria-pressed={scope === value}
            onClick={() => setScope(value)}
            className={cn(
              "rounded-full px-3 py-1 font-semibold",
              scope === value
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {value === "session" ? "このセッション" : "すべて"}
          </button>
        ))}
      </div>
      {props.error && (
        <p className="mx-3 mb-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {props.error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {scope === "session" ? (
          <>
            {open.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                保留にした話題はありません
              </p>
            ) : (
              <ul>
                {open.map(todo => (
                  <TodoRow key={todo.id} todo={todo} {...rowProps} />
                ))}
              </ul>
            )}
            {done.length > 0 && (
              <div className="mt-3">
                <button
                  type="button"
                  aria-expanded={showDone}
                  onClick={() => setShowDone(v => !v)}
                  className="px-2 text-xs font-semibold text-muted-foreground hover:text-foreground"
                >
                  完了 ({done.length})
                </button>
                {showDone && (
                  <ul className="mt-1">
                    {done.map(todo => (
                      <TodoRow key={todo.id} todo={todo} {...rowProps} />
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        ) : groups.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            保留にした話題はありません
          </p>
        ) : (
          groups.map(([worktreePath, list]) => {
            const label = props.worktreeLabel(worktreePath);
            return (
              <section key={worktreePath} className="mb-3">
                <h3 className="px-2 py-1 text-xs font-semibold text-muted-foreground">
                  {label !== null && props.onOpenWorktree ? (
                    <button
                      type="button"
                      onClick={() => props.onOpenWorktree?.(worktreePath)}
                      className="hover:text-foreground hover:underline"
                    >
                      {label}
                    </button>
                  ) : (
                    (label ?? "削除済み worktree")
                  )}
                </h3>
                <ul>
                  {list.map(todo => (
                    <TodoRow key={todo.id} todo={todo} {...rowProps} />
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}
