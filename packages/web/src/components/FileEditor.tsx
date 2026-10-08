import { Save } from "lucide-react";
import {
  lazy,
  type ReactNode,
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
  /**
   * 実際に見えているか (ペインが見えていて、このタブがアクティブ)。
   * 見えている間だけ読み込み・購読し、見えるたびにディスクと突き合わせる
   */
  isVisible: boolean;
  onDirtyChange: (tabId: string, dirty: boolean) => void;
  /**
   * ツリーの git 状態を読み直す合図。保存できたときと、ディスク上の変更を
   * 読み直したときに呼ぶ (どちらも git の状態が変わりうる)
   */
  onSaved: () => void;
  /**
   * 見出しの行を呼び出し側の部品で組む (ピーク用)。start はファイル名とパスの代わりに
   * 左へ、end は保存ボタンの右へ置く。読み込み中・失敗・html でも同じ行を出す
   * (閉じるボタンを常に押せるようにするため)
   */
  chrome?: FileEditorChrome;
}

export interface FileEditorChrome {
  start: ReactNode;
  end: ReactNode;
}

const HEADER_ROW =
  "flex shrink-0 items-center gap-2 px-3 py-1 text-muted-foreground text-xs";

/** 見出しの中身が無い状態 (読み込み中・失敗・html) に、呼び出し側の見出しだけを載せる */
function WithChrome({
  chrome,
  children,
}: {
  chrome: FileEditorChrome | undefined;
  children: ReactNode;
}) {
  if (!chrome) return <>{children}</>;
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className={HEADER_ROW}>
        {chrome.start}
        <span className="ml-auto" />
        {chrome.end}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

export function FileEditor(props: FileEditorProps) {
  // html は iframe で見せるだけ。file:open も購読も要らない
  if (props.tab.kind === "html") {
    return (
      <WithChrome chrome={props.chrome}>
        <HtmlViewerPane filePath={props.tab.filePath} />
      </WithChrome>
    );
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

/**
 * 改行の扱い: エディタ (CodeMirror) は CRLF も単独の CR も 1 つの改行にして LF で返す。
 * 未保存の判定に使う基準も同じ形に揃える (揃えないと、CR を含むファイルは
 * 元へ戻しても未保存のままになる)。書き戻すときは読み取り時に決めた改行に揃える:
 * 最初の改行が CRLF なら全部 CRLF、それ以外は全部 LF。単独の CR は残らない
 */
function toEditorText(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

/** サーバーが内容を文字列で返す MIME (サーバーの isTextMimeType と同じ範囲) */
function isTextMime(mimeType: string): boolean {
  return mimeType.startsWith("text/") || mimeType === "application/json";
}

type OpenedFile = Extract<Awaited<ReturnType<FileApi["open"]>>, { ok: true }>;

function TextFileEditor({
  api,
  tab,
  isVisible,
  onDirtyChange,
  onSaved,
  chrome,
}: FileEditorProps) {
  const filePath = tab.filePath;
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 行指定つきで開かれた Markdown は編集で出す (プレビューでは行を示せない)
  const hasTargetLine = tab.targetLine != null;
  const [markdownMode, setMarkdownMode] = useState<"preview" | "edit">(
    hasTargetLine ? "edit" : "preview"
  );
  // エディタは 1 度出したら外さない (外すと未保存の編集と undo 履歴が消える)
  const [editorMounted, setEditorMounted] = useState(hasTargetLine);
  // 行指定で開き直されたら (revealSeq が増えたら) 編集へ戻す。effect ではなく
  // 描画中に切り替える: effect だと 1 コミットだけ display:none のまま
  // エディタが行へスクロールしようとして効かない
  const [seenRevealSeq, setSeenRevealSeq] = useState(tab.revealSeq);
  if (tab.revealSeq !== seenRevealSeq) {
    setSeenRevealSeq(tab.revealSeq);
    if (tab.revealSeq > seenRevealSeq && hasTargetLine) {
      setEditorMounted(true);
      setMarkdownMode("edit");
    }
  }

  // 非同期の処理から最新を読むための ref
  const apiRef = useRef(api);
  apiRef.current = api;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  /** ディスクと一致している内容 (LF) */
  const baseRef = useRef("");
  /** エディタの今の内容 (LF) */
  const valueRef = useRef("");
  const mtimeRef = useRef(0);
  const lineEndingRef = useRef<"\n" | "\r\n">("\n");
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const loadSeqRef = useRef(0);
  /** 保存中に届いた更新の印。保存の応答のあとにディスクと突き合わせる */
  const pendingUpdateRef = useRef(false);
  /** 応答を待っている open の数 */
  const openInFlightRef = useRef(0);
  /**
   * 失敗に終わった保存で書こうとした内容 (ディスクへ書く形)。ack が届かなかった
   * だけで、書き込みは済んでいる・あとから済むことがある
   */
  const failedWriteRef = useRef<string | null>(null);
  /** 手元に読めた内容があるか。無ければ、開き直した結果をそのまま採る */
  const loadedOkRef = useRef(false);
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
    (res: OpenedFile) => {
      lineEndingRef.current = detectLineEnding(res.content);
      const content = toEditorText(res.content);
      failedWriteRef.current = null;
      baseRef.current = content;
      valueRef.current = content;
      mtimeRef.current = res.mtimeMs;
      loadSeqRef.current += 1;
      loadedOkRef.current = true;
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

  /**
   * ディスクの内容が、失敗に終わった保存で書こうとしたものと同じだった。
   * 保存できていたものとして扱う (そのあとに打った分は未保存のまま残す)
   */
  const adoptOwnWrite = useCallback(
    (res: OpenedFile) => {
      const saved = toEditorText(res.content);
      failedWriteRef.current = null;
      baseRef.current = saved;
      mtimeRef.current = res.mtimeMs;
      markDirty(valueRef.current !== saved);
      setBanner(null);
      setSaveError(null);
      setLoaded(current =>
        current.status === "ok" ? { ...current, size: res.size } : current
      );
      onSavedRef.current();
    },
    [markDirty]
  );

  const failLoad = useCallback((error: string) => {
    loadedOkRef.current = false;
    setLoaded({ status: "error", error });
  }, []);

  /** 開き直して、手元を置き換える (再試行・「再読込」) */
  const reload = useCallback(async () => {
    // 保存の応答を待つ間に読み直すと、応答が古い内容の上へ mtime と基準を被せる
    if (savingRef.current) return;
    const request = ++requestRef.current;
    const res = await apiRef.current.open(filePath);
    if (!aliveRef.current || request !== requestRef.current) return;
    if (res.ok) applyLoaded(res);
    else failLoad(res.error);
  }, [filePath, applyLoaded, failLoad]);

  /**
   * ディスクと突き合わせる。file:updated を受けたときと、タブが見えたときに呼ぶ。
   * 開き直した結果を手元の状態と比べて、読み直す・バナーを出す・何もしないを決める
   */
  const handleDiskUpdate = useCallback(async () => {
    // 保存の応答を待つ間は mtime が古く、自分の書き込みを競合と見誤るので、
    // 応答のあとに回す
    if (savingRef.current) {
      pendingUpdateRef.current = true;
      return;
    }
    pendingUpdateRef.current = false;
    const request = ++requestRef.current;
    openInFlightRef.current += 1;
    const res = await apiRef.current.open(filePath);
    openInFlightRef.current -= 1;
    if (!aliveRef.current) return;
    // この応答は保存より前のディスクかもしれない。保存のあとに確かめ直す
    if (savingRef.current) {
      pendingUpdateRef.current = true;
      return;
    }
    if (request !== requestRef.current) return;
    if (!res.ok) {
      // 消されたなど。編集中なら手元を残し、保存のときに分かるようにする
      if (!dirtyRef.current) failLoad(res.error);
      return;
    }
    // 初回と、開けなかったあと。比べる相手が無いのでそのまま採る
    if (!loadedOkRef.current) {
      applyLoaded(res);
      return;
    }
    if (res.content === failedWriteRef.current) {
      adoptOwnWrite(res);
      return;
    }
    // 未保存かどうかは、open を待つ間に打たれた分も含めて、ここで読む
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
  }, [filePath, applyLoaded, adoptOwnWrite, failLoad]);

  // 見えている間だけ購読する。サーバーの購読は 1 socket あたり 50 件までで、
  // 全セッションの全タブに張ると届かない。隠れている間の変更は、見えたときに
  // 開き直して拾う (初回の読み込みもここ。隠れたままのタブは読まない)。
  // 未保存の編集は捨てない: 突き合わせの結果がバナーになるだけ
  useEffect(() => {
    if (!isVisible) return;
    // 先に購読してから開く (開いている間の変更を取りこぼさない)
    const unsubscribe = api.subscribe(filePath, () => void handleDiskUpdate());
    void handleDiskUpdate();
    return unsubscribe;
  }, [api, filePath, isVisible, handleDiskUpdate]);

  const editable = loaded.status === "ok" && loaded.editable;

  const save = useCallback(
    async (force = false) => {
      if (!editable || savingRef.current) return;
      if (!dirtyRef.current && !force) return;
      const value = valueRef.current;
      // エディタは LF で持つ。読み取り時に決めた改行へ揃えて書く (toEditorText を参照)
      const content =
        lineEndingRef.current === "\r\n" ? value.replace(/\n/g, "\r\n") : value;
      savingRef.current = true;
      setSaving(true);
      setSaveError(null);
      // 書き込みより前に出した open は、遅れて届くと書き込み前の内容で手元を
      // 巻き戻すか、偽の競合を出す。応答を捨て、保存のあとに確かめ直す
      requestRef.current += 1;
      if (openInFlightRef.current > 0) pendingUpdateRef.current = true;
      const res = force
        ? await apiRef.current.write(filePath, content, mtimeRef.current, true)
        : await apiRef.current.write(filePath, content, mtimeRef.current);
      // ack が届かなかっただけで、書き込みは済んでいることがある。開き直して確かめる。
      // そのあいだも保存中のままにして、ほかの open や保存と交ざらないようにする
      let onDisk: Awaited<ReturnType<FileApi["open"]>> | null = null;
      if (!res.ok && res.code !== "conflict") {
        failedWriteRef.current = content;
        onDisk = await apiRef.current.open(filePath);
      }
      savingRef.current = false;
      if (!aliveRef.current) return;
      setSaving(false);
      if (res.ok) {
        failedWriteRef.current = null;
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
      } else if (onDisk?.ok && onDisk.content === content) {
        adoptOwnWrite(onDisk);
      } else {
        // まだ書かれていない。あとから届いたら handleDiskUpdate が拾う
        setSaveError(res.error);
      }
      if (pendingUpdateRef.current) void handleDiskUpdate();
    },
    [editable, filePath, markDirty, adoptOwnWrite, handleDiskUpdate]
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
      <WithChrome chrome={chrome}>
        <div className="flex h-full items-center justify-center bg-background text-muted-foreground text-xs">
          読み込み中…
        </div>
      </WithChrome>
    );
  }

  if (loaded.status === "error") {
    return (
      <WithChrome chrome={chrome}>
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
      </WithChrome>
    );
  }

  const isImage = loaded.mimeType.startsWith("image/");
  const isMarkdown = loaded.mimeType === "text/markdown";
  const showPreview = isMarkdown && markdownMode === "preview";
  // 画像でないバイナリは、サーバーが内容を空で返す。空のエディタを出さない
  const isBinary =
    !isImage && loaded.content === "" && !isTextMime(loaded.mimeType);
  const showEditor = !isImage && !isBinary && (!isMarkdown || editorMounted);
  const fileName = filePath.split("/").pop() ?? filePath;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className={HEADER_ROW}>
        {chrome ? (
          chrome.start
        ) : (
          <>
            <span className="shrink-0 font-medium text-foreground">
              {fileName}
            </span>
            <span className="min-w-0 truncate" title={filePath}>
              {filePath}
            </span>
          </>
        )}
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
        {chrome?.end}
      </div>
      {banner && (
        <div
          role="status"
          className="flex shrink-0 flex-wrap items-center gap-2 bg-status-awaiting/15 px-3 py-1.5 text-xs"
        >
          <span className="mr-auto font-medium">
            ディスク上で変更されました
          </span>
          <button
            type="button"
            disabled={saving}
            onClick={() => void reload()}
            className="rounded border border-border bg-background px-2 py-0.5 hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
          >
            再読込 (編集を捨てる)
          </button>
          {banner === "conflict" && (
            <button
              type="button"
              disabled={saving}
              onClick={() => void save(true)}
              className="rounded border border-border bg-background px-2 py-0.5 hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
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
          className="shrink-0 bg-destructive/10 px-3 py-1.5 text-destructive text-xs"
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
        {isBinary && (
          <div className="flex h-full items-center justify-center p-4 text-center">
            <div>
              <p className="font-medium text-sm">
                このファイルは表示できません
              </p>
              <p className="mt-1 text-muted-foreground text-xs">
                {loaded.mimeType} ・ {formatSize(loaded.size)}
              </p>
            </div>
          </div>
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
