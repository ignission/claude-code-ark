/**
 * 図ファイルを表示するペイン。
 *
 * HtmlViewerPane と同じく fetch した本文を srcDoc に流し込む
 * （認証トークンを iframe 内に露出させないため）。
 * sandbox は allow-scripts のみで allow-same-origin を付けない。
 * 外部送信の遮断は本文に注入された meta CSP が担う（サーバー側で注入済み）。
 */
import type { ClientToServerEvents, ServerToClientEvents } from "@ark/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface DiagramPaneProps {
  sessionId: string;
  worktreePath: string;
  relPath: string;
  /** 未接続時は null。null の間は診断購読をスキップする */
  socket: TypedSocket | null;
}

/** ハーネス（diagram-harness.ts）が port 経由で送ってくるメッセージ */
interface DiagramSubmitMessage {
  type: "ark:diagram-submit";
  model: unknown;
  html: string;
}

function isDiagramSubmitMessage(data: unknown): data is DiagramSubmitMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "ark:diagram-submit"
  );
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
}: DiagramPaneProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // 進行中の fetch を追跡し、古いタブの結果が新しいタブを上書きしないようにする
  const abortControllerRef = useRef<AbortController | null>(null);
  // ハーネスへ渡した MessageChannel の port1（親側）。再ロードのたびに
  // 張り直すので、常に「今のロードに対応する port」だけを保持する。
  const portRef = useRef<MessagePort | null>(null);

  const load = useCallback(async () => {
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
    void load();
    return () => {
      portRef.current?.close();
      portRef.current = null;
    };
  }, [load]);

  // 図ファイルの更新監視。worktreePath / relPath が変わるたびに
  // 古い購読を解除してから新しい購読を張る。アンマウント時も同様に解除する。
  useEffect(() => {
    if (!socket) return;
    socket.emit("diagram:subscribe", { worktreePath, relPath });
    const onUpdated = (data: { worktreePath: string; relPath: string }) => {
      if (data.worktreePath === worktreePath && data.relPath === relPath) {
        void load();
      }
    };
    socket.on("diagram:updated", onUpdated);
    return () => {
      socket.off("diagram:updated", onUpdated);
      socket.emit("diagram:unsubscribe", { worktreePath, relPath });
    };
  }, [socket, worktreePath, relPath, load]);

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
      if (!socket) {
        setSubmitError("サーバーに未接続のため送信できません");
        return;
      }
      socket.emit(
        "diagram:submit",
        { sessionId, worktreePath, relPath, model, html: submittedHtml },
        response => {
          if (!response.ok) {
            setSubmitError(response.error ?? "送信に失敗しました");
            return;
          }
          setSubmitError(null);
        }
      );
    },
    [socket, sessionId, worktreePath, relPath]
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
  const portGrantedForRef = useRef<string | null>(null);
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
      channel.port1.onmessage = (event: MessageEvent) => {
        if (!isDiagramSubmitMessage(event.data)) return;
        handleSubmit(event.data.model, event.data.html);
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
    [handleSubmit, html]
  );

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (html === null) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        読み込み中…
      </div>
    );
  }
  return (
    <div className="relative flex h-full flex-col">
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
      <iframe
        title={relPath}
        srcDoc={html}
        sandbox="allow-scripts"
        className="h-full w-full flex-1 border-0 bg-white"
        onLoad={handleIframeLoad}
      />
    </div>
  );
}
