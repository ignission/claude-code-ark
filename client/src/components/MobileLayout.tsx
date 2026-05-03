/**
 * MobileLayout - モバイル専用ルートコンポーネント
 *
 * 「セッション一覧」「セッション詳細」「Beaconチャット」を
 * ボトムナビゲーションと画面遷移で切り替える。
 * iframe再マウント防止のため、display:none/blockで表示を切り替える。
 */

import type Phaser from "phaser";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { BrowserPane } from "@/components/BrowserPane";
import { FrontLineGame } from "@/components/frontline/FrontLineGame";
import { MobileControls } from "@/components/frontline/MobileControls";
import { MobileChatView } from "@/components/MobileChatView";
import { MobileSessionList } from "@/components/MobileSessionList";
import { MobileSessionView } from "@/components/MobileSessionView";
import type {
  BrowserSession,
  ChatMessage,
  ClientToServerEvents,
  ManagedSession,
  MessageShortcut,
  ServerToClientEvents,
  SpecialKey,
  UsageProgress,
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
  /** セッション削除（停止 + メイン以外のWorktree削除） */
  onDeleteSession: (sessionId: string, worktree: Worktree | undefined) => void;
  onDeleteWorktree: (worktree: Worktree) => void;
  onSendMessage: (sessionId: string, message: string) => void;
  onSendKey: (sessionId: string, key: SpecialKey) => void;
  onSelectSession: (sessionId: string) => void;
  onUploadFile?: (data: {
    sessionId: string;
    base64Data: string;
    mimeType: string;
    originalFilename?: string;
  }) => Promise<{
    path: string;
    filename: string;
    originalFilename?: string;
  }>;
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
  // Usage取得（Linux + multiProfileSupported のみ）
  onRequestUsage?: () => void;
  usageRequesting?: boolean;
  usageProgress?: UsageProgress | null;
  multiProfileSupported?: boolean;
  /** MCP server (Beacon の OAuth MCP) マネージャを開く */
  onOpenMcpManager?: () => void;
  // ブラウザ（noVNC）
  activeBrowserSession: BrowserSession | null;
  onSelectBrowser: () => void;
  navigateBrowser: (url: string) => void;
  isRemote: boolean;
  // メッセージショートカット
  messageShortcuts: MessageShortcut[];
  onCreateShortcut: (label: string, message: string) => void;
  onUpdateShortcut: (
    id: string,
    patch: { label?: string; message?: string }
  ) => void;
  onDeleteShortcut: (id: string) => void;
}

