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

export interface Session {
  id: string;
  worktreeId: string;
  worktreePath: string;
  /** セッションが属するリポジトリのルートパス（既存セッション互換のためoptional） */
  repoPath?: string;
  status: SessionStatus;
  createdAt: Date;
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
  "worktree:list": (worktrees: Worktree[]) => void;
  "worktree:created": (worktree: Worktree) => void;
  "worktree:deleted": (worktreeId: string) => void;
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
  "repo:error": (error: string) => void;

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
  "beacon:stream": (data: BeaconStreamChunk) => void;
  "beacon:history": (data: { messages: ChatMessage[] }) => void;
  "beacon:error": (data: { error: string }) => void;

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

  // ペットイベント
  "pet:list": (pets: Pet[]) => void;
  "pet:created": (pet: Pet) => void;
  "pet:updated": (pet: Pet) => void;
  "pet:deleted": (data: { petId: string }) => void;
  "pet:level_up": (data: { petId: string; newLevel: number }) => void;
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

  // ファイルビューワー
  "file:read": (data: { sessionId: string; filePath: string }) => void;

  // ブラウザセッション（noVNC）
  "browser:start": () => void;
  "browser:stop": (data: { browserId: string }) => void;
  "browser:navigate": (data: { url: string }) => void;

  // ペットコマンド
  "pet:list": () => void;
  "pet:interact": (data: { petId: string; action: PetAction }) => void;
  "pet:rename": (data: { petId: string; name: string }) => void;
  "pet:game_result": (result: PetGameResult) => void;
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

/** ペットの動物種 */
export type PetSpecies =
  | "dog"
  | "cat"
  | "rabbit"
  | "bird"
  | "turtle"
  | "penguin"
  | "fox"
  | "owl";

/** ペットのレアリティ */
export type PetRarity = "common" | "uncommon" | "rare";

/** ペットの気分 */
export type PetMood = "happy" | "neutral" | "sleepy" | "hungry" | "sad";

/** ペットデータ */
export interface Pet {
  id: string;
  sessionId: string;
  species: PetSpecies;
  name: string | null;
  level: number;
  exp: number;
  hp: number;
  mood: PetMood;
  createdAt: string;
  updatedAt: string;
}

/** ペットインタラクション種別 */
export type PetAction = "pet" | "feed";

/** ミニゲーム種別 */
export type PetGame = "feeding" | "arkdash";

/** ミニゲーム結果 */
export interface PetGameResult {
  petId: string;
  game: PetGame;
  score: number;
}
