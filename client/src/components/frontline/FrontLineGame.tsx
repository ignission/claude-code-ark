// FrontLine Phaser ゲームの React ラッパー

import Phaser from "phaser";
import { useEffect, useRef } from "react";
import type { Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  FrontlineRecord,
  FrontlineStats,
  ServerToClientEvents,
} from "../../../../shared/types";
import { createGameConfig } from "./game/config";

type ArkSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface FrontLineGameProps {
  socket: ArkSocket | null;
}

export function FrontLineGame({ socket }: FrontLineGameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const game = new Phaser.Game(createGameConfig(containerRef.current));
    gameRef.current = game;

    // --- Bridge: game.events → socket ---

    const onSaveRecord = (data: Omit<FrontlineRecord, "id" | "createdAt">) => {
      socket?.emit("frontline:save_record", data);
    };

    const onGetStats = () => {
      socket?.emit("frontline:get_stats");
    };

    game.events.on("frontline:save_record", onSaveRecord);
    game.events.on("frontline:get_stats", onGetStats);

    // --- Bridge: socket → game.events ---

    const onStatsReceived = (stats: FrontlineStats) => {
      game.events.emit("frontline:stats_received", stats);
    };

    socket?.on("frontline:stats", onStatsReceived);

    // --- Bridge: window CustomEvent → game.events ---

    const onMobileAction = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      game.events.emit("mobile:action", detail);
    };

    window.addEventListener("frontline:mobile", onMobileAction);

    return () => {
      window.removeEventListener("frontline:mobile", onMobileAction);
      socket?.off("frontline:stats", onStatsReceived);
      game.events.off("frontline:save_record", onSaveRecord);
      game.events.off("frontline:get_stats", onGetStats);
      game.destroy(true);
      gameRef.current = null;
    };
  }, [socket]);

  return (
    <div
      ref={containerRef}
      style={{ imageRendering: "pixelated" }}
      className="w-full max-w-[640px] mx-auto"
    />
  );
}
