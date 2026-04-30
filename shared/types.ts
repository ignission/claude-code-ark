// Shared types between client and server

export interface Worktree {
  id: string;
  path: string;
  branch: string;
  commit: string;
  isMain: boolean;
  isBare: boolean;
}

/**
 * リポジトリ情報
 * scanRepositories関数で返される型
 */
export interface RepoInfo {
  /** リポジトリのフルパス */
  path: string;
  /** リポジトリのディレクトリ名 */
  name: string;
  /** 現在のブランチ名 */
  branch: string;
}

/** フォルダブラウザ: ディレクトリエントリ */
export interface FsEntry {
  /** ディレクトリ名 */
  name: string;
  /** 絶対パス */
  path: string;
  /** `.` 始まりかどうか */
  isHidden: boolean;
}

/** フォルダブラウザ: ディレクトリ一覧結果 */
export interface FsListResult {
  /** 正規化済みの現在パス */
  path: string;
  /** 親ディレクトリパス（ルート時はnull） */
  parent: string | null;
  /** サブディレクトリ一覧 */
  entries: FsEntry[];
}

export interface Session {
  id: string;
  worktreeId: string;
  worktreePath: string;
  /** セッションが属するリポジトリのルートパス（既存セッション互換のためoptional） */
  repoPath?: string;
  status: SessionStatus;
  createdAt: Date;
  /** 起動時に確定したプロファイルID（未紐付けはnull/undefined） */
  profileId?: string | null;
  /** 起動時に確定したプロファイルのconfigDir（configDir変更検出用） */
  profileConfigDir?: string | null;
}

/**
 * ttyd/tmux統合されたセッション情報
 *
 * Session を拡張し、tmuxセッション名とttyd接続情報を含む。
 * サーバー側のSessionOrchestratorとクライアント側の両方で共通して使用する。
 */
export interface ManagedSession extends Session {
  /** tmuxセッション名 */
  tmuxSessionName: string;
  /** ttydのポート番号（未起動時はnull） */
  ttydPort: number | null;
  /** ttydのURL（未起動時はnull） */
  ttydUrl: string | null;
  /** セッション起動時に確定したプロファイルID（未紐付けはnull/undefined） */
  profileId?: string | null;
  /** 現在のリポジトリ紐付けと不一致（再起動が必要） */
  staleProfile?: boolean;
}

/**
 * Claude CLIの設定ディレクトリ (CLAUDE_CONFIG_DIR) プロファイル (Linux限定)
 * リポジトリ単位で別々のディレクトリを使い分けるための抽象化
 */
export interface Profile {
  id: string;
  name: string;
  /** 絶対パス。チルダはサーバ側で展開済 */
  configDir: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * リポジトリとプロファイルの紐付け
 * 1リポジトリ=1プロファイル（多重紐付けは未サポート）
 */
export interface RepoProfileLink {
  repoPath: string;
  profileId: string;
  updatedAt: number;
}

/**
 * 実行環境の機能フラグ
 * クライアントは初期化時に受け取り、UI表示の可否を判断する
 */
export interface SystemCapabilities {
  /** プロファイル切替が利用可能か（Linux + claudeコマンド存在 で true） */
  multiProfileSupported: boolean;
}

export type SessionStatus = "active" | "idle" | "error" | "stopped";

export interface BrowserSession {
  id: string;
  targetPort: number;
  targetUrl: string;
  wsPort: number;
  vncPort: number;
  displayNum: number;
  devtools: boolean;
  createdAt: Date;
}

export interface Message {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  type?: MessageType;
}

export type MessageType =
  | "text"
  | "tool_use"
  | "tool_result"
  | "thinking"
  | "error";

// Claude Code stream-json event types
export interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  content?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  result?: string;
  error?: string;
}

/** 特殊キー入力の種別 */
export type SpecialKey =
  | "Enter"
  | "C-c"
  | "C-d"
  | "y"
  | "n"
  | "S-Tab"
  | "Escape"
  | "Up"
  | "Down";

// WebSocket event types
export interface ServerToClientEvents {
  // Repository events
  "repos:list": (repos: string[]) => void;
  "repos:scanned": (repos: RepoInfo[]) => void;
  "repos:scanning": (data: {
    basePath: string;
    status: "start" | "complete" | "error";
    error?: string;
  }) => void;

