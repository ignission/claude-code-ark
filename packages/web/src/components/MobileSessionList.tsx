/**
 * MobileSessionList - モバイルのセッション一覧画面
 *
 * PCサイドバーと同じ並べ方・行の中身・行メニュー (SessionSectionList) を、カードの形で出す。
 * RepoGridViewはPCだけなので、「このリポジトリの全セッションを並べて見る」は渡さない。
 *
 * 見出しの「Ark」はPCのサイドバーと同じくメニューを開き、言語の切替を置く
 * (モバイルにはサイドバーが無いので、切替の入口はここだけ)。
 */

import { LOCALES } from "@ark/shared/i18n";
import { Check, ChevronDown, ListPlus, Monitor, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { changeLocale, LOCALE_NAMES, locale, m } from "@/lib/i18n";
import {
  SessionSectionList,
  type SessionSectionListProps,
} from "./SessionSectionList";

type MobileSessionListProps = Omit<
  SessionSectionListProps,
  "variant" | "selectedSessionId" | "onSelectRepoGrid"
> & {
  onNewSession: () => void;
  /** 新しいタスクのダイアログを開く (名前とプロンプトだけで worktree とセッションを起こす) */
  onNewTask: () => void;
  /** 画面の管理ダイアログを開く。画面が未登録でも一覧の見出しから登録できるようにする */
  onOpenScreenManager?: () => void;
  notificationControl?: ReactNode;
};

export function MobileSessionList({
  onNewSession,
  onNewTask,
  onOpenScreenManager,
  notificationControl,
  ...listProps
}: MobileSessionListProps) {
  return (
    <div className="flex-1 flex flex-col min-h-0 safe-area-x">
      <header className="flex h-14 shrink-0 items-center gap-1 pl-5 pr-2">
        <h1 className="flex-1 text-[22px] font-bold tracking-[-0.01em] text-foreground">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={m.mobile.list.arkMenu}
                className="-ml-2 inline-flex h-12 items-center gap-1 rounded-md px-2"
              >
                Ark
                <ChevronDown
                  className="size-5 text-muted-foreground"
                  aria-hidden="true"
                />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuLabel>{m.common.language}</DropdownMenuLabel>
              {LOCALES.map(code => (
                <DropdownMenuItem
                  key={code}
                  lang={code}
                  className="min-h-11"
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
        </h1>
        {notificationControl}
        {onOpenScreenManager && (
          <Button
            variant="ghost"
            size="icon"
            className="h-12 w-12"
            onClick={onOpenScreenManager}
            aria-label={m.mobile.list.manageScreens}
            title={m.mobile.list.manageScreens}
          >
            <Monitor className="size-6" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-12 w-12"
          onClick={onNewTask}
          aria-label={m.mobile.list.newTask}
          title={m.mobile.list.newTask}
        >
          <ListPlus className="size-6" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-12 w-12"
          onClick={onNewSession}
          aria-label={m.mobile.list.newSession}
          title={m.mobile.list.newSession}
        >
          <Plus className="size-6" />
        </Button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 pt-1 pb-4">
        <SessionSectionList
          variant="card"
          selectedSessionId={null}
          {...listProps}
        />
      </div>
    </div>
  );
}
