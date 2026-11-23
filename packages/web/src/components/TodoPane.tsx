/**
 * 分岐TODOのペイン。会話で保留にした話題を Claude が todo_add で足し、ここで人間が
 * 完了・削除する (Claude は消せない)。表示は「このセッション」と「すべて」を切り替える。
 * 一覧の正本はサーバーで、Dashboard の useTodos から受け取る
 *
 * 未完了の行からは、その話題の会話を「元のセッション」か「新しいworktree」で始められる。
 * どちらもチャット入力欄に下書きを入れるだけで送らない (配線は Dashboard)。元のworktreeが
 * 消えていれば始められない。始めた先 (最後の1件) は行の下に出し、押すとそのセッションを開く
 *
 * 始めた先のセッションがいまある行は、始めるボタンを出さず、黄色の「<名前> へ移動」だけを
 * 本文の下に出す (判定は todo-start.ts の todoStartedSessionPath)。押すとそのセッションを開き、
 * 新しくは始めない (同じTODOからセッションを二重に作らないため)。右には「完了」を並べ、
 * 始めた先で片付いた行をその場で完了にできるようにする (左のチェックボックスと同じ操作)。
 * この行を完了にすると、確認のダイアログを出してから、始めた先のセッションとworktreeを
 * 消して完了にする (onFinishStarted)。worktreeの削除は未コミットの変更も消すので、確認を挟む。
 * キャンセルしたら何もしない。onFinishStarted が無ければ、確認せずに完了の印だけを付ける。
 * 「完了」は黄色と同じ濃さの緑にする。黄色は GitRefLabels の
 * タグと同じ配色。行のアイコンは PC ではホバーするまで見えないので、色を付けるのではなく
 * 常に見える文字のボタンにする。セッションを消すと、行は元の始めるボタンに戻る
 *
 * 行き先のリポジトリを持つ行 (todo_add の repo) は、アイコンではなく「<リポジトリ名> で始める」と
 * 文字で出すボタンを本文の下に置く。別のリポジトリのタスクとして切り出す行で、アイコン 2 つの
 * 見分けに頼らせないため。押すと新しいタスクのダイアログがそのリポジトリで開く。
 * この行には「元のセッションで話す」を出さない (別のリポジトリの仕事を、置いたセッションが
 * 自分で始めてしまうため)
 */

