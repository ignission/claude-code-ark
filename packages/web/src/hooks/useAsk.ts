/**
 * useAsk - 裏の Claude (コマンドパレットの「聞く」) との会話
 *
 * 会話はサーバーが持ち、`ask:state` で丸ごと届く。ここは受け取って渡すだけ。
 * 再接続したときは取り直す (切れている間の答えを取りこぼさない)。
 */

import type {
  AskResult,
  AskState,
  ClientToServerEvents,
  ServerToClientEvents,
} from "@ark/shared";
import { useCallback, useEffect, useState } from "react";
import type { Socket } from "socket.io-client";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const EMPTY: AskState = { messages: [], busy: false, error: null };
const NOT_CONNECTED = "サーバーに未接続です";
const NO_RESPONSE = "サーバーから応答がありません";

export interface UseAsk {
  state: AskState;
  /** 送る前に弾かれた理由 (未接続・応答なし)。サーバー側の失敗は state.error */
  sendError: string | null;
  send: (text: string) => void;
  reset: () => void;
}

export function useAsk(socket: TypedSocket | null): UseAsk {
  const [state, setState] = useState<AskState>(EMPTY);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    if (!socket) return;
    const fetchState = () => socket.emit("ask:get", setState);
    socket.on("ask:state", setState);
    socket.on("connect", fetchState);
    if (socket.connected) fetchState();
    return () => {
      socket.off("ask:state", setState);
      socket.off("connect", fetchState);
    };
  }, [socket]);

  const request = useCallback(
    (
      emit: (socket: TypedSocket, done: (result: AskResult) => void) => void
    ) => {
      if (!socket?.connected) {
        setSendError(NOT_CONNECTED);
        return;
      }
      setSendError(null);
      emit(socket, result => {
        // サーバー側の失敗は ask:state の error にも載るので、ここでは重ねて出さない
        if (!result) setSendError(NO_RESPONSE);
      });
    },
    [socket]
  );

  const send = useCallback(
    (text: string) =>
      request((target, done) => target.emit("ask:send", { text }, done)),
    [request]
  );
  const reset = useCallback(
    () => request((target, done) => target.emit("ask:reset", done)),
    [request]
  );

  return { state, sendError, send, reset };
}
