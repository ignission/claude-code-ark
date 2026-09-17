/**
 * SessionSidebar - PCのセッション一覧サイドバー
 *
 * ヘッダー (ワードマークのメニュー・新規作成・通知許可・ブラウザ) と、
 * 注意の順に並べたセッション一覧 (SessionSectionList) を出す。
 * About (CPU/MEM/DISKとBridgeへのリンクを含む) はワードマークのメニューから開く。
 */

import { ChevronDown, Globe, Info, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SessionSectionList,
  type SessionSectionListProps,
} from "./SessionSectionList";

type SessionSidebarProps = Omit<SessionSectionListProps, "variant"> & {
  onNewSession: () => void;
  /** Aboutダイアログを開く */
  onOpenAbout: () => void;
  /** ブラウザ選択コールバック (リモートアクセス時のみ使用) */
  onSelectBrowser?: () => void;
  isBrowserSelected?: boolean;
  isRemote?: boolean;
  notificationControl?: ReactNode;
};

export function SessionSidebar({
  onNewSession,
  onOpenAbout,
  onSelectBrowser,
  isBrowserSelected = false,
  isRemote = false,
  notificationControl,
  ...listProps
}: SessionSidebarProps) {
  return (
    <div className="h-full flex flex-col bg-sidebar">
      <div className="flex h-14 shrink-0 items-center gap-1 pl-3 pr-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Arkのメニュー"
              className="inline-flex h-9 items-center gap-1 rounded-sm px-2 text-[17px] font-semibold tracking-[-0.01em] text-sidebar-foreground transition-colors hover:bg-sidebar-accent"
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
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex-1" />
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
        {isRemote && onSelectBrowser && (
          <Button
            variant={isBrowserSelected ? "default" : "ghost"}
            size="icon"
            className="h-8 w-8"
            onClick={onSelectBrowser}
            aria-label={
              isBrowserSelected ? "ブラウザを選択中" : "ブラウザを開く"
            }
            aria-pressed={isBrowserSelected}
            title="ブラウザ"
          >
            <Globe className="size-5" />
          </Button>
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
    </div>
  );
}
