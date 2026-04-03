/**
 * SessionSidebar - リポジトリ別にグルーピングしたセッション一覧サイドバー
 *
 * セッション一覧（SessionCard） + 新規作成「+」ボタンを提供。
 * リポジトリごとにヘッダーで区切って表示する。
 */

import { FolderOpen, Plus, Terminal } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { getBaseName } from "@/utils/pathUtils";
import { findRepoForSession } from "@/utils/sessionUtils";
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
  onNewSession,
}: SessionSidebarProps) {
  const getWorktree = (session: ManagedSession): Worktree | undefined => {
    return worktrees.find(w => w.id === session.worktreeId);
  };

  // リポジトリ別にセッションをグルーピング
  const groupedSessions = useMemo(() => {
    const groups = new Map<string, ManagedSession[]>();
    for (const session of sessions.values()) {
      const repo = findRepoForSession(session, repoList);
      const repoName = repo ? getBaseName(repo) : "unknown";
      const existing = groups.get(repoName) || [];
      existing.push(session);
      groups.set(repoName, existing);
    }
    return groups;
  }, [sessions, repoList]);

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
          {sessions.size === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">
              <Terminal className="w-8 h-8 mx-auto mb-3 opacity-50" />
              <p>セッションがありません</p>
              <p className="text-xs mt-1">「+」から新規作成</p>
            </div>
          ) : (
            Array.from(groupedSessions.entries()).map(
              ([repoName, repoSessions]) => (
                <div key={repoName} className="mb-3">
                  {/* リポジトリヘッダー */}
                  <div className="flex items-center gap-1.5 px-2 py-1.5">
                    <FolderOpen className="w-3 h-3 text-muted-foreground" />
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider truncate">
                      {repoName}
                    </span>
                  </div>
                  {/* そのリポジトリのセッション */}
                  <div className="space-y-1">
                    {repoSessions.map(session => (
                      <SessionCard
                        key={session.id}
                        session={session}
                        worktree={getWorktree(session)}
                        repoList={repoList}
                        isSelected={selectedSessionId === session.id}
                        previewText={sessionPreviews.get(session.id) || ""}
                        activityText={
                          sessionActivityTexts.get(session.id) || ""
                        }
                        onClick={() => onSelectSession(session.id)}
                        onStop={() => onStopSession(session.id)}
                      />
                    ))}
                  </div>
                </div>
              )
            )
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
