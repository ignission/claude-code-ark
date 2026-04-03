/**
 * SessionSidebar - 全セッションをフラット表示するサイドバー
 *
 * セッション一覧（SessionCard） + 新規作成「+」ボタンを提供。
 * リポジトリ横断で全セッションを表示する。
 */

import { Plus, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ManagedSession, Worktree } from "../../../shared/types";
import { SessionCard } from "./SessionCard";

interface SessionSidebarProps {
  sessions: Map<string, ManagedSession>;
  worktrees: Worktree[];
  repoList: string[];
  selectedSessionId: string | null;
  sessionPreviews: Map<string, string>;
  onSelectSession: (sessionId: string) => void;
  onStopSession: (sessionId: string) => void;
  onNewSession: () => void;
}

export function SessionSidebar({
  sessions,
  worktrees,
  repoList,
  selectedSessionId,
  sessionPreviews,
  onSelectSession,
  onStopSession,
  onNewSession,
}: SessionSidebarProps) {
  const sessionList = Array.from(sessions.values());

  const getWorktree = (session: ManagedSession): Worktree | undefined => {
    return worktrees.find((w) => w.id === session.worktreeId);
  };

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
        <div className="p-2 space-y-1">
          {sessionList.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">
              <Terminal className="w-8 h-8 mx-auto mb-3 opacity-50" />
              <p>セッションがありません</p>
              <p className="text-xs mt-1">「+」から新規作成</p>
            </div>
          ) : (
            sessionList.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                worktree={getWorktree(session)}
                repoList={repoList}
                isSelected={selectedSessionId === session.id}
                previewText={sessionPreviews.get(session.id) || ""}
                onClick={() => onSelectSession(session.id)}
                onStop={() => onStopSession(session.id)}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