  // Worktree events
  /**
   * 対象repoのworktree一覧を通知する。
   * クライアントは repoPath と自分が選択中のrepoPathを比較し、mismatchなら無視する
   * （rapid selectRepoによるout-of-order応答でworktrees stateが取り違えられるのを防ぐ）。
   */
  "worktree:list": (payload: {
    repoPath: string;
    worktrees: Worktree[];
  }) => void;
  /**
   * worktree:created / worktree:deleted は io.emit で全クライアントにブロードキャストされるため、
   * 別repoのクライアントで誤適用されないよう repoPath を添付する（クライアントで完全一致判定）。
   */
  "worktree:created": (payload: {
    repoPath: string;
    worktree: Worktree;
  }) => void;
  "worktree:deleted": (payload: {
    repoPath: string;
    worktreeId: string;
  }) => void;
  "worktree:error": (error: string) => void;

  // Session events（ManagedSessionを使用）
  "session:list": (sessions: ManagedSession[]) => void;
  "session:created": (session: ManagedSession) => void;
  "session:updated": (session: ManagedSession) => void;
  "session:stopped": (sessionId: string) => void;
  "session:error": (data: { sessionId: string; error: string }) => void;
  "session:restored": (session: ManagedSession) => void;
  "session:restore_failed": (data: {
    worktreePath: string;
    error: string;
  }) => void;

  // Session preview events
  "session:previews": (
    previews: Array<{
      sessionId: string;
      text: string;
      activityText: string;
      status: SessionStatus;
      timestamp: number;
    }>
  ) => void;

  // Message events
  "message:received": (message: Message) => void;
  "message:stream": (data: {
    sessionId: string;
    chunk: string;
    type?: MessageType;
  }) => void;
  "message:complete": (data: { sessionId: string; messageId: string }) => void;

  // Repository events
  "repo:set": (path: string) => void;
  /**
   * repo選択エラーの通知。クライアントはrepoPathを見てstale応答を判定する。
   * repoPathがnullのエラー（repoに紐付かない全般エラー）もあり得る。
   */
  "repo:error": (payload: { repoPath: string | null; error: string }) => void;

  // Tunnel events
  "tunnel:started": (data: { url: string; token: string }) => void;
  "tunnel:stopped": () => void;
  "tunnel:error": (data: { message: string }) => void;
  "tunnel:status": (data: {
    active: boolean;
    url?: string;
    token?: string;
  }) => void;

  // Port events
  "ports:list": (data: {
    ports: Array<{ port: number; process: string; pid: number }>;
  }) => void;

  // File upload events
  "file-upload:uploaded": (data: {
    requestId: string;
    path: string;
    filename: string;
    originalFilename?: string;
  }) => void;
  "file-upload:error": (data: {
    requestId: string;
    message: string;
    code?: string;
  }) => void;

  // Beacon events
  "beacon:message": (message: ChatMessage) => void;
  /**
   * Beacon履歴UIにのみ追加される外部メッセージ (Usage取得結果など)。
   * `beacon:message` と異なり client 側の streaming state には影響しない。
   * (LLM streaming 中に到着しても応答が切り捨てられないようにするため)
   */
  "beacon:external-message": (message: ChatMessage) => void;
  "beacon:stream": (data: BeaconStreamChunk) => void;
  "beacon:history": (data: { messages: ChatMessage[] }) => void;
  "beacon:error": (data: { error: string }) => void;

  // Usage取得
  "usage:progress": (data: UsageProgress) => void;
  "usage:complete": (report: UsageReport) => void;
  "usage:error": (data: { message: string }) => void;

  // ファイルビューワー
  "file:content": (data: {
    filePath: string;
    content: string;
    mimeType: string;
    size: number;
    error?: string;
  }) => void;

  // ブラウザセッション（noVNC）
  "browser:started": (session: BrowserSession) => void;
  "browser:stopped": (data: { browserId: string }) => void;
  "browser:error": (data: { message: string }) => void;

  // フロントライン
  "frontline:stats": (stats: FrontlineStats) => void;
  "frontline:records": (records: FrontlineRecord[]) => void;
  "frontline:record_saved": (data: FrontlineRecordSaved) => void;
  "frontline:error": (data: FrontlineError) => void;

