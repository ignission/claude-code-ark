/**
 * SessionTabBar - PCの画面の上に並べる、開いたセッションのタブ
 *
 * 並びの決まりは `lib/session-tabs.ts` にある。ここは描くだけで、状態は持たない。
 */

import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { m } from "@/lib/i18n";
import { sessionPanelId, sessionTabId } from "@/lib/session-tabs";
import type { StatusKey } from "@/lib/status-tone";
import { cn } from "@/lib/utils";
import { StatusChip } from "./StatusChip";

export interface SessionTabItem {
  sessionId: string;
  label: string;
  /** リポジトリ名。同じラベルのタブが並んだときだけ、見分けるために添える */
  repoName?: string;
  /** ラベルだけでは見分けにくいときの補足 (worktreeのパス)。ツールチップに出す */
  title?: string;
  statusKey: StatusKey;
}

interface SessionTabBarProps {
  tabs: SessionTabItem[];
  /** 選んでいるセッション。画面やグリッドを見ているときは null */
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
}

export function SessionTabBar({
  tabs,
  activeSessionId,
  onSelect,
  onClose,
}: SessionTabBarProps) {
  const activeRef = useRef<HTMLDivElement | null>(null);

  // 一覧や通知から選ばれたタブが、横スクロールの外にあっても見えるようにする
  // biome-ignore lint/correctness/useExhaustiveDependencies: 選択が替わるたびに位置を合わせる
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
    });
  }, [activeSessionId]);

  if (tabs.length === 0) return null;
  // 最後の1つは閉じさせない。閉じると選ぶものが無くなり、自動選択が同じセッションを開き直す
  const closable = tabs.length > 1;
  // 別のリポジトリの同じブランチ名 (mainなど) が並ぶと見分けられないので、重なったラベルにだけ
  // リポジトリ名を添える
  const labelCounts = new Map<string, number>();
  for (const tab of tabs) {
    labelCounts.set(tab.label, (labelCounts.get(tab.label) ?? 0) + 1);
  }

  return (
    <div
      role="tablist"
      aria-label={m.session.tabs.list}
      className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-border bg-sidebar"
    >
      {tabs.map(tab => {
        const isActive = tab.sessionId === activeSessionId;
        return (
          <div
            key={tab.sessionId}
            ref={isActive ? activeRef : undefined}
            data-session-id={tab.sessionId}
            className={cn(
              "group flex min-w-0 max-w-56 shrink-0 items-center border-r border-border",
              isActive
                ? "bg-background text-foreground shadow-[inset_0_2px_0_0_var(--color-foreground)]"
                : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
            )}
            // 中クリックで閉じる (ブラウザやエディタのタブと同じ)
            onAuxClick={e => {
              if (e.button === 1 && closable) {
                e.preventDefault();
                onClose(tab.sessionId);
              }
            }}
          >
            <button
              type="button"
              role="tab"
              id={sessionTabId(tab.sessionId)}
              aria-controls={sessionPanelId(tab.sessionId)}
              aria-selected={isActive}
              title={tab.title}
              onClick={() => onSelect(tab.sessionId)}
              className={cn(
                "flex h-full min-w-0 items-center gap-1.5 pl-3 text-[13px]",
                closable ? "pr-1" : "pr-3"
              )}
            >
              <StatusChip
                statusKey={tab.statusKey}
                bare
                className="px-0"
                labelClassName="sr-only"
              />
              <span className="truncate">{tab.label}</span>
              {tab.repoName && (labelCounts.get(tab.label) ?? 0) > 1 && (
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {tab.repoName}
                </span>
              )}
            </button>
            {closable && (
              <button
                type="button"
                aria-label={m.session.tabs.close(tab.label)}
                onClick={() => onClose(tab.sessionId)}
                className={cn(
                  "mr-1.5 inline-flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-foreground/10 focus-visible:opacity-100",
                  isActive ? "opacity-70" : "opacity-0 group-hover:opacity-70"
                )}
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
