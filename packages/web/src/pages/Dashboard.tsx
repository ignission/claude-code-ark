import type { ManagedSession, SpecialKey, Worktree } from "@ark/shared";
import { AlertCircle, Copy, Loader2, Terminal } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AboutDialog } from "@/components/AboutDialog";
import { BrowserPane } from "@/components/BrowserPane";
import { CreateWorktreeDialog } from "@/components/CreateWorktreeDialog";
import {
  MobileLayout,
  type MobileTab,
  normalizeMobileTab,
  normalizeSessionId,
  normalizeSessionSubView,
  type SessionSubView,
} from "@/components/MobileLayout";
import { NotificationPermissionButton } from "@/components/NotificationPermissionButton";
import { ProfileManagerDialog } from "@/components/ProfileManagerDialog";
import { RepoGridView } from "@/components/RepoGridView";
import { RepoSelectDialog } from "@/components/RepoSelectDialog";
import { SessionSidebar } from "@/components/SessionSidebar";
import { SidebarMainLayout } from "@/components/SidebarMainLayout";
import { SplitViewPane } from "@/components/SplitViewPane";
import { UpdateBanner } from "@/components/UpdateBanner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBridgeSnapshot } from "@/hooks/useBridgeSnapshot";
import { useIsMobile } from "@/hooks/useMobile";
import { useSessionNotifications } from "@/hooks/useSessionNotifications";
import { useSettings } from "@/hooks/useSettings";
import { useSocket } from "@/hooks/useSocket";
import { useViewerTabs } from "@/hooks/useViewerTabs";
import {
  createDiagramOpenRequest,
  type DiagramOpenRequest,
} from "@/lib/mobile-session-view-mode";
import {
  isNotificationEnabledForSession,
  normalizeSessionNotificationSettings,
  updateSessionNotificationSettings,
} from "@/lib/session-notifications";
import { getBaseName } from "@/utils/pathUtils";
import {
  findRepoForSession,
  isSessionBelongsToRepo,
} from "@/utils/sessionUtils";

