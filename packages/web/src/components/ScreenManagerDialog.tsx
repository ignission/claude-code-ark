import type { Screen, ScreenInput, ScreenPatch } from "@ark/shared";
import { Monitor, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
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
import { Label } from "@/components/ui/label";

interface ScreenManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  screens: Screen[];
  onCreate: (input: ScreenInput) => void;
  onUpdate: (id: string, patch: ScreenPatch) => void;
  onDelete: (id: string) => void;
}

type Mode = { kind: "list" } | { kind: "add" } | { kind: "edit"; id: string };

/** フォームの文字列 state。ポートも文字列で持ち、送信時に数値へ変える */
interface FormValues {
  name: string;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  vncHost: string;
  vncPort: string;
  vncUser: string;
  vncPassword: string;
}

type FormField = keyof FormValues;

const EMPTY_FORM: FormValues = {
  name: "",
  sshHost: "",
  sshPort: "22",
  sshUser: "",
  vncHost: "127.0.0.1",
  vncPort: "5900",
  vncUser: "",
  vncPassword: "",
};

function formFromScreen(screen: Screen): FormValues {
  return {
    name: screen.name,
    sshHost: screen.sshHost,
    sshPort: String(screen.sshPort),
    sshUser: screen.sshUser,
    vncHost: screen.vncHost,
    vncPort: String(screen.vncPort),
    vncUser: screen.vncUser,
    vncPassword: "",
  };
}

