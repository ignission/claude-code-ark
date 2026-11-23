/**
 * SessionSectionList - PCサイドバーとモバイル一覧で共有するセッション一覧
 *
 * 行を「あなたの番 → 作業中 → 休止中」の注意の順に並べる。セクション見出しと行は
 * 同じ親の直下に安定したkeyで置き、セクションをまたいでも行を再マウントしない
 * (表示名の編集中の値やフォーカスを失わないため)。
 * ポインタ・フォーカス・メニュー・タッチの間は並びを保留し、チップと件数の表示だけ最新にする。
 * 行を押せる要素にdata-session-key、見出しにdata-sectionを付ける (撮影のスクリプトが使う)。
 * 行メニューから開く確認ダイアログ (削除・再起動・リポジトリの除外) もここで持つ。
 */

import type {
  BridgeSessionStatus,
  ManagedSession,
  SessionPrStatus,
  Worktree,
} from "@ark/shared";
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
import { useHeldOrder, useListHold } from "@/hooks/useHeldOrder";
import { m } from "@/lib/i18n";
import { deleteSessionDescription } from "@/lib/session-header";
import {
  buildSessionEntries,
  countChildren,
  type SessionListRow as ListRow,
  type SessionListEntry,
  sectionize,
  sortSessionEntries,
  toListRows,
} from "@/lib/session-sections";
import { SECTION_LABELS, TONE_CLASSES } from "@/lib/status-tone";
import { collectActiveSessionIds } from "@/lib/unlisted-active-sessions";
import { cn } from "@/lib/utils";
import { getBaseName } from "@/utils/pathUtils";
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
   * セクションの中はこれの降順に並べる。未起動や読めていない行は不明として最後へ
   */
  sessionLastUpdatedAt?: Map<string, number>;
  /** sessionId → 端末の最後の内容行。2行目にそのまま出す */
  sessionPreviews: Map<string, string>;
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
  /** その worktree を親にして子タスクを分離する (新しいタスクのダイアログを開く) */
  onSplitTask?: (target: SplitTaskTarget) => void;
  /** リポジトリの全セッションを並べて見る (RepoGridView)。PCだけ渡す */
  onSelectRepoGrid?: (repoPath: string) => void;
  onRemoveRepo?: (repoPath: string) => void;
  /** 「あなたの番」の件数が変わるたびに呼ぶ (畳んだサイドバーの帯に出す) */
  onYourTurnCountChange?: (count: number) => void;
  /**
   * ホームの worktree のパス (lib/home-session.ts)。この行は一覧に出さない
   * (呼び出し側が一覧の上に固定の行で出す)
   */
  homeWorktreePath?: string | null;
  /** 行のメニューから worktree をホームにする。無ければ項目を出さない */
  onSetHome?: (worktreePath: string) => void;
}

type DeleteTarget =
  | { kind: "session"; sessionId: string; worktree: Worktree | undefined }
  | { kind: "worktree"; worktree: Worktree };