export default function Dashboard() {
  const {
    settings,
    isLoading: isSettingsLoading,
    getSetting,
    setSetting,
  } = useSettings();

  const savedRepoList = getSetting<string[]>("repoList", []);
  const savedRepoPath = getSetting<string | null>("selectedRepoPath", null);
  const savedScanBasePath = getSetting<string>("scanBasePath", "");

  const {
    socket,
    isConnected,
    error,
    diagramCommentsUpdate,
    allowedRepos,
    repoList,
    repoPath,
    selectRepo,
    removeRepo,
    scannedRepos,
    isScanning,
    scanRepos,
    listDirectory,
    listDiagrams,
    deleteDiagram,
    getDiagramComments,
    createDiagramComment,
    replyDiagramComment,
    resolveDiagramComment,
    deleteDiagramComment,
    sendDiagramComment,
    worktrees,
    createWorktree,
    deleteWorktree,
    sessions,
    sessionsLoaded,
    startSession,
    stopSession,
    sendMessage,
    sendKey,
    tunnelUrl,
    tunnelToken,
    tunnelLoading,
    tunnelJustStarted,
    startTunnel,
    stopTunnel,
    clearTunnelJustStarted,
    listeningPorts,
    uploadFile,
    copyBuffer,
    deletedWorktreeId,
    clearDeletedWorktreeId,
    sessionPreviews,
    sessionActivityTexts,
    sessionAwaitingTexts,
    gridSnapshots,
    subscribeGrid,
    unsubscribeGrid,
    sessionStatuses,
    sessionStatusSignals,
    sessionAuqSignals,
    readFile,
    fileContent,
    browserSessions,
    startBrowser,
    navigateBrowser,
    profiles,
    repoProfileLinks,
    worktreeProfileLinks,
    capabilities,
    createProfile,
    updateProfile,
    deleteProfile,
    setRepoProfile,
    setWorktreeProfile,
    worktreeDisplayNames,
    setWorktreeDisplayName,
    restartSessionWithProfile,
    messageShortcuts,
    createShortcut,
    updateShortcut,
    deleteShortcut,
  } = useSocket({
    enabled: !isSettingsLoading,
    initialRepoList: savedRepoList,
    initialRepoPath: savedRepoPath,
    onRepoListChange: list => setSetting("repoList", list),
    onRepoPathChange: path => setSetting("selectedRepoPath", path),
  });

  const isMobile = useIsMobile();

  // PCサイドバー下部のシステムステータスバー用に bridge:snapshot を購読
  const bridgeSnapshot = useBridgeSnapshot(socket, !isMobile);

  const isRemote =
    typeof window !== "undefined" &&
    window.location.hostname !== "localhost" &&
    window.location.hostname !== "127.0.0.1";

  const activeBrowserSession = Array.from(browserSessions.values())[0] ?? null;

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );
  const [mobileActiveTab, setMobileActiveTab] = useState<MobileTab>("session");
  const [mobileSessionSubView, setMobileSessionSubView] =
    useState<SessionSubView>("list");
  const [diagramOpenRequest, setDiagramOpenRequest] =
    useState<DiagramOpenRequest | null>(null);
  // ブラウザビューを一度でも開いたかどうかのフラグ
  // 一度開いたら常に描画してdisplay:hiddenで切り替え、BrowserPaneの再マウント（VNC再接続）を防ぐ
  const [hasBrowserOpened, setHasBrowserOpened] = useState(false);

  // リポジトリ別セッショングリッドビュー (B案: スナップショット型)
  // null 以外のとき main 領域は RepoGridView に切り替わる。
  // selectedSessionId とは独立。セルクリックで selectedSessionId に切替えてターミナル表示に潜る
  const [gridRepoPath, setGridRepoPath] = useState<string | null>(null);

  const sessionNotificationSettings = useMemo(
    () =>
      normalizeSessionNotificationSettings(
        settings["sessionNotifications.enabledBySession"]
      ),
    [settings]
  );

  const sessionNotificationLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const session of sessions.values()) {
      const worktree = worktrees.find(item => item.id === session.worktreeId);
      const customName = worktreeDisplayNames
        .get(worktree?.path ?? session.worktreePath)
        ?.trim();
      labels.set(
        session.id,
        customName || worktree?.branch || getBaseName(session.worktreePath)
      );
    }
    return labels;
  }, [sessions, worktreeDisplayNames, worktrees]);

  const handleOpenSessionFromNotification = useCallback(
    (sessionId: string) => {
      setGridRepoPath(null);
      setSelectedSessionId(sessionId);
      if (isMobile) {
        setMobileActiveTab("session");
        setMobileSessionSubView("detail");
      }
    },
    [isMobile]
  );

  const sessionNotifications = useSessionNotifications({
    statusSignals: sessionStatusSignals,
    auqSignals: sessionAuqSignals,
    sessionLabels: sessionNotificationLabels,
    enabledBySession: sessionNotificationSettings,
    onOpenSession: handleOpenSessionFromNotification,
  });

  const isSessionNotificationEnabled = useCallback(
    (sessionId: string) =>
      isNotificationEnabledForSession(sessionNotificationSettings, sessionId),
    [sessionNotificationSettings]
  );

  const handleSessionNotificationEnabledChange = useCallback(
    (sessionId: string, enabled: boolean) => {
      setSetting(
        "sessionNotifications.enabledBySession",
        updateSessionNotificationSettings(
          sessionNotificationSettings,
          sessionId,
          enabled
        )
      );
    },
    [sessionNotificationSettings, setSetting]
  );

  const notificationControl = (
    <NotificationPermissionButton
      supported={sessionNotifications.supported}
      permission={sessionNotifications.permission}
      onRequestPermission={sessionNotifications.requestPermission}
      className={isMobile ? "h-12 w-12" : "h-8 w-8"}
    />
  );

  /** リポジトリヘッダクリック時: グリッドビューを開く */
  const handleSelectRepoGrid = useCallback((repoPath: string) => {
    setGridRepoPath(repoPath);
    setSelectedSessionId(null);
  }, []);

  /** グリッドのセルクリック時: ターミナル表示に切替 */
  const handleSelectSessionFromGrid = useCallback((sessionId: string) => {
    setGridRepoPath(null);
    setSelectedSessionId(sessionId);
  }, []);

  /** ブラウザを選択（未起動なら起動） */
  const handleSelectBrowser = useCallback(() => {
    if (!activeBrowserSession) {
      startBrowser();
    }
    setSelectedSessionId("browser");
    setHasBrowserOpened(true);
  }, [activeBrowserSession, startBrowser]);

  /** localhost URLクリック時: ブラウザに遷移して選択 */
  const handleOpenUrl = useCallback(
    (url: string) => {
      if (isRemote) {
        if (isMobile) {
          handleSelectBrowser();
          setMobileActiveTab("browser");
        }
        navigateBrowser(url);
        setSelectedSessionId("browser");
        setHasBrowserOpened(true);
      } else {
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.click();
      }
    },
    [isRemote, isMobile, handleSelectBrowser, navigateBrowser]
  );

  // PC / モバイル共通の単一インスタンス。MobileLayout で再度呼ぶとリンクタップの
  // ハンドラが二重登録され、URL オープンが 2 回走るため、ここだけで管理する。
  const {
    getTabsForSession,
    getActiveTabForSession,
    handleTabSelect,
    handleTabClose,
    openDiagramTab,
    clearDiagramTab,
  } = useViewerTabs(
    selectedSessionId,
    sessions,
    readFile,
    fileContent,
    handleOpenUrl,
    true
  );

  // diagram:open を受けて図タブを開く。worktreePath はサーバーから送られない
  // （絶対パスの配布範囲を広げないため）。クライアントが既に持っている
  // sessions から sessionId 経由で引く。
  useEffect(() => {
    if (!socket) return;
    const onDiagramOpen = (data: { sessionId: string; relPath: string }) => {
      const session = sessions.get(data.sessionId);
      if (!session?.worktreePath) return;
      openDiagramTab(data.sessionId, session.worktreePath, data.relPath);
      setDiagramOpenRequest(previous =>
        createDiagramOpenRequest(previous, data.sessionId, data.relPath)
      );
    };
    socket.on("diagram:open", onDiagramOpen);
    return () => {
      socket.off("diagram:open", onDiagramOpen);
    };
  }, [socket, sessions, openDiagramTab]);

  useEffect(() => {
    if (!socket) return;
    const onDiagramDeleted = (data: { sessionId: string; relPath: string }) => {
      clearDiagramTab(data.sessionId, data.relPath);
    };
    socket.on("diagram:deleted", onDiagramDeleted);
    return () => {
      socket.off("diagram:deleted", onDiagramDeleted);
    };
  }, [socket, clearDiagramTab]);

  // セッションで最後に開いていた図（lastDiagramPath）をリロード後に復元する。
  // 「セッションが見つからなければ何もしない」という diagram:open ハンドラと
  // 同じガードを踏襲する（sessions に無いセッションは処理対象にならない）。
  //
  // 復元は各 sessionId につき一度だけ試みる（restoredDiagramSessionIdsRef）。
  // session:updated 等で sessions が再エミットされるたびに再実行すると、
  // ユーザーが後から手動で右ペインを閉じた操作を無限ループで打ち消しかねない
  // ため、「最初に対象セッションを認識したとき」だけに限定する。
  //
  // openDiagramTab には restoredOnLoad=true を渡す。SplitViewPane 側の
  // 「図タブが増えたら右ペインを自動表示する」effect は、マウント直後は
  // 常にカウント基準値 0 から始まるため、素直に復元すると毎回強制で右ペインが
  // 開いてしまう（詳細は SplitViewPane.tsx のコメント参照）。restoredOnLoad の
  // タブは自動表示のカウント対象から除外されるため、ユーザーが閉じた状態が
  // リロードのたびに上書きされることはない。
  const restoredDiagramSessionIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const session of sessions.values()) {
      if (restoredDiagramSessionIdsRef.current.has(session.id)) continue;
      restoredDiagramSessionIdsRef.current.add(session.id);

      if (!session.lastDiagramPath || !session.worktreePath) continue;
      // 既に図タブがある場合は復元不要（diagram:open ハンドラが既に開いている等）
      const hasDiagramTab = getTabsForSession(session.id).some(
        t => t.type === "diagram"
      );
      if (hasDiagramTab) continue;

      openDiagramTab(
        session.id,
        session.worktreePath,
        session.lastDiagramPath,
        true
      );
    }
  }, [sessions, getTabsForSession, openDiagramTab]);

  // サーバーからの設定が読み込まれたらセッションIDを復元
  const settingsInitializedRef = useRef(false);
  useEffect(() => {
    if (!isSettingsLoading && !settingsInitializedRef.current) {
      settingsInitializedRef.current = true;
      // 永続化ストアから読んだ値は runtime で正規化（壊れた値・型不一致対策）。
      // selectedSessionId も string-or-null に正規化しないと openedSessions の
      // Set<string> に汚染値が入る恐れがある。
      setSelectedSessionId(
        normalizeSessionId(getSetting<unknown>("selectedSessionId", null))
      );
      setMobileActiveTab(
        normalizeMobileTab(getSetting<unknown>("mobile.activeTab", "session"))
      );
      setMobileSessionSubView(
        normalizeSessionSubView(
          getSetting<unknown>("mobile.sessionSubView", "list")
        )
      );
    }
  }, [isSettingsLoading, getSetting]);

  // 設定読み込み完了後にリポジトリを復元（Socket接続が設定読み込みより先に完了する場合の対策）
  useEffect(() => {
    if (!isSettingsLoading && settingsInitializedRef.current) {
      const repoPath = getSetting<string | null>("selectedRepoPath", null);
      if (repoPath) {
        selectRepo(repoPath);
      }
    }
  }, [isSettingsLoading, getSetting, selectRepo]);

  // selectedSessionIdのサーバー永続化
  useEffect(() => {
    if (settingsInitializedRef.current) {
      setSetting("selectedSessionId", selectedSessionId);
    }
  }, [selectedSessionId, setSetting]);

  // モバイル UI 状態の永続化
  useEffect(() => {
    if (settingsInitializedRef.current) {
      setSetting("mobile.activeTab", mobileActiveTab);
    }
  }, [mobileActiveTab, setSetting]);

  useEffect(() => {
    if (settingsInitializedRef.current) {
      setSetting("mobile.sessionSubView", mobileSessionSubView);
    }
  }, [mobileSessionSubView, setSetting]);

  // 注: 以前はここで subscribeGrid を常時 ON にしていたが、サーバ側で
  // collectGridSnapshots() が 1.5秒ごとに走り session:previews と pane polling が
  // 二重化していた。サイドバードット色は session:previews が運ぶ
  // bridgeStatus (sessionStatuses) を使うので、grid 購読は RepoGridView 内で
  // mount/unmount に紐付ける形に戻している。

  // リロード時にブラウザ選択状態を維持:
  // selectedSessionIdが"browser"のまま復元された場合、
  // browserSessionがまだなければ自動的に起動する。
  useEffect(() => {
    if (selectedSessionId === "browser" && !activeBrowserSession && isRemote) {
      startBrowser();
      setHasBrowserOpened(true);
    }
  }, [selectedSessionId, activeBrowserSession, isRemote, startBrowser]);

  const [isCreateWorktreeOpen, setIsCreateWorktreeOpen] = useState(false);
  /**
   * サイドバー+ボタンで他repoに切り替えた際の元repoPath。
   * ダイアログキャンセル時に元に戻すために保持する。
   * 作成確定時はnullにしてリセットし、新しいrepoに留まらせる。
   * （未選択状態 repoPath===null からの+クリックは「単純選択」として扱い、
   *   復元対象とせず previousRepoPath は更新しない）
   */
  const [previousRepoPath, setPreviousRepoPath] = useState<string | null>(null);
  const [isSelectRepoOpen, setIsSelectRepoOpen] = useState(false);
  const [showTunnelDialog, setShowTunnelDialog] = useState(false);
  const [selectedPort, setSelectedPort] = useState<number | null>(null);
  const [showPortSelector, setShowPortSelector] = useState(false);
  const [showProfileManager, setShowProfileManager] = useState(false);
  const [showAboutDialog, setShowAboutDialog] = useState(false);

  const copyToClipboard = (text: string | null) => {
    if (text) {
      navigator.clipboard.writeText(text);
      toast.success("Copied to clipboard");
    }
  };

  useEffect(() => {
    if (error) toast.error(error);
  }, [error]);

  // トンネル新規起動時のみ自動でダイアログを表示（リロード時の復元では表示しない）
  useEffect(() => {
    if (tunnelJustStarted) {
      setShowTunnelDialog(true);
      clearTunnelJustStarted();
    }
  }, [tunnelJustStarted, clearTunnelJustStarted]);

  const handleRestartSession = useCallback(
    (sessionId: string) => {
      restartSessionWithProfile(sessionId);
    },
    [restartSessionWithProfile]
  );

  // 再起動完了通知 (旧ID→新ID) による選択追従。
  // サーバーは created(新) → restarted(旧→新) → stopped(旧) の順で emit する
  // ため、選択中セッションが sessions Map から消える前にこのハンドラで新IDへ
  // 付け替わる (= 消失フォールバックとの競合が起きない)。initiating tab /
  // 別タブの区別なくこの1経路で追従が完結するので、worktreePath ベースの
  // migration ヒューリスティックは持たない (pending 残留の温床だったため廃止)。
  // sessions 一覧の更新は session:stopped / session:created が担うので、
  // ここでは selectedSessionId の付け替えだけを行う。
  // 選択が "browser" 等の別対象に移っていた場合は付け替えない (prev 不一致)
  useEffect(() => {
    if (!socket) return;
    const handler = (data: {
      oldSessionId: string;
      session: ManagedSession;
    }) => {
      setSelectedSessionId(prev =>
        prev === data.oldSessionId ? data.session.id : prev
      );
    };
    socket.on("session:restarted", handler);
    return () => {
      socket.off("session:restarted", handler);
    };
  }, [socket]);

  // ユーザー操作によるセッション選択
  const handleSelectSession = useCallback((id: string | null) => {
    setSelectedSessionId(id);
  }, []);

  // セッション自動選択
  useEffect(() => {
    // ブラウザ選択中はリセットしない
    if (selectedSessionId === "browser") return;

    // グリッドビュー表示中は自動選択を抑制 (ユーザーがセルクリックで明示的に選ぶ)
    if (!selectedSessionId && sessions.size > 0 && !gridRepoPath) {
      const first = Array.from(sessions.values())[0];
      setSelectedSessionId(first.id);
    }
    // session:list を未受信のうちは dangling 判定をスキップ (savedId 復元保護)。
    // sessionsLoaded は空配列の session:list でも true になるため、
    // 「全セッション停止後にリロード」のケースでも savedId を null にリセットできる。
    if (
      sessionsLoaded &&
      selectedSessionId &&
      !sessions.has(selectedSessionId)
    ) {
      const remaining = Array.from(sessions.values());
      setSelectedSessionId(remaining.length > 0 ? remaining[0].id : null);
    }
  }, [sessions, sessionsLoaded, selectedSessionId, gridRepoPath]);

  useEffect(() => {
    if (deletedWorktreeId) {
      toast.success("Worktreeを削除しました");
      clearDeletedWorktreeId();
    }
  }, [deletedWorktreeId, clearDeletedWorktreeId]);

  const getSessionForWorktree = (worktreeId: string) => {
    return Array.from(sessions.values()).find(s => s.worktreeId === worktreeId);
  };

  const handleSelectRepo = (path: string) => {
    selectRepo(path);
    setIsSelectRepoOpen(false);
    // Drawer閉じアニメーション完了後にWorktree作成ダイアログを開く
    setTimeout(() => {
      setIsCreateWorktreeOpen(true);
    }, 350);
  };

  const handleCreateWorktree = (branchName: string, baseBranch?: string) => {
    createWorktree(branchName, baseBranch);
    setIsCreateWorktreeOpen(false);
    // 作成確定時は元repoへの復元をキャンセルし、作成先repoに留まる
    setPreviousRepoPath(null);
    toast.success(`Creating worktree: ${branchName}`);
  };

  const handleDeleteWorktree = (worktree: Worktree) => {
    if (worktree.isMain) {
      toast.error("Cannot delete the main worktree");
      return;
    }
    deleteWorktree(worktree.path);
    toast.info("Worktreeを削除中...");
  };

  const handleStartSession = (worktree: Worktree) => {
    const existingSession = getSessionForWorktree(worktree.id);
    if (existingSession) {
      setSelectedSessionId(existingSession.id);
      return;
    }
    startSession(worktree.id, worktree.path);
    toast.success("Session started");
  };

  /**
   * セッションを削除（統合アクション）
   * - セッションを停止
   * - 関連Worktreeがメイン以外なら削除
   * - 選択中セッションなら残りのセッションへフォーカスを移す
   */
  const handleDeleteSession = (
    sessionId: string,
    worktree: Worktree | undefined
  ) => {
    stopSession(sessionId);
    // server側の session:stop ハンドラが !isMain のworktreeを自動削除するため、
    // クライアント側で deleteWorktree を呼ぶと重複リクエストになる。
    // 選択セッションの切り替えは sessions 変化を検出する useEffect に任せる
    // （削除失敗時に optimistic update で別セッションへ誤遷移するのを防ぐため）。
    if (worktree && !worktree.isMain) {
      toast.success("セッションを削除しました");
    } else {
      toast.info("セッションを停止しました");
    }
  };

  const handleNewSession = () => {
    // まずリポジトリ選択（なければスキャン、あれば選択→worktree作成へ）
    setIsSelectRepoOpen(true);
  };

  /**
   * 既存リポジトリの右クリック / +ボタンから直接Worktree作成。
   * server側の worktree:list 配信が repoを問わず worktrees stateを上書きするため、
   * 作成前にrepoPathを切り替えておく必要がある。
   * キャンセル時は元のrepoに戻すため previousRepoPath を保存しておく。
   */
  const handleCreateWorktreeForRepo = (path: string) => {
    if (repoPath === null) {
      // 未選択状態からの+クリック: 単純選択として扱う（復元なし）
      selectRepo(path);
      setTimeout(() => {
        setIsCreateWorktreeOpen(true);
      }, 50);
      return;
    }
    if (repoPath !== path) {
      setPreviousRepoPath(repoPath);
      selectRepo(path);
      // selectRepo の反映を待ってから作成ダイアログを開く
      setTimeout(() => {
        setIsCreateWorktreeOpen(true);
      }, 50);
    } else {
      setIsCreateWorktreeOpen(true);
    }
  };

  /** Worktree作成ダイアログの open/close ハンドラ。close時にrepo復元する */
  const handleCreateWorktreeOpenChange = (open: boolean) => {
    setIsCreateWorktreeOpen(open);
    if (!open && previousRepoPath !== null) {
      selectRepo(previousRepoPath);
      setPreviousRepoPath(null);
    }
  };

  /**
   * リポジトリをサイドバーから除外する。
   * 現在選択中のrepoを除外する場合、残りrepoListの先頭に切り替えてから除外することで
   * 他repoのworktree表示（repoPath選択でのみフェッチされる）が連鎖的に消えないようにする。
   */
  const handleRemoveRepo = (path: string) => {
    if (repoPath === path) {
      const remaining = repoList.filter(p => p !== path);
      if (remaining.length > 0) {
        selectRepo(remaining[0]);
      }
    }
    removeRepo(path);
  };

  return (
    <>
      {/* F8: 更新通知バナー (Electron 経由のみ。ブラウザ版では何もレンダリングしない) */}
      <UpdateBanner />
      {isMobile ? (
        <MobileLayout
          socket={socket}
          sessions={sessions}
          worktrees={worktrees}
          repoList={repoList}
          repoPath={repoPath}
          onStartSession={handleStartSession}
          onDeleteSession={handleDeleteSession}
          onRestartSession={handleRestartSession}
          onDeleteWorktree={handleDeleteWorktree}
          onSendMessage={sendMessage}
          onSendKey={sendKey}
          onSelectSession={handleSelectSession}
          onUploadFile={uploadFile}
          onCopyBuffer={copyBuffer}
          onNewSession={handleNewSession}
          getTabsForSession={getTabsForSession}
          getActiveTabForSession={getActiveTabForSession}
          handleTabSelect={handleTabSelect}
          handleTabClose={handleTabClose}
          openDiagramTab={openDiagramTab}
          diagramOpenRequest={diagramOpenRequest}
          listDiagrams={listDiagrams}
          deleteDiagram={deleteDiagram}
          getDiagramComments={getDiagramComments}
          createDiagramComment={createDiagramComment}
          replyDiagramComment={replyDiagramComment}
          resolveDiagramComment={resolveDiagramComment}
          deleteDiagramComment={deleteDiagramComment}
          sendDiagramComment={sendDiagramComment}
          isSocketConnected={isConnected}
          diagramCommentsUpdate={diagramCommentsUpdate}
          activeBrowserSession={activeBrowserSession}
          onSelectBrowser={handleSelectBrowser}
          isRemote={isRemote}
          messageShortcuts={messageShortcuts}
          onCreateShortcut={createShortcut}
          onUpdateShortcut={updateShortcut}
          onDeleteShortcut={deleteShortcut}
          selectedSessionId={selectedSessionId}
          activeTab={mobileActiveTab}
          sessionSubView={mobileSessionSubView}
          onChangeActiveTab={setMobileActiveTab}
          onChangeSessionSubView={setMobileSessionSubView}
          sessionsLoaded={sessionsLoaded}
          sessionStatuses={sessionStatuses}
          sessionAwaitingTexts={sessionAwaitingTexts}
          notificationControl={notificationControl}
          notificationsSupported={sessionNotifications.supported}
          isSessionNotificationEnabled={isSessionNotificationEnabled}
          onSessionNotificationEnabledChange={
            handleSessionNotificationEnabledChange
          }
        />
      ) : (
        <SidebarMainLayout
          sidebar={
            <SessionSidebar
              sessions={sessions}
              worktrees={worktrees}
              repoList={repoList}
              selectedSessionId={selectedSessionId}
              sessionPreviews={sessionPreviews}
              sessionActivityTexts={sessionActivityTexts}
              onSelectSession={handleSelectSession}
              onDeleteSession={handleDeleteSession}
              onStartSession={handleStartSession}
              onNewSession={handleNewSession}
              onRemoveRepo={handleRemoveRepo}
              onSelectBrowser={handleSelectBrowser}
              isBrowserSelected={selectedSessionId === "browser"}
              isRemote={isRemote}
              profiles={profiles}
              repoProfileLinks={repoProfileLinks}
              worktreeProfileLinks={worktreeProfileLinks}
              capabilities={capabilities}
              onSetRepoProfile={setRepoProfile}
              onSetWorktreeProfile={setWorktreeProfile}
              worktreeDisplayNames={worktreeDisplayNames}
              onSetWorktreeDisplayName={setWorktreeDisplayName}
              onOpenProfileManager={() => setShowProfileManager(true)}
              onRestartSession={handleRestartSession}
              onCreateWorktreeForRepo={handleCreateWorktreeForRepo}
              onSelectRepoGrid={handleSelectRepoGrid}
              gridRepoPath={gridRepoPath}
              gridStatuses={sessionStatuses}
              notificationControl={notificationControl}
              notificationsSupported={sessionNotifications.supported}
              isSessionNotificationEnabled={isSessionNotificationEnabled}
              onSessionNotificationEnabledChange={
                handleSessionNotificationEnabledChange
              }
            />
          }
          main={
            <div className="h-full flex flex-col">
              {!isConnected && (
                <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 flex items-center gap-2 text-destructive text-sm shrink-0">
                  <AlertCircle className="w-4 h-4" />
                  <span>Not connected to server</span>
                </div>
              )}
              <div className="flex-1 overflow-hidden relative">
                {/* リポジトリグリッドビュー: gridRepoPath が設定されているとき
                    全 TerminalPane と独立して表示する (ttyd iframe は非マウント) */}
                {gridRepoPath && !selectedSessionId ? (
                  <RepoGridView
                    repoPath={gridRepoPath}
                    sessions={Array.from(sessions.values()).filter(s => {
                      // useGroupedWorktreeItems と同じフォールバック判定:
                      //  1. session.repoPath が gridRepoPath に一致
                      //  2. worktreePath が gridRepoPath で始まる (worktree)
                      //  3. isSessionBelongsToRepo で姉妹worktreeを判定
                      if (s.repoPath === gridRepoPath) return true;
                      if (s.worktreePath.startsWith(`${gridRepoPath}/`))
                        return true;
                      if (s.worktreePath === gridRepoPath) return true;
                      return isSessionBelongsToRepo(s, gridRepoPath);
                    })}
                    worktreeBranchById={
                      new Map(worktrees.map(w => [w.id, w.branch]))
                    }
                    snapshots={gridSnapshots}
                    onSubscribe={subscribeGrid}
                    onUnsubscribe={unsubscribeGrid}
                    onSelectSession={handleSelectSessionFromGrid}
                  />
                ) : null}
                {/* ブラウザビュー: 一度開いたら常に描画してdisplay:hiddenで切り替え。
                    BrowserPaneの再マウント（VNC再接続）を防ぐ */}
                {hasBrowserOpened && (
                  <div
                    className={
                      selectedSessionId === "browser" ? "h-full" : "hidden"
                    }
                  >
                    {activeBrowserSession ? (
                      <BrowserPane browserSession={activeBrowserSession} />
                    ) : (
                      <div className="h-full flex items-center justify-center text-muted-foreground">
                        <Loader2 className="h-6 w-6 animate-spin mr-2" />
                        ブラウザを起動中...
                      </div>
                    )}
                  </div>
                )}
                {Array.from(sessions.values()).map(session => {
                  const isActive = selectedSessionId === session.id;
                  const wt = worktrees.find(w => w.id === session.worktreeId);
                  const rn = (() => {
                    if (repoList.length === 0) return undefined;
                    const repo = findRepoForSession(session, repoList);
                    return repo ? getBaseName(repo) : undefined;
                  })();
                  const paneProps = {
                    session,
                    worktree: wt,
                    repoName: rn,
                    tabs: getTabsForSession(session.id),
                    activeTabIndex: getActiveTabForSession(session.id),
                    onTabSelect: (idx: number) =>
                      handleTabSelect(session.id, idx),
                    onTabClose: (idx: number) =>
                      handleTabClose(session.id, idx),
                    onSelectDiagram: (relPath: string, worktreePath: string) =>
                      openDiagramTab(session.id, worktreePath, relPath),
                    onSendMessage: (msg: string) =>
                      sendMessage(session.id, msg),
                    onSendKey: (key: SpecialKey) => sendKey(session.id, key),
                    onDeleteSession: () => handleDeleteSession(session.id, wt),
                    onUploadFile: (data: {
                      base64Data: string;
                      mimeType: string;
                      originalFilename?: string;
                    }) => uploadFile({ sessionId: session.id, ...data }),
                    onCopyBuffer: copyBuffer
                      ? () => copyBuffer(session.id)
                      : undefined,
                    messageShortcuts,
                    onCreateShortcut: createShortcut,
                    onUpdateShortcut: updateShortcut,
                    onDeleteShortcut: deleteShortcut,
                  };
                  return (
                    <div
                      key={session.id}
                      className={isActive ? "h-full flex flex-col" : "hidden"}
                    >
                      <SplitViewPane
                        socket={socket}
                        isConnected={isConnected}
                        diagramCommentsUpdate={diagramCommentsUpdate}
                        listDiagrams={listDiagrams}
                        deleteDiagram={deleteDiagram}
                        getDiagramComments={getDiagramComments}
                        createDiagramComment={createDiagramComment}
                        replyDiagramComment={replyDiagramComment}
                        resolveDiagramComment={resolveDiagramComment}
                        deleteDiagramComment={deleteDiagramComment}
                        sendDiagramComment={sendDiagramComment}
                        {...paneProps}
                      />
                    </div>
                  );
                })}
                {sessions.size === 0 && (
                  <div className="h-full flex items-center justify-center">
                    <div className="text-center">
                      <Terminal className="w-12 h-12 text-muted-foreground/50 mx-auto mb-4" />
                      <p className="text-muted-foreground">
                        サイドバーの「+」からセッションを作成
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          }
          initialSidebarWidth={getSetting<number>("ark-sidebar-width", 250)}
          onSidebarWidthChange={w => setSetting("ark-sidebar-width", w)}
          onOpenAboutDialog={() => setShowAboutDialog(true)}
          hostMetrics={bridgeSnapshot?.metrics ?? null}
        />
      )}

      {/* ダイアログ群はレイアウトの外にポータル表示されるが、DOM上の配置はここ */}
      {/* ポート選択ダイアログ */}
      <Dialog open={showPortSelector} onOpenChange={setShowPortSelector}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Quick Tunnel</DialogTitle>
            <DialogDescription>
              公開するポートを選択してください
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Port</Label>
              <Select
                value={selectedPort?.toString() ?? ""}
                onValueChange={v => setSelectedPort(Number(v))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="ポートを選択..." />
                </SelectTrigger>
                <SelectContent>
                  {listeningPorts.map(p => (
                    <SelectItem key={p.port} value={p.port.toString()}>
                      {p.port} ({p.process})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>またはポート番号を入力</Label>
              <Input
                type="number"
                placeholder="3000"
                value={selectedPort ?? ""}
                onChange={e =>
                  setSelectedPort(
                    e.target.value ? Number(e.target.value) : null
                  )
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowPortSelector(false)}
            >
              キャンセル
            </Button>
            <Button
              onClick={() => {
                if (selectedPort) {
                  startTunnel(selectedPort);
                  setShowPortSelector(false);
                }
              }}
              disabled={!selectedPort || tunnelLoading}
            >
              {tunnelLoading ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Start Tunnel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Quick Tunnel Dialog */}
      <Dialog open={showTunnelDialog} onOpenChange={setShowTunnelDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Quick Tunnel</DialogTitle>
            <DialogDescription>
              外部からアクセスするためのURLです
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-sm font-medium">URL</Label>
              <div className="flex items-center gap-2">
                <a
                  href={tunnelUrl ?? "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 text-sm font-mono text-primary hover:underline truncate"
                  title={tunnelUrl ?? ""}
                >
                  {tunnelUrl ? new URL(tunnelUrl).hostname : ""}
                </a>
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => copyToClipboard(tunnelUrl)}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
            {tunnelUrl && (
              <div className="flex justify-center py-4">
                <div className="p-4 bg-white rounded-lg">
                  <QRCodeSVG value={tunnelUrl} size={200} />
                </div>
              </div>
            )}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Auth Token</Label>
              <div className="flex gap-2">
                <Input
                  value={tunnelToken ?? ""}
                  readOnly
                  type="password"
                  className="font-mono text-sm"
                />
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => copyToClipboard(tunnelToken)}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="destructive"
              onClick={() => {
                stopTunnel();
                setShowTunnelDialog(false);
              }}
              disabled={tunnelLoading}
            >
              {tunnelLoading ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Stop Tunnel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* リポジトリ選択ダイアログ */}
      <RepoSelectDialog
        isOpen={isSelectRepoOpen}
        onOpenChange={setIsSelectRepoOpen}
        allowedRepos={allowedRepos}
        scannedRepos={scannedRepos}
        isScanning={isScanning}
        onScanRepos={scanRepos}
        onSelectRepo={handleSelectRepo}
        listDirectory={listDirectory}
        initialScanBasePath={savedScanBasePath}
      />

      {/* Worktree作成ダイアログ */}
      <CreateWorktreeDialog
        open={isCreateWorktreeOpen}
        onOpenChange={handleCreateWorktreeOpenChange}
        selectedRepoPath={repoPath}
        onCreateWorktree={handleCreateWorktree}
      />

      {/* プロファイル管理 (Linux限定) */}
      {capabilities.multiProfileSupported && (
        <ProfileManagerDialog
          open={showProfileManager}
          onOpenChange={setShowProfileManager}
          profiles={profiles}
          onCreate={createProfile}
          onUpdate={updateProfile}
          onDelete={deleteProfile}
        />
      )}

      {/* About Ark (同梱バイナリ LICENSE 一覧) */}
      <AboutDialog open={showAboutDialog} onOpenChange={setShowAboutDialog} />
    </>
  );
}
