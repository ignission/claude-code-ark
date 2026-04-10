/**
 * MobileSessionList - モバイル用セッション一覧画面
 *
 * ワークツリーをリポジトリ別にグルーピングしてカード形式で表示する。
 * PC版SessionSidebarと同じグルーピングロジックを使用。
 * タップターゲットは最低48pxを確保。
 */

import {
  FolderOpen,
  GitBranch,
  MoreVertical,
  Play,
  Plus,
  Square,
  Trash2,
} from "lucide-react";
import { useState } from "react";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useGroupedWorktreeItems } from "@/hooks/useGroupedWorktreeItems";
import { getBaseName } from "@/utils/pathUtils";
import type { ManagedSession, Worktree } from "../../../shared/types";

interface MobileSessionListProps {
  sessions: Map<string, ManagedSession>;
  worktrees: Worktree[];
  repoList: string[];
  onOpenSession: (sessionId: string) => void;
  onStartSession: (worktree: Worktree) => void;
  onStopSession: (sessionId: string) => void;
  onDeleteWorktree: (worktree: Worktree) => void;
  onNewSession: () => void;
}

export function MobileSessionList({
  sessions,
  worktrees,
  repoList,
  onOpenSession,
  onStartSession,
  onStopSession,
  onDeleteWorktree,
  onNewSession,
}: MobileSessionListProps) {
  const [deleteTarget, setDeleteTarget] = useState<Worktree | null>(null);
  const { groupedItems } = useGroupedWorktreeItems(
    worktrees,
    sessions,
    repoList
  );

  return (
    <div className="flex-1 flex flex-col min-h-0 safe-area-x">
      {/* ヘッダー: +ボタンのみ（repoNameはグループヘッダーに移動） */}
      <div className="px-4 py-2 border-b border-border/50 flex items-center justify-between">
        <span className="text-sm font-semibold text-sidebar-foreground">
          Ark
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-12 w-12"
          onClick={onNewSession}
          title="新規セッション"
        >
          <Plus className="w-4 h-4" />
        </Button>
      </div>

      {/* リポジトリ別グルーピングリスト */}
      <div className="flex-1 overflow-y-auto min-h-0 p-4 space-y-4">
        {groupedItems.size === 0 ? (
          <div className="text-center text-muted-foreground py-8">
            ワークツリーがありません
          </div>
        ) : (
          Array.from(groupedItems.entries()).map(([repoName, items]) => (
            <div key={repoName}>
              {/* リポジトリヘッダー（PC版SessionSidebarと同じFolderOpenアイコン付き） */}
              <div className="flex items-center gap-1.5 px-1 py-1.5 mb-2">
                <FolderOpen className="w-3 h-3 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider truncate">
                  {repoName}
                </span>
              </div>
              {/* アイテム一覧 */}
              <div className="space-y-3">
                {items.map(({ worktree, session }) => {
                  // worktreeがあるアイテム
                  if (worktree) {
                    return (
                      <div
                        key={worktree.id}
                        className="bg-card border border-border rounded-lg p-4 active:bg-accent/50 transition-colors"
                        onClick={() =>
                          session
                            ? onOpenSession(session.id)
                            : onStartSession(worktree)
                        }
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 min-w-0">
                            {session && (
                              <div
                                className={`status-indicator ${session.status}`}
                              />
                            )}
                            <GitBranch className="w-4 h-4 text-muted-foreground shrink-0" />
                            <span className="font-mono text-sm truncate">
                              {worktree.branch}
                            </span>
                            {worktree.isMain && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/20 text-primary uppercase">
                                main
                              </span>
                            )}
                          </div>
                          <div
                            className="shrink-0"
                            onClick={e => e.stopPropagation()}
                          >
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-10 w-10"
                                  aria-label="Worktree actions"
                                >
                                  <MoreVertical className="w-5 h-5" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-48">
                                {session ? (
                                  <DropdownMenuItem
                                    className="text-destructive focus:text-destructive"
                                    onSelect={() => onStopSession(session.id)}
                                  >
                                    <Square className="w-4 h-4 mr-2" />
                                    セッションを停止
                                  </DropdownMenuItem>
                                ) : (
                                  <DropdownMenuItem
                                    onSelect={() => onStartSession(worktree)}
                                  >
                                    <Play className="w-4 h-4 mr-2" />
                                    セッションを開始
                                  </DropdownMenuItem>
                                )}
                                {!worktree.isMain && (
                                  <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      className="text-destructive focus:text-destructive"
                                      onSelect={() => setDeleteTarget(worktree)}
                                    >
                                      <Trash2 className="w-4 h-4 mr-2" />
                                      Worktreeを削除
                                    </DropdownMenuItem>
                                  </>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </div>
                      </div>
                    );
                  }
                  // worktreeがない他リポのセッション
                  if (!session) return null;
                  return (
                    <div
                      key={session?.id}
                      className="bg-card border border-border rounded-lg p-4 active:bg-accent/50 transition-colors"
                      onClick={() => onOpenSession(session?.id)}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 min-w-0">
                          <div
                            className={`status-indicator ${session?.status}`}
                          />
                          <GitBranch className="w-4 h-4 text-muted-foreground shrink-0" />
                          <span className="font-mono text-sm truncate">
                            {getBaseName(session?.worktreePath)}
                          </span>
                        </div>
                        <div
                          className="shrink-0"
                          onClick={e => e.stopPropagation()}
                        >
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-10 w-10"
                                aria-label="Session actions"
                              >
                                <MoreVertical className="w-5 h-5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-48">
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onSelect={() => onStopSession(session?.id)}
                              >
                                <Square className="w-4 h-4 mr-2" />
                                セッションを停止
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={open => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent className="bg-card border-border w-[calc(100%-2rem)] max-w-md mx-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>Worktreeを削除</AlertDialogTitle>
            <AlertDialogDescription>
              このWorktreeを削除しますか？関連するブランチも削除されます。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="h-12">キャンセル</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 h-12"
              onClick={() => {
                if (deleteTarget) onDeleteWorktree(deleteTarget);
                setDeleteTarget(null);
              }}
            >
              削除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
