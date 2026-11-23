/**
 * SessionSidebar - PCのセッション一覧サイドバー
 *
 * ヘッダー (ワードマークのメニュー・新規作成・ブラウザ) と、
 * 注意の順に並べたセッション一覧 (SessionSectionList) と、
 * 下部に常に出すCPU/MEM/DISK (押すとBridgeを別タブで開く) を出す。
 * About と言語の切り替えはワードマークのメニューにある。
 *
 * 左上のボタンでサイドバーを丸ごと畳む。畳んだ間は SessionSidebarRail が代わりに出る。
 * 畳むボタンと開くボタンは同じ位置に置き、続けて押せるようにする。
 * 帯には「あなたの番」の件数だけを残す (畳んでいても呼ばれたことに気づけるように)。
 */

import type { HostMetrics, Screen } from "@ark/shared";
import { LOCALES } from "@ark/shared/i18n";
import {
  Check,
  ChevronDown,
  Info,
  ListPlus,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
} from "lucide-react";
import type { ReactNode } from "react";
import { SystemStatusBar } from "@/components/bridge/SystemStatusBar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { changeLocale, LOCALE_NAMES, locale, m } from "@/lib/i18n";
import {
  SessionSectionList,
  type SessionSectionListProps,
} from "./SessionSectionList";

type SessionSidebarProps = Omit<SessionSectionListProps, "variant"> & {
  onNewSession: () => void;
  /** 新しいタスクのダイアログを開く (名前とプロンプトだけで worktree とセッションを起こす) */
  onNewTask: () => void;
  /** Aboutダイアログを開く */
  onOpenAbout: () => void;
  /** サイドバーを畳む。無ければボタンを出さない */
  onCollapse?: () => void;
  /** 下部に出すCPU/MEM/DISK (未着はnull) */
  metrics: HostMetrics | null;
  /** 一覧の上に固定で出すホームの行 (lib/home-session.ts)。ホームを決めていなければ無い */
  home?: ReactNode;
  /** リモート画面。onOpenScreenManager が無ければメニューを出さない */
  screens?: Screen[];
  selectedScreenId?: string | null;
  onSelectScreen?: (id: string) => void;
  onOpenScreenManager?: () => void;
};

export function SessionSidebar({
  onNewSession,
  onNewTask,
  onOpenAbout,
  onCollapse,
  metrics,
  home,
  screens = [],
  selectedScreenId = null,
  onSelectScreen,
  onOpenScreenManager,
  ...listProps
}: SessionSidebarProps) {
  return (
    <div className="h-full flex flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 pl-2 pr-2">
        {onCollapse && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={onCollapse}
            aria-label={m.session.sidebar.collapse}
            title={m.session.sidebar.collapse}
          >
            <PanelLeftClose className="size-5" />
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={m.session.sidebar.arkMenu}
              className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[15px] font-semibold tracking-[-0.01em] text-sidebar-foreground transition-colors hover:bg-sidebar-accent"
            >
              Ark
              <ChevronDown
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuItem onSelect={onOpenAbout}>
              <Info />
              About Ark
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{m.common.language}</DropdownMenuLabel>
            {LOCALES.map(code => (
              <DropdownMenuItem
                key={code}
                lang={code}
                onSelect={() => changeLocale(code)}
              >
                {code === locale ? (
                  <Check aria-hidden="true" />
                ) : (
                  <span className="size-4" aria-hidden="true" />
                )}
                {LOCALE_NAMES[code]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={onNewTask}
          aria-label={m.session.sidebar.newTask}
          title={m.session.sidebar.newTask}
        >
          <ListPlus className="size-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={onNewSession}
          aria-label={m.session.sidebar.newSession}
          title={m.session.sidebar.newSession}
        >
          <Plus className="size-5" />
        </Button>
        {onOpenScreenManager && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant={selectedScreenId ? "default" : "ghost"}
                size="icon"
                className="h-8 w-8"
                aria-label={m.session.sidebar.screens}
                aria-pressed={selectedScreenId !== null}
                title={m.session.sidebar.screens}
              >
                <Monitor className="size-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {screens.map(screen => (
                <DropdownMenuItem
                  key={screen.id}
                  onSelect={() => onSelectScreen?.(screen.id)}
                >
                  <Monitor />
                  {screen.name}
                </DropdownMenuItem>
              ))}
              {screens.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem onSelect={onOpenScreenManager}>
                <Settings />
                {m.session.sidebar.manageScreens}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* セッション一覧。
          Radix ScrollAreaを使うとViewportの中にdisplay: tableの無classラッパーが挟まり、
          子要素 (表示名の入力欄など) が想定外に広がるとラッパーが膨らんで水平スクロール状態になる
          (overflow-x: hiddenはViewportに効いてもscrollLeftが焼き付き、確定後に左端を戻せない)。
          素直なdivの縦スクロール + overflow-x: hiddenで水平方向の広がりを抑える。 */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2 pb-3">
        {home}
        <SessionSectionList variant="sidebar" {...listProps} />
      </div>

      <div className="shrink-0 border-t border-sidebar-border px-2 py-1.5">
        <SystemStatusBar metrics={metrics} compact />
      </div>
    </div>
  );
}

/** 畳んだサイドバーの代わりに出す細い帯。開くボタンと「あなたの番」の件数 */
export function SessionSidebarRail({
  yourTurnCount,
  onExpand,
}: {
  yourTurnCount: number;
  onExpand: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center gap-2 pt-2">
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-muted-foreground hover:text-foreground"
        onClick={onExpand}
        aria-label={m.session.sidebar.expand}
        title={m.session.sidebar.expand}
      >
        <PanelLeftOpen className="size-5" />
      </Button>
      {yourTurnCount > 0 && (
        <button
          type="button"
          onClick={onExpand}
          aria-label={m.session.sidebar.yourTurnCount(yourTurnCount)}
          title={m.session.sidebar.yourTurnCount(yourTurnCount)}
          className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-status-awaiting/15 px-1.5 text-xs font-semibold tabular-nums text-status-awaiting"
        >
          {yourTurnCount}
        </button>
      )}
    </div>
  );
}