  // プロファイル切替 (Linux限定)
  "system:capabilities": (caps: SystemCapabilities) => void;
  "profile:list": (profiles: Profile[]) => void;
  "repo:profile-links": (links: RepoProfileLink[]) => void;
  "profile:created": (profile: Profile) => void;
  "profile:updated": (profile: Profile) => void;
  "profile:deleted": (data: { id: string }) => void;
  "profile:error": (data: { message: string; code?: string }) => void;
  "repo:profile-changed": (data: {
    repoPath: string;
    profileId: string | null;
  }) => void;

  // Bridge ダッシュボード
  "bridge:snapshot": (snapshot: BridgeSnapshot) => void;
  "bridge:stream": (data: {
    sessionId: string;
    lines: BridgeStreamLine[];
  }) => void;

  // 主 Dashboard の Repo グリッドビュー
  "session:grid:snapshot": (snapshots: SessionGridSnapshot[]) => void;
}

export interface ClientToServerEvents {
  // Worktree commands
  "worktree:list": (repoPath: string) => void;
  "worktree:create": (data: {
    repoPath: string;
    branchName: string;
    baseBranch?: string;
  }) => void;
  "worktree:delete": (data: { repoPath: string; worktreePath: string }) => void;

  // Session commands
  "session:start": (data: { worktreeId: string; worktreePath: string }) => void;
  "session:stop": (sessionId: string) => void;
  "session:send": (data: { sessionId: string; message: string }) => void;
  "session:key": (data: { sessionId: string; key: SpecialKey }) => void;
  "session:copy": (
    sessionId: string,
    callback: (response: { text?: string; error?: string }) => void
  ) => void;
  "session:restore": (worktreePath: string) => void;

  // Repository commands
  "repo:scan": (basePath: string) => void;
  "repo:select": (path: string) => void;
  "repo:browse": () => void;

  // ファイルシステムブラウザ（フォルダ選択ダイアログ用）
  "fs:list": (
    data: { path?: string },
    callback: (response: { result?: FsListResult; error?: string }) => void
  ) => void;

  // Tunnel commands
  "tunnel:start": (data?: { port?: number }) => void;
  "tunnel:stop": () => void;

  // Port commands
  "ports:scan": () => void;

  // File upload commands
  "file-upload:upload": (data: {
    sessionId: string;
    base64Data: string;
    mimeType: string;
    originalFilename?: string;
    requestId: string;
  }) => void;

  // Beacon commands
  "beacon:send": (data: { message: string }) => void;
  "beacon:history": () => void;
  "beacon:close": () => void;
  "beacon:clear": () => void;

  // ファイルビューワー
  "file:read": (data: { sessionId: string; filePath: string }) => void;

  // ブラウザセッション（noVNC）
  "browser:start": () => void;
  "browser:stop": (data: { browserId: string }) => void;
  "browser:navigate": (data: { url: string }) => void;

  // フロントライン
  "frontline:save_record": (
    record: Omit<FrontlineRecord, "id" | "createdAt">
  ) => void;
  "frontline:get_stats": () => void;
  "frontline:get_records": (data?: { limit?: number }) => void;

  // プロファイル切替 (Linux限定)
  "profile:list": () => void;
  "profile:create": (data: { name: string; configDir: string }) => void;
  "profile:update": (data: {
    id: string;
    name?: string;
    configDir?: string;
  }) => void;
  "profile:delete": (data: { id: string }) => void;
  "repo:set-profile": (data: {
    repoPath: string;
    profileId: string | null;
  }) => void;
  "session:restart-with-profile": (data: { sessionId: string }) => void;

  // Usage取得 (Linux + multiProfileSupported 限定)
  "usage:request": () => void;

  // Bridge ダッシュボード
  /**
   * Bridgeダッシュボードを購読する。
   * サーバ側で定期ポーリングを開始し、bridge:snapshot を emit する。
   * トラッキング対象セッションを指定するとそのライブストリームも配信される。
   */
  "bridge:subscribe": (data: { focusSessionId?: string | null }) => void;
  "bridge:unsubscribe": () => void;

  // 主 Dashboard の Repo グリッドビュー
  /**
   * セッショングリッド購読。サーバ側で 1.5秒間隔で session:grid:snapshot を emit する。
   * 主 Dashboard の RepoGridView がマウントされている間だけ購読する想定。
   */
  "session:grid:subscribe": () => void;
  "session:grid:unsubscribe": () => void;
}

