/**
 * Socket.IO Client Hook
 *
 * Provides real-time communication with the server for:
 * - Git worktree operations
 * - ttyd/tmux-based Claude Code session management
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { io, Socket } from "socket.io-client";
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  Worktree,
  ManagedSession,
  Message,
  RepoInfo,
  SpecialKey,
  ChatMessage,
  BeaconStreamChunk,
} from "../../../shared/types";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

// Extract token from URL
function getTokenFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("token");
}

interface UseSocketReturn {
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

  // Image upload
  uploadImage: (sessionId: string, base64Data: string, mimeType: string) => void;
  imageUploadResult: { path: string; filename: string } | null;
  imageUploadError: string | null;
  clearImageUploadState: () => void;

  // Copy buffer
  copyBuffer: (sessionId: string) => Promise<string | null>;

  // Beacon
  beaconMessages: ChatMessage[];
  beaconStreaming: boolean;
  beaconStreamText: string;
  beaconSend: (message: string) => void;
  beaconLoadHistory: () => void;
  beaconClose: () => void;
  beaconClear: () => void;
}

export function useSocket(): UseSocketReturn {
  const socketRef = useRef<TypedSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allowedRepos, setAllowedRepos] = useState<string[]>([]);
  const [scannedRepos, setScannedRepos] = useState<RepoInfo[]>([]);
  const [isScanning, setIsScanning] = useState(false);

  const [repoList, setRepoList] = useState<string[]>(() => {
    const saved = localStorage.getItem("repoList");
    return saved ? JSON.parse(saved) : [];
  });
  const [repoPath, setRepoPath] = useState<string | null>(() => {
    return localStorage.getItem("selectedRepoPath");
  });
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [deletedWorktreeId, setDeletedWorktreeId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Map<string, ManagedSession>>(new Map());

  // Tunnel state
  const [tunnelActive, setTunnelActive] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [tunnelToken, setTunnelToken] = useState<string | null>(null);
  const [tunnelLoading, setTunnelLoading] = useState(false);
  const [tunnelJustStarted, setTunnelJustStarted] = useState(false);

  // Ports state
  const [listeningPorts, setListeningPorts] = useState<Array<{ port: number; process: string; pid: number }>>([]);

  // Image upload state
  const [imageUploadResult, setImageUploadResult] = useState<{ path: string; filename: string } | null>(null);
  const [imageUploadError, setImageUploadError] = useState<string | null>(null);

  // Beacon状態
  const [beaconMessages, setBeaconMessages] = useState<ChatMessage[]>([]);
  const [beaconStreaming, setBeaconStreaming] = useState(false);
  const [beaconStreamText, setBeaconStreamText] = useState("");

  // Initialize socket connection
  useEffect(() => {
    const serverUrl = import.meta.env.DEV
      ? "http://localhost:3001"
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

      // 保存されたリポジトリを自動復元
      const savedRepoPath = localStorage.getItem("selectedRepoPath");
      if (savedRepoPath) {
        socket.emit("repo:select", savedRepoPath);
      }
    });

    socket.on("disconnect", () => {
      console.log("Socket disconnected");
      setIsConnected(false);
    });

    socket.on("connect_error", (err) => {
      console.error("Socket connection error:", err);
      setError("Failed to connect to server");
      setIsConnected(false);
    });

    // Allowed repositories list
    socket.on("repos:list", (repos) => {
      console.log("Allowed repos received:", repos);
      setAllowedRepos(repos);
    });

    // Repository events
    socket.on("repo:set", (path) => {
      setRepoPath(path);
      localStorage.setItem("selectedRepoPath", path);

      // リポジトリリストに追加（重複しない場合）
      setRepoList((prev) => {
        if (prev.includes(path)) return prev;
        const newList = [...prev, path];
        localStorage.setItem("repoList", JSON.stringify(newList));
        return newList;
      });

      setError(null);
    });

    socket.on("repo:error", (err) => {
      setError(err);
    });

    // Repository scanning events
    socket.on("repos:scanned", (repos) => {
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
    socket.on("worktree:list", (wts) => {
      setWorktrees(wts);
    });

    socket.on("worktree:created", (wt) => {
      setWorktrees((prev) => [...prev, wt]);
    });

    socket.on("worktree:deleted", (wtId) => {
      setWorktrees((prev) => prev.filter((w) => w.id !== wtId));
      setDeletedWorktreeId(wtId);
    });

    socket.on("worktree:error", (err) => {
      setError(err);
    });

    // Session events (ttyd-based)
    const updateSession = (session: ManagedSession): void => {
      setSessions((prev) => new Map(prev).set(session.id, session));
    };

    socket.on("session:list", (sessions: ManagedSession[]) => {
      setSessions((prev) => {
        const next = new Map(prev);
        for (const session of sessions) {
          next.set(session.id, session);
        }
        return next;
      });
    });

    socket.on("session:created", (session) => {
      console.log("[Socket] Session created:", session.id, "ttydUrl:", session.ttydUrl);
      updateSession(session);
    });

    socket.on("session:updated", updateSession);

    socket.on("session:stopped", (sessionId) => {
      setSessions((prev) => {
        const next = new Map(prev);
        next.delete(sessionId);
        return next;
      });
    });

    socket.on("session:restored", (session) => {
      console.log("[Socket] Session restored:", session.id, "ttydUrl:", session.ttydUrl);
      updateSession(session);
    });

    socket.on("session:restore_failed", ({ worktreePath: _path, error: err }) => {
      console.log("[Socket] Session restore failed:", err);
    });

    socket.on("session:error", ({ sessionId, error: err }) => {
      setError(err);
      if (sessionId) {
        setSessions((prev) => {
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

    // Image upload events
    socket.on("image:uploaded", (data) => {
      console.log("[Socket] Image uploaded:", data.path);
      setImageUploadResult(data);
      setImageUploadError(null);
    });

    socket.on("image:error", ({ message }) => {
      console.error("[Socket] Image upload error:", message);
      setImageUploadError(message);
      setImageUploadResult(null);
    });

    // Beaconイベント
    socket.on("beacon:message", (message: ChatMessage) => {
      setBeaconMessages((prev) => [...prev, message]);
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
        setBeaconStreamText((prev) => prev + data.chunk);
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

    // Cleanup on unmount
    return () => {
      socket.off("ports:list");
      socket.off("image:uploaded");
      socket.off("image:error");
      socket.off("beacon:message");
      socket.off("beacon:stream");
      socket.off("beacon:history");
      socket.off("beacon:error");
      socket.disconnect();
    };
  }, []);

  // Repository actions
  const selectRepo = useCallback((path: string) => {
    socketRef.current?.emit("repo:select", path);
  }, []);

  const removeRepo = useCallback((path: string) => {
    setRepoList((prev) => {
      const newList = prev.filter((p) => p !== path);
      localStorage.setItem("repoList", JSON.stringify(newList));
      return newList;
    });

    // 削除したリポジトリが選択中の場合はクリア
    if (repoPath === path) {
      setRepoPath(null);
      setWorktrees([]);
      localStorage.removeItem("selectedRepoPath");
    }
  }, [repoPath]);

  const scanRepos = useCallback((basePath: string) => {
    socketRef.current?.emit("repo:scan", basePath);
  }, []);

  // Worktree actions
  const createWorktree = useCallback(
    (branchName: string, baseBranch?: string) => {
      if (!repoPath) return;
      socketRef.current?.emit("worktree:create", { repoPath, branchName, baseBranch });
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
  const startSession = useCallback((worktreeId: string, worktreePath: string) => {
    socketRef.current?.emit("session:start", { worktreeId, worktreePath });
  }, []);

  const stopSession = useCallback((sessionId: string) => {
    socketRef.current?.emit("session:stop", sessionId);
  }, []);

  const sendMessage = useCallback((sessionId: string, message: string) => {
    socketRef.current?.emit("session:send", { sessionId, message });
  }, []);

  const sendKey = useCallback(
    (sessionId: string, key: SpecialKey) => {
      socketRef.current?.emit("session:key", { sessionId, key });
    },
    []
  );

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

  // Image upload actions
  const uploadImage = useCallback(
    (sessionId: string, base64Data: string, mimeType: string) => {
      setImageUploadResult(null);
      setImageUploadError(null);
      socketRef.current?.emit("image:upload", { sessionId, base64Data, mimeType });
    },
    []
  );

  const clearImageUploadState = useCallback(() => {
    setImageUploadResult(null);
    setImageUploadError(null);
  }, []);

  // Beaconメッセージ送信
  const beaconSend = useCallback((message: string) => {
    socketRef.current?.emit("beacon:send", { message });
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

  // Beaconチャット履歴クリア（セッションは維持、サーバーには送信しない）
  const beaconClear = useCallback(() => {
    setBeaconMessages([]);
    setBeaconStreaming(false);
    setBeaconStreamText("");
  }, []);

  // Copy buffer action
  const copyBuffer = useCallback(
    (sessionId: string): Promise<string | null> => {
      return new Promise((resolve) => {
        if (!socketRef.current) {
          resolve(null);
          return;
        }
        socketRef.current.emit("session:copy", sessionId, (response: { text?: string; error?: string }) => {
          if (response.text) {
            resolve(response.text);
          } else {
            console.error("[Socket] Copy buffer error:", response.error);
            resolve(null);
          }
        });
      });
    },
    []
  );

  return {
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
    // Image upload
    uploadImage,
    imageUploadResult,
    imageUploadError,
    clearImageUploadState,
    // Copy buffer
    copyBuffer,
    // Beacon
    beaconMessages,
    beaconStreaming,
    beaconStreamText,
    beaconSend,
    beaconLoadHistory,
    beaconClose,
    beaconClear,
  };
}
