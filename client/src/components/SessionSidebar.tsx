/**
 * SessionSidebar - リポジトリ別にグルーピングしたセッション一覧サイドバー
 *
 * セッション一覧（SessionCard） + 新規作成「+」ボタンを提供。
 * リポジトリごとにヘッダーで区切って表示する。
 * worktree中心のイテレーション: セッション未起動のworktreeも表示する。
 */

import { FolderOpen, Plus, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useGroupedWorktreeItems } from "@/hooks/useGroupedWorktreeItems";
import type { ManagedSession, Worktree } from "../../../shared/types";
import { SessionCard } from "./SessionCard";

interface SessionSidebarProps {
  sessions: Map<string, ManagedSession>;
  worktrees: Worktree[];
  repoList: string[];
  selectedSessionId: string | null;
  sessionPreviews: Map<string, string>;
  sessionActivityTexts: Map<string, string>;
  onSelectSession: (sessionId: string) => void;
  onStopSession: (sessionId: string) => void;
  onStartSession: (worktree: Worktree) => void;
  onNewSession: () => void;
}

export function SessionSidebar({
  sessions,
  worktrees,
  repoList,
  selectedSessionId,
  sessionPreviews,
  sessionActivityTexts,
  onSelectSession,
  onStopSession,
  onStartSession,
  onNewSession,
}: SessionSidebarProps) {
  const { groupedItems } = useGroupedWorktreeItems(
    worktrees,
    sessions,
    repoList
  );

  return (
    <div className="h-full flex flex-col bg-sidebar">
      {/* ヘッダー */}
      <div className="h-12 border-b border-sidebar-border flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-primary" />
          <h1 className="font-semibold text-sm text-sidebar-foreground">Ark</h1>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onNewSession}
          title="新規セッション"
        >
          <Plus className="w-4 h-4" />
        </Button>
      </div>

      {/* セッション一覧 */}
      <ScrollArea className="flex-1">
        <div className="p-2">
          {sessions.size === 0 && worktrees.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">
              <Terminal className="w-8 h-8 mx-auto mb-3 opacity-50" />
              <p>セッションがありません</p>
              <p className="text-xs mt-1">「+」から新規作成</p>
            </div>
          ) : (
            Array.from(groupedItems.entries()).map(([repoName, items]) => (
              <div key={repoName} className="mb-3">
                {/* リポジトリヘッダー */}
                <div className="flex items-center gap-1.5 px-2 py-1.5">
                  <FolderOpen className="w-3 h-3 text-muted-foreground" />
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider truncate">
                    {repoName}
                  </span>
                </div>
                {/* アイテム一覧 */}
                <div className="space-y-1">
                  {items.map(({ worktree: wt, session }) => (
                    <SessionCard
                      key={session?.id ?? wt?.id ?? "unknown"}
                      session={session}
                      worktree={wt ?? undefined}
                      repoList={repoList}
                      isSelected={
                        session ? selectedSessionId === session.id : false
                      }
                      previewText={
                        session ? sessionPreviews.get(session.id) || "" : ""
                      }
                      activityText={
                        session
                          ? sessionActivityTexts.get(session.id) || ""
                          : ""
                      }
                      onClick={() => session && onSelectSession(session.id)}
                      onStop={() => session && onStopSession(session.id)}
                      onStart={() => (wt ? onStartSession(wt) : undefined)}
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
