// Shared types between client and server

/** 図ファイルを格納する worktree 相対の正準ディレクトリ */
export const DIAGRAM_DIR = ".claude/diagrams";

/**
 * Slash command 候補。チャットビュー入力欄の補完で使う。
 *  - `name`: `/foo` 形式 (先頭の `/` 含む)
 *  - `description`: 1 行説明 (frontmatter `description:` または組み込み定義)
 *  - `source`: どこから拾ったか (UI のバッジ表示用)
 */
export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: "built-in" | "global" | "project" | "plugin";
}

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
  /**
   * board MCP の per-session mcp-config ファイルのパス（サーバー内部用）。
   * サーバー再起動後に board token を registry へ復帰させるために使う。
   */
  boardMcpConfigPath?: string | null;
  /**
   * セッションで最後に開いた図（.claude/diagrams/*.diagram.html）の worktree 相対パス。
   * board_open で図を開くたびに更新され、クライアントはリロード後に
   * この値を使って右ペインの図タブを復元する。旧 root の保存値は server
   * 起動時に無効化される（未オープン時は null/undefined）。
   */
  lastDiagramPath?: string | null;
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

/** メッセージショートカットの本文最大長（文字数） */
export const MESSAGE_SHORTCUT_MAX_LENGTH = 4000;

/** UIから登録する定型メッセージのショートカット（全リポジトリ共通） */
export interface MessageShortcut {
  id: string;
  /** 送信本文（1文字以上、上限は MESSAGE_SHORTCUT_MAX_LENGTH 参照、複数行可）。ドロップダウン表示は先頭行を切り詰めて使う */
  message: string;
  /** 並び順（MVPはMAX+1で末尾追加） */
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * リポジトリとプロファイルの紐付け
 * 1リポジトリ=1プロファイル（多重紐付けは未サポート）。
 * worktree個別の紐付けが無いセッションのデフォルトとして使われる。
 */
export interface RepoProfileLink {
  repoPath: string;
  profileId: string;
  updatedAt: number;
}

/**
 * worktreeとプロファイルの紐付け
 * 1worktree=1プロファイル。指定された場合はリポジトリのデフォルトより優先される。
 */
export interface WorktreeProfileLink {
  worktreePath: string;
  profileId: string;
  updatedAt: number;
}

/**
 * worktreeのカスタム表示名
 * 未設定時はクライアント側で branch 名にフォールバックする。
 */
export interface WorktreeDisplayName {
  worktreePath: string;
  displayName: string;
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
  | "Down"
  | "Right"
  | "Space"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9";

// WebSocket event types
export interface DiagramListItem {
  relPath: string;
  displayName: string;
  tracked: boolean;
}

export type DiagramListResponse =
  | { ok: true; diagrams: DiagramListItem[] }
  | { ok: false; error: string };

export interface DiagramDeleteRequest {
  sessionId: string;
  relPath: string;
  expectedTracked: boolean;
}

export type DiagramDeleteResponse =
  | {
      ok: true;
      relPath: string;
      tracked: boolean;
      warning?: string;
    }
  | {
      ok: false;
      code:
        | "BAD_REQUEST"
        | "SESSION_NOT_FOUND"
        | "NOT_FOUND"
        | "FORBIDDEN"
        | "CONFLICT"
        | "IO_ERROR";
      error: string;
    };

export interface DiagramCommentMessage {
  id: string;
  author?: string;
  at: string;
  body: string;
}

export interface DiagramCommentThread {
  id: string;
  anchorId: string;
  anchorText: string;
  anchorQuote?: string;
  anchorOccurrence?: number;
  status: "open" | "resolved";
  createdAt: string;
  messages: DiagramCommentMessage[];
}

export interface DiagramCommentsFile {
  version: 1;
  target: string;
  threads: DiagramCommentThread[];
}

/**
 * mutation の同一性を示す操作 ID。ACK タイムアウト後の再試行で同じ値を送ると、
 * サーバーは適用済みの操作を再適用せず現在の sidecar を返す（冪等）。
 * クライアントが生成する 1〜256 文字の任意文字列。
 */
export interface DiagramCommentOperation {
  operationId: string;
}

export interface DiagramCommentThreadRequest extends DiagramCommentOperation {
  sessionId: string;
  relPath: string;
  threadId: string;
}

export interface DiagramCommentCreateRequest extends DiagramCommentOperation {
  sessionId: string;
  relPath: string;
  anchorId: string;
  anchorQuote?: string;
  anchorOccurrence?: number;
  body: string;
}

export type DiagramCommentDeleteRequest = DiagramCommentThreadRequest;

export interface DiagramCommentReplyRequest
  extends DiagramCommentThreadRequest {
  body: string;
}

export type DiagramCommentsResponse =
  | { ok: true; comments: DiagramCommentsFile }
  | {
      ok: false;
      code:
        | "BAD_REQUEST"
        | "SESSION_NOT_FOUND"
        | "FORBIDDEN"
        | "NOT_DOC"
        | "INVALID_SIDECAR"
        | "ANCHOR_NOT_FOUND"
        | "THREAD_NOT_FOUND"
        | "IO_ERROR";
      error: string;
    };

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

