import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WorktreeContextMenu } from "@/components/WorktreeContextMenu";
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
  Trash2,
  Terminal,
  Settings,
  Wifi,
  WifiOff,
  RefreshCw,
  AlertCircle,
  Menu,
  Globe,
  Copy,
  Loader2,
  MessageSquare,
} from "lucide-react";
import { useIsMobile } from "@/hooks/useMobile";
import { toast } from "sonner";
import { useSocket } from "@/hooks/useSocket";
import { MultiPaneLayout } from "@/components/MultiPaneLayout";

import { MobileLayout } from "@/components/MobileLayout";
import { RepoSelectDialog } from "@/components/RepoSelectDialog";
import { CreateWorktreeDialog } from "@/components/CreateWorktreeDialog";
import {
  isSessionBelongsToRepo,
  findRepoForSession,
} from "@/utils/sessionUtils";
import { MobileChatView } from "@/components/MobileChatView";
import { getBaseName } from "@/utils/pathUtils";
import type { Worktree, ManagedSession } from "../../../shared/types";

// サイドバーの幅の定数
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 400;
const SIDEBAR_DEFAULT_WIDTH = 320;
const SIDEBAR_WIDTH_STORAGE_KEY = "sidebar-width";
const ACTIVE_PANES_STORAGE_KEY = "activePanesPerRepo";
const MAXIMIZED_PANE_STORAGE_KEY = "maximizedPane";
const CLOSED_PANES_STORAGE_KEY = "closedPanes";

