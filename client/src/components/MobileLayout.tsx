/**
 * MobileLayout - モバイル専用ルートコンポーネント
 *
 * 「セッション一覧」「セッション詳細」「Beaconチャット」を
 * ボトムナビゲーションと画面遷移で切り替える。
 * iframe再マウント防止のため、display:none/blockで表示を切り替える。
 */

import { useCallback, useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import { BrowserPane } from "@/components/BrowserPane";
import { MobileChatView } from "@/components/MobileChatView";
import { MobileSessionList } from "@/components/MobileSessionList";
import { MobileSessionView } from "@/components/MobileSessionView";
import type {
  BrowserSession,
  ChatMessage,
  ClientToServerEvents,
  ManagedSession,
  ServerToClientEvents,
  SpecialKey,
  Worktree,
} from "../../../shared/types";
import { useViewerTabs } from "../hooks/useViewerTabs";

interface MobileLayoutProps {
  socket: Socket<ServerToClientEvents, ClientToServerEvents> | null;
  sessions: Map<string, ManagedSession>;
  worktrees: Worktree[];
  repoList: string[];
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
  onNewSession: () => void;
  // ファイルビューワー
  readFile: (sessionId: string, filePath: string) => void;
  fileContent: {
    filePath: string;
    content: string;
    mimeType: string;
    size: number;
    error?: string;
  } | null;
  // Beaconチャット
  beaconMessages: ChatMessage[];
  beaconStreaming: boolean;
  beaconStreamText: string;
  onBeaconSend: (message: string) => void;
  onBeaconClear?: () => void;
  // ブラウザ（noVNC）
  activeBrowserSession: BrowserSession | null;
  onSelectBrowser: () => void;
  navigateBrowser: (url: string) => void;
  isRemote: boolean;
}

export function MobileLayout({
  socket,
  sessions,
  worktrees,
  repoList,
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
  onNewSession,
  readFile,
  fileContent,
  beaconMessages,
  beaconStreaming,
  beaconStreamText,
  onBeaconSend,
  onBeaconClear,
  activeBrowserSession,
  onSelectBrowser,
  navigateBrowser,
  isRemote,
}: MobileLayoutProps) {
  const [activeView, setActiveView] = useState<
    "list" | "detail" | "beacon" | "browser"
  >("list");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );
  const [openedSessions, setOpenedSessions] = useState<Set<string>>(new Set());

  const handleOpenUrl = useCallback(
    (url: string) => {
      if (isRemote) {
        onSelectBrowser();
        setActiveView("browser");
        navigateBrowser(url);
      } else {
        window.open(url, "_blank");
      }
    },
    [isRemote, onSelectBrowser, navigateBrowser]
  );

  // タブ状態管理（共通フック）
  const {
    getTabsForSession,
    getActiveTabForSession,
    handleTabSelect,
    handleTabClose,
  } = useViewerTabs(
    selectedSessionId,
    sessions,
    readFile,
    fileContent,
    handleOpenUrl
  );

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

  // ブラウザを選択して画面遷移
  const handleOpenBrowser = useCallback(() => {
    onSelectBrowser();
    setActiveView("browser");
  }, [onSelectBrowser]);

  // ボトムナビゲーションの表示判定（セッション詳細画面・ブラウザ画面以外で表示）
  const showBottomNav = activeView !== "detail" && activeView !== "browser";

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
          repoList={repoList}
          onOpenSession={handleOpenSession}
          onStartSession={onStartSession}
          onStopSession={onStopSession}
          onDeleteWorktree={onDeleteWorktree}
          onNewSession={onNewSession}
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
              socket={socket}
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
              tabs={getTabsForSession(sessionId)}
              activeTabIndex={getActiveTabForSession(sessionId)}
              onTabSelect={idx => handleTabSelect(sessionId, idx)}
              onTabClose={idx => handleTabClose(sessionId, idx)}
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

      {/* ブラウザビュー（noVNC） */}
      {activeView === "browser" && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="h-12 border-b border-border flex items-center px-4 shrink-0">
            <button
              type="button"
              className="text-sm text-muted-foreground mr-3"
              onClick={handleBack}
            >
              ← 戻る
            </button>
            <span className="text-sm font-medium">ブラウザ</span>
          </div>
          <div className="flex-1 min-h-0">
            {activeBrowserSession ? (
              <BrowserPane browserSession={activeBrowserSession} />
            ) : (
              <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                ブラウザを起動中...
              </div>
            )}
          </div>
        </div>
      )}

      {/* ボトムナビゲーション（セッション詳細画面・ブラウザ画面以外で表示） */}
      {showBottomNav && (
        <nav className="fixed bottom-0 left-0 right-0 border-t border-border bg-background z-50 flex">
          <button
            type="button"
            className={`flex-1 py-3 text-center text-sm font-medium ${
              activeView === "list"
                ? "text-primary border-t-2 border-primary"
                : "text-muted-foreground"
            }`}
            onClick={() => setActiveView("list")}
          >
            セッション
          </button>
          {isRemote && (
            <button
              type="button"
              className={`flex-1 py-3 text-center text-sm font-medium ${
                activeView === "browser"
                  ? "text-primary border-t-2 border-primary"
                  : "text-muted-foreground"
              }`}
              onClick={handleOpenBrowser}
            >
              ブラウザ
            </button>
          )}
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
