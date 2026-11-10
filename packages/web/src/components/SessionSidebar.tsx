/**
 * SessionSidebar - PCのセッション一覧サイドバー
 *
 * ヘッダー (ワードマークのメニュー・新規作成・通知許可・ブラウザ) と、
 * 注意の順に並べたセッション一覧 (SessionSectionList) と、
 * 下部に常に出すCPU/MEM/DISK (押すとBridgeを別タブで開く) を出す。
 * About と言語の切り替えはワードマークのメニューにある。
 */

import type { HostMetrics, Screen } from "@ark/shared";
import { LOCALES } from "@ark/shared/i18n";
import {
  Check,
  ChevronDown,
  Info,
  ListPlus,
  Monitor,
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
  /** 下部に出すCPU/MEM/DISK (未着はnull) */
  metrics: HostMetrics | null;
  notificationControl?: ReactNode;
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
  metrics,
  notificationControl,
  screens = [],
  selectedScreenId = null,
  onSelectScreen,
  onOpenScreenManager,
  ...listProps
}: SessionSidebarProps) {
  return (
    <div className="h-full flex flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 pl-2 pr-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Arkのメニュー"
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
          aria-label="新しいタスク"
          title="新しいタスク"
        >
          <ListPlus className="size-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={onNewSession}
          aria-label="新規セッション"
          title="新規セッション"
        >
          <Plus className="size-5" />
        </Button>
        {notificationControl}
        {onOpenScreenManager && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant={selectedScreenId ? "default" : "ghost"}
                size="icon"
                className="h-8 w-8"
                aria-label="画面"
                aria-pressed={selectedScreenId !== null}
                title="画面"
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
                画面の管理...
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
        <SessionSectionList variant="sidebar" {...listProps} />
      </div>

      <div className="shrink-0 border-t border-sidebar-border px-2 py-1.5">
        <SystemStatusBar metrics={metrics} compact />
      </div>
    </div>
  );
}
