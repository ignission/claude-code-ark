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
import { m } from "@/lib/i18n";

/** サイドバーとコミット一覧の右クリック、上部のボタンから呼ぶ操作 */
export interface GitOpsActions {
  /** sha から新しいブランチを作る (名前を聞く) */
  createBranchAt: (sha: string) => void;
  renameBranch: (name: string) => void;
  /**
   * 取り込み済みならそのまま消す。未マージなら確かめてから強制で消す。
   * 作業ツリーで使用中なら、作業ツリーごと消すかを確かめる
   */
  deleteBranch: (name: string) => void;
  /** 追跡ブランチ trackingName (`origin/feat/x`) の元をリモート remote から、確かめてから消す */
  deleteRemoteBranch: (remote: string, trackingName: string) => void;
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
  | {
      kind: "worktree-delete";
      name: string;
      worktreePath: string;
      notMerged: boolean;
    }
  | { kind: "remote-delete"; remote: string; trackingName: string };

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
        else toast.error(res.error ?? m.git.ops.failed);
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
      if (res.ok) toast.success(m.git.ops.branchRestored(name));
      else toast.error(res.error);
      onChanged();
    },
    [api, onChanged]
  );

  const runDelete = useCallback(
    async (name: string, force: boolean, removeWorktree = false) => {
      if (!api) return;
      const res = await api.deleteBranch(name, force, removeWorktree);
      if (res.ok) {
        toast.success(
          res.removedWorktree
            ? m.git.ops.branchDeletedWithWorktree(name)
            : m.git.ops.branchDeleted(name),
          {
            description: res.removedWorktree
              ? m.git.ops.undoRestoresBranchOnly(res.sha.slice(0, 7))
              : res.sha.slice(0, 7),
            action: {
              label: m.git.ops.undo,
              onClick: () => void restoreBranch(name, res.sha, res.upstream),
            },
          }
        );
        onChanged();
      } else if (res.inWorktree && !removeWorktree) {
        setConfirm({
          kind: "worktree-delete",
          name,
          worktreePath: res.inWorktree,
          notMerged: res.notMerged === true,
        });
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
    deleteRemoteBranch: (remote, trackingName) =>
      setConfirm({ kind: "remote-delete", remote, trackingName }),
    pushBranch: name => {
      if (!api) return;
      void remoteOp("push", () => api.push(name), m.git.ops.pushed(name));
    },
    fetch: () => {
      if (!api) return;
      void remoteOp("fetch", () => api.fetch(), m.git.ops.fetched);
    },
    pull: () => {
      if (!api || !currentBranch) return;
      void remoteOp("pull", () => api.pull(), m.git.ops.pulled(currentBranch));
    },
  };

  const submitName = async (e: FormEvent) => {
    e.preventDefault();
    if (!api || !nameDialog || submitting) return;
    const name = nameInput.trim();
    if (!name) {
      setNameError(m.git.ops.nameRequired);
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
        ? m.git.ops.branchCreated(name)
        : m.git.ops.branchRenamed(nameDialog.from, name)
    );
    setNameDialog(null);
    onChanged();
  };

  const runConfirm = () => {
    if (!api || !confirm) return;
    if (confirm.kind === "force-delete") {
      void runDelete(confirm.name, true);
    } else if (confirm.kind === "worktree-delete") {
      void runDelete(confirm.name, true, true);
    } else {
      const { remote, trackingName } = confirm;
      void remoteOp(
        "remote-delete",
        () => api.deleteRemoteBranch(remote, trackingName),
        m.git.ops.remoteBranchDeleted(trackingName)
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
                  ? m.git.ops.renameTitle
                  : m.git.ops.createTitle}
              </DialogTitle>
              <DialogDescription>
                {nameDialog?.mode === "rename"
                  ? m.git.ops.renameDescription(nameDialog.from)
                  : nameDialog
                    ? m.git.ops.createDescription(nameDialog.sha.slice(0, 7))
                    : ""}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Input
                autoFocus
                aria-label={m.git.ops.branchName}
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
                {m.common.cancel}
              </Button>
              <Button type="submit" disabled={submitting}>
                {nameDialog?.mode === "rename"
                  ? m.git.ops.renameSubmit
                  : m.git.ops.createSubmit}
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
              {confirm && confirmTitle(confirm)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm && confirmDescription(confirm, currentBranch)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.common.cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={runConfirm}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {m.common.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );

  return { actions, busy, dialogs };
}

function confirmTitle(c: Confirm): string {
  switch (c.kind) {
    case "remote-delete":
      return m.git.ops.confirmRemoteDeleteTitle(c.trackingName);
    case "worktree-delete":
      return m.git.ops.confirmWorktreeDeleteTitle(c.name);
    case "force-delete":
      return m.git.ops.confirmForceDeleteTitle(c.name);
  }
}

function confirmDescription(c: Confirm, currentBranch: string | null): string {
  switch (c.kind) {
    case "remote-delete":
      return m.git.ops.confirmRemoteDeleteDescription(c.remote);
    case "worktree-delete":
      return m.git.ops.confirmWorktreeDeleteDescription(
        c.worktreePath,
        c.name === currentBranch,
        c.notMerged
      );
    case "force-delete":
      return m.git.ops.confirmForceDeleteDescription(c.reason);
  }
}