function parsePort(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/**
 * 入力値検証 (サーバの screen-input.ts と同じ規則)。
 * 編集時はパスワード空を「変更しない」として通す
 */
function validateForm(
  values: FormValues,
  kind: "add" | "edit"
): { ok: true } | { ok: false; field: FormField; message: string } {
  if (!values.name.trim()) {
    return { ok: false, field: "name", message: "名前を入力してください" };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(values.sshHost.trim())) {
    return {
      ok: false,
      field: "sshHost",
      message: "SSH ホストはホスト名か IP アドレスで指定してください",
    };
  }
  if (parsePort(values.sshPort) === null) {
    return {
      ok: false,
      field: "sshPort",
      message: "SSH ポートは 1〜65535 の整数で指定してください",
    };
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(values.sshUser.trim())) {
    return { ok: false, field: "sshUser", message: "SSH ユーザー名が不正です" };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(values.vncHost.trim())) {
    return {
      ok: false,
      field: "vncHost",
      message: "VNC ホストはホスト名か IP アドレスで指定してください",
    };
  }
  if (parsePort(values.vncPort) === null) {
    return {
      ok: false,
      field: "vncPort",
      message: "VNC ポートは 1〜65535 の整数で指定してください",
    };
  }
  if (kind === "add" && values.vncPassword.length === 0) {
    return {
      ok: false,
      field: "vncPassword",
      message: "VNC パスワードを入力してください",
    };
  }
  return { ok: true };
}

export function ScreenManagerDialog({
  open,
  onOpenChange,
  screens,
  onCreate,
  onUpdate,
  onDelete,
}: ScreenManagerDialogProps) {
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [pendingDelete, setPendingDelete] = useState<Screen | null>(null);

  useEffect(() => {
    if (!open) {
      setMode({ kind: "list" });
      setPendingDelete(null);
    }
  }, [open]);

  const editing =
    mode.kind === "edit" ? (screens.find(s => s.id === mode.id) ?? null) : null;

  useEffect(() => {
    if (mode.kind === "edit" && !editing) setMode({ kind: "list" });
  }, [mode, editing]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="bg-card border-border w-[calc(100%-2rem)] max-w-2xl mx-auto max-h-[85vh] flex flex-col gap-0 p-0 overflow-hidden">
          {mode.kind === "list" && (
            <ListView
              screens={screens}
              onAdd={() => setMode({ kind: "add" })}
              onEdit={id => setMode({ kind: "edit", id })}
              onAskDelete={setPendingDelete}
              onClose={() => onOpenChange(false)}
            />
          )}
          {mode.kind === "add" && (
            <AddOrEditView
              kind="add"
              initial={EMPTY_FORM}
              onCancel={() => setMode({ kind: "list" })}
              onSubmit={values => {
                onCreate({
                  name: values.name.trim(),
                  sshHost: values.sshHost.trim(),
                  sshPort: Number(values.sshPort),
                  sshUser: values.sshUser.trim(),
                  vncHost: values.vncHost.trim(),
                  vncPort: Number(values.vncPort),
                  vncUser: values.vncUser.trim(),
                  vncPassword: values.vncPassword,
                });
                setMode({ kind: "list" });
              }}
            />
          )}
          {mode.kind === "edit" && editing && (
            <AddOrEditView
              kind="edit"
              initial={formFromScreen(editing)}
              onCancel={() => setMode({ kind: "list" })}
              onSubmit={values => {
                const patch: ScreenPatch = {
                  name: values.name.trim(),
                  sshHost: values.sshHost.trim(),
                  sshPort: Number(values.sshPort),
                  sshUser: values.sshUser.trim(),
                  vncHost: values.vncHost.trim(),
                  vncPort: Number(values.vncPort),
                  vncUser: values.vncUser.trim(),
                };
                if (values.vncPassword.length > 0) {
                  patch.vncPassword = values.vncPassword;
                }
                onUpdate(editing.id, patch);
                setMode({ kind: "list" });
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={openState => {
          if (!openState) setPendingDelete(null);
        }}
      >
        <AlertDialogContent className="bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle>画面を削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? `「${pendingDelete.name}」の接続設定を削除します。接続先のホストには何もしません。`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDelete) {
                  onDelete(pendingDelete.id);
                  setPendingDelete(null);
                }
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              削除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ListView({
  screens,
  onAdd,
  onEdit,
  onAskDelete,
  onClose,
}: {
  screens: Screen[];
  onAdd: () => void;
  onEdit: (id: string) => void;
  onAskDelete: (screen: Screen) => void;
  onClose: () => void;
}) {
  return (
    <>
      <DialogHeader className="px-5 py-4 border-b border-border">
        <DialogTitle className="flex items-center gap-2">
          <Monitor className="w-4 h-4 text-muted-foreground" />
          画面の管理
        </DialogTitle>
        <DialogDescription>
          SSH で届くホストの VNC 画面 (macOS の画面共有など) を Ark
          の中に表示します。
        </DialogDescription>
      </DialogHeader>

      <div className="px-5 py-3 flex-1 overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-muted-foreground font-medium">
            登録済みの画面 ({screens.length})
          </span>
          <Button type="button" size="sm" onClick={onAdd}>
            <Plus className="w-3 h-3 mr-1" />
            新規追加
          </Button>
        </div>

        {screens.length === 0 ? (
          <div className="text-center py-10 text-sm text-muted-foreground border border-dashed border-border rounded-md">
            画面が未登録です。
          </div>
        ) : (
          <div className="space-y-2">
            {screens.map(screen => (
              <div
                key={screen.id}
                className="bg-background border border-border hover:border-muted-foreground/40 rounded-md p-3 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-sm">{screen.name}</span>
                    <p className="text-xs text-muted-foreground mt-1 font-mono truncate">
                      {screen.sshUser}@{screen.sshHost}:{screen.sshPort} →{" "}
                      {screen.vncHost}:{screen.vncPort}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => onEdit(screen.id)}
                      title="編集"
                      className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onAskDelete(screen)}
                      title="削除"
                      className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="px-5 py-3 border-t border-border flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          閉じる
        </Button>
      </div>
    </>
  );
}

const FIELD_LABELS: Array<{
  field: FormField;
  id: string;
  label: string;
  placeholder: string;
  type?: "text" | "password";
}> = [
  {
    field: "name",
    id: "screen-name",
    label: "名前",
    placeholder: "例: ビルド VM",
  },
  {
    field: "sshHost",
    id: "screen-ssh-host",
    label: "SSH ホスト",
    placeholder: "ホスト名か IP アドレス",
  },
  {
    field: "sshPort",
    id: "screen-ssh-port",
    label: "SSH ポート",
    placeholder: "22",
  },
  {
    field: "sshUser",
    id: "screen-ssh-user",
    label: "SSH ユーザー",
    placeholder: "",
  },
  {
    field: "vncHost",
    id: "screen-vnc-host",
    label: "VNC ホスト (SSH ホストから見た宛先)",
    placeholder: "127.0.0.1",
  },
  {
    field: "vncPort",
    id: "screen-vnc-port",
    label: "VNC ポート",
    placeholder: "5900",
  },
  {
    field: "vncUser",
    id: "screen-vnc-user",
    label: "VNC ユーザー名 (macOS の画面共有では必須)",
    placeholder: "",
  },
  {
    field: "vncPassword",
    id: "screen-vnc-password",
    label: "VNC パスワード",
    placeholder: "",
    type: "password",
  },
];

function AddOrEditView({
  kind,
  initial,
  onCancel,
  onSubmit,
}: {
  kind: "add" | "edit";
  initial: FormValues;
  onCancel: () => void;
  onSubmit: (values: FormValues) => void;
}) {
  const [values, setValues] = useState<FormValues>(initial);
  const [error, setError] = useState<{
    field: FormField;
    message: string;
  } | null>(null);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const result = validateForm(values, kind);
    if (!result.ok) {
      setError({ field: result.field, message: result.message });
      return;
    }
    setError(null);
    onSubmit(values);
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
      <DialogHeader className="px-5 py-4 border-b border-border">
        <DialogTitle>
          {kind === "add" ? "画面を追加" : "画面を編集"}
        </DialogTitle>
        <DialogDescription>
          {kind === "add"
            ? "Ark のサーバから SSH 鍵で繋がるホストを指定します。"
            : "パスワードは空のままにすると変更しません。"}
        </DialogDescription>
      </DialogHeader>

      <div className="px-5 py-4 flex-1 overflow-y-auto space-y-4">
        {FIELD_LABELS.map(({ field, id, label, placeholder, type }) => (
          <div key={field}>
            <Label htmlFor={id} className="text-xs font-medium mb-1.5 block">
              {label}
            </Label>
            <Input
              id={id}
              type={type ?? "text"}
              value={values[field]}
              onChange={e => {
                const next = e.target.value;
                setValues(prev => ({ ...prev, [field]: next }));
                if (error?.field === field) setError(null);
              }}
              placeholder={placeholder}
              autoFocus={field === "name"}
              autoComplete={type === "password" ? "new-password" : "off"}
              className="bg-background border-border"
            />
            {error?.field === field && (
              <p className="text-xs text-destructive mt-1">{error.message}</p>
            )}
          </div>
        ))}
      </div>

      <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          キャンセル
        </Button>
        <Button type="submit" size="sm">
          {kind === "add" ? "追加" : "保存"}
        </Button>
      </div>
    </form>
  );
}
