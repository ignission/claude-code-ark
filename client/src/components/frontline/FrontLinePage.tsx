// FrontLine ページコンポーネント

import { ArrowLeft } from "lucide-react";
import { Link } from "wouter";
import { useIsMobile } from "@/hooks/useMobile";
import { useSocket } from "@/hooks/useSocket";
import { FrontLineGame } from "./FrontLineGame";
import { MobileControls } from "./MobileControls";

export default function FrontLinePage() {
  const { socket } = useSocket();
  const isMobile = useIsMobile();

  return (
    <div className="min-h-screen bg-black text-white flex flex-col items-center">
      <div className="w-full max-w-[640px] p-4">
        <div className="flex items-center gap-4 mb-4">
          <Link
            href="/"
            aria-label="ダッシュボードへ戻る"
            className="text-gray-400 hover:text-white transition"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <h1 className="text-xl font-bold font-mono tracking-wider">
            FRONT LINE
          </h1>
        </div>
        <FrontLineGame socket={socket} />
        {isMobile && <MobileControls />}
      </div>
    </div>
  );
}
