/**
 * MobileLayout - モバイル専用ルートコンポーネント
 *
 * 「セッション一覧」と「セッション詳細」を画面遷移で切り替える。
 * iframe再マウント防止のため、display:none/blockで表示を切り替える。
 */

import { useState, useCallback, useEffect } from "react";
import { MobileSessionList } from "@/components/MobileSessionList";
import { MobileSessionView } from "@/components/MobileSessionView";
import type { ManagedSession, SpecialKey, Worktree } from "../../../shared/types";

interface MobileLayoutProps {
  sessions: Map<string, ManagedSession>;
  worktrees: Worktree[];
  repoName: string | null;
  onStartSession: (worktree: Worktree) => void;
  onStopSession: (sessionId: string) => void;
  onDeleteWorktree: (worktree: Worktree) => void;
  onSendMessage: (sessionId: string, message: string) => void;
  onSendKey: (sessionId: string, key: SpecialKey) => void;
  onSelectSession: (sessionId: string) => void;
  onUploadImage?: (sessionId: string, base64Data: string, mimeType: string) => void;
  imageUploadResult?: { path: string; filename: string } | null;
  imageUploadError?: string | null;
  onClearImageUploadState?: () => void;
  onCopyBuffer?: (sessionId: string) => Promise<string | null>;
}

export function MobileLayout({
  sessions,
  worktrees,
  repoName,
  onStartSession,
  onStopSession,
  onDeleteWorktree,
  onSendMessage,
  onSendKey,
  onSelectSession,
  onUploadImage,
  imageUploadResult,
  imageUploadError,
  onClearImageUploadState,
  onCopyBuffer,
}: MobileLayoutProps) {
  const [activeView, setActiveView] = useState<"list" | "detail">("list");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  // セッションを選択して詳細画面に遷移
  const handleOpenSession = useCallback(
    (sessionId: string) => {
      setSelectedSessionId(sessionId);
      setActiveView("detail");
      onSelectSession(sessionId);
    },
    [onSelectSession]
  );

  // 一覧画面に戻る
  const handleBack = useCallback(() => {
    setActiveView("list");
  }, []);

  // 選択中のセッションが削除された場合、一覧画面にフォールバック
  useEffect(() => {
    if (activeView === "detail" && selectedSessionId && !sessions.has(selectedSessionId)) {
      setActiveView("list");
    }
  }, [activeView, selectedSessionId, sessions]);

  // ワークツリーのIDからWorktreeを取得するヘルパー
  const getWorktreeForSession = (session: ManagedSession): Worktree | undefined => {
    return worktrees.find((w) => w.id === session.worktreeId);
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* 一覧画面 */}
      <div
        className={
          activeView === "list" ? "flex-1 flex flex-col min-h-0" : "hidden"
        }
      >
        <MobileSessionList
          sessions={sessions}
          worktrees={worktrees}
          repoName={repoName}
          onOpenSession={handleOpenSession}
          onStartSession={onStartSession}
          onStopSession={onStopSession}
          onDeleteWorktree={onDeleteWorktree}
        />
      </div>

      {/* 詳細画面 - 各セッションのビューを保持（iframe再マウント防止） */}
      {Array.from(sessions.entries()).map(([sessionId, session]) => (
        <div
          key={sessionId}
          className={
            activeView === "detail" && selectedSessionId === sessionId
              ? "flex-1 flex flex-col min-h-0"
              : "hidden"
          }
        >
          <MobileSessionView
            session={session}
            worktree={getWorktreeForSession(session)}
            onBack={handleBack}
            onSendMessage={(message) => onSendMessage(sessionId, message)}
            onSendKey={(key) => onSendKey(sessionId, key)}
            onStopSession={() => onStopSession(sessionId)}
            onUploadImage={
              onUploadImage
                ? (base64Data, mimeType) =>
                    onUploadImage(sessionId, base64Data, mimeType)
                : undefined
            }
            imageUploadResult={imageUploadResult}
            imageUploadError={imageUploadError}
            onClearImageUploadState={onClearImageUploadState}
            onCopyBuffer={
              onCopyBuffer ? () => onCopyBuffer(sessionId) : undefined
            }
          />
        </div>
      ))}
    </div>
  );
}
