import type { FileTreeEntry } from "@ark/shared";
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileApi } from "@/lib/file-api";

interface Props {
  api: Pick<FileApi, "list">;
  /** 展開状態の保存キーに使う */
  worktreePath: string;
  /** 相対パス。該当行を強調する */
  activeFilePath: string | null;
  onOpenFile: (filePath: string) => void;
  /** 増えたら、展開中のディレクトリを読み直す (保存後・ファイル更新後) */
  refreshSeq: number;
}

type Listing =
  | { ok: true; entries: FileTreeEntry[]; truncated: boolean }
  | { ok: false; error: string };

interface Row {
  path: string;
  name: string;
  type: "dir" | "file";
  depth: number;
  gitStatus?: FileTreeEntry["gitStatus"];
}

const STATUS_CLASS: Record<NonNullable<FileTreeEntry["gitStatus"]>, string> = {
  M: "text-amber-500",
  A: "text-green-500",
  "?": "text-green-500",
  D: "text-red-500",
};

const storageKey = (worktreePath: string) =>
  `ark-file-tree-expanded:${worktreePath}`;

function loadExpanded(worktreePath: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(worktreePath));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

function saveExpanded(worktreePath: string, expanded: Set<string>) {
  try {
    localStorage.setItem(
      storageKey(worktreePath),
      JSON.stringify([...expanded])
    );
  } catch {
    // 保存できなくても動作には影響しない
  }
}

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

export function FileTree({
  api,
  worktreePath,
  activeFilePath,
  onOpenFile,
  refreshSeq,
}: Props) {
  const [expanded, setExpanded] = useState(
    () => new Set(loadExpanded(worktreePath))
  );
  const [listings, setListings] = useState<Map<string, Listing>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const requested = useRef(new Set<string>());
  const apiRef = useRef(api);
  apiRef.current = api;

  // worktree が変わったら展開状態を読み直し、キャッシュを捨てる
  const lastWorktree = useRef(worktreePath);
  useEffect(() => {
    if (lastWorktree.current === worktreePath) return;
    lastWorktree.current = worktreePath;
    requested.current = new Set();
    setListings(new Map());
    setExpanded(new Set(loadExpanded(worktreePath)));
  }, [worktreePath]);

  const load = useCallback(async (dir: string) => {
    requested.current.add(dir);
    const res = await apiRef.current.list(dir);
    setListings(prev => new Map(prev).set(dir, res));
  }, []);

  // ルートと、展開されていてまだ読んでいないディレクトリを読む
  useEffect(() => {
    for (const dir of ["", ...expanded]) {
      if (!requested.current.has(dir)) void load(dir);
    }
  }, [expanded, load]);

  // refreshSeq が増えたら展開中のものを読み直す (初回は上の effect が読む)
  const lastSeq = useRef(refreshSeq);
  useEffect(() => {
    if (lastSeq.current === refreshSeq) return;
    lastSeq.current = refreshSeq;
    for (const dir of ["", ...expanded]) void load(dir);
  }, [refreshSeq, expanded, load]);

  const toggle = useCallback(
    (dir: string) => {
      setExpanded(prev => {
        const next = new Set(prev);
        if (!next.delete(dir)) next.add(dir);
        saveExpanded(worktreePath, next);
        return next;
      });
    },
    [worktreePath]
  );

  const { rows, notes } = useMemo(() => {
    const out: Row[] = [];
    const messages: Array<{ key: string; depth: number; text: string }> = [];
    const walk = (dir: string, depth: number) => {
      const listing = listings.get(dir);
      if (!listing) return;
      if (!listing.ok) {
        messages.push({ key: dir, depth, text: listing.error });
        return;
      }
      const sorted = [...listing.entries].sort((a, b) =>
        a.type === b.type
          ? a.name.localeCompare(b.name)
          : a.type === "dir"
            ? -1
            : 1
      );
      for (const e of sorted) {
        const path = join(dir, e.name);
        out.push({
          path,
          name: e.name,
          type: e.type,
          depth,
          gitStatus: e.gitStatus,
        });
        if (e.type === "dir" && expanded.has(path)) walk(path, depth + 1);
      }
      if (listing.truncated) {
        messages.push({
          key: `${dir}#truncated`,
          depth,
          text: "…件数が多いため一部だけ表示しています",
        });
      }
    };
    walk("", 0);
    return { rows: out, notes: messages };
  }, [listings, expanded]);

  const rootError = listings.get("");
  const focusRow = (path: string | undefined) => {
    if (!path) return;
    for (const el of containerRef.current?.querySelectorAll<HTMLElement>(
      "[data-path]"
    ) ?? []) {
      if (el.dataset.path === path) el.focus();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent, row: Row, index: number) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(rows[index + 1]?.path);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusRow(rows[index - 1]?.path);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (row.type === "dir") toggle(row.path);
      else onOpenFile(row.path);
    }
  };

  const refreshAll = () => {
    for (const dir of ["", ...expanded]) void load(dir);
  };

  return (
    <div className="flex h-full min-h-0 flex-col text-[13px]">
      <div className="flex shrink-0 items-center justify-between border-b px-2 py-1">
        <span className="text-muted-foreground text-xs">ファイル</span>
        <button
          type="button"
          aria-label="再読み込み"
          title="再読み込み"
          onClick={refreshAll}
          className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>
      <div
        ref={containerRef}
        role="tree"
        aria-label="ファイルツリー"
        className="min-h-0 flex-1 overflow-auto py-1"
      >
        {rows.map((row, i) => {
          const isDir = row.type === "dir";
          const isOpen = isDir && expanded.has(row.path);
          return (
            <div
              key={row.path}
              role="treeitem"
              tabIndex={0}
              data-path={row.path}
              aria-level={row.depth + 1}
              aria-selected={!isDir && row.path === activeFilePath}
              aria-expanded={isDir ? isOpen : undefined}
              title={row.path}
              onClick={() => (isDir ? toggle(row.path) : onOpenFile(row.path))}
              onKeyDown={e => onKeyDown(e, row, i)}
              style={{ paddingLeft: 8 + row.depth * 12 }}
              className={`flex h-[26px] cursor-pointer items-center gap-1 pr-2 outline-none hover:bg-muted focus-visible:bg-muted ${
                !isDir && row.path === activeFilePath ? "bg-muted" : ""
              }`}
            >
              {isDir ? (
                isOpen ? (
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                )
              ) : (
                <span className="size-3.5 shrink-0" />
              )}
              {isDir ? (
                <Folder className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <File className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              {row.gitStatus && (
                <span
                  className={`shrink-0 font-mono text-xs ${STATUS_CLASS[row.gitStatus]}`}
                >
                  {row.gitStatus}
                </span>
              )}
            </div>
          );
        })}
        {notes.map(n => (
          <p
            key={n.key}
            role={
              rootError && !rootError.ok && n.key === "" ? "alert" : undefined
            }
            style={{ paddingLeft: 8 + n.depth * 12 }}
            className="py-1 pr-2 text-muted-foreground text-xs"
          >
            {n.text}
          </p>
        ))}
      </div>
    </div>
  );
}