/** Usage取得結果（プロファイル単位） */
export interface UsageEntry {
  profileId: string;
  profileName: string;
  configDir: string;
  status: "ok" | "unauthenticated" | "timeout" | "error";
  parsed?: {
    sessionPercent: number;
    weeklyAllPercent: number;
    /**
     * Per-model 集計が取得できなかった場合 null。
     * - API rate limit (画面に「Per-model breakdown unavailable」表示)
     * - claude 2.1.123 以降の新UIで Sonnet 区画がスクロール下方に押し出される
     */
    weeklySonnetPercent: number | null;
    /** "8:20pm (Asia/Tokyo)" のような表示用文字列 */
    sessionResets: string;
    weeklyAllResets: string;
    /** Sonnet 取得不可時は null。 */
    weeklySonnetResets: string | null;
    /** "$0.0000" のような表示用文字列 */
    totalCost?: string;
    /** "7s" のような表示用文字列 */
    wallDuration?: string;
  };
  /** デバッグ用（NODE_ENV=development 時のみ含める） */
  rawOutput?: string;
  errorMessage?: string;
}

/** Usage取得結果（全プロファイル分） */
export interface UsageReport {
  entries: UsageEntry[];
  /** UNIXタイムスタンプ(ms) */
  collectedAt: number;
}

/** Usage取得進捗 */
export interface UsageProgress {
  /** 現在処理中のプロファイル名 */
  currentProfileName: string;
  /** 完了済み件数 */
  completed: number;
  /** 全体件数 */
  total: number;
}

/** Beaconチャットのメッセージ */
export interface ChatMessage {
  id: string;
  repoPath?: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  /** ツール使用情報（Bash実行結果など） */
  toolUse?: {
    toolName: string;
    input: string;
    result?: string;
  };
}

/** Beaconストリーミングチャンク */
export interface BeaconStreamChunk {
  repoPath?: string;
  /** 部分テキスト */
  chunk: string;
  /** ストリーミング完了フラグ */
  done: boolean;
}

// ============================================================
// フロントライン（ゲーム）
// ============================================================

export interface FrontlineRecord {
  id: string;
  distance: number;
  kills: number;
  headshots: number;
  totalShots: number;
  playTime: number;
  meritPoints: number;
  blocks: number;
  heliKills: number;
  createdAt: string;
}

export interface FrontlineStats {
  totalPlays: number;
  totalPlayTime: number;
  totalKills: number;
  totalHeadshots: number;
  totalShots: number;
  totalMeritPoints: number;
  bestDistance: number;
  bestKills: number;
  rank: string;
  playHours: Record<string, number>;
  medals: string[];
  deathPositions: number[];
}

export interface FrontlineRecordSaved {
  record: FrontlineRecord;
  stats: FrontlineStats;
  newMedals: string[];
  newBestDistance: boolean;
  newBestKills: boolean;
}

export interface FrontlineError {
  action: "get_stats" | "get_records" | "save_record";
  message: string;
}

// ============================================================
// Bridge ダッシュボード（5インチサブディスプレイ常駐）
// ============================================================

/**
 * Bridge 上で表示するセッションの状態。
 * Claude Code v2 のターミナル出力 (⏺/⎿/✻/❯ + Sautéed/Wibbling 等) を解析して判定する。
 *
 * 優先度 (高→低): ERR > AWAITING > TOOL > THINK > IDLE > READY
 */
export type BridgeSessionStatus =
  | "TOOL" // ツール実行中 (⏺ Tool(...) 直近、⎿ 結果未到着)
  | "THINK" // 思考中 (✻ Wibbling… / esc to interrupt)
  | "AWAITING" // ユーザー判断待ち (1./2. メニュー or y/n プロンプト)
  | "IDLE" // 入力待ち (出力あり、アクション要)
  | "READY" // 空 / クリア直後 (画面に意味あるテキストなし)
  | "ERR" // エラー検出
  | "STOP"; // tmux セッション停止

/** Bridge ダッシュボードに渡すセッション情報 */
export interface BridgeSession {
  /** ManagedSession.id と一致 */
  id: string;
  /** worktree のディレクトリ名（短縮表示用） */
  name: string;
  /** ステータスバッジ用 */
  status: BridgeSessionStatus;
  /** tmux pane インデックス表示用（"%3" など。取得不可なら null） */
  paneId: string | null;
  /** トークン数概算（"2.1k" 等の表示文字列を含む数値） */
  tokens: number;
  /** 経過時間 ms */
  elapsedMs: number;
  /** 現在タスクの1行サマリ（capture-pane の最終非UI行） */
  currentTask: string;
  /**
   * capture-pane 末尾のプレーンテキスト（改行込み、UI装飾行は除外済み）。
   * Bridge のセッショングリッドでターミナル中身プレビュー表示用。
   */
  previewText: string;
}

