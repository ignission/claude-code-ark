import {
  MessageSquare,
  MoreVertical,
  Play,
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
  onStopSession: (sessionId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteWorktree: (worktree: Worktree) => void;
}

export function WorktreeContextMenu({
  children,
  worktree,
  session,
  onStartSession,
  onStopSession,
  onSelectSession,
  onDeleteWorktree,
}: WorktreeContextMenuProps) {
  const isMobile = useIsMobile();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const deleteDialog = (
    <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
      <AlertDialogContent className="bg-card border-border w-[calc(100%-2rem)] max-w-md mx-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>Worktreeを削除</AlertDialogTitle>
          <AlertDialogDescription>
            このWorktreeを削除しますか？関連するブランチも削除されます。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
          <AlertDialogCancel className="h-12 md:h-10">
            キャンセル
          </AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90 h-12 md:h-10"
            onClick={() => {
              onDeleteWorktree(worktree);
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
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onSelect={() => onStopSession(session.id)}
                  >
                    <Square className="w-4 h-4 mr-2" />
                    セッションを停止
                  </DropdownMenuItem>
                </>
              ) : (
                <DropdownMenuItem onSelect={() => onStartSession(worktree)}>
                  <Play className="w-4 h-4 mr-2" />
                  セッションを開始
                </DropdownMenuItem>
              )}
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
              <ContextMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => onStopSession(session.id)}
              >
                <Square className="w-4 h-4 mr-2" />
                セッションを停止
              </ContextMenuItem>
            </>
          ) : (
            <ContextMenuItem onSelect={() => onStartSession(worktree)}>
              <Play className="w-4 h-4 mr-2" />
              セッションを開始
            </ContextMenuItem>
          )}
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
        </ContextMenuContent>
      </ContextMenu>
      {deleteDialog}
    </>
  );
}
