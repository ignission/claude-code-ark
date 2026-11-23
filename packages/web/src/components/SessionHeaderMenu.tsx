/**
 * SessionHeaderMenu - PC上部バー右端の `…` メニュー
 *
 * 端末に関する操作 (バッファのコピー / 端末の再読み込み / 入力バーの表示) と、
 * 1タップで届かせたい送る操作 (ファイルの添付 / 画像の貼り付け / メッセージの
 * ショートカット) は上部バーのボタンへ出したので、ここには残さない。
 * ここに残るのはセッション全体の操作だけ: 削除。
 * 確認ダイアログはメニューの外に置き、メニューが閉じても開いたままにする。
 */

import type { Worktree } from "@ark/shared";
import { Ellipsis, Trash2 } from "lucide-react";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { m } from "@/lib/i18n";
import { deleteSessionDescription } from "@/lib/session-header";

export interface SessionHeaderMenuProps {
  worktree: Worktree | undefined;
  /** セッション削除 (停止 + メイン以外のWorktree削除)。確認ダイアログはこのメニューが出す */
  onDeleteSession: () => void;
}

export function SessionHeaderMenu({
  worktree,
  onDeleteSession,
}: SessionHeaderMenuProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={m.session.header.moreActions}
            title={m.session.header.moreActions}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
          >
            <Ellipsis className="size-5" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setShowDeleteDialog(true)}
          >
            <Trash2 />
            {m.session.actions.deleteSession}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent className="bg-card border-border w-[calc(100%-2rem)] max-w-md mx-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {m.session.actions.deleteSession}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteSessionDescription(worktree)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="h-10">
              {m.common.cancel}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 h-10"
              onClick={() => {
                onDeleteSession();
                setShowDeleteDialog(false);
              }}
            >
              {m.common.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