export function MobileLayout({
  socket,
  sessions,
  worktrees,
  repoList,
  repoPath: _repoPath,
  onStartSession,
  onDeleteSession,
  onDeleteWorktree,
  onSendMessage,
  onSendKey,
  onSelectSession,
  onUploadFile,
  onCopyBuffer,
  onNewSession,
  readFile,
  fileContent,
  beaconMessages,
  beaconStreaming,
  beaconStreamText,
  onBeaconSend,
  onBeaconClear,
  onRequestUsage,
  usageRequesting,
  usageProgress,
  multiProfileSupported,
  onOpenMcpManager,
  activeBrowserSession,
  onSelectBrowser,
  navigateBrowser,
  isRemote,
  messageShortcuts,
  onCreateShortcut,
  onUpdateShortcut,
  onDeleteShortcut,
}: MobileLayoutProps) {
  const [activeView, setActiveView] = useState<
    "list" | "detail" | "beacon" | "browser" | "frontline"
  >("list");
  const [frontlineOpened, setFrontlineOpened] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );
  const [openedSessions, setOpenedSessions] = useState<Set<string>>(new Set());
  // ブラウザビューを一度でも開いたかどうかのフラグ
  // 一度開いたらdisplay:hiddenで切り替え、BrowserPaneの再マウント（WebSocket再接続）を防ぐ
  const [hasBrowserOpened, setHasBrowserOpened] = useState(false);

  const handleOpenUrl = useCallback(
    (url: string) => {
      if (isRemote) {
        onSelectBrowser();
        setActiveView("browser");
        setHasBrowserOpened(true);
        navigateBrowser(url);
      } else {
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.click();
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
    setHasBrowserOpened(true);
  }, [onSelectBrowser]);

  const showBottomNav = true;

  // FrontLineタブ離脱/復帰時にpause/resume
  const prevActiveViewRef = useRef(activeView);
  useEffect(() => {
    const prev = prevActiveViewRef.current;
    prevActiveViewRef.current = activeView;
    if (prev === activeView) return;

    const game = (window as unknown as Record<string, unknown>)
      .__FRONTLINE_GAME__ as Phaser.Game | undefined;
    if (!game) return;

    if (prev === "frontline" && activeView !== "frontline") {
      game.events.emit("modal:pause");
      game.loop.sleep();
    } else if (prev !== "frontline" && activeView === "frontline") {
      game.loop.wake();
      game.events.emit("modal:resume");
    }
  }, [activeView]);

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
          onDeleteSession={onDeleteSession}
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
                ? "flex-1 flex flex-col min-h-0 pb-14"
                : "hidden"
            }
          >
            <MobileSessionView
              session={session}
              worktree={getWorktreeForSession(session)}
              onBack={handleBack}
              onSendMessage={message => onSendMessage(sessionId, message)}
              onSendKey={key => onSendKey(sessionId, key)}
              onDeleteSession={() =>
                onDeleteSession(sessionId, getWorktreeForSession(session))
              }
              onUploadFile={
                onUploadFile
                  ? data => onUploadFile({ sessionId, ...data })
                  : undefined
              }
              onCopyBuffer={
                onCopyBuffer ? () => onCopyBuffer(sessionId) : undefined
              }
              tabs={getTabsForSession(sessionId)}
              activeTabIndex={getActiveTabForSession(sessionId)}
              onTabSelect={idx => handleTabSelect(sessionId, idx)}
              onTabClose={idx => handleTabClose(sessionId, idx)}
              messageShortcuts={messageShortcuts}
              onCreateShortcut={onCreateShortcut}
              onUpdateShortcut={onUpdateShortcut}
              onDeleteShortcut={onDeleteShortcut}
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
          onRequestUsage={onRequestUsage}
          usageRequesting={usageRequesting}
          usageProgress={usageProgress}
          multiProfileSupported={multiProfileSupported}
          onOpenMcpManager={onOpenMcpManager}
        />
      </div>

      {/* ブラウザビュー（noVNC）- 一度開いたら常に描画し、display:hiddenで切り替え。
          BrowserPaneの再マウントによるVNC再接続を防ぐ。 */}
      {hasBrowserOpened && (
        <div
          className={
            activeView === "browser"
              ? "flex-1 flex flex-col min-h-0 pb-14"
              : "hidden"
          }
        >
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
              className="flex-1 py-3 text-center text-sm font-medium text-muted-foreground"
              onClick={handleOpenBrowser}
            >
              ブラウザ
            </button>
          )}
          <button
            type="button"
            className={`flex-1 py-3 text-center text-sm font-medium ${
              activeView === "frontline"
                ? "text-primary border-t-2 border-primary"
                : "text-muted-foreground"
            }`}
            onClick={() => {
              setActiveView("frontline");
              setFrontlineOpened(true);
            }}
          >
            🎯
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

      {/* FrontLine ビュー — 一度開いたら常に描画（ゲーム状態保持） */}
      {frontlineOpened && (
        <div
          className={
            activeView === "frontline"
              ? "flex-1 flex flex-col min-h-0 pb-14 bg-black"
              : "hidden"
          }
        >
          <div className="flex-1 flex items-center justify-center min-h-0">
            <FrontLineGame socket={socket} />
          </div>
          <div className="shrink-0">
            <MobileControls />
          </div>
        </div>
      )}
    </div>
  );
}
