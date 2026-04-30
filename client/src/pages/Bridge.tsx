/**
 * Bridge ページ — Ark のメインダッシュボード
 *
 * 1280x720 固定レイアウトの 1bit Mac OS 風モニタリング画面。
 * 5インチサブディスプレイ常駐を主目的とするが、ブラウザタブでも閲覧できる。
 *
 * 上半分: 全セッションのグリッド (状態 + ターミナル末尾プレビュー)
 * 下半分: System Monitor (CPU / Cores / Memory / Storage)
 *
 * フォーカス概念やライブストリームは持たない (静的スナップショット型)。
 */

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  BridgeSnapshot,
  ClientToServerEvents,
  ServerToClientEvents,
} from "../../../shared/types";
import { BridgeDashboard } from "../components/bridge/BridgeDashboard";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

function getTokenFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("token");
}

export default function Bridge() {
  const socketRef = useRef<TypedSocket | null>(null);
  const [snapshot, setSnapshot] = useState<BridgeSnapshot | null>(null);
  const [now, setNow] = useState(new Date());

  // 時計表示を 30秒ごとに更新（メニューバー用）
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Socket.IO 接続 (1回だけ確立)
  useEffect(() => {
    const token = getTokenFromUrl();
    const socket: TypedSocket = io({
      auth: token ? { token } : undefined,
      transports: ["websocket"],
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("bridge:subscribe", { focusSessionId: null });
    });

    socket.on("bridge:snapshot", snap => {
      setSnapshot(snap);
    });

    return () => {
      socket.emit("bridge:unsubscribe");
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#000",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "auto",
      }}
    >
      <BridgeDashboard snapshot={snapshot} now={now} />
    </div>
  );
}
