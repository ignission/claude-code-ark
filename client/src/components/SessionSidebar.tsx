/**
 * SessionSidebar - リポジトリ別にグルーピングしたセッション一覧サイドバー
 *
 * セッション一覧（SessionCard） + 新規作成「+」ボタンを提供。
 * リポジトリごとにヘッダーで区切って表示する。
 * worktree中心のイテレーション: セッション未起動のworktreeも表示する。
 *
 * 複数アカウント機能 (Linux限定):
 * - capabilities.multiAccountSupported === true のときのみ
 *   アカウントバッジ・staleAccount警告・再起動ボタン・右クリックメニュー追加項目を表示する
 * - false の場合は従来通りの挙動 (関連UI完全非表示)
 */

import {
  AlertTriangle,
  FolderOpen,
  Globe,
  Plus,
  RotateCw,
  Terminal,
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
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useGroupedWorktreeItems } from "@/hooks/useGroupedWorktreeItems";
import { getBaseName } from "@/utils/pathUtils";
import type {
  AccountProfile,
  ManagedSession,
  SystemCapabilities,
  Worktree,
} from "../../../shared/types";
import { badgeLabel, colorFor, RepoAccountMenu } from "./RepoAccountMenu";
import { SessionCard } from "./SessionCard";

interface SessionSidebarProps {
  sessions: Map<string, ManagedSession>;
  worktrees: Worktree[];
  repoList: string[];
  selectedSessionId: string | null;
  sessionPreviews: Map<string, string>;
  sessionActivityTexts: Map<string, string>;
  onSelectSession: (sessionId: string) => void;
  /** セッション削除（停止 + メイン以外のWorktree削除） */
  onDeleteSession: (sessionId: string, worktree: Worktree | undefined) => void;
  onStartSession: (worktree: Worktree) => void;
  onNewSession: () => void;
  /** リポジトリをサイドバー一覧から除外する */
  onRemoveRepo?: (repoPath: string) => void;
  /** ブラウザ選択コールバック（リモートアクセス時のみ使用） */
  onSelectBrowser?: () => void;
  /** ブラウザが選択中か */
  isBrowserSelected?: boolean;
  /** リモートアクセス中か */
  isRemote?: boolean;
  /** 複数アカウント機能用 (Linux限定) */
  accounts?: AccountProfile[];
  repoAccountLinks?: Map<string, string>;
  capabilities?: SystemCapabilities;
  onSetRepoAccount?: (
    repoPath: string,
    accountProfileId: string | null
  ) => void;
  onOpenAccountManager?: () => void;
  onRestartSession?: (sessionId: string) => void;
  /** リポジトリで新規Worktree作成を要求 */
  onCreateWorktreeForRepo?: (repoPath: string) => void;
}