import type { Todo } from "@ark/shared";
import {
  ArrowRight,
  Check,
  GitBranchPlus,
  MessageSquareText,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { m } from "@/lib/i18n";
import { todoStartedSessionPath } from "@/lib/todo-start";
import { cn } from "@/lib/utils";
import { getBaseName } from "@/utils/pathUtils";

interface TodoPaneProps {
  todos: Todo[];
  worktreePath: string;
  error: string | null;
  onSetDone: (id: string, done: boolean) => void;
  /**
   * 始めた先のセッションがある行を、確認のあとで完了にする。始めた先のセッションと
   * worktreeを消し、TODOを完了にするのは渡す側。省略時は onSetDone だけを呼ぶ
   */
  onFinishStarted?: (todo: Todo, startedWorktreePath: string) => void;
  onRemove: (id: string) => void;
  /** worktree の表示名。セッションが無い (worktree を消した) ときは null */
  worktreeLabel: (worktreePath: string) => string | null;
  /** 「すべて」で別の worktree の見出しを押したとき、そのセッションを開く */
  onOpenWorktree?: (worktreePath: string) => void;
  /** その worktree にセッションがあって開けるか。省略時は開ける。false なら見出しはボタンにしない */
  canOpenWorktree?: (worktreePath: string) => boolean;
  /**
   * 黄色の「<名前> へ移動」を押したとき。省略時は onOpenWorktree を使う。
   * Dashboard は会話を見せる開き方を渡す (モバイルは移動先が TODO の表示のままでも会話へ替える)
   */
  onOpenStarted?: (worktreePath: string) => void;
  /** 「元のセッションで話す」。省略時はボタンを出さない */
  onStartHere?: (todo: Todo) => void;
  /** 「新しいworktreeで話す」。省略時はボタンを出さない */
  onStartInNewWorktree?: (todo: Todo) => void;
  /** 新しいworktreeを作れるか (元のリポジトリが分かるか)。省略時は作れる */
  canStartInNewWorktree?: (todo: Todo) => boolean;
}

type Scope = "session" | "all";

/** 完了の確認を待っている行と、その始めた先 */
interface FinishTarget {
  todo: Todo;
  path: string;
  label: string;
}

type RowProps = Pick<
  TodoPaneProps,
  | "onSetDone"
  | "onRemove"
  | "worktreeLabel"
  | "onOpenWorktree"
  | "canOpenWorktree"
  | "onOpenStarted"
  | "onStartHere"
  | "onStartInNewWorktree"
  | "canStartInNewWorktree"
> & {
  /** 始めた先のセッションがある行を完了にしようとした (確認のダイアログを開く) */
  onRequestFinish?: (target: FinishTarget) => void;
};

const ROW_ICON_BUTTON =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 [@media(hover:none)]:opacity-100 hover:bg-background hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100";

/** 始めた先の行。始めた先が元と同じなら「このセッションで始めた」。開けないときはボタンにしない */
function StartedLine({ todo, ...props }: { todo: Todo } & RowProps) {
  const path = todo.startedWorktreePath;
  if (path === null) return null;
  const label = props.worktreeLabel(path);
  const text =
    path === todo.worktreePath ? m.todo.startedHere : m.todo.startedIn(label);
  const canOpen =
    label !== null &&
    props.onOpenWorktree !== undefined &&
    (props.canOpenWorktree?.(path) ?? true);
  return (
    <p className="mt-0.5 text-xs text-muted-foreground">
      {canOpen ? (
        <button
          type="button"
          onClick={() => props.onOpenWorktree?.(path)}
          className="hover:text-foreground hover:underline"
        >
          {text}
        </button>
      ) : (
        text
      )}
    </p>
  );
}

function TodoRow({ todo, ...props }: { todo: Todo } & RowProps) {
  const { onSetDone, onRemove } = props;
  const done = todo.doneAt !== null;
  // 始めた先のセッションがあれば、始める代わりにそこへ移動する
  const openStarted = props.onOpenStarted ?? props.onOpenWorktree;
  const startedPath =
    openStarted === undefined
      ? null
      : todoStartedSessionPath(
          todo,
          path =>
            props.worktreeLabel(path) !== null &&
            (props.canOpenWorktree?.(path) ?? true)
        );
  const startedLabel =
    startedPath === null ? null : props.worktreeLabel(startedPath);
  // 始めた先のセッションがある行の完了は、確認してから始めた先ごと片付ける
  const finish = () => {
    if (
      startedPath !== null &&
      startedLabel !== null &&
      props.onRequestFinish
    ) {
      props.onRequestFinish({ todo, path: startedPath, label: startedLabel });
      return;
    }
    onSetDone(todo.id, true);
  };
  // 始められるのは未完了で、元のworktreeが残っていて、始めた先のセッションが無い行だけ
  const canStart =
    !done &&
    startedPath === null &&
    props.worktreeLabel(todo.worktreePath) !== null;
  // 行き先のリポジトリを持つ行は、文字のボタンでそのリポジトリのタスクとして始める
  const startInRepo =
    canStart &&
    todo.repoPath !== null &&
    props.onStartInNewWorktree !== undefined;
  return (
    <li className="group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-muted">
      <button
        type="button"
        aria-label={done ? m.todo.markUndone : m.todo.markDone}
        onClick={() => (done ? onSetDone(todo.id, false) : finish())}
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
        {startedPath !== null && startedLabel !== null ? (
          <div className="mt-1.5 flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => openStarted?.(startedPath)}
              className="inline-flex min-h-8 min-w-0 items-center gap-1.5 rounded-md border border-amber-500/50 bg-amber-500/15 px-2.5 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-500/25 dark:text-amber-300"
            >
              <ArrowRight className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">
                {m.todo.openStarted(startedLabel)}
              </span>
            </button>
            <button
              type="button"
              onClick={finish}
              className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md border border-emerald-500/50 bg-emerald-500/15 px-2.5 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-500/25 dark:text-emerald-300"
            >
              <Check className="size-3.5" aria-hidden="true" />
              {m.todo.finishStarted}
            </button>
          </div>
        ) : (
          <StartedLine todo={todo} {...props} />
        )}
        {startInRepo && (
          <button
            type="button"
            onClick={() => props.onStartInNewWorktree?.(todo)}
            className="mt-1.5 inline-flex min-h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
          >
            <GitBranchPlus className="size-3.5" aria-hidden="true" />
            {m.todo.startInRepo(getBaseName(todo.repoPath ?? ""))}
          </button>
        )}
      </div>
      {canStart && !startInRepo && props.onStartHere && (
        <button
          type="button"
          aria-label={m.todo.talkHere}
          title={m.todo.talkHere}
          onClick={() => props.onStartHere?.(todo)}
          className={ROW_ICON_BUTTON}
        >
          <MessageSquareText className="size-3.5" aria-hidden="true" />
        </button>
      )}
      {canStart &&
        !startInRepo &&
        props.onStartInNewWorktree &&
        (props.canStartInNewWorktree?.(todo) ?? true) && (
          <button
            type="button"
            aria-label={m.todo.talkInNewWorktree}
            title={m.todo.talkInNewWorktree}
            onClick={() => props.onStartInNewWorktree?.(todo)}
            className={ROW_ICON_BUTTON}
          >
            <GitBranchPlus className="size-3.5" aria-hidden="true" />
          </button>
        )}
      <button
        type="button"
        aria-label={m.todo.remove}
        onClick={() => onRemove(todo.id)}
        className={ROW_ICON_BUTTON}
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </li>
  );
}

export function TodoPane(props: TodoPaneProps) {
  const [scope, setScope] = useState<Scope>("session");
  const [showDone, setShowDone] = useState(false);
  const [finishTarget, setFinishTarget] = useState<FinishTarget | null>(null);
  const onFinishStarted = props.onFinishStarted;

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

  const rowProps: RowProps = {
    onSetDone: props.onSetDone,
    onRemove: props.onRemove,
    worktreeLabel: props.worktreeLabel,
    onOpenWorktree: props.onOpenWorktree,
    canOpenWorktree: props.canOpenWorktree,
    onOpenStarted: props.onOpenStarted,
    onStartHere: props.onStartHere,
    onStartInNewWorktree: props.onStartInNewWorktree,
    canStartInNewWorktree: props.canStartInNewWorktree,
    onRequestFinish: onFinishStarted ? setFinishTarget : undefined,
  };

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
            {value === "session" ? m.todo.scopeSession : m.todo.scopeAll}
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
                {m.todo.empty}
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
                  {m.todo.doneCount(done.length)}
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
            {m.todo.empty}
          </p>
        ) : (
          groups.map(([worktreePath, list]) => {
            const label = props.worktreeLabel(worktreePath);
            return (
              <section key={worktreePath} className="mb-3">
                <h3 className="px-2 py-1 text-xs font-semibold text-muted-foreground">
                  {label !== null &&
                  props.onOpenWorktree &&
                  (props.canOpenWorktree?.(worktreePath) ?? true) ? (
                    <button
                      type="button"
                      onClick={() => props.onOpenWorktree?.(worktreePath)}
                      className="hover:text-foreground hover:underline"
                    >
                      {label}
                    </button>
                  ) : (
                    (label ?? m.todo.deletedWorktree)
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
      <AlertDialog
        open={finishTarget !== null}
        onOpenChange={open => {
          if (!open) setFinishTarget(null);
        }}
      >
        <AlertDialogContent className="w-[calc(100%-2rem)] max-w-md mx-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {m.todo.finishStartedConfirmTitle}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {finishTarget
                ? m.todo.finishStartedConfirm(finishTarget.label)
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="h-12 md:h-10">
              {m.common.cancel}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 h-12 md:h-10"
              onClick={() => {
                if (finishTarget) {
                  onFinishStarted?.(finishTarget.todo, finishTarget.path);
                }
                setFinishTarget(null);
              }}
            >
              {m.todo.finishStartedConfirmAction}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
