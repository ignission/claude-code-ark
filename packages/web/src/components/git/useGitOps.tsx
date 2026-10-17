import type { GitBranchUpstream } from "@ark/shared";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { GitApi } from "@/lib/git-api";

/** サイドバーとコミット一覧の右クリック、上部のボタンから呼ぶ操作 */
export interface GitOpsActions {
  /** sha から新しいブランチを作る (名前を聞く) */
  createBranchAt: (sha: string) => void;
  renameBranch: (name: string) => void;
  /** 取り込み済みならそのまま消す。未マージなら確かめてから強制で消す */
  deleteBranch: (name: string) => void;
  /** リモート remote のブランチ name を、確かめてから消す */
  deleteRemoteBranch: (remote: string, name: string) => void;
  pushBranch: (name: string) => void;
  fetch: () => void;
  pull: () => void;
}

/** 実行中のリモートの操作 (ボタンの回転と、重ね押しの抑止に使う) */
export type GitRemoteBusy = "fetch" | "pull" | "push" | "remote-delete" | null;

type NameDialog =
  | { mode: "create"; sha: string }
  | { mode: "rename"; from: string };

type Confirm =
  | { kind: "force-delete"; name: string; reason: string }
  | { kind: "remote-delete"; remote: string; name: string };

/**
 * Git タブの書き込み操作。名前の入力と確認のダイアログを持ち、終わったら
 * onChanged で読み直させる (指紋の追従の 3 秒を待たない)。結果は toast で出す
 */
export function useGitOps(
  api: GitApi | null,
  currentBranch: string | null,
  onChanged: () => void
): { actions: GitOpsActions; busy: GitRemoteBusy; dialogs: ReactNode } {
  const [busy, setBusy] = useState<GitRemoteBusy>(null);
  // 重ね押しの判定は ref で行う (state は描き直すまで古い値のまま)
  const busyRef = useRef<GitRemoteBusy>(null);
  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const remoteOp = useCallback(
    async (
      kind: Exclude<GitRemoteBusy, null>,
      run: () => Promise<{ ok: boolean; error?: string }>,
      success: string
    ) => {
      if (busyRef.current) return;
      busyRef.current = kind;
      setBusy(kind);
      try {
        const res = await run();
        if (res.ok) toast.success(success);
        else toast.error(res.error ?? "失敗しました");
      } finally {
        busyRef.current = null;
        setBusy(null);
        onChanged();
      }
    },
    [onChanged]
  );

  const restoreBranch = useCallback(
    async (name: string, sha: string, upstream?: GitBranchUpstream) => {
      if (!api) return;
      const res = await api.createBranch(name, sha, upstream);
      if (res.ok) toast.success(`ブランチ ${name} を戻しました`);
      else toast.error(res.error);
      onChanged();
    },
    [api, onChanged]
  );

  const runDelete = useCallback(
    async (name: string, force: boolean) => {
      if (!api) return;
      const res = await api.deleteBranch(name, force);
      if (res.ok) {
        toast.success(`ブランチ ${name} を削除しました`, {
          description: res.sha.slice(0, 7),
          action: {
            label: "元に戻す",
            onClick: () => void restoreBranch(name, res.sha, res.upstream),
          },
        });
        onChanged();
      } else if (res.notMerged && !force) {
        setConfirm({ kind: "force-delete", name, reason: res.error });
      } else {
        toast.error(res.error);
      }
    },
    [api, onChanged, restoreBranch]
  );

  const actions: GitOpsActions = {
    createBranchAt: sha => {
      setNameDialog({ mode: "create", sha });
      setNameInput("");
      setNameError(null);
    },
    renameBranch: from => {
      setNameDialog({ mode: "rename", from });
      setNameInput(from);
      setNameError(null);
    },
    deleteBranch: name => void runDelete(name, false),
    deleteRemoteBranch: (remote, name) =>
      setConfirm({ kind: "remote-delete", remote, name }),
    pushBranch: name => {
      if (!api) return;
      void remoteOp("push", () => api.push(name), `${name} を push しました`);
    },
    fetch: () => {
      if (!api) return;
      void remoteOp("fetch", () => api.fetch(), "fetch しました");
    },
    pull: () => {
      if (!api || !currentBranch) return;
      void remoteOp(
        "pull",
        () => api.pull(),
        `${currentBranch} を pull しました`
      );
    },
  };

  const submitName = async (e: FormEvent) => {
    e.preventDefault();
    if (!api || !nameDialog || submitting) return;
    const name = nameInput.trim();
    if (!name) {
      setNameError("ブランチ名を入力してください");
      return;
    }
    if (nameDialog.mode === "rename" && name === nameDialog.from) {
      setNameDialog(null);
      return;
    }
    setSubmitting(true);
    const res =
      nameDialog.mode === "create"
        ? await api.createBranch(name, nameDialog.sha)
        : await api.renameBranch(nameDialog.from, name);
    setSubmitting(false);
    if (!res.ok) {
      setNameError(res.error);
      return;
    }
    toast.success(
      nameDialog.mode === "create"
        ? `ブランチ ${name} を作成しました`
        : `${nameDialog.from} を ${name} に変更しました`
    );
    setNameDialog(null);
    onChanged();
  };

  const runConfirm = () => {
    if (!api || !confirm) return;
    if (confirm.kind === "force-delete") {
      void runDelete(confirm.name, true);
    } else {
      const { remote, name } = confirm;
      void remoteOp(
        "remote-delete",
        () => api.deleteRemoteBranch(remote, name),
        `${remote}/${name} を削除しました`
      );
    }
    setConfirm(null);
  };

  const dialogs = (
    <>
      <Dialog
        open={nameDialog !== null}
        onOpenChange={open => {
          if (!open) setNameDialog(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <form onSubmit={submitName} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>
                {nameDialog?.mode === "rename"
                  ? "ブランチの名前を変更"
                  : "新しいブランチ"}
              </DialogTitle>
              <DialogDescription>
                {nameDialog?.mode === "rename"
                  ? `${nameDialog.from} の新しい名前`
                  : nameDialog
                    ? `${nameDialog.sha.slice(0, 7)} から作成します (チェックアウトはしません)`
                    : ""}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Input
                autoFocus
                aria-label="ブランチ名"
                value={nameInput}
                onChange={e => {
                  setNameInput(e.target.value);
                  setNameError(null);
                }}
                placeholder="feature/xxx"
                spellCheck={false}
                autoComplete="off"
              />
              {nameError && (
                <p role="alert" className="text-destructive text-xs">
                  {nameError}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setNameDialog(null)}
              >
                キャンセル
              </Button>
              <Button type="submit" disabled={submitting}>
                {nameDialog?.mode === "rename" ? "変更" : "作成"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirm !== null}
        onOpenChange={open => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "remote-delete"
                ? `${confirm.remote}/${confirm.name} を削除しますか?`
                : `${confirm?.name ?? ""} を強制削除しますか?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "remote-delete"
                ? `リモート ${confirm.remote} からブランチを消します。ほかの人もこのリモートを使っていれば、その人からも見えなくなります。`
                : `${confirm?.reason ?? ""}。削除するとこれらのコミットはブランチから辿れなくなります (直後なら「元に戻す」で戻せます)。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={runConfirm}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              削除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );

  return { actions, busy, dialogs };
}
