/**
 * SidebarMainLayout - PC用3カラムレイアウト
 *
 * サイドバー（セッション一覧） + メイン（ttyd 1ペイン） + Beacon（チャット）
 * の3カラム構成。サイドバー・Beacon幅はドラッグでリサイズ可能、Beaconは表示/非表示を切替可能。
 */

import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { HostMetrics } from "../../../shared/types";
import { SystemStatusBar } from "./bridge/SystemStatusBar";

const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 450;
const SIDEBAR_DEFAULT_WIDTH = 250;

const BEACON_MIN_WIDTH = 280;
const BEACON_MAX_WIDTH = 700;
const BEACON_DEFAULT_WIDTH = 350;

// メインエリアが最低限保持すべき幅（これ未満には潰れないようBeacon/Sidebarを制限）
const MAIN_MIN_WIDTH = 320;

interface SidebarMainLayoutProps {
  sidebar: ReactNode;
  main: ReactNode;
  beacon: ReactNode;
  initialSidebarWidth?: number;
  onSidebarWidthChange?: (width: number) => void;
  onOpenFrontLine?: () => void;
  hostMetrics?: HostMetrics | null;
  beaconVisible?: boolean;
  onBeaconVisibleChange?: (visible: boolean) => void;
  initialBeaconWidth?: number;
  onBeaconWidthChange?: (width: number) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// 現在のサイドバー幅とviewport幅から、Beacon幅の上限を計算する
function resolveBeaconMax(sidebarWidth: number): number {
  if (typeof window === "undefined") return BEACON_MAX_WIDTH;
  const available = window.innerWidth - sidebarWidth - MAIN_MIN_WIDTH;
  // availableが下限を下回る場合はBEACON_MIN_WIDTHまで許容（main側が潰れてもBeaconはmin死守）
  return Math.max(BEACON_MIN_WIDTH, Math.min(BEACON_MAX_WIDTH, available));
}

export function SidebarMainLayout({
  sidebar,
  main,
  beacon,
  initialSidebarWidth = SIDEBAR_DEFAULT_WIDTH,
  onSidebarWidthChange,
  onOpenFrontLine,
  hostMetrics = null,
  beaconVisible = true,
  onBeaconVisibleChange,
  initialBeaconWidth = BEACON_DEFAULT_WIDTH,
  onBeaconWidthChange,
}: SidebarMainLayoutProps) {
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    clamp(initialSidebarWidth, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)
  );
  const [beaconWidth, setBeaconWidth] = useState(() => {
    const initialSb = clamp(
      initialSidebarWidth,
      SIDEBAR_MIN_WIDTH,
      SIDEBAR_MAX_WIDTH
    );
    return clamp(
      initialBeaconWidth,
      BEACON_MIN_WIDTH,
      resolveBeaconMax(initialSb)
    );
  });
  const [resizing, setResizing] = useState<"sidebar" | "beacon" | null>(null);
  const sidebarWidthRef = useRef(sidebarWidth);
  const beaconWidthRef = useRef(beaconWidth);
  const cleanupRef = useRef<(() => void) | null>(null);
  const onBeaconWidthChangeRef = useRef(onBeaconWidthChange);

  useEffect(() => {
    onBeaconWidthChangeRef.current = onBeaconWidthChange;
  }, [onBeaconWidthChange]);

  useEffect(() => {
    const clamped = clamp(
      initialSidebarWidth,
      SIDEBAR_MIN_WIDTH,
      SIDEBAR_MAX_WIDTH
    );
    setSidebarWidth(clamped);
    sidebarWidthRef.current = clamped;
  }, [initialSidebarWidth]);

  useEffect(() => {
    const clamped = clamp(
      initialBeaconWidth,
      BEACON_MIN_WIDTH,
      resolveBeaconMax(sidebarWidthRef.current)
    );
    setBeaconWidth(clamped);
    beaconWidthRef.current = clamped;
  }, [initialBeaconWidth]);

