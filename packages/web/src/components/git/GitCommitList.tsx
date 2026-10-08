import type { GitCommit } from "@ark/shared";
import { RefreshCw, Search, X } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  filterCommits,
  formatAbsoluteTime,
  formatRelativeTime,
  shortSha,
} from "@/lib/git-format";
import type { GraphRow } from "@/lib/git-graph";
import { layoutGraphWithWorking } from "@/lib/git-graph-rows";
import { cn } from "@/lib/utils";
import { GitAvatar } from "./GitAvatar";
import { GitGraphCell, GRAPH_ROW_HEIGHT, laneColor } from "./GitGraphCell";
import { GitRefLabels } from "./GitRefLabels";
import type { GitSelection } from "./types";

interface GitCommitListProps {
  /** 読み込み済みのコミット (新しい順) */
  commits: readonly GitCommit[];
  headSha: string | null;
  /** 未コミットの変更の数。0 なら先頭の行を出さない */
  workingCount: number;
  selection: GitSelection | null;
  onSelect: (selection: GitSelection) => void;
  /** まだ続きがある */
  hasMore: boolean;
  loadingMore: boolean;
  /**
   * 続きの読み込みが失敗した理由。出ている間は自動では頼まない (末尾が見えたままだと
   * 失敗するたびに頼み直し続けてしまう)。「再試行」でonLoadMoreを呼ぶ
   */
  loadMoreError?: string | null;
  onLoadMore: () => void;
  onReload: () => void;
  reloading?: boolean;
  /** seq が変わったら、その行が見える位置へスクロールする (サイドバーから飛ぶとき) */
  reveal?: { selection: GitSelection; seq: number } | null;
  /** 絞り込みの左に置くもの (サイドバーの開閉) */
  leading?: ReactNode;
  /** 相対時刻の基準 (テスト用)。未指定は描画時の現在時刻 */
  now?: number;
}

type Item =
  | { kind: "working"; row: GraphRow | null }
  | { kind: "commit"; commit: GitCommit; row: GraphRow | null };

/** 見えている範囲の上下に余分に描く行数 */
const OVERSCAN = 8;
/** ref の札はこれを超えたら「+n」にまとめる */
const MAX_REFS = 3;

const itemSelection = (item: Item): GitSelection =>
  item.kind === "working"
    ? { kind: "working" }
    : { kind: "commit", sha: item.commit.sha };

const isSelected = (item: Item, selection: GitSelection | null) =>
  selection !== null &&
  (item.kind === "working"
    ? selection.kind === "working"
    : selection.kind === "commit" && selection.sha === item.commit.sha);

/**
 * コミット一覧。行は固定高 (28px) で、見えている範囲とその前後だけを描く
 * (数千件を読み込んでも DOM は数十行)。グラフは行ごとの SVG を縦に継いで見せる
 */
