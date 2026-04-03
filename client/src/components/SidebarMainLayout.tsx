/**
 * SidebarMainLayout - PC用3カラムレイアウト
 *
 * サイドバー（セッション一覧） + メイン（ttyd 1ペイン） + Beacon（チャット）
 * の3カラム構成。サイドバー幅はドラッグでリサイズ可能。
 */

import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 450;
const SIDEBAR_DEFAULT_WIDTH = 250;
const SIDEBAR_WIDTH_KEY = "ark-sidebar-width";

interface SidebarMainLayoutProps {
  sidebar: ReactNode;
  main: ReactNode;
  beacon: ReactNode;
}

export function SidebarMainLayout({
  sidebar,
  main,
  beacon,
}: SidebarMainLayoutProps) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
      if (saved) {
        const parsed = Number.parseInt(saved, 10);
        if (parsed >= SIDEBAR_MIN_WIDTH && parsed <= SIDEBAR_MAX_WIDTH)
          return parsed;
      }
    } catch {}
    return SIDEBAR_DEFAULT_WIDTH;
  });
  const [isResizing, setIsResizing] = useState(false);
  const widthRef = useRef(sidebarWidth);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, e.clientX)
      );
      widthRef.current = newWidth;
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      localStorage.setItem(SIDEBAR_WIDTH_KEY, widthRef.current.toString());
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing]);

  return (
    <div className="h-[100dvh] flex relative">
      {/* リサイズ中のオーバーレイ（iframeのマウスイベント吸収を防止） */}
      {isResizing && <div className="fixed inset-0 z-50 cursor-col-resize" />}
      {/* サイドバー */}
      <div
        className="shrink-0 border-r border-border relative"
        style={{ width: `${sidebarWidth}px` }}
      >
        {sidebar}
        {/* リサイズハンドル */}
        <div
          className={`absolute top-0 -right-1 w-3 h-full cursor-col-resize hover:bg-primary/50 transition-colors ${
            isResizing ? "bg-primary/50" : "bg-transparent"
          }`}
          onMouseDown={handleResizeStart}
        />
      </div>

      {/* メインエリア */}
      <div className="flex-1 min-w-0 flex flex-col">{main}</div>

      {/* Beacon */}
      <div className="w-[350px] shrink-0 border-l border-border">{beacon}</div>
    </div>
  );
}
