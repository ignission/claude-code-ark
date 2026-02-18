import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { QRCodeSVG } from "qrcode.react";
import {
  GitBranch,
  Plus,
  FolderOpen,
  Play,
  Square,
  Trash2,
  MessageSquare,
  Terminal,
  Settings,
  Wifi,
  WifiOff,
  RefreshCw,
  AlertCircle,
  LayoutGrid,
  Columns2,
  Menu,
  Globe,
  Copy,
  Loader2,
} from "lucide-react";
import { useIsMobile } from "@/hooks/useMobile";
import { toast } from "sonner";
import { useSocket } from "@/hooks/useSocket";
import { MultiPaneLayout } from "@/components/MultiPaneLayout";
import { SessionDashboard } from "@/components/SessionDashboard";
import { RepoSelectDialog } from "@/components/RepoSelectDialog";
import { CreateWorktreeDialog } from "@/components/CreateWorktreeDialog";
import { isSessionBelongsToRepo, findRepoForSession } from "@/utils/sessionUtils";
import { getBaseName } from "@/utils/pathUtils";
import type { Worktree, ManagedSession } from "../../../shared/types";

type ViewMode = "dashboard" | "panes";

// サイドバーの幅の定数
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 400;
const SIDEBAR_DEFAULT_WIDTH = 320;
const SIDEBAR_WIDTH_STORAGE_KEY = "sidebar-width";

