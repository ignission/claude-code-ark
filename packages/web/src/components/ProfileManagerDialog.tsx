import type { Profile } from "@ark/shared";
import { Info, Pencil, Plus, Trash2, UsersRound } from "lucide-react";
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
import { m } from "@/lib/i18n";

interface ProfileManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profiles: Profile[];
  onCreate: (name: string, configDir: string) => void;
  onUpdate: (id: string, patch: { name?: string; configDir?: string }) => void;
  onDelete: (id: string) => void;
}

type Mode = { kind: "list" } | { kind: "add" } | { kind: "edit"; id: string };

/**
 * 入力値検証
 * - 名前: trim後に非空
 * - configDir: trim後に非空、かつ絶対パス("/") または "~/" / "~" 始まり
 *
 * 注: サーバ側の validateConfigDir は `expanded === "~"` か
 * `expanded.startsWith("~/")` のみチルダ展開する。`~user/...` 形式は
 * 別ユーザのhome を指し展開対象外で、サーバ側で拒否されるため、
 * クライアントもここで弾いて UX 不整合を防ぐ。
 */
function validateForm(
  name: string,
  configDir: string
): { ok: true } | { ok: false; field: "name" | "configDir"; message: string } {
  const trimmedName = name.trim();
  const trimmedDir = configDir.trim();
  if (!trimmedName) {
    return {
      ok: false,
      field: "name",
      message: m.dialogs.profile.nameRequired,
    };
  }
  if (!trimmedDir) {
    return {
      ok: false,
      field: "configDir",
      message: m.dialogs.profile.configDirRequired,
    };
  }
  const isAbsolute = trimmedDir.startsWith("/");
  const isHomeRelative = trimmedDir === "~" || trimmedDir.startsWith("~/");
  if (!isAbsolute && !isHomeRelative) {
    return {
      ok: false,
      field: "configDir",
      message: m.dialogs.profile.absolutePathRequired,
    };
  }
  return { ok: true };
}

