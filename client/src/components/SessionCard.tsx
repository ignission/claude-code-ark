import { MessageSquare, Trash2 } from "lucide-react";
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
  session: ManagedSession | null;
  worktree: Worktree | undefined;
  repoList: string[];
  isSelected: boolean;
  previewText: string;
  activityText: string;
  onClick: () => void;
  /** セッション削除（停止 + メイン以外のWorktree削除） */
  onDelete: () => void;
  onStart?: () => void;
}

export function SessionCard({
  session,
  worktree,
  isSelected,
  previewText,
  activityText,
  onClick,
  onDelete,
  onStart,
}: SessionCardProps) {
  const branch =
    worktree?.branch ||
    (session
      ? session.worktreePath.substring(
          session.worktreePath.lastIndexOf("/") + 1
        )
      : "unknown");

  // プレビュー/アクティビティの変化を追跡してアイドル判定
  const prevTextRef = useRef(previewText);
  const prevActivityRef = useRef(activityText);
  const lastChangedRef = useRef(Date.now());
  const [isIdle, setIsIdle] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

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

  // セッション未起動の場合はシンプルなカードを表示
  if (!session) {
    return (
      <button
        type="button"
        className={`w-full text-left p-3 rounded-lg transition-colors group ${
          isSelected
            ? "bg-primary/15 border border-primary/30"
            : "hover:bg-sidebar-accent/50"
        }`}
        onClick={onStart ?? onClick}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-2 h-2 rounded-full shrink-0 bg-muted-foreground/30" />
          <span className="text-sm font-mono truncate text-sidebar-foreground/60">
            {branch}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground truncate pl-4">
          セッション未起動
        </p>
      </button>
    );
  }

  // ✢✻はアニメーション記号、◼◻はタスク表示記号、"* verb…"は処理中表示
  const hasActivitySymbol =
    /[✢✻◼◻]/.test(activityText) ||
    /[◼◻]/.test(previewText) ||
    /\S+…/.test(activityText);
  // タスク記号・処理中表示はidle判定を無視する
  const hasTaskSymbol =
    /[◼◻]/.test(activityText) ||
    /[◼◻]/.test(previewText) ||
    /\S+…/.test(activityText);

  // 緑: 動作中（✢✻+変化あり or タスク進行中）、青: 起動直後/clear後、赤: それ以外
  const hasVisibleContent =
    previewText.trim().length > 0 || activityText.trim().length > 0;

  const dotColor =
    hasActivitySymbol && (!isIdle || hasTaskSymbol)
      ? "bg-green-500"
      : !hasVisibleContent
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
            onSelect={() => setShowDeleteDialog(true)}
          >
            <Trash2 className="w-4 h-4 mr-2" />
            セッションを削除
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent className="bg-card border-border w-[calc(100%-2rem)] max-w-md mx-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>セッションを削除</AlertDialogTitle>
            <AlertDialogDescription>
              {worktree?.isMain
                ? "このセッションを削除しますか？メインWorktreeは削除されません。"
                : "このセッションとWorktreeを削除しますか？関連するブランチも削除されます。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="h-12 md:h-10">
              キャンセル
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 h-12 md:h-10"
              onClick={() => {
                onDelete();
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