  /**
   * Claude が board_open を呼んだ。クライアントは図タブを開く。
   * worktreePath は載せない。クライアントは session:list で既に持っている値を
   * sessionId から引く（worktree の絶対パスが渡る範囲を必要なクライアントに
   * 限定するため。index.ts の openDiagram 実装の方針に揃える）。
   */
  "diagram:open": (data: { sessionId: string; relPath: string }) => void;

  /** 監視中の図ファイルが更新された。クライアントは再読込する */
  "diagram:updated": (data: { worktreePath: string; relPath: string }) => void;

  /** 監視中のコメント sidecar が更新された。iframe はコメントだけを再取得する */
  "diagram:comments-updated": (data: {
    worktreePath: string;
    relPath: string;
  }) => void;

  /** 管理対象の図ファイルが削除された。絶対 path は通知しない */
  "diagram:deleted": (data: { sessionId: string; relPath: string }) => void;

  // Session events（ManagedSessionを使用）
  "session:list": (sessions: ManagedSession[]) => void;
  "session:created": (session: ManagedSession) => void;
  "session:updated": (session: ManagedSession) => void;
  "session:stopped": (sessionId: string) => void;
  /**
   * セッション再起動の完了通知 (旧ID → 新セッションの対応)。
   * sessions 一覧の更新は session:stopped / session:created が担うため、
   * このイベントは「選択中セッションの新IDへの追従」のヒント専用。
   * 一覧へ session を追加してはならない (旧ID残留の幻セッション防止)
   */
  "session:restarted": (data: {
    oldSessionId: string;
    session: ManagedSession;
  }) => void;
  "session:error": (data: { sessionId: string; error: string }) => void;

  /**
   * `session:jsonl-subscribe` の初回応答。既存履歴を一括で返す。
   * `lines` は JSONL 1 行 = 1 要素の生 JSON 文字列配列。
   * /clear 等で JSONL ファイルが切り替わったときは空配列で再送される。
   */
  "session:jsonl-snapshot": (data: {
    sessionId: string;
    lines: string[];
  }) => void;

  /** 購読中の JSONL ファイルに新規行が追記されたときの push */
  "session:jsonl-line": (data: { sessionId: string; line: string }) => void;

  /**
   * AskUserQuestion が表示された通知 (PreToolUse hook 由来)。
   * 対話版 claude は AUQ の tool_use を「回答確定時」まで transcript に
   * 書かないため、回答待ちのリアルタイム検出は hook で行う。
   * 回答確定 (カードを閉じる) は JSONL の tool_result 出現で判定する。
   */
  "session:auq": (data: {
    sessionId: string;
    /** サーバーが hook を受信した epoch ms (JSONL 解決イベントとの前後比較用) */
    at: number;
    /** tool_input.questions の生データ (クライアント側で構造検証する) */
    questions: unknown;
    /**
     * hook 受信時の tmux 画面スナップショット (verbatim・無解釈)。
     * AUQ 表示中は直前の会話が JSONL に無いため、カードの「直前の画面」
     * 表示に使う。capture 失敗時は null
     */
    screen: string | null;
  }) => void;
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
      /**
       * Bridge collector が判定した詳細ステータス。
       * サイドバードット色 (SessionCard) や RepoGridView と表示を統一するための情報。
       */
      bridgeStatus: BridgeSessionStatus;
      /**
       * AWAITING のときのみ: 確認 UI の生テキスト (ANSI 除去済み画面末尾)。
       * チャットビューのバナーで「何を聞かれているか」をそのまま表示する
       */
      awaitingText?: string;
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

  // プロファイル切替 (Linux限定)
  "system:capabilities": (caps: SystemCapabilities) => void;
  "profile:list": (profiles: Profile[]) => void;
  "repo:profile-links": (links: RepoProfileLink[]) => void;
  "worktree:profile-links": (links: WorktreeProfileLink[]) => void;
  "profile:created": (profile: Profile) => void;
  "profile:updated": (profile: Profile) => void;
  "profile:deleted": (data: { id: string }) => void;
  "profile:error": (data: { message: string; code?: string }) => void;
  "repo:profile-changed": (data: {
    repoPath: string;
    profileId: string | null;
  }) => void;
  "worktree:profile-changed": (data: {
    worktreePath: string;
    profileId: string | null;
  }) => void;
  "worktree:display-names": (names: WorktreeDisplayName[]) => void;
  "worktree:display-name-changed": (data: {
    worktreePath: string;
    displayName: string | null;
  }) => void;

  // メッセージショートカット
  "shortcut:list": (shortcuts: MessageShortcut[]) => void;
  "shortcut:created": (shortcut: MessageShortcut) => void;
  "shortcut:updated": (shortcut: MessageShortcut) => void;
  "shortcut:deleted": (data: { id: string }) => void;
  "shortcut:error": (data: { message: string; code?: string }) => void;

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

