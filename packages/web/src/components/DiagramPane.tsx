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
  worktreePath: string;
  relPath: string;
  /** 未接続時は null。null の間は診断購読をスキップする（CanvasPane と同じ方針） */
  socket: TypedSocket | null;
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
  worktreePath,
  relPath,
  socket,
}: DiagramPaneProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 進行中の fetch を追跡し、古いタブの結果が新しいタブを上書きしないようにする
  const abortControllerRef = useRef<AbortController | null>(null);

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
  // 先にリセットしてから再取得する（HtmlViewerPane と同じ方針）
  useEffect(() => {
    setHtml(null);
    setError(null);
    void load();
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
    <iframe
      title={relPath}
      srcDoc={html}
      sandbox="allow-scripts"
      className="h-full w-full border-0 bg-white"
    />
  );
}
