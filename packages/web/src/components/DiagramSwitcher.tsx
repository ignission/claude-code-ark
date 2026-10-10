/**
 * DiagramSwitcher - 図の切り替え。いまの図の名前を出すバーと、押すと開く図の一覧
 *
 * 一覧は Finder のリスト表示に寄せる (名前・種類・更新日時の列。既定は更新の新しい順)。
 * 以前はプルダウン 1 本で、名前しか見えず、どれが新しい図かも分からなかった。
 *
 * - 一覧は図の上に重ねて開く (DiagramPane の根が `relative`)。図を選ぶ / Esc / バーを
 *   もう一度押すと閉じる。図をまだ選んでいないときは、開いた状態から始める
 * - 一覧は `role="listbox"` で、矢印・Home / End・PageUp / PageDown・Enter で動く。
 *   ノーマルモードの j / k / gg / G もここへ届く (keynav-dom が作業エリアの listbox へ送る)
 * - 削除は行ごとのボタンから。確認のダイアログは 1 つを使い回す
 * - 並べ方と絞り込みは lib/diagram-browser.ts
 */

import type { DiagramKind, DiagramListItem } from "@ark/shared";
import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  ChevronDown,
  FileText,
  Layers,
  ListTree,
  type LucideIcon,
  Trash2,
  Workflow,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  browseDiagrams,
  DIAGRAM_KIND_LABEL,
  type DiagramSort,
  type DiagramSortKey,
  diagramKind,
  diagramShortPath,
  formatDiagramTime,
  loadDiagramSort,
  saveDiagramSort,
  toggleDiagramSort,
} from "@/lib/diagram-browser";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
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
  /** 削除の結果の知らせ (失敗の理由や、残ったファイルの警告)。一覧の中にも出す */
  notice?: string | null;
}

const KIND_ICON: Readonly<Record<DiagramKind, LucideIcon>> = {
  deck: Layers,
  doc: FileText,
  sequence: ArrowLeftRight,
  "call-tree": ListTree,
  graph: Workflow,
};

const COLUMNS: ReadonlyArray<{
  key: DiagramSortKey;
  label: string;
  className: string;
}> = [
  { key: "name", label: "名前", className: "min-w-0 flex-1" },
  { key: "kind", label: "種類", className: "w-24 shrink-0" },
  { key: "mtime", label: "更新", className: "w-24 shrink-0" },
];

/** PageUp / PageDown で動かす行数 */
const PAGE_ROWS = 10;

