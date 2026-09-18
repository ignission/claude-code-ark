/**
 * SessionHeaderMenu - PC上部バー右端の `…` メニュー
 *
 * 端末に関する操作 (バッファのコピー / 端末の再読み込み / 入力バーの表示) と、
 * 1タップで届かせたい送る操作 (ファイルの添付 / 画像の貼り付け / メッセージの
 * ショートカット) は上部バーのボタンへ出したので、ここには残さない。
 * ここに残るのはセッション全体の操作だけ: このセッションの通知と、削除 (最下段)。
 * 確認ダイアログはメニューの外に置き、メニューが閉じても開いたままにする。
 */

import type { Worktree } from "@ark/shared";
import { Bell, BellOff, Ellipsis, Trash2 } from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  deleteSessionDescription,
  notificationMenuLabel,
} from "@/lib/session-header";

export interface SessionHeaderMenuProps {
  worktree: Worktree | undefined;
  notificationsSupported: boolean;
  notificationsEnabled: boolean;
  onNotificationsEnabledChange?: (enabled: boolean) => void;
  /** セッション削除 (停止 + メイン以外のWorktree削除)。確認ダイアログはこのメニューが出す */
  onDeleteSession: () => void;
}

export function SessionHeaderMenu({
  worktree,
  notificationsSupported,
  notificationsEnabled,
  onNotificationsEnabledChange,
  onDeleteSession,
}: SessionHeaderMenuProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const canChangeNotifications =
    notificationsSupported && onNotificationsEnabledChange !== undefined;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="その他の操作"
            title="その他の操作"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
          >
            <Ellipsis className="size-5" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {/* 区切り線は、直前のまとまりが実際に出たときだけ引く
              (通知を出せない環境で、先頭に線だけが残ってしまうのを避ける) */}
          {canChangeNotifications && (
            <>
              <DropdownMenuItem
                onSelect={() =>
                  onNotificationsEnabledChange?.(!notificationsEnabled)
                }
              >
                {notificationsEnabled ? <BellOff /> : <Bell />}
                {notificationMenuLabel(notificationsEnabled)}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setShowDeleteDialog(true)}
          >
            <Trash2 />
            セッションを削除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent className="bg-card border-border w-[calc(100%-2rem)] max-w-md mx-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>セッションを削除</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteSessionDescription(worktree)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="h-10">キャンセル</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 h-10"
              onClick={() => {
                onDeleteSession();
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
