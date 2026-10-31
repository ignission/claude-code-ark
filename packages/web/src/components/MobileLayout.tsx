/**
 * MobileLayout - モバイル専用ルートコンポーネント
 *
 * 「セッション一覧」「セッション詳細」「ブラウザ」「リモート画面」を
 * 画面遷移と、リモート時または画面登録があるときに出す下部タブで切り替える。
 * iframe再マウント防止のため、display:none/blockで表示を切り替える。
 * ただしリモート画面のタブだけは display:none を使わず、絶対配置 +
 * visibility でサイズを保ったまま隠す (noVNC の倍率計算のため。
 * 理由は screenPaneClassName のコメント)。
 */

import type {
  BridgeSessionStatus,
  ClientToServerEvents,
  DiagramDeleteResponse,
  DiagramListItem,
  ManagedSession,
  MessageShortcut,
  PlanLimits,
  Profile,
  Screen,
  ScreenCredentialsResult,
  ScreenPasteResult,
  ServerToClientEvents,
  SessionPrStatus,
  SpecialKey,
  SystemCapabilities,
  Worktree,
} from "@ark/shared";
import { ChevronLeft } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import { MobileSessionList } from "@/components/MobileSessionList";
import { MobileSessionView } from "@/components/MobileSessionView";
import { ScreenPane } from "@/components/ScreenPane";
import type { ViewerTab } from "@/components/TerminalPane";
import type {
  ChatViewRequest,
  DiagramOpenRequest,
} from "@/lib/mobile-session-view-mode";
import { getBaseName, isPathWithin } from "@/utils/pathUtils";
import { findRepoForSession } from "@/utils/sessionUtils";