export default function Dashboard() {
  const {
    isConnected,
    error,
    allowedRepos,
    repoList,
    repoPath,
    selectRepo,
    removeRepo,
    scannedRepos,
    isScanning,
    scanRepos,
    worktrees,
    createWorktree,
    deleteWorktree,
    refreshWorktrees,
    sessions,
    startSession,
    stopSession,
    sendMessage,
    sendKey,
    tunnelActive,
    tunnelUrl,
    tunnelToken,
    tunnelLoading,
    startTunnel,
    stopTunnel,
    listeningPorts,
    scanPorts,
    uploadImage,
    imageUploadResult,
    imageUploadError,
    clearImageUploadState,
    copyBuffer,
  } = useSocket();

  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // サイドバーのリサイズ機能
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (saved) {
      const parsed = parseInt(saved, 10);
      if (!isNaN(parsed) && parsed >= SIDEBAR_MIN_WIDTH && parsed <= SIDEBAR_MAX_WIDTH) {
        return parsed;
      }
    }
    return SIDEBAR_DEFAULT_WIDTH;
  });
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);

  // リサイズ開始
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  // リサイズ中のマウス移動処理
  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, e.clientX));
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, sidebarWidth.toString());
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, sidebarWidth]);

  const [viewMode, setViewMode] = useState<ViewMode>("dashboard");
  const [activePanesPerRepo, setActivePanesPerRepo] = useState<Map<string, string[]>>(new Map());
  const [maximizedPane, setMaximizedPane] = useState<string | null>(null);

  // ユーザーが意図的に閉じたペインを追跡（useEffectによる再追加を防ぐ）
  const closedPanesRef = useRef<Set<string>>(new Set());

  // 現在のリポジトリのactivePanesを取得
  const activePanes = repoPath ? (activePanesPerRepo.get(repoPath) || []) : [];

  // activePanesを更新するヘルパー関数
  const setActivePanes = (updater: string[] | ((prev: string[]) => string[])) => {
    if (!repoPath) return;
    setActivePanesPerRepo((prev) => {
      const newMap = new Map(prev);
      const currentPanes = newMap.get(repoPath) || [];
      const newPanes = typeof updater === 'function' ? updater(currentPanes) : updater;
      newMap.set(repoPath, newPanes);
      return newMap;
    });
  };
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(null);
  const [isCreateWorktreeOpen, setIsCreateWorktreeOpen] = useState(false);
  const [isSelectRepoOpen, setIsSelectRepoOpen] = useState(false);
  const [showTunnelDialog, setShowTunnelDialog] = useState(false);
  const [selectedPort, setSelectedPort] = useState<number | null>(null);
  const [showPortSelector, setShowPortSelector] = useState(false);
  const prevTunnelActive = useRef(false);

  const copyToClipboard = (text: string | null) => {
    if (text) {
      navigator.clipboard.writeText(text);
      toast.success("Copied to clipboard");
    }
  };

  useEffect(() => {
    if (error) toast.error(error);
  }, [error]);

  // トンネル接続成功時に自動でダイアログを表示
  useEffect(() => {
    if (tunnelActive && tunnelUrl && !prevTunnelActive.current) {
      setShowTunnelDialog(true);
    }
    prevTunnelActive.current = tunnelActive;
  }, [tunnelActive, tunnelUrl]);

  useEffect(() => {
    setMaximizedPane(null);
    setSelectedWorktreeId(null);
    const currentPanes = repoPath ? (activePanesPerRepo.get(repoPath) || []) : [];
    setViewMode(currentPanes.length > 0 ? "panes" : "dashboard");
  }, [repoPath, activePanesPerRepo]);

  const getSessionForWorktree = (worktreeId: string): ManagedSession | undefined => {
    return Array.from(sessions.values()).find((s) => s.worktreeId === worktreeId);
  };

  const handleSelectRepo = (path: string) => {
    selectRepo(path);
    setIsSelectRepoOpen(false);
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
    toast.success("Worktree deleted");
  };

  const handleStartSession = (worktree: Worktree) => {
    const existingSession = getSessionForWorktree(worktree.id);
    if (existingSession) {
      // ユーザーが明示的に開くので、closedPanesから除外
      closedPanesRef.current.delete(existingSession.id);
      // Add to active panes if not already there
      if (!activePanes.includes(existingSession.id)) {
        setActivePanes((prev) => [...prev, existingSession.id]);
        toast.warning("このWorktreeには既にセッションが存在するため、既存セッションを開きます");
      }
      setViewMode("panes");
      return;
    }
    startSession(worktree.id, worktree.path);
    toast.success("Session started");
  };

  const handleStopSession = (sessionId: string) => {
    stopSession(sessionId);
    setActivePanes((prev) => prev.filter((id) => id !== sessionId));
    if (maximizedPane === sessionId) {
      setMaximizedPane(null);
    }
    toast.info("Session stopped");
  };

  const handleSelectSession = (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) return;

    // ユーザーが明示的に開くので、closedPanesから除外
    closedPanesRef.current.delete(sessionId);

    // セッションが属するリポジトリを特定
    const targetRepo = findRepoForSession(session, repoList);
    if (targetRepo && targetRepo !== repoPath) {
      // 別リポジトリの場合は切り替え
      selectRepo(targetRepo);
    }

    // activePanesPerRepoを直接更新（リポジトリ切り替え後でも正しく動作するように）
    const targetRepoPath = targetRepo || repoPath;
    if (targetRepoPath) {
      setActivePanesPerRepo((prev) => {
        const newMap = new Map(prev);
        const currentPanes = newMap.get(targetRepoPath) || [];
        if (!currentPanes.includes(sessionId)) {
          newMap.set(targetRepoPath, [...currentPanes, sessionId]);
        }
        return newMap;
      });
    }

    setViewMode("panes");
  };

  const handleClosePane = (sessionId: string) => {
    // ユーザーが意図的に閉じたペインとして記録
    closedPanesRef.current.add(sessionId);
    setActivePanes((prev) => prev.filter((id) => id !== sessionId));
    if (maximizedPane === sessionId) {
      setMaximizedPane(null);
    }
  };

  const handleMaximizePane = (sessionId: string) => {
    setMaximizedPane(maximizedPane === sessionId ? null : sessionId);
  };


  useEffect(() => {
    if (!repoPath) return;
    sessions.forEach((session, sessionId) => {
      // ユーザーが意図的に閉じたペインは再追加しない
      if (closedPanesRef.current.has(sessionId)) return;
      if (isSessionBelongsToRepo(session, repoPath)) {
        setActivePanes((prev) => {
          if (prev.includes(sessionId)) return prev;
          return [...prev, sessionId];
        });
        setViewMode("panes");
      }
    });
  }, [sessions, repoPath]);

  // 現在のリポジトリに属し、かつ存在するセッションのみをフィルタ
  const { filteredSessions, validActivePanes } = useMemo(() => {
    const filtered = new Map(
      Array.from(sessions.entries()).filter(([sessionId, session]) =>
        repoPath && isSessionBelongsToRepo(session, repoPath) && activePanes.includes(sessionId)
      )
    );
    const valid = activePanes.filter((id) => filtered.has(id));
    return { filteredSessions: filtered, validActivePanes: valid };
  }, [sessions, repoPath, activePanes]);

  const SidebarContent = () => (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="p-4 border-b border-sidebar-border">
        <div className="flex items-center justify-between mb-2">
          <Label className="text-xs text-muted-foreground uppercase tracking-wider">Repositories</Label>
          {allowedRepos.length > 0 ? (
            <Select onValueChange={selectRepo} value={repoPath || undefined}>
              <SelectTrigger className="w-auto h-8 text-xs gap-1">
                <Plus className="w-3 h-3" />
              </SelectTrigger>
              <SelectContent>
                {allowedRepos.map((repo) => (
                  <SelectItem key={repo} value={repo} className="font-mono text-xs">
                    {getBaseName(repo)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setIsSelectRepoOpen(true)}
            >
              <FolderOpen className="w-4 h-4" />
            </Button>
          )}
        </div>

        <div className="max-h-[200px] overflow-y-auto">
          {repoList.length > 0 ? (
            <div className="space-y-1">
              {repoList.map((repo) => {
                const isSelected = repo === repoPath;
                const repoName = getBaseName(repo);
                return (
                  <div
                    key={repo}
                    className={`group flex items-center gap-2 p-2 rounded-md cursor-pointer transition-colors ${
                      isSelected
                        ? "bg-primary/20 border border-primary/30"
                        : "hover:bg-sidebar-accent"
                    }`}
                    onClick={() => selectRepo(repo)}
                  >
                    <FolderOpen className={`w-4 h-4 shrink-0 ${isSelected ? "text-primary" : "text-muted-foreground"}`} />
                    <div className="flex-1 min-w-0">
                      <div className={`text-sm font-medium truncate ${isSelected ? "text-primary" : "text-sidebar-foreground"}`}>
                        {repoName}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {isSelected && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={(e) => {
                            e.stopPropagation();
                            refreshWorktrees();
                          }}
                        >
                          <RefreshCw className="w-3 h-3" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeRepo(repo);
                        }}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground text-center py-4">
              リポジトリを追加してください
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="p-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GitBranch className="w-5 h-5 md:w-4 md:h-4 text-muted-foreground" />
            <span className="text-base md:text-sm font-medium text-sidebar-foreground">Worktrees</span>
            <span className="text-sm md:text-xs text-muted-foreground">({worktrees.length})</span>
          </div>
          <CreateWorktreeDialog
            open={isCreateWorktreeOpen}
            onOpenChange={setIsCreateWorktreeOpen}
            selectedRepoPath={repoPath}
            onCreateWorktree={handleCreateWorktree}
          />
        </div>

        <ScrollArea className="flex-1 px-2">
          <div className="space-y-1 pb-4">
            {worktrees.length === 0 && repoPath && (
              <div className="p-4 text-center text-muted-foreground text-base md:text-sm">
                No worktrees found
              </div>
            )}
            {!repoPath && (
              <div className="p-4 text-center text-muted-foreground text-base md:text-sm">
                Select a repository to view worktrees
              </div>
            )}
            {worktrees.map((worktree) => {
              const session = getSessionForWorktree(worktree.id);
              const isSelected = selectedWorktreeId === worktree.id;
              const isInPane = session && activePanes.includes(session.id);

              return (
                <div
                  key={worktree.id}
                  className={`group p-4 md:p-3 rounded-lg cursor-pointer transition-all ${
                    isInPane
                      ? "bg-sidebar-accent border border-primary/30"
                      : isSelected
                      ? "bg-sidebar-accent"
                      : "hover:bg-sidebar-accent/50 active:bg-sidebar-accent/70"
                  }`}
                  onClick={() => {
                    setSelectedWorktreeId(worktree.id);
                    handleStartSession(worktree);
                    if (isMobile) setSidebarOpen(false);
                  }}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      {session && (
                        <div
                          className={`status-indicator ${session.status}`}
                          title={session.status}
                        />
                      )}
                      <GitBranch className="w-5 h-5 md:w-4 md:h-4 text-muted-foreground shrink-0" />
                      <span className="text-base md:text-sm font-mono truncate text-sidebar-foreground">
                        {worktree.branch}
                      </span>
                      {worktree.isMain && (
                        <span className="text-xs md:text-[10px] px-1.5 py-0.5 rounded bg-primary/20 text-primary uppercase">
                          main
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {session ? (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-10 w-10 md:h-6 md:w-6"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSelectSession(session.id);
                              if (isMobile) setSidebarOpen(false);
                            }}
                          >
                            <MessageSquare className="w-5 h-5 md:w-3 md:h-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-10 w-10 md:h-6 md:w-6 text-destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleStopSession(session.id);
                            }}
                          >
                            <Square className="w-5 h-5 md:w-3 md:h-3" />
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-10 w-10 md:h-6 md:w-6 text-primary"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStartSession(worktree);
                            if (isMobile) setSidebarOpen(false);
                          }}
                        >
                          <Play className="w-5 h-5 md:w-3 md:h-3" />
                        </Button>
                      )}
                      {!worktree.isMain && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-10 w-10 md:h-6 md:w-6 text-destructive"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Trash2 className="w-5 h-5 md:w-3 md:h-3" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent className="bg-card border-border w-[calc(100%-2rem)] max-w-md mx-auto">
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete Worktree</AlertDialogTitle>
                              <AlertDialogDescription>
                                Are you sure you want to delete this worktree? This will also delete the associated branch.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
                              <AlertDialogCancel className="h-12 md:h-10">Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90 h-12 md:h-10"
                                onClick={() => handleDeleteWorktree(worktree)}
                              >
                                Delete
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </div>

      <div className="p-4 border-t border-sidebar-border space-y-2">
        <Button
          variant={tunnelActive ? "default" : "outline"}
          className="w-full justify-start gap-2 h-12 md:h-10 text-base md:text-sm"
          onClick={() => {
            if (tunnelActive) {
              setShowTunnelDialog(true);
            } else {
              scanPorts();
              setShowPortSelector(true);
            }
          }}
          disabled={tunnelLoading}
        >
          {tunnelLoading ? (
            <Loader2 className="w-5 h-5 md:w-4 md:h-4 animate-spin" />
          ) : (
            <Globe className="w-5 h-5 md:w-4 md:h-4" />
          )}
          {tunnelActive ? "Tunnel Active" : "Quick Tunnel"}
        </Button>
        <Button
          variant="ghost"
          className="w-full justify-start gap-2 text-muted-foreground h-12 md:h-10 text-base md:text-sm"
          onClick={() => toast.info("Settings coming soon")}
        >
          <Settings className="w-5 h-5 md:w-4 md:h-4" />
          Settings
        </Button>
      </div>
    </div>
  );

  return (
    <div className="h-screen flex flex-col md:flex-row bg-background">
      {isMobile && (
        <header className="h-14 border-b border-border flex items-center justify-between px-4 bg-sidebar shrink-0">
          <div className="flex items-center gap-3">
            <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="h-10 w-10">
                  <Menu className="w-6 h-6" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-[85%] max-w-[320px] p-0 flex flex-col bg-sidebar h-full">
                <SheetHeader className="p-4 border-b border-sidebar-border shrink-0">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center">
                      <Terminal className="w-5 h-5 text-primary" />
                    </div>
                    <SheetTitle className="text-sidebar-foreground">Claude Code Manager</SheetTitle>
                  </div>
                </SheetHeader>
                <SidebarContent />
              </SheetContent>
            </Sheet>
            <div className="flex items-center gap-2">
              <Terminal className="w-5 h-5 text-primary" />
              <span className="font-semibold text-sidebar-foreground">Claude Code</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isConnected ? (
              <Wifi className="w-5 h-5 text-primary" />
            ) : (
              <WifiOff className="w-5 h-5 text-destructive" />
            )}
          </div>
        </header>
      )}

      {!isMobile && (
        <aside
          ref={sidebarRef}
          className="h-screen border-r border-border flex flex-col bg-sidebar shrink-0 relative"
          style={{ width: `${sidebarWidth}px` }}
        >
          <div className="p-4 border-b border-sidebar-border">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center">
                  <Terminal className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <h1 className="font-semibold text-sidebar-foreground">Claude Code Manager</h1>
                  <p className="text-xs text-muted-foreground font-mono">v0.2.0</p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {isConnected ? (
                  <Wifi className="w-4 h-4 text-primary" />
                ) : (
                  <WifiOff className="w-4 h-4 text-destructive" />
                )}
              </div>
            </div>
          </div>
          <SidebarContent />
          {/* リサイズハンドル */}
          <div
            className={`absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/50 transition-colors ${
              isResizing ? "bg-primary/50" : "bg-transparent"
            }`}
            onMouseDown={handleResizeStart}
          />
        </aside>
      )}

      <main className="flex-1 flex flex-col min-w-0">
        <div className="h-14 md:h-12 border-b border-border flex items-center justify-between px-4 bg-sidebar shrink-0">
          <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as ViewMode)}>
            <TabsList className="bg-sidebar-accent h-10 md:h-9">
              <TabsTrigger value="dashboard" className="gap-2 h-8 md:h-7 px-3 md:px-2 text-sm md:text-xs">
                <LayoutGrid className="w-4 h-4 md:w-4 md:h-4" />
                <span className="hidden sm:inline">Dashboard</span>
              </TabsTrigger>
              <TabsTrigger value="panes" className="gap-2 h-8 md:h-7 px-3 md:px-2 text-sm md:text-xs">
                <Columns2 className="w-4 h-4 md:w-4 md:h-4" />
                <span className="hidden sm:inline">Panes</span>
                {validActivePanes.length > 0 && (
                  <span className="ml-1 text-xs bg-primary/20 text-primary px-1.5 py-0.5 rounded">
                    {validActivePanes.length}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {!isConnected && (
            <div className="flex items-center gap-2 text-destructive text-sm">
              <AlertCircle className="w-5 h-5 md:w-4 md:h-4" />
              <span className="hidden sm:inline">Not connected to server</span>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-hidden">
          {viewMode === "dashboard" ? (
            <SessionDashboard
              sessions={sessions}
              onSelectSession={handleSelectSession}
              onStopSession={handleStopSession}
            />
          ) : validActivePanes.length > 0 ? (
            <MultiPaneLayout
              activePanes={validActivePanes}
              sessions={filteredSessions}
              worktrees={worktrees}
              onSendMessage={sendMessage}
              onSendKey={sendKey}
              onStopSession={handleStopSession}
              onClosePane={handleClosePane}
              onMaximizePane={handleMaximizePane}
              maximizedPane={maximizedPane}
              onUploadImage={uploadImage}
              imageUploadResult={imageUploadResult}
              imageUploadError={imageUploadError}
              onClearImageUploadState={clearImageUploadState}
              onCopyBuffer={copyBuffer}
            />
          ) : (
              <div className="h-full flex items-center justify-center p-6">
                <div className="text-center max-w-md">
                  <div className="w-20 h-20 md:w-16 md:h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-6">
                    <Terminal className="w-10 h-10 md:w-8 md:h-8 text-primary" />
                  </div>
                  <h2 className="text-2xl md:text-xl font-semibold mb-3 md:mb-2">No Active Panes</h2>
                  <p className="text-base md:text-sm text-muted-foreground mb-6">
                    {isMobile ? "Tap the menu to select a worktree and start a session." : "Start a session from the sidebar to open a chat pane."}
                  </p>
                  <div className="flex flex-col sm:flex-row items-center justify-center gap-4 text-base md:text-sm text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <Play className="w-5 h-5 md:w-4 md:h-4 text-primary" />
                      <span>Start session</span>
                    </div>
                    <Separator orientation="vertical" className="h-4 hidden sm:block" />
                    <div className="flex items-center gap-2">
                      <Plus className="w-5 h-5 md:w-4 md:h-4 text-accent" />
                      <span>Create worktree</span>
                    </div>
                  </div>
                </div>
              </div>
          )}
        </div>
      </main>

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
            {/* ポート選択 */}
            <div className="space-y-2">
              <Label>Port</Label>
              <Select
                value={selectedPort?.toString() ?? ""}
                onValueChange={(v) => setSelectedPort(Number(v))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="ポートを選択..." />
                </SelectTrigger>
                <SelectContent>
                  {listeningPorts.map((p) => (
                    <SelectItem key={p.port} value={p.port.toString()}>
                      {p.port} ({p.process})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* カスタムポート入力 */}
            <div className="space-y-2">
              <Label>またはポート番号を入力</Label>
              <Input
                type="number"
                placeholder="3000"
                value={selectedPort ?? ""}
                onChange={(e) => setSelectedPort(e.target.value ? Number(e.target.value) : null)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPortSelector(false)}>
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
            {/* URL表示 */}
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
                <Button size="icon" variant="outline" onClick={() => copyToClipboard(tunnelUrl)}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* QRコード */}
            {tunnelUrl && (
              <div className="flex justify-center py-4">
                <div className="p-4 bg-white rounded-lg">
                  <QRCodeSVG value={tunnelUrl} size={200} />
                </div>
              </div>
            )}

            {/* トークン表示 */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Auth Token</Label>
              <div className="flex gap-2">
                <Input value={tunnelToken ?? ""} readOnly type="password" className="font-mono text-sm" />
                <Button size="icon" variant="outline" onClick={() => copyToClipboard(tunnelToken)}>
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

      {/* リポジトリ選択ダイアログ - SidebarContentの外に配置して再マウントを防ぐ */}
      <RepoSelectDialog
        isOpen={isSelectRepoOpen}
        onOpenChange={setIsSelectRepoOpen}
        scannedRepos={scannedRepos}
        isScanning={isScanning}
        onScanRepos={scanRepos}
        onSelectRepo={handleSelectRepo}
      />
    </div>
  );
}
