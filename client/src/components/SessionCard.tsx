import { MessageSquare, Square, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { ManagedSession, Worktree } from "../../../shared/types";

/** プレビュー無変化でアイドル判定するまでの秒数 */
const IDLE_THRESHOLD_MS = 10_000;

interface SessionCardProps {
  session: ManagedSession;
  worktree: Worktree | undefined;
  repoList: string[];
  isSelected: boolean;
  previewText: string;
  activityText: string;
  onClick: () => void;
  onStop: () => void;
  onDeleteWorktree: () => void;
}

export function SessionCard({
  session,
  worktree,
  isSelected,
  previewText,
  activityText,
  onClick,
  onStop,
  onDeleteWorktree,
}: SessionCardProps) {
  const branch =
    worktree?.branch ||
    session.worktreePath.substring(session.worktreePath.lastIndexOf("/") + 1);

  // プレビュー/アクティビティの変化を追跡してアイドル判定
  const prevTextRef = useRef(previewText);
  const prevActivityRef = useRef(activityText);
  const lastChangedRef = useRef(Date.now());
  const [isIdle, setIsIdle] = useState(false);

  useEffect(() => {
    if (
      previewText !== prevTextRef.current ||
      activityText !== prevActivityRef.current
    ) {
      prevTextRef.current = previewText;
      prevActivityRef.current = activityText;
      lastChangedRef.current = Date.now();
      setIsIdle(false);
    }
  }, [previewText, activityText]);

  useEffect(() => {
    const timer = setInterval(() => {
      const elapsed = Date.now() - lastChangedRef.current;
      setIsIdle(elapsed >= IDLE_THRESHOLD_MS);
    }, 2000);
    return () => clearInterval(timer);
  }, []);

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  // ✢✻はどちらもClaude Codeの動作中アニメーション記号
  const hasActivitySymbol = /[✢✻]/.test(activityText);

  // 緑: 動作中（✢✻+変化あり）、青: 起動直後//clear後（コンテンツなし）、赤: それ以外
  const dotColor =
    hasActivitySymbol && !isIdle
      ? "bg-green-500"
      : session.status === "idle" && !hasActivitySymbol
        ? "bg-blue-500"
        : "bg-red-500";

  // アイドル時はactivityText（✻ Baked for ...）、アクティブ時はコンテンツ行
  const idle = session.status === "idle" || isIdle;
  const displayText = idle && activityText ? activityText : previewText;

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            className={`w-full text-left p-3 rounded-lg transition-colors group ${
              isSelected
                ? "bg-primary/15 border border-primary/30"
                : "hover:bg-sidebar-accent/50"
            }`}
            onClick={onClick}
          >
            <div className="flex items-center gap-2 min-w-0">
              <div className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
              <span className="text-sm font-mono truncate text-sidebar-foreground">
                {branch}
              </span>
              {isSelected && (
                <span className="ml-auto text-xs text-primary shrink-0">◀</span>
              )}
            </div>
            {displayText && (
              <p className="mt-1 text-xs text-muted-foreground truncate pl-4">
                {displayText}
              </p>
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuItem onSelect={onClick}>
            <MessageSquare className="w-4 h-4 mr-2" />
            セッションを開く
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={onStop}
          >
            <Square className="w-4 h-4 mr-2" />
            セッションを停止
          </ContextMenuItem>
          {worktree?.isMain !== true && (
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
                onDeleteWorktree();
                setShowDeleteDialog(false);
              }}
            >
              削除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
