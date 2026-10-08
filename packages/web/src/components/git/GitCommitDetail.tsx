import type {
  GitCommitDetail as CommitDetail,
  GitDiffTarget,
  GitFileChange,
  GitFileDiff,
  GitRef,
  GitStatus,
} from "@ark/shared";
import { Check, Copy, ExternalLink } from "lucide-react";
import {
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { GitApi } from "@/lib/git-api";
import {
  formatAbsoluteTime,
  formatRelativeTime,
  shortSha,
} from "@/lib/git-format";
import { cn } from "@/lib/utils";
import { FileIcon } from "../FileIcon";
import { GitAvatar } from "./GitAvatar";
import { GitRefLabels } from "./GitRefLabels";
import type { GitSelection } from "./types";

// @codemirror/merge を初期バンドルに入れない
const GitDiffView = lazy(() => import("./GitDiffView"));

interface GitCommitDetailProps {
  api: Pick<GitApi, "commit" | "fileDiff">;
  selection: GitSelection | null;
  /** 未コミットの変更 (selection が working のときに使う) */
  status: GitStatus | null;
  /**
   * 読み直すたびに変わる値。未コミットの変更は同じパスでも中身が変わるので、
   * これが変わったら差分を取り直す (コミットの差分は変わらないので取り直さない)
   */
  refreshKey: number;
  /**
   * 選んだコミットのいまのref (読み直した一覧から渡す)。コミットの応答はshaごとに
   * 持ち続けるので、応答のrefは古くなる (新しいコミットが積まれてもHEADの札が残る)。
   * 一覧に無いコミットは未指定で、そのときだけ応答のrefを出す
   */
  refs?: readonly GitRef[];
  /** 親のハッシュを押した */
  onSelectCommit: (sha: string) => void;
  /** 相対時刻の基準 (テスト用) */
  now?: number;
}

type DetailTab = "commit" | "changes";

interface FileEntry {
  key: string;
  file: GitFileChange;
  target: GitDiffTarget;
}

interface FileGroup {
  /** 見出し。コミットの変更には無い */
  label: string | null;
  entries: FileEntry[];
}

/** これより狭いと、ファイル一覧と差分を上下に積む */
const STACK_BELOW = 520;

const STATUS_LABEL: Record<GitFileChange["status"], string> = {
  A: "追加",
  M: "変更",
  D: "削除",
  R: "名前の変更",
  C: "コピー",
  T: "種類の変更",
  U: "競合",
  "?": "未追跡",
};

const STATUS_COLOR: Record<GitFileChange["status"], string> = {
  A: "var(--git-added)",
  "?": "var(--git-added)",
  M: "var(--git-modified)",
  T: "var(--git-modified)",
  D: "var(--git-removed)",
  U: "var(--git-removed)",
  R: "var(--git-renamed)",
  C: "var(--git-renamed)",
};

const baseName = (path: string) => path.split("/").pop() || path;
const dirName = (path: string) => {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i + 1);
};

function StatusBadge({ status }: { status: GitFileChange["status"] }) {
  const color = STATUS_COLOR[status];
  return (
    <span
      data-testid="git-file-status"
      title={STATUS_LABEL[status]}
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-[3px] font-bold font-mono text-[11px] leading-none"
      // 塗りに状態の色、字に地の色。明暗どちらでも字が抜けて読める
      style={{ backgroundColor: color, color: "var(--background)" }}
    >
      {status}
    </span>
  );
}