  // ウィンドウリサイズ時にBeaconが新しい上限を超えていたら縮める
  useEffect(() => {
    const handleResize = () => {
      const max = resolveBeaconMax(sidebarWidthRef.current);
      if (beaconWidthRef.current > max) {
        beaconWidthRef.current = max;
        setBeaconWidth(max);
        onBeaconWidthChangeRef.current?.(max);
      }
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const handleSidebarResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setResizing("sidebar");

      const handleMouseMove = (ev: MouseEvent) => {
        const newWidth = clamp(
          ev.clientX,
          SIDEBAR_MIN_WIDTH,
          SIDEBAR_MAX_WIDTH
        );
        sidebarWidthRef.current = newWidth;
        setSidebarWidth(newWidth);
        // サイドバー拡大でBeaconの許容上限を超えたら縮める
        const beaconMax = resolveBeaconMax(newWidth);
        if (beaconWidthRef.current > beaconMax) {
          beaconWidthRef.current = beaconMax;
          setBeaconWidth(beaconMax);
        }
      };

      const handleMouseUp = () => {
        setResizing(null);
        onSidebarWidthChange?.(sidebarWidthRef.current);
        onBeaconWidthChangeRef.current?.(beaconWidthRef.current);
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

  const handleBeaconResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setResizing("beacon");

      const handleMouseMove = (ev: MouseEvent) => {
        const newWidth = clamp(
          window.innerWidth - ev.clientX,
          BEACON_MIN_WIDTH,
          resolveBeaconMax(sidebarWidthRef.current)
        );
        beaconWidthRef.current = newWidth;
        setBeaconWidth(newWidth);
      };

      const handleMouseUp = () => {
        setResizing(null);
        onBeaconWidthChange?.(beaconWidthRef.current);
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
    [onBeaconWidthChange]
  );

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  const isResizing = resizing !== null;

  return (
    <div className="h-[100dvh] flex relative">
      {/* リサイズ中のオーバーレイ（iframeのマウスイベント吸収を防止） */}
      {isResizing && <div className="fixed inset-0 z-50 cursor-col-resize" />}
      {/* サイドバー */}
      <div
        className="shrink-0 border-r border-border relative flex flex-col"
        style={{ width: `${sidebarWidth}px` }}
      >
        <div className="flex-1 min-h-0 overflow-hidden">{sidebar}</div>
        {onOpenFrontLine && (
          <button
            type="button"
            onClick={onOpenFrontLine}
            className="w-full py-2 text-sm text-muted-foreground hover:text-foreground border-t border-border transition-colors block text-center"
          >
            🎯 FrontLine
          </button>
        )}
        <SystemStatusBar metrics={hostMetrics} />
        {/* biome-ignore lint/a11y/noStaticElementInteractions: リサイズハンドルはマウス操作専用 */}
        <div
          className={`absolute top-0 -right-1 w-3 h-full cursor-col-resize hover:bg-primary/50 transition-colors ${
            resizing === "sidebar" ? "bg-primary/50" : "bg-transparent"
          }`}
          onMouseDown={handleSidebarResizeStart}
        />
      </div>

      {/* メインエリア */}
      <div className="flex-1 min-w-0 flex flex-col relative">
        {main}
        {/* Beacon非表示時の展開ボタン */}
        {!beaconVisible && onBeaconVisibleChange && (
          <button
            type="button"
            onClick={() => onBeaconVisibleChange(true)}
            aria-label="Beaconを表示"
            title="Beaconを表示"
            className="absolute top-2 right-2 z-10 p-1.5 rounded-md bg-background/80 border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Beacon */}
      {beaconVisible && (
        <div
          className="shrink-0 border-l border-border relative"
          style={{ width: `${beaconWidth}px` }}
        >
          {beacon}
        </div>
      )}

      {/* Beaconリサイズハンドル（レイアウト直下配置でiframe/内部要素の干渉を回避） */}
      {beaconVisible && (
        <>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: リサイズハンドルはマウス操作専用 */}
          <div
            className={`absolute top-0 w-3 h-full cursor-col-resize hover:bg-primary/50 transition-colors z-40 ${
              resizing === "beacon" ? "bg-primary/50" : "bg-transparent"
            }`}
            style={{ right: `${beaconWidth - 6}px` }}
            onMouseDown={handleBeaconResizeStart}
          />
          {onBeaconVisibleChange && (
            <button
              type="button"
              onClick={() => onBeaconVisibleChange(false)}
              aria-label="Beaconを非表示"
              title="Beaconを非表示"
              className="absolute top-3 z-40 p-1 rounded-full bg-background border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shadow-sm"
              style={{ right: `${beaconWidth - 6}px` }}
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          )}
        </>
      )}
    </div>
  );
}
