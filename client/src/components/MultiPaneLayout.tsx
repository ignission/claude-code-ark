/**
 * MultiPaneLayout Component - PC向けグリッドレイアウト
 *
 * Design: Terminal-Inspired Dark Mode
 * - Fixed 2-column grid layout
 * - Maximize/minimize individual panes
 * - Uses ttyd iframe for terminal rendering
 * - モバイル表示は MobileLayout が担当
 */

import { useMemo } from "react";
import { getBaseName } from "@/utils/pathUtils";
import { findRepoForSession } from "@/utils/sessionUtils";
import type {
  ManagedSession,
  SpecialKey,
  Worktree,
} from "../../../shared/types";
import { TerminalPane } from "./TerminalPane";

interface MultiPaneLayoutProps {
  activePanes: string[]; // Session IDs
  sessions: Map<string, ManagedSession>;
  worktrees: Worktree[];
  repoList?: string[];
  onSendMessage: (sessionId: string, message: string) => void;
  onSendKey: (sessionId: string, key: SpecialKey) => void;
  onStopSession: (sessionId: string) => void;
  onClosePane: (sessionId: string) => void;
  onMaximizePane: (sessionId: string) => void;
  maximizedPane: string | null;
  onUploadImage?: (
    sessionId: string,
    base64Data: string,
    mimeType: string
  ) => void;
  imageUploadResult?: { path: string; filename: string } | null;
  imageUploadError?: string | null;
  onClearImageUploadState?: () => void;
  onCopyBuffer?: (sessionId: string) => Promise<string | null>;
}

export function MultiPaneLayout({
  activePanes,
  sessions,
  worktrees,
  repoList,
  onSendMessage,
  onSendKey,
  onStopSession,
  onClosePane,
  onMaximizePane,
  maximizedPane,
  onUploadImage,
  imageUploadResult,
  imageUploadError,
  onClearImageUploadState,
  onCopyBuffer,
}: MultiPaneLayoutProps) {
  const getWorktreeForSession = (
    session: ManagedSession
  ): Worktree | undefined => {
    return worktrees.find(w => w.id === session.worktreeId);
  };

  const getRepoNameForSession = (
    session: ManagedSession
  ): string | undefined => {
    if (!repoList) return undefined;
    const repo = findRepoForSession(session, repoList);
    return repo ? getBaseName(repo) : undefined;
  };

  // Filter to only show panes that have active sessions
  const visiblePanes = useMemo(
    () => activePanes.filter(id => sessions.has(id)),
    [activePanes, sessions]
  );

  // If a pane is maximized, only show that pane
  if (maximizedPane) {
    const session = sessions.get(maximizedPane);
    if (session) {
      const worktree = getWorktreeForSession(session);
      return (
        <div className="h-full p-2">
          <TerminalPane
            session={session}
            worktree={worktree}
            repoName={getRepoNameForSession(session)}
            onSendMessage={msg => onSendMessage(maximizedPane, msg)}
            onSendKey={key => onSendKey(maximizedPane, key)}
            onStopSession={() => onStopSession(maximizedPane)}
            onClose={() => onClosePane(maximizedPane)}
            onMaximize={() => onMaximizePane(maximizedPane)}
            isMaximized={true}
            onUploadImage={(base64, mimeType) =>
              onUploadImage?.(maximizedPane, base64, mimeType)
            }
            imageUploadResult={imageUploadResult}
            imageUploadError={imageUploadError}
            onClearImageUploadState={onClearImageUploadState}
            onCopyBuffer={
              onCopyBuffer ? () => onCopyBuffer(maximizedPane) : undefined
            }
          />
        </div>
      );
    }
  }

  if (visiblePanes.length === 0) {
    return null;
  }

  return (
    <div className="h-full flex flex-col">
      {/* グリッド表示 */}
      <div className="flex-1 grid grid-cols-2 gap-2 p-2 overflow-y-auto auto-rows-[minmax(calc(100vh_-_10rem),1fr)]">
        {visiblePanes.map(sessionId => {
          const session = sessions.get(sessionId);
          if (!session) return null;

          const worktree = getWorktreeForSession(session);

          return (
            <TerminalPane
              key={sessionId}
              session={session}
              worktree={worktree}
              repoName={getRepoNameForSession(session)}
              onSendMessage={msg => onSendMessage(sessionId, msg)}
              onSendKey={key => onSendKey(sessionId, key)}
              onStopSession={() => onStopSession(sessionId)}
              onClose={() => onClosePane(sessionId)}
              onMaximize={() => onMaximizePane(sessionId)}
              isMaximized={false}
              onUploadImage={(base64, mimeType) =>
                onUploadImage?.(sessionId, base64, mimeType)
              }
              imageUploadResult={imageUploadResult}
              imageUploadError={imageUploadError}
              onClearImageUploadState={onClearImageUploadState}
              onCopyBuffer={
                onCopyBuffer ? () => onCopyBuffer(sessionId) : undefined
              }
            />
          );
        })}
      </div>
    </div>
  );
}

export default MultiPaneLayout;
