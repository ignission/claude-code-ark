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
  Profile,
  SystemCapabilities,
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
import { deleteSessionDescription } from "@/lib/session-header";
import {
  buildSessionEntries,
  type SessionListRow as ListRow,
  type SessionListEntry,
  sectionize,
  sortSessionEntries,
  toListRows,
} from "@/lib/session-sections";
import { SECTION_LABELS, TONE_CLASSES } from "@/lib/status-tone";
import { cn } from "@/lib/utils";
import { getBaseName } from "@/utils/pathUtils";
import { resolveSessionRowProfile, SessionListRow } from "./SessionListRow";
import type { SessionRowMenuProps } from "./SessionRowMenu";

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
  selectedSessionId: string | null;
  /** worktreePath → 表示名 */
  worktreeDisplayNames?: Map<string, string>;
  capabilities?: SystemCapabilities;
  profiles?: Profile[];
  repoProfileLinks?: Map<string, string>;
  /** worktreePath → profileIdの個別の上書き */
  worktreeProfileLinks?: Map<string, string>;
  notificationsSupported?: boolean;
  isSessionNotificationEnabled?: (sessionId: string) => boolean;
  onOpenSession: (sessionId: string) => void;
  onStartSession: (worktree: Worktree) => void;
  /** セッション削除 (停止 + メイン以外のWorktree削除) */
  onDeleteSession: (sessionId: string, worktree: Worktree | undefined) => void;
  /** 未起動のworktreeの削除。モバイルだけ渡す */
  onDeleteWorktree?: (worktree: Worktree) => void;
  /** 再起動 (tmux kill → 新セッション。会話履歴は失われる) */
  onRestartSession?: (sessionId: string) => void;
  onSetWorktreeDisplayName?: (
    worktreePath: string,
    displayName: string | null
  ) => void;
  onSessionNotificationEnabledChange?: (
    sessionId: string,
    enabled: boolean
  ) => void;
  onCreateWorktreeForRepo?: (repoPath: string) => void;
  /** リポジトリの全セッションを並べて見る (RepoGridView)。PCだけ渡す */
  onSelectRepoGrid?: (repoPath: string) => void;
  onRemoveRepo?: (repoPath: string) => void;
  onSetRepoProfile?: (repoPath: string, profileId: string | null) => void;
  onSetWorktreeProfile?: (
    worktreePath: string,
    profileId: string | null
  ) => void;
  onOpenProfileManager?: () => void;
}

type DeleteTarget =
  | { kind: "session"; sessionId: string; worktree: Worktree | undefined }
  | { kind: "worktree"; worktree: Worktree };

const NO_PROFILES: Profile[] = [];
const rowKey = (row: ListRow) => row.key;

function worktreePathOf(entry: SessionListEntry): string | null {
  return entry.worktree?.path ?? entry.session?.worktreePath ?? null;
}

function deleteDescription(target: DeleteTarget): string {
  if (target.kind === "worktree") {
    return "このWorktreeを削除しますか？関連するブランチも削除されます。";
  }
  return deleteSessionDescription(target.worktree);
}

