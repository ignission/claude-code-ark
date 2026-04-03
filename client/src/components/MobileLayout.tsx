/**
 * MobileLayout - モバイル専用ルートコンポーネント
 *
 * 「セッション一覧」「セッション詳細」「Beaconチャット」を
 * ボトムナビゲーションと画面遷移で切り替える。
 * iframe再マウント防止のため、display:none/blockで表示を切り替える。
 */

import { useCallback, useEffect, useState } from "react";
import { MobileChatView } from "@/components/MobileChatView";
import { MobileSessionList } from "@/components/MobileSessionList";
import { MobileSessionView } from "@/components/MobileSessionView";
import type {
  ChatMessage,
  ManagedSession,
  SpecialKey,
  Worktree,
} from "../../../shared/types";

interface MobileLayoutProps {
  sessions: Map<string, ManagedSession>;
  worktrees: Worktree[];
  repoName: string | null;
  repoPath: string | null;
  onStartSession: (worktree: Worktree) => void;
  onStopSession: (sessionId: string) => void;
  onDeleteWorktree: (worktree: Worktree) => void;
  onSendMessage: (sessionId: string, message: string) => void;
  onSendKey: (sessionId: string, key: SpecialKey) => void;
  onSelectSession: (sessionId: string) => void;
  onUploadImage?: (
    sessionId: string,
    base64Data: string,
    mimeType: string
  ) => void;
  imageUploadResult?: { path: string; filename: string } | null;
  imageUploadError?: string | null;
  onClearImageUploadState?: () => void;
  onCopyBuffer?: (sessionId: string) => Promise<string | null>;
  // Beaconチャット
  beaconMessages: ChatMessage[];
  beaconStreaming: boolean;
  beaconStreamText: string;
  onBeaconSend: (message: string) => void;
  onBeaconClear?: () => void;
}

export function MobileLayout({
  sessions,
  worktrees,
  repoName,
  repoPath: _repoPath,
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
  beaconMessages,
  beaconStreaming,
  beaconStreamText,
  onBeaconSend,
  onBeaconClear,
}: MobileLayoutProps) {
  const [activeView, setActiveView] = useState<"list" | "detail" | "beacon">(
    "list"
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );
  const [openedSessions, setOpenedSessions] = useState<Set<string>>(new Set());

  // セッションを選択して詳細画面に遷移
  const handleOpenSession = useCallback(
    (sessionId: string) => {
      setSelectedSessionId(sessionId);
      setActiveView("detail");
      setOpenedSessions(prev => new Set(prev).add(sessionId));
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
    if (
      activeView === "detail" &&
      selectedSessionId &&
      !sessions.has(selectedSessionId)
    ) {
      setActiveView("list");
    }
  }, [activeView, selectedSessionId, sessions]);

  // ワークツリーのIDからWorktreeを取得するヘルパー
  const getWorktreeForSession = (
    session: ManagedSession
  ): Worktree | undefined => {
    return worktrees.find(w => w.id === session.worktreeId);
  };

  // ボトムナビゲーションの表示判定（セッション詳細画面以外で表示）
  const showBottomNav = activeView !== "detail";

  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden">
      {/* 一覧画面 */}
      <div
        className={
          activeView === "list"
            ? "flex-1 flex flex-col min-h-0 pb-14"
            : "hidden"
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

      {/* 詳細画面 - 一度でも開いたセッションのみ描画（iframe再マウント防止） */}
      {Array.from(sessions.entries())
        .filter(([sessionId]) => openedSessions.has(sessionId))
        .map(([sessionId, session]) => (
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
              onSendMessage={message => onSendMessage(sessionId, message)}
              onSendKey={key => onSendKey(sessionId, key)}
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

      {/* Beaconチャットビュー */}
      <div
        className={
          activeView === "beacon"
            ? "flex-1 flex flex-col min-h-0 pb-14"
            : "hidden"
        }
      >
        <MobileChatView
          messages={beaconMessages}
          isStreaming={beaconStreaming}
          streamingText={beaconStreamText}
          onSendMessage={onBeaconSend}
          onClear={onBeaconClear}
        />
      </div>

      {/* ボトムナビゲーション（セッション詳細画面以外で表示） */}
      {showBottomNav && (
        <nav className="fixed bottom-0 left-0 right-0 border-t border-border bg-background z-50 flex">
          <button
            type="button"
            className={`flex-1 py-3 text-center text-sm font-medium ${
              activeView !== "beacon"
                ? "text-primary border-t-2 border-primary"
                : "text-muted-foreground"
            }`}
            onClick={() => setActiveView("list")}
          >
            セッション
          </button>
          <button
            type="button"
            className={`flex-1 py-3 text-center text-sm font-medium ${
              activeView === "beacon"
                ? "text-primary border-t-2 border-primary"
                : "text-muted-foreground"
            }`}
            onClick={() => setActiveView("beacon")}
          >
            Beacon
          </button>
        </nav>
      )}
    </div>
  );
}
