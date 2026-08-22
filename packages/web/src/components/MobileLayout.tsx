/**
 * MobileLayout - モバイル専用ルートコンポーネント
 *
 * 「セッション一覧」「セッション詳細」「ブラウザ」を
 * ボトムナビゲーションと画面遷移で切り替える。
 * iframe再マウント防止のため、display:none/blockで表示を切り替える。
 */

import type {
  BridgeSessionStatus,
  BrowserSession,
  ClientToServerEvents,
  DiagramCommentsResponse,
  DiagramDeleteResponse,
  DiagramListItem,
  ManagedSession,
  MessageShortcut,
  ServerToClientEvents,
  SpecialKey,
  Worktree,
} from "@ark/shared";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import { BrowserPane } from "@/components/BrowserPane";
import { MobileSessionList } from "@/components/MobileSessionList";
import { MobileSessionView } from "@/components/MobileSessionView";
import type { ViewerTab } from "@/components/TerminalPane";
import type { DiagramOpenRequest } from "@/lib/mobile-session-view-mode";

// MobileTab / SessionSubView は配列を真実源にし、union 型を派生させる。
// こうしないと runtime 検証配列と型が二重化し、union に値を足したとき配列更新を
// 忘れても型エラーにならず正当な値が静かに潰れる。
const MOBILE_TABS = ["session", "browser"] as const;
const SESSION_SUB_VIEWS = ["list", "detail"] as const;
export type MobileTab = (typeof MOBILE_TABS)[number];
export type SessionSubView = (typeof SESSION_SUB_VIEWS)[number];

/** 永続化ストアから読んだ任意値を MobileTab に正規化（不正値は "session"） */
export function normalizeMobileTab(value: unknown): MobileTab {
  return MOBILE_TABS.includes(value as MobileTab)
    ? (value as MobileTab)
    : "session";
}

/** 永続化ストアから読んだ任意値を SessionSubView に正規化（不正値は "list"） */
export function normalizeSessionSubView(value: unknown): SessionSubView {
  return SESSION_SUB_VIEWS.includes(value as SessionSubView)
    ? (value as SessionSubView)
    : "list";
}

/** 永続化ストアから読んだ任意値を sessionId (string) に正規化（不正値は null）。
 * 壊れた値が openedSessions の Set<string> を汚染するのを防ぐ。 */
