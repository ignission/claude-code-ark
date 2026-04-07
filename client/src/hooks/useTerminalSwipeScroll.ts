import { useEffect } from "react";
import type { Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "../../../shared/types";

/**
 * モバイル用ターミナルスワイプスクロール。
 * iframe内のtouchイベントハンドラーからpostMessageで送られてくるスクロール要求を受け取り、
 * Socket.IO経由でtmux copy-modeスクロールを送信する。
 */
export function useTerminalSwipeScroll(
  socket: Socket<ServerToClientEvents, ClientToServerEvents> | null,
  sessionId: string
) {
  useEffect(() => {
    if (!socket) return;

    const onMessage = (e: MessageEvent) => {
      // 同一オリジンからのメッセージのみ受け付ける
      if (e.origin !== window.location.origin) return;
      if (e.data?.type === "ark:scroll") {
        socket.emit("session:scroll", {
          sessionId,
          direction: e.data.direction,
          lines: e.data.lines,
        });
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [socket, sessionId]);
}
