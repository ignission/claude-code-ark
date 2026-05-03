/**
 * Socket.IO Client Hook
 *
 * Provides real-time communication with the server for:
 * - Git worktree operations
 * - ttyd/tmux-based Claude Code session management
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { toast } from "sonner";
import type {
  BeaconStreamChunk,
  BridgeSessionStatus,
  BrowserSession,
  ChatMessage,
  ClientToServerEvents,
  FsListResult,
  ManagedSession,
  McpConnectionInfo,
  McpProviderCatalog,
  McpProvidersSnapshot,
  Profile,
  RepoInfo,
  ServerToClientEvents,
  SessionGridSnapshot,
  SpecialKey,
  SystemCapabilities,
  UsageProgress,
  UsageReport,
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

  // Folder browser
  listDirectory: (path?: string) => Promise<FsListResult>;

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
  sessionsLoaded: boolean;
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

  // Repo Grid View (主 Dashboard 用、購読中のみ更新される)
  /** sessionId → 最新スナップショット。購読していなければ空 */
  gridSnapshots: Map<string, SessionGridSnapshot>;
  /** RepoGridView マウント時に呼ぶ。購読中は 1.5秒ごとに gridSnapshots が更新される */
  subscribeGrid: () => void;
  /** RepoGridView アンマウント時に呼ぶ */
  unsubscribeGrid: () => void;

  /**
   * sessionId → BridgeSessionStatus。session:previews ペイロードから派生。
   * RepoGridView 購読の有無に関わらず常に最新化されるので、サイドバードット色等で利用する。
   */
  sessionStatuses: Map<string, BridgeSessionStatus>;

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

  // プロファイル切替 (Linux限定)
  profiles: Profile[];
  /** repoPath → profileId のマップ */
  repoProfileLinks: Map<string, string>;
  capabilities: SystemCapabilities;
  loadProfiles: () => void;
  createProfile: (name: string, configDir: string) => void;
  updateProfile: (
    id: string,
    patch: { name?: string; configDir?: string }
  ) => void;
  deleteProfile: (id: string) => void;
  setRepoProfile: (repoPath: string, profileId: string | null) => void;
  restartSessionWithProfile: (sessionId: string) => void;

  // MCP server (Beacon の外部 OAuth MCP) — マルチアカウント
  mcpCatalog: McpProviderCatalog[];
  mcpConnections: McpConnectionInfo[];
  /** 認可フロー進行中の connectionId → authorizationUrl */
  mcpPendingAuthUrls: Record<string, string>;
  mcpRefresh: () => void;
  mcpConnect: (
    providerId: string,
    options?: { label?: string; connectionId?: string }
  ) => void;
  mcpSubmitRedirect: (redirectUrl: string) => void;
  mcpDisconnect: (connectionId: string) => void;
  mcpAuthCancel: (connectionId: string) => void;
  mcpRename: (connectionId: string, label: string) => void;

  // Usage取得 (Linux + multiProfileSupported 限定)
  /** /usage 取得が進行中か（全クライアント横断ではなく、自身が依頼中の状態） */
  usageRequesting: boolean;
  /** 直近の取得進捗（取得開始まで null） */
  usageProgress: UsageProgress | null;
  /** 直近の取得結果（成功時のみ更新） */
  usageReport: UsageReport | null;
  /** 直近の usage:error メッセージ */
  usageError: string | null;
  /** Usage取得を要求する */
  requestUsage: () => void;
  /** UI側で表示済みのusageErrorをクリア */
  clearUsageError: () => void;
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
  /**
   * 直近のクライアント選択。`repo:set` 応答の out-of-order 適用を抑制するのに使う。
   * selectRepoで更新し、repo:set受信時に一致しなければ無視する（stale応答）。
   */
  const pendingRepoPathRef = useRef<string | null>(null);
  /**
   * server側が確認(`repo:set`)を返したrepoPath。
   * 同一pathの重複selectで一方が失敗してもロールバックしないよう、
   * `repo:error` のロールバック判定で「確認済みstate」と「楽観state」を区別するために使う。
   */
  const confirmedRepoPathRef = useRef<string | null>(null);

  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [deletedWorktreeId, setDeletedWorktreeId] = useState<string | null>(
    null
  );
  const [sessions, setSessions] = useState<Map<string, ManagedSession>>(
    new Map()
  );
  // session:list を一度でも受信したか。
  // 空配列でも true になるため、リロード直後の savedId 復元処理で
  // 「サーバ側にセッションが存在しない」ことを判定できる。
  const [sessionsLoaded, setSessionsLoaded] = useState(false);

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

  // Repo Grid View 用 (主 Dashboard が購読中のみ更新)
  const [gridSnapshots, setGridSnapshots] = useState<
    Map<string, SessionGridSnapshot>
  >(new Map());

  // BridgeSessionStatus を session:previews から取り出して保持。
  // サイドバードット色用。RepoGridView 購読の有無に関わらず常時更新される。
  const [sessionStatuses, setSessionStatuses] = useState<
    Map<string, BridgeSessionStatus>
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

  // プロファイル切替 (Linux限定)
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [repoProfileLinks, setRepoProfileLinks] = useState<Map<string, string>>(
    new Map()
  );
  const [capabilities, setCapabilities] = useState<SystemCapabilities>({
    multiProfileSupported: false,
  });

  // MCP server (Beacon の外部 OAuth MCP) — マルチアカウント
  const [mcpCatalog, setMcpCatalog] = useState<McpProviderCatalog[]>([]);
  const [mcpConnections, setMcpConnections] = useState<McpConnectionInfo[]>([]);
  // 認可フロー進行中の connectionId → authorize URL。
  // ポップアップブロック時のフォールバックでダイアログから手動でリンクを開けるようにするため保持する。
  const [mcpPendingAuthUrls, setMcpPendingAuthUrls] = useState<
    Record<string, string>
  >({});
  // toast 内で connection の label を解決するための安定参照
  const mcpConnectionsRef = useRef<McpConnectionInfo[]>([]);
  useEffect(() => {
    mcpConnectionsRef.current = mcpConnections;
  }, [mcpConnections]);
  /**
   * `mcpConnect` 呼び出し時にユーザクリック由来で開いた空ポップアップの FIFO キュー。
   * providerId をキーに配列で保持する: 同 provider に対して短時間に複数 connect が
   * 走った場合、後勝ちで上書きすると先のリクエストの popup ref が失われるため。
   * `mcp:auth-started` 到着時に該当 provider の最古エントリを取り出して navigate する。
   */
  const mcpPendingPopupsRef = useRef<Record<string, Window[]>>({});

  // Usage取得
  const [usageRequesting, setUsageRequesting] = useState(false);
  const [usageProgress, setUsageProgress] = useState<UsageProgress | null>(
    null
  );
  const [usageReport, setUsageReport] = useState<UsageReport | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);

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
        // 切断中に未確定のpendingが残っているとre-emit後の repo:set を stale 判定で
        // 落としてしまうため、pendingを復元対象pathに揃える
        pendingRepoPathRef.current = repoPathRef.current;
        socket.emit("repo:select", repoPathRef.current);
      }

      // grid 購読中だった場合は再購読する。
      // サーバ側は disconnect 時に interval を破棄するので、再接続後は再 emit が必須。
      if (gridSubscribedRef.current) {
        socket.emit("session:grid:subscribe");
      }

      // MCP server スナップショットを再取得 (切断中に他クライアントが追加/削除した
      // 変更や、進行中フローの完了通知をミスっている可能性があるため)。
      socket.emit("mcp:state");
    });

    socket.on("disconnect", () => {
      console.log("Socket disconnected");
      setIsConnected(false);
      // 切断中に usage:complete/usage:error を受け損ねるとボタンが永遠に
      // disabled になるため、進行中フラグもリセットする。
      // (再接続後に再度 requestUsage を呼べる状態に戻す)
      setUsageRequesting(false);
      setUsageProgress(null);
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
      // stale応答を無視: 直近の selectRepo 呼び出しの期待pathと一致しない場合、
      // これはより古い selectRepo の遅延応答なのでスキップする。
      // pendingは一致してもクリアしない（後から到着する古い応答で上書きされないようにするため）。
      const pending = pendingRepoPathRef.current;
      if (pending !== null && pending !== path) return;

      // server側で repo:set 直後に worktree:list が emit されるため、refをuseEffect待たず
      // 同期更新する。これがないと続く worktree:list が古いrefと比較されdropされる。
      repoPathRef.current = path;
      // server確認済みstateを記録（重複selectの後続エラーでロールバックしないために使用）
      confirmedRepoPathRef.current = path;
      setRepoPath(path);

      // リポジトリリストに追加（重複しない場合）
      // コールバック通知はuseEffectで行う（StrictMode二重実行対策）
      setRepoList(prev => {
        if (prev.includes(path)) return prev;
        return [...prev, path];
      });

      setError(null);
    });

    socket.on("repo:error", ({ repoPath: errorRepoPath, error: errMsg }) => {
      // 全般エラー(repoに紐付かないerror)は選択状態に触らずエラー表示のみ。
      // selectRepo楽観更新のロールバックは特定repoに対するerrorに限定する
      if (errorRepoPath === null) {
        setError(errMsg);
        return;
      }
      // stale error: 新しい選択がすでに成功している場合、古いエラーのロールバックを適用しない
      const pending = pendingRepoPathRef.current;
      if (pending !== null && errorRepoPath !== pending) {
        return;
      }
      // 同一pathに対する重複selectで、既にserver確認済み（confirmedRepoPathRef==errorRepoPath）の
      // 場合は後続エラーをロールバックしない。repoPathRefは楽観更新値も含むため、
      // 確認済みstateを表す confirmedRepoPathRef で判定する必要がある。
      if (errorRepoPath === confirmedRepoPathRef.current) {
        setError(errMsg);
        // server側がrepo:set後にworktree取得で失敗するケース（listWorktrees throw 等）。
        // worktreesは前repoのstaleデータが残るため、確認済みrepoには有効データがない事を表すため空にする。
        setWorktrees([]);
        return;
      }
      setError(errMsg);
      // 楽観的更新のロールバック（selectRepoで先行設定したrepoPathを戻す）
      // pendingもクリアし以降のworktreeイベントをデフォルト判定（refベース）に戻す
      repoPathRef.current = null;
      pendingRepoPathRef.current = null;
      confirmedRepoPathRef.current = null;
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

    /**
     * worktree系イベントの受け入れ判定。
     * ユーザーの最新意図 (pendingRepoPathRef) を最優先で使用し、未設定時は確認済み (repoPathRef) で判定する。
     * pendingベースで判定する理由: 直前のselectRepo(B)後にA向け遅延応答が届いた場合、
     * refはまだAだが意図はBなので、Aのlistを誤って適用しないようにする。
     */
    const eventTargetRepoPath = (): string | null =>
      pendingRepoPathRef.current ?? repoPathRef.current;

    // Worktree events
    socket.on("worktree:list", ({ repoPath: listRepoPath, worktrees: wts }) => {
      const target = eventTargetRepoPath();
      if (target !== null && listRepoPath !== target) return;
      setWorktrees(wts);
    });

    socket.on("worktree:created", ({ repoPath: eventRepoPath, worktree }) => {
      const target = eventTargetRepoPath();
      if (target !== null && eventRepoPath !== target) return;
      setWorktrees(prev => [...prev, worktree]);
    });

    socket.on("worktree:deleted", ({ repoPath: eventRepoPath, worktreeId }) => {
      const target = eventTargetRepoPath();
      if (target !== null && eventRepoPath !== target) return;
      setWorktrees(prev => prev.filter(w => w.id !== worktreeId));
      setDeletedWorktreeId(worktreeId);
    });

    socket.on("worktree:error", err => {
      setError(err);
    });

    // Session events (ttyd-based)
    const updateSession = (session: ManagedSession): void => {
      setSessions(prev => new Map(prev).set(session.id, session));
    };

    socket.on("session:list", (sessions: ManagedSession[]) => {
      // session:list はサーバ側の権威ある全件スナップショット。
      // 再接続時に死んだセッションが残らないよう、マージではなく置き換える。
      setSessions(new Map(sessions.map(s => [s.id, s])));
      setSessionsLoaded(true);
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

    // 外部メッセージ (Usage取得結果など)。streaming state には影響させない
    // (LLM応答 streaming 中に到着しても応答を切り捨てない)。
    socket.on("beacon:external-message", (message: ChatMessage) => {
      setBeaconMessages(prev => [...prev, message]);
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
      // BridgeSessionStatus は Bridge collector の判定結果。サイドバードット色を
      // RepoGridView と揃えるために sessionStatuses Map に保持する。
      setSessionStatuses(prev => {
        const next = new Map(prev);
        for (const p of previews) {
          next.set(p.sessionId, p.bridgeStatus);
        }
        return next;
      });
    });

    // Repo Grid View
    socket.on("session:grid:snapshot", snapshots => {
      setGridSnapshots(prev => {
        const next = new Map(prev);
        // 配信は「現在の全セッション」なので、購読中のスナップショットで全置換する
        next.clear();
        for (const s of snapshots) {
          next.set(s.sessionId, s);
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

    // プロファイル切替 (Linux限定) ----------------------------------
    socket.on("system:capabilities", caps => {
      setCapabilities(caps);
      // 機能利用可能ならプロファイル一覧を初回取得
      if (caps.multiProfileSupported) {
        socket.emit("profile:list");
      }
    });

    socket.on("profile:list", list => {
      setProfiles(list);
    });

    socket.on("profile:created", profile => {
      // サーバー側でも profile:list を再emitするが、即時反映のため楽観更新
      setProfiles(prev =>
        prev.some(p => p.id === profile.id) ? prev : [...prev, profile]
      );
    });

    socket.on("profile:updated", profile => {
      setProfiles(prev => prev.map(p => (p.id === profile.id ? profile : p)));
    });

    socket.on("profile:deleted", ({ id }) => {
      setProfiles(prev => prev.filter(p => p.id !== id));
    });

    socket.on("profile:error", ({ message, code }) => {
      console.error("[Socket] Profile error:", message, code);
      toast.error(message);
    });

    socket.on("repo:profile-changed", ({ repoPath, profileId }) => {
      setRepoProfileLinks(prev => {
        const next = new Map(prev);
        if (profileId) {
          next.set(repoPath, profileId);
        } else {
          next.delete(repoPath);
        }
        return next;
      });
    });

    // 初期同期: 接続時に全紐付けをまとめて受信 (リロード時のバッジ復元用)
    socket.on("repo:profile-links", links => {
      const next = new Map<string, string>();
      for (const link of links) next.set(link.repoPath, link.profileId);
      setRepoProfileLinks(next);
    });

    // Usage取得イベント
    socket.on("usage:progress", progress => {
      setUsageProgress(progress);
    });

    socket.on("usage:complete", report => {
      setUsageReport(report);
      setUsageProgress(null);
      // 完了 toast は要求元クライアントだけに出す。
      // server は io.emit でブロードキャストしているため、別タブ/別デバイス
      // にも届くが、それらは usageRequesting=false なので toast を出さない。
      // (functional setState で前値を読み取り、true→false 遷移時のみ通知)
      setUsageRequesting(prev => {
        if (prev) {
          const okCount = report.entries.filter(e => e.status === "ok").length;
          toast.success(
            `Usage取得完了: ${okCount}/${report.entries.length} プロファイル`
          );
        }
        return false;
      });
    });

    socket.on("usage:error", ({ message }) => {
      setUsageError(message);
      setUsageRequesting(false);
      setUsageProgress(null);
      toast.error(`Usage取得に失敗: ${message}`);
    });

    // MCP server (Beacon の外部 OAuth MCP) ----------------------------
    socket.on("mcp:state", (snapshot: McpProvidersSnapshot) => {
      setMcpCatalog(snapshot.catalog);
      setMcpConnections(snapshot.connections);
      // 認可 URL は server snapshot を source of truth にする。
      // - リロード / 再接続後でも進行中フローの URL を復元できる
      // - cancel / disconnect 後は server 側で消えているのでクライアントも自動掃除
      setMcpPendingAuthUrls(snapshot.pendingAuthUrls);
    });
    socket.on("mcp:auth-started", ({ connectionId, authorizationUrl }) => {
      // ポップアップブロック等のフォールバック用にダイアログ内のリンクへ残す
      setMcpPendingAuthUrls(prev => ({
        ...prev,
        [connectionId]: authorizationUrl,
      }));
      // mcpConnect で同期文脈で開いた空ポップアップ FIFO キューから最古エントリを取り出し、
      // authorizationUrl へ navigate する (非同期 window.open はブロックされるため)。
      // connectionId 形式: `<providerId>-<nanoid>`。再認証では既存 connectionId なので
      // providerId 部分のみ取り出してキュー検索。
      const providerId = connectionId.split("-")[0];
      const queue =
        providerId !== undefined
          ? mcpPendingPopupsRef.current[providerId]
          : undefined;
      let navigated = false;
      while (queue && queue.length > 0) {
        const popup = queue.shift();
        if (!popup || popup.closed) continue;
        try {
          popup.location.href = authorizationUrl;
          navigated = true;
          break;
        } catch {
          // クロスオリジンで弾かれた等 → 次の候補を試す
        }
      }
      if (navigated) {
        toast.success("認可ページを開きました", {
          description: "ブラウザで認証を完了してください",
        });
        return;
      }
      // popup ref が無い (= ブロックされた) → ユーザに手動オープンを促す
      toast.error("ポップアップがブロックされました", {
        description:
          "ダイアログ内の「認可ページを開く」リンクから手動で開いてください",
      });
    });
    socket.on("mcp:auth-completed", ({ connectionId }) => {
      setMcpPendingAuthUrls(prev => {
        const next = { ...prev };
        delete next[connectionId];
        return next;
      });
      const label =
        mcpConnectionsRef.current.find(c => c.id === connectionId)?.label ??
        connectionId;
      toast.success(`${label} を認証しました`);
    });
    socket.on("mcp:auth-failed", ({ connectionId, message }) => {
      setMcpPendingAuthUrls(prev => {
        const next = { ...prev };
        delete next[connectionId];
        return next;
      });
      const label =
        mcpConnectionsRef.current.find(c => c.id === connectionId)?.label ??
        connectionId;
      toast.error(`${label} の認証に失敗`, { description: message });
    });
    socket.on("mcp:error", ({ message }) => {
      toast.error(message);
    });
    // 接続時にカタログ + connection 一覧を取得
    socket.emit("mcp:state");

    // Cleanup on unmount
    return () => {
      socket.off("ports:list");
      socket.off("file:content");
      socket.off("beacon:message");
      socket.off("beacon:external-message");
      socket.off("beacon:stream");
      socket.off("beacon:history");
      socket.off("beacon:error");
      socket.off("session:previews");
      socket.off("session:grid:snapshot");
      socket.off("browser:started");
      socket.off("browser:stopped");
      socket.off("browser:error");
      socket.off("usage:progress");
      socket.off("usage:complete");
      socket.off("usage:error");
      socket.disconnect();
    };
  }, [enabled]);

  // Repository actions
  const selectRepo = useCallback((path: string) => {
    // repo:setハンドラがstale応答を無視できるよう、直近の期待pathを記録する。
    // repoPathRef は repo:set 確定時に useEffect 経由で同期する（楽観更新しない理由は、
    // 切り替えが拒否された場合に古いrepoのworktree更新を誤って捨てないため）。
    pendingRepoPathRef.current = path;
    setRepoPath(path);
    socketRef.current?.emit("repo:select", path);
  }, []);

  const removeRepo = useCallback(
    (path: string) => {
      // コールバック通知はuseEffectで行う（StrictMode二重実行対策）
      setRepoList(prev => prev.filter(p => p !== path));

      // 削除したリポジトリが選択中の場合はクリア
      if (repoPath === path) {
        // 全refを同期クリア（pendingが残ると以降のworktree:listが古いpathで誤フィルタされる）
        repoPathRef.current = null;
        pendingRepoPathRef.current = null;
        confirmedRepoPathRef.current = null;
        setRepoPath(null);
        setWorktrees([]);
      }
    },
    [repoPath]
  );

  const scanRepos = useCallback((basePath: string) => {
    socketRef.current?.emit("repo:scan", basePath);
  }, []);

  // フォルダ選択ダイアログ用: 指定パス配下のサブディレクトリを取得
  const listDirectory = useCallback((path?: string): Promise<FsListResult> => {
    return new Promise((resolve, reject) => {
      const socket = socketRef.current;
      if (!socket?.connected) {
        reject(new Error("ソケットが切断されています"));
        return;
      }
      const timeoutId = window.setTimeout(() => {
        reject(new Error("ディレクトリ取得がタイムアウトしました"));
      }, 10000);
      socket.emit("fs:list", { path }, response => {
        window.clearTimeout(timeoutId);
        if (response.result) {
          resolve(response.result);
        } else {
          reject(new Error(response.error ?? "ディレクトリ取得に失敗しました"));
        }
      });
    });
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
    // 無通知で消えるとUX上「送信したのに何も起きない」に見えるのでエラー通知する
    const socket = socketRef.current;
    if (!socket?.connected) {
      setError("サーバーに接続していません。再接続後に再送してください。");
      return;
    }
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

  // プロファイル切替 (Linux限定) actions
  const loadProfiles = useCallback(() => {
    socketRef.current?.emit("profile:list");
  }, []);

  const createProfile = useCallback((name: string, configDir: string) => {
    socketRef.current?.emit("profile:create", { name, configDir });
  }, []);

  const updateProfile = useCallback(
    (id: string, patch: { name?: string; configDir?: string }) => {
      socketRef.current?.emit("profile:update", { id, ...patch });
    },
    []
  );

  const deleteProfile = useCallback((id: string) => {
    socketRef.current?.emit("profile:delete", { id });
  }, []);

  const setRepoProfile = useCallback(
    (repoPath: string, profileId: string | null) => {
      socketRef.current?.emit("repo:set-profile", {
        repoPath,
        profileId,
      });
    },
    []
  );

  const restartSessionWithProfile = useCallback((sessionId: string) => {
    socketRef.current?.emit("session:restart-with-profile", { sessionId });
  }, []);

  // MCP server (Beacon の外部 OAuth MCP) actions
  const mcpRefresh = useCallback(() => {
    socketRef.current?.emit("mcp:state");
  }, []);
  const mcpConnect = useCallback(
    (
      providerId: string,
      options?: { label?: string; connectionId?: string }
    ) => {
      // ポップアップブロック対策: ボタンクリック由来 (この関数の同期実行コンテキスト) で
      // window.open する必要がある。authorize URL は server から非同期で返ってくるので
      // 先に about:blank で空ウィンドウを開いておき、`mcp:auth-started` 受信時に
      // location を差し替える。同 provider に複数 connect が並走しうるため FIFO キューで保持。
      // 注: `noopener` を付けると window 仕様で detached / null が返る browser がある
      // (後で popup.location.href を設定できなくなる)。
      // 開いたあと navigate するまでは opener が必要なので features 文字列は空にする。
      const popup = window.open("about:blank", "_blank");
      if (popup) {
        const queue = (mcpPendingPopupsRef.current[providerId] ??= []);
        queue.push(popup);
      }
      socketRef.current?.emit("mcp:connect", {
        providerId,
        ...(options?.label !== undefined ? { label: options.label } : {}),
        ...(options?.connectionId !== undefined
          ? { connectionId: options.connectionId }
          : {}),
      });
    },
    []
  );
  const mcpSubmitRedirect = useCallback((redirectUrl: string) => {
    socketRef.current?.emit("mcp:submit-redirect", { redirectUrl });
  }, []);
  const mcpDisconnect = useCallback((connectionId: string) => {
    socketRef.current?.emit("mcp:disconnect", { connectionId });
  }, []);
  const mcpAuthCancel = useCallback((connectionId: string) => {
    socketRef.current?.emit("mcp:auth-cancel", { connectionId });
  }, []);
  const mcpRename = useCallback((connectionId: string, label: string) => {
    socketRef.current?.emit("mcp:rename", { connectionId, label });
  }, []);

  // Usage取得
  const requestUsage = useCallback(() => {
    if (usageRequesting) return;
    // 未接続でemitすると永遠に応答が返らず、ボタンがリロードまでdisabledになる。
    // socket未確立 or 切断中なら何もせずユーザに通知する。
    if (!socketRef.current?.connected) {
      toast.error(
        "サーバーに接続されていません。少し待ってから再試行してください"
      );
      return;
    }
    setUsageError(null);
    setUsageRequesting(true);
    setUsageProgress(null);
    socketRef.current.emit("usage:request");
    toast.info("Usage取得を開始しました（数十秒かかります）");
  }, [usageRequesting]);

  const clearUsageError = useCallback(() => {
    setUsageError(null);
  }, []);

  // Repo Grid View 購読
  // 再接続対応: サーバ側は disconnect 時に interval を破棄するので、
  // クライアント側で「現在購読中か」を ref に持ち、connect 時に都度 re-emit する。
  const gridSubscribedRef = useRef(false);

  const subscribeGrid = useCallback(() => {
    gridSubscribedRef.current = true;
    socketRef.current?.emit("session:grid:subscribe");
  }, []);

  const unsubscribeGrid = useCallback(() => {
    gridSubscribedRef.current = false;
    socketRef.current?.emit("session:grid:unsubscribe");
    setGridSnapshots(new Map());
  }, []);

  return {
    socket: socketRef.current,
    isConnected,
    error,
    allowedRepos,
    scannedRepos,
    isScanning,
    scanRepos,
    listDirectory,
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
    sessionsLoaded,
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
    gridSnapshots,
    subscribeGrid,
    unsubscribeGrid,
    sessionStatuses,
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
    // プロファイル切替 (Linux限定)
    profiles,
    repoProfileLinks,
    capabilities,
    loadProfiles,
    createProfile,
    updateProfile,
    deleteProfile,
    setRepoProfile,
    restartSessionWithProfile,
    // MCP server (Beacon の外部 OAuth MCP) — マルチアカウント
    mcpCatalog,
    mcpConnections,
    mcpPendingAuthUrls,
    mcpRefresh,
    mcpConnect,
    mcpSubmitRedirect,
    mcpDisconnect,
    mcpAuthCancel,
    mcpRename,
    // Usage取得
    usageRequesting,
    usageProgress,
    usageReport,
    usageError,
    requestUsage,
    clearUsageError,
  };
}