export function normalizeSessionId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface MobileLayoutProps {
  socket: Socket<ServerToClientEvents, ClientToServerEvents> | null;
  sessions: Map<string, ManagedSession>;
  worktrees: Worktree[];
  repoList: string[];
  repoPath: string | null;
  onStartSession: (worktree: Worktree) => void;
  /** セッション削除（停止 + メイン以外のWorktree削除） */
  onDeleteSession: (sessionId: string, worktree: Worktree | undefined) => void;
  /** セッション再起動（tmux kill → 新セッション作成。会話履歴は失われる） */
  onRestartSession?: (sessionId: string) => void;
  onDeleteWorktree: (worktree: Worktree) => void;
  onSendMessage: (sessionId: string, message: string) => void;
  onSendKey: (sessionId: string, key: SpecialKey) => void;
  /** セッション選択通知。**親側で `selectedSessionId` プロップ更新まで責任を持つ契約**。
   * これが満たされないと canShowDetail/effectiveSessionSubView が detail を表示できない */
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
  // ビューアタブ状態は Dashboard から props で受け取り、ここでは useViewerTabs を呼ばない
  getTabsForSession: (sessionId: string) => ViewerTab[];
  getActiveTabForSession: (sessionId: string) => number;
  handleTabSelect: (sessionId: string, index: number) => void;
  handleTabClose: (sessionId: string, index: number) => void;
  openDiagramTab: (
    sessionId: string,
    worktreePath: string,
    relPath: string
  ) => void;
  /** diagram:open のたびに sequence が増えるモバイル表示用の明示通知 */
  diagramOpenRequest: DiagramOpenRequest | null;
  // 図ペイン transport（PC の SplitViewPane と同じ集合）
  listDiagrams: (worktreePath: string) => Promise<DiagramListItem[]>;
  deleteDiagram: (
    sessionId: string,
    relPath: string,
    expectedTracked: boolean
  ) => Promise<DiagramDeleteResponse>;
  getDiagramComments: (
    sessionId: string,
    relPath: string
  ) => Promise<DiagramCommentsResponse>;
  createDiagramComment: (
    sessionId: string,
    relPath: string,
    anchorId: string,
    body: string,
    anchorQuote?: string,
    anchorOccurrence?: number
  ) => Promise<DiagramCommentsResponse>;
  resolveDiagramComment: (
    sessionId: string,
    relPath: string,
    threadId: string
  ) => Promise<DiagramCommentsResponse>;
  replyDiagramComment: (
    sessionId: string,
    relPath: string,
    threadId: string,
    body: string
  ) => Promise<DiagramCommentsResponse>;
  deleteDiagramComment: (
    sessionId: string,
    relPath: string,
    threadId: string
  ) => Promise<DiagramCommentsResponse>;
  sendDiagramComment: (
    sessionId: string,
    relPath: string,
    threadId: string
  ) => Promise<DiagramCommentsResponse>;
  /** Socket.IO 接続状態 */
  isSocketConnected: boolean;
  diagramCommentsUpdate: {
    worktreePath: string;
    relPath: string;
    sequence: number;
  } | null;
  // ブラウザ（noVNC）
  activeBrowserSession: BrowserSession | null;
  onSelectBrowser: () => void;
  isRemote: boolean;
  // メッセージショートカット
  messageShortcuts: MessageShortcut[];
  onCreateShortcut: (message: string) => void;
  onUpdateShortcut: (id: string, patch: { message?: string }) => void;
  onDeleteShortcut: (id: string) => void;
  // モバイル UI 状態（Dashboard が永続化）
  selectedSessionId: string | null;
  activeTab: MobileTab;
  sessionSubView: SessionSubView;
  onChangeActiveTab: (tab: MobileTab) => void;
  onChangeSessionSubView: (view: SessionSubView) => void;
  /** session:list を受信済みか。フォールバック判定で使う（復元中の誤list遷移を防ぐ） */
  sessionsLoaded: boolean;
  /** session:previews 由来のセッション状態マップ（チャットビューの busy/AWAITING 用） */
  sessionStatuses: Map<string, BridgeSessionStatus>;
  /** AWAITING 時の確認 UI 生テキストマップ（チャットビューのバナー用） */
  sessionAwaitingTexts: Map<string, string>;
  notificationControl?: ReactNode;
  notificationsSupported?: boolean;
  isSessionNotificationEnabled?: (sessionId: string) => boolean;
  onSessionNotificationEnabledChange?: (
    sessionId: string,
    enabled: boolean
  ) => void;
}

