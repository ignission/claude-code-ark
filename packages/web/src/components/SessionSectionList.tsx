/**
 * SessionSectionList - PCサイドバーとモバイル一覧で共有するセッション一覧
 *
 * 行をリポジトリの見出しの下にまとめて並べる (並べ方は lib/session-sections.ts)。
 * リポジトリの操作 (新しいタスク、ホームにする、除外など) は見出しの「+」と `…` に置く (RepoHeadingMenu.tsx)。
 * 見出しのつまみでリポジトリのかたまりを並べ替え、順はサーバーの設定に保存する
 * (hooks/useRepoReorder.ts)。状態では並べ替えないので、状態が変わっても行は動かない。
 * 行を押せる要素にdata-session-key、かたまりにdata-repo-groupを付ける (撮影のスクリプトが使う)。
 * 行メニューから開く確認ダイアログ (削除・再起動・リポジトリの除外) もここで持つ。
 */

import type {
  BridgeSessionStatus,
  ManagedSession,
  SessionPrStatus,
  Worktree,
} from "@ark/shared";
import { GripVertical } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { useGroupedWorktreeItems } from "@/hooks/useGroupedWorktreeItems";
import { useRepoReorder } from "@/hooks/useRepoReorder";
import { m } from "@/lib/i18n";
import { deleteSessionDescription } from "@/lib/session-header";
import {
  buildSessionEntries,
  groupByRepo,
  type SessionListEntry,
} from "@/lib/session-sections";
import { collectActiveSessionIds } from "@/lib/unlisted-active-sessions";
import { cn } from "@/lib/utils";
import { getBaseName } from "@/utils/pathUtils";
import { RepoHeadingMenu } from "./RepoHeadingMenu";
import { SessionListRow } from "./SessionListRow";
import type { SessionRowMenuProps } from "./SessionRowMenu";

/** 行メニューの「子タスクを分離」で渡すもの (分離元の worktree) */
export interface SplitTaskTarget {
  repoPath: string;
  worktreePath: string;
  /** 分離元の今のブランチ。detached・不明なら undefined */
  branch: string | undefined;
}

export interface SessionSectionListProps {
  /** "sidebar" = PCサイドバーの行、"card" = モバイル一覧のカード */
  variant: "sidebar" | "card";
  sessions: Map<string, ManagedSession>;
  worktrees: Worktree[];
  repoList: string[];
  /** sessionId → BridgeSessionStatus (session:previews由来) */
  sessionStatuses: Map<string, BridgeSessionStatus>;
  /**
   * sessionId → 会話の最終更新時刻 (session:previews由来)。
   * 未登録のリポジトリでも直近に動いたセッションを出すのに使う
   */
  sessionLastUpdatedAt?: Map<string, number>;
  /** sessionId → ブランチのPRとチェックの集計。PRが無ければエントリが無い */
  sessionPrStatuses: Map<string, SessionPrStatus>;
  /** sessionId → 未完了の分岐TODOの件数。無ければエントリが無い */
  sessionTodoCounts?: Map<string, number>;
  selectedSessionId: string | null;
  /** worktreePath → 表示名 */
  worktreeDisplayNames?: Map<string, string>;
  onOpenSession: (sessionId: string) => void;
  onStartSession: (worktree: Worktree) => void;
  /** セッション削除 (停止 + メイン以外のWorktree削除) */
  onDeleteSession: (sessionId: string, worktree: Worktree | undefined) => void;
  /** 未起動のworktreeの削除。モバイルだけ渡す */
  onDeleteWorktree?: (worktree: Worktree) => void;
  /** 再起動 (tmux kill → 新セッション。会話履歴は失われる) */
  onRestartSession?: (sessionId: string) => void;
  /** 手動で休止にする / 休止から戻す */
  onSetSessionRested?: (sessionId: string, rested: boolean) => void;
  onSetWorktreeDisplayName?: (
    worktreePath: string,
    displayName: string | null
  ) => void;
  onCreateWorktreeForRepo?: (repoPath: string) => void;
  /** そのリポジトリで新しいタスクのダイアログを開く (見出しの「+」) */
  onNewTaskForRepo?: (repoPath: string) => void;
  /** その worktree を親にして子タスクを分離する (新しいタスクのダイアログを開く) */
  onSplitTask?: (target: SplitTaskTarget) => void;
  /** リポジトリの全セッションを並べて見る (RepoGridView)。PCだけ渡す */
  onSelectRepoGrid?: (repoPath: string) => void;
  onRemoveRepo?: (repoPath: string) => void;
  /**
   * リポジトリの並び順 (設定 `sessionListRepoOrder` の値)。無い・空ならリポジトリ名の順
   */
  repoOrder?: readonly string[];
  /** リポジトリを並べ替えたときに新しい保存値を渡す。無ければつまみを出さない */
  onRepoOrderChange?: (order: string[]) => void;
  /** 「あなたの番」の件数が変わるたびに呼ぶ (畳んだサイドバーの帯に出す) */
  onYourTurnCountChange?: (count: number) => void;
  /**
   * ホームの worktree のパス (lib/home-session.ts)。この行は一覧に出さない
   * (呼び出し側が一覧の上に固定の行で出す)
   */
  homeWorktreePath?: string | null;
  /** 見出しのメニューから、そのリポジトリのmainのworktreeをホームにする。無ければ項目を出さない */
  onSetHome?: (worktreePath: string) => void;
}

