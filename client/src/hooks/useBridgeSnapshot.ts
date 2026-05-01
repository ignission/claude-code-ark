import { useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import type {
  BridgeSnapshot,
  ClientToServerEvents,
  ServerToClientEvents,
} from "../../../shared/types";

type ArkSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * `bridge:snapshot` を購読して最新の BridgeSnapshot を返すフック。
 *
 * `enabled=true` のときのみ購読し、`false` または unmount で `bridge:unsubscribe` を送る。
 *
 * 同一ソケットでの並行呼び出しは想定していない。cleanup は無条件に
 * `bridge:unsubscribe` を送るので、別箇所がまだ購読中だと巻き添えで購読解除される。
 * 複数消費者が必要になったら refcount などで対応すること。
 */
export function useBridgeSnapshot(
  socket: ArkSocket | null,
  enabled: boolean
): BridgeSnapshot | null {
  const [snapshot, setSnapshot] = useState<BridgeSnapshot | null>(null);

  useEffect(() => {
    if (!socket || !enabled) return;

    const subscribe = () =>
      socket.emit("bridge:subscribe", { focusSessionId: null });

    const onSnapshot = (snap: BridgeSnapshot) => setSnapshot(snap);

    if (socket.connected) subscribe();
    socket.on("connect", subscribe);
    socket.on("bridge:snapshot", onSnapshot);

    return () => {
      socket.off("connect", subscribe);
      socket.off("bridge:snapshot", onSnapshot);
      if (socket.connected) socket.emit("bridge:unsubscribe");
    };
  }, [socket, enabled]);

  return snapshot;
}
