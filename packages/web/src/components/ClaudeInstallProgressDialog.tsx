/**
 * F5 placeholder: Claude CLI 自動インストール進捗ダイアログ
 *
 * 現状は props で受け取った state を表示するだけの placeholder。
 * F5-followup で Electron IPC (`ark:claude-install-progress`) 経由で
 * 実状態を受信し、`Dashboard.tsx` 等から open 制御する想定。
 *
 * `ClaudeInstallState` の discriminated union は
 * `packages/desktop/src/claude-installer.ts:ClaudeInstallProgressEvent` と
 * 同型 (type + フィールド)。IPC で受け取ったイベントをそのまま state に
 * セットすれば動作する。
 */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type ClaudeInstallState =
  | { type: "idle" }
  | { type: "checking" }
  | { type: "already-installed"; path: string }
  | { type: "node-missing"; message: string }
  | { type: "installing"; output: string }
  | { type: "completed"; path: string }
  | { type: "failed"; error: string };

export interface ClaudeInstallProgressDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: ClaudeInstallState;
}

function renderDescription(state: ClaudeInstallState): string {
  switch (state.type) {
    case "idle":
      return "待機中";
    case "checking":
      return "Claude CLI のインストール状態を確認しています...";
    case "already-installed":
      return `Claude CLI は既にインストール済みです: ${state.path}`;
    case "node-missing":
      return state.message;
    case "installing":
      return "Claude CLI をインストール中...";
    case "completed":
      return `インストールが完了しました: ${state.path}`;
    case "failed":
      return `インストールに失敗しました: ${state.error}`;
  }
}

export function ClaudeInstallProgressDialog({
  open,
  onOpenChange,
  state,
}: ClaudeInstallProgressDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Claude CLI セットアップ</DialogTitle>
          <DialogDescription>{renderDescription(state)}</DialogDescription>
        </DialogHeader>
        {state.type === "installing" && (
          <pre className="max-h-60 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
            {state.output}
          </pre>
        )}
        {state.type === "failed" && (
          <pre className="max-h-60 overflow-auto rounded bg-destructive/10 p-2 text-xs whitespace-pre-wrap text-destructive">
            {state.error}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  );
}
