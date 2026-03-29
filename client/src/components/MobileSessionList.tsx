/**
 * MobileSessionList - モバイル用セッション一覧画面
 *
 * ワークツリーをカード形式で表示し、セッションの開始・停止・オープンを操作する。
 * タップターゲットは最低48pxを確保。
 */

import {
  GitBranch,
  MessageSquare,
  MoreVertical,
  Play,
  Square,
  Trash2,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ManagedSession, Worktree } from "../../../shared/types";

interface MobileSessionListProps {
  sessions: Map<string, ManagedSession>;
  worktrees: Worktree[];
  repoName: string | null;
  onOpenSession: (sessionId: string) => void;
  onStartSession: (worktree: Worktree) => void;
  onStopSession: (sessionId: string) => void;
  onDeleteWorktree: (worktree: Worktree) => void;
}

export function MobileSessionList({
  sessions,
  worktrees,
  repoName,
  onOpenSession,
  onStartSession,
  onStopSession,
  onDeleteWorktree,
}: MobileSessionListProps) {
  const [deleteTarget, setDeleteTarget] = useState<Worktree | null>(null);
  const sessionByWorktreeId = useMemo(() => {
    const map = new Map<string, ManagedSession>();
    sessions.forEach(session => {
      map.set(session.worktreeId, session);
    });
    return map;
  }, [sessions]);

  const getSessionForWorktree = (worktreeId: string) => {
    return sessionByWorktreeId.get(worktreeId);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 safe-area-x">
      {/* リポジトリ名表示 */}
      {repoName && (
        <div className="px-4 py-2 border-b border-border/50">
          <span className="text-xs text-muted-foreground font-mono">
            {repoName}
          </span>
        </div>
      )}

      {/* ワークツリーリスト */}
      <div className="flex-1 overflow-y-auto min-h-0 p-4 space-y-3">
        {worktrees.map(worktree => {
          const session = getSessionForWorktree(worktree.id);
          return (
            <div
              key={worktree.id}
              className="bg-card border border-border rounded-lg p-4"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  {session && (
                    <div className={`status-indicator ${session.status}`} />
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
                <div className="shrink-0">
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
                        <>
                          <DropdownMenuItem
                            onSelect={() => onOpenSession(session.id)}
                          >
                            <MessageSquare className="w-4 h-4 mr-2" />
                            セッションを開く
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onSelect={() => onStopSession(session.id)}
                          >
                            <Square className="w-4 h-4 mr-2" />
                            セッションを停止
                          </DropdownMenuItem>
                        </>
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
        })}
        {worktrees.length === 0 && (
          <div className="text-center text-muted-foreground py-8">
            ワークツリーがありません
          </div>
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
