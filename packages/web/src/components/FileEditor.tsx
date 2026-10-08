import { Save } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { FileApi } from "@/lib/file-api";
import { decideOnDiskChange, detectLineEnding } from "@/lib/file-editor-state";
import type { FileTab } from "@/lib/file-tabs";
import { cn } from "@/lib/utils";
import { ImageRenderer, MarkdownRenderer } from "./FileViewerPane";
import { HtmlViewerPane } from "./HtmlViewerPane";

// CodeMirror は初期バンドルに載せない
const CodeEditor = lazy(() => import("./CodeEditor"));

interface FileEditorProps {
  api: FileApi;
  tab: FileTab;
  /** 非表示の間は読み直しを遅らせる */
  isVisible: boolean;
  onDirtyChange: (tabId: string, dirty: boolean) => void;
  /**
   * ツリーの git 状態を読み直す合図。保存できたときと、ディスク上の変更を
   * 読み直したときに呼ぶ (どちらも git の状態が変わりうる)
   */
  onSaved: () => void;
}

export function FileEditor(props: FileEditorProps) {
  // html は iframe で見せるだけ。file:open も購読も要らない
  if (props.tab.kind === "html") {
    return <HtmlViewerPane filePath={props.tab.filePath} />;
  }
  return <TextFileEditor {...props} />;
}

type Loaded =
  | { status: "loading" }
  | { status: "error"; error: string }
  | {
      status: "ok";
      /** 改行を LF に揃えた内容。エディタへ渡す */
      content: string;
      mimeType: string;
      size: number;
      editable: boolean;
      /** 読み直すたびに増える。エディタが文書を差し替える合図 */
      loadSeq: number;
    };

