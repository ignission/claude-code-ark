import type { DiagramListItem } from "@ark/shared";
import { type ChangeEvent, createElement } from "react";

interface DiagramSwitcherProps {
  diagrams: DiagramListItem[];
  currentRelPath?: string;
  onSelect: (relPath: string) => void;
  listLoading?: boolean;
  listError?: string | null;
  onRetry?: () => void;
}

function basename(relPath: string): string {
  return relPath.split("/").at(-1) ?? relPath;
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

  const options = [
    !currentRelPath
      ? createElement("option", { key: "", value: "" }, placeholder)
      : null,
    currentIsStale && currentRelPath
      ? createElement(
          "option",
          {
            key: currentRelPath,
            value: currentRelPath,
            title: currentRelPath,
          },
          basename(currentRelPath)
        )
      : null,
    ...diagrams.map(diagram =>
      createElement(
        "option",
        {
          key: diagram.relPath,
          value: diagram.relPath,
          title: diagram.relPath,
        },
        diagram.displayName
      )
    ),
  ];

  return createElement(
    "div",
    {
      className:
        "flex h-10 shrink-0 items-center gap-2 border-b border-border bg-sidebar px-2",
    },
    createElement(
      "select",
      {
        "aria-label": "表示する図",
        className:
          "h-7 min-w-0 flex-1 truncate rounded border border-border bg-background px-2 text-xs text-foreground",
        disabled,
        value: currentRelPath ?? "",
        onChange: handleChange,
      },
      ...options
    ),
    listLoading
      ? createElement(
          "span",
          { className: "shrink-0 text-[10px] text-muted-foreground" },
          "更新中…"
        )
      : null,
    listError
      ? createElement(
          "span",
          {
            className: "min-w-0 max-w-28 truncate text-[10px] text-destructive",
            title: listError,
          },
          listError
        )
      : null,
    listError && onRetry
      ? createElement(
          "button",
          {
            type: "button",
            className: "shrink-0 text-[10px] underline",
            onClick: onRetry,
          },
          "再試行"
        )
      : null
  );
}
