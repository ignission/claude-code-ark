/**
 * SessionHeaderMenu - PC上部バー右端の `…` メニュー
 *
 * 1タップで届かせたい操作 (ファイルの添付 / 画像の貼り付け / メッセージの
 * ショートカット) は上部バーのボタンへ出したので、ここには残さない。
 * ここに残るのは、両モード共通のこのセッションの通知 / 削除 (最下段) と、
 * 端末モードだけのバッファのコピー / 端末の再読み込み / 入力バーの表示。
 * 端末の操作の実体はTerminalPaneが持ち (TerminalPaneHandle)、ここは呼ぶだけ。
 * どの項目を出すかはlib/session-header.tsが決める。
 * 確認ダイアログはメニューの外に置き、メニューが閉じても開いたままにする。
 */

import type { Worktree } from "@ark/shared";
import { Bell, BellOff, Copy, Ellipsis, RefreshCw, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
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
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  deleteSessionDescription,
  notificationMenuLabel,
  type TerminalMenuAction,
  terminalMenuActions,
} from "@/lib/session-header";
import type { SplitViewLeftMode } from "@/lib/split-view-left-mode";

export interface SessionHeaderMenuProps {
  leftMode: SplitViewLeftMode;
  worktree: Worktree | undefined;
  notificationsSupported: boolean;
  notificationsEnabled: boolean;
  onNotificationsEnabledChange?: (enabled: boolean) => void;
  /** セッション削除 (停止 + メイン以外のWorktree削除)。確認ダイアログはこのメニューが出す */
  onDeleteSession: () => void;
  /** 以下は端末モードだけの操作。未指定の操作は出さない */
  onCopyBuffer?: () => void;
  onReloadTerminal: () => void;
  inputBarVisible: boolean;
  onToggleInputBar: () => void;
}

export function SessionHeaderMenu({
  leftMode,
  worktree,
  notificationsSupported,
  notificationsEnabled,
  onNotificationsEnabledChange,
  onDeleteSession,
  onCopyBuffer,
  onReloadTerminal,
  inputBarVisible,
  onToggleInputBar,
}: SessionHeaderMenuProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const terminalActions = terminalMenuActions({
    leftMode,
    canCopyBuffer: onCopyBuffer !== undefined,
  });
  const canChangeNotifications =
    notificationsSupported && onNotificationsEnabledChange !== undefined;
  // Recordにして、TerminalMenuActionを足したときの描き忘れを型で拾う
  const terminalItems: Record<TerminalMenuAction, ReactNode> = {
    "copy-buffer": (
      <DropdownMenuItem key="copy-buffer" onSelect={onCopyBuffer}>
        <Copy />
        端末のバッファをコピー
      </DropdownMenuItem>
    ),
    reload: (
      <DropdownMenuItem key="reload" onSelect={onReloadTerminal}>
        <RefreshCw />
        端末を再読み込み
      </DropdownMenuItem>
    ),
    "toggle-input-bar": (
      <DropdownMenuCheckboxItem
        key="toggle-input-bar"
        checked={inputBarVisible}
        onCheckedChange={() => onToggleInputBar()}
      >
        入力バーを表示
      </DropdownMenuCheckboxItem>
    ),
  };

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
          {canChangeNotifications && (
            <DropdownMenuItem
              onSelect={() =>
                onNotificationsEnabledChange?.(!notificationsEnabled)
              }
            >
              {notificationsEnabled ? <BellOff /> : <Bell />}
              {notificationMenuLabel(notificationsEnabled)}
            </DropdownMenuItem>
          )}
          {/* 区切り線は、直前のまとまりが実際に出たときだけ引く
              (会話モードで通知も出せないと、先頭に線だけが残ってしまう) */}
          {canChangeNotifications && terminalActions.length > 0 && (
            <DropdownMenuSeparator />
          )}
          {terminalActions.map(action => terminalItems[action])}
          {(canChangeNotifications || terminalActions.length > 0) && (
            <DropdownMenuSeparator />
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
