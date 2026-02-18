/**
 * MultiPaneLayout Component - Grid layout for multiple terminal panes
 *
 * Design: Terminal-Inspired Dark Mode
 * - Flexible grid layout (1x1, 2x1, 2x2, etc.)
 * - Maximize/minimize individual panes
 * - Mobile-first: single pane on small screens
 * - Uses ttyd iframe for terminal rendering
 */

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Columns2,
  Square,
  Grid2x2,
} from "lucide-react";
import { TerminalPane } from "./TerminalPane";
import { useIsMobile } from "@/hooks/useMobile";
import { findRepoForSession } from "@/utils/sessionUtils";
import { getBaseName } from "@/utils/pathUtils";
import type { ManagedSession, SpecialKey, Worktree } from "../../../shared/types";

type LayoutMode = "single" | "split-2" | "grid-4";

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
  onUploadImage?: (sessionId: string, base64Data: string, mimeType: string) => void;
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
  const isMobile = useIsMobile();
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("grid-4");
  const [activeMobilePane, setActiveMobilePane] = useState<string | null>(null);

  // Force single pane on mobile
  const effectiveLayoutMode = isMobile ? "single" : layoutMode;

  const getWorktreeForSession = (session: ManagedSession): Worktree | undefined => {
    return worktrees.find((w) => w.id === session.worktreeId);
  };

  const getRepoNameForSession = (session: ManagedSession): string | undefined => {
    if (!repoList) return undefined;
    const repo = findRepoForSession(session, repoList);
    return repo ? getBaseName(repo) : undefined;
  };

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
            onSendMessage={(msg) => onSendMessage(maximizedPane, msg)}
            onSendKey={(key) => onSendKey(maximizedPane, key)}
            onStopSession={() => onStopSession(maximizedPane)}
            onClose={() => onClosePane(maximizedPane)}
            onMaximize={() => onMaximizePane(maximizedPane)}
            isMaximized={true}
            onUploadImage={(base64, mimeType) => onUploadImage?.(maximizedPane, base64, mimeType)}
            imageUploadResult={imageUploadResult}
            imageUploadError={imageUploadError}
            onClearImageUploadState={onClearImageUploadState}
            onCopyBuffer={onCopyBuffer ? () => onCopyBuffer(maximizedPane) : undefined}
          />
        </div>
      );
    }
  }

  // Filter to only show panes that have active sessions
  const visiblePanes = activePanes.filter((id) => sessions.has(id));

  // モバイル時: visiblePanesが変わったらactiveMobilePaneを自動更新
  useEffect(() => {
    if (isMobile && visiblePanes.length > 0) {
      if (!activeMobilePane || !visiblePanes.includes(activeMobilePane)) {
        setActiveMobilePane(visiblePanes[0]);
      }
    }
  }, [isMobile, visiblePanes, activeMobilePane]);

  if (visiblePanes.length === 0) {
    return null;
  }

  // Determine grid layout based on mode and number of panes
  const getGridClass = () => {
    const paneCount = visiblePanes.length;

    if (effectiveLayoutMode === "single" || paneCount === 1) {
      return "grid-cols-1";
    }

    // split-2、grid-4ともに最大2列
    return "grid-cols-1 md:grid-cols-2";
  };

  return (
    <div className="h-full flex flex-col">
      {/* Layout Controls */}
      <div className="h-12 md:h-10 border-b border-border flex items-center justify-between px-4 shrink-0 bg-sidebar">
        <div className="flex items-center gap-2">
          <span className="text-base md:text-sm text-muted-foreground">
            {visiblePanes.length} active pane{visiblePanes.length !== 1 ? "s" : ""}
          </span>
        </div>
        {/* Hide layout selector on mobile - always single pane */}
        <div className="hidden md:flex items-center gap-1">
          <Button
            variant={layoutMode === "single" ? "secondary" : "ghost"}
            size="icon"
            className="h-7 w-7"
            onClick={() => setLayoutMode("single")}
            title="Single pane"
          >
            <Square className="w-4 h-4" />
          </Button>
          <Button
            variant={layoutMode === "split-2" ? "secondary" : "ghost"}
            size="icon"
            className="h-7 w-7"
            onClick={() => setLayoutMode("split-2")}
            title="Split view"
          >
            <Columns2 className="w-4 h-4" />
          </Button>
          <Button
            variant={layoutMode === "grid-4" ? "secondary" : "ghost"}
            size="icon"
            className="h-7 w-7"
            onClick={() => setLayoutMode("grid-4")}
            title="Grid view"
          >
            <Grid2x2 className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Mobile: タブ切り替え式 */}
      {isMobile ? (
        <>
          {/* タブバー */}
          <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border bg-sidebar overflow-x-auto shrink-0">
            {visiblePanes.map((sessionId) => {
              const session = sessions.get(sessionId);
              if (!session) return null;
              const wt = getWorktreeForSession(session);
              const repoName = getRepoNameForSession(session);
              const isActive = (activeMobilePane || visiblePanes[0]) === sessionId;
              return (
                <button
                  key={sessionId}
                  type="button"
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                    isActive
                      ? "bg-primary/20 text-primary border border-primary/30"
                      : "text-muted-foreground hover:bg-sidebar-accent"
                  }`}
                  onClick={() => setActiveMobilePane(sessionId)}
                >
                  <div className={`w-1.5 h-1.5 rounded-full ${session.status === 'active' ? 'bg-green-500' : 'bg-muted-foreground'}`} />
                  {repoName && <span className="text-[10px] opacity-70">{repoName}</span>}
                  <span>{wt?.branch || getBaseName(session.worktreePath)}</span>
                </button>
              );
            })}
          </div>
          {/* 選択中のペイン */}
          <div className="flex-1 min-h-0 p-2">
            {(() => {
              const selectedId = activeMobilePane && visiblePanes.includes(activeMobilePane) ? activeMobilePane : visiblePanes[0];
              const session = selectedId ? sessions.get(selectedId) : undefined;
              if (!session || !selectedId) return null;
              const worktree = getWorktreeForSession(session);
              return (
                <TerminalPane
                  key={selectedId}
                  session={session}
                  worktree={worktree}
                  repoName={getRepoNameForSession(session)}
                  onSendMessage={(msg) => onSendMessage(selectedId, msg)}
                  onSendKey={(key) => onSendKey(selectedId, key)}
                  onStopSession={() => onStopSession(selectedId)}
                  onClose={() => onClosePane(selectedId)}
                  isMaximized={false}
                  onUploadImage={(base64, mimeType) => onUploadImage?.(selectedId, base64, mimeType)}
                  imageUploadResult={imageUploadResult}
                  imageUploadError={imageUploadError}
                  onClearImageUploadState={onClearImageUploadState}
                  onCopyBuffer={onCopyBuffer ? () => onCopyBuffer(selectedId) : undefined}
                />
              );
            })()}
          </div>
        </>
      ) : (
        /* Desktop: グリッド表示 */
        <div className={`flex-1 grid ${getGridClass()} gap-3 md:gap-2 p-3 md:p-2 overflow-y-auto auto-rows-[minmax(calc(100vh-10rem),1fr)]`}>
          {visiblePanes.map((sessionId) => {
            const session = sessions.get(sessionId);
            if (!session) return null;

            const worktree = getWorktreeForSession(session);

            return (
              <TerminalPane
                key={sessionId}
                session={session}
                worktree={worktree}
                repoName={getRepoNameForSession(session)}
                onSendMessage={(msg) => onSendMessage(sessionId, msg)}
                onSendKey={(key) => onSendKey(sessionId, key)}
                onStopSession={() => onStopSession(sessionId)}
                onClose={() => onClosePane(sessionId)}
                onMaximize={() => onMaximizePane(sessionId)}
                isMaximized={false}
                onUploadImage={(base64, mimeType) => onUploadImage?.(sessionId, base64, mimeType)}
                imageUploadResult={imageUploadResult}
                imageUploadError={imageUploadError}
                onClearImageUploadState={onClearImageUploadState}
                onCopyBuffer={onCopyBuffer ? () => onCopyBuffer(sessionId) : undefined}
              />
            );
          })}
        </div>
      )}

    </div>
  );
}

export default MultiPaneLayout;
