/**
 * SidebarMainLayout - PC用2カラムレイアウト
 *
 * サイドバー（セッション一覧） + メイン（ttyd 1ペイン）の構成。
 * サイドバー幅はドラッグでリサイズできる。
 *
 * 幅の上限はウィンドウ幅に連動する（`lib/sidebar-width.ts`）。メインペインの
 * 上部バーには端末モードで1タップの操作が並ぶので、狭いウィンドウで
 * サイドバーを広げると右端の `…` が切れてしまうため。
 * ドラッグ中だけでなく、ウィンドウのリサイズと保存値の読み込みでも丸める。
 *
 * ユーザーが選んだ幅（preferredWidthRef）は丸めた値とは別に覚えておき、
 * ウィンドウを広げ直したときは、丸める前の幅へ戻す。
 */

import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { clampSidebarWidth, SIDEBAR_DEFAULT_WIDTH } from "@/lib/sidebar-width";

interface SidebarMainLayoutProps {
  sidebar: ReactNode;
  main: ReactNode;
  initialSidebarWidth?: number;
  onSidebarWidthChange?: (width: number) => void;
}

/** ウィンドウ幅。取れない環境では上限の判断から外す（NaN で「制限なし」） */
function viewportWidth(): number {
  return typeof window === "undefined" ? Number.NaN : window.innerWidth;
}

export function SidebarMainLayout({
  sidebar,
  main,
  initialSidebarWidth = SIDEBAR_DEFAULT_WIDTH,
  onSidebarWidthChange,
}: SidebarMainLayoutProps) {
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    clampSidebarWidth(initialSidebarWidth, viewportWidth())
  );
  const [resizing, setResizing] = useState(false);
  const sidebarWidthRef = useRef(sidebarWidth);
  // ユーザーが選んだ幅。ウィンドウを狭めて丸めたあと、また広げたら戻す
  const preferredWidthRef = useRef(initialSidebarWidth);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    preferredWidthRef.current = initialSidebarWidth;
    const clamped = clampSidebarWidth(initialSidebarWidth, viewportWidth());
    setSidebarWidth(clamped);
    sidebarWidthRef.current = clamped;
  }, [initialSidebarWidth]);

  // ウィンドウのリサイズでも上限を当て直す。先に広げてから縮める経路で
  // メインペインが潰れないようにする。保存はしない（選んだ幅は覚えたまま）
  useEffect(() => {
    const handleResize = () => {
      const clamped = clampSidebarWidth(
        preferredWidthRef.current,
        viewportWidth()
      );
      sidebarWidthRef.current = clamped;
      setSidebarWidth(clamped);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const handleSidebarResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setResizing(true);

      const handleMouseMove = (ev: MouseEvent) => {
        const newWidth = clampSidebarWidth(ev.clientX, viewportWidth());
        preferredWidthRef.current = newWidth;
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
        className="shrink-0 relative flex flex-col"
        style={{ width: `${sidebarWidth}px` }}
      >
        <div className="flex-1 min-h-0 overflow-hidden">{sidebar}</div>
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
