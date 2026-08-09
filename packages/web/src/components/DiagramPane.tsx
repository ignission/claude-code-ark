/**
 * 図ファイルを表示するペイン。
 *
 * HtmlViewerPane と同じく fetch した本文を srcDoc に流し込む
 * （認証トークンを iframe 内に露出させないため）。
 * sandbox は allow-scripts のみで allow-same-origin を付けない。
 * 外部送信の遮断は本文に注入された meta CSP が担う（サーバー側で注入済み）。
 */
import type {
  ClientToServerEvents,
  DiagramCommentsResponse,
  DiagramDeleteResponse,
  DiagramListItem,
  ServerToClientEvents,
} from "@ark/shared";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import {
  type DiagramCommentPortRequest,
  type DiagramCommentPortResult,
  parseDiagramCommentPortRequest,
  toDiagramCommentPortResult,
} from "../lib/diagram-comment-bridge";
import {
  applyDiagramDeleteResponse,
  getDiagramEmptyState,
  shouldRefreshDiagramList,
} from "../lib/diagram-delete-state";
import { DiagramSwitcher } from "./DiagramSwitcher";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface DiagramPaneProps {
  sessionId: string;
  worktreePath: string;
  relPath?: string;
  onSelectDiagram: (relPath: string, worktreePath: string) => void;
  isConnected: boolean;
  listDiagrams: (worktreePath: string) => Promise<DiagramListItem[]>;
  deleteDiagram: (
    sessionId: string,
    relPath: string,
    expectedTracked: boolean
  ) => Promise<DiagramDeleteResponse>;
  getDiagramComments: (
    sessionId: string,
    relPath: string
  ) => Promise<DiagramCommentsResponse>;
  createDiagramComment: (
    sessionId: string,
    relPath: string,
    anchorId: string,
    author: string,
    body: string
  ) => Promise<DiagramCommentsResponse>;
  resolveDiagramComment: (
    sessionId: string,
    relPath: string,
    threadId: string
  ) => Promise<DiagramCommentsResponse>;
  /** 未接続時は null。null の間は診断購読をスキップする */
  socket: TypedSocket | null;
}

/** ハーネス（diagram-harness.ts）が port 経由で送ってくるメッセージ */
interface DiagramSubmitMessage {
  type: "ark:diagram-submit";
  model: unknown;
  html: string;
}

interface DiagramAutosaveMessage {
  type: "ark:diagram-autosave";
  model: unknown;
  html: string;
}

interface DiagramPinchMessage {
  type: "ark:diagram-pinch";
  deltaY: number;
}

interface DiagramAutosaveRequest {
  sessionId: string;
  worktreePath: string;
  relPath: string;
  model: unknown;
  html: string;
}

interface DiagramAutosaveResponse {
  ok: boolean;
  error?: string;
}

export const DIAGRAM_ZOOM_MIN = 0.25;
export const DIAGRAM_ZOOM_MAX = 2;
export const DIAGRAM_ZOOM_STEP = 1.25;
export const DIAGRAM_ZOOM_DEFAULT = 1;

export function stepDiagramZoom(zoom: number, direction: "in" | "out"): number {
  const next =
    direction === "in" ? zoom * DIAGRAM_ZOOM_STEP : zoom / DIAGRAM_ZOOM_STEP;
  return Math.min(DIAGRAM_ZOOM_MAX, Math.max(DIAGRAM_ZOOM_MIN, next));
}

export function applyDiagramPinchZoom(zoom: number, deltaY: number): number {
  const next = zoom * Math.exp(-deltaY / 400);
  return Math.min(DIAGRAM_ZOOM_MAX, Math.max(DIAGRAM_ZOOM_MIN, next));
}

export function getDiagramZoomPercent(zoom: number): number {
  return Math.round(zoom * 100);
}

export function getDiagramZoomStyle(zoom: number): CSSProperties | undefined {
  if (zoom === DIAGRAM_ZOOM_DEFAULT) return undefined;
  return {
    width: `calc(100% / ${zoom})`,
    height: `calc(100% / ${zoom})`,
    transform: `scale(${zoom})`,
    transformOrigin: "0 0",
  };
}