/** Bridge ライブストリームの1行 */
export interface BridgeStreamLine {
  /** プロンプト / ツールコール / 思考 / 出力 などの分類 */
  kind: "prompt" | "tool" | "think" | "ok" | "error" | "result" | "text";
  /** 表示テキスト（ANSI 除去済み） */
  text: string;
}

/** ホストシステムのリソースメトリクス（毎秒スナップショット） */
export interface HostMetrics {
  /** 0-100 全体CPU使用率 */
  cpuPercent: number;
  /** load average [1m, 5m, 15m] */
  loadAvg: [number, number, number];
  /** 物理メモリ */
  memory: {
    /** 全体 GB */
    totalGB: number;
    /** 使用中 GB */
    usedGB: number;
    /** Wired 相当 GB（Linux の場合 Slab + KernelStack 概算） */
    wiredGB: number;
    /** App / Active GB */
    appGB: number;
    /** Cached GB */
    cachedGB: number;
    /** 圧縮 GB（取得不可なら 0） */
    compressGB: number;
    /** 空き GB */
    freeGB: number;
    /** swap GB */
    swapGB: number;
  };
  /** コアごと使用率 0-100。配列長 = 物理コア数 */
  cores: number[];
  /** ストレージボリューム */
  volumes: Array<{
    name: string;
    mount: string;
    /** 使用率 0-100 */
    usedPercent: number;
    /** 全体 GB */
    totalGB: number;
    /** 使用 GB */
    usedGB: number;
  }>;
  /** Network 集計（MB/s） */
  network: {
    txMBs: number;
    rxMBs: number;
  };
  /** Disk I/O 集計 (MB/s) */
  diskIOMBs: number;
  /** VM温度 °C（取れなければ null） */
  tempC: number | null;
  /** GPU使用率 0-100（取れなければ null） */
  gpuPercent: number | null;
  /** 直近60秒の総CPU使用率履歴（古い→新しい） */
  cpuHistory: number[];
  /** 直近10分のメモリ使用率履歴 0-100 */
  memHistory: number[];
}

/** Cloudflare Tunnel エントリ（Bridge 表示用） */
export interface BridgeTunnelEntry {
  /** 表示名（例: Gangway） */
  name: string;
  /** ホスト名 / URL */
  host: string;
  /** ステータス LED */
  status: "on" | "warn" | "off";
  /** 統計テキスト（"18ms · 142/h" 等） */
  stat: string;
}

/** Bridge ダッシュボードへの全データを1メッセージにまとめたスナップショット */
export interface BridgeSnapshot {
  metrics: HostMetrics;
  sessions: BridgeSession[];
  tunnels: BridgeTunnelEntry[];
  /** UNIX ms */
  collectedAt: number;
}

// ============================================================
// 主 Dashboard の Repo グリッドビュー
// ============================================================

/**
 * 主 Dashboard でリポジトリ選択時に表示する「セッションのグリッド」用スナップショット。
 *
 * 各セッションの状態と末尾プレビュー (プレーンテキスト) を返す。
 * Bridge の BridgeSession と似ているが、こちらはターミナル中身のプレビュー行を
 * 含む点が異なる (Bridge は構造化された BridgeStreamLine をフォーカスセッションのみ別経路で送る)。
 */
export interface SessionGridSnapshot {
  /** ManagedSession.id */
  sessionId: string;
  /** リポジトリの絶対パス。フィルタとグルーピングに使う */
  repoPath: string;
  /** worktree のディレクトリ名 (短縮表示) */
  name: string;
  /** ステータスバッジ用 */
  status: BridgeSessionStatus;
  /** capture-pane 末尾のプレーンテキスト (改行込み、UI装飾行は除外済み) */
  previewText: string;
  /** 直近1行サマリ (UIヘッダーなど用、currentTask と同じ) */
  currentTask: string;
  /** 経過時間 ms */
  elapsedMs: number;
  /** 取得時刻 UNIX ms */
  capturedAt: number;
}
