/**
 * MobileSessionList - モバイルのセッション一覧画面
 *
 * PCサイドバーと同じ並べ方・行の中身・行メニュー (SessionSectionList) を、カードの形で出す。
 * RepoGridViewはPCだけなので、「このリポジトリの全セッションを並べて見る」は渡さない。
 */

import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  SessionSectionList,
  type SessionSectionListProps,
} from "./SessionSectionList";

type MobileSessionListProps = Omit<
  SessionSectionListProps,
  "variant" | "selectedSessionId" | "onSelectRepoGrid"
> & {
  onNewSession: () => void;
  notificationControl?: ReactNode;
};

export function MobileSessionList({
  onNewSession,
  notificationControl,
  ...listProps
}: MobileSessionListProps) {
  return (
    <div className="flex-1 flex flex-col min-h-0 safe-area-x">
      <header className="flex h-14 shrink-0 items-center gap-1 pl-5 pr-2">
        <h1 className="flex-1 text-[22px] font-bold tracking-[-0.01em] text-foreground">
          Ark
        </h1>
        {notificationControl}
        <Button
          variant="ghost"
          size="icon"
          className="h-12 w-12"
          onClick={onNewSession}
          aria-label="新規セッション"
          title="新規セッション"
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
