/**
 * Socket.IO Client Hook
 *
 * Provides real-time communication with the server for:
 * - Git worktree operations
 * - ttyd/tmux-based Claude Code session management
 */

import type {
  BridgeSessionStatus,
  BrowserSession,
  ClientToServerEvents,
  DiagramCommentsResponse,
  DiagramDeleteResponse,
  DiagramListItem,
  FsListResult,
  ManagedSession,
  MessageShortcut,
  Profile,
  RepoInfo,
  ServerToClientEvents,
  SessionGridSnapshot,
  SpecialKey,
  SystemCapabilities,
  UsageProgress,
  UsageReport,
  Worktree,
} from "@ark/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { toast } from "sonner";
import {
  requestDiagramCommentCreate,
  requestDiagramCommentDelete,
  requestDiagramCommentReply,
  requestDiagramCommentResolve,
  requestDiagramCommentSend,
  requestDiagramCommentsGet,
} from "../lib/diagram-comment-transport";
import { requestDiagramDelete } from "../lib/diagram-delete-transport";
import type {
  SessionAuqSignal,
  SessionStatusSignal,
} from "../lib/session-notifications";
import {
  addWorktree,
  clearRepo,
  flattenWorktrees,
  pruneToRepos,
  removeWorktree,
  setRepoWorktrees,
  type WorktreesByRepo,
} from "./worktreesByRepo";

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
  diagramCommentsUpdate: {
    worktreePath: string;
    relPath: string;
    sequence: number;
  } | null;

  // Allowed repositories (from --repos option)
  allowedRepos: string[];

  // Repository scanning
  scannedRepos: RepoInfo[];
  isScanning: boolean;
  scanRepos: (basePath: string) => void;

  // Folder browser
  listDirectory: (path?: string) => Promise<FsListResult>;

  // Diagram list
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
    operationId: string,
    anchorId: string,
    body: string,
    anchorQuote?: string,
    anchorOccurrence?: number
  ) => Promise<DiagramCommentsResponse>;
  resolveDiagramComment: (
    sessionId: string,
    relPath: string,
    operationId: string,
    threadId: string
  ) => Promise<DiagramCommentsResponse>;
  replyDiagramComment: (
    sessionId: string,
    relPath: string,
    operationId: string,
    threadId: string,
    body: string
  ) => Promise<DiagramCommentsResponse>;
  deleteDiagramComment: (
    sessionId: string,
    relPath: string,
    operationId: string,
    threadId: string
  ) => Promise<DiagramCommentsResponse>;
  sendDiagramComment: (
    sessionId: string,
    relPath: string,
    operationId: string,
    threadId: string
  ) => Promise<DiagramCommentsResponse>;

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

  /** 通知判定用の最新statusシグナル（既存session:previewsから派生） */
  sessionStatusSignals: Map<string, SessionStatusSignal>;

  /** 通知判定用の最新AskUserQuestionシグナル（既存session:auqから派生） */
  sessionAuqSignals: Map<string, SessionAuqSignal>;

  /**
   * sessionId → AWAITING 時の確認 UI 生テキスト。
   * チャットビューのバナーで「何を聞かれているか」をそのまま表示する。
   * AWAITING でないセッションはエントリ自体が無い
   */
  sessionAwaitingTexts: Map<string, string>;

  // Browser sessions
  browserSessions: Map<string, BrowserSession>;
  browserError: string | null;
  startBrowser: () => void;
  stopBrowser: (browserId: string) => void;
  navigateBrowser: (url: string) => void;

  // プロファイル切替 (Linux限定)
  profiles: Profile[];
  /** repoPath → profileId のマップ (リポジトリのデフォルト) */
  repoProfileLinks: Map<string, string>;
  /** worktreePath → profileId のマップ (個別override、worktree個別が優先) */
  worktreeProfileLinks: Map<string, string>;
  capabilities: SystemCapabilities;
  loadProfiles: () => void;
  createProfile: (name: string, configDir: string) => void;
  updateProfile: (
    id: string,
    patch: { name?: string; configDir?: string }
  ) => void;
  deleteProfile: (id: string) => void;
  setRepoProfile: (repoPath: string, profileId: string | null) => void;
  setWorktreeProfile: (worktreePath: string, profileId: string | null) => void;
  /** worktreePath → カスタム表示名 のマップ。未設定の worktree は branch にフォールバック */
  worktreeDisplayNames: Map<string, string>;
  setWorktreeDisplayName: (
    worktreePath: string,
    displayName: string | null
  ) => void;
  restartSessionWithProfile: (sessionId: string) => void;

  // メッセージショートカット
  messageShortcuts: MessageShortcut[];
  createShortcut: (message: string) => void;
  updateShortcut: (
    id: string,
    patch: { message?: string; sortOrder?: number }
  ) => void;
  deleteShortcut: (id: string) => void;

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
  // worktree:* イベント受信時に最新の repoList で許可判定するための ref。
  // 登録外/削除済み repo への遅延 worktree:list や不正 payload で bucket が
  // 復活するのを防ぐ（毎レンダー同期。socket ハンドラは登録時クロージャから参照）。
  const repoListRef = useRef(repoList);
  repoListRef.current = repoList;
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

  // worktree は repoPath ごとに bucket 分けして保持する。
  // 単一配列で上書き保持していた旧実装は「現在選択中の1リポジトリ」分しか
  // worktree を持てず、リロード時に選択中以外のリポジトリの worktree が
  // サイドバーから丸ごと消えていた（複数 repo をまたいで同時に保持できなかった）。
  const [worktreesByRepo, setWorktreesByRepo] = useState<WorktreesByRepo>(
    () => new Map()
  );
  // 消費側（サイドバー等）へは全 repo を平坦化した配列で公開する（既存 API 互換）。
  const worktrees = useMemo(
    () => flattenWorktrees(worktreesByRepo, repoList),
    [worktreesByRepo, repoList]
  );
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
  const [diagramCommentsUpdate, setDiagramCommentsUpdate] = useState<{
    worktreePath: string;
    relPath: string;
    sequence: number;
  } | null>(null);

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
  const [sessionStatusSignals, setSessionStatusSignals] = useState<
    Map<string, SessionStatusSignal>
  >(new Map());
  const [sessionAuqSignals, setSessionAuqSignals] = useState<
    Map<string, SessionAuqSignal>
  >(new Map());

  // AWAITING 時の確認 UI 生テキスト (チャットビューのバナーで内容を表示する)。
  // AWAITING でないセッションは undefined になる
  const [sessionAwaitingTexts, setSessionAwaitingTexts] = useState<
    Map<string, string>
  >(new Map());

  // Browser session state
  const [browserSessions, setBrowserSessions] = useState<
    Map<string, BrowserSession>
  >(new Map());
  const [browserError, setBrowserError] = useState<string | null>(null);

  // プロファイル切替 (Linux限定)
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [repoProfileLinks, setRepoProfileLinks] = useState<Map<string, string>>(
    new Map()
  );
  const [worktreeProfileLinks, setWorktreeProfileLinks] = useState<
    Map<string, string>
  >(new Map());
  // worktreePath → カスタム表示名。プロファイル機能とは独立 (capabilities 不要)。
  const [worktreeDisplayNames, setWorktreeDisplayNames] = useState<
    Map<string, string>
  >(new Map());
  const [capabilities, setCapabilities] = useState<SystemCapabilities>({
    multiProfileSupported: false,
  });

  // メッセージショートカット（全リポジトリ共通）
  const [messageShortcuts, setMessageShortcuts] = useState<MessageShortcut[]>(
    []
  );

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

  // repoList の全リポジトリの worktree を取得する。
  // サーバーは repo:select 応答時に選択中repoの worktree:list しか返さないため、
  // これが無いと選択中以外のリポジトリの worktree がサイドバーに出ない
  // （リロードで「別リポジトリが丸ごと消える」原因）。接続時/repoList変化時に
  // 全repo分を明示的にリクエストし、不要になったrepoのbucketは掃除する。
  useEffect(() => {
    if (!isConnected) return;
    const socket = socketRef.current;
    if (!socket) return;
    setWorktreesByRepo(prev => pruneToRepos(prev, repoList));
    for (const repo of repoList) {
      socket.emit("worktree:list", repo);
    }
  }, [isConnected, repoList]);

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

    socket.on("diagram:comments-updated", data => {
      setDiagramCommentsUpdate(previous => ({
        ...data,
        sequence: (previous?.sequence ?? 0) + 1,
      }));
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
        // 当該repoのbucketだけを破棄する（他repoのworktreeは保持したまま）。
        setWorktreesByRepo(prev => clearRepo(prev, errorRepoPath));
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

    // Worktree events
    // 各イベントは payload の repoPath で bucket を特定して更新する。
    // repoPath ごとに分離保持するため、別 repo の遅延応答が届いても
    // その repo の bucket だけが更新され、他 repo を破壊しない
    // （旧実装の eventTargetRepoPath による stale-drop は不要になった）。
    //
    // worktree イベントを受理してよい repo か判定する allowlist。
    // 登録外/削除済み repo への遅延 worktree:list や不正な payload で、サイドバーに
    // 想定外の path が復活するのを防ぐ。runtime では非 string も来うる前提で type guard。
    // 空 path も弾く（repoList に含まれないため）。選択直後は confirmedRepoPathRef が
    // 同期更新済み（repo:set 参照）なので、repoList state 反映前の worktree:list も取りこぼさない。
    const isAllowedWorktreeRepo = (path: unknown): path is string =>
      typeof path === "string" &&
      (repoListRef.current.includes(path) ||
        path === confirmedRepoPathRef.current);

    // payload 健全性チェック。イベントは型付き（ServerToClientEvents）だが、
    // socket 境界では実行時に壊れた payload が届きうるため、helper へ渡す前に
    // Worktree の全必須フィールドの型・非空性を検証して例外終了や不正 state 流入を防ぐ。
    const isValidWorktree = (w: unknown): w is Worktree => {
      if (typeof w !== "object" || w === null) return false;
      const c = w as Record<string, unknown>;
      return (
        typeof c.id === "string" &&
        c.id.length > 0 &&
        typeof c.path === "string" &&
        c.path.length > 0 &&
        typeof c.branch === "string" &&
        typeof c.commit === "string" &&
        typeof c.isMain === "boolean" &&
        typeof c.isBare === "boolean"
      );
    };

    socket.on("worktree:list", ({ repoPath: listRepoPath, worktrees: wts }) => {
      if (!isAllowedWorktreeRepo(listRepoPath) || !Array.isArray(wts)) return;
      // worktree:list は repo の authoritative snapshot。不正 item を filter で
      // 黙って落とすと部分リストが「正」として保存され、schema drift / 壊れた
      // payload で worktree が静かに消える。1件でも不正なら list 全体を拒否する。
      if (!wts.every(isValidWorktree)) return;
      setWorktreesByRepo(prev => setRepoWorktrees(prev, listRepoPath, wts));
    });

    socket.on("worktree:created", ({ repoPath: eventRepoPath, worktree }) => {
      if (!isAllowedWorktreeRepo(eventRepoPath) || !isValidWorktree(worktree)) {
        return;
      }
      setWorktreesByRepo(prev => addWorktree(prev, eventRepoPath, worktree));
    });

    socket.on("worktree:deleted", ({ repoPath: eventRepoPath, worktreeId }) => {
      if (typeof worktreeId !== "string" || worktreeId.length === 0) return;
      // 信頼できない repo 由来のイベントで bucket / グローバル UI state を動かさない。
      // bucket 削除と deletedWorktreeId（該当ペインのクローズ等）はどちらも
      // allowlist repo のイベントに限定する（3 ハンドラで一貫した受理条件）。
      if (!isAllowedWorktreeRepo(eventRepoPath)) return;
      setWorktreesByRepo(prev =>
        removeWorktree(prev, eventRepoPath, worktreeId)
      );
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

    const handleAuqSignal = (data: { sessionId: string; at: number }) => {
      setSessionAuqSignals(prev => {
        const current = prev.get(data.sessionId);
        if (current && current.at >= data.at) return prev;
        return new Map(prev).set(data.sessionId, {
          sessionId: data.sessionId,
          at: data.at,
        });
      });
    };
    socket.on("session:auq", handleAuqSignal);

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
      setSessionStatusSignals(prev => {
        const next = new Map(prev);
        for (const p of previews) {
          next.set(p.sessionId, {
            sessionId: p.sessionId,
            status: p.bridgeStatus,
            at: p.timestamp,
          });
        }
        return next;
      });
      setSessionAwaitingTexts(prev => {
        const next = new Map(prev);
        for (const p of previews) {
          if (p.awaitingText) {
            next.set(p.sessionId, p.awaitingText);
          } else {
            next.delete(p.sessionId);
          }
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

    socket.on("worktree:profile-changed", ({ worktreePath, profileId }) => {
      setWorktreeProfileLinks(prev => {
        const next = new Map(prev);
        if (profileId) {
          next.set(worktreePath, profileId);
        } else {
          next.delete(worktreePath);
        }
        return next;
      });
    });

    socket.on("worktree:profile-links", links => {
      const next = new Map<string, string>();
      for (const link of links) next.set(link.worktreePath, link.profileId);
      setWorktreeProfileLinks(next);
    });

    // worktree カスタム表示名 ----------------------------------
    socket.on("worktree:display-names", names => {
      const next = new Map<string, string>();
      for (const n of names) next.set(n.worktreePath, n.displayName);
      setWorktreeDisplayNames(next);
    });

    socket.on(
      "worktree:display-name-changed",
      ({ worktreePath, displayName }) => {
        setWorktreeDisplayNames(prev => {
          const next = new Map(prev);
          if (displayName) {
            next.set(worktreePath, displayName);
          } else {
            next.delete(worktreePath);
          }
          return next;
        });
      }
    );

    // メッセージショートカット ----------------------------------
    socket.on("shortcut:list", list => {
      setMessageShortcuts(list);
    });

    socket.on("shortcut:created", shortcut => {
      setMessageShortcuts(prev =>
        prev.some(s => s.id === shortcut.id) ? prev : [...prev, shortcut]
      );
    });

    socket.on("shortcut:updated", shortcut => {
      setMessageShortcuts(prev =>
        prev.map(s => (s.id === shortcut.id ? shortcut : s))
      );
    });

    socket.on("shortcut:deleted", ({ id }) => {
      setMessageShortcuts(prev => prev.filter(s => s.id !== id));
    });

    socket.on("shortcut:error", ({ message, code }) => {
      console.error(`[shortcut] ${code ?? "error"}: ${message}`);
      toast.error(`ショートカット操作に失敗: ${message}`);
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

    // Cleanup on unmount
    return () => {
      socket.off("ports:list");
      socket.off("file:content");
      socket.off("session:auq", handleAuqSignal);
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
      // 除外したリポジトリの worktree bucket も破棄する（他repoは保持）
      setWorktreesByRepo(prev => clearRepo(prev, path));

      // 削除したリポジトリが選択中の場合はクリア
      if (repoPath === path) {
        // 全refを同期クリア（pendingが残ると以降のworktree:listが古いpathで誤フィルタされる）
        repoPathRef.current = null;
        pendingRepoPathRef.current = null;
        confirmedRepoPathRef.current = null;
        setRepoPath(null);
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

  const listDiagrams = useCallback(
    (worktreePath: string): Promise<DiagramListItem[]> => {
      return new Promise((resolve, reject) => {
        const socket = socketRef.current;
        if (!socket?.connected) {
          reject(new Error("ソケットが切断されています"));
          return;
        }

        let settled = false;
        const timeoutId = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error("図一覧の取得がタイムアウトしました"));
        }, 10000);

        socket.emit("diagram:list", { worktreePath }, response => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeoutId);
          if (response.ok) {
            resolve(response.diagrams);
          } else {
            reject(new Error(response.error));
          }
        });
      });
    },
    []
  );

  const deleteDiagram = useCallback(
    (sessionId: string, relPath: string, expectedTracked: boolean) =>
      requestDiagramDelete(
        socketRef.current,
        sessionId,
        relPath,
        expectedTracked
      ),
    []
  );

  const getDiagramComments = useCallback(
    (sessionId: string, relPath: string) =>
      requestDiagramCommentsGet(socketRef.current, sessionId, relPath),
    []
  );

  // mutation の operationId は iframe（comment layer）が生成し、ここでは
  // 透過的に transport へ渡す。再試行で同じ値が届けばサーバー側で冪等化される
  const createDiagramComment = useCallback(
    (
      sessionId: string,
      relPath: string,
      operationId: string,
      anchorId: string,
      body: string,
      anchorQuote?: string,
      anchorOccurrence?: number
    ) =>
      requestDiagramCommentCreate(
        socketRef.current,
        sessionId,
        relPath,
        operationId,
        anchorId,
        body,
        anchorQuote,
        anchorOccurrence
      ),
    []
  );

  const resolveDiagramComment = useCallback(
    (
      sessionId: string,
      relPath: string,
      operationId: string,
      threadId: string
    ) =>
      requestDiagramCommentResolve(
        socketRef.current,
        sessionId,
        relPath,
        operationId,
        threadId
      ),
    []
  );

  const replyDiagramComment = useCallback(
    (
      sessionId: string,
      relPath: string,
      operationId: string,
      threadId: string,
      body: string
    ) =>
      requestDiagramCommentReply(
        socketRef.current,
        sessionId,
        relPath,
        operationId,
        threadId,
        body
      ),
    []
  );

  const deleteDiagramComment = useCallback(
    (
      sessionId: string,
      relPath: string,
      operationId: string,
      threadId: string
    ) =>
      requestDiagramCommentDelete(
        socketRef.current,
        sessionId,
        relPath,
        operationId,
        threadId
      ),
    []
  );

  const sendDiagramComment = useCallback(
    (
      sessionId: string,
      relPath: string,
      operationId: string,
      threadId: string
    ) =>
      requestDiagramCommentSend(
        socketRef.current,
        sessionId,
        relPath,
        operationId,
        threadId
      ),
    []
  );

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

  const setWorktreeProfile = useCallback(
    (worktreePath: string, profileId: string | null) => {
      socketRef.current?.emit("worktree:set-profile", {
        worktreePath,
        profileId,
      });
    },
    []
  );

  const setWorktreeDisplayName = useCallback(
    (worktreePath: string, displayName: string | null) => {
      socketRef.current?.emit("worktree:set-display-name", {
        worktreePath,
        displayName,
      });
    },
    []
  );

  const restartSessionWithProfile = useCallback((sessionId: string) => {
    socketRef.current?.emit("session:restart-with-profile", { sessionId });
  }, []);

  // メッセージショートカット actions
  const createShortcut = useCallback((message: string) => {
    socketRef.current?.emit("shortcut:create", { message });
  }, []);

  const updateShortcut = useCallback(
    (id: string, patch: { message?: string; sortOrder?: number }) => {
      socketRef.current?.emit("shortcut:update", { id, ...patch });
    },
    []
  );

  const deleteShortcut = useCallback((id: string) => {
    socketRef.current?.emit("shortcut:delete", { id });
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
    diagramCommentsUpdate,
    allowedRepos,
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
    sessionAwaitingTexts,
    sessionStatusSignals,
    sessionAuqSignals,
    gridSnapshots,
    subscribeGrid,
    unsubscribeGrid,
    sessionStatuses,
    // Browser sessions
    browserSessions,
    browserError,
    startBrowser,
    stopBrowser,
    navigateBrowser,
    // プロファイル切替 (Linux限定)
    profiles,
    repoProfileLinks,
    worktreeProfileLinks,
    capabilities,
    loadProfiles,
    createProfile,
    updateProfile,
    deleteProfile,
    setRepoProfile,
    setWorktreeProfile,
    worktreeDisplayNames,
    setWorktreeDisplayName,
    restartSessionWithProfile,
    // メッセージショートカット
    messageShortcuts,
    createShortcut,
    updateShortcut,
    deleteShortcut,
    // Usage取得
    usageRequesting,
    usageProgress,
    usageReport,
    usageError,
    requestUsage,
    clearUsageError,
  };
}