/** `+n −m`。バイナリ (null) は出さない。0 の側は出さない */
function Counts({ file }: { file: GitFileChange }) {
  // 未追跡と競合はサーバーが行数を数えない (null)。バイナリとは限らないので何も出さない
  if (file.status === "?" || file.status === "U") return null;
  if (file.added === null || file.removed === null) {
    return (
      <span className="shrink-0 text-[11px] text-muted-foreground">
        バイナリ
      </span>
    );
  }
  if (file.added === 0 && file.removed === 0) return null;
  return (
    <span
      data-testid="git-file-counts"
      className="shrink-0 font-mono text-[11px] tabular-nums"
    >
      {file.added > 0 && (
        <span style={{ color: "var(--git-added)" }}>+{file.added}</span>
      )}
      {file.added > 0 && file.removed > 0 && " "}
      {file.removed > 0 && (
        <span style={{ color: "var(--git-removed)" }}>−{file.removed}</span>
      )}
    </span>
  );
}

const Message = ({ children }: { children: ReactNode }) => (
  <div className="flex h-full items-center justify-center p-6 text-center text-muted-foreground text-xs">
    {children}
  </div>
);

type CommitState =
  | { sha: string; state: "loading" }
  | { sha: string; state: "error"; error: string }
  | {
      sha: string;
      state: "ready";
      commit: CommitDetail;
      files: GitFileChange[];
    };

type DiffState =
  | { key: string; state: "loading" }
  | { key: string; state: "error"; error: string }
  | { key: string; state: "ready"; diff: GitFileDiff };

/**
 * 選んだコミット (または未コミットの変更) の詳細。「コミット」と「変更」の 2 タブで、
 * 「変更」は左にファイル一覧、右に選んだファイルの差分を出す
 */
