/**
 * SessionSidebar - リポジトリ別にグルーピングしたセッション一覧サイドバー
 *
 * セッション一覧（SessionCard） + 新規作成「+」ボタンを提供。
 * リポジトリごとにヘッダーで区切って表示する。
 * worktree中心のイテレーション: セッション未起動のworktreeも表示する。
 *
 * プロファイル切替機能 (Linux限定):
 * - capabilities.multiProfileSupported === true のときのみ
 *   プロファイルバッジ・staleProfile警告・再起動ボタン・右クリックメニュー追加項目を表示する
 * - false の場合は従来通りの挙動 (関連UI完全非表示)
 */

import type {
  BridgeSessionStatus,
  ManagedSession,
  Profile,
  SystemCapabilities,
  Worktree,
} from "@ark/shared";
import {
  AlertTriangle,
  Check,
  FolderOpen,
  Globe,
  MoreVertical,
  Plus,
  RotateCw,
  Settings,
  Terminal,
  X,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
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
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useGroupedWorktreeItems } from "@/hooks/useGroupedWorktreeItems";
import { getBaseName } from "@/utils/pathUtils";
import { badgeLabel, colorFor, RepoProfileMenu } from "./RepoProfileMenu";
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
  /** プロファイル切替機能用 (Linux限定) */
  profiles?: Profile[];
  repoProfileLinks?: Map<string, string>;
  /** worktreePath → profileId の個別override (worktree個別が優先) */
  worktreeProfileLinks?: Map<string, string>;
  capabilities?: SystemCapabilities;
  onSetRepoProfile?: (repoPath: string, profileId: string | null) => void;
  onSetWorktreeProfile?: (
    worktreePath: string,
    profileId: string | null
  ) => void;
  /** worktreePath → カスタム表示名 (未設定なら branch にフォールバック) */
  worktreeDisplayNames?: Map<string, string>;
  onSetWorktreeDisplayName?: (
    worktreePath: string,
    displayName: string | null
  ) => void;
  onOpenProfileManager?: () => void;
  onRestartSession?: (sessionId: string) => void;
  /** リポジトリで新規Worktree作成を要求 */
  onCreateWorktreeForRepo?: (repoPath: string) => void;
  /** リポジトリヘッダクリック時: メイン領域をセッショングリッドビューに切替える */
  onSelectRepoGrid?: (repoPath: string) => void;
  /** 現在グリッド表示中のリポジトリパス（ヘッダのハイライト判定用） */
  gridRepoPath?: string | null;
  /**
   * 各セッションの BridgeSessionStatus スナップショット (sessionId → status)。
   * SessionCard のドット色を統一するために渡す。
   * 未設定 (Map empty) の場合は SessionCard 側のフォールバック判定が使われる。
   */
  gridStatuses?: Map<string, BridgeSessionStatus>;
  notificationControl?: ReactNode;
  notificationsSupported?: boolean;
  isSessionNotificationEnabled?: (sessionId: string) => boolean;
  onSessionNotificationEnabledChange?: (
    sessionId: string,
    enabled: boolean
  ) => void;
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
  profiles,
  repoProfileLinks,
  worktreeProfileLinks,
  capabilities,
  onSetRepoProfile,
  onSetWorktreeProfile,
  worktreeDisplayNames,
  onSetWorktreeDisplayName,
  onOpenProfileManager,
  onRestartSession,
  onCreateWorktreeForRepo,
  onSelectRepoGrid,
  gridRepoPath,
  gridStatuses,
  notificationControl,
  notificationsSupported = false,
  isSessionNotificationEnabled,
  onSessionNotificationEnabledChange,
}: SessionSidebarProps) {
  const { groupedItems } = useGroupedWorktreeItems(
    worktrees,
    sessions,
    repoList
  );

  const [removeTargetRepoPath, setRemoveTargetRepoPath] = useState<
    string | null
  >(null);
  const [restartTargetSessionId, setRestartTargetSessionId] = useState<
    string | null
  >(null);

  const multiProfileEnabled = capabilities?.multiProfileSupported === true;
  const profileList = profiles ?? [];
  const profileById = useMemo(
    () => new Map(profileList.map(a => [a.id, a])),
    [profileList]
  );

  // リポジトリヘッダのプロファイルキャプション。
  // ピル型バッジではなく "・ デフォルト: KB2" のような小さなテキストで表示し、
  // worktree 側のピル型バッジと視覚的に区別する。
  // クリックでプロファイル選択ドロップダウンを開ける (3点リーダーからは撤去済)。
  const renderRepoProfileCaption = (repoPath: string | undefined) => {
    if (!multiProfileEnabled || !repoPath) return null;
    const linkedId = repoProfileLinks?.get(repoPath) ?? null;
    const profile = linkedId ? profileById.get(linkedId) : undefined;
    const labelText = profile ? profile.name : "既定 (~/.claude)";
    const canChange = !!onSetRepoProfile && !!onOpenProfileManager;

    const caption = (
      <span className="shrink-0 normal-case text-[11px] text-muted-foreground/80">
        <span className="mr-1">・</span>
        デフォルト: <span className="text-foreground/80">{labelText}</span>
      </span>
    );

    if (!canChange) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>{caption}</TooltipTrigger>
          <TooltipContent side="right">
            {profile
              ? `${profile.name} (${profile.configDir})`
              : "紐付けなし (~/.claude を使用)"}
          </TooltipContent>
        </Tooltip>
      );
    }

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="shrink-0 normal-case text-[11px] text-muted-foreground/80 hover:text-foreground transition-colors"
            title={
              profile
                ? `リポジトリのデフォルトプロファイル: ${profile.name} (クリックで変更)`
                : "リポジトリのデフォルトプロファイル: 既定 (~/.claude) (クリックで変更)"
            }
          >
            <span className="mr-1">・</span>
            デフォルト: <span className="text-foreground/80">{labelText}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <RepoProfileMenu
            variant="dropdown"
            profiles={profileList}
            currentProfileId={linkedId}
            onSelect={profileId => onSetRepoProfile?.(repoPath, profileId)}
            onOpenManager={() => onOpenProfileManager?.()}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  // SessionCard のステータスドット隣に差し込むプロファイル切替バッジ。
  // worktree個別が未設定なら repoデフォルトを継承して同じ色で表示し、
  // worktree個別が指定されている場合のみ末尾に `*` を表示する。
  const renderProfileBadgeSlot = (
    session: ManagedSession | null,
    worktree: Worktree | undefined,
    repoPath: string | undefined
  ) => {
    if (!multiProfileEnabled) return null;
    if (!onSetWorktreeProfile || !onOpenProfileManager) return null;
    const wtPath = worktree?.path ?? session?.worktreePath ?? null;
    if (!wtPath) return null;

    const wtLinkedId = worktreeProfileLinks?.get(wtPath) ?? null;
    const effectiveRepoPath = repoPath ?? session?.repoPath ?? null;
    const repoLinkedId = effectiveRepoPath
      ? (repoProfileLinks?.get(effectiveRepoPath) ?? null)
      : null;
    const effectiveProfileId = wtLinkedId ?? repoLinkedId;
    const effectiveProfile = effectiveProfileId
      ? profileById.get(effectiveProfileId)
      : undefined;

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            onClick={e => e.stopPropagation()}
            onKeyDown={e => e.stopPropagation()}
            className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-medium rounded border transition-colors shrink-0 ${
              effectiveProfile
                ? colorFor(effectiveProfile.id)
                : "bg-neutral-800 text-neutral-400 border-neutral-700 hover:bg-neutral-700"
            }`}
            title={
              effectiveProfile
                ? `プロファイル: ${effectiveProfile.name}${
                    wtLinkedId ? "" : "（リポジトリのデフォルト）"
                  }`
                : "プロファイル: 既定 (~/.claude)"
            }
          >
            {effectiveProfile ? badgeLabel(effectiveProfile.name) : "既定"}
            {wtLinkedId && (
              <span className="opacity-70" title="worktree個別設定">
                *
              </span>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            プロファイル
          </DropdownMenuLabel>
          {profileList.map(profile => {
            const isCurrent = wtLinkedId === profile.id;
            return (
              <DropdownMenuItem
                key={profile.id}
                onSelect={() => onSetWorktreeProfile?.(wtPath, profile.id)}
                className="flex items-center justify-between gap-2"
              >
                <span className="flex items-center gap-2 min-w-0">
                  {isCurrent ? (
                    <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  ) : (
                    <span className="w-3.5 h-3.5 shrink-0" aria-hidden />
                  )}
                  <span className="truncate">{profile.name}</span>
                </span>
                <span
                  className={`shrink-0 inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded border ${colorFor(profile.id)}`}
                >
                  {badgeLabel(profile.name)}
                </span>
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          {/*
           * リポジトリにデフォルトが設定されている場合は「リポジトリの
           * デフォルトに従う」を表示する。実 effective profile 名を
           * 添えてバッジ表示と一致させる。worktree override が無い時の
           * チェックはこの項目に付く。
           * 設定されていない場合は従来通り「既定 (~/.claude)」とする。
           */}
          {repoLinkedId && profileById.has(repoLinkedId) ? (
            <DropdownMenuItem
              onSelect={() => onSetWorktreeProfile?.(wtPath, null)}
              className="flex items-center justify-between gap-2"
            >
              <span className="flex items-center gap-2 min-w-0">
                {wtLinkedId === null ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                ) : (
                  <span className="w-3.5 h-3.5 shrink-0" aria-hidden />
                )}
                <span className="truncate text-muted-foreground">
                  リポジトリのデフォルトに従う
                </span>
              </span>
              <span
                className={`shrink-0 inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded border ${colorFor(repoLinkedId)}`}
              >
                {badgeLabel(profileById.get(repoLinkedId)?.name ?? "")}
              </span>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onSelect={() => onSetWorktreeProfile?.(wtPath, null)}
              className="flex items-center gap-2"
            >
              {wtLinkedId === null ? (
                <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              ) : (
                <span className="w-3.5 h-3.5 shrink-0" aria-hidden />
              )}
              <span className="truncate text-muted-foreground">
                既定 (~/.claude)
              </span>
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => onOpenProfileManager?.()}
            className="flex items-center gap-2"
          >
            <Settings className="w-3.5 h-3.5" />
            <span>プロファイル管理を開く...</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  // 古い設定 警告バッジ + 再起動ボタン (SessionCard の下に表示)
  const renderStaleProfileControls = (session: ManagedSession) => {
    if (!multiProfileEnabled || session.staleProfile !== true) return null;
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
            プロファイル紐付けが変更されました。このセッションは元の設定で動作中です
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
          {notificationControl}
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

      {/* セッション一覧。
          Radix ScrollArea を使うと Viewport の中に display: table の
          無 class ラッパーが挟まり、子要素 (input 等) が想定外に広がると
          ラッパーが content-size で膨らんで Viewport が水平スクロール状態に
          なる (`overflow-x: hidden` は Viewport に効いても scrollLeft が
          焼き付き、確定後に左端を戻せない)。Radix 経由を諦めて素直な div の
          縦スクロール + `overflow-x: hidden` で完全に水平拡張を抑止する。 */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <div className="p-2 overflow-x-hidden">
          {sessions.size === 0 && worktrees.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">
              <Terminal className="w-8 h-8 mx-auto mb-3 opacity-50" />
              <p>セッションがありません</p>
              <p className="text-xs mt-1">「+」から新規作成</p>
            </div>
          ) : (
            Array.from(groupedItems.entries()).map(([repoPath, group]) => {
              const { repoName, disambiguator, items } = group;
              const canRemove = !!onRemoveRepo;
              const canCreateWorktree = !!onCreateWorktreeForRepo;
              // 三点リーダー / 右クリックメニューは「Worktreeを作成」「サイドバーから除外」のみ。
              // プロファイル変更はリポジトリヘッダのバッジクリックに集約済み。
              const showRepoContextMenu = canCreateWorktree || canRemove;

              const repoHeader = (
                <div className="sticky left-0 flex items-center gap-1.5 px-2 py-1.5">
                  {showRepoContextMenu ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground hover:bg-sidebar-accent"
                          aria-label={`${repoName} のメニュー`}
                          title="メニュー"
                        >
                          <MoreVertical className="w-3.5 h-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-56">
                        {canCreateWorktree && (
                          <DropdownMenuItem
                            onSelect={() => onCreateWorktreeForRepo?.(repoPath)}
                          >
                            <Plus className="w-3.5 h-3.5 mr-2" />
                            新規Worktreeを作成
                          </DropdownMenuItem>
                        )}
                        {canCreateWorktree && canRemove && (
                          <DropdownMenuSeparator />
                        )}
                        {canRemove && (
                          <DropdownMenuItem
                            onSelect={() => setRemoveTargetRepoPath(repoPath)}
                          >
                            <X className="w-3.5 h-3.5 mr-2" />
                            サイドバーから除外
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : (
                    <FolderOpen className="w-3 h-3 text-muted-foreground shrink-0" />
                  )}
                  {onSelectRepoGrid ? (
                    <button
                      type="button"
                      onClick={() => onSelectRepoGrid(repoPath)}
                      className={`text-xs font-medium uppercase tracking-wider truncate text-left hover:text-foreground transition-colors ${
                        gridRepoPath === repoPath
                          ? "text-foreground"
                          : "text-muted-foreground"
                      }`}
                      title={`${repoPath} (クリックでセッション一覧)`}
                    >
                      {repoName}
                      {disambiguator && (
                        <span className="ml-1 text-muted-foreground/70 normal-case">
                          ({disambiguator})
                        </span>
                      )}
                    </button>
                  ) : (
                    <span
                      className="text-xs font-medium text-muted-foreground uppercase tracking-wider truncate"
                      title={repoPath}
                    >
                      {repoName}
                      {disambiguator && (
                        <span className="ml-1 text-muted-foreground/70 normal-case">
                          ({disambiguator})
                        </span>
                      )}
                    </span>
                  )}
                  {renderRepoProfileCaption(repoPath)}
                </div>
              );

              return (
                <div key={repoPath} className="mb-3">
                  {/* リポジトリヘッダー (右クリックでアクションメニュー) */}
                  {showRepoContextMenu ? (
                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        {repoHeader}
                      </ContextMenuTrigger>
                      <ContextMenuContent className="w-56">
                        {canCreateWorktree && (
                          <ContextMenuItem
                            onSelect={() => onCreateWorktreeForRepo?.(repoPath)}
                          >
                            <Plus className="w-3.5 h-3.5 mr-2" />
                            新規Worktreeを作成
                          </ContextMenuItem>
                        )}
                        {canCreateWorktree && canRemove && (
                          <ContextMenuSeparator />
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
                          gridStatus={
                            session ? gridStatuses?.get(session.id) : undefined
                          }
                          onClick={() => session && onSelectSession(session.id)}
                          onDelete={() =>
                            session &&
                            onDeleteSession(session.id, wt ?? undefined)
                          }
                          onRestart={
                            session && onRestartSession
                              ? () => setRestartTargetSessionId(session.id)
                              : undefined
                          }
                          onStart={() => (wt ? onStartSession(wt) : undefined)}
                          profileBadgeSlot={renderProfileBadgeSlot(
                            session,
                            wt ?? undefined,
                            repoPath
                          )}
                          customDisplayName={(() => {
                            const wtPath =
                              wt?.path ?? session?.worktreePath ?? null;
                            return wtPath
                              ? (worktreeDisplayNames?.get(wtPath) ?? null)
                              : null;
                          })()}
                          onSetCustomDisplayName={
                            onSetWorktreeDisplayName
                              ? (name: string | null) => {
                                  const wtPath =
                                    wt?.path ?? session?.worktreePath ?? null;
                                  if (wtPath) {
                                    onSetWorktreeDisplayName(wtPath, name);
                                  }
                                }
                              : undefined
                          }
                          notificationsSupported={notificationsSupported}
                          notificationsEnabled={
                            session
                              ? (isSessionNotificationEnabled?.(session.id) ??
                                true)
                              : true
                          }
                          onNotificationsEnabledChange={
                            session && onSessionNotificationEnabledChange
                              ? enabled =>
                                  onSessionNotificationEnabledChange(
                                    session.id,
                                    enabled
                                  )
                              : undefined
                          }
                        />
                        {session && renderStaleProfileControls(session)}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

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

      {/* セッション再起動 確認ダイアログ (コンテキストメニュー / staleProfile 警告の両方から開く) */}
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