export function ProfileManagerDialog({
  open,
  onOpenChange,
  profiles,
  onCreate,
  onUpdate,
  onDelete,
}: ProfileManagerDialogProps) {
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [pendingDelete, setPendingDelete] = useState<Profile | null>(null);

  // ダイアログが閉じたら内部stateをリセット
  useEffect(() => {
    if (!open) {
      setMode({ kind: "list" });
      setPendingDelete(null);
    }
  }, [open]);

  const editingProfile =
    mode.kind === "edit"
      ? (profiles.find(a => a.id === mode.id) ?? null)
      : null;

  // 編集対象が削除されたらlistに戻る
  useEffect(() => {
    if (mode.kind === "edit" && !editingProfile) {
      setMode({ kind: "list" });
    }
  }, [mode, editingProfile]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="bg-card border-border w-[calc(100%-2rem)] max-w-2xl mx-auto max-h-[85vh] flex flex-col gap-0 p-0 overflow-hidden">
          {mode.kind === "list" && (
            <ListView
              profiles={profiles}
              onAdd={() => setMode({ kind: "add" })}
              onEdit={id => setMode({ kind: "edit", id })}
              onAskDelete={acc => setPendingDelete(acc)}
              onClose={() => onOpenChange(false)}
            />
          )}
          {mode.kind === "add" && (
            <AddOrEditView
              kind="add"
              initialName=""
              initialConfigDir=""
              onCancel={() => setMode({ kind: "list" })}
              onSubmit={(name, configDir) => {
                onCreate(name.trim(), configDir.trim());
                setMode({ kind: "list" });
              }}
            />
          )}
          {mode.kind === "edit" && editingProfile && (
            <AddOrEditView
              kind="edit"
              initialName={editingProfile.name}
              initialConfigDir={editingProfile.configDir}
              onCancel={() => setMode({ kind: "list" })}
              onSubmit={(name, configDir) => {
                onUpdate(editingProfile.id, {
                  name: name.trim(),
                  configDir: configDir.trim(),
                });
                setMode({ kind: "list" });
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* 削除確認 AlertDialog */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={openState => {
          if (!openState) setPendingDelete(null);
        }}
      >
        <AlertDialogContent className="bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle>{m.dialogs.profile.deleteTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? m.dialogs.profile.deleteDescription(pendingDelete.name)
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.common.cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDelete) {
                  onDelete(pendingDelete.id);
                  setPendingDelete(null);
                }
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {m.common.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ============================================================
// 一覧ビュー
// ============================================================

function ListView({
  profiles,
  onAdd,
  onEdit,
  onAskDelete,
  onClose,
}: {
  profiles: Profile[];
  onAdd: () => void;
  onEdit: (id: string) => void;
  onAskDelete: (acc: Profile) => void;
  onClose: () => void;
}) {
  return (
    <>
      <DialogHeader className="px-5 py-4 border-b border-border">
        <DialogTitle className="flex items-center gap-2">
          <UsersRound className="w-4 h-4 text-muted-foreground" />
          {m.dialogs.profile.title}
        </DialogTitle>
        <DialogDescription>{m.dialogs.profile.description}</DialogDescription>
      </DialogHeader>

      {/* Linuxのみバッジ */}
      <div className="px-5 py-3 text-xs text-muted-foreground bg-muted/30 border-b border-border">
        <p className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 font-medium text-foreground">
            {m.dialogs.profile.linuxOnly}
          </span>
          <span>{m.dialogs.profile.unavailableOnOtherOs}</span>
        </p>
      </div>

      {/* プロファイル一覧 */}
      <div className="px-5 py-3 flex-1 overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-muted-foreground font-medium">
            {m.dialogs.profile.registered(profiles.length)}
          </span>
          <Button type="button" size="sm" onClick={onAdd}>
            <Plus className="w-3 h-3 mr-1" />
            {m.dialogs.profile.add}
          </Button>
        </div>

        {profiles.length === 0 ? (
          <div className="text-center py-10 text-sm text-muted-foreground border border-dashed border-border rounded-md">
            {m.dialogs.profile.empty}
          </div>
        ) : (
          <div className="space-y-2">
            {profiles.map(profile => (
              <ProfileRow
                key={profile.id}
                profile={profile}
                onEdit={() => onEdit(profile.id)}
                onAskDelete={() => onAskDelete(profile)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="px-5 py-3 border-t border-border flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          {m.common.close}
        </Button>
      </div>
    </>
  );
}

function ProfileRow({
  profile,
  onEdit,
  onAskDelete,
}: {
  profile: Profile;
  onEdit: () => void;
  onAskDelete: () => void;
}) {
  return (
    <div className="bg-background border border-border hover:border-muted-foreground/40 rounded-md p-3 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{profile.name}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-1 font-mono truncate">
            {profile.configDir}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={onEdit}
            title={m.dialogs.profile.edit}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onAskDelete}
            title={m.common.delete}
            className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// 追加 / 編集ビュー（共通フォーム）
// ============================================================

function AddOrEditView({
  kind,
  initialName,
  initialConfigDir,
  onCancel,
  onSubmit,
}: {
  kind: "add" | "edit";
  initialName: string;
  initialConfigDir: string;
  onCancel: () => void;
  onSubmit: (name: string, configDir: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const [configDir, setConfigDir] = useState(initialConfigDir);
  const [error, setError] = useState<{
    field: "name" | "configDir";
    message: string;
  } | null>(null);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const result = validateForm(name, configDir);
    if (!result.ok) {
      setError({ field: result.field, message: result.message });
      return;
    }
    setError(null);
    onSubmit(name, configDir);
  };

  const isAdd = kind === "add";

  return (
    <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
      <DialogHeader className="px-5 py-4 border-b border-border">
        <DialogTitle className="flex items-center gap-2">
          <UsersRound className="w-4 h-4 text-primary" />
          {isAdd ? m.dialogs.profile.addTitle : m.dialogs.profile.editTitle}
        </DialogTitle>
      </DialogHeader>

      <div className="px-5 py-4 space-y-4 flex-1 overflow-y-auto">
        <div>
          <Label
            htmlFor="profile-name"
            className="text-xs font-medium mb-1.5 block"
          >
            {m.dialogs.profile.name}
          </Label>
          <Input
            id="profile-name"
            type="text"
            value={name}
            onChange={e => {
              setName(e.target.value);
              if (error?.field === "name") setError(null);
            }}
            placeholder={m.dialogs.profile.namePlaceholder}
            autoFocus
            className="bg-background border-border"
          />
          {error?.field === "name" && (
            <p className="text-xs text-destructive mt-1">{error.message}</p>
          )}
          <p className="text-xs text-muted-foreground mt-1">
            {m.dialogs.profile.nameHint}
          </p>
        </div>

        <div>
          <Label
            htmlFor="profile-config-dir"
            className="text-xs font-medium mb-1.5 block"
          >
            {m.dialogs.profile.configDir}{" "}
            <span className="text-muted-foreground font-normal">
              (CLAUDE_CONFIG_DIR)
            </span>
          </Label>
          <Input
            id="profile-config-dir"
            type="text"
            value={configDir}
            onChange={e => {
              setConfigDir(e.target.value);
              if (error?.field === "configDir") setError(null);
            }}
            placeholder="~/.claude-personal"
            className="bg-background border-border font-mono"
          />
          {error?.field === "configDir" && (
            <p className="text-xs text-destructive mt-1">{error.message}</p>
          )}
          <p className="text-xs text-muted-foreground mt-1">
            {m.dialogs.profile.configDirHint}
          </p>
        </div>

        {isAdd && (
          <div className="bg-primary/5 border border-primary/20 rounded-md p-3 flex gap-2">
            <Info className="w-4 h-4 text-primary shrink-0 mt-0.5" />
            <div className="text-xs text-foreground/80">
              <p>{m.dialogs.profile.loginNotice}</p>
            </div>
          </div>
        )}
      </div>

      <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          {m.common.cancel}
        </Button>
        <Button type="submit" size="sm">
          {isAdd ? (
            <>
              <Plus className="w-3.5 h-3.5 mr-1" />
              {m.dialogs.profile.submitAdd}
            </>
          ) : (
            m.common.save
          )}
        </Button>
      </div>
    </form>
  );
}