export function resetDiagramZoom(): number {
  return DIAGRAM_ZOOM_DEFAULT;
}

interface DiagramViewportProps {
  relPath: string;
  html: string;
  zoom: number;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onZoomIn: () => void;
  onIframeLoad: (event: React.SyntheticEvent<HTMLIFrameElement>) => void;
}

export function DiagramViewport({
  relPath,
  html,
  zoom,
  onZoomOut,
  onZoomReset,
  onZoomIn,
  onIframeLoad,
}: DiagramViewportProps) {
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <div className="absolute top-2 right-2 z-10 flex items-center rounded-md border border-border bg-background/90 p-0.5 shadow-sm">
        <button
          type="button"
          title="ズームアウト"
          disabled={zoom <= DIAGRAM_ZOOM_MIN}
          className="inline-flex size-7 items-center justify-center rounded text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          onClick={onZoomOut}
        >
          −
        </button>
        <button
          type="button"
          title="ズームをリセット"
          className="h-7 min-w-12 rounded px-1 text-xs tabular-nums text-foreground transition-colors hover:bg-accent"
          onClick={onZoomReset}
        >
          {getDiagramZoomPercent(zoom)}%
        </button>
        <button
          type="button"
          title="ズームイン"
          disabled={zoom >= DIAGRAM_ZOOM_MAX}
          className="inline-flex size-7 items-center justify-center rounded text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          onClick={onZoomIn}
        >
          ＋
        </button>
      </div>
      <iframe
        title={relPath}
        srcDoc={html}
        sandbox="allow-scripts"
        className="block h-full w-full border-0 bg-white"
        style={getDiagramZoomStyle(zoom)}
        onLoad={onIframeLoad}
      />
    </div>
  );
}

export function emitDiagramAutosave(
  socket: TypedSocket,
  request: DiagramAutosaveRequest,
  reply: (response: DiagramAutosaveResponse) => void
): void {
  socket.timeout(10_000).emit("diagram:autosave", request, (err, response) => {
    if (err) {
      reply({ ok: false, error: "保存がタイムアウトしました" });
      return;
    }
    reply(response);
  });
}

function isDiagramSubmitMessage(data: unknown): data is DiagramSubmitMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "ark:diagram-submit"
  );
}

function isDiagramAutosaveMessage(
  data: unknown
): data is DiagramAutosaveMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "ark:diagram-autosave"
  );
}

function isDiagramPinchMessage(data: unknown): data is DiagramPinchMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "ark:diagram-pinch" &&
    typeof (data as { deltaY?: unknown }).deltaY === "number" &&
    Number.isFinite((data as { deltaY: number }).deltaY)
  );
}

export function handleDiagramPinchMessage(
  data: unknown,
  setZoom: (update: (zoom: number) => number) => void
): boolean {
  if (!isDiagramPinchMessage(data)) return false;
  setZoom(zoom => applyDiagramPinchZoom(zoom, data.deltaY));
  return true;
}

interface DiagramCommentForwardDeps {
  isConnected: boolean;
  sessionId: string;
  relPath: string;
  getDiagramComments: (
    sessionId: string,
    relPath: string
  ) => Promise<DiagramCommentsResponse>;
  createDiagramComment: (
    sessionId: string,
    relPath: string,
    anchorId: string,
    author: string,
    body: string
  ) => Promise<DiagramCommentsResponse>;
  resolveDiagramComment: (
    sessionId: string,
    relPath: string,
    threadId: string
  ) => Promise<DiagramCommentsResponse>;
  isCurrent: () => boolean;
  reply: (result: DiagramCommentPortResult) => void;
  onError: (error: string | null) => void;
}

export function readDiagramCommentConnectionState(state: {
  readonly current: boolean;
}): boolean {
  return state.current;
}

