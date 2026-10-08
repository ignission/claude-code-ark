import type { FileTreeEntry } from "@ark/shared";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileApi } from "@/lib/file-api";
import { FileIcon } from "./FileIcon";

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

type Item =
  | { kind: "row"; row: Row }
  | { kind: "note"; key: string; depth: number; text: string; alert: boolean };

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
  D: "text-destructive",
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
  const [epoch, setEpoch] = useState(0);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const requested = useRef(new Set<string>());
  const failed = useRef(new Set<string>());
  // worktree / apiが変わるたびに増やし、古い世代の応答を捨てる
  const generation = useRef(0);
  // ディレクトリごとの要求番号。最新の要求だけがstateに書ける
  const requestSeq = useRef(new Map<string, number>());
  const apiRef = useRef(api);
  apiRef.current = api;

  // worktree / apiが変わったら世代を進め、キャッシュを捨てて読み直す。
  // worktreeが変わったときは展開状態も読み直す
  const lastWorktree = useRef(worktreePath);
  const lastApi = useRef(api);
  const resetPending = useRef(false);
  const lastEpoch = useRef(0);
  useEffect(() => {
    const worktreeChanged = lastWorktree.current !== worktreePath;
    if (!worktreeChanged && lastApi.current === api) return;
    lastWorktree.current = worktreePath;
    lastApi.current = api;
    generation.current += 1;
    requestSeq.current = new Map();
    requested.current = new Set();
    failed.current = new Set();
    resetPending.current = true;
    setListings(new Map());
    if (worktreeChanged) setExpanded(new Set(loadExpanded(worktreePath)));
    setEpoch(e => e + 1);
  }, [worktreePath, api]);

  const load = useCallback(async (dir: string) => {
    const gen = generation.current;
    const seq = (requestSeq.current.get(dir) ?? 0) + 1;
    requestSeq.current.set(dir, seq);
    requested.current.add(dir);
    const res = await apiRef.current.list(dir);
    if (gen !== generation.current || requestSeq.current.get(dir) !== seq) {
      return;
    }
    if (res.ok) failed.current.delete(dir);
    else failed.current.add(dir);
    setListings(prev => new Map(prev).set(dir, res));
  }, []);

  // ルートと、展開されていてまだ読んでいないディレクトリを読む。
  // リセット直後の1回目は、古い展開状態を新しい世代で読まないよう見送る
  useEffect(() => {
    if (resetPending.current && lastEpoch.current === epoch) return;
    resetPending.current = false;
    lastEpoch.current = epoch;
    for (const dir of ["", ...expanded]) {
      if (!requested.current.has(dir)) void load(dir);
    }
  }, [expanded, epoch, load]);

  // refreshSeqが増えたら展開中のものを読み直す (初回は上のeffectが読む)
  const lastSeq = useRef(refreshSeq);
  useEffect(() => {
    if (lastSeq.current === refreshSeq) return;
    lastSeq.current = refreshSeq;
    for (const dir of ["", ...expanded]) void load(dir);
  }, [refreshSeq, expanded, load]);

  // 展開状態の保存。worktreeが変わった直後の描画では、まだ旧worktreeの
  // 展開状態なので、新しいキーへ保存しないよう見送る
  const savedWorktree = useRef(worktreePath);
  useEffect(() => {
    if (savedWorktree.current !== worktreePath) {
      savedWorktree.current = worktreePath;
      return;
    }
    saveExpanded(worktreePath, expanded);
  }, [expanded, worktreePath]);

  const toggle = useCallback((dir: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (!next.delete(dir)) {
        next.add(dir);
        // 前回の読み込みが失敗していたら、開き直しで再試行する
        if (failed.current.has(dir)) requested.current.delete(dir);
      }
      return next;
    });
  }, []);

  const items = useMemo(() => {
    const out: Item[] = [];
    const walk = (dir: string, depth: number) => {
      const listing = listings.get(dir);
      if (!listing) return;
      if (!listing.ok) {
        out.push({
          kind: "note",
          key: `${dir}#error`,
          depth,
          text: listing.error,
          alert: dir === "",
        });
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
          kind: "row",
          row: {
            path,
            name: e.name,
            type: e.type,
            depth,
            gitStatus: e.gitStatus,
          },
        });
        if (e.type === "dir" && expanded.has(path)) walk(path, depth + 1);
      }
      if (listing.truncated) {
        out.push({
          kind: "note",
          key: `${dir}#truncated`,
          depth,
          text: "…件数が多いため一部だけ表示しています",
          alert: false,
        });
      }
    };
    walk("", 0);
    return out;
  }, [listings, expanded]);

  const rows = useMemo(
    () => items.flatMap(i => (i.kind === "row" ? [i.row] : [])),
    [items]
  );
  // roving tabindex: タブ停止は1行だけ。フォーカス行が消えたら先頭に戻す
  const tabStop = rows.some(r => r.path === focusedPath)
    ? focusedPath
    : (rows[0]?.path ?? null);

  const focusRow = (path: string | undefined) => {
    if (!path) return;
    setFocusedPath(path);
    for (const el of containerRef.current?.querySelectorAll<HTMLElement>(
      "[data-path]"
    ) ?? []) {
      if (el.dataset.path === path) el.focus();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent, row: Row, index: number) => {
    const isOpen = row.type === "dir" && expanded.has(row.path);
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
    } else if (e.key === "ArrowRight" && row.type === "dir" && !isOpen) {
      e.preventDefault();
      toggle(row.path);
    } else if (e.key === "ArrowLeft" && row.type === "dir" && isOpen) {
      e.preventDefault();
      toggle(row.path);
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
        {items.map(item => {
          if (item.kind === "note") {
            return (
              <p
                key={item.key}
                role={item.alert ? "alert" : undefined}
                style={{ paddingLeft: 8 + item.depth * 12 }}
                className="py-1 pr-2 text-muted-foreground text-xs"
              >
                {item.text}
              </p>
            );
          }
          const row = item.row;
          const i = rows.indexOf(row);
          const isDir = row.type === "dir";
          const isOpen = isDir && expanded.has(row.path);
          return (
            <div
              key={row.path}
              role="treeitem"
              tabIndex={row.path === tabStop ? 0 : -1}
              onFocus={() => setFocusedPath(row.path)}
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
              <FileIcon
                name={row.name}
                kind={isDir ? "dir" : "file"}
                open={isOpen}
              />
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
      </div>
    </div>
  );
}