type DeleteTarget =
  | { kind: "session"; sessionId: string; worktree: Worktree | undefined }
  | { kind: "worktree"; worktree: Worktree };

const NO_REPO_ORDER: readonly string[] = [];

function worktreePathOf(entry: SessionListEntry): string | null {
  return entry.worktree?.path ?? entry.session?.worktreePath ?? null;
}

function deleteDescription(target: DeleteTarget): string {
  if (target.kind === "worktree") {
    return m.session.list.deleteWorktreeConfirm;
  }
  return deleteSessionDescription(target.worktree);
}

/**
 * 選んでいる行を、一覧のスクロールの中で見える位置へ寄せる。
 * 選択が替わったときは行が自分で寄る (SessionListRow)。ここは、選択が替わらない操作
 * (選んでいるタブをもう一度押すなど) から呼ぶ
 */
export function revealSelectedSessionRow(): void {
  document
    .querySelector('[data-session-list] [aria-current="true"]')
    ?.scrollIntoView?.({ block: "nearest" });
}

const NO_LAST_UPDATED: ReadonlyMap<string, number> = new Map();

export function SessionSectionList({
  variant,
  sessions,
  worktrees,
  repoList,
  sessionStatuses,
  sessionLastUpdatedAt,
  sessionPrStatuses,
  sessionTodoCounts,
  selectedSessionId,
  worktreeDisplayNames,
  onOpenSession,
  onStartSession,
  onDeleteSession,
  onDeleteWorktree,
  onRestartSession,
  onSetSessionRested,
  onSetWorktreeDisplayName,
  onCreateWorktreeForRepo,
  onNewTaskForRepo,
  onSplitTask,
  onSelectRepoGrid,
  onRemoveRepo,
  repoOrder = NO_REPO_ORDER,
  onRepoOrderChange,
  onYourTurnCountChange,
  homeWorktreePath = null,
  onSetHome,
}: SessionSectionListProps) {
  // 未登録のリポジトリでも、動いているか直近に動いたセッションは一覧に出す。
  // 中身が変わったときだけ Set を作り直す (状態は毎秒届くので、毎回作り直すと一覧を組み直し続ける)
  const activeSessionKey = collectActiveSessionIds(
    Array.from(sessions.values(), session => session.id),
    sessionStatuses,
    sessionLastUpdatedAt ?? NO_LAST_UPDATED,
    Date.now()
  ).join("\n");
  const activeSessionIds = useMemo(
    () => new Set(activeSessionKey ? activeSessionKey.split("\n") : []),
    [activeSessionKey]
  );
  const { groupedItems } = useGroupedWorktreeItems(
    worktrees,
    sessions,
    repoList,
    activeSessionIds
  );
  // ホームの行は一覧から外す (呼び出し側が一覧の上に固定の行で出す)
  const entries = useMemo(
    () =>
      buildSessionEntries(groupedItems, sessionStatuses).filter(
        entry =>
          homeWorktreePath === null ||
          worktreePathOf(entry) !== homeWorktreePath
      ),
    [groupedItems, sessionStatuses, homeWorktreePath]
  );
  const repoSections = useMemo(
    () => groupByRepo(groupedItems, entries, repoList, repoOrder),
    [groupedItems, entries, repoList, repoOrder]
  );
  const listRef = useRef<HTMLDivElement | null>(null);
  const {
    order: shownRepoOrder,
    draggingRepoPath,
    handleProps,
  } = useRepoReorder({
    visibleOrder: useMemo(
      () => repoSections.map(section => section.repoPath),
      [repoSections]
    ),
    savedOrder: repoOrder,
    onChange: onRepoOrderChange,
    containerRef: listRef,
  });
  // ドラッグ中はドラッグで並べた順に描く。途中で消えた・増えたかたまりも落とさない
  const shownSections = useMemo(() => {
    const byPath = new Map(repoSections.map(s => [s.repoPath, s] as const));
    const ordered = shownRepoOrder.flatMap(path => byPath.get(path) ?? []);
    const placed = new Set(ordered);
    return [...ordered, ...repoSections.filter(s => !placed.has(s))];
  }, [repoSections, shownRepoOrder]);
  const canReorder = onRepoOrderChange !== undefined && repoSections.length > 1;
  // 畳んだサイドバーの帯に出す件数を外へ知らせる
  const yourTurnCount = useMemo(
    () => entries.filter(e => e.yourTurn).length,
    [entries]
  );
  useEffect(() => {
    onYourTurnCountChange?.(yourTurnCount);
  }, [yourTurnCount, onYourTurnCountChange]);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [restartSessionId, setRestartSessionId] = useState<string | null>(null);
  const [removeRepoPath, setRemoveRepoPath] = useState<string | null>(null);

  const buildMenu = (
    entry: SessionListEntry
  ): Omit<SessionRowMenuProps, "variant" | "entry"> => {
    const { session, worktree, repoPath } = entry;
    const worktreePath = worktreePathOf(entry);

    let onDelete: (() => void) | undefined;
    if (session) {
      onDelete = () =>
        setDeleteTarget({
          kind: "session",
          sessionId: session.id,
          worktree: worktree ?? undefined,
        });
    } else if (worktree && !worktree.isMain && onDeleteWorktree) {
      onDelete = () => setDeleteTarget({ kind: "worktree", worktree });
    }

    return {
      onOpen: () => {
        if (session) onOpenSession(session.id);
        else if (worktree) onStartSession(worktree);
      },
      onSplitTask:
        onSplitTask && worktreePath
          ? () => {
              const branch = entry.worktree?.branch;
              onSplitTask({
                repoPath,
                worktreePath,
                branch:
                  branch && branch !== "(detached)" && branch !== "unknown"
                    ? branch
                    : undefined,
              });
            }
          : undefined,
      onStartRename:
        onSetWorktreeDisplayName && worktreePath
          ? () => setEditingKey(entry.key)
          : undefined,
      // 休止にできるのは「あなたの番」の行だけ。作業中の行は休止にしてもすぐ会話が動いて外れる
      rest:
        session &&
        onSetSessionRested &&
        (entry.manuallyRested || entry.yourTurn)
          ? {
              rested: entry.manuallyRested,
              onChange: rested => onSetSessionRested(session.id, rested),
            }
          : undefined,
      onRestart:
        session && onRestartSession
          ? () => setRestartSessionId(session.id)
          : undefined,
      onDelete,
    };
  };

  const renderRepoHeading = (section: (typeof repoSections)[number]) => (
    <h2
      className={cn(
        "flex h-7 items-center gap-1.5 font-semibold text-muted-foreground",
        variant === "sidebar" ? "px-2.5 text-[12px]" : "px-1 text-[13px]"
      )}
      title={section.repoPath}
    >
      <span className="min-w-0 truncate">{section.repoName}</span>
      {section.disambiguator && (
        <span className="min-w-0 truncate font-normal">
          {section.disambiguator}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        <RepoHeadingMenu
          variant={variant}
          repoName={section.repoName}
          onNewTask={
            onNewTaskForRepo
              ? () => onNewTaskForRepo(section.repoPath)
              : undefined
          }
          onSetHome={
            onSetHome &&
            section.mainWorktreePath &&
            section.mainWorktreePath !== homeWorktreePath
              ? () => onSetHome(section.mainWorktreePath as string)
              : undefined
          }
          onCreateWorktree={
            onCreateWorktreeForRepo
              ? () => onCreateWorktreeForRepo(section.repoPath)
              : undefined
          }
          onOpenRepoGrid={
            onSelectRepoGrid
              ? () => onSelectRepoGrid(section.repoPath)
              : undefined
          }
          onRemoveRepo={
            onRemoveRepo ? () => setRemoveRepoPath(section.repoPath) : undefined
          }
        />
        {canReorder && (
          <button
            type="button"
            {...handleProps(section.repoPath)}
            aria-label={m.session.list.reorderRepo(section.repoName)}
            className={cn(
              "inline-flex shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing",
              // sidebar はかたまりにポインタを載せたときだけ出す (行の … と同じ)。card は指で掴むので常に出す
              variant === "sidebar"
                ? "h-6 w-6 opacity-0 group-hover/repo:opacity-100 focus-visible:opacity-100"
                : "-mr-1 h-9 w-9",
              draggingRepoPath === section.repoPath && "opacity-100"
            )}
          >
            <GripVertical className="size-4" aria-hidden="true" />
          </button>
        )}
      </span>
    </h2>
  );

  const renderRow = (entry: SessionListEntry) => {
    const worktreePath = worktreePathOf(entry);
    const displayName = worktreePath
      ? worktreeDisplayNames?.get(worktreePath)?.trim() || null
      : null;
    return (
      <SessionListRow
        key={entry.key}
        variant={variant}
        entry={entry}
        displayName={displayName}
        prStatus={
          entry.session
            ? (sessionPrStatuses.get(entry.session.id) ?? null)
            : null
        }
        todoCount={
          entry.session ? (sessionTodoCounts?.get(entry.session.id) ?? 0) : 0
        }
        selected={
          entry.session !== null && entry.session.id === selectedSessionId
        }
        editing={editingKey === entry.key}
        onEditingChange={editing =>
          setEditingKey(current => {
            if (editing) return entry.key;
            return current === entry.key ? null : current;
          })
        }
        onSaveDisplayName={
          onSetWorktreeDisplayName && worktreePath
            ? name => onSetWorktreeDisplayName(worktreePath, name)
            : undefined
        }
        menu={buildMenu(entry)}
      />
    );
  };

  return (
    <>
      <div
        ref={listRef}
        data-session-list=""
        className={cn(
          "flex flex-col",
          variant === "sidebar" ? "gap-3" : "gap-4"
        )}
      >
        {shownSections.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            <p>{m.session.list.empty}</p>
            <p className="mt-1 text-xs">{m.session.list.emptyHint}</p>
          </div>
        ) : (
          shownSections.map(section => (
            <section
              key={section.repoPath}
              data-repo-group={section.repoPath}
              className={cn(
                "group/repo flex flex-col transition-opacity",
                variant === "sidebar" ? "gap-px" : "gap-2",
                draggingRepoPath === section.repoPath && "opacity-60"
              )}
            >
              {renderRepoHeading(section)}
              {section.entries.map(renderRow)}
            </section>
          ))
        )}
      </div>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={open => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent className="w-[calc(100%-2rem)] max-w-md mx-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget?.kind === "worktree"
                ? m.session.actions.deleteWorktree
                : m.session.actions.deleteSession}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? deleteDescription(deleteTarget) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="h-12 md:h-10">
              {m.common.cancel}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 h-12 md:h-10"
              onClick={() => {
                if (deleteTarget?.kind === "session") {
                  onDeleteSession(
                    deleteTarget.sessionId,
                    deleteTarget.worktree
                  );
                } else if (deleteTarget?.kind === "worktree") {
                  onDeleteWorktree?.(deleteTarget.worktree);
                }
                setDeleteTarget(null);
              }}
            >
              {m.common.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={restartSessionId !== null}
        onOpenChange={open => {
          if (!open) setRestartSessionId(null);
        }}
      >
        <AlertDialogContent className="w-[calc(100%-2rem)] max-w-md mx-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {m.session.list.restartConfirmTitle}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {m.session.list.restartConfirmBody}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="h-12 md:h-10">
              {m.common.cancel}
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-12 md:h-10"
              onClick={() => {
                if (restartSessionId) onRestartSession?.(restartSessionId);
                setRestartSessionId(null);
              }}
            >
              {m.session.actions.restart}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={removeRepoPath !== null}
        onOpenChange={open => {
          if (!open) setRemoveRepoPath(null);
        }}
      >
        <AlertDialogContent className="w-[calc(100%-2rem)] max-w-md mx-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {m.session.list.removeRepoTitle}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {removeRepoPath
                ? m.session.list.removeRepoBody(getBaseName(removeRepoPath))
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="h-12 md:h-10">
              {m.common.cancel}
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-12 md:h-10"
              onClick={() => {
                if (removeRepoPath) onRemoveRepo?.(removeRepoPath);
                setRemoveRepoPath(null);
              }}
            >
              {m.session.list.removeRepoAction}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