export function SessionSidebar({
  sessions,
  worktrees,
  repoList,
  selectedSessionId,
  sessionPreviews,
  sessionActivityTexts,
  onSelectSession,
  onDeleteSession,
  onStartSession,
  onNewSession,
  onRemoveRepo,
  onSelectBrowser,
  isBrowserSelected = false,
  isRemote = false,
  accounts,
  repoAccountLinks,
  capabilities,
  onSetRepoAccount,
  onOpenAccountManager,
  onRestartSession,
  onCreateWorktreeForRepo,
}: SessionSidebarProps) {
  const { groupedItems } = useGroupedWorktreeItems(
    worktrees,
    sessions,
    repoList
  );

  // basename → repoPath の対応表（同名repoは衝突する点に注意。既存ロジックも同前提）
  const repoPathByName = useMemo(
    () => new Map(repoList.map(p => [getBaseName(p), p])),
    [repoList]
  );

  const [removeTargetRepoPath, setRemoveTargetRepoPath] = useState<
    string | null
  >(null);
  const [restartTargetSessionId, setRestartTargetSessionId] = useState<
    string | null
  >(null);

  const multiAccountEnabled = capabilities?.multiAccountSupported === true;
  const accountList = accounts ?? [];
  const accountById = useMemo(
    () => new Map(accountList.map(a => [a.id, a])),
    [accountList]
  );

  // リポジトリ行に表示するアカウントバッジを描画する
  const renderRepoAccountBadge = (repoPath: string | undefined) => {
    if (!multiAccountEnabled || !repoPath) return null;
    const linkedId = repoAccountLinks?.get(repoPath);
    if (linkedId) {
      const profile = accountById.get(linkedId);
      if (profile) {
        const colorClass = colorFor(profile.id);
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={`shrink-0 inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded border ${colorClass}`}
              >
                {badgeLabel(profile.name)}
              </span>
            </TooltipTrigger>
            <TooltipContent side="right">
              <div className="text-xs">
                <div className="font-medium">{profile.name}</div>
                <div className="opacity-70">{profile.configDir}</div>
              </div>
            </TooltipContent>
          </Tooltip>
        );
      }
    }
    // 紐付けなし: 既定バッジ
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded border bg-neutral-800 text-neutral-400 border-neutral-700">
            既定
          </span>
        </TooltipTrigger>
        <TooltipContent side="right">
          紐付けなし (~/.claude を使用)
        </TooltipContent>
      </Tooltip>
    );
  };

  // 古い設定 警告バッジ + 再起動ボタン
  const renderStaleAccountControls = (session: ManagedSession) => {
    if (!multiAccountEnabled || session.staleAccount !== true) return null;
    return (
      <div className="flex items-center gap-1 px-2 pb-1.5 pl-7">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border bg-amber-500/10 text-amber-400 border-amber-500/30">
              <AlertTriangle className="w-3 h-3" />
              古い設定
            </span>
          </TooltipTrigger>
          <TooltipContent side="right">
            リポジトリのアカウント紐付けが変更されました。このセッションは元の設定で動作中です
          </TooltipContent>
        </Tooltip>
        {onRestartSession && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[10px] gap-1 text-amber-400 hover:text-amber-300 hover:bg-amber-500/10"
            onClick={() => setRestartTargetSessionId(session.id)}
          >
            <RotateCw className="w-3 h-3" />
            再起動
          </Button>
        )}
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col bg-sidebar">
      {/* ヘッダー */}
      <div className="h-12 border-b border-sidebar-border flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-primary" />
          <h1 className="font-semibold text-sm text-sidebar-foreground">Ark</h1>
        </div>
        <div className="flex items-center gap-1">
          {isRemote && onSelectBrowser && (
            <Button
              variant={isBrowserSelected ? "default" : "ghost"}
              size="icon"
              className="h-8 w-8"
              onClick={onSelectBrowser}
              aria-label={
                isBrowserSelected ? "ブラウザを選択中" : "ブラウザを開く"
              }
              aria-pressed={isBrowserSelected}
              title="ブラウザ"
            >
              <Globe className="w-4 h-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onNewSession}
            aria-label="新規セッション"
            title="新規セッション"
          >
            <Plus className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* セッション一覧 */}
      <ScrollArea className="flex-1">
        <div className="p-2">
          {sessions.size === 0 && worktrees.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">
              <Terminal className="w-8 h-8 mx-auto mb-3 opacity-50" />
              <p>セッションがありません</p>
              <p className="text-xs mt-1">「+」から新規作成</p>
            </div>
          ) : (
            Array.from(groupedItems.entries()).map(([repoName, items]) => {
              const repoPath = repoPathByName.get(repoName);
              const canRemove = !!onRemoveRepo && !!repoPath;
              const currentLinkId = repoPath
                ? (repoAccountLinks?.get(repoPath) ?? null)
                : null;
              const showAccountSubmenu =
                multiAccountEnabled &&
                !!repoPath &&
                !!onSetRepoAccount &&
                !!onOpenAccountManager;
              const canCreateWorktree = !!onCreateWorktreeForRepo && !!repoPath;
              // Worktree作成 / アカウント変更 / サイドバーから除外
              // のいずれかが可能なら repoヘッダに ContextMenu を付ける
              const showRepoContextMenu =
                !!repoPath &&
                (canCreateWorktree || showAccountSubmenu || canRemove);

              const repoHeader = (
                <div className="sticky left-0 flex items-center gap-1.5 px-2 py-1.5">
                  <FolderOpen className="w-3 h-3 text-muted-foreground shrink-0" />
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider truncate">
                    {repoName}
                  </span>
                  {renderRepoAccountBadge(repoPath)}
                  {canCreateWorktree && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 shrink-0 ml-auto text-sidebar-foreground/70 hover:text-foreground hover:bg-sidebar-accent"
                      onClick={() => onCreateWorktreeForRepo?.(repoPath)}
                      aria-label={`${repoName} に新規Worktreeを作成`}
                      title="新規Worktreeを作成"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </Button>
                  )}
                  {canRemove && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className={`h-5 w-5 shrink-0 ${canCreateWorktree ? "" : "ml-auto"} text-sidebar-foreground/70 hover:text-destructive hover:bg-destructive/15`}
                      onClick={() => setRemoveTargetRepoPath(repoPath)}
                      aria-label={`${repoName} をサイドバーから除外`}
                      title="サイドバーから除外"
                    >
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
              );

              return (
                <div key={repoName} className="mb-3">
                  {/* リポジトリヘッダー (右クリックでアクションメニュー) */}
                  {showRepoContextMenu && repoPath ? (
                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        {repoHeader}
                      </ContextMenuTrigger>
                      <ContextMenuContent className="w-56">
                        {canCreateWorktree && (
                          <>
                            <ContextMenuItem
                              onSelect={() =>
                                onCreateWorktreeForRepo?.(repoPath)
                              }
                            >
                              <Plus className="w-3.5 h-3.5 mr-2" />
                              新規Worktreeを作成
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                          </>
                        )}
                        {showAccountSubmenu && (
                          <>
                            <ContextMenuSub>
                              <ContextMenuSubTrigger>
                                アカウントを変更
                              </ContextMenuSubTrigger>
                              <ContextMenuSubContent className="w-56">
                                <RepoAccountMenu
                                  accounts={accountList}
                                  currentAccountId={currentLinkId}
                                  onSelect={profileId =>
                                    onSetRepoAccount?.(repoPath, profileId)
                                  }
                                  onOpenManager={() => onOpenAccountManager?.()}
                                />
                              </ContextMenuSubContent>
                            </ContextMenuSub>
                            {canRemove && <ContextMenuSeparator />}
                          </>
                        )}
                        {canRemove && (
                          <ContextMenuItem
                            onSelect={() => setRemoveTargetRepoPath(repoPath)}
                          >
                            <X className="w-3.5 h-3.5 mr-2" />
                            サイドバーから除外
                          </ContextMenuItem>
                        )}
                      </ContextMenuContent>
                    </ContextMenu>
                  ) : (
                    repoHeader
                  )}
                  {/* アイテム一覧 */}
                  <div className="space-y-1">
                    {items.map(({ worktree: wt, session }) => (
                      <div key={session?.id ?? wt?.id ?? "unknown"}>
                        <SessionCard
                          session={session}
                          worktree={wt ?? undefined}
                          repoList={repoList}
                          isSelected={
                            session ? selectedSessionId === session.id : false
                          }
                          previewText={
                            session ? sessionPreviews.get(session.id) || "" : ""
                          }
                          activityText={
                            session
                              ? sessionActivityTexts.get(session.id) || ""
                              : ""
                          }
                          onClick={() => session && onSelectSession(session.id)}
                          onDelete={() =>
                            session &&
                            onDeleteSession(session.id, wt ?? undefined)
                          }
                          onStart={() => (wt ? onStartSession(wt) : undefined)}
                        />
                        {session && renderStaleAccountControls(session)}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>

      <AlertDialog
        open={removeTargetRepoPath !== null}
        onOpenChange={open => {
          if (!open) setRemoveTargetRepoPath(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>リポジトリをサイドバーから除外</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTargetRepoPath
                ? `「${getBaseName(removeTargetRepoPath)}」をサイドバー一覧から非表示にします。Worktreeやセッション、リポジトリ自体は削除されません。再度リポジトリを選択すれば復元できます。`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (removeTargetRepoPath && onRemoveRepo) {
                  onRemoveRepo(removeTargetRepoPath);
                }
                setRemoveTargetRepoPath(null);
              }}
            >
              除外
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* セッション再起動 確認ダイアログ (staleAccount対応) */}
      <AlertDialog
        open={restartTargetSessionId !== null}
        onOpenChange={open => {
          if (!open) setRestartTargetSessionId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>セッションを再起動しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              このセッションを再起動するとClaude会話履歴・実行中コマンド・ターミナル内容がすべて失われます。続行しますか？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (restartTargetSessionId && onRestartSession) {
                  onRestartSession(restartTargetSessionId);
                }
                setRestartTargetSessionId(null);
              }}
            >
              再起動
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