// MobileTab / SessionSubView は配列を真実源にし、union 型を派生させる。
// こうしないと runtime 検証配列と型が二重化し、union に値を足したとき配列更新を
// 忘れても型エラーにならず正当な値が静かに潰れる。
const MOBILE_TABS = ["session", "screen"] as const;
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
  getViewerOpenSeqForSession: (sessionId: string) => number;
  handleTabSelect: (sessionId: string, index: number) => void;
  handleTabClose: (sessionId: string, index: number) => void;
  openDiagramTab: (
    sessionId: string,
    worktreePath: string,
    relPath: string
  ) => void;
  /** diagram:open のたびに sequence が増えるモバイル表示用の明示通知 */
  diagramOpenRequest: DiagramOpenRequest | null;
  /** 会話モードへ切り替える要求 (分岐TODOから話し始めたとき) */
  chatViewRequest?: ChatViewRequest | null;
  // 図ペイン transport（PC の SplitViewPane と同じ集合）
  listDiagrams: (worktreePath: string) => Promise<DiagramListItem[]>;
  deleteDiagram: (
    sessionId: string,
    relPath: string,
    expectedTracked: boolean
  ) => Promise<DiagramDeleteResponse>;
  /** Socket.IO 接続状態 */
  isSocketConnected: boolean;
  // ブラウザ
  // リモート画面
  screens: Screen[];
  requestScreenCredentials: (id: string) => Promise<ScreenCredentialsResult>;
  setScreenClipboard: (id: string, text: string) => Promise<ScreenPasteResult>;
  onOpenScreenManager: () => void;
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
  /** sessionId → 会話の最終更新時刻 (一覧の並べ替え用) */
  sessionLastUpdatedAt?: Map<string, number>;
  /** AWAITING 時の確認 UI 生テキストマップ（チャットビューのバナー用） */
  sessionAwaitingTexts: Map<string, string>;
  /** 作業中の画面末尾マップ（会話ビューで動きを見せる） */
  sessionLiveTails: Map<string, string>;
  /** プランの使用量マップ（入力欄の横に出す） */
  sessionPlanLimits: Map<string, PlanLimits>;
  /** session:previews由来の端末の最後の内容行 (一覧の2行目) */
  sessionPreviews: Map<string, string>;
  sessionPrStatuses: Map<string, SessionPrStatus>;
  /** sessionId → 未完了の分岐TODOの件数 */
  sessionTodoCounts?: Map<string, number>;
  /** 「TODO」モードの本文。他の worktree の見出しからセッションを開く操作を受け取る */
  renderTodoPane?: (
    session: ManagedSession,
    openWorktree: (worktreePath: string) => void
  ) => ReactNode;
  /** worktreePath → 表示名 (一覧の行とTask 10のヘッダーの主ラベル) */
  worktreeDisplayNames: Map<string, string>;
  onSetWorktreeDisplayName?: (
    worktreePath: string,
    displayName: string | null
  ) => void;
  /** プロファイル切替 (Linux限定) */
  capabilities?: SystemCapabilities;
  profiles?: Profile[];
  repoProfileLinks?: Map<string, string>;
  worktreeProfileLinks?: Map<string, string>;
  onSetRepoProfile?: (repoPath: string, profileId: string | null) => void;
  onSetWorktreeProfile?: (
    worktreePath: string,
    profileId: string | null
  ) => void;
  onOpenProfileManager?: () => void;
  /** 行メニューの「リポジトリ」の操作 */
  onCreateWorktreeForRepo?: (repoPath: string) => void;
  onRemoveRepo?: (repoPath: string) => void;
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
  getViewerOpenSeqForSession,
  handleTabSelect,
  handleTabClose,
  openDiagramTab,
  diagramOpenRequest,
  chatViewRequest,
  listDiagrams,
  deleteDiagram,
  isSocketConnected,
  screens,
  requestScreenCredentials,
  setScreenClipboard,
  onOpenScreenManager,
  messageShortcuts,
  onCreateShortcut,
  onUpdateShortcut,
  onDeleteShortcut,
  selectedSessionId,
  activeTab: storedActiveTab,
  sessionSubView,
  onChangeActiveTab,
  onChangeSessionSubView,
  sessionsLoaded,
  sessionStatuses,
  sessionLastUpdatedAt,
  sessionAwaitingTexts,
  sessionLiveTails,
  sessionPlanLimits,
  sessionPreviews,
  sessionPrStatuses,
  sessionTodoCounts,
  renderTodoPane,
  worktreeDisplayNames,
  onSetWorktreeDisplayName,
  capabilities,
  profiles,
  repoProfileLinks,
  worktreeProfileLinks,
  onSetRepoProfile,
  onSetWorktreeProfile,
  onOpenProfileManager,
  onCreateWorktreeForRepo,
  onRemoveRepo,
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

  // TODO の見出しから、その worktree のセッションを一覧で開いたときと同じ操作で開く
  const openWorktreeSession = useCallback(
    (worktreePath: string) => {
      for (const [sessionId, session] of sessions) {
        if (session.worktreePath === worktreePath) {
          handleOpenSession(sessionId);
          return;
        }
      }
    },
    [sessions, handleOpenSession]
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
  // 画面のタブは登録があるときだけある。
  // 無いタブが保存されていたら一覧に戻す (戻る手段の無い空の画面を避ける)
  const hasScreens = screens.length > 0;
  const activeTab: MobileTab =
    storedActiveTab === "screen" && !hasScreens ? "session" : storedActiveTab;

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

  // 画面タブ。複数登録があれば上部の select で切り替える
  const [selectedScreenId, setSelectedScreenId] = useState<string | null>(null);
  const [openedScreenIds, setOpenedScreenIds] = useState<Set<string>>(
    () => new Set()
  );
  const activeScreenId =
    selectedScreenId && screens.some(s => s.id === selectedScreenId)
      ? selectedScreenId
      : (screens[0]?.id ?? null);
  const handleOpenScreenTab = useCallback(() => {
    onChangeActiveTab("screen");
    if (activeScreenId) {
      setOpenedScreenIds(prev =>
        prev.has(activeScreenId) ? prev : new Set(prev).add(activeScreenId)
      );
    }
  }, [onChangeActiveTab, activeScreenId]);
  useEffect(() => {
    if (activeTab === "screen" && activeScreenId) {
      setOpenedScreenIds(prev =>
        prev.has(activeScreenId) ? prev : new Set(prev).add(activeScreenId)
      );
    }
  }, [activeTab, activeScreenId]);

  // 下部タブはブラウザタブがあるリモート時、または画面タブがある登録時に、
  // 一覧・ブラウザ・画面の画面に出す。
  // 会話の詳細画面は自前の下部バーを画面の下端に置くので、タブを重ねない
  const isDetailShown =
    activeTab === "session" && effectiveSessionSubView === "detail";
  const hasBottomNav = hasScreens;
  const showBottomNav = hasBottomNav && !isDetailShown;
  // 一覧とブラウザ・画面のラッパーだけが、下部タブの高さぶんの余白を持つ
  const paneClassName = hasBottomNav
    ? "flex-1 flex flex-col min-h-0 pb-14"
    : "flex-1 flex flex-col min-h-0";
  // 画面タブだけは display:none で隠さない。noVNC の scaleViewport は
  // コンテナの実寸から倍率を決めるので、隠れている間に画面が回転したり
  // キーボードが出たりすると autoscale(0,0) に落ち、戻しても戻らない。
  // flex-1 のまま残すと一覧と高さを取り合うため、絶対配置で流れから外し、
  // 見えているときも隠れているときも同じ箱 (inset-0) のままにする
  const screenPaneClassName = hasBottomNav
    ? "absolute inset-0 flex flex-col min-h-0 pb-14"
    : "absolute inset-0 flex flex-col min-h-0";
  const tabClassName = (selected: boolean) =>
    `flex-1 py-3 text-center text-sm ${
      selected
        ? "font-semibold text-foreground"
        : "font-medium text-muted-foreground"
    }`;

  return (
    // relative は画面タブのラッパー (absolute inset-0) の基準に使う
    <div className="relative h-full flex flex-col min-h-0 overflow-hidden">
      {/* 一覧画面 */}
      <div
        className={
          activeTab === "session" && effectiveSessionSubView === "list"
            ? paneClassName
            : "hidden"
        }
      >
        <MobileSessionList
          onOpenScreenManager={onOpenScreenManager}
          sessions={sessions}
          worktrees={worktrees}
          repoList={repoList}
          sessionStatuses={sessionStatuses}
          sessionLastUpdatedAt={sessionLastUpdatedAt}
          sessionPreviews={sessionPreviews}
          sessionPrStatuses={sessionPrStatuses}
          sessionTodoCounts={sessionTodoCounts}
          worktreeDisplayNames={worktreeDisplayNames}
          capabilities={capabilities}
          profiles={profiles}
          repoProfileLinks={repoProfileLinks}
          worktreeProfileLinks={worktreeProfileLinks}
          notificationsSupported={notificationsSupported}
          isSessionNotificationEnabled={isSessionNotificationEnabled}
          onOpenSession={handleOpenSession}
          onStartSession={onStartSession}
          onDeleteSession={onDeleteSession}
          onDeleteWorktree={onDeleteWorktree}
          onRestartSession={onRestartSession}
          onSetWorktreeDisplayName={onSetWorktreeDisplayName}
          onSessionNotificationEnabledChange={
            onSessionNotificationEnabledChange
          }
          onCreateWorktreeForRepo={onCreateWorktreeForRepo}
          onRemoveRepo={onRemoveRepo}
          onSetRepoProfile={onSetRepoProfile}
          onSetWorktreeProfile={onSetWorktreeProfile}
          onOpenProfileManager={onOpenProfileManager}
          onNewSession={onNewSession}
          notificationControl={notificationControl}
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
          const worktree = getWorktreeForSession(session);
          // 主ラベルに使うリポジトリ名。PC の上部バー (Dashboard) とサイドバー
          // (useGroupedWorktreeItems) と同じ順 (session.repoPath → worktree のパス →
          // 兄弟ディレクトリの推定) で決める
          const repoPathOfSession =
            session.repoPath ??
            (worktree
              ? repoList.find(repo => isPathWithin(worktree.path, repo))
              : undefined) ??
            findRepoForSession(session, repoList);
          return (
            <div
              key={sessionId}
              className={isActive ? "flex-1 flex flex-col min-h-0" : "hidden"}
            >
              <MobileSessionView
                socket={socket}
                isActive={isActive}
                bridgeStatus={sessionStatuses.get(sessionId)}
                awaitingText={sessionAwaitingTexts.get(sessionId)}
                liveTail={sessionLiveTails.get(sessionId)}
                planLimits={sessionPlanLimits.get(sessionId)}
                session={session}
                worktree={worktree}
                repoName={
                  repoPathOfSession ? getBaseName(repoPathOfSession) : undefined
                }
                displayName={
                  worktreeDisplayNames.get(
                    worktree?.path ?? session.worktreePath
                  ) ?? null
                }
                notificationsSupported={notificationsSupported}
                notificationsEnabled={
                  isSessionNotificationEnabled?.(sessionId) ?? true
                }
                onNotificationsEnabledChange={
                  onSessionNotificationEnabledChange
                    ? enabled =>
                        onSessionNotificationEnabledChange(sessionId, enabled)
                    : undefined
                }
                onBack={handleBack}
                todoPane={renderTodoPane?.(session, openWorktreeSession)}
                onSendMessage={message => onSendMessage(sessionId, message)}
                onSendKey={key => onSendKey(sessionId, key)}
                onDeleteSession={() => onDeleteSession(sessionId, worktree)}
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
                viewerOpenSeq={getViewerOpenSeqForSession(sessionId)}
                diagramOpenRequest={diagramOpenRequest}
                chatViewRequest={chatViewRequest}
                onTabSelect={idx => handleTabSelect(sessionId, idx)}
                onTabClose={idx => handleTabClose(sessionId, idx)}
                isConnected={isSocketConnected}
                listDiagrams={listDiagrams}
                deleteDiagram={deleteDiagram}
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

      {/* リモート画面 - 一度開いた画面はマウントしたまま、
          サイズを保ったまま visibility だけで切り替える
          (理由は screenPaneClassName のコメント) */}
      {openedScreenIds.size > 0 && (
        <div
          className={
            activeTab === "screen"
              ? screenPaneClassName
              : `${screenPaneClassName} invisible pointer-events-none`
          }
        >
          <div className="h-12 border-b border-border flex items-center gap-3 px-4 shrink-0">
            <button
              type="button"
              className="inline-flex items-center gap-0.5 text-sm text-muted-foreground"
              onClick={() => onChangeActiveTab("session")}
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
              戻る
            </button>
            {screens.length > 1 ? (
              <select
                aria-label="表示する画面"
                className="text-sm bg-transparent"
                value={activeScreenId ?? ""}
                onChange={e => setSelectedScreenId(e.target.value)}
              >
                {screens.map(screen => (
                  <option key={screen.id} value={screen.id}>
                    {screen.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-sm font-medium">
                {screens[0]?.name ?? "画面"}
              </span>
            )}
            <button
              type="button"
              className="ml-auto text-sm text-muted-foreground"
              onClick={onOpenScreenManager}
            >
              管理
            </button>
          </div>
          <div className="flex-1 min-h-0 relative">
            {screens
              .filter(screen => openedScreenIds.has(screen.id))
              .map(screen => (
                <div
                  key={screen.id}
                  className={
                    activeScreenId === screen.id
                      ? "absolute inset-0"
                      : "absolute inset-0 invisible pointer-events-none"
                  }
                >
                  <ScreenPane
                    screen={screen}
                    requestCredentials={requestScreenCredentials}
                    setClipboard={setScreenClipboard}
                  />
                </div>
              ))}
          </div>
        </div>
      )}

      {/* 下部タブ。選択中は緑の線ではなく、文字色とウェイトで示す */}
      {showBottomNav && (
        <nav
          aria-label="画面の切り替え"
          className="fixed bottom-0 left-0 right-0 z-50 flex border-t border-border bg-background"
        >
          <button
            type="button"
            aria-current={activeTab === "session" ? "page" : undefined}
            className={tabClassName(activeTab === "session")}
            onClick={() => onChangeActiveTab("session")}
          >
            セッション
          </button>
          {hasScreens && (
            <button
              type="button"
              aria-current={activeTab === "screen" ? "page" : undefined}
              className={tabClassName(activeTab === "screen")}
              onClick={handleOpenScreenTab}
            >
              画面
            </button>
          )}
        </nav>
      )}
    </div>
  );
}