export function MobileLayout({
  socket,
  sessions,
  worktrees,
  repoList,
  repoPath: _repoPath,
  onStartSession,
  onDeleteSession,
  onRestartSession,
  onDeleteWorktree,
  onSendMessage,
  onSendKey,
  onSelectSession,
  onUploadFile,
  onCopyBuffer,
  onNewSession,
  getTabsForSession,
  getActiveTabForSession,
  handleTabSelect,
  handleTabClose,
  openDiagramTab,
  diagramOpenRequest,
  listDiagrams,
  deleteDiagram,
  getDiagramComments,
  createDiagramComment,
  resolveDiagramComment,
  replyDiagramComment,
  deleteDiagramComment,
  sendDiagramComment,
  isSocketConnected,
  diagramCommentsUpdate,
  activeBrowserSession,
  onSelectBrowser,
  isRemote,
  messageShortcuts,
  onCreateShortcut,
  onUpdateShortcut,
  onDeleteShortcut,
  selectedSessionId,
  activeTab,
  sessionSubView,
  onChangeActiveTab,
  onChangeSessionSubView,
  sessionsLoaded,
  sessionStatuses,
  sessionAwaitingTexts,
  notificationControl,
  notificationsSupported = false,
  isSessionNotificationEnabled,
  onSessionNotificationEnabledChange,
}: MobileLayoutProps) {
  const [openedSessions, setOpenedSessions] = useState<Set<string>>(() =>
    selectedSessionId ? new Set([selectedSessionId]) : new Set()
  );

  // 復元/外部更新で selectedSessionId が変わったとき openedSessions に追加
  useEffect(() => {
    if (selectedSessionId) {
      setOpenedSessions(prev =>
        prev.has(selectedSessionId)
          ? prev
          : new Set(prev).add(selectedSessionId)
      );
    }
  }, [selectedSessionId]);
  // ブラウザビューを一度でも開いたかどうかのフラグ
  // 一度開いたらdisplay:hiddenで切り替え、BrowserPaneの再マウント（WebSocket再接続）を防ぐ
  const [hasBrowserOpened, setHasBrowserOpened] = useState(false);

  // セッションを選択して詳細画面に遷移
  const handleOpenSession = useCallback(
    (sessionId: string) => {
      onChangeActiveTab("session");
      onChangeSessionSubView("detail");
      setOpenedSessions(prev => new Set(prev).add(sessionId));
      onSelectSession(sessionId);
    },
    [onSelectSession, onChangeActiveTab, onChangeSessionSubView]
  );

  // 一覧画面に戻る
  const handleBack = useCallback(() => {
    onChangeSessionSubView("list");
  }, [onChangeSessionSubView]);

  // detail が表示可能か (= selectedSessionId が sessions に存在するか) を render 時に導出。
  // 復元直後に sessions Map がまだ空でも、永続化state は触らずに list 表示にフォールバックできる。
  const canShowDetail = !!(
    selectedSessionId && sessions.has(selectedSessionId)
  );
  const effectiveSessionSubView: SessionSubView =
    sessionSubView === "detail" && !canShowDetail ? "list" : sessionSubView;

  // 選択中のセッションが恒久的に存在しない（削除等）場合は、永続化state も
  // 全てクリアする（sessionSubView=list + 不在 selectedSessionId の解除）。
  // sessionsLoaded を待たないと、復元直後 sessions Map がまだ空のときに
  // 誤って "list" を保存してしまい、次回リロード時 detail が復元されなくなる。
  // Dashboard 側にも自動セッション選択ロジックがあるが、MobileLayout 側でも
  // invariant を明示しておく（assertive）。
  useEffect(() => {
    if (!sessionsLoaded || activeTab !== "session") return;
    const hasStaleId = selectedSessionId && !sessions.has(selectedSessionId);
    if (sessionSubView === "detail" && (!selectedSessionId || hasStaleId)) {
      onChangeSessionSubView("list");
    }
  }, [
    sessionsLoaded,
    activeTab,
    sessionSubView,
    selectedSessionId,
    sessions,
    onChangeSessionSubView,
  ]);

  // ワークツリーのIDからWorktreeを取得するヘルパー
  const getWorktreeForSession = (
    session: ManagedSession
  ): Worktree | undefined => {
    return worktrees.find(w => w.id === session.worktreeId);
  };

  // ブラウザを選択して画面遷移
  const handleOpenBrowser = useCallback(() => {
    onSelectBrowser();
    onChangeActiveTab("browser");
    setHasBrowserOpened(true);
  }, [onSelectBrowser, onChangeActiveTab]);

  const showBottomNav = true;

  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden">
      {/* 一覧画面 */}
      <div
        className={
          activeTab === "session" && effectiveSessionSubView === "list"
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
          notificationControl={notificationControl}
          notificationsSupported={notificationsSupported}
          isSessionNotificationEnabled={isSessionNotificationEnabled}
          onSessionNotificationEnabledChange={
            onSessionNotificationEnabledChange
          }
        />
      </div>

      {/* 詳細画面 - 一度でも開いたセッションのみ描画（iframe再マウント防止） */}
      {Array.from(sessions.entries())
        .filter(([sessionId]) => openedSessions.has(sessionId))
        .map(([sessionId, session]) => {
          // この詳細が現在画面に表示されているか。チャットビューの JSONL 購読を
          // 表示中セッションに限定するために使う（全 opened セッションが
          // display:none でマウントされ続けるため）。
          const isActive =
            activeTab === "session" &&
            effectiveSessionSubView === "detail" &&
            selectedSessionId === sessionId;
          return (
            <div
              key={sessionId}
              className={
                isActive ? "flex-1 flex flex-col min-h-0 pb-14" : "hidden"
              }
            >
              <MobileSessionView
                socket={socket}
                isActive={isActive}
                bridgeStatus={sessionStatuses.get(sessionId)}
                awaitingText={sessionAwaitingTexts.get(sessionId)}
                session={session}
                worktree={getWorktreeForSession(session)}
                onBack={handleBack}
                onSendMessage={message => onSendMessage(sessionId, message)}
                onSendKey={key => onSendKey(sessionId, key)}
                onDeleteSession={() =>
                  onDeleteSession(sessionId, getWorktreeForSession(session))
                }
                onRestartSession={
                  onRestartSession
                    ? () => onRestartSession(sessionId)
                    : undefined
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
                diagramOpenRequest={diagramOpenRequest}
                onTabSelect={idx => handleTabSelect(sessionId, idx)}
                onTabClose={idx => handleTabClose(sessionId, idx)}
                isConnected={isSocketConnected}
                diagramCommentsUpdate={diagramCommentsUpdate}
                listDiagrams={listDiagrams}
                deleteDiagram={deleteDiagram}
                getDiagramComments={getDiagramComments}
                createDiagramComment={createDiagramComment}
                replyDiagramComment={replyDiagramComment}
                resolveDiagramComment={resolveDiagramComment}
                deleteDiagramComment={deleteDiagramComment}
                sendDiagramComment={sendDiagramComment}
                onSelectDiagram={(relPath, worktreePath) =>
                  openDiagramTab(sessionId, worktreePath, relPath)
                }
                messageShortcuts={messageShortcuts}
                onCreateShortcut={onCreateShortcut}
                onUpdateShortcut={onUpdateShortcut}
                onDeleteShortcut={onDeleteShortcut}
              />
            </div>
          );
        })}

      {/* ブラウザビュー（noVNC）- 一度開いたら常に描画し、display:hiddenで切り替え。
          BrowserPaneの再マウントによるVNC再接続を防ぐ。 */}
      {hasBrowserOpened && (
        <div
          className={
            activeTab === "browser"
              ? "flex-1 flex flex-col min-h-0 pb-14"
              : "hidden"
          }
        >
          <div className="h-12 border-b border-border flex items-center px-4 shrink-0">
            <button
              type="button"
              className="text-sm text-muted-foreground mr-3"
              onClick={() => onChangeActiveTab("session")}
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

      {/* ボトムナビゲーション */}
      {showBottomNav && (
        <nav className="fixed bottom-0 left-0 right-0 border-t border-border bg-background z-50 flex">
          <button
            type="button"
            className={`flex-1 py-3 text-center text-sm font-medium ${
              activeTab === "session"
                ? "text-primary border-t-2 border-primary"
                : "text-muted-foreground"
            }`}
            onClick={() => onChangeActiveTab("session")}
          >
            セッション
          </button>
          {isRemote && (
            <button
              type="button"
              className={`flex-1 py-3 text-center text-sm font-medium ${
                activeTab === "browser"
                  ? "text-primary border-t-2 border-primary"
                  : "text-muted-foreground"
              }`}
              onClick={handleOpenBrowser}
            >
              ブラウザ
            </button>
          )}
        </nav>
      )}
    </div>
  );
}
