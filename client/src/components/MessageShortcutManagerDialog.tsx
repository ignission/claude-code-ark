/**
 * MessageShortcutManagerDialog - ショートカット CRUD 用ダイアログ
 */

import { Plus, Save, Trash2 } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  MESSAGE_SHORTCUT_MAX_LENGTH,
  type MessageShortcut,
} from "../../../shared/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shortcuts: MessageShortcut[];
  onCreate: (message: string) => void;
  onUpdate: (id: string, patch: { message?: string }) => void;
  onDelete: (id: string) => void;
}

/** 削除確認ダイアログ等で本文の先頭行を 40 字に切り詰めて表示する */
function previewOf(message: string): string {
  const firstLine = message.split("\n")[0];
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
}

export function MessageShortcutManagerDialog({
  open,
  onOpenChange,
  shortcuts,
  onCreate,
  onUpdate,
  onDelete,
}: Props) {
  const [drafts, setDrafts] = useState<Record<string, { message: string }>>({});
  const [newMessage, setNewMessage] = useState("");
  const [pendingDelete, setPendingDelete] = useState<MessageShortcut | null>(
    null
  );

  const getDraft = (s: MessageShortcut) =>
    drafts[s.id] ?? { message: s.message };

  const setDraft = (id: string, patch: Partial<{ message: string }>) => {
    setDrafts(prev => ({
      ...prev,
      [id]: { ...(prev[id] ?? { message: "" }), ...patch },
    }));
  };

  const isDirty = (s: MessageShortcut) => {
    const d = drafts[s.id];
    if (!d) return false;
    // trim 済み値で比較し、空白のみの差分で no-op update を発火しない
    return d.message.trim() !== s.message.trim();
  };

  const isValidDraft = (d: { message: string }) => {
    const m = d.message.trim();
    return m.length > 0 && m.length <= MESSAGE_SHORTCUT_MAX_LENGTH;
  };

  const clearDraft = (id: string) =>
    setDrafts(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

  const handleSave = (s: MessageShortcut) => {
    const d = getDraft(s);
    if (!isValidDraft(d)) return;
    const trimmed = d.message.trim();
    // 正規化後の値が同一なら no-op update を抑止して draft も破棄する
    if (trimmed === s.message.trim()) {
      clearDraft(s.id);
      return;
    }
    // ack 待ち: onUpdate 実行後すぐに draft を消すと、サーバ失敗時に入力が消失する。
    // server から shortcut:updated が届くと props.shortcuts[].message が trimmed に変わり、
    // isDirty で trim 比較しているため自動的に「保存」ボタンが非活性化する。
    // ダイアログを閉じれば state 自体が解放されるので明示的なクリアは不要。
    onUpdate(s.id, { message: trimmed });
  };

  // 新規作成: ack 待ちのため、shortcuts 配列の長さが増えたタイミングで textarea をクリアする
  const pendingCreateRef = useRef(false);
  const prevShortcutsLenRef = useRef(shortcuts.length);
  useEffect(() => {
    if (
      pendingCreateRef.current &&
      shortcuts.length > prevShortcutsLenRef.current
    ) {
      setNewMessage("");
      pendingCreateRef.current = false;
    }
    prevShortcutsLenRef.current = shortcuts.length;
  }, [shortcuts.length]);

  const handleCreate = () => {
    const m = newMessage.trim();
    if (m.length === 0 || m.length > MESSAGE_SHORTCUT_MAX_LENGTH) return;
    // ack 待ち: shortcut:created で配列が増えるまで textarea を保持する
    pendingCreateRef.current = true;
    onCreate(m);
  };

  const newDraftValid =
    newMessage.trim().length > 0 &&
    newMessage.trim().length <= MESSAGE_SHORTCUT_MAX_LENGTH;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="bg-card border-border w-[calc(100%-2rem)] max-w-2xl mx-auto max-h-[85vh] flex flex-col gap-0 p-0 overflow-hidden">
          <DialogHeader className="p-4 border-b border-border shrink-0">
            <DialogTitle>メッセージショートカット</DialogTitle>
            <DialogDescription>
              選択するとセッションへ即送信されます。複数行可・末尾で Enter
              が押されます。
            </DialogDescription>
          </DialogHeader>

          <div className="overflow-y-auto p-4 space-y-4 flex-1">
            {shortcuts.length === 0 && (
              <p className="text-sm text-muted-foreground">
                登録されたショートカットがありません。下のフォームから追加してください。
              </p>
            )}
            {shortcuts.map(s => {
              const d = getDraft(s);
              const dirty = isDirty(s);
              const valid = isValidDraft(d);
              return (
                <div
                  key={s.id}
                  className="border border-border rounded-md p-3 space-y-2"
                >
                  <Textarea
                    value={d.message}
                    onChange={e => setDraft(s.id, { message: e.target.value })}
                    placeholder="送信本文（1〜4000字、複数行可）"
                    className="min-h-[80px] text-sm font-mono"
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setPendingDelete(s)}
                    >
                      <Trash2 className="w-4 h-4 mr-1" />
                      削除
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => handleSave(s)}
                      disabled={!dirty || !valid}
                    >
                      <Save className="w-4 h-4 mr-1" />
                      保存
                    </Button>
                  </div>
                </div>
              );
            })}

            <div className="border-t border-border pt-4 mt-4 space-y-2">
              <h4 className="text-sm font-semibold">新規追加</h4>
              <Textarea
                value={newMessage}
                onChange={e => setNewMessage(e.target.value)}
                placeholder="送信本文（例: 現在のタスクの進捗を教えて）"
                className="min-h-[80px] text-sm font-mono"
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={handleCreate}
                  disabled={!newDraftValid}
                >
                  <Plus className="w-4 h-4 mr-1" />
                  追加
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={open => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent className="bg-card border-border w-[calc(100%-2rem)] max-w-md mx-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>ショートカットを削除</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? `「${previewOf(pendingDelete.message)}」を削除します。よろしいですか？`
                : "このショートカットを削除します。よろしいですか？"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="h-12 md:h-10">
              キャンセル
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 h-12 md:h-10"
              onClick={() => {
                if (pendingDelete) onDelete(pendingDelete.id);
                setPendingDelete(null);
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

export default MessageShortcutManagerDialog;
