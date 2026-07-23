import type { DiagramListItem } from "@ark/shared";
import type { ChangeEvent } from "react";
import { formatDiagramOptionLabel } from "../lib/diagram-option-label";

interface DiagramSwitcherProps {
  diagrams: DiagramListItem[];
  currentRelPath?: string;
  onSelect: (relPath: string) => void;
  listLoading?: boolean;
  listError?: string | null;
  onRetry?: () => void;
}

export function DiagramSwitcher({
  diagrams,
  currentRelPath,
  onSelect,
  listLoading = false,
  listError = null,
  onRetry,
}: DiagramSwitcherProps) {
  const currentIsStale =
    currentRelPath !== undefined &&
    !diagrams.some(diagram => diagram.relPath === currentRelPath);
  const disabled = diagrams.length === 0 && !currentRelPath;
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
            title={diagram.relPath}
          >
            {formatDiagramOptionLabel(diagram.displayName, diagram.relPath)}
          </option>
        ))}
      </select>
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
