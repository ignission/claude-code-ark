/**
 * SessionHeaderMenu - PC上部バー右端の `…` メニュー
 *
 * 両モード共通: メッセージショートカット (送信と管理) / このセッションの通知 / 削除 (最下段)
 * 端末モードだけ: バッファのコピー / 画像の貼り付け / ファイルの添付 / 端末の再読み込み /
 * 入力バーの表示。端末の操作の実体はTerminalPaneが持ち (TerminalPaneHandle)、
 * ここは呼ぶだけ。どの項目を出すかはlib/session-header.tsが決める。
 * 確認ダイアログとショートカット管理ダイアログはメニューの外に置き、
 * メニューが閉じても開いたままにする。
 */

import type { MessageShortcut, Worktree } from "@ark/shared";
import {
  Bell,
  BellOff,
  Copy,
  Ellipsis,
  ImagePlus,
  MessageSquareQuote,
  Paperclip,
  RefreshCw,
  Settings,
  Trash2,
} from "lucide-react";
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  deleteSessionDescription,
  notificationMenuLabel,
  type TerminalMenuAction,
  terminalMenuActions,
} from "@/lib/session-header";
import type { SplitViewLeftMode } from "@/lib/split-view-left-mode";
import { MessageShortcutManagerDialog } from "./MessageShortcutManagerDialog";
import { previewOf } from "./MessageShortcutMenu";

export interface SessionHeaderMenuProps {
  leftMode: SplitViewLeftMode;
  worktree: Worktree | undefined;
  messageShortcuts: MessageShortcut[];
  onSendMessage: (message: string) => void;
  onCreateShortcut: (message: string) => void;
  onUpdateShortcut: (id: string, patch: { message?: string }) => void;
  onDeleteShortcut: (id: string) => void;
  notificationsSupported: boolean;
  notificationsEnabled: boolean;
  onNotificationsEnabledChange?: (enabled: boolean) => void;
  /** セッション削除 (停止 + メイン以外のWorktree削除)。確認ダイアログはこのメニューが出す */
  onDeleteSession: () => void;
  /** 以下は端末モードだけの操作。未指定の操作は出さない */
  onCopyBuffer?: () => void;
  onPasteImage?: () => void;
  onAttachFile?: () => void;
  onReloadTerminal: () => void;
  inputBarVisible: boolean;
  onToggleInputBar: () => void;
}

export function SessionHeaderMenu({
  leftMode,
  worktree,
  messageShortcuts,
  onSendMessage,
  onCreateShortcut,
  onUpdateShortcut,
  onDeleteShortcut,
  notificationsSupported,
  notificationsEnabled,
  onNotificationsEnabledChange,
  onDeleteSession,
  onCopyBuffer,
  onPasteImage,
  onAttachFile,
  onReloadTerminal,
  inputBarVisible,
  onToggleInputBar,
}: SessionHeaderMenuProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showShortcutManager, setShowShortcutManager] = useState(false);

  const terminalActions = terminalMenuActions({
    leftMode,
    canCopyBuffer: onCopyBuffer !== undefined,
    canUploadFile: onPasteImage !== undefined && onAttachFile !== undefined,
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
    "paste-image": (
      <DropdownMenuItem key="paste-image" onSelect={onPasteImage}>
        <ImagePlus />
        画像を貼り付け
      </DropdownMenuItem>
    ),
    "attach-file": (
      <DropdownMenuItem key="attach-file" onSelect={onAttachFile}>
        <Paperclip />
        ファイルを添付
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
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <MessageSquareQuote />
              メッセージショートカット
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-64">
              {messageShortcuts.length === 0 ? (
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  ショートカットがありません
                </DropdownMenuLabel>
              ) : (
                messageShortcuts.map(shortcut => (
                  <DropdownMenuItem
                    key={shortcut.id}
                    title={shortcut.message.slice(0, 200)}
                    onSelect={() => onSendMessage(shortcut.message)}
                  >
                    <span className="truncate">
                      {previewOf(shortcut.message)}
                    </span>
                  </DropdownMenuItem>
                ))
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setShowShortcutManager(true)}>
                <Settings />
                ショートカットを管理
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
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
          {terminalActions.length > 0 && <DropdownMenuSeparator />}
          {terminalActions.map(action => terminalItems[action])}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setShowDeleteDialog(true)}
          >
            <Trash2 />
            セッションを削除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <MessageShortcutManagerDialog
        open={showShortcutManager}
        onOpenChange={setShowShortcutManager}
        shortcuts={messageShortcuts}
        onCreate={onCreateShortcut}
        onUpdate={onUpdateShortcut}
        onDelete={onDeleteShortcut}
      />

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
