import type {
  ClientToServerEvents,
  HostMetrics,
  ServerToClientEvents,
} from "@ark/shared";
import { useEffect, useState } from "react";
import type { Socket } from "socket.io-client";

type ArkSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * `host:metrics` を購読して最新のホストのメトリクスを返すフック。
 *
 * `enabled=true` のときだけ購読し、`false` か unmount で `host:metrics:unsubscribe` を送る。
 * Bridgeの購読 (`bridge:subscribe`) と違い、サーバーはセッションを収集しない。
 * 再接続するとサーバー側の購読 (room) が消えるので、connect のたびに購読し直す。
 */
export function useHostMetrics(
  socket: ArkSocket | null,
  enabled: boolean
): HostMetrics | null {
  const [metrics, setMetrics] = useState<HostMetrics | null>(null);

  useEffect(() => {
    if (!socket || !enabled) return;

    const subscribe = () => socket.emit("host:metrics:subscribe");
    const onMetrics = (next: HostMetrics) => setMetrics(next);

    if (socket.connected) subscribe();
    socket.on("connect", subscribe);
    socket.on("host:metrics", onMetrics);

    return () => {
      socket.off("connect", subscribe);
      socket.off("host:metrics", onMetrics);
      if (socket.connected) socket.emit("host:metrics:unsubscribe");
    };
  }, [socket, enabled]);

  return metrics;
}
