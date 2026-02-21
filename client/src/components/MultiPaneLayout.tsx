/**
 * MultiPaneLayout Component - PC向けグリッドレイアウト
 *
 * Design: Terminal-Inspired Dark Mode
 * - Flexible grid layout (1x1, 2x2)
 * - Maximize/minimize individual panes
 * - Uses ttyd iframe for terminal rendering
 * - モバイル表示は MobileLayout が担当
 */

import { useState, useMemo, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Square,
  Grid2x2,
} from "lucide-react";
import { TerminalPane } from "./TerminalPane";
import { findRepoForSession } from "@/utils/sessionUtils";
import { getBaseName } from "@/utils/pathUtils";
import type { ManagedSession, SpecialKey, Worktree } from "../../../shared/types";

type LayoutMode = "single" | "grid-4";

const LAYOUT_MODE_STORAGE_KEY = "layoutMode";

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
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(() => {
    try {
      if (typeof window === "undefined") return "grid-4";
      const saved = localStorage.getItem(LAYOUT_MODE_STORAGE_KEY);
      if (saved === "single" || saved === "grid-4") {
        return saved;
      }
    } catch {}
    return "grid-4";
  });

  useEffect(() => {
    try {
      if (typeof window === "undefined") return;
      localStorage.setItem(LAYOUT_MODE_STORAGE_KEY, layoutMode);
    } catch {}
  }, [layoutMode]);

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
  const visiblePanes = useMemo(
    () => activePanes.filter((id) => sessions.has(id)),
    [activePanes, sessions]
  );

  if (visiblePanes.length === 0) {
    return null;
  }

  // Determine grid layout based on mode and number of panes
  const getGridClass = () => {
    const paneCount = visiblePanes.length;

    if (layoutMode === "single" || paneCount === 1) {
      return "grid-cols-1";
    }

    // grid-4は最大2列
    return "grid-cols-2";
  };

  return (
    <div className="h-full flex flex-col">
      {/* Layout Controls */}
      <div className="h-10 border-b border-border flex items-center justify-between px-4 shrink-0 bg-sidebar">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {visiblePanes.length} active pane{visiblePanes.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="flex items-center gap-1">
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

      {/* グリッド表示 */}
      <div className={`flex-1 grid ${getGridClass()} gap-2 p-2 overflow-y-auto auto-rows-[minmax(calc(100vh_-_10rem),1fr)]`}>
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

    </div>
  );
}

export default MultiPaneLayout;
