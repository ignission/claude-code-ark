/**
 * 図ファイルを表示するペイン。
 *
 * HtmlViewerPane と同じく fetch した本文を srcDoc に流し込む
 * （認証トークンを iframe 内に露出させないため）。
 * sandbox は allow-scripts のみで allow-same-origin を付けない。
 * 外部送信の遮断は本文に注入された meta CSP が担う（サーバー側で注入済み）。
 */
import type { ClientToServerEvents, ServerToClientEvents } from "@ark/shared";
import { useCallback, useEffect, useState } from "react";
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

  const load = useCallback(async () => {
    try {
      const res = await fetch(buildDiagramUrl(worktreePath, relPath));
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(body?.error ?? `読み込みに失敗しました (${res.status})`);
        setHtml(null);
        return;
      }
      setHtml(await res.text());
      setError(null);
    } catch (e) {
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