  /**
   * tmux に literal テキストのみ送信する (Enter を付けない)。
   * AskUserQuestion の自由入力モードで「1 文字ずつタイプ」する用途。
   */
  "session:send-literal": (data: { sessionId: string; text: string }) => void;

  /** managed worktree にある有効な図を read-only で一覧する */
  "diagram:list": (
    data: { worktreePath: string },
    callback: (response: DiagramListResponse) => void
  ) => void;

  /** session に紐づく現在図を1件削除する */
  "diagram:delete": (
    data: DiagramDeleteRequest,
    callback: (response: DiagramDeleteResponse) => void
  ) => void;

  /** session に紐づく図のコメントを取得する */
  "diagram:comments:get": (
    data: { sessionId: string; relPath: string },
    callback: (response: DiagramCommentsResponse) => void
  ) => void;

  /**
   * 文書ブロックまたはそのテキスト選択範囲へ単発コメントを作成する。
   * mutation 系は operationId を必須とし、同じ ID の再送は再適用しない
   */
  "diagram:comment:create": (
    data: DiagramCommentCreateRequest,
    callback: (response: DiagramCommentsResponse) => void
  ) => void;

  /** 既存の文書コメントへ人間の返信を追加する */
  "diagram:comment:reply": (
    data: DiagramCommentReplyRequest,
    callback: (response: DiagramCommentsResponse) => void
  ) => void;

  /** 文書コメントを解決済みにする */
  "diagram:comment:resolve": (
    data: DiagramCommentThreadRequest,
    callback: (response: DiagramCommentsResponse) => void
  ) => void;

  /** 文書コメントを削除する */
  "diagram:comment:delete": (
    data: DiagramCommentDeleteRequest,
    callback: (response: DiagramCommentsResponse) => void
  ) => void;

  /** 文書コメントを会話セッションへ送る（同じ operationId の再送は二重送信しない） */
  "diagram:comment:send": (
    data: DiagramCommentThreadRequest,
    callback: (response: DiagramCommentsResponse) => void
  ) => void;

  /** 図の購読開始（更新通知を受け取る）。1 セッション 1 図を想定 */
  "diagram:subscribe": (data: {
    worktreePath: string;
    relPath: string;
  }) => void;

  /** 図の購読解除 */
  "diagram:unsubscribe": (data: {
    worktreePath: string;
    relPath: string;
  }) => void;

  /** 図の編集結果を保存する。会話への還流は行わない。 */
  "diagram:autosave": (
    data: {
      sessionId: string;
      worktreePath: string;
      relPath: string;
      model: unknown;
      html: string;
    },
    callback: (response: { ok: boolean; error?: string }) => void
  ) => void;

  /**
   * 図の編集結果を保存し、意味差分を会話へ還流する。
   * model は構造化モデル、html は投影（ハーネスと meta CSP を除いたもの）。
   * 還流の文面はサーバーが model の差分から組む（iframe から散文は受け取らない）。
   */
  "diagram:submit": (
    data: {
      sessionId: string;
      worktreePath: string;
      relPath: string;
      model: unknown;
      html: string;
    },
    callback: (response: {
      ok: boolean;
      sent?: string[];
      error?: string;
    }) => void
  ) => void;

  /**
   * Claude Code が永続化する JSONL 履歴 (~/.claude/projects/<encoded-cwd>/*.jsonl)
   * を購読する。チャットビューの会話描画に使用する。
   */
  "session:jsonl-subscribe": (sessionId: string) => void;
  "session:jsonl-unsubscribe": (sessionId: string) => void;

  /**
   * 既存購読中の JSONL について、過去履歴をより多く読み直す。
   * サーバは末尾 `limit` 行で snapshot を再送する。
   */
  "session:jsonl-load-more": (data: {
    sessionId: string;
    limit: number;
  }) => void;

  /**
   * 指定セッションで使える slash command 一覧をリクエスト。
   * サーバは組み込みコマンド + `<configDir>/commands/*.md` +
   * `<worktreePath>/.claude/commands/*.md` を集めて返す。
   */
  "slash:list": (
    sessionId: string,
    callback: (response: {
      commands?: SlashCommandInfo[];
      error?: string;
    }) => void
  ) => void;

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

  // ファイルビューワー
  "file:read": (data: { sessionId: string; filePath: string }) => void;

  // ブラウザセッション（noVNC）
  "browser:start": () => void;
  "browser:stop": (data: { browserId: string }) => void;
  "browser:navigate": (data: { url: string }) => void;

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
  "worktree:set-profile": (data: {
    worktreePath: string;
    profileId: string | null;
  }) => void;
  "worktree:set-display-name": (data: {
    worktreePath: string;
    /** null / 空文字でクリア（branch名にフォールバック） */
    displayName: string | null;
  }) => void;
  "session:restart-with-profile": (data: { sessionId: string }) => void;

  // メッセージショートカット
  "shortcut:list": () => void;
  "shortcut:create": (data: { message: string }) => void;
  "shortcut:update": (data: {
    id: string;
    message?: string;
    sortOrder?: number;
  }) => void;
  "shortcut:delete": (data: { id: string }) => void;

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
