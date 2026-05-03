/**
 * MessageShortcutManagerDialog - ショートカット CRUD 用ダイアログ
 */

import { Plus, Save, Trash2 } from "lucide-react";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { MessageShortcut } from "../../../shared/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shortcuts: MessageShortcut[];
  onCreate: (label: string, message: string) => void;
  onUpdate: (id: string, patch: { label?: string; message?: string }) => void;
  onDelete: (id: string) => void;
}

const MAX_LABEL = 60;
const MAX_MESSAGE = 4000;

export function MessageShortcutManagerDialog({
  open,
  onOpenChange,
  shortcuts,
  onCreate,
  onUpdate,
  onDelete,
}: Props) {
  const [drafts, setDrafts] = useState<
    Record<string, { label: string; message: string }>
  >({});
  const [newLabel, setNewLabel] = useState("");
  const [newMessage, setNewMessage] = useState("");
  const [pendingDelete, setPendingDelete] = useState<MessageShortcut | null>(
    null
  );

  const getDraft = (s: MessageShortcut) =>
    drafts[s.id] ?? { label: s.label, message: s.message };

  const setDraft = (
    id: string,
    patch: Partial<{ label: string; message: string }>
  ) => {
    setDrafts(prev => ({
      ...prev,
      [id]: { ...(prev[id] ?? { label: "", message: "" }), ...patch },
    }));
  };

  const isDirty = (s: MessageShortcut) => {
    const d = drafts[s.id];
    if (!d) return false;
    return d.label !== s.label || d.message !== s.message;
  };

  const isValidDraft = (d: { label: string; message: string }) => {
    const l = d.label.trim();
    const m = d.message.trim();
    return (
      l.length > 0 &&
      l.length <= MAX_LABEL &&
      m.length > 0 &&
      m.length <= MAX_MESSAGE
    );
  };

  const handleSave = (s: MessageShortcut) => {
    const d = getDraft(s);
    if (!isValidDraft(d)) return;
    const patch: { label?: string; message?: string } = {};
    if (d.label !== s.label) patch.label = d.label.trim();
    if (d.message !== s.message) patch.message = d.message.trim();
    if (Object.keys(patch).length === 0) return;
    onUpdate(s.id, patch);
    setDrafts(prev => {
      const next = { ...prev };
      delete next[s.id];
      return next;
    });
  };

  const handleCreate = () => {
    const l = newLabel.trim();
    const m = newMessage.trim();
    if (l.length === 0 || l.length > MAX_LABEL) return;
    if (m.length === 0 || m.length > MAX_MESSAGE) return;
    onCreate(l, m);
    setNewLabel("");
    setNewMessage("");
  };

  const newDraftValid =
    newLabel.trim().length > 0 &&
    newLabel.trim().length <= MAX_LABEL &&
    newMessage.trim().length > 0 &&
    newMessage.trim().length <= MAX_MESSAGE;

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
                  <Input
                    value={d.label}
                    maxLength={MAX_LABEL}
                    onChange={e => setDraft(s.id, { label: e.target.value })}
                    placeholder="ラベル（1〜60字）"
                  />
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
              <Input
                value={newLabel}
                maxLength={MAX_LABEL}
                onChange={e => setNewLabel(e.target.value)}
                placeholder="ラベル（例: 進捗確認）"
              />
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
              「{pendingDelete?.label}」を削除します。よろしいですか？
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
