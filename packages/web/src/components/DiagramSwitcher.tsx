import type { DiagramListItem } from "@ark/shared";
import { Trash2 } from "lucide-react";
import type { ChangeEvent } from "react";
import { useState } from "react";
import { formatDiagramOptionLabel } from "../lib/diagram-option-label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./ui/alert-dialog";

interface DiagramSwitcherProps {
  diagrams: DiagramListItem[];
  currentRelPath?: string;
  onSelect: (relPath: string) => void;
  listLoading?: boolean;
  listError?: string | null;
  onRetry?: () => void;
  onDelete?: (
    relPath: string,
    expectedTracked: boolean
  ) => boolean | Promise<boolean>;
  isConnected?: boolean;
  isDeleting?: boolean;
}

export function getDiagramDeleteWarning(item: DiagramListItem): string {
  return item.tracked
    ? "worktree に削除差分が残ります。必要なら Git で復元できます。この操作は取り消せません。"
    : "未追跡ファイルは Git から復元できません。この操作は取り消せません。";
}

export function handleDiagramDeleteConfirmation(
  confirmed: boolean,
  item: DiagramListItem,
  onDelete: (
    relPath: string,
    expectedTracked: boolean
  ) => boolean | Promise<boolean>
): Promise<boolean> {
  if (!confirmed) return Promise.resolve(false);
  return Promise.resolve(onDelete(item.relPath, item.tracked));
}

export function DiagramSwitcher({
  diagrams,
  currentRelPath,
  onSelect,
  listLoading = false,
  listError = null,
  onRetry,
  onDelete,
  isConnected = true,
  isDeleting = false,
}: DiagramSwitcherProps) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const currentItem = diagrams.find(
    diagram => diagram.relPath === currentRelPath
  );
  const currentIsStale =
    currentRelPath !== undefined &&
    !diagrams.some(diagram => diagram.relPath === currentRelPath);
  const deletePending = isDeleting || confirmingDelete;
  const disabled = (diagrams.length === 0 && !currentRelPath) || deletePending;
  const deleteDisabled =
    !currentItem || listLoading || !isConnected || deletePending || !onDelete;
  const placeholder = diagrams.length === 0 ? "図がありません" : "図を選択";
  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    if (event.target.value) onSelect(event.target.value);
  };

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-sidebar px-2">
      <select
        aria-label="表示する図"
        className="h-7 min-w-0 flex-1 truncate rounded border border-border bg-background px-2 text-xs text-foreground"
        disabled={disabled}
        value={currentRelPath ?? ""}
        onChange={handleChange}
      >
        {!currentRelPath && <option value="">{placeholder}</option>}
        {currentIsStale && currentRelPath && (
          <option value={currentRelPath} title={currentRelPath}>
            {formatDiagramOptionLabel(
              currentRelPath.split("/").at(-1) ?? currentRelPath,
              currentRelPath
            )}
          </option>
        )}
        {diagrams.map(diagram => (
          <option
            key={diagram.relPath}
            value={diagram.relPath}
            title={`${diagram.relPath}（${diagram.tracked ? "Git管理" : "未追跡"}）`}
          >
            {`${formatDiagramOptionLabel(diagram.displayName, diagram.relPath)} — ${
              diagram.tracked ? "Git管理" : "未追跡"
            }`}
          </option>
        ))}
      </select>
      {currentItem && (
        <span
          className="shrink-0 text-[10px] text-muted-foreground"
          title={`${currentItem.relPath}（${currentItem.tracked ? "Git管理" : "未追跡"}）`}
        >
          {currentItem.tracked ? "Git管理" : "未追跡"}
        </span>
      )}
      <AlertDialog
        open={deleteDialogOpen}
        onOpenChange={open => {
          if (!deletePending) setDeleteDialogOpen(open);
        }}
      >
        <AlertDialogTrigger asChild>
          <button
            type="button"
            aria-label="現在の図を削除"
            disabled={deleteDisabled}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </button>
        </AlertDialogTrigger>
        {currentItem && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                「{currentItem.displayName}」を削除しますか？
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2">
                  <p className="break-all">{currentItem.relPath}</p>
                  <p>{currentItem.tracked ? "Git管理" : "未追跡"}</p>
                  <p>{getDiagramDeleteWarning(currentItem)}</p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deletePending}>
                キャンセル
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={deletePending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={async event => {
                  event.preventDefault();
                  if (!onDelete || deletePending) return;
                  setConfirmingDelete(true);
                  try {
                    const succeeded = await handleDiagramDeleteConfirmation(
                      true,
                      currentItem,
                      onDelete
                    );
                    if (succeeded) setDeleteDialogOpen(false);
                  } finally {
                    setConfirmingDelete(false);
                  }
                }}
              >
                {deletePending ? "削除中…" : "削除する"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
      {listLoading && (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          更新中…
        </span>
      )}
      {listError && (
        <span
          className="min-w-0 max-w-28 truncate text-[10px] text-destructive"
          title={listError}
        >
          {listError}
        </span>
      )}
      {listError && onRetry && (
        <button
          type="button"
          className="shrink-0 text-[10px] underline"
          onClick={onRetry}
        >
          再試行
        </button>
      )}
    </div>
  );
}
