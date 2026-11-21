/**
 * SidebarMainLayout - PC用2カラムレイアウト
 *
 * サイドバー（セッション一覧） + メイン（セッションの画面）の構成。
 * サイドバー幅はドラッグでリサイズできる。
 *
 * 幅の上限はウィンドウ幅に連動する（`lib/sidebar-width.ts`）。狭いウィンドウで
 * サイドバーを広げると、メインペインの上部バーと、会話に重ねる端末の窓に
 * 残る幅が足りなくなるため。
 * ドラッグ中だけでなく、ウィンドウのリサイズと保存値の読み込みでも丸める。
 *
 * ユーザーが選んだ幅（preferredWidthRef）は丸めた値とは別に覚えておき、
 * ウィンドウを広げ直したときは、丸める前の幅へ戻す。
 *
 * サイドバーは丸ごと畳める (`collapsed`)。畳んだ間は `rail` (開くボタンと「あなたの番」の
 * 件数を載せた細い帯) を代わりに出す。サイドバーは外さずに隠すだけにして、一覧の中の状態
 * (並びの保留、編集中の表示名、件数の通知) を保つ。幅は畳む前のまま覚えておく。
 */

import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  clampSidebarWidth,
  LAYOUT_PADDING_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
} from "@/lib/sidebar-width";

interface SidebarMainLayoutProps {
  sidebar: ReactNode;
  main: ReactNode;
  /** サイドバーを畳んで、代わりに rail を出す */
  collapsed?: boolean;
  /** 畳んだ間に出す細い帯 */
  rail?: ReactNode;
  initialSidebarWidth?: number;
  onSidebarWidthChange?: (width: number) => void;
  /**
   * サイドバーを置く側。既定は左。ホームを決めている間は右に置き、会話を左の主画面にする
   * (lib/home-session.ts)
   */
  side?: "left" | "right";
}

/** ウィンドウ幅。取れない環境では上限の判断から外す（NaN で「制限なし」） */
function viewportWidth(): number {
  return typeof window === "undefined" ? Number.NaN : window.innerWidth;
}

export function SidebarMainLayout({
  sidebar,
  main,
  collapsed = false,
  rail,
  initialSidebarWidth = SIDEBAR_DEFAULT_WIDTH,
  onSidebarWidthChange,
  side = "left",
}: SidebarMainLayoutProps) {
  const onRight = side === "right";
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
        // 画面の外側の余白のぶんだけ、ポインタの位置から引く (今は 0)
        // 右に置いているときは、画面の右端からポインタまでが幅になる
        const newWidth = clampSidebarWidth(
          (onRight ? viewportWidth() - ev.clientX : ev.clientX) -
            LAYOUT_PADDING_WIDTH,
          viewportWidth()
        );
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
    [onSidebarWidthChange, onRight]
  );

  useEffect(() => {
    return () => cleanupRef.current?.();
  }, []);

  return (
    <div
      className={`app-wallpaper h-[100dvh] flex relative ${
        onRight ? "flex-row-reverse" : ""
      }`}
    >
      {resizing && <div className="fixed inset-0 z-50 cursor-col-resize" />}
      {collapsed && (
        <div
          className={`panel-glass w-12 shrink-0 border-sidebar-border ${
            onRight ? "border-l" : "border-r"
          }`}
        >
          {rail}
        </div>
      )}
      <div
        className={`shrink-0 relative flex-col border-sidebar-border ${
          onRight ? "border-l" : "border-r"
        } ${collapsed ? "hidden" : "flex"}`}
        style={{ width: `${sidebarWidth}px` }}
      >
        <div className="panel-glass flex-1 min-h-0 overflow-hidden">
          {sidebar}
        </div>
        {/* 掴める幅は 7px、見える線は border-r の 1px。乗せたときとドラッグ中だけ線に色を出す */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: リサイズハンドルはマウス操作専用 */}
        <div
          className={`absolute inset-y-0 ${
            onRight ? "-left-1" : "-right-1"
          } z-10 w-[7px] cursor-col-resize bg-clip-content px-[3px] hover:bg-ring/70 transition-colors ${
            resizing ? "bg-ring/70" : "bg-transparent"
          }`}
          onMouseDown={handleSidebarResizeStart}
        />
      </div>

      <div className="flex-1 min-w-0 flex flex-col relative">{main}</div>
    </div>
  );
}
