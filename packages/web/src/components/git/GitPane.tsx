import type {
  ClientToServerEvents,
  GitCommit,
  GitRefs,
  GitStatus,
  ServerToClientEvents,
} from "@ark/shared";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { createGitApi, type GitApi } from "@/lib/git-api";
import { countChanges } from "@/lib/git-format";
import { cn } from "@/lib/utils";
import { GitCommitDetail } from "./GitCommitDetail";
import { GitCommitList } from "./GitCommitList";
import { GitSidebar } from "./GitSidebar";
import type { GitSelection } from "./types";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface GitPaneProps {
  socket: TypedSocket | null;
  sessionId: string;
  /**
   * このペインが実際に見えているか (作業エリアが開いていて、「Git」のタブで、
   * セッションが選択中)。見えていない間もマウントされたままなので、
   * 指紋の問い合わせは見えている間だけにする
   */
  isActive: boolean;
}

/** 1 回に読むコミット数 (サーバーの上限は 500) */
const PAGE_SIZE = 300;
/** 読み直しと、ref へ飛ぶための読み足しで持つ上限 */
const MAX_COMMITS = 3000;
const POLL_INTERVAL_MS = 3000;

const SIDEBAR_COLLAPSED_KEY = "ark-git-sidebar-collapsed";
const DETAIL_HEIGHT_KEY = "ark-git-detail-height";
const DEFAULT_DETAIL_RATIO = 0.45;
const MIN_DETAIL_RATIO = 0.2;
const MAX_DETAIL_RATIO = 0.8;

const clampRatio = (ratio: number) =>
  Math.min(MAX_DETAIL_RATIO, Math.max(MIN_DETAIL_RATIO, ratio));

function loadSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function loadDetailRatio(): number {
  try {
    const raw = localStorage.getItem(DETAIL_HEIGHT_KEY);
    const n = raw === null ? Number.NaN : Number.parseFloat(raw);
    return Number.isFinite(n) ? clampRatio(n) : DEFAULT_DETAIL_RATIO;
  } catch {
    return DEFAULT_DETAIL_RATIO;
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 保存できなくても動作には影響しない
  }
}

interface GitData {
  refs: GitRefs;
  status: GitStatus;
  commits: GitCommit[];
  hasMore: boolean;
}

type LoadResult = { ok: true; data: GitData } | { ok: false; error: string };

/** refs・status と、先頭から want 件ぶんのコミットを読む */
async function fetchAll(api: GitApi, want: number): Promise<LoadResult> {
  const [refs, status] = await Promise.all([api.refs(), api.status()]);
  if (!refs.ok) return { ok: false, error: refs.error };
  if (!status.ok) return { ok: false, error: status.error };
  const commits: GitCommit[] = [];
  let hasMore = false;
  while (commits.length < want) {
    const res = await api.log(
      commits.length,
      Math.min(PAGE_SIZE, want - commits.length)
    );
    if (!res.ok) {
      // コミットの無いリポジトリでは git log が失敗しうる。空として扱う
      if (refs.head.sha === null) break;
      return { ok: false, error: res.error };
    }
    commits.push(...res.commits);
    hasMore = res.hasMore;
    if (!res.hasMore || res.commits.length === 0) break;
  }
  return {
    ok: true,
    data: {
      refs: {
        head: refs.head,
        branches: refs.branches,
        remotes: refs.remotes,
        tags: refs.tags,
        stashes: refs.stashes,
      },
      status: {
        staged: status.staged,
        unstaged: status.unstaged,
        untracked: status.untracked,
      },
      commits,
      hasMore,
    },
  };
}

/** 何も選んでいないときの選択。HEAD、無ければ未コミットの変更 */
function defaultSelection(data: GitData): GitSelection | null {
  if (data.refs.head.sha) return { kind: "commit", sha: data.refs.head.sha };
  if (countChanges(data.status) > 0) return { kind: "working" };
  return null;
}

/**
 * 読み直したあとの選択。選んでいたコミットが一覧から消えたら (amend・reset 等) HEAD へ戻す。
 * 読み込み済みの範囲に元から無かったコミット (親のハッシュから飛んだ先) と、読み直しの
 * 範囲の外へ出ただけのコミットは、消えたとは言えないので保つ
 */