/** 休止の付け外しがサーバーから届かなかったときに、保留へ戻すまでの時間 */
const PENDING_REST_TIMEOUT_MS = 5000;
const rowKey = (row: ListRow) => row.key;

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
  sessionPreviews,
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
  onSplitTask,
  onSelectRepoGrid,
  onRemoveRepo,
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
  const { held: pointerHeld, bindings, onMenuOpenChange } = useListHold();
  // 行メニューで休止にした (戻した) 行は、保留中でも新しいセクションへ動かす。
  // メニューを閉じるとフォーカスは … に残り、ポインタも一覧の上にあるので、保留のままだと
  // 選んでも何も起きないように見える。行が動いたら (または届かなければ時間で) 保留に戻す
  const [pendingRest, setPendingRest] = useState<{
    key: string;
    rested: boolean;
  } | null>(null);
  const held = pointerHeld && pendingRest === null;
  // ホームの行は一覧から外す。親をたどる対応表 (entryByPath) にも入らないので、
  // ホームの子は親の表示を持たない普通の行になる (子は全部ホームの子なので、出すと全行に付く)
  const entries = useMemo(
    () =>
      sortSessionEntries(
        buildSessionEntries(groupedItems, sessionStatuses, sessionLastUpdatedAt)
      ).filter(
        entry =>
          homeWorktreePath === null ||
          worktreePathOf(entry) !== homeWorktreePath
      ),
    [groupedItems, sessionStatuses, sessionLastUpdatedAt, homeWorktreePath]
  );
  const rows = useMemo(() => toListRows(sectionize(entries)), [entries]);
  // 見出しの件数と同じ値を外へ知らせる。並びを保留していても件数は最新にする
  const yourTurnCount = useMemo(
    () => entries.filter(e => e.section === "your-turn").length,
    [entries]
  );
  useEffect(() => {
    onYourTurnCountChange?.(yourTurnCount);
  }, [yourTurnCount, onYourTurnCountChange]);
  // 親子の表示: 親の行に出す子の数と、子の行から親をたどるための worktree のパス → 行
  const childCounts = useMemo(() => countChildren(entries), [entries]);
  const entryByPath = useMemo(() => {
    const map = new Map<string, SessionListEntry>();
    for (const entry of entries) {
      const path = worktreePathOf(entry);
      if (path) map.set(path, entry);
    }
    return map;
  }, [entries]);
  useEffect(() => {
    if (!pendingRest) return;
    const entry = entries.find(e => e.key === pendingRest.key);
    if (!entry || entry.manuallyRested === pendingRest.rested) {
      setPendingRest(null);
      return;
    }
    const timer = setTimeout(
      () => setPendingRest(null),
      PENDING_REST_TIMEOUT_MS
    );
    return () => clearTimeout(timer);
  }, [entries, pendingRest]);
  const shownRows = useHeldOrder(rows, rowKey, held);
  // 保留していなければ、直後に行が続かない (空の) 見出しは描かない。
  // 保留中は描く見出しを保留の前のまま固定する。空になった見出しも残して下の行を動かさず、
  // 保留の前に空だった見出しは行が入っても出さない (出すとその分だけ下の行が押し下がる)
  const visibleHeadingKeysRef = useRef<ReadonlySet<string>>(new Set());
  const visibleRows = shownRows.filter((row, index) => {
    if (row.kind === "entry") return true;
    return held
      ? visibleHeadingKeysRef.current.has(row.key)
      : shownRows[index + 1]?.kind === "entry";
  });
  useEffect(() => {
    visibleHeadingKeysRef.current = new Set(
      visibleRows.filter(row => row.kind === "section").map(rowKey)
    );
  });

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

    const parentSession = entry.parentWorktreePath
      ? (entryByPath.get(entry.parentWorktreePath)?.session ?? null)
      : null;

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
      onOpenParent: parentSession
        ? () => onOpenSession(parentSession.id)
        : undefined,
      onSetHome:
        onSetHome && worktreePath ? () => onSetHome(worktreePath) : undefined,
      onStartRename:
        onSetWorktreeDisplayName && worktreePath
          ? () => setEditingKey(entry.key)
          : undefined,
      // 休止にできるのは「あなたの番」の行だけ。作業中の行は休止にしてもすぐ会話が動いて外れる
      rest:
        session &&
        onSetSessionRested &&
        (entry.manuallyRested || entry.section === "your-turn")
          ? {
              rested: entry.manuallyRested,
              onChange: rested => {
                setPendingRest({ key: entry.key, rested });
                onSetSessionRested(session.id, rested);
              },
            }
          : undefined,
      onRestart:
        session && onRestartSession
          ? () => setRestartSessionId(session.id)
          : undefined,
      onCreateWorktree: onCreateWorktreeForRepo
        ? () => onCreateWorktreeForRepo(repoPath)
        : undefined,
      onOpenRepoGrid: onSelectRepoGrid
        ? () => onSelectRepoGrid(repoPath)
        : undefined,
      onRemoveRepo: onRemoveRepo
        ? () => setRemoveRepoPath(repoPath)
        : undefined,
      onDelete,
    };
  };

  const renderSection = (row: Extract<ListRow, { kind: "section" }>) => (
    <h2
      key={row.key}
      data-section={row.section}
      className={cn(
        "mt-4 flex h-7 items-center gap-2 font-semibold text-muted-foreground first:mt-0",
        // sidebar の見出しは小さい大文字の間隔で、行の題と読み分ける
        variant === "sidebar"
          ? "px-2.5 text-[11px] tracking-[0.06em]"
          : "px-1 text-[13px]"
      )}
    >
      <span>{SECTION_LABELS[row.section]}</span>
      {row.section === "your-turn" && row.count > 0 && (
        <span
          data-testid="section-count"
          className={cn(
            "inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-sm px-1 font-mono text-[11px] font-bold tabular-nums tracking-normal text-background",
            TONE_CLASSES.awaiting.solidBg
          )}
        >
          {row.count}
        </span>
      )}
    </h2>
  );

  const labelOf = (path: string): string => {
    const entry = entryByPath.get(path);
    return (
      worktreeDisplayNames?.get(path)?.trim() ||
      entry?.worktree?.branch ||
      getBaseName(path)
    );
  };

  const renderRow = (entry: SessionListEntry) => {
    const worktreePath = worktreePathOf(entry);
    const displayName = worktreePath
      ? worktreeDisplayNames?.get(worktreePath)?.trim() || null
      : null;
    const parentPath = entry.parentWorktreePath;
    const parentSession = parentPath
      ? (entryByPath.get(parentPath)?.session ?? null)
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
        childCount={worktreePath ? (childCounts.get(worktreePath) ?? 0) : 0}
        parentLabel={
          parentPath && parentPath !== homeWorktreePath
            ? labelOf(parentPath)
            : null
        }
        onOpenParent={
          parentSession ? () => onOpenSession(parentSession.id) : undefined
        }
        previewText={
          entry.session ? (sessionPreviews.get(entry.session.id) ?? "") : ""
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
        onMenuOpenChange={onMenuOpenChange}
      />
    );
  };

  return (
    <>
      <div
        data-session-list=""
        className={cn(
          "flex flex-col",
          variant === "sidebar" ? "gap-px" : "gap-2"
        )}
        {...bindings}
      >
        {visibleRows.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            <p>{m.session.list.empty}</p>
            <p className="mt-1 text-xs">{m.session.list.emptyHint}</p>
          </div>
        ) : (
          visibleRows.map(row =>
            row.kind === "section" ? renderSection(row) : renderRow(row.entry)
          )
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