export function GitCommitDetail({
  api,
  selection,
  status,
  refreshKey,
  refs,
  onSelectCommit,
  now,
}: GitCommitDetailProps) {
  const [tab, setTab] = useState<DetailTab>("changes");
  const sha = selection?.kind === "commit" ? selection.sha : null;
  const isWorking = selection?.kind === "working";
  const domId = useId();

  // コミットの中身。sha ごとに取り、遅れて届いた古い応答は捨てる
  const [commitState, setCommitState] = useState<CommitState | null>(null);
  const [retrySeq, setRetrySeq] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retrySeq は再試行の合図
  useEffect(() => {
    if (!sha) {
      setCommitState(null);
      return;
    }
    let cancelled = false;
    setCommitState(prev =>
      prev?.sha === sha && prev.state === "ready"
        ? prev
        : { sha, state: "loading" }
    );
    api.commit(sha).then(res => {
      if (cancelled) return;
      setCommitState(
        res.ok
          ? { sha, state: "ready", commit: res.commit, files: res.files }
          : { sha, state: "error", error: res.error }
      );
    });
    return () => {
      cancelled = true;
    };
  }, [api, sha, retrySeq]);

  const current = commitState && commitState.sha === sha ? commitState : null;
  const commit = current?.state === "ready" ? current.commit : null;

  const groups = useMemo<FileGroup[]>(() => {
    if (isWorking) {
      const make = (
        label: string,
        kind: "staged" | "unstaged" | "untracked",
        files: GitFileChange[]
      ): FileGroup => ({
        label,
        entries: files.map(file => ({
          key: `${kind}:${file.path}`,
          file,
          target: { kind },
        })),
      });
      return [
        make("ステージ済み", "staged", status?.staged ?? []),
        make("変更", "unstaged", status?.unstaged ?? []),
        make("未追跡", "untracked", status?.untracked ?? []),
      ].filter(g => g.entries.length > 0);
    }
    if (current?.state !== "ready") return [];
    const target: GitDiffTarget = { kind: "commit", sha: current.sha };
    return [
      {
        label: null,
        entries: current.files.map(file => ({
          key: `${current.sha}:${file.path}`,
          file,
          target,
        })),
      },
    ];
  }, [isWorking, status, current]);

  const entries = useMemo(() => groups.flatMap(g => g.entries), [groups]);
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  // 選んだファイルが一覧から消えたら (別のコミットへ移った等) 先頭を選ぶ
  const selected = entries.find(e => e.key === pickedKey) ?? entries[0] ?? null;

  // 選んだファイルの差分。(対象, パス) ごとに取り、古い応答は捨てる。
  // 取り直しのあいだは前の差分を出したままにする (読み直しのたびに点滅させない)
  const [diffState, setDiffState] = useState<DiffState | null>(null);
  const selectedKey = selected?.key ?? null;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const diffRefresh = isWorking ? refreshKey : 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: diffRefresh と retrySeq は取り直しの合図
  useEffect(() => {
    const entry = selectedRef.current;
    if (!selectedKey || !entry) {
      setDiffState(null);
      return;
    }
    let cancelled = false;
    setDiffState(prev =>
      prev?.key === selectedKey && prev.state === "ready"
        ? prev
        : { key: selectedKey, state: "loading" }
    );
    api
      .fileDiff(entry.target, entry.file.path, entry.file.oldPath)
      .then(res => {
        if (cancelled) return;
        setDiffState(
          res.ok
            ? { key: selectedKey, state: "ready", diff: res }
            : { key: selectedKey, state: "error", error: res.error }
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, selectedKey, diffRefresh, retrySeq]);

  // 狭いときはファイル一覧と差分を上下に積む
  const bodyRef = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(false);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      // 隠れている間 (幅 0) は判定を変えない
      if (el.clientWidth > 0) setStacked(el.clientWidth < STACK_BELOW);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (!selection) {
    return <Message>コミットを選ぶと、ここに詳細が出ます</Message>;
  }

  // 未コミットの変更にはコミットの情報が無いので、「変更」だけを出す
  const activeTab: DetailTab = isWorking ? "changes" : tab;
  const tabs: { value: DetailTab; label: string }[] = isWorking
    ? [{ value: "changes", label: `変更 ${entries.length}` }]
    : [
        { value: "commit", label: "コミット" },
        {
          value: "changes",
          label: current?.state === "ready" ? `変更 ${entries.length}` : "変更",
        },
      ];
  const nowMs = now ?? Date.now();
  const diff = diffState && diffState.key === selectedKey ? diffState : null;

  const changes =
    !isWorking && current?.state !== "ready" ? (
      <CommitPending state={current} onRetry={() => setRetrySeq(s => s + 1)} />
    ) : entries.length === 0 ? (
      <Message>
        {isWorking ? "未コミットの変更はありません" : "変更はありません"}
      </Message>
    ) : (
      <div
        className={cn("flex h-full min-h-0", stacked ? "flex-col" : "flex-row")}
      >
        <div
          role="listbox"
          aria-label="変更されたファイル"
          className={cn(
            "shrink-0 overflow-y-auto overflow-x-hidden border-border py-0.5",
            stacked ? "max-h-[30%] border-b" : "w-[220px] border-r"
          )}
        >
          {groups.map(group => (
            <div key={group.label ?? "files"}>
              {group.label && (
                <div
                  data-testid="git-file-group"
                  className="flex h-[22px] items-center gap-1.5 px-2 font-semibold text-[11px] text-muted-foreground"
                >
                  {group.label}
                  <span className="font-normal tabular-nums">
                    {group.entries.length}
                  </span>
                </div>
              )}
              {group.entries.map(entry => (
                <FileRow
                  key={entry.key}
                  entry={entry}
                  selected={entry.key === selectedKey}
                  onSelect={() => setPickedKey(entry.key)}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {selected && (
            <>
              <DiffHeader file={selected.file} />
              <div className="min-h-0 flex-1">
                {!diff || diff.state === "loading" ? (
                  <Message>読み込み中…</Message>
                ) : diff.state === "error" ? (
                  <Message>
                    <span role="alert">{diff.error}</span>
                  </Message>
                ) : diff.diff.binary ? (
                  <Message>バイナリファイルです</Message>
                ) : diff.diff.tooLarge ? (
                  <Message>大きすぎるため表示できません</Message>
                ) : (
                  <Suspense fallback={<Message>読み込み中…</Message>}>
                    <GitDiffView
                      path={selected.file.path}
                      oldContent={diff.diff.oldContent}
                      newContent={diff.diff.newContent}
                    />
                  </Suspense>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div
        role="tablist"
        aria-label="詳細の表示"
        className="flex h-[31px] shrink-0 items-stretch gap-1 border-border border-b bg-muted/30 px-2 text-[13px]"
      >
        {tabs.map(t => {
          const active = t.value === activeTab;
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              id={`${domId}-tab-${t.value}`}
              aria-selected={active}
              aria-controls={`${domId}-panel`}
              onClick={() => setTab(t.value)}
              className={cn(
                "-mb-px inline-flex shrink-0 items-center border-b-2 px-2 font-semibold transition-colors",
                active
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {t.label}
            </button>
          );
        })}
        {isWorking ? (
          <span className="ml-auto self-center truncate text-[12px] text-muted-foreground">
            未コミットの変更
          </span>
        ) : (
          sha && (
            <span
              className="ml-auto min-w-0 self-center truncate text-[12px] text-muted-foreground"
              title={commit?.subject}
            >
              <span className="font-mono">{shortSha(sha)}</span>
              {commit && ` · ${commit.subject}`}
            </span>
          )
        )}
      </div>
      <div
        ref={bodyRef}
        role="tabpanel"
        id={`${domId}-panel`}
        aria-labelledby={`${domId}-tab-${activeTab}`}
        className="min-h-0 flex-1"
      >
        {activeTab === "changes" ? (
          changes
        ) : commit ? (
          <CommitInfo
            commit={commit}
            refs={refs ?? commit.refs}
            nowMs={nowMs}
            onSelectCommit={onSelectCommit}
          />
        ) : (
          <CommitPending
            state={current}
            onRetry={() => setRetrySeq(s => s + 1)}
          />
        )}
      </div>
    </div>
  );
}

/** コミットの中身を待っている / 取れなかった */
function CommitPending({
  state,
  onRetry,
}: {
  state: CommitState | null;
  onRetry: () => void;
}) {
  if (state?.state === "error") {
    return (
      <Message>
        <span className="flex flex-col items-center gap-2">
          <span role="alert">{state.error}</span>
          <button
            type="button"
            onClick={onRetry}
            className="rounded-sm border border-border px-2.5 py-1 text-foreground hover:bg-muted"
          >
            再試行
          </button>
        </span>
      </Message>
    );
  }
  return <Message>読み込み中…</Message>;
}

function FileRow({
  entry,
  selected,
  onSelect,
}: {
  entry: FileEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  const { file } = entry;
  const name = baseName(file.path);
  const renamed = file.oldPath !== undefined && file.oldPath !== file.path;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-path={file.path}
      title={renamed ? `${file.oldPath} → ${file.path}` : file.path}
      onClick={onSelect}
      className={cn(
        "flex h-[26px] w-full items-center gap-1.5 px-2 text-left text-[13px]",
        selected ? "bg-primary/20" : "hover:bg-muted/60"
      )}
    >
      <StatusBadge status={file.status} />
      <FileIcon name={name} kind="file" />
      <span className="min-w-0 flex-1 truncate">
        {renamed && (
          <span className="text-muted-foreground">
            {baseName(file.oldPath as string)} →{" "}
          </span>
        )}
        <span className="font-semibold">{name}</span>
        {dirName(file.path) && (
          <span className="ml-1.5 text-[12px] text-muted-foreground">
            {dirName(file.path)}
          </span>
        )}
      </span>
      <Counts file={file} />
    </button>
  );
}

/** 差分の上の帯: パス、増減、「ファイルで開く」 */
function DiffHeader({ file }: { file: GitFileChange }) {
  const deleted = file.status === "D";
  const openInFiles = () => {
    // 端末やボードのリンクと同じ入口。Dashboard が「ファイル」のタブで開く
    window.postMessage(
      { type: "ark:open-file", path: file.path },
      window.location.origin
    );
  };
  return (
    <div className="flex h-[28px] shrink-0 items-center gap-2 border-border border-b bg-muted/20 pr-1.5 pl-2.5 text-[12px]">
      <span
        data-testid="git-diff-path"
        className="min-w-0 flex-1 truncate font-mono"
        title={file.path}
      >
        {file.oldPath && file.oldPath !== file.path && (
          <span className="text-muted-foreground">{file.oldPath} → </span>
        )}
        {file.path}
      </span>
      <Counts file={file} />
      <button
        type="button"
        disabled={deleted}
        title={
          deleted ? "削除されたファイルは開けません" : "ファイルのタブで開く"
        }
        onClick={openInFiles}
        className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-sm px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        <ExternalLink className="size-3.5" aria-hidden="true" />
        ファイルで開く
      </button>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // クリップボードが使えない (http など)。印は出さない
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      type="button"
      aria-label="ハッシュをコピー"
      title={copied ? "コピーしました" : "ハッシュをコピー"}
      onClick={() => void copy()}
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {copied ? (
        <Check className="size-3.5 text-status-idle" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
    </button>
  );
}

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <>
    <dt className="pt-0.5 text-[12px] text-muted-foreground">{label}</dt>
    <dd className="flex min-w-0 flex-wrap items-center gap-1.5">{children}</dd>
  </>
);

function CommitInfo({
  commit,
  refs,
  nowMs,
  onSelectCommit,
}: {
  commit: CommitDetail;
  /** いまのref (一覧から)。一覧に無いコミットは応答のref */
  refs: readonly GitRef[];
  nowMs: number;
  onSelectCommit: (sha: string) => void;
}) {
  return (
    <div className="h-full overflow-y-auto px-4 py-3 text-[13px]">
      <h3 className="font-semibold text-[16px] leading-snug">
        {commit.subject}
      </h3>
      {commit.body.trim() && (
        <p
          data-testid="git-commit-body"
          className="mt-2 whitespace-pre-wrap break-words text-foreground/90 leading-relaxed"
        >
          {commit.body.trim()}
        </p>
      )}
      <div className="mt-3 flex items-center gap-2.5">
        <GitAvatar
          name={commit.authorName}
          email={commit.authorEmail}
          size="md"
        />
        <div className="min-w-0">
          <div className="truncate">
            <span className="font-semibold">{commit.authorName}</span>
            {commit.authorEmail && (
              <span className="ml-1.5 text-muted-foreground">
                {commit.authorEmail}
              </span>
            )}
          </div>
          <div className="text-[12px] text-muted-foreground">
            {formatAbsoluteTime(commit.authorTime)} (
            {formatRelativeTime(commit.authorTime, nowMs)})
          </div>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5">
        {commit.committerName !== commit.authorName && (
          <Field label="コミッター">
            <span data-testid="git-committer">
              {commit.committerName}
              <span className="ml-1.5 text-[12px] text-muted-foreground">
                {formatAbsoluteTime(commit.committerTime)}
              </span>
            </span>
          </Field>
        )}
        <Field label="ハッシュ">
          <code data-testid="git-full-sha" className="break-all text-[12px]">
            {commit.sha}
          </code>
          <CopyButton text={commit.sha} />
        </Field>
        <Field label="親">
          {commit.parents.length === 0 ? (
            <span className="text-muted-foreground">なし (最初のコミット)</span>
          ) : (
            commit.parents.map(parent => (
              <button
                key={parent}
                type="button"
                data-parent={parent}
                title={parent}
                onClick={() => onSelectCommit(parent)}
                className="rounded-sm border border-border px-1.5 py-px font-mono text-[12px] text-primary hover:bg-muted"
              >
                {shortSha(parent)}
              </button>
            ))
          )}
        </Field>
        {refs.length > 0 && (
          <Field label="ref">
            <GitRefLabels refs={refs} />
          </Field>
        )}
      </dl>
    </div>
  );
}
