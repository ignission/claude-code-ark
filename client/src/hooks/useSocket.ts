/**
 * Socket.IO Client Hook
 *
 * Provides real-time communication with the server for:
 * - Git worktree operations
 * - ttyd/tmux-based Claude Code session management
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  BeaconStreamChunk,
  BrowserSession,
  ChatMessage,
  ClientToServerEvents,
  ManagedSession,
  RepoInfo,
  ServerToClientEvents,
  SpecialKey,
  Worktree,
} from "../../../shared/types";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

// Extract token from URL
function getTokenFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("token");
}

interface UseSocketOptions {
  /** 設定読み込み完了後にtrueにする（falseの間はソケット接続しない） */
  enabled?: boolean;
  initialRepoList?: string[];
  initialRepoPath?: string | null;
  onRepoListChange?: (list: string[]) => void;
  onRepoPathChange?: (path: string | null) => void;
}

interface UseSocketReturn {
  /** Socket.IOインスタンスへの参照（モバイルスクロール等で直接使用） */
  socket: TypedSocket | null;
  isConnected: boolean;
  error: string | null;

  // Allowed repositories (from --repos option)
  allowedRepos: string[];

  // Repository scanning
  scannedRepos: RepoInfo[];
  isScanning: boolean;
  scanRepos: (basePath: string) => void;

  // Repository
  repoList: string[];
  repoPath: string | null;
  selectRepo: (path: string) => void;
  removeRepo: (path: string) => void;

  // Worktrees
  worktrees: Worktree[];
  createWorktree: (branchName: string, baseBranch?: string) => void;
  deleteWorktree: (worktreePath: string) => void;
  refreshWorktrees: () => void;

  // Worktree deletion notification
  deletedWorktreeId: string | null;
  clearDeletedWorktreeId: () => void;

  // Sessions
  sessions: Map<string, ManagedSession>;
  startSession: (worktreeId: string, worktreePath: string) => void;
  stopSession: (sessionId: string) => void;
  sendMessage: (sessionId: string, message: string) => void;
  sendKey: (sessionId: string, key: SpecialKey) => void;
  restoreSession: (worktreePath: string) => void;

  // Tunnel
  tunnelActive: boolean;
  tunnelUrl: string | null;
  tunnelToken: string | null;
  tunnelLoading: boolean;
  tunnelJustStarted: boolean;
  startTunnel: (port?: number) => void;
  stopTunnel: () => void;
  clearTunnelJustStarted: () => void;

  // Ports
  listeningPorts: Array<{ port: number; process: string; pid: number }>;
  scanPorts: () => void;

  // File upload（Promiseベース: 1回のアップロードにつきリスナーを付け外して結果を解決）
  uploadFile: (data: {
    sessionId: string;
    base64Data: string;
    mimeType: string;
    originalFilename?: string;
  }) => Promise<{
    path: string;
    filename: string;
    originalFilename?: string;
  }>;

  // File viewer
  fileContent: {
    filePath: string;
    content: string;
    mimeType: string;
    size: number;
    error?: string;
  } | null;
  readFile: (sessionId: string, filePath: string) => void;

  // Copy buffer
  copyBuffer: (sessionId: string) => Promise<string | null>;

  // Session previews
  sessionPreviews: Map<string, string>;
  sessionActivityTexts: Map<string, string>;

  // Beacon
  beaconMessages: ChatMessage[];
  beaconStreaming: boolean;
  beaconStreamText: string;
  beaconSend: (message: string) => void;
  beaconLoadHistory: () => void;
  beaconClose: () => void;
  beaconClear: () => void;

  // Browser sessions
  browserSessions: Map<string, BrowserSession>;
  browserError: string | null;
  startBrowser: () => void;
  stopBrowser: (browserId: string) => void;
  navigateBrowser: (url: string) => void;
}

