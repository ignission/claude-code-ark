import { AlertCircle, Copy, Loader2, Terminal } from "lucide-react";
import { BrowserPane } from "@/components/BrowserPane";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CreateWorktreeDialog } from "@/components/CreateWorktreeDialog";
import { MobileChatView } from "@/components/MobileChatView";
import { MobileLayout } from "@/components/MobileLayout";
import { RepoSelectDialog } from "@/components/RepoSelectDialog";
import { SessionSidebar } from "@/components/SessionSidebar";
import { SidebarMainLayout } from "@/components/SidebarMainLayout";
import { TerminalPane } from "@/components/TerminalPane";
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
import { useIsMobile } from "@/hooks/useMobile";
import { useSettings } from "@/hooks/useSettings";
import { useSocket } from "@/hooks/useSocket";
import { useViewerTabs } from "@/hooks/useViewerTabs";
import { getBaseName } from "@/utils/pathUtils";
import { findRepoForSession } from "@/utils/sessionUtils";
import type { Worktree } from "../../../shared/types";

export default function Dashboard() {
  const {
    isLoading: isSettingsLoading,
    getSetting,
    setSetting,
  } = useSettings();

  const savedRepoList = getSetting<string[]>("repoList", []);
  const savedRepoPath = getSetting<string | null>("selectedRepoPath", null);

  const {
    socket,
    isConnected,
    error,
    repoList,
    repoPath,
    selectRepo,
    scannedRepos,
    isScanning,
    scanRepos,
    worktrees,
    createWorktree,
    deleteWorktree,
    sessions,
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
    uploadImage,
    imageUploadResult,
    imageUploadError,
    clearImageUploadState,
    copyBuffer,
    deletedWorktreeId,
    clearDeletedWorktreeId,
    beaconMessages,
    beaconStreaming,
    beaconStreamText,
    beaconSend,
    beaconLoadHistory,
    beaconClear,
    sessionPreviews,
    sessionActivityTexts,
    readFile,
    fileContent,
    browserSessions,
    startBrowser,
    stopBrowser,
  } = useSocket({
    enabled: !isSettingsLoading,
    initialRepoList: savedRepoList,
    initialRepoPath: savedRepoPath,
    onRepoListChange: list => setSetting("repoList", list),
    onRepoPathChange: path => setSetting("selectedRepoPath", path),
  });

  const isMobile = useIsMobile();

  const isRemote =
    typeof window !== "undefined" &&
    window.location.hostname !== "localhost" &&
    window.location.hostname !== "127.0.0.1";

  const [showBrowser, setShowBrowser] = useState(false);
  const activeBrowserSession = Array.from(browserSessions.values())[0] ?? null;

  const handleToggleBrowser = () => {
    if (activeBrowserSession) {
      stopBrowser(activeBrowserSession.id);
      setShowBrowser(false);
    } else {
      startBrowser();
      setShowBrowser(true);
    }
  };

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );

  const {
    getTabsForSession,
    getActiveTabForSession,
    handleTabSelect,
    handleTabClose,
  } = useViewerTabs(selectedSessionId, sessions, readFile, fileContent);

  // サーバーからの設定が読み込まれたらセッションIDを復元
  const settingsInitializedRef = useRef(false);
  useEffect(() => {
    if (!isSettingsLoading && !settingsInitializedRef.current) {
      settingsInitializedRef.current = true;
      setSelectedSessionId(
        getSetting<string | null>("selectedSessionId", null)
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

  const [isCreateWorktreeOpen, setIsCreateWorktreeOpen] = useState(false);
  const [isSelectRepoOpen, setIsSelectRepoOpen] = useState(false);
  const [showTunnelDialog, setShowTunnelDialog] = useState(false);
  const [selectedPort, setSelectedPort] = useState<number | null>(null);
  const [showPortSelector, setShowPortSelector] = useState(false);

  const copyToClipboard = (text: string | null) => {
    if (text) {
      navigator.clipboard.writeText(text);
      toast.success("Copied to clipboard");
    }
  };

  useEffect(() => {
    if (error) toast.error(error);
  }, [error]);

  // Beacon履歴をマウント時に読み込む
  useEffect(() => {
    beaconLoadHistory();
  }, [beaconLoadHistory]);

  // トンネル新規起動時のみ自動でダイアログを表示（リロード時の復元では表示しない）
  useEffect(() => {
    if (tunnelJustStarted) {
      setShowTunnelDialog(true);
      clearTunnelJustStarted();
    }
  }, [tunnelJustStarted, clearTunnelJustStarted]);

  // セッション自動選択
  useEffect(() => {
    if (!selectedSessionId && sessions.size > 0) {
      const first = Array.from(sessions.values())[0];
      setSelectedSessionId(first.id);
    }
    if (selectedSessionId && !sessions.has(selectedSessionId)) {
      const remaining = Array.from(sessions.values());
      setSelectedSessionId(remaining.length > 0 ? remaining[0].id : null);
    }
  }, [sessions, selectedSessionId]);

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

  const handleStopSession = (sessionId: string) => {
    stopSession(sessionId);
    if (selectedSessionId === sessionId) {
      const remaining = Array.from(sessions.values()).filter(
        s => s.id !== sessionId
      );
      setSelectedSessionId(remaining.length > 0 ? remaining[0].id : null);
    }
    toast.info("Session stopped");
  };

  const handleNewSession = () => {
    // まずリポジトリ選択（なければスキャン、あれば選択→worktree作成へ）
    setIsSelectRepoOpen(true);
  };

  return (
    <>
      {isMobile ? (
        <MobileLayout
          socket={socket}
          sessions={sessions}
          worktrees={worktrees}
          repoList={repoList}
          repoPath={repoPath}
          onStartSession={handleStartSession}
          onStopSession={handleStopSession}
          onDeleteWorktree={handleDeleteWorktree}
          onSendMessage={sendMessage}
          onSendKey={sendKey}
          onSelectSession={sessionId => setSelectedSessionId(sessionId)}
          onUploadImage={uploadImage}
          imageUploadResult={imageUploadResult}
          imageUploadError={imageUploadError}
          onClearImageUploadState={clearImageUploadState}
          onCopyBuffer={copyBuffer}
          onNewSession={handleNewSession}
          readFile={readFile}
          fileContent={fileContent}
          beaconMessages={beaconMessages}
          beaconStreaming={beaconStreaming}
          beaconStreamText={beaconStreamText}
          onBeaconSend={beaconSend}
          onBeaconClear={beaconClear}
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
              onSelectSession={setSelectedSessionId}
              onStopSession={handleStopSession}
              onStartSession={handleStartSession}
              onNewSession={handleNewSession}
              onToggleBrowser={handleToggleBrowser}
              isBrowserActive={!!activeBrowserSession}
              isRemote={isRemote}
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
                {showBrowser && activeBrowserSession && (
                  <div className="h-full">
                    <BrowserPane browserSession={activeBrowserSession} />
                  </div>
                )}
                {(!showBrowser || !activeBrowserSession) &&
                  Array.from(sessions.values()).map(session => {
                    const isActive = selectedSessionId === session.id;
                    const wt = worktrees.find(w => w.id === session.worktreeId);
                    const rn = (() => {
                      if (repoList.length === 0) return undefined;
                      const repo = findRepoForSession(session, repoList);
                      return repo ? getBaseName(repo) : undefined;
                    })();
                    return (
                      <div
                        key={session.id}
                        className={isActive ? "h-full flex flex-col" : "hidden"}
                      >
                        <TerminalPane
                          session={session}
                          worktree={wt}
                          repoName={rn}
                          tabs={getTabsForSession(session.id)}
                          activeTabIndex={getActiveTabForSession(session.id)}
                          onTabSelect={idx => handleTabSelect(session.id, idx)}
                          onTabClose={idx => handleTabClose(session.id, idx)}
                          onSendMessage={msg => sendMessage(session.id, msg)}
                          onSendKey={key => sendKey(session.id, key)}
                          onStopSession={() => handleStopSession(session.id)}
                          onUploadImage={(base64, mimeType) =>
                            uploadImage(session.id, base64, mimeType)
                          }
                          imageUploadResult={imageUploadResult}
                          imageUploadError={imageUploadError}
                          onClearImageUploadState={clearImageUploadState}
                          onCopyBuffer={
                            copyBuffer
                              ? () => copyBuffer(session.id)
                              : undefined
                          }
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
          beacon={
            <MobileChatView
              messages={beaconMessages}
              isStreaming={beaconStreaming}
              streamingText={beaconStreamText}
              onSendMessage={beaconSend}
              onClear={beaconClear}
            />
          }
          initialSidebarWidth={getSetting<number>("ark-sidebar-width", 250)}
          onSidebarWidthChange={w => setSetting("ark-sidebar-width", w)}
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
        scannedRepos={scannedRepos}
        isScanning={isScanning}
        onScanRepos={scanRepos}
        onSelectRepo={handleSelectRepo}
      />

      {/* Worktree作成ダイアログ */}
      <CreateWorktreeDialog
        open={isCreateWorktreeOpen}
        onOpenChange={setIsCreateWorktreeOpen}
        selectedRepoPath={repoPath}
        onCreateWorktree={handleCreateWorktree}
      />
    </>
  );
}
