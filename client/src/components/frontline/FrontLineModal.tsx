// FrontLine モーダルコンポーネント
// PC: 中央モーダル、モバイル: フルスクリーン
// 一度起動したらゲーム状態を保持し、閉じた時はpause、開いた時にresume

import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { useIsMobile } from "@/hooks/useMobile";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "../../../../shared/types";
import { FrontLineGame } from "./FrontLineGame";
import { MobileControls } from "./MobileControls";

type ArkSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface FrontLineModalProps {
  open: boolean;
  onClose: () => void;
  socket: ArkSocket | null;
}

export function FrontLineModal({ open, onClose, socket }: FrontLineModalProps) {
  const isMobile = useIsMobile();
  const [hasOpened, setHasOpened] = useState(false);
  const prevOpenRef = useRef(false);

  if (open && !hasOpened) {
    setHasOpened(true);
  }

  useEffect(() => {
    if (prevOpenRef.current === open) return;
    prevOpenRef.current = open;

    const game = (window as unknown as Record<string, Phaser.Game | undefined>)
      .__FRONTLINE_GAME__;
    if (!game) return;

    if (open) {
      // ゲームループ再開 → シーンresume + PAUSEDオーバーレイ
      game.loop.wake();
      game.events.emit("modal:resume");
    } else {
      // シーンpause（物理・タイマー停止）→ ゲームループ停止（CPU節約）
      game.events.emit("modal:pause");
      game.loop.sleep();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [open, onClose]);

  if (!hasOpened) return null;

  // モバイル: フルスクリーン、PC: 中央モーダル
  if (isMobile) {
    return (
      <div
        className="fixed inset-0 z-40 bg-black flex flex-col pb-14"
        style={
          open ? undefined : { visibility: "hidden", pointerEvents: "none" }
        }
      >
        {/* 閉じるボタン */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 z-10 text-gray-400 hover:text-white transition p-2"
          aria-label="閉じる"
        >
          <X className="w-6 h-6" />
        </button>
        {/* ゲーム */}
        <div className="flex-1 flex items-center justify-center min-h-0">
          <FrontLineGame socket={socket} />
        </div>
        {/* コントロール */}
        <div className="shrink-0 pb-safe">
          <MobileControls />
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={open ? undefined : { visibility: "hidden", pointerEvents: "none" }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: モーダルオーバーレイのクリック閉じ */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={e => {
          e.stopPropagation();
          onClose();
        }}
      />
      <div className="relative bg-black rounded-lg shadow-2xl border border-white/10 max-w-[700px] w-[95vw] max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <h2 className="text-lg font-bold font-mono tracking-wider text-white">
            FRONT LINE
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-white transition p-1"
            aria-label="閉じる"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4">
          <FrontLineGame socket={socket} />
        </div>
      </div>
    </div>
  );
}
