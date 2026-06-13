/**
 * useSlashCommands - 指定セッションで利用可能な slash command 候補をサーバから取得。
 *
 * `slash:list` Socket.IO イベントを 1 回叩いてキャッシュ。
 * セッション切替 / socket 再接続で再取得する。手動 reload も export。
 */

import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SlashCommandInfo,
} from "@ark/shared";
import { useCallback, useEffect, useState } from "react";
import type { Socket } from "socket.io-client";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface UseSlashCommandsResult {
  commands: SlashCommandInfo[];
  isLoading: boolean;
  error: string | null;
  reload: () => void;
}

export function useSlashCommands(
  socket: TypedSocket | null,
  sessionId: string | null
): UseSlashCommandsResult {
  const [commands, setCommands] = useState<SlashCommandInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey(k => k + 1), []);

  useEffect(() => {
    // reloadKey は reload() からの再実行トリガとして deps に含めている。
    // effect 内で実値を参照しないため `void` で明示的に使用した形にしておく
    void reloadKey;
    if (!socket || !sessionId) {
      setCommands([]);
      setError(null);
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    socket.emit("slash:list", sessionId, response => {
      if (cancelled) return;
      setIsLoading(false);
      if (response.error) {
        setError(response.error);
        setCommands([]);
        return;
      }
      setCommands(response.commands ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [socket, sessionId, reloadKey]);

  return { commands, isLoading, error, reload };
}
