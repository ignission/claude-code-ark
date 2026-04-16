// FrontLine Phaser ゲームの React ラッパー

import Phaser from "phaser";
import { useEffect, useRef } from "react";
import type { Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  FrontlineRecord,
  FrontlineRecordSaved,
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
    (window as unknown as Record<string, unknown>).__FRONTLINE_GAME__ = game;

    // モーダル内ではcanvasのblurでPhaserのInputManagerが無効化される問題を回避
    // InputManagerの初期化完了を待ってからblur/focusハンドラを除去し、常にアクティブに保つ
    let patchTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    const patchInput = () => {
      if (disposed) return;
      if ((game.input as any)?.manager) {
        game.events.removeAllListeners("blur");
        game.events.removeAllListeners("focus");
        (game.input as any).manager.isActive = true;
      } else {
        patchTimer = setTimeout(patchInput, 100);
      }
    };
    game.events.once("ready", patchInput);

    const onMobileAction = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      gameRef.current?.events.emit("mobile:action", detail);
    };

    window.addEventListener("frontline:mobile", onMobileAction);

    return () => {
      disposed = true;
      if (patchTimer) clearTimeout(patchTimer);
      window.removeEventListener("frontline:mobile", onMobileAction);
      game.destroy(true);
      gameRef.current = null;
      (window as unknown as Record<string, unknown>).__FRONTLINE_GAME__ =
        undefined;
    };
  }, []);

  useEffect(() => {
    const game = gameRef.current;
    if (!game) return;

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

    const onRecordSaved = (data: FrontlineRecordSaved) => {
      game.events.emit("frontline:record_saved_received", data);
    };

    const onFrontlineError = (data: {
      action: "get_stats" | "get_records" | "save_record";
      message: string;
    }) => {
      game.events.emit("frontline:error_received", data);
    };

    socket?.on("frontline:stats", onStatsReceived);
    socket?.on("frontline:record_saved", onRecordSaved);
    socket?.on("frontline:error", onFrontlineError);

    return () => {
      socket?.off("frontline:stats", onStatsReceived);
      socket?.off("frontline:record_saved", onRecordSaved);
      socket?.off("frontline:error", onFrontlineError);
      game.events.off("frontline:save_record", onSaveRecord);
      game.events.off("frontline:get_stats", onGetStats);
    };
  }, [socket]);

  return (
    <div
      ref={containerRef}
      style={{ imageRendering: "pixelated", minHeight: "250px" }}
      className="w-full max-w-[640px] mx-auto"
    />
  );
}
