// FrontLine ページコンポーネント

import { ArrowLeft } from "lucide-react";
import { Link } from "wouter";
import { useSocket } from "@/hooks/useSocket";
import { FrontLineGame } from "./FrontLineGame";

export default function FrontLinePage() {
  const { socket } = useSocket();

  return (
    <div className="min-h-screen bg-black text-white flex flex-col items-center">
      <div className="w-full max-w-[640px] p-4">
        <div className="flex items-center gap-4 mb-4">
          <Link href="/" className="text-gray-400 hover:text-white transition">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <h1 className="text-xl font-bold font-mono tracking-wider">
            FRONT LINE
          </h1>
        </div>
        <FrontLineGame socket={socket} />
      </div>
    </div>
  );
}
