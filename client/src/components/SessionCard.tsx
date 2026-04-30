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
import type {
  BridgeSessionStatus,
  ManagedSession,
  Worktree,
} from "../../../shared/types";

/** プレビュー無変化でアイドル判定するまでの秒数 */
const IDLE_THRESHOLD_MS = 10_000;

interface SessionCardProps {
  session: ManagedSession | null;
  worktree: Worktree | undefined;
  repoList: string[];
  isSelected: boolean;
  previewText: string;
  activityText: string;
  /**
   * Bridge collector が判定した最新のセッション状態 (グリッドビューと同じソース)。
   * 渡されればこれを優先してドット色を決定し、サイドバーとグリッドで表示が一致する。
   * 未取得 (snapshot 未着信) の場合は activityText/previewText 由来のフォールバックを使う。
   */
  gridStatus?: BridgeSessionStatus;
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
  gridStatus,
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

  // ドット色はグリッドビューと統一するため BridgeSessionStatus を優先する。
  // gridStatus が未着信のときだけ既存ヒューリスティック (✢✻ / ◼◻ / …) にフォールバック。
  const dotColor = gridStatus
    ? statusToDotColor(gridStatus)
    : fallbackDotColor(previewText, activityText, isIdle);

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
              <div className="mt-1 flex items-center gap-1 pl-4 min-w-0">
                <p className="text-xs text-muted-foreground truncate">
                  {displayText}
                </p>
              </div>
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

/**
 * Bridge の状態判定 → サイドバードット色のマップ。
 * グリッドビュー側 (RepoGridView の STATUS_CONFIG) と色を揃える。
 *
 *   TOOL/THINK = 緑     (動作中)
 *   AWAITING   = 橙     (判断要)
 *   IDLE/ERR   = 赤     (アクション必要)
 *   READY/STOP = グレー (アイドル相当)
 */
function statusToDotColor(status: BridgeSessionStatus): string {
  switch (status) {
    case "TOOL":
    case "THINK":
      return "bg-green-500";
    case "AWAITING":
      return "bg-orange-500";
    case "IDLE":
    case "ERR":
      return "bg-red-500";
    case "READY":
    case "STOP":
      return "bg-neutral-500";
  }
}

/**
 * gridStatus が未着信の間だけ使う旧ロジックのフォールバック。
 *   - 緑: 活動記号 (✢✻◼◻ / `…`) あり、かつ idle でない or タスク記号
 *   - 青: 出力なし (起動直後/clear 後)
 *   - 赤: それ以外
 */
function fallbackDotColor(
  previewText: string,
  activityText: string,
  isIdle: boolean
): string {
  const hasActivitySymbol =
    /[✢✻◼◻]/.test(activityText) ||
    /[◼◻]/.test(previewText) ||
    /\S+…/.test(activityText);
  const hasTaskSymbol =
    /[◼◻]/.test(activityText) ||
    /[◼◻]/.test(previewText) ||
    /\S+…/.test(activityText);
  const hasVisibleContent =
    previewText.trim().length > 0 || activityText.trim().length > 0;
  if (hasActivitySymbol && (!isIdle || hasTaskSymbol)) return "bg-green-500";
  if (!hasVisibleContent) return "bg-neutral-500";
  return "bg-red-500";
}