export function getDiagramDeleteWarning(item: DiagramListItem): string {
  return item.tracked
    ? "図と隣接するコメント sidecar も削除します。図は worktree に削除差分が残ります。必要なら Git で復元できます。ただし Git 未追跡のファイルは復元できません。この操作は取り消せません。"
    : "図と隣接するコメント sidecar も削除します。Git 未追跡のファイルは復元できません。この操作は取り消せません。";
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
  notice = null,
}: DiagramSwitcherProps) {
  // 図をまだ選んでいないときは、一覧を開いた状態から始める
  const [open, setOpen] = useState(currentRelPath === undefined);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<DiagramSort>(loadDiagramSort);
  const [active, setActive] = useState<string | undefined>(currentRelPath);
  // 消す図はパスで持つ。確認を開いている間に一覧が読み直されたら (Git の追跡が
  // 変わって断られた、など)、新しい行の内容で確認と次の試行をやり直せるようにする
  const [deleteTargetPath, setDeleteTargetPath] = useState<string | null>(null);
  const deleteTarget =
    diagrams.find(diagram => diagram.relPath === deleteTargetPath) ?? null;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const currentItem = diagrams.find(
    diagram => diagram.relPath === currentRelPath
  );
  const rows = useMemo(
    () => browseDiagrams(diagrams, query, sort),
    [diagrams, query, sort]
  );
  const activeIndex = Math.max(
    0,
    rows.findIndex(row => row.relPath === active)
  );
  const activeRow = rows[activeIndex];
  const deletePending = isDeleting || confirmingDelete;
  const canDelete = !!onDelete && isConnected && !listLoading && !deletePending;
  const now = new Date();

  // 見せる図が替わったら一覧を閉じる (復元や Claude の board_open で図が開いたのに、
  // 一覧が上に重なったままにしない)。図が無くなったら、選べるように開く
  useEffect(() => {
    setOpen(currentRelPath === undefined);
  }, [currentRelPath]);

  // 開いたら、いまの図の行を選び、絞り込みの欄へフォーカスを置く
  // biome-ignore lint/correctness/useExhaustiveDependencies: 開いた瞬間だけ合わせる (開いている間の選択は利用者が動かす)
  useEffect(() => {
    if (!open) return;
    setActive(currentRelPath);
    searchRef.current?.focus();
  }, [open]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 選んでいる行が変わるたびに、見える位置へ寄せる
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeRow?.relPath]);

  const choose = (item: DiagramListItem | undefined) => {
    if (!item) return;
    onSelect(item.relPath);
    setOpen(false);
    setQuery("");
  };

  const moveTo = (index: number) => {
    const next = rows[Math.min(rows.length - 1, Math.max(0, index))];
    if (next) setActive(next.relPath);
  };

  /** 一覧と絞り込みの欄の両方で効くキー。扱ったら true */
  const handleListKey = (event: React.KeyboardEvent): boolean => {
    switch (event.key) {
      case "ArrowDown":
        moveTo(activeIndex + 1);
        return true;
      case "ArrowUp":
        moveTo(activeIndex - 1);
        return true;
      case "PageDown":
        moveTo(activeIndex + PAGE_ROWS);
        return true;
      case "PageUp":
        moveTo(activeIndex - PAGE_ROWS);
        return true;
      case "Enter":
        choose(activeRow);
        return true;
      case "Escape":
        // 図を選んでいないときは、閉じても見せるものが無い
        if (currentRelPath === undefined) return false;
        setOpen(false);
        return true;
      default:
        return false;
    }
  };

  const changeSort = (key: DiagramSortKey) => {
    const next = toggleDiagramSort(sort, key);
    setSort(next);
    saveDiagramSort(next);
  };

  const CurrentIcon =
    KIND_ICON[currentItem ? diagramKind(currentItem) : "graph"];
  const currentLabel =
    currentItem?.displayName ??
    (currentRelPath
      ? (currentRelPath.split("/").at(-1) ?? currentRelPath)
      : diagrams.length === 0
        ? "図がありません"
        : "図を選択");

  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-2 px-2">
        <button
          type="button"
          aria-label="図の一覧"
          aria-expanded={open}
          title={currentRelPath}
          className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md bg-well px-2 text-left text-xs text-foreground transition-colors hover:bg-accent"
          onClick={() => setOpen(value => !value)}
        >
          <CurrentIcon
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate font-medium">
            {currentLabel}
          </span>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {diagrams.length}件
          </span>
          <ChevronDown
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180"
            )}
            aria-hidden="true"
          />
        </button>
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
      {open && (
        <div
          data-diagram-browser=""
          className="absolute inset-x-0 top-10 bottom-0 z-20 flex flex-col bg-card"
        >
          {/* 一覧は図の上を覆うので、DiagramPane がバーの下に出す知らせが隠れる */}
          {notice && (
            <div
              role="status"
              className="mx-2 mb-1.5 shrink-0 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {notice}
            </div>
          )}
          <div className="shrink-0 px-2 pb-1.5">
            <input
              ref={searchRef}
              type="search"
              value={query}
              aria-label="図を探す"
              placeholder="図を探す"
              spellCheck={false}
              autoComplete="off"
              className="block h-8 w-full rounded-md bg-well px-2.5 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) {
                  return;
                }
                if (handleListKey(event)) event.preventDefault();
              }}
            />
          </div>
          <div className="flex shrink-0 items-center gap-2 px-4 pb-1 text-[11px] text-muted-foreground">
            {COLUMNS.map(column => (
              <button
                key={column.key}
                type="button"
                aria-label={`${column.label}で並べ替え`}
                aria-pressed={sort.key === column.key}
                className={cn(
                  "flex items-center gap-1 text-left hover:text-foreground",
                  column.className,
                  sort.key === column.key && "font-semibold text-foreground"
                )}
                onClick={() => changeSort(column.key)}
              >
                {column.label}
                {sort.key === column.key &&
                  (sort.dir === "asc" ? (
                    <ArrowUp className="size-3" aria-hidden="true" />
                  ) : (
                    <ArrowDown className="size-3" aria-hidden="true" />
                  ))}
              </button>
            ))}
            {/* 行の削除ボタンのぶんの幅 */}
            <span className="w-6 shrink-0" />
          </div>
          <div
            ref={listRef}
            role="listbox"
            tabIndex={0}
            aria-label="図"
            aria-activedescendant={
              activeRow ? `diagram-row-${activeIndex}` : undefined
            }
            className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 outline-none"
            onKeyDown={event => {
              // 行の中のボタン (削除) にフォーカスがあるときは、そのボタンに任せる
              if (event.target !== event.currentTarget) return;
              if (event.key === "Home") {
                moveTo(0);
                event.preventDefault();
              } else if (event.key === "End") {
                moveTo(rows.length - 1);
                event.preventDefault();
              } else if (handleListKey(event)) {
                event.preventDefault();
              }
            }}
          >
            {rows.length === 0 && (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                {diagrams.length === 0
                  ? "図がありません"
                  : "一致する図がありません"}
              </p>
            )}
            {rows.map((item, index) => {
              const Icon = KIND_ICON[diagramKind(item)];
              const selected = index === activeIndex;
              const current = item.relPath === currentRelPath;
              return (
                // biome-ignore lint/a11y/useKeyWithClickEvents: キーは親の listbox が受ける (行はフォーカスを持たない)
                <div
                  key={item.relPath}
                  id={`diagram-row-${index}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={selected}
                  aria-current={current ? "true" : undefined}
                  title={`${item.relPath}（${item.tracked ? "Git管理" : "未追跡"}）`}
                  className={cn(
                    "group flex h-9 cursor-default items-center gap-2 rounded-lg px-2 text-[13px]",
                    selected && "bg-well"
                  )}
                  onMouseMove={() => setActive(item.relPath)}
                  onClick={() => choose(item)}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <Icon
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span
                      className={cn("truncate", current && "font-semibold")}
                    >
                      {item.displayName}
                    </span>
                    {item.displayName !== item.relPath.split("/").at(-1) && (
                      <span className="min-w-0 shrink truncate text-[11px] text-muted-foreground">
                        {diagramShortPath(item.relPath)}
                      </span>
                    )}
                  </span>
                  <span className="w-24 shrink-0 truncate text-muted-foreground">
                    {DIAGRAM_KIND_LABEL[diagramKind(item)]}
                  </span>
                  <span className="w-24 shrink-0 truncate tabular-nums text-muted-foreground">
                    {formatDiagramTime(item.mtimeMs, now)}
                  </span>
                  <button
                    type="button"
                    aria-label={`「${item.displayName}」を削除`}
                    disabled={!canDelete}
                    className={cn(
                      "inline-flex size-6 shrink-0 items-center justify-center rounded text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40",
                      !selected && "opacity-0 group-hover:opacity-100"
                    )}
                    onClick={event => {
                      event.stopPropagation();
                      setDeleteTargetPath(item.relPath);
                    }}
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={next => {
          if (!next && !deletePending) setDeleteTargetPath(null);
        }}
      >
        {deleteTarget && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                「{deleteTarget.displayName}」を削除しますか？
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2">
                  <p className="break-all">{deleteTarget.relPath}</p>
                  <p>{deleteTarget.tracked ? "Git管理" : "未追跡"}</p>
                  <p>{getDiagramDeleteWarning(deleteTarget)}</p>
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
                      deleteTarget,
                      onDelete
                    );
                    if (succeeded) setDeleteTargetPath(null);
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
    </>
  );
}