/** conflict は保存が拒否されたとき。「上書き保存」を足す */
type Banner = "disk-changed" | "conflict" | null;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function TextFileEditor({
  api,
  tab,
  isVisible,
  onDirtyChange,
  onSaved,
}: FileEditorProps) {
  const filePath = tab.filePath;
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [markdownMode, setMarkdownMode] = useState<"preview" | "edit">(
    "preview"
  );
  // エディタは 1 度出したら外さない (外すと未保存の編集と undo 履歴が消える)
  const [editorMounted, setEditorMounted] = useState(false);

  // 非同期の処理から最新を読むための ref
  const apiRef = useRef(api);
  apiRef.current = api;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const visibleRef = useRef(isVisible);
  visibleRef.current = isVisible;
  /** ディスクと一致している内容 (LF) */
  const baseRef = useRef("");
  /** エディタの今の内容 (LF) */
  const valueRef = useRef("");
  const mtimeRef = useRef(0);
  const lineEndingRef = useRef<"\n" | "\r\n">("\n");
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const loadSeqRef = useRef(0);
  /** 非表示・保存中に届いた更新の印 */
  const pendingUpdateRef = useRef(false);
  /** open の要求番号。最新の応答だけを採る */
  const requestRef = useRef(0);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const markDirty = useCallback((next: boolean) => {
    dirtyRef.current = next;
    setDirty(next);
  }, []);

  // 親が持つ dirty の集合へ伝える。アンマウントで必ず解く
  const tabId = tab.id;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const reportedDirty = useRef(false);
  useEffect(() => {
    if (reportedDirty.current === dirty) return;
    reportedDirty.current = dirty;
    onDirtyChangeRef.current(tabId, dirty);
  }, [dirty, tabId]);
  useEffect(
    () => () => {
      if (reportedDirty.current) onDirtyChangeRef.current(tabId, false);
    },
    [tabId]
  );

  /** 読み取った内容を手元の正にする。編集は捨てる */
  const applyLoaded = useCallback(
    (res: Extract<Awaited<ReturnType<FileApi["open"]>>, { ok: true }>) => {
      lineEndingRef.current = detectLineEnding(res.content);
      const content = res.content.replace(/\r\n/g, "\n");
      baseRef.current = content;
      valueRef.current = content;
      mtimeRef.current = res.mtimeMs;
      loadSeqRef.current += 1;
      setLoaded({
        status: "ok",
        content,
        mimeType: res.mimeType,
        size: res.size,
        editable: res.editable,
        loadSeq: loadSeqRef.current,
      });
      markDirty(false);
      setBanner(null);
      setSaveError(null);
    },
    [markDirty]
  );

  /** 開き直して、手元を置き換える (初回・再試行・「再読込」) */
  const reload = useCallback(async () => {
    const request = ++requestRef.current;
    const res = await apiRef.current.open(filePath);
    if (!aliveRef.current || request !== requestRef.current) return;
    if (res.ok) applyLoaded(res);
    else setLoaded({ status: "error", error: res.error });
  }, [filePath, applyLoaded]);

  /** file:updated を受けたとき。手元の状態と突き合わせて決める */
  const handleDiskUpdate = useCallback(async () => {
    // 非表示の間は読み直さない。保存の応答を待つ間は mtime が古く、
    // 自分の書き込みを競合と見誤るので、応答のあとに回す
    if (!visibleRef.current || savingRef.current) {
      pendingUpdateRef.current = true;
      return;
    }
    pendingUpdateRef.current = false;
    const request = ++requestRef.current;
    const res = await apiRef.current.open(filePath);
    if (!aliveRef.current || request !== requestRef.current) return;
    if (savingRef.current) {
      pendingUpdateRef.current = true;
      return;
    }
    if (!res.ok) {
      // 消されたなど。編集中なら手元を残し、保存のときに分かるようにする
      if (!dirtyRef.current) setLoaded({ status: "error", error: res.error });
      return;
    }
    const decision = decideOnDiskChange({
      loadedMtimeMs: mtimeRef.current,
      diskMtimeMs: res.mtimeMs,
      dirty: dirtyRef.current,
    });
    if (decision === "reload-silently") {
      applyLoaded(res);
      onSavedRef.current();
    } else if (decision === "show-conflict") {
      setBanner(current => current ?? "disk-changed");
    }
  }, [filePath, applyLoaded]);

  // 初回の読み込み。api が作り直されても、編集中の内容は捨てない
  // biome-ignore lint/correctness/useExhaustiveDependencies: api の作り直しで読み直す
  useEffect(() => {
    if (dirtyRef.current) return;
    void reload();
  }, [api, reload]);

  // 購読は表示・非表示に関わらず張る (読み直しだけを遅らせる)
  useEffect(
    () => api.subscribe(filePath, () => void handleDiskUpdate()),
    [api, filePath, handleDiskUpdate]
  );

  // 表示されたとき、溜めていた更新を処理する
  useEffect(() => {
    if (isVisible && pendingUpdateRef.current) void handleDiskUpdate();
  }, [isVisible, handleDiskUpdate]);

  const editable = loaded.status === "ok" && loaded.editable;

  const save = useCallback(
    async (force = false) => {
      if (!editable || savingRef.current) return;
      if (!dirtyRef.current && !force) return;
      const value = valueRef.current;
      // エディタは LF で持つ。読み取り時の改行へ戻して書く
      const content =
        lineEndingRef.current === "\r\n" ? value.replace(/\n/g, "\r\n") : value;
      savingRef.current = true;
      setSaving(true);
      setSaveError(null);
      const res = force
        ? await apiRef.current.write(filePath, content, mtimeRef.current, true)
        : await apiRef.current.write(filePath, content, mtimeRef.current);
      savingRef.current = false;
      if (!aliveRef.current) return;
      setSaving(false);
      if (res.ok) {
        // 反響の file:updated を無視できるよう、先に mtime を進める
        mtimeRef.current = res.mtimeMs;
        baseRef.current = value;
        markDirty(valueRef.current !== value);
        setBanner(null);
        setLoaded(current =>
          current.status === "ok"
            ? { ...current, size: new TextEncoder().encode(content).length }
            : current
        );
        onSavedRef.current();
      } else if (res.code === "conflict") {
        setBanner("conflict");
      } else {
        setSaveError(res.error);
      }
      if (pendingUpdateRef.current) void handleDiskUpdate();
    },
    [editable, filePath, markDirty, handleDiskUpdate]
  );

  const handleChange = useCallback(
    (value: string) => {
      valueRef.current = value;
      markDirty(value !== baseRef.current);
    },
    [markDirty]
  );
  const handleSave = useCallback(() => void save(), [save]);

  if (loaded.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center bg-background text-muted-foreground text-xs">
        読み込み中…
      </div>
    );
  }

  if (loaded.status === "error") {
    return (
      <div className="flex h-full items-center justify-center bg-background p-4">
        <div className="text-center">
          <p className="font-medium text-destructive text-sm">
            ファイルを開けません
          </p>
          <p className="mt-1 break-all text-muted-foreground text-xs">
            {loaded.error}
          </p>
          <button
            type="button"
            aria-label="再試行"
            onClick={() => void reload()}
            className="mt-3 rounded border border-border px-2.5 py-1 text-xs hover:bg-muted"
          >
            再試行
          </button>
        </div>
      </div>
    );
  }

  const isImage = loaded.mimeType.startsWith("image/");
  const isMarkdown = loaded.mimeType === "text/markdown";
  const showPreview = isMarkdown && markdownMode === "preview";
  const showEditor = !isImage && (!isMarkdown || editorMounted);
  const fileName = filePath.split("/").pop() ?? filePath;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-border border-b px-3 py-1 text-muted-foreground text-xs">
        <span className="shrink-0 font-medium text-foreground">{fileName}</span>
        <span className="min-w-0 truncate" title={filePath}>
          {filePath}
        </span>
        <span className="ml-auto shrink-0">{formatSize(loaded.size)}</span>
        {!loaded.editable && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5">
            読み取り専用
          </span>
        )}
        {isMarkdown && (
          <fieldset className="m-0 inline-flex shrink-0 items-center gap-0.5 rounded border-0 bg-muted p-0.5">
            <legend className="sr-only">Markdown の表示</legend>
            {(["preview", "edit"] as const).map(mode => (
              <button
                key={mode}
                type="button"
                aria-label={mode === "preview" ? "プレビュー" : "編集"}
                aria-pressed={markdownMode === mode}
                onClick={() => {
                  if (mode === "edit") setEditorMounted(true);
                  setMarkdownMode(mode);
                }}
                className={cn(
                  "rounded-sm px-2 py-0.5",
                  markdownMode === mode
                    ? "bg-card text-foreground shadow-card"
                    : "hover:text-foreground"
                )}
              >
                {mode === "preview" ? "プレビュー" : "編集"}
              </button>
            ))}
          </fieldset>
        )}
        {loaded.editable && (
          <button
            type="button"
            aria-label="保存"
            title="保存 (Ctrl+S)"
            disabled={!dirty || saving}
            onClick={handleSave}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded text-foreground hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
          >
            <Save className="size-3.5" />
          </button>
        )}
      </div>
      {banner && (
        <div
          role="status"
          className="flex shrink-0 flex-wrap items-center gap-2 border-border border-b bg-status-awaiting/15 px-3 py-1.5 text-xs"
        >
          <span className="mr-auto font-medium">
            ディスク上で変更されました
          </span>
          <button
            type="button"
            onClick={() => void reload()}
            className="rounded border border-border bg-background px-2 py-0.5 hover:bg-muted"
          >
            再読込 (編集を捨てる)
          </button>
          {banner === "conflict" && (
            <button
              type="button"
              onClick={() => void save(true)}
              className="rounded border border-border bg-background px-2 py-0.5 hover:bg-muted"
            >
              上書き保存
            </button>
          )}
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="rounded border border-border bg-background px-2 py-0.5 hover:bg-muted"
          >
            このまま編集
          </button>
        </div>
      )}
      {saveError && (
        <div
          role="alert"
          className="shrink-0 border-border border-b bg-destructive/10 px-3 py-1.5 text-destructive text-xs"
        >
          保存できません: {saveError}
        </div>
      )}
      <div className="min-h-0 flex-1">
        {isImage && (
          <ImageRenderer
            content={loaded.content}
            mimeType={loaded.mimeType}
            filePath={filePath}
          />
        )}
        {showPreview && (
          <div className="h-full overflow-auto">
            {/* 編集中の内容を映す (未保存の編集も確かめられる) */}
            <MarkdownRenderer content={valueRef.current} />
          </div>
        )}
        {showEditor && (
          <div className={cn("h-full", showPreview && "hidden")}>
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-muted-foreground text-xs">
                  読み込み中…
                </div>
              }
            >
              <CodeEditor
                filePath={filePath}
                value={loaded.content}
                loadSeq={loaded.loadSeq}
                readOnly={!loaded.editable}
                targetLine={tab.targetLine}
                targetEndLine={tab.targetEndLine}
                revealSeq={tab.revealSeq}
                onChange={handleChange}
                onSave={handleSave}
              />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}