export async function forwardDiagramCommentPortRequest(
  request: DiagramCommentPortRequest,
  deps: DiagramCommentForwardDeps
): Promise<boolean> {
  let response: DiagramCommentsResponse;
  if (!deps.isConnected) {
    response = {
      ok: false,
      code: "IO_ERROR",
      error: "サーバーに未接続のためコメントを処理できません",
    };
  } else {
    try {
      if (request.type === "ark:diagram-comments-load") {
        response = await deps.getDiagramComments(deps.sessionId, deps.relPath);
      } else if (request.type === "ark:diagram-comment-create") {
        response = await deps.createDiagramComment(
          deps.sessionId,
          deps.relPath,
          request.anchorId,
          request.author,
          request.body
        );
      } else {
        response = await deps.resolveDiagramComment(
          deps.sessionId,
          deps.relPath,
          request.threadId
        );
      }
    } catch (reason) {
      response = {
        ok: false,
        code: "IO_ERROR",
        error:
          reason instanceof Error
            ? reason.message
            : "コメント処理に失敗しました",
      };
    }
  }
  if (!deps.isCurrent()) return false;
  deps.reply(toDiagramCommentPortResult(request.requestId, response));
  deps.onError(response.ok ? null : response.error);
  return true;
}

/**
 * /api/diagram の URL を構築する。
 * リモートアクセス時は token クエリパラメータを継承する。
 */
function buildDiagramUrl(worktreePath: string, relPath: string): string {
  const token = new URLSearchParams(window.location.search).get("token");
  let url =
    `/api/diagram?worktreePath=${encodeURIComponent(worktreePath)}` +
    `&path=${encodeURIComponent(relPath)}`;
  if (token) url += `&token=${encodeURIComponent(token)}`;
  return url;
}

