/**
 * RepoAccountMenu - リポジトリ右クリックメニュー内に表示する
 * 「アカウントを変更」サブメニューのコンテンツ
 *
 * - 登録アカウント一覧 (pendingはdisabled)
 * - 既定 (~/.claude) で紐付け解除
 * - アカウント管理ダイアログを開く
 *
 * NOTE: ContextMenuSubContentにラップする内側のItem群のみを描画する。
 *       SubTriggerは呼び出し側 (SessionSidebar) が担う。
 */

import { Check, Settings } from "lucide-react";
import {
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AccountProfile } from "../../../shared/types";

/** プロファイルバッジのカラーパレット (5色) */
export const PROFILE_COLORS = [
  "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  "bg-purple-500/10 text-purple-300 border-purple-500/30",
  "bg-blue-500/10 text-blue-300 border-blue-500/30",
  "bg-pink-500/10 text-pink-300 border-pink-500/30",
  "bg-amber-500/10 text-amber-400 border-amber-500/30",
];

/** プロファイルIDから決定論的に色を選択 */
export function colorFor(id: string): string {
  if (!id || id.length === 0) return PROFILE_COLORS[0];
  return PROFILE_COLORS[id.charCodeAt(0) % PROFILE_COLORS.length];
}

/**
 * バッジ表示用ラベル。短い名前はそのまま、長い場合は12文字+ellipsisで切り詰める。
 * コードポイント単位で扱う（絵文字や日本語が4文字で切れないように）。
 */
const BADGE_MAX_CHARS = 12;
export function badgeLabel(name: string): string {
  const chars = Array.from(name);
  if (chars.length <= BADGE_MAX_CHARS) return name;
  return `${chars.slice(0, BADGE_MAX_CHARS).join("")}…`;
}

interface RepoAccountMenuProps {
  accounts: AccountProfile[];
  currentAccountId: string | null;
  onSelect: (accountProfileId: string | null) => void;
  onOpenManager: () => void;
}

export function RepoAccountMenu({
  accounts,
  currentAccountId,
  onSelect,
  onOpenManager,
}: RepoAccountMenuProps) {
  return (
    <>
      <ContextMenuLabel className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
        アカウント
      </ContextMenuLabel>
      {accounts.map(account => {
        const isPending = account.status === "pending";
        const isCurrent = account.id === currentAccountId;
        const colorClass = colorFor(account.id);
        const label = badgeLabel(account.name);

        const item = (
          <ContextMenuItem
            key={account.id}
            disabled={isPending}
            onSelect={() => {
              if (!isPending) onSelect(account.id);
            }}
            className="flex items-center justify-between gap-2"
          >
            <span className="flex items-center gap-2 min-w-0">
              {isCurrent ? (
                <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              ) : (
                <span className="w-3.5 h-3.5 shrink-0" aria-hidden />
              )}
              <span className="truncate">{account.name}</span>
            </span>
            <span
              className={`shrink-0 inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded border ${colorClass}`}
            >
              {label}
            </span>
          </ContextMenuItem>
        );

        if (isPending) {
          return (
            <Tooltip key={account.id}>
              <TooltipTrigger asChild>
                {/* disabledのMenuItemはeventsを受けないため、wrap divでhover検知 */}
                <div>{item}</div>
              </TooltipTrigger>
              <TooltipContent side="right">
                ログイン未完了 — 先にログインしてください
              </TooltipContent>
            </Tooltip>
          );
        }
        return item;
      })}
      <ContextMenuSeparator />
      <ContextMenuItem
        onSelect={() => onSelect(null)}
        className="flex items-center gap-2"
      >
        {currentAccountId === null ? (
          <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
        ) : (
          <span className="w-3.5 h-3.5 shrink-0" aria-hidden />
        )}
        <span className="truncate text-muted-foreground">既定 (~/.claude)</span>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        onSelect={() => onOpenManager()}
        className="flex items-center gap-2"
      >
        <Settings className="w-3.5 h-3.5" />
        <span>アカウント管理を開く...</span>
      </ContextMenuItem>
    </>
  );
}