export function useSocket(options: UseSocketOptions = {}): UseSocketReturn {
  const socketRef = useRef<TypedSocket | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allowedRepos, setAllowedRepos] = useState<string[]>([]);
  const [scannedRepos, setScannedRepos] = useState<RepoInfo[]>([]);
  const [isScanning, setIsScanning] = useState(false);

  const [repoList, setRepoList] = useState<string[]>(
    options.initialRepoList ?? []
  );
  const [repoPath, setRepoPath] = useState<string | null>(
    options.initialRepoPath ?? null
  );
  // 再接続時に最新のrepoPathを参照するためのref
  const repoPathRef = useRef(options.initialRepoPath ?? null);

  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [deletedWorktreeId, setDeletedWorktreeId] = useState<string | null>(
    null
  );
  const [sessions, setSessions] = useState<Map<string, ManagedSession>>(
    new Map()
  );

  // Tunnel state
  const [tunnelActive, setTunnelActive] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [tunnelToken, setTunnelToken] = useState<string | null>(null);
  const [tunnelLoading, setTunnelLoading] = useState(false);
  const [tunnelJustStarted, setTunnelJustStarted] = useState(false);

  // Ports state
  const [listeningPorts, setListeningPorts] = useState<
    Array<{ port: number; process: string; pid: number }>
  >([]);

  // File viewer state
  const [fileContent, setFileContent] = useState<{
    filePath: string;
    content: string;
    mimeType: string;
    size: number;
    error?: string;
  } | null>(null);

  // Session previews state
  const [sessionPreviews, setSessionPreviews] = useState<Map<string, string>>(
    new Map()
  );
  const [sessionActivityTexts, setSessionActivityTexts] = useState<
    Map<string, string>
  >(new Map());

  // Browser session state
  const [browserSessions, setBrowserSessions] = useState<
    Map<string, BrowserSession>
  >(new Map());
  const [browserError, setBrowserError] = useState<string | null>(null);

  // Beacon状態
  const [beaconMessages, setBeaconMessages] = useState<ChatMessage[]>([]);
  const [beaconStreaming, setBeaconStreaming] = useState(false);
  const [beaconStreamText, setBeaconStreamText] = useState("");

  // repoPathRefをrepoPathの変化に同期させる
  useEffect(() => {
    repoPathRef.current = repoPath;
  }, [repoPath]);

  // repoPath変更時にコールバック通知（setState外で呼ぶことでStrictModeの二重実行を回避）
  useEffect(() => {
    optionsRef.current.onRepoPathChange?.(repoPath);
  }, [repoPath]);

  // repoList変更時にコールバック通知
  const prevRepoListRef = useRef(repoList);
  useEffect(() => {
    if (prevRepoListRef.current !== repoList) {
      prevRepoListRef.current = repoList;
      optionsRef.current.onRepoListChange?.(repoList);
    }
  }, [repoList]);

  // Initialize socket connection（enabled=falseの間は接続しない）
  const enabled = options.enabled ?? true;
  useEffect(() => {
    if (!enabled) return;

    // enabled時点のinitial値でstate同期（useStateの初期値は初回のみなので）
    const list = optionsRef.current.initialRepoList ?? [];
    if (list.length > 0) setRepoList(list);
    const path = optionsRef.current.initialRepoPath ?? null;
    if (path) {
      setRepoPath(path);
      repoPathRef.current = path;
    }

    const serverUrl = import.meta.env.DEV
      ? "http://localhost:4001"
      : window.location.origin;

    const token = getTokenFromUrl();
    const socket: TypedSocket = io(serverUrl, {
      transports: ["websocket", "polling"],
      auth: token ? { token } : undefined,
    });

    socketRef.current = socket;

    // Connection events
    socket.on("connect", () => {
      console.log("Socket connected");
      setIsConnected(true);
      setError(null);

      // 保存されたリポジトリを自動復元（再接続時は最新のrepoPathRefを使用）
      if (repoPathRef.current) {
        socket.emit("repo:select", repoPathRef.current);
      }
    });

    socket.on("disconnect", () => {
      console.log("Socket disconnected");
      setIsConnected(false);
    });

    socket.on("connect_error", err => {
      console.error("Socket connection error:", err);
      setError("Failed to connect to server");
      setIsConnected(false);
    });

    // Allowed repositories list
    socket.on("repos:list", repos => {
      console.log("Allowed repos received:", repos);
      setAllowedRepos(repos);
    });

    // Repository events
    socket.on("repo:set", path => {
      setRepoPath(path);

      // リポジトリリストに追加（重複しない場合）
      // コールバック通知はuseEffectで行う（StrictMode二重実行対策）
      setRepoList(prev => {
        if (prev.includes(path)) return prev;
        return [...prev, path];
      });

      setError(null);
    });

    socket.on("repo:error", err => {
      setError(err);
      // 楽観的更新のロールバック（selectRepoで先行設定したrepoPathを戻す）
      setRepoPath(null);
    });

    // Repository scanning events
    socket.on("repos:scanned", repos => {
      console.log("Scanned repos:", repos.length);
      setScannedRepos(repos);
    });

    socket.on("repos:scanning", ({ status, error: scanError }) => {
      if (status === "start") {
        setIsScanning(true);
        // スキャン中も前回のリストを保持（UIの伸縮を防ぐ）
      } else if (status === "complete") {
        setIsScanning(false);
      } else if (status === "error") {
        setIsScanning(false);
        setError(scanError || "Failed to scan repositories");
      }
    });

    // Worktree events
    socket.on("worktree:list", wts => {
      setWorktrees(wts);
    });

    socket.on("worktree:created", wt => {
      setWorktrees(prev => [...prev, wt]);
    });

    socket.on("worktree:deleted", wtId => {
      setWorktrees(prev => prev.filter(w => w.id !== wtId));
      setDeletedWorktreeId(wtId);
    });

    socket.on("worktree:error", err => {
      setError(err);
    });

    // Session events (ttyd-based)
    const updateSession = (session: ManagedSession): void => {
      setSessions(prev => new Map(prev).set(session.id, session));
    };

    socket.on("session:list", (sessions: ManagedSession[]) => {
      setSessions(prev => {
        const next = new Map(prev);
        for (const session of sessions) {
          next.set(session.id, session);
        }
        return next;
      });
    });

    socket.on("session:created", session => {
      console.log(
        "[Socket] Session created:",
        session.id,
        "ttydUrl:",
        session.ttydUrl
      );
      updateSession(session);
    });

    socket.on("session:updated", updateSession);

    socket.on("session:stopped", sessionId => {
      setSessions(prev => {
        const next = new Map(prev);
        next.delete(sessionId);
        return next;
      });
    });

    socket.on("session:restored", session => {
      console.log(
        "[Socket] Session restored:",
        session.id,
        "ttydUrl:",
        session.ttydUrl
      );
      updateSession(session);
    });

    socket.on(
      "session:restore_failed",
      ({ worktreePath: _path, error: err }) => {
        console.log("[Socket] Session restore failed:", err);
      }
    );

    socket.on("session:error", ({ sessionId, error: err }) => {
      setError(err);
      if (sessionId) {
        setSessions(prev => {
          const next = new Map(prev);
          const session = next.get(sessionId);
          if (session) {
            next.set(sessionId, { ...session, status: "error" });
          }
          return next;
        });
      }
    });

    // Tunnel events
    socket.on("tunnel:started", ({ url, token }) => {
      console.log("[Socket] Tunnel started:", url);
      setTunnelActive(true);
      setTunnelUrl(url);
      setTunnelToken(token);
      setTunnelLoading(false);
      setTunnelJustStarted(true);
    });

    socket.on("tunnel:stopped", () => {
      console.log("[Socket] Tunnel stopped");
      setTunnelActive(false);
      setTunnelUrl(null);
      setTunnelToken(null);
      setTunnelLoading(false);
    });

    socket.on("tunnel:error", ({ message }) => {
      console.error("[Socket] Tunnel error:", message);
      setError(message);
      setTunnelLoading(false);
    });

    socket.on("tunnel:status", ({ active, url, token }) => {
      console.log("[Socket] Tunnel status:", { active, url });
      setTunnelActive(active);
      setTunnelUrl(url ?? null);
      setTunnelToken(token ?? null);
    });

    // Ports events
    socket.on("ports:list", ({ ports }) => {
      setListeningPorts(ports);
    });

    // File upload events は uploadFile(Promise版) 内で都度 on/off して扱う

    // File viewer events
    socket.on("file:content", data => {
      console.log("[Socket] File content received:", data.filePath);
      setFileContent(data);
    });

    // Beaconイベント
    socket.on("beacon:message", (message: ChatMessage) => {
      setBeaconMessages(prev => [...prev, message]);
      if (message.role === "assistant") {
        setBeaconStreaming(false);
        setBeaconStreamText("");
      }
    });

    socket.on("beacon:stream", (data: BeaconStreamChunk) => {
      if (data.done) {
        setBeaconStreaming(false);
        setBeaconStreamText("");
      } else {
        setBeaconStreaming(true);
        setBeaconStreamText(prev => prev + data.chunk);
      }
    });

    socket.on("beacon:history", (data: { messages: ChatMessage[] }) => {
      setBeaconMessages(data.messages);
    });

    socket.on("beacon:error", (data: { error: string }) => {
      console.error("[Beacon] Error:", data.error);
      setBeaconStreaming(false);
      setBeaconStreamText("");
    });

    socket.on("session:previews", previews => {
      // セッションのstatusをプレビューから更新
      setSessions(prev => {
        const next = new Map(prev);
        for (const p of previews) {
          const existing = next.get(p.sessionId);
          if (existing && existing.status !== p.status) {
            next.set(p.sessionId, { ...existing, status: p.status });
          }
        }
        return next;
      });
      setSessionPreviews(prev => {
        const next = new Map(prev);
        for (const p of previews) {
          next.set(p.sessionId, p.text);
        }
        return next;
      });
      setSessionActivityTexts(prev => {
        const next = new Map(prev);
        for (const p of previews) {
          next.set(p.sessionId, p.activityText);
        }
        return next;
      });
    });

    // Browser session events (noVNC)
    socket.on("browser:started", (session: BrowserSession) => {
      setBrowserSessions(prev => {
        const next = new Map(prev);
        next.set(session.id, session);
        return next;
      });
      setBrowserError(null);
    });

    socket.on("browser:stopped", ({ browserId }: { browserId: string }) => {
      setBrowserSessions(prev => {
        const next = new Map(prev);
        next.delete(browserId);
        return next;
      });
    });

    socket.on("browser:error", ({ message }: { message: string }) => {
      setBrowserError(message);
    });

    // Cleanup on unmount
    return () => {
      socket.off("ports:list");
      socket.off("file:content");
      socket.off("beacon:message");
      socket.off("beacon:stream");
      socket.off("beacon:history");
      socket.off("beacon:error");
      socket.off("session:previews");
      socket.off("browser:started");
      socket.off("browser:stopped");
      socket.off("browser:error");
      socket.disconnect();
    };
  }, [enabled]);

  // Repository actions
  const selectRepo = useCallback((path: string) => {
    setRepoPath(path);
    socketRef.current?.emit("repo:select", path);
  }, []);

  const removeRepo = useCallback(
    (path: string) => {
      // コールバック通知はuseEffectで行う（StrictMode二重実行対策）
      setRepoList(prev => prev.filter(p => p !== path));

      // 削除したリポジトリが選択中の場合はクリア
      if (repoPath === path) {
        setRepoPath(null);
        setWorktrees([]);
      }
    },
    [repoPath]
  );

  const scanRepos = useCallback((basePath: string) => {
    socketRef.current?.emit("repo:scan", basePath);
  }, []);

  // Worktree actions
  const createWorktree = useCallback(
    (branchName: string, baseBranch?: string) => {
      if (!repoPath) return;
      socketRef.current?.emit("worktree:create", {
        repoPath,
        branchName,
        baseBranch,
      });
    },
    [repoPath]
  );

  const deleteWorktree = useCallback(
    (worktreePath: string) => {
      if (!repoPath) return;
      socketRef.current?.emit("worktree:delete", { repoPath, worktreePath });
    },
    [repoPath]
  );

  const refreshWorktrees = useCallback(() => {
    if (!repoPath) return;
    socketRef.current?.emit("worktree:list", repoPath);
  }, [repoPath]);

  const clearDeletedWorktreeId = useCallback(() => {
    setDeletedWorktreeId(null);
  }, []);

  // Session actions
  const startSession = useCallback(
    (worktreeId: string, worktreePath: string) => {
      socketRef.current?.emit("session:start", { worktreeId, worktreePath });
    },
    []
  );

  const stopSession = useCallback((sessionId: string) => {
    socketRef.current?.emit("session:stop", sessionId);
  }, []);

  const sendMessage = useCallback((sessionId: string, message: string) => {
    socketRef.current?.emit("session:send", { sessionId, message });
  }, []);

  const sendKey = useCallback((sessionId: string, key: SpecialKey) => {
    socketRef.current?.emit("session:key", { sessionId, key });
  }, []);

  const restoreSession = useCallback((worktreePath: string) => {
    socketRef.current?.emit("session:restore", worktreePath);
  }, []);

  // Tunnel actions
  const startTunnel = useCallback((port?: number) => {
    setTunnelLoading(true);
    socketRef.current?.emit("tunnel:start", port ? { port } : undefined);
  }, []);

  const stopTunnel = useCallback(() => {
    setTunnelLoading(true);
    socketRef.current?.emit("tunnel:stop");
  }, []);

  const clearTunnelJustStarted = useCallback(() => {
    setTunnelJustStarted(false);
  }, []);

  // Ports actions
  const scanPorts = useCallback(() => {
    socketRef.current?.emit("ports:scan");
  }, []);

  // File upload actions（Promiseベース: 1回のアップロードで都度リスナーを付けて結果を解決）
  const uploadFile = useCallback(
    (data: {
      sessionId: string;
      base64Data: string;
      mimeType: string;
      originalFilename?: string;
    }): Promise<{
      path: string;
      filename: string;
      originalFilename?: string;
    }> => {
      return new Promise((resolve, reject) => {
        const socket = socketRef.current;
        if (!socket?.connected) {
          reject(new Error("ソケットが切断されています"));
          return;
        }
        // 複数アップロードの同時実行で誤った Promise が解決されないよう requestId で紐付ける
        const requestId =
          typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const timeoutId = window.setTimeout(() => {
          socket.off("file-upload:uploaded", onUploaded);
          socket.off("file-upload:error", onError);
          reject(new Error("アップロードがタイムアウトしました"));
        }, 30000);
        const onUploaded = (result: {
          requestId: string;
          path: string;
          filename: string;
          originalFilename?: string;
        }) => {
          if (result.requestId !== requestId) return;
          window.clearTimeout(timeoutId);
          socket.off("file-upload:uploaded", onUploaded);
          socket.off("file-upload:error", onError);
          const { requestId: _omitted, ...rest } = result;
          resolve(rest);
        };
        const onError = (err: {
          requestId: string;
          message: string;
          code?: string;
        }) => {
          if (err.requestId !== requestId) return;
          window.clearTimeout(timeoutId);
          socket.off("file-upload:uploaded", onUploaded);
          socket.off("file-upload:error", onError);
          reject(new Error(err.message));
        };
        socket.on("file-upload:uploaded", onUploaded);
        socket.on("file-upload:error", onError);
        socket.emit("file-upload:upload", { ...data, requestId });
      });
    },
    []
  );

  // File read action
  const readFile = useCallback((sessionId: string, filePath: string) => {
    if (!socketRef.current?.connected) return;
    socketRef.current.emit("file:read", { sessionId, filePath });
  }, []);

  // Beaconメッセージ送信
  const beaconSend = useCallback((message: string) => {
    // 切断時は楽観更新を起こさない（streamingイベントが届かず入力欄が永久ロックされるため）
    const socket = socketRef.current;
    if (!socket?.connected) return;
    // 楽観的にストリーミング状態を立てる（ツール実行先行ターンは最初のチャンクが遅れるため）
    setBeaconStreaming(true);
    setBeaconStreamText("");
    socket.emit("beacon:send", { message });
  }, []);

  // Beacon履歴取得
  const beaconLoadHistory = useCallback(() => {
    socketRef.current?.emit("beacon:history");
  }, []);

  // Beaconセッション終了
  const beaconClose = useCallback(() => {
    socketRef.current?.emit("beacon:close");
    setBeaconMessages([]);
    setBeaconStreaming(false);
    setBeaconStreamText("");
  }, []);

  // Beaconチャット履歴クリア（サーバー側のセッション・DB履歴も完全にリセット）
  // 切断時はサーバーに届かないため何もしない（ローカルだけ消すと
  // 次の再接続時にサーバー履歴が戻ってきて不整合になる）
  const beaconClear = useCallback(() => {
    const socket = socketRef.current;
    if (!socket?.connected) return;
    socket.emit("beacon:clear");
    setBeaconMessages([]);
    setBeaconStreaming(false);
    setBeaconStreamText("");
  }, []);

  // Copy buffer action
  const copyBuffer = useCallback(
    (sessionId: string): Promise<string | null> => {
      return new Promise(resolve => {
        if (!socketRef.current) {
          resolve(null);
          return;
        }
        const timeoutId = window.setTimeout(() => resolve(null), 5000);
        socketRef.current.emit(
          "session:copy",
          sessionId,
          (response: { text?: string; error?: string }) => {
            window.clearTimeout(timeoutId);
            if (response.text) {
              resolve(response.text);
            } else {
              console.error("[Socket] Copy buffer error:", response.error);
              resolve(null);
            }
          }
        );
      });
    },
    []
  );

  // Browser session actions
  const startBrowser = useCallback(() => {
    socketRef.current?.emit("browser:start");
  }, []);

  const stopBrowser = useCallback((browserId: string) => {
    socketRef.current?.emit("browser:stop", { browserId });
  }, []);

  const navigateBrowser = useCallback((url: string) => {
    socketRef.current?.emit("browser:navigate", { url });
  }, []);

  return {
    socket: socketRef.current,
    isConnected,
    error,
    allowedRepos,
    scannedRepos,
    isScanning,
    scanRepos,
    repoList,
    repoPath,
    selectRepo,
    removeRepo,
    worktrees,
    createWorktree,
    deleteWorktree,
    refreshWorktrees,
    deletedWorktreeId,
    clearDeletedWorktreeId,
    sessions,
    startSession,
    stopSession,
    sendMessage,
    sendKey,
    restoreSession,
    tunnelActive,
    tunnelUrl,
    tunnelToken,
    tunnelLoading,
    tunnelJustStarted,
    startTunnel,
    stopTunnel,
    clearTunnelJustStarted,
    // Ports
    listeningPorts,
    scanPorts,
    // File upload
    uploadFile,
    // File viewer
    fileContent,
    readFile,
    // Copy buffer
    copyBuffer,
    // Session previews
    sessionPreviews,
    sessionActivityTexts,
    // Beacon
    beaconMessages,
    beaconStreaming,
    beaconStreamText,
    beaconSend,
    beaconLoadHistory,
    beaconClose,
    beaconClear,
    // Browser sessions
    browserSessions,
    browserError,
    startBrowser,
    stopBrowser,
    navigateBrowser,
  };
}