export function GitCommitList({
  commits,
  headSha,
  workingCount,
  selection,
  onSelect,
  hasMore,
  loadingMore,
  loadMoreError = null,
  onLoadMore,
  onReload,
  reloading = false,
  reveal = null,
  leading,
  now,
}: GitCommitListProps) {
  const [query, setQuery] = useState("");
  const filtering = query.trim() !== "";
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const domId = useId();

  const items = useMemo<Item[]>(() => {
    if (filtering) {
      // 絞り込み中は行が飛び飛びになるので、グラフは描かない
      return filterCommits(commits, query).map(commit => ({
        kind: "commit",
        commit,
        row: null,
      }));
    }
    const layout = layoutGraphWithWorking(commits, headSha, workingCount > 0);
    const list: Item[] = commits.map((commit, i) => ({
      kind: "commit",
      commit,
      row: layout.rows[i] ?? null,
    }));
    if (workingCount > 0)
      list.unshift({ kind: "working", row: layout.working });
    return list;
  }, [commits, headSha, workingCount, filtering, query]);

  // 表示領域の高さ。隠れている間 (display:none) は 0 で、見えたときに測り直す
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() =>
      setViewportHeight(el.clientHeight)
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    // ResizeObserver の無い環境でも高さを拾う
    if (el.clientHeight !== viewportHeight) setViewportHeight(el.clientHeight);
  };

  const first = Math.max(
    0,
    Math.floor(scrollTop / GRAPH_ROW_HEIGHT) - OVERSCAN
  );
  const last = Math.min(
    items.length,
    Math.ceil((scrollTop + viewportHeight) / GRAPH_ROW_HEIGHT) + OVERSCAN
  );

  // 末尾が見える位置まで来たら続きを読む。絞り込み中は自動では読まない
  // (一致が少ないと末尾が見えたままになり、上限まで読み続けてしまう)
  const nearEnd =
    viewportHeight > 0 &&
    scrollTop + viewportHeight >= (items.length - 4) * GRAPH_ROW_HEIGHT;
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;
  useEffect(() => {
    if (nearEnd && hasMore && !loadingMore && !loadMoreError && !filtering) {
      onLoadMoreRef.current();
    }
  }, [nearEnd, hasMore, loadingMore, loadMoreError, filtering]);

  /** index の行が見える位置へスクロールする。center は中央へ寄せる */
  const scrollToIndex = useCallback((index: number, center = false) => {
    const el = scrollerRef.current;
    if (!el || index < 0) return;
    const top = index * GRAPH_ROW_HEIGHT;
    const height = el.clientHeight;
    let next = el.scrollTop;
    if (center) {
      next = Math.max(0, top - (height - GRAPH_ROW_HEIGHT) / 2);
    } else if (top < el.scrollTop) {
      next = top;
    } else if (top + GRAPH_ROW_HEIGHT > el.scrollTop + height) {
      next = top + GRAPH_ROW_HEIGHT - height;
    }
    if (next !== el.scrollTop) {
      el.scrollTop = next;
      setScrollTop(next);
    }
  }, []);

  // サイドバーから飛んだとき。items を ref で読み、seq が変わったときだけ動く
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const revealSeq = reveal?.seq;
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  useEffect(() => {
    const target = revealRef.current;
    if (revealSeq === undefined || !target) return;
    scrollToIndex(
      itemsRef.current.findIndex(item => isSelected(item, target.selection)),
      true
    );
  }, [revealSeq, scrollToIndex]);

  const selectedIndex = items.findIndex(item => isSelected(item, selection));

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (items.length === 0) return;
    const page = Math.max(
      1,
      Math.floor((scrollerRef.current?.clientHeight ?? 0) / GRAPH_ROW_HEIGHT) -
        1
    );
    const current = selectedIndex === -1 ? 0 : selectedIndex;
    const lastIndex = items.length - 1;
    const next =
      e.key === "ArrowDown"
        ? selectedIndex === -1
          ? 0
          : Math.min(lastIndex, current + 1)
        : e.key === "ArrowUp"
          ? Math.max(0, current - 1)
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? lastIndex
              : e.key === "PageDown"
                ? Math.min(lastIndex, current + page)
                : e.key === "PageUp"
                  ? Math.max(0, current - page)
                  : null;
    if (next === null) return;
    e.preventDefault();
    scrollToIndex(next);
    if (next !== selectedIndex) onSelect(itemSelection(items[next]));
  };

  const nowMs = now ?? Date.now();
  const optionId = (index: number) => `${domId}-row-${index}`;
  const selectedRendered = selectedIndex >= first && selectedIndex < last;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 pr-1.5">
        {leading}
        <label className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2 text-muted-foreground">
          <Search className="size-3.5 shrink-0" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={e => {
              setQuery(e.target.value);
              // 絞り込むと行数が変わる。先頭へ戻す
              if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
              setScrollTop(0);
            }}
            placeholder="件名・作者・ハッシュで絞り込み"
            aria-label="コミットを絞り込む"
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70 [&::-webkit-search-cancel-button]:hidden"
          />
        </label>
        {filtering && (
          <>
            <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
              {items.length}件
            </span>
            <button
              type="button"
              aria-label="絞り込みを解除"
              title="絞り込みを解除"
              onClick={() => setQuery("")}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </>
        )}
        <button
          type="button"
          aria-label="読み直す"
          title="読み直す"
          onClick={onReload}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <RefreshCw
            className={cn("size-3.5", reloading && "animate-spin")}
            aria-hidden="true"
          />
        </button>
      </div>

      <div
        ref={scrollerRef}
        role="listbox"
        aria-label="コミット"
        aria-activedescendant={
          selectedRendered ? optionId(selectedIndex) : undefined
        }
        tabIndex={0}
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {items.length === 0 ? (
          <div className="p-6 text-center text-muted-foreground text-xs">
            {filtering
              ? "一致するコミットがありません"
              : "コミットがありません"}
          </div>
        ) : (
          // 全行ぶんの高さを確保し、見えている行だけを絶対位置で置く
          <div
            className="relative"
            style={{ height: items.length * GRAPH_ROW_HEIGHT }}
          >
            {items.slice(first, last).map((item, offset) => {
              const index = first + offset;
              const selected = index === selectedIndex;
              return (
                // biome-ignore lint/a11y/useFocusableInteractive: フォーカスは listbox が持ち、aria-activedescendant で行を指す
                // biome-ignore lint/a11y/useKeyWithClickEvents: キー操作は listbox 側で受ける
                <div
                  key={item.kind === "working" ? "working" : item.commit.sha}
                  id={optionId(index)}
                  role="option"
                  aria-selected={selected}
                  data-sha={
                    item.kind === "commit" ? item.commit.sha : undefined
                  }
                  data-kind={item.kind}
                  onClick={() => onSelect(itemSelection(item))}
                  className={cn(
                    "absolute inset-x-0 flex cursor-default items-center gap-1.5 pr-2.5 text-[13px]",
                    selected
                      ? "bg-primary/20 text-foreground"
                      : "hover:bg-muted/60"
                  )}
                  style={{
                    top: index * GRAPH_ROW_HEIGHT,
                    height: GRAPH_ROW_HEIGHT,
                  }}
                >
                  {item.row ? (
                    <GitGraphCell
                      row={item.row}
                      isWorking={item.kind === "working"}
                      isHead={
                        item.kind === "commit" && item.commit.sha === headSha
                      }
                    />
                  ) : (
                    <span className="w-2 shrink-0" />
                  )}
                  {item.kind === "working" ? (
                    <span className="min-w-0 flex-1 truncate font-semibold">
                      未コミットの変更 ({workingCount})
                    </span>
                  ) : (
                    <CommitCells
                      commit={item.commit}
                      color={laneColor(item.row?.color ?? 0)}
                      detachedHead={item.commit.sha === headSha}
                      nowMs={nowMs}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
        {hasMore && items.length > 0 && (
          <div className="flex h-8 items-center justify-center text-[12px] text-muted-foreground">
            {loadingMore ? (
              "読み込み中…"
            ) : loadMoreError ? (
              <span
                role="alert"
                title={loadMoreError}
                className="flex items-center gap-2"
              >
                続きを読み込めませんでした
                <button
                  type="button"
                  onClick={onLoadMore}
                  className="rounded-sm border border-border px-2 py-0.5 text-foreground hover:bg-muted"
                >
                  再試行
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={onLoadMore}
                className="rounded-sm px-2 py-0.5 hover:bg-muted hover:text-foreground"
              >
                さらに読み込む
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface CommitCellsProps {
  commit: GitCommit;
  color: string;
  /** HEAD のコミット。ブランチの札が無い (detached) ときに「HEAD」の札を出す */
  detachedHead: boolean;
  nowMs: number;
}

/** ref の札・件名・作者・時刻 */
function CommitCells({ commit, color, detachedHead, nowMs }: CommitCellsProps) {
  const refs =
    detachedHead && !commit.refs.some(r => r.kind === "head")
      ? [{ kind: "head" as const, name: "HEAD" }, ...commit.refs]
      : commit.refs;
  return (
    <>
      {refs.length > 0 && (
        // 狭いときは札のほうを縮め、件名に幅を残す (札が件名と作者を押し出さない)
        <span className="flex max-w-[60%] shrink-[2] items-center gap-1 overflow-hidden">
          <GitRefLabels refs={refs} color={color} max={MAX_REFS} />
        </span>
      )}
      <span
        className="min-w-[4.5rem] flex-1 basis-[4.5rem] truncate"
        title={commit.subject}
      >
        {commit.subject}
      </span>
      <GitAvatar name={commit.authorName} email={commit.authorEmail} />
      <span
        className="w-[68px] shrink-0 text-right text-[12px] text-muted-foreground tabular-nums"
        title={`${formatAbsoluteTime(commit.authorTime)} · ${shortSha(commit.sha)}`}
      >
        {formatRelativeTime(commit.authorTime, nowMs)}
      </span>
    </>
  );
}