export function DiagramPane({
  sessionId,
  worktreePath,
  relPath,
  socket,
  isConnected,
  listDiagrams,
  deleteDiagram,
  getDiagramComments,
  createDiagramComment,
  resolveDiagramComment,
  onSelectDiagram,
}: DiagramPaneProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [diagrams, setDiagrams] = useState<DiagramListItem[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [listRefreshKey, setListRefreshKey] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState<string | null>(null);
  const [zoom, setZoom] = useState(DIAGRAM_ZOOM_DEFAULT);
  const activeListRequestRef = useRef<object | null>(null);
  const deleteInFlightRef = useRef(false);
  // 進行中の fetch を追跡し、古いタブの結果が新しいタブを上書きしないようにする
  const abortControllerRef = useRef<AbortController | null>(null);
  // ハーネスへ渡した MessageChannel の port1（親側）。再ロードのたびに
  // 張り直すので、常に「今のロードに対応する port」だけを保持する。
  const portRef = useRef<MessagePort | null>(null);
  const portGrantedForRef = useRef<string | null>(null);
  const portGenerationRef = useRef(0);
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;

  const load = useCallback(async () => {
    if (!relPath) return;
    // 前のリクエストをキャンセル。タブ切り替え時に古い fetch が
    // 新しいタブの display を上書きするのを防ぐ（HtmlViewerPane と同じ方針）
    abortControllerRef.current?.abort();

    // 新しい controller を作成
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const res = await fetch(buildDiagramUrl(worktreePath, relPath), {
        signal: controller.signal,
      });

      // 中断済みの場合はステート更新をスキップ
      if (controller.signal.aborted) return;

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        if (controller.signal.aborted) return;
        setError(body?.error ?? `読み込みに失敗しました (${res.status})`);
        setHtml(null);
        return;
      }
      const text = await res.text();
      if (controller.signal.aborted) return;
      setHtml(text);
      setError(null);
    } catch (e) {
      // AbortError は正常なキャンセルなので無視
      if (e instanceof Error && e.name === "AbortError") return;
      if (controller.signal.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
      setHtml(null);
    }
  }, [worktreePath, relPath]);

  // worktreePath / relPath 変更時は、前タブの内容が一瞬残らないよう
  // 先にリセットしてから再取得する（HtmlViewerPane と同じ方針）。
  // load は worktreePath / relPath の変化のたびに作り直される（useCallback の
  // deps 参照）ため、この effect も同じタイミングで再実行される。cleanup で
  // 古い iframe に紐づく port を閉じる（次の load で新しい iframe → 新しい
  // port が張られる。閉じ忘れると古い port がぶら下がり続ける）。
  useEffect(() => {
    setHtml(null);
    setError(null);
    setCommentError(null);
    setZoom(resetDiagramZoom());
    portGenerationRef.current += 1;
    portGrantedForRef.current = null;
    if (!relPath) {
      abortControllerRef.current?.abort();
      portRef.current?.close();
      portRef.current = null;
      return;
    }
    void load();
    return () => {
      portGenerationRef.current += 1;
      portRef.current?.close();
      portRef.current = null;
    };
  }, [load, relPath]);

  // mount / reconnect / current 図変更 / 明示 refresh で一覧を再取得する。
  // request generation により、古い worktree の遅延 ACK は state へ反映しない。
  useEffect(() => {
    const request = { worktreePath, relPath, listRefreshKey };
    activeListRequestRef.current = request;
    if (!isConnected || !worktreePath) {
      setListLoading(false);
      return;
    }

    setListLoading(true);
    void listDiagrams(worktreePath)
      .then(items => {
        if (activeListRequestRef.current !== request) return;
        setDiagrams(items);
        setListError(null);
      })
      .catch(reason => {
        if (activeListRequestRef.current !== request) return;
        setListError(
          reason instanceof Error
            ? reason.message
            : "図一覧の取得に失敗しました"
        );
      })
      .finally(() => {
        if (activeListRequestRef.current === request) {
          setListLoading(false);
        }
      });
    return () => {
      if (activeListRequestRef.current === request) {
        activeListRequestRef.current = null;
      }
    };
  }, [worktreePath, isConnected, relPath, listDiagrams, listRefreshKey]);

  // 図ファイルの更新監視。worktreePath / relPath が変わるたびに
  // 古い購読を解除してから新しい購読を張る。アンマウント時も同様に解除する。
  useEffect(() => {
    if (!socket || !isConnected || !relPath) return;
    socket.emit("diagram:subscribe", { worktreePath, relPath });
    const onUpdated = (data: { worktreePath: string; relPath: string }) => {
      if (data.worktreePath === worktreePath && data.relPath === relPath) {
        void load();
        setListRefreshKey(key => key + 1);
      }
    };
    socket.on("diagram:updated", onUpdated);
    return () => {
      socket.off("diagram:updated", onUpdated);
      socket.emit("diagram:unsubscribe", { worktreePath, relPath });
    };
  }, [socket, isConnected, worktreePath, relPath, load]);

  useEffect(() => {
    if (!socket) return;
    const onDeleted = (data: { sessionId: string; relPath: string }) => {
      if (shouldRefreshDiagramList(sessionId, data)) {
        setListRefreshKey(key => key + 1);
      }
    };
    socket.on("diagram:deleted", onDeleted);
    return () => {
      socket.off("diagram:deleted", onDeleted);
    };
  }, [socket, sessionId]);

  const handleDelete = useCallback(
    async (
      targetRelPath: string,
      expectedTracked: boolean
    ): Promise<boolean> => {
      if (deleteInFlightRef.current) return false;
      deleteInFlightRef.current = true;
      setIsDeleting(true);
      setDeleteMessage(null);
      try {
        const response = await deleteDiagram(
          sessionId,
          targetRelPath,
          expectedTracked
        );
        const next = applyDiagramDeleteResponse(response);
        setDeleteMessage(next.message);
        if (next.refreshList) setListRefreshKey(key => key + 1);
        return response.ok;
      } catch (reason) {
        setDeleteMessage(
          reason instanceof Error ? reason.message : "図の削除に失敗しました"
        );
        return false;
      } finally {
        deleteInFlightRef.current = false;
        setIsDeleting(false);
      }
    },
    [deleteDiagram, sessionId]
  );

  // アンマウント時に進行中の fetch を中止。タブ切り替え直後の
  // アンマウント時に古い fetch が返された結果でステート更新されるのを防ぐ
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  // ハーネスから port 経由で受け取った送信内容を socket:diagram:submit で
  // サーバーへ中継し、ACK で保存/還流の成否を受け取る。失敗時はペインに
  // エラーを表示する（非破壊）。
  const handleSubmit = useCallback(
    (model: unknown, submittedHtml: string) => {
      if (!relPath) return;
      if (!socket || !isConnected) {
        setSubmitError("サーバーに未接続のため送信できません");
        return;
      }
      socket
        .timeout(10_000)
        .emit(
          "diagram:submit",
          { sessionId, worktreePath, relPath, model, html: submittedHtml },
          (err, response) => {
            if (err) {
              setSubmitError("送信がタイムアウトしました");
              return;
            }
            if (!response.ok) {
              setSubmitError(response.error ?? "送信に失敗しました");
              return;
            }
            setSubmitError(null);
          }
        );
    },
    [socket, isConnected, sessionId, worktreePath, relPath]
  );

  // 自動保存はファイルだけを更新し、会話への還流は行わない。ACK は port で
  // ハーネスへ返し、「保存中… / 保存済み」の表示を確定させる。
  const handleAutosave = useCallback(
    (
      model: unknown,
      submittedHtml: string,
      reply: (response: { ok: boolean; error?: string }) => void
    ) => {
      if (!relPath) {
        reply({ ok: false, error: "図が選択されていません" });
        return;
      }
      if (!socket || !isConnected) {
        const error = "サーバーに未接続のため保存できません";
        setSaveError(error);
        reply({ ok: false, error });
        return;
      }
      emitDiagramAutosave(
        socket,
        { sessionId, worktreePath, relPath, model, html: submittedHtml },
        response => {
          setSaveError(
            response.ok ? null : (response.error ?? "自動保存に失敗しました")
          );
          reply(response);
        }
      );
    },
    [socket, isConnected, sessionId, worktreePath, relPath]
  );

  // iframe のロード（初回表示 / worktreePath・relPath 変更 / diagram:updated
  // による再読込のいずれも "load" イベントを起こす）のたびに MessageChannel を
  // 新規に張り直し、port2 をハーネスへ渡す。ハーネス側も document 再生成のたびに
  // submitPort を失うため、古い port を使い回すと繋がらない。
  //
  // ただし「同じ srcDoc に対する2回目以降の load」には渡さない。srcDoc の
  // 正当な再描画は必ず html state の変更（再fetch）を伴うため、同一 html での
  // 再 load は文書内スクリプトが location.href 等で別ドキュメントへ遷移した
  // ことを意味する。meta CSP はサブリソースを遮断するがナビゲーションは
  // 止められない（spec §4.2.2）ので、ここで port を渡すと遷移先の外部
  // ドキュメントに diagram:submit の書き込み経路まで開いてしまう（codex
  // review P1 指摘）。初回限定にすることでこの経路を塞ぐ。
  const handleIframeLoad = useCallback(
    (e: React.SyntheticEvent<HTMLIFrameElement>) => {
      const iframeWindow = e.currentTarget.contentWindow;
      if (!iframeWindow) return;

      if (html !== null && portGrantedForRef.current === html) {
        // 同一文書での2回目の load = 自己ナビゲーション。port を渡さず遮断する
        portRef.current?.close();
        portRef.current = null;
        setError(
          "図が別のページへ遷移しようとしたため接続を遮断しました。図ファイルに外部遷移するスクリプトが含まれていないか確認してください"
        );
        return;
      }
      portGrantedForRef.current = html;

      // 前回の port が残っていれば閉じてから張り替える
      portRef.current?.close();

      const channel = new MessageChannel();
      portRef.current = channel.port1;
      const generation = ++portGenerationRef.current;
      channel.port1.onmessage = (event: MessageEvent) => {
        if (handleDiagramPinchMessage(event.data, setZoom)) return;
        if (isDiagramSubmitMessage(event.data)) {
          handleSubmit(event.data.model, event.data.html);
          return;
        }
        if (isDiagramAutosaveMessage(event.data)) {
          handleAutosave(event.data.model, event.data.html, response => {
            channel.port1.postMessage({
              type: "ark:diagram-autosave-result",
              ...response,
            });
          });
          return;
        }
        const commentRequest = parseDiagramCommentPortRequest(event.data);
        if (commentRequest === null || !relPath) return;
        void forwardDiagramCommentPortRequest(commentRequest, {
          isConnected: readDiagramCommentConnectionState(isConnectedRef),
          sessionId,
          relPath,
          getDiagramComments,
          createDiagramComment,
          resolveDiagramComment,
          isCurrent: () =>
            portGenerationRef.current === generation &&
            portRef.current === channel.port1,
          reply: result => channel.port1.postMessage(result),
          onError: setCommentError,
        });
      };

      // targetOrigin に "*" を使う理由:
      // この iframe は sandbox="allow-scripts"（allow-same-origin 無し）+
      // srcDoc なので不透明オリジンを持ち、event.origin は常に "null" になる
      // （実測済み）。そのため postMessage 側も具体的な targetOrigin を
      // 指定できない。ただし送信先は `iframeWindow`、つまりこの DiagramPane が
      // 自分で srcDoc に書き込んだ文書そのものであり、宛先は window 参照の
      // 時点で一意に特定できている（他のタブ/フレームに渡る余地が無い）。
      // "*" は「誰でも受け取ってよい」という意味ではなく、
      // 「相手のオリジン文字列を検証できない（検証不要）」という意味に限られる。
      iframeWindow.postMessage({ type: "ark:diagram-init" }, "*", [
        channel.port2,
      ]);
    },
    [
      createDiagramComment,
      getDiagramComments,
      handleAutosave,
      handleSubmit,
      html,
      relPath,
      resolveDiagramComment,
      sessionId,
    ]
  );

  return (
    <div className="flex h-full flex-col">
      <DiagramSwitcher
        diagrams={diagrams}
        currentRelPath={relPath}
        onSelect={selectedRelPath =>
          onSelectDiagram(selectedRelPath, worktreePath)
        }
        listLoading={listLoading}
        listError={listError}
        onRetry={() => setListRefreshKey(key => key + 1)}
        onDelete={handleDelete}
        isConnected={isConnected}
        isDeleting={isDeleting}
      />
      {deleteMessage && (
        <div
          className="shrink-0 border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          role="status"
        >
          {deleteMessage}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {!relPath ? (
          <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
            {getDiagramEmptyState(diagrams.length)}
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center p-4 text-sm text-destructive">
            {error}
          </div>
        ) : html === null ? (
          <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
            読み込み中…
          </div>
        ) : (
          <div className="flex h-full flex-col">
            {saveError && (
              <div className="flex shrink-0 items-start justify-between gap-2 border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
                <span className="flex-1">{saveError}</span>
                <button
                  type="button"
                  className="shrink-0 text-xs underline"
                  onClick={() => setSaveError(null)}
                >
                  閉じる
                </button>
              </div>
            )}
            {commentError && (
              <div className="flex shrink-0 items-start justify-between gap-2 border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
                <span className="flex-1">{commentError}</span>
                <button
                  type="button"
                  className="shrink-0 text-xs underline"
                  onClick={() => setCommentError(null)}
                >
                  閉じる
                </button>
              </div>
            )}
            {submitError && (
              <div className="flex shrink-0 items-start justify-between gap-2 border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <span className="flex-1">{submitError}</span>
                <button
                  type="button"
                  className="shrink-0 text-xs underline"
                  onClick={() => setSubmitError(null)}
                >
                  閉じる
                </button>
              </div>
            )}
            <DiagramViewport
              relPath={relPath}
              html={html}
              zoom={zoom}
              onZoomOut={() =>
                setZoom(current => stepDiagramZoom(current, "out"))
              }
              onZoomReset={() => setZoom(resetDiagramZoom())}
              onZoomIn={() =>
                setZoom(current => stepDiagramZoom(current, "in"))
              }
              onIframeLoad={handleIframeLoad}
            />
          </div>
        )}
      </div>
    </div>
  );
}