function loadClosedPanes(): Set<string> {
  try {
    const saved = localStorage.getItem(CLOSED_PANES_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        return new Set(
          parsed.filter((v): v is string => typeof v === "string")
        );
      }
    }
  } catch {}
  return new Set();
}

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
    tunnelJustStarted,
    startTunnel,
    stopTunnel,
    clearTunnelJustStarted,
    listeningPorts,
    scanPorts,
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
    beaconClose,
    beaconClear,
  } = useSocket();

  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // サイドバーのリサイズ機能
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (saved) {
      const parsed = parseInt(saved, 10);
      if (
        !isNaN(parsed) &&
        parsed >= SIDEBAR_MIN_WIDTH &&
        parsed <= SIDEBAR_MAX_WIDTH
      ) {
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
      const newWidth = Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, e.clientX)
      );
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

  const [activePanesPerRepo, setActivePanesPerRepo] = useState<
    Map<string, string[]>
  >(() => {
    try {
      const saved = localStorage.getItem(ACTIVE_PANES_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          return new Map(parsed);
        }
      }
    } catch {}
    return new Map();
  });
  const [maximizedPane, setMaximizedPane] = useState<string | null>(() => {
    try {
      const saved = localStorage.getItem(MAXIMIZED_PANE_STORAGE_KEY);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch {}
    return null;
  });

  // ユーザーが意図的に閉じたペインを追跡（useEffectによる再追加を防ぐ）
  const closedPanesRef = useRef<Set<string>>(loadClosedPanes());
  const saveClosedPanes = useCallback(() => {
    try {
      localStorage.setItem(
        CLOSED_PANES_STORAGE_KEY,
        JSON.stringify(Array.from(closedPanesRef.current))
      );
    } catch {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        ACTIVE_PANES_STORAGE_KEY,
        JSON.stringify(Array.from(activePanesPerRepo.entries()))
      );
    } catch {}
  }, [activePanesPerRepo]);

  useEffect(() => {
    try {
      localStorage.setItem(
        MAXIMIZED_PANE_STORAGE_KEY,
        JSON.stringify(maximizedPane)
      );
    } catch {}
  }, [maximizedPane]);

  // 現在のリポジトリのactivePanesを取得
  const activePanes = repoPath ? activePanesPerRepo.get(repoPath) || [] : [];

  // 全リポジトリ横断のactivePanes（Panesタブ用）
  const allActivePanes = useMemo(() => {
    const all: string[] = [];
    activePanesPerRepo.forEach(panes => all.push(...panes));
    return all;
  }, [activePanesPerRepo]);

  // activePanesを更新するヘルパー関数
  const setActivePanes = (
    updater: string[] | ((prev: string[]) => string[])
  ) => {
    if (!repoPath) return;
    setActivePanesPerRepo(prev => {
      const newMap = new Map(prev);
      const currentPanes = newMap.get(repoPath) || [];
      const newPanes =
        typeof updater === "function" ? updater(currentPanes) : updater;
      newMap.set(repoPath, newPanes);
      return newMap;
    });
  };
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(
    null
  );
  const [isCreateWorktreeOpen, setIsCreateWorktreeOpen] = useState(false);
  const [isSelectRepoOpen, setIsSelectRepoOpen] = useState(false);
  const [showTunnelDialog, setShowTunnelDialog] = useState(false);
  const [selectedPort, setSelectedPort] = useState<number | null>(null);
  const [showPortSelector, setShowPortSelector] = useState(false);
  const [showBeaconDialog, setShowBeaconDialog] = useState(false);

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

  useEffect(() => {
    setMaximizedPane(null);
    setSelectedWorktreeId(null);
  }, [repoPath, activePanesPerRepo]);

  const getSessionForWorktree = (
    worktreeId: string
  ): ManagedSession | undefined => {
    return Array.from(sessions.values()).find(s => s.worktreeId === worktreeId);
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

  useEffect(() => {
    if (deletedWorktreeId) {
      toast.success("Worktreeを削除しました");
      clearDeletedWorktreeId();
    }
  }, [deletedWorktreeId, clearDeletedWorktreeId]);

  const handleDeleteWorktree = (worktree: Worktree) => {
    if (worktree.isMain) {
      toast.error("Cannot delete the main worktree");
      return;
    }

    // 対応するセッションがあればペインを即座に閉じる
    const session = getSessionForWorktree(worktree.id);
    if (session) {
      closedPanesRef.current.add(session.id);
      saveClosedPanes();
      const targetRepo = findRepoForSession(session, repoList);
      removeSessionFromPanes(session.id, targetRepo);
      if (maximizedPane === session.id) {
        setMaximizedPane(null);
      }
    }

    deleteWorktree(worktree.path);
    toast.info("Worktreeを削除中...");
  };

  const handleStartSession = (worktree: Worktree) => {
    const existingSession = getSessionForWorktree(worktree.id);
    if (existingSession) {
      // ユーザーが明示的に開くので、closedPanesから除外
      closedPanesRef.current.delete(existingSession.id);
      saveClosedPanes();
      // Add to active panes if not already there
      if (!activePanes.includes(existingSession.id)) {
        setActivePanes(prev => [...prev, existingSession.id]);
        toast.warning(
          "このWorktreeには既にセッションが存在するため、既存セッションを開きます"
        );
      }
      return;
    }
    startSession(worktree.id, worktree.path);
    toast.success("Session started");
  };

  // セッションIDをペインリストから削除するヘルパー
  // targetRepoが指定されていればそのリポのみ、nullならフォールバックで全リポから削除
  const removeSessionFromPanes = (
    sessionId: string,
    targetRepo?: string | null
  ) => {
    setActivePanesPerRepo(prev => {
      const newMap = new Map(prev);
      if (targetRepo) {
        const currentPanes = newMap.get(targetRepo) || [];
        newMap.set(
          targetRepo,
          currentPanes.filter(id => id !== sessionId)
        );
        return newMap;
      }
      // フォールバック: 全リポから削除
      Array.from(newMap.entries()).forEach(([repo, panes]) => {
        if (panes.includes(sessionId)) {
          newMap.set(
            repo,
            panes.filter((id: string) => id !== sessionId)
          );
        }
      });
      return newMap;
    });
  };

  const handleStopSession = (sessionId: string) => {
    stopSession(sessionId);
    const session = sessions.get(sessionId);
    const targetRepo = session ? findRepoForSession(session, repoList) : null;
    removeSessionFromPanes(sessionId, targetRepo);
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
    saveClosedPanes();

    // セッションが属するリポジトリを特定
    const targetRepo = findRepoForSession(session, repoList);
    if (targetRepo && targetRepo !== repoPath) {
      // 別リポジトリの場合は切り替え
      selectRepo(targetRepo);
    }

    // activePanesPerRepoを直接更新（リポジトリ切り替え後でも正しく動作するように）
    const targetRepoPath = targetRepo || repoPath;
    if (targetRepoPath) {
      setActivePanesPerRepo(prev => {
        const newMap = new Map(prev);
        const currentPanes = newMap.get(targetRepoPath) || [];
        if (!currentPanes.includes(sessionId)) {
          newMap.set(targetRepoPath, [...currentPanes, sessionId]);
        }
        return newMap;
      });
    }
  };

  const handleClosePane = (sessionId: string) => {
    // ユーザーが意図的に閉じたペインとして記録
    closedPanesRef.current.add(sessionId);
    saveClosedPanes();
    const session = sessions.get(sessionId);
    const targetRepo = session ? findRepoForSession(session, repoList) : null;
    removeSessionFromPanes(sessionId, targetRepo);
    if (maximizedPane === sessionId) {
      setMaximizedPane(null);
    }
  };

  const handleMaximizePane = (sessionId: string) => {
    setMaximizedPane(maximizedPane === sessionId ? null : sessionId);
  };

  useEffect(() => {
    if (repoList.length === 0) return;
    sessions.forEach((session, sessionId) => {
      // ユーザーが意図的に閉じたペインは再追加しない
      if (closedPanesRef.current.has(sessionId)) return;
      const targetRepo = findRepoForSession(session, repoList);
      if (targetRepo) {
        setActivePanesPerRepo(prev => {
          const currentPanes = prev.get(targetRepo) || [];
          if (currentPanes.includes(sessionId)) return prev;
          const newMap = new Map(prev);
          newMap.set(targetRepo, [...currentPanes, sessionId]);
          return newMap;
        });
      }
    });
  }, [sessions, repoList]);

  useEffect(() => {
    if (maximizedPane && !sessions.has(maximizedPane)) {
      setMaximizedPane(null);
    }
  }, [maximizedPane, sessions]);

  // 現在のリポジトリに属し、かつ存在するセッションのみをフィルタ
  const { filteredSessions, validActivePanes } = useMemo(() => {
    const filtered = new Map(
      Array.from(sessions.entries()).filter(([sessionId]) =>
        allActivePanes.includes(sessionId)
      )
    );
    const valid = allActivePanes.filter(id => filtered.has(id));
    return { filteredSessions: filtered, validActivePanes: valid };
  }, [sessions, allActivePanes]);

  const SidebarContent = () => (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="p-4 border-b border-sidebar-border">
        <div className="flex items-center justify-between mb-2">
          <Label className="text-xs text-muted-foreground uppercase tracking-wider">
            Repositories
          </Label>
          {allowedRepos.length > 0 ? (
            <Select onValueChange={selectRepo} value={repoPath || undefined}>
              <SelectTrigger className="w-auto h-8 text-xs gap-1">
                <Plus className="w-3 h-3" />
              </SelectTrigger>
              <SelectContent>
                {allowedRepos.map(repo => (
                  <SelectItem
                    key={repo}
                    value={repo}
                    className="font-mono text-xs"
                  >
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
              {repoList.map(repo => {
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
                    <FolderOpen
                      className={`w-4 h-4 shrink-0 ${isSelected ? "text-primary" : "text-muted-foreground"}`}
                    />
                    <div className="flex-1 min-w-0">
                      <div
                        className={`text-sm font-medium truncate ${isSelected ? "text-primary" : "text-sidebar-foreground"}`}
                      >
                        {repoName}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {isSelected && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={e => {
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
                        onClick={e => {
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
            <span className="text-base md:text-sm font-medium text-sidebar-foreground">
              Worktrees
            </span>
            <span className="text-sm md:text-xs text-muted-foreground">
              ({worktrees.length})
            </span>
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
            {worktrees.map(worktree => {
              const session = getSessionForWorktree(worktree.id);
              const isSelected = selectedWorktreeId === worktree.id;
              const isInPane = session && activePanes.includes(session.id);

              return (
                <WorktreeContextMenu
                  key={worktree.id}
                  worktree={worktree}
                  session={session}
                  onStartSession={w => {
                    handleStartSession(w);
                    if (isMobile) setSidebarOpen(false);
                  }}
                  onStopSession={handleStopSession}
                  onSelectSession={sessionId => {
                    handleSelectSession(sessionId);
                    if (isMobile) setSidebarOpen(false);
                  }}
                  onDeleteWorktree={handleDeleteWorktree}
                >
                  <div
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
                  </div>
                </WorktreeContextMenu>
              );
            })}
          </div>
        </ScrollArea>
      </div>

      {/* Beaconボタン */}
      <div className="border-t border-border p-4">
        <Button
          variant="outline"
          className="w-full justify-start gap-2 h-10 text-sm"
          onClick={() => setShowBeaconDialog(true)}
        >
          <MessageSquare className="h-4 w-4" />
          Beacon
          {beaconStreaming && (
            <span className="ml-auto flex gap-0.5">
              <span
                className="w-1 h-1 bg-primary rounded-full animate-bounce"
                style={{ animationDelay: "0ms" }}
              />
              <span
                className="w-1 h-1 bg-primary rounded-full animate-bounce"
                style={{ animationDelay: "150ms" }}
              />
              <span
                className="w-1 h-1 bg-primary rounded-full animate-bounce"
                style={{ animationDelay: "300ms" }}
              />
            </span>
          )}
        </Button>
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
    <div className="h-[100dvh] flex flex-col md:flex-row bg-background">
      {isMobile && (
        <header className="h-14 border-b border-border flex items-center justify-between px-4 bg-sidebar shrink-0">
          <div className="flex items-center gap-3">
            <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="h-10 w-10">
                  <Menu className="w-6 h-6" />
                </Button>
              </SheetTrigger>
              <SheetContent
                side="left"
                className="w-[85%] max-w-[320px] p-0 flex flex-col bg-sidebar h-full"
              >
                <SheetHeader className="p-4 border-b border-sidebar-border shrink-0">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center">
                      <Terminal className="w-5 h-5 text-primary" />
                    </div>
                    <SheetTitle className="text-sidebar-foreground">
                      Claude Code Manager
                    </SheetTitle>
                  </div>
                </SheetHeader>
                <SidebarContent />
              </SheetContent>
            </Sheet>
            <div className="flex items-center gap-2">
              <Terminal className="w-5 h-5 text-primary" />
              <span className="font-semibold text-sidebar-foreground">
                Claude Code
              </span>
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
        {isMobile ? (
          <MobileLayout
            sessions={sessions}
            worktrees={worktrees}
            repoName={repoPath ? getBaseName(repoPath) : null}
            repoPath={repoPath}
            onStartSession={handleStartSession}
            onStopSession={handleStopSession}
            onDeleteWorktree={handleDeleteWorktree}
            onSendMessage={sendMessage}
            onSendKey={sendKey}
            onSelectSession={handleSelectSession}
            onUploadImage={uploadImage}
            imageUploadResult={imageUploadResult}
            imageUploadError={imageUploadError}
            onClearImageUploadState={clearImageUploadState}
            onCopyBuffer={copyBuffer}
            beaconMessages={beaconMessages}
            beaconStreaming={beaconStreaming}
            beaconStreamText={beaconStreamText}
            onBeaconSend={message => {
              beaconSend(message);
            }}
            onBeaconClear={beaconClear}
          />
        ) : (
          <>
            {!isConnected && (
              <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 flex items-center gap-2 text-destructive text-sm shrink-0">
                <AlertCircle className="w-4 h-4" />
                <span>Not connected to server</span>
              </div>
            )}

            <div className="flex-1 overflow-hidden">
              {validActivePanes.length > 0 ? (
                <MultiPaneLayout
                  activePanes={validActivePanes}
                  sessions={filteredSessions}
                  worktrees={worktrees}
                  repoList={repoList}
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
                    <h2 className="text-2xl md:text-xl font-semibold mb-3 md:mb-2">
                      No Active Panes
                    </h2>
                    <p className="text-base md:text-sm text-muted-foreground mb-6">
                      Start a session from the sidebar to open a chat pane.
                    </p>
                    <div className="flex flex-col sm:flex-row items-center justify-center gap-4 text-base md:text-sm text-muted-foreground">
                      <div className="flex items-center gap-2">
                        <Play className="w-5 h-5 md:w-4 md:h-4 text-primary" />
                        <span>Start session</span>
                      </div>
                      <Separator
                        orientation="vertical"
                        className="h-4 hidden sm:block"
                      />
                      <div className="flex items-center gap-2">
                        <Plus className="w-5 h-5 md:w-4 md:h-4 text-accent" />
                        <span>Create worktree</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
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

            {/* カスタムポート入力 */}
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
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => copyToClipboard(tunnelUrl)}
                >
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

      {/* Beaconチャットダイアログ */}
      <Dialog open={showBeaconDialog} onOpenChange={setShowBeaconDialog}>
        <DialogContent
          className="max-w-2xl h-[80vh] p-0 flex flex-col overflow-hidden"
          showCloseButton={false}
        >
          {/* アクセシビリティ用（非表示） */}
          <DialogHeader className="sr-only">
            <DialogTitle>Beacon</DialogTitle>
            <DialogDescription>
              全リポジトリを横断して操作できます
            </DialogDescription>
          </DialogHeader>
          <MobileChatView
            messages={beaconMessages}
            isStreaming={beaconStreaming}
            streamingText={beaconStreamText}
            onSendMessage={message => {
              beaconSend(message);
            }}
            onClear={beaconClear}
          />
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