export function SessionSectionList({
  variant,
  sessions,
  worktrees,
  repoList,
  sessionStatuses,
  sessionLastUpdatedAt,
  sessionPreviews,
  selectedSessionId,
  worktreeDisplayNames,
  capabilities,
  profiles,
  repoProfileLinks,
  worktreeProfileLinks,
  notificationsSupported = false,
  isSessionNotificationEnabled,
  onOpenSession,
  onStartSession,
  onDeleteSession,
  onDeleteWorktree,
  onRestartSession,
  onSetWorktreeDisplayName,
  onSessionNotificationEnabledChange,
  onCreateWorktreeForRepo,
  onSelectRepoGrid,
  onRemoveRepo,
  onSetRepoProfile,
  onSetWorktreeProfile,
  onOpenProfileManager,
}: SessionSectionListProps) {
  const { groupedItems } = useGroupedWorktreeItems(
    worktrees,
    sessions,
    repoList
  );
  const { held, bindings, onMenuOpenChange } = useListHold();
  const rows = useMemo(
    () =>
      toListRows(
        sectionize(
          sortSessionEntries(
            buildSessionEntries(
              groupedItems,
              sessionStatuses,
              sessionLastUpdatedAt
            )
          )
        )
      ),
    [groupedItems, sessionStatuses, sessionLastUpdatedAt]
  );
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

  const profileList = profiles ?? NO_PROFILES;
  const profileById = useMemo(
    () => new Map(profileList.map(profile => [profile.id, profile])),
    [profileList]
  );
  const multiProfileEnabled = capabilities?.multiProfileSupported === true;
  // プロファイルの項目は今と同じく、Linuxで管理ダイアログを開けるときだけ出す
  const canManageProfiles =
    multiProfileEnabled && onOpenProfileManager !== undefined;

  const buildMenu = (
    entry: SessionListEntry
  ): Omit<SessionRowMenuProps, "variant" | "entry"> => {
    const { session, worktree, repoPath } = entry;
    const worktreePath = worktreePathOf(entry);
    const worktreeProfileId = worktreePath
      ? (worktreeProfileLinks?.get(worktreePath) ?? null)
      : null;
    const repoProfileId = repoProfileLinks?.get(repoPath) ?? null;

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
      onStartRename:
        onSetWorktreeDisplayName && worktreePath
          ? () => setEditingKey(entry.key)
          : undefined,
      notifications:
        session && notificationsSupported && onSessionNotificationEnabledChange
          ? {
              enabled: isSessionNotificationEnabled?.(session.id) ?? true,
              onChange: enabled =>
                onSessionNotificationEnabledChange(session.id, enabled),
            }
          : undefined,
      onRestart:
        session && onRestartSession
          ? () => setRestartSessionId(session.id)
          : undefined,
      worktreeProfile:
        canManageProfiles && onSetWorktreeProfile && worktreePath
          ? {
              profiles: profileList,
              currentProfileId: worktreeProfileId,
              inheritedProfileName: repoProfileId
                ? (profileById.get(repoProfileId)?.name ?? null)
                : null,
              onSelect: profileId =>
                onSetWorktreeProfile(worktreePath, profileId),
            }
          : undefined,
      onCreateWorktree: onCreateWorktreeForRepo
        ? () => onCreateWorktreeForRepo(repoPath)
        : undefined,
      onOpenRepoGrid: onSelectRepoGrid
        ? () => onSelectRepoGrid(repoPath)
        : undefined,
      repoProfile:
        canManageProfiles && onSetRepoProfile
          ? {
              profiles: profileList,
              currentProfileId: repoProfileId,
              onSelect: profileId => onSetRepoProfile(repoPath, profileId),
            }
          : undefined,
      onOpenProfileManager: canManageProfiles
        ? onOpenProfileManager
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
        "mt-4 flex h-7 items-center gap-2 text-[13px] font-semibold text-muted-foreground first:mt-0",
        variant === "sidebar" ? "px-3" : "px-1"
      )}
    >
      <span>{SECTION_LABELS[row.section]}</span>
      {row.section === "your-turn" && row.count > 0 && (
        <span
          data-testid="section-count"
          className={cn(
            "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-bold text-background",
            TONE_CLASSES.awaiting.solidBg
          )}
        >
          {row.count}
        </span>
      )}
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
        previewText={
          entry.session ? (sessionPreviews.get(entry.session.id) ?? "") : ""
        }
        profile={resolveSessionRowProfile({
          enabled: multiProfileEnabled,
          worktreePath,
          repoPath: entry.repoPath,
          profileById,
          repoProfileLinks,
          worktreeProfileLinks,
        })}
        staleProfile={
          multiProfileEnabled && entry.session?.staleProfile === true
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
          variant === "sidebar" ? "gap-1" : "gap-2"
        )}
        {...bindings}
      >
        {visibleRows.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            <p>セッションがありません</p>
            <p className="mt-1 text-xs">「+」から新規作成</p>
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
                ? "Worktreeを削除"
                : "セッションを削除"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? deleteDescription(deleteTarget) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="h-12 md:h-10">
              キャンセル
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
              削除
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
            <AlertDialogTitle>セッションを再起動しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              このセッションを再起動するとClaude会話履歴・実行中コマンド・ターミナル内容がすべて失われます。続行しますか？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="h-12 md:h-10">
              キャンセル
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-12 md:h-10"
              onClick={() => {
                if (restartSessionId) onRestartSession?.(restartSessionId);
                setRestartSessionId(null);
              }}
            >
              再起動
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
            <AlertDialogTitle>リポジトリをサイドバーから除外</AlertDialogTitle>
            <AlertDialogDescription>
              {removeRepoPath
                ? `「${getBaseName(removeRepoPath)}」をサイドバー一覧から非表示にします。Worktreeやセッション、リポジトリ自体は削除されません。再度リポジトリを選択すれば復元できます。`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="h-12 md:h-10">
              キャンセル
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-12 md:h-10"
              onClick={() => {
                if (removeRepoPath) onRemoveRepo?.(removeRepoPath);
                setRemoveRepoPath(null);
              }}
            >
              除外
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
