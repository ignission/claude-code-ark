/**
 * SidebarMainLayout - PC用2カラムレイアウト
 *
 * サイドバー（セッション一覧） + メイン（ttyd 1ペイン）の構成。
 * サイドバー幅はドラッグでリサイズできる。
 */

import type { HostMetrics } from "@ark/shared";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { SystemStatusBar } from "./bridge/SystemStatusBar";

const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 450;
const SIDEBAR_DEFAULT_WIDTH = 250;

interface SidebarMainLayoutProps {
  sidebar: ReactNode;
  main: ReactNode;
  initialSidebarWidth?: number;
  onSidebarWidthChange?: (width: number) => void;
  /** About ダイアログを開く (同梱バイナリの LICENSE 一覧) */
  onOpenAboutDialog?: () => void;
  hostMetrics?: HostMetrics | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function SidebarMainLayout({
  sidebar,
  main,
  initialSidebarWidth = SIDEBAR_DEFAULT_WIDTH,
  onSidebarWidthChange,
  onOpenAboutDialog,
  hostMetrics = null,
}: SidebarMainLayoutProps) {
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    clamp(initialSidebarWidth, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)
  );
  const [resizing, setResizing] = useState(false);
  const sidebarWidthRef = useRef(sidebarWidth);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const clamped = clamp(
      initialSidebarWidth,
      SIDEBAR_MIN_WIDTH,
      SIDEBAR_MAX_WIDTH
    );
    setSidebarWidth(clamped);
    sidebarWidthRef.current = clamped;
  }, [initialSidebarWidth]);

  const handleSidebarResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setResizing(true);

      const handleMouseMove = (ev: MouseEvent) => {
        const newWidth = clamp(
          ev.clientX,
          SIDEBAR_MIN_WIDTH,
          SIDEBAR_MAX_WIDTH
        );
        sidebarWidthRef.current = newWidth;
        setSidebarWidth(newWidth);
      };

      const handleMouseUp = () => {
        setResizing(false);
        onSidebarWidthChange?.(sidebarWidthRef.current);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        cleanupRef.current = null;
      };

      cleanupRef.current = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [onSidebarWidthChange]
  );

  useEffect(() => {
    return () => cleanupRef.current?.();
  }, []);

  return (
    <div className="h-[100dvh] flex relative">
      {resizing && <div className="fixed inset-0 z-50 cursor-col-resize" />}
      <div
        className="shrink-0 border-r border-border relative flex flex-col"
        style={{ width: `${sidebarWidth}px` }}
      >
        <div className="flex-1 min-h-0 overflow-hidden">{sidebar}</div>
        {onOpenAboutDialog && (
          <button
            type="button"
            onClick={onOpenAboutDialog}
            className="w-full py-2 text-sm text-muted-foreground hover:text-foreground border-t border-border transition-colors block text-center"
          >
            ℹ About Ark
          </button>
        )}
        <SystemStatusBar metrics={hostMetrics} />
        {/* biome-ignore lint/a11y/noStaticElementInteractions: リサイズハンドルはマウス操作専用 */}
        <div
          className={`absolute top-0 -right-1 w-3 h-full cursor-col-resize hover:bg-primary/50 transition-colors ${
            resizing ? "bg-primary/50" : "bg-transparent"
          }`}
          onMouseDown={handleSidebarResizeStart}
        />
      </div>

      <div className="flex-1 min-w-0 flex flex-col relative">{main}</div>
    </div>
  );
}