function reconcileSelection(
  prev: GitSelection | null,
  before: GitData | null,
  next: GitData
): GitSelection | null {
  if (!prev) return defaultSelection(next);
  if (prev.kind === "working") {
    return countChanges(next.status) > 0 ? prev : defaultSelection(next);
  }
  const indexIn = (data: GitData | null) =>
    data?.commits.findIndex(c => c.sha === prev.sha) ?? -1;
  const beforeIndex = indexIn(before);
  if (indexIn(next) !== -1 || beforeIndex === -1) return prev;
  // 読み直すのは上限 (3,000 件) までなので、それより先まで読み足していた分は一覧から
  // 落ちる。落ちただけのコミットは消えたとは言えない
  if (next.hasMore && beforeIndex >= next.commits.length) return prev;
  return defaultSelection(next);
}

/**
 * Git タブの器 (作業エリアの「Git」のタブの中身)。データの取得・選択・追従を持つ。
 * 左にサイドバー、右の上にコミット一覧、下に選んだコミットの詳細。
 *
 * 追従: 見えている間だけ3秒ごとに指紋 (HEAD・いまのブランチ・ref・status・indexのblob・
 * 変更中のファイルのmtimeと大きさ) を問い合わせ、変わったら読み直す。
 * 読み込みには通し番号を振り、あとから始めた読み込みだけがstateを書ける
 */
