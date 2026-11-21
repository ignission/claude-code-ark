/**
 * HomeSessionRow - 一覧の先頭に固定で出すホームの行と、タスクを開いている間の「ホームへ戻る」
 *
 * ホームの決まりは `lib/home-session.ts` にある。ここは描くだけで、状態は持たない。
 */

import { ArrowLeft, Home, MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { m } from "@/lib/i18n";
import type { StatusKey } from "@/lib/status-tone";
import { cn } from "@/lib/utils";
import { StatusChip } from "./StatusChip";

interface HomeSessionRowProps {
  /** "sidebar" = PCの一覧、"card" = モバイルの一覧 */
  variant: "sidebar" | "card";
  /** ホームのディレクトリ名など、どこがホームかを言う短い補足 */
  subLabel: string;
  /** ホームのセッションの状態。未起動なら NOT_STARTED */
  statusKey: StatusKey;
  running: boolean;
  selected: boolean;
  /** ホームを開く。未起動なら起動する */
  onOpen: () => void;
  onUnset: () => void;
}

export function HomeSessionRow({
  variant,
  subLabel,
  statusKey,
  running,
  selected,
  onOpen,
  onUnset,
}: HomeSessionRowProps) {
  const card = variant === "card";
  return (
    <div
      data-home-row=""
      className={cn(
        "flex items-center rounded-md",
        card ? "mb-3 border border-border bg-card" : "mb-2",
        selected && "bg-sidebar-accent"
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 rounded-md text-left transition-colors hover:bg-sidebar-accent",
          card ? "min-h-14 px-3" : "h-10 px-2.5"
        )}
      >
        <Home
          className={cn("shrink-0", card ? "size-5" : "size-4")}
          aria-hidden="true"
        />
        <span
          className={cn(
            "shrink-0 font-semibold text-foreground",
            card ? "text-[15px]" : "text-[13px]"
          )}
        >
          {m.session.home.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {running ? subLabel : m.session.home.notRunning}
        </span>
        <StatusChip statusKey={statusKey} bare labelClassName="sr-only" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={m.session.home.menu}
            className={cn(
              "inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground",
              card ? "h-12 w-12" : "h-8 w-8"
            )}
          >
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem
            className={card ? "min-h-11" : undefined}
            onSelect={onUnset}
          >
            {m.session.home.unset}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** PCで、ホーム以外のセッションを開いている間に会話の上へ出す帯 */
export function HomeBackBar({
  label,
  onBack,
}: {
  /** いま開いているセッションの名前 */
  label: string;
  onBack: () => void;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-sidebar px-2">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-foreground transition-colors hover:bg-sidebar-accent"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        <Home className="size-4" aria-hidden="true" />
        {m.session.home.back}
      </button>
      <span className="min-w-0 truncate text-[13px] text-muted-foreground">
        {label}
      </span>
    </div>
  );
}
