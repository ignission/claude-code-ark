import { MessageSquare, MoreVertical, Play, Trash2 } from "lucide-react";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIsMobile } from "@/hooks/useMobile";
import type { ManagedSession, Worktree } from "../../../shared/types";

interface WorktreeContextMenuProps {
  children: React.ReactNode;
  worktree: Worktree;
  session: ManagedSession | undefined;
  onStartSession: (worktree: Worktree) => void;
  /** セッション削除（停止 + メイン以外のWorktree削除） */
  onDeleteSession: (sessionId: string, worktree: Worktree) => void;
  onSelectSession: (sessionId: string) => void;
  /** セッションなし状態でのWorktree単体削除 */
  onDeleteWorktree: (worktree: Worktree) => void;
}

export function WorktreeContextMenu({
  children,
  worktree,
  session,
  onStartSession,
  onDeleteSession,
  onSelectSession,
  onDeleteWorktree,
}: WorktreeContextMenuProps) {
  const isMobile = useIsMobile();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  // セッション有無で削除対象が変わる:
  // - セッションあり: stopSession + (メイン以外なら)deleteWorktree
  // - セッションなし(非mainのみ表示): deleteWorktreeのみ
  const hasSession = session !== undefined;
  const dialogTitle = hasSession ? "セッションを削除" : "Worktreeを削除";
  const dialogDescription = hasSession
    ? worktree.isMain
      ? "このセッションを削除しますか？メインWorktreeは削除されません。"
      : "このセッションとWorktreeを削除しますか？関連するブランチも削除されます。"
    : "このWorktreeを削除しますか？関連するブランチも削除されます。";

  const deleteDialog = (
    <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
      <AlertDialogContent className="bg-card border-border w-[calc(100%-2rem)] max-w-md mx-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>{dialogTitle}</AlertDialogTitle>
          <AlertDialogDescription>{dialogDescription}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
          <AlertDialogCancel className="h-12 md:h-10">
            キャンセル
          </AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90 h-12 md:h-10"
            onClick={() => {
              if (session) {
                onDeleteSession(session.id, worktree);
              } else {
                onDeleteWorktree(worktree);
              }
              setShowDeleteDialog(false);
            }}
          >
            削除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  if (isMobile) {
    return (
      <div className="flex items-center">
        <div className="flex-1 min-w-0">{children}</div>
        <div className="shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-10 w-10"
                aria-label="Worktree actions"
                onClick={e => e.stopPropagation()}
              >
                <MoreVertical className="w-5 h-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {session ? (
                <>
                  <DropdownMenuItem
                    onSelect={() => onSelectSession(session.id)}
                  >
                    <MessageSquare className="w-4 h-4 mr-2" />
                    セッションを開く
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onSelect={() => setShowDeleteDialog(true)}
                  >
                    <Trash2 className="w-4 h-4 mr-2" />
                    セッションを削除
                  </DropdownMenuItem>
                </>
              ) : (
                <>
                  <DropdownMenuItem onSelect={() => onStartSession(worktree)}>
                    <Play className="w-4 h-4 mr-2" />
                    セッションを開始
                  </DropdownMenuItem>
                  {!worktree.isMain && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onSelect={() => setShowDeleteDialog(true)}
                      >
                        <Trash2 className="w-4 h-4 mr-2" />
                        Worktreeを削除
                      </DropdownMenuItem>
                    </>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {deleteDialog}
      </div>
    );
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          {session ? (
            <>
              <ContextMenuItem onSelect={() => onSelectSession(session.id)}>
                <MessageSquare className="w-4 h-4 mr-2" />
                セッションを開く
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => setShowDeleteDialog(true)}
              >
                <Trash2 className="w-4 h-4 mr-2" />
                セッションを削除
              </ContextMenuItem>
            </>
          ) : (
            <>
              <ContextMenuItem onSelect={() => onStartSession(worktree)}>
                <Play className="w-4 h-4 mr-2" />
                セッションを開始
              </ContextMenuItem>
              {!worktree.isMain && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    className="text-destructive focus:text-destructive"
                    onSelect={() => setShowDeleteDialog(true)}
                  >
                    <Trash2 className="w-4 h-4 mr-2" />
                    Worktreeを削除
                  </ContextMenuItem>
                </>
              )}
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {deleteDialog}
    </>
  );
}