export function GitPane({ socket, sessionId, isActive }: GitPaneProps) {
  const api = useMemo(
    () => (socket ? createGitApi(socket, sessionId) : null),
    [socket, sessionId]
  );

  const [data, setData] = useState<GitData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  /** 続きの読み込みが失敗した理由。出ている間、一覧は自動では読み足さない */
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [selection, setSelection] = useState<GitSelection | null>(null);
  const [reveal, setReveal] = useState<{
    selection: GitSelection;
    seq: number;
  } | null>(null);
  /** 読み直すたびに増やす。詳細が未コミットの変更の差分を取り直す合図 */
  const [dataVersion, setDataVersion] = useState(0);

  const dataRef = useRef(data);
  dataRef.current = data;
  /** 読み込みの通し番号。最新の読み込みだけが state を書ける */
  const loadSeq = useRef(0);
  const lastFingerprint = useRef<string | null>(null);
  /** 最初の読み込みを試したか (成功・失敗を問わない) */
  const attempted = useRef(false);
  const polling = useRef(false);

  const revealSelection = useCallback((target: GitSelection) => {
    setReveal(prev => ({ selection: target, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

  /** refs・status・コミットを読み直す。読み込み済みの件数ぶん (上限 3,000) を読む */
  const reload = useCallback(async (): Promise<boolean> => {
    if (!api) return false;
    const seq = ++loadSeq.current;
    setReloading(true);
    const want = Math.min(
      MAX_COMMITS,
      Math.max(PAGE_SIZE, dataRef.current?.commits.length ?? 0)
    );
    const result = await fetchAll(api, want);
    // あとから始まった読み込みがある。古い結果は捨てる
    if (seq !== loadSeq.current) return false;
    setReloading(false);
    attempted.current = true;
    if (!result.ok) {
      // 既に出しているものがあれば、それを残す (一時的な失敗で画面を消さない)
      setError(result.error);
      // 覚えている指紋を捨てる。残すと、次の問い合わせが「変わっていない」と見て
      // 読み直さず、失敗の画面が消えない (最初の読み込み・再試行のボタンも同じ)
      lastFingerprint.current = null;
      return false;
    }
    const before = dataRef.current;
    dataRef.current = result.data;
    setData(result.data);
    setError(null);
    setLoadMoreError(null);
    setDataVersion(v => v + 1);
    setSelection(prev => reconcileSelection(prev, before, result.data));
    return true;
  }, [api]);

  /** 指紋を問い合わせ、変わっていたら読み直す。重ねては走らせない */
  const poll = useCallback(async () => {
    if (!api || polling.current) return;
    polling.current = true;
    try {
      const res = await api.fingerprint();
      const fingerprint = res.ok ? res.fingerprint : null;
      if (!attempted.current) {
        // 最初の 1 回は、指紋が取れなくても読みに行く (失敗の理由を出すため)
        lastFingerprint.current = fingerprint;
        await reload();
        return;
      }
      if (fingerprint === null || fingerprint === lastFingerprint.current) {
        return;
      }
      lastFingerprint.current = fingerprint;
      // 読み直しに失敗したら (別の読み込みに追い越された場合も)、次の問い合わせでもう一度試す
      if (!(await reload())) lastFingerprint.current = null;
    } finally {
      polling.current = false;
    }
  }, [api, reload]);

  // api が替わったら (再接続)、次の問い合わせで必ず読み直す
  // biome-ignore lint/correctness/useExhaustiveDependencies: api が替わったことだけを合図にする
  useEffect(() => {
    lastFingerprint.current = null;
    attempted.current = false;
    return () => {
      // 外したあとに届く応答で state を書かない
      loadSeq.current += 1;
    };
  }, [api]);

  // 見えている間だけ追従する。見えた瞬間にも 1 回問い合わせる
  useEffect(() => {
    if (!api || !isActive) return;
    void poll();
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [api, isActive, poll]);

  /**
   * 続きの 1 ページを読み足す。読み直しと重なったら結果を捨てる。
   * 読み足しの最中に呼ばれたら、同じ読み足しの結果を返す (二重に読まない)。
   * 失敗したら理由を残す (残っている間、一覧は自動では頼み直さない。呼ばれたら消して試す)
   */
  const loadMoreInFlight = useRef<Promise<boolean> | null>(null);
  const loadMore = useCallback((): Promise<boolean> => {
    if (loadMoreInFlight.current) return loadMoreInFlight.current;
    const current = dataRef.current;
    if (!api || !current?.hasMore) return Promise.resolve(false);
    const run = async () => {
      setLoadingMore(true);
      setLoadMoreError(null);
      const seq = loadSeq.current;
      const res = await api.log(current.commits.length, PAGE_SIZE);
      loadMoreInFlight.current = null;
      setLoadingMore(false);
      if (seq !== loadSeq.current || dataRef.current !== current) return false;
      if (!res.ok) {
        setLoadMoreError(res.error);
        return false;
      }
      const known = new Set(current.commits.map(c => c.sha));
      const next: GitData = {
        ...current,
        commits: [
          ...current.commits,
          ...res.commits.filter(c => !known.has(c.sha)),
        ],
        hasMore: res.hasMore && res.commits.length > 0,
      };
      dataRef.current = next;
      setData(next);
      return true;
    };
    const promise = run();
    loadMoreInFlight.current = promise;
    return promise;
  }, [api]);

  /**
   * sha のコミットを選んで一覧をそこへ寄せる。読み込み済みに無ければ、見つかるまで
   * 読み足す (上限 3,000 件)。詳細は sha だけで取れるので、選択は先に替える
   */
  const jumpSeq = useRef(0);
  const jumpTo = useCallback(
    async (sha: string) => {
      const seq = ++jumpSeq.current;
      const target: GitSelection = { kind: "commit", sha };
      setSelection(target);
      const loaded = () =>
        dataRef.current?.commits.some(c => c.sha === sha) ?? false;
      while (
        !loaded() &&
        dataRef.current?.hasMore &&
        dataRef.current.commits.length < MAX_COMMITS
      ) {
        if (!(await loadMore())) break;
        // 別の ref を押した。古い読み足しはここで止める
        if (seq !== jumpSeq.current) return;
      }
      if (loaded()) revealSelection(target);
    },
    [loadMore, revealSelection]
  );

  const selectWorking = useCallback(() => {
    const target: GitSelection = { kind: "working" };
    setSelection(target);
    revealSelection(target);
  }, [revealSelection]);

  const showAll = useCallback(() => {
    const head = dataRef.current?.refs.head.sha;
    if (head) void jumpTo(head);
  }, [jumpTo]);

  const handleRetry = useCallback(() => void reload(), [reload]);

  // 選んだコミットのいまのref。詳細はshaごとに応答を持ち続けるので、refだけは
  // 読み直した一覧から渡す (一覧に無いコミットはundefinedで、詳細が応答のrefを出す)
  const selectedSha = selection?.kind === "commit" ? selection.sha : null;
  const selectedRefs = useMemo(
    () =>
      selectedSha === null
        ? undefined
        : data?.commits.find(c => c.sha === selectedSha)?.refs,
    [data, selectedSha]
  );

  // ---- レイアウト ----
  const [sidebarCollapsed, setSidebarCollapsed] =
    useState(loadSidebarCollapsed);
  const toggleSidebar = () => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      save(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      return next;
    });
  };

  const columnRef = useRef<HTMLDivElement>(null);
  const [detailRatio, setDetailRatio] = useState(loadDetailRatio);
  const detailRatioRef = useRef(detailRatio);
  detailRatioRef.current = detailRatio;
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const rect = columnRef.current?.getBoundingClientRect();
      if (!rect || rect.height <= 0) return;
      // 詳細の高さ = 列の下端からカーソルまで
      setDetailRatio(clampRatio((rect.bottom - e.clientY) / rect.height));
    };
    const onUp = () => {
      setDragging(false);
      save(DETAIL_HEIGHT_KEY, String(detailRatioRef.current));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragging]);

  if (!api) {
    return <Centered>接続中…</Centered>;
  }
  if (!data) {
    if (error) {
      return (
        <Centered>
          <span role="alert">{error}</span>
          <button
            type="button"
            onClick={handleRetry}
            className="rounded-sm border border-border px-2.5 py-1 text-foreground hover:bg-muted"
          >
            再試行
          </button>
        </Centered>
      );
    }
    return <Skeleton />;
  }

  const changeCount = countChanges(data.status);
  const sidebarLabel = sidebarCollapsed
    ? "サイドバーを開く"
    : "サイドバーを折りたたむ";

  return (
    <div data-testid="git-pane" className="flex h-full min-h-0 bg-background">
      <div
        className={cn(
          "h-full w-[180px] shrink-0 border-border border-r",
          sidebarCollapsed && "hidden"
        )}
      >
        <GitSidebar
          refs={data.refs}
          changeCount={changeCount}
          selection={selection}
          onSelectWorking={selectWorking}
          onShowAll={showAll}
          onSelectSha={jumpTo}
        />
      </div>
      <div ref={columnRef} className="flex min-w-0 flex-1 flex-col">
        <div
          className="min-h-0"
          style={{ flex: `${1 - detailRatio} 1 0%` }}
          data-testid="git-list-area"
        >
          <GitCommitList
            commits={data.commits}
            headSha={data.refs.head.sha}
            workingCount={changeCount}
            selection={selection}
            onSelect={setSelection}
            hasMore={data.hasMore}
            loadingMore={loadingMore}
            loadMoreError={loadMoreError}
            onLoadMore={loadMore}
            onReload={handleRetry}
            reloading={reloading}
            reveal={reveal}
            leading={
              <button
                type="button"
                aria-label={sidebarLabel}
                title={sidebarLabel}
                aria-expanded={!sidebarCollapsed}
                onClick={toggleSidebar}
                className="inline-flex h-full w-8 shrink-0 items-center justify-center border-border border-r text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {sidebarCollapsed ? (
                  <PanelLeftOpen className="size-3.5" aria-hidden="true" />
                ) : (
                  <PanelLeftClose className="size-3.5" aria-hidden="true" />
                )}
              </button>
            }
          />
        </div>
        <button
          type="button"
          aria-label="一覧と詳細の高さを調整"
          onMouseDown={e => {
            e.preventDefault();
            setDragging(true);
          }}
          className={cn(
            "relative h-1 shrink-0 cursor-row-resize bg-border transition-colors hover:bg-primary/50",
            dragging && "bg-primary/70"
          )}
        >
          <span className="absolute inset-x-0 -top-1 -bottom-1" />
        </button>
        <div
          className="min-h-0"
          style={{ flex: `${detailRatio} 1 0%` }}
          data-testid="git-detail-area"
        >
          <GitCommitDetail
            api={api}
            selection={selection}
            status={data.status}
            refreshKey={dataVersion}
            refs={selectedRefs}
            onSelectCommit={jumpTo}
          />
        </div>
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 bg-background p-6 text-center text-muted-foreground text-xs">
      {children}
    </div>
  );
}

/** 最初の読み込みのあいだの骨組み (一覧の行の形) */
function Skeleton() {
  const widths = ["62%", "48%", "71%", "40%", "56%", "66%", "45%", "58%"];
  return (
    <div
      data-testid="git-skeleton"
      role="status"
      aria-label="読み込み中"
      className="h-full animate-pulse bg-background py-2"
    >
      {widths.map((width, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: 並びの変わらない飾り
          key={i}
          className="flex h-[28px] items-center gap-2 px-3"
        >
          <span className="size-2 shrink-0 rounded-full bg-muted" />
          <span className="h-2.5 rounded bg-muted" style={{ width }} />
        </div>
      ))}
    </div>
  );
}
