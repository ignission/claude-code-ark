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
/**
 * セッションのブランチに紐づくGitHubのPRと、そのチェックの集計。
 * サーバーが `gh pr view` を定期的に読んで作る (`pr-status-collector.ts`)
 */
export interface SessionPrStatus {
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  /**
   * チェックの集計。1つでも落ちていれば failed、終わっていないものがあれば pending、
   * すべて通れば passed、チェックが1つも無ければ none
   */
  checks: "none" | "pending" | "passed" | "failed";
  /** PRの先頭のコミット。同じ失敗を二度通知しないために使う */
  headRefOid: string;
}

/**
 * プランの使用量の1つの枠 (5時間枠か週枠)。
 * サーバーが Claude Code の使用量APIを定期的に読んで作る (`plan-limits-collector.ts`)
 */
export interface PlanLimitWindow {
  /** 使った割合 (0-100) */
  percent: number;
  /** 枠がリセットされる時刻 (ISO 8601)。分からなければ null */
  resetsAt: string | null;
}

/** セッションのプロファイルのプランの使用量。枠が無い、読めない、はその枠が null */
export interface PlanLimits {
  fiveHour: PlanLimitWindow | null;
  sevenDay: PlanLimitWindow | null;
}

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
 * リモート画面 (SSH 越しに届く VNC 画面)。
 * パスワードは含めない。`screen:credentials` の callback だけで配る
 */
export interface Screen {
  id: string;
  name: string;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  /** SSH ホストから見た VNC ホスト。既定 127.0.0.1 */
  vncHost: string;
  vncPort: number;
  /** ARD 認証のユーザー名。標準 VNC 認証のホストでは空文字 */
  vncUser: string;
  createdAt: number;
  updatedAt: number;
}

/** 画面の作成入力 */
export interface ScreenInput {
  name: string;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  vncHost: string;
  vncPort: number;
  vncUser: string;
  vncPassword: string;
}

/** 画面の部分更新。vncPassword は指定したときだけ更新する */
export type ScreenPatch = Partial<ScreenInput>;

/** noVNC の credentials に渡す値 */
export interface ScreenCredentials {
  username: string;
  password: string;
}

/** screen:credentials の結果。unavailable は socket 未接続や ack タイムアウト */
export type ScreenCredentialsResult =
  | { kind: "ok"; credentials: ScreenCredentials }
  | { kind: "unregistered" }
  | { kind: "unavailable" };

/**
 * screen:paste の結果。失敗の reason は表示用ではなく、ログと切り分けに使う
 * (unsupported: VNC の宛先が SSH ホスト自身でない、too_large: 本文が上限超え)
 */
export type ScreenPasteResult = { ok: true } | { ok: false; reason: string };

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
  targetUrl: string;
  createdAt: Date;
}

/** 修飾キーのビット (CDPの Input.* と同じ値): Alt=1, Ctrl=2, Meta=4, Shift=8 */
export type BrowserModifiers = number;

/**
 * ブラウザ機能のWebSocket (`/browser/:id/ws`) でクライアントが送るメッセージ。
 * 座標はビューポートのCSSピクセル。
 */
export type BrowserClientMessage =
  | { t: "resize"; width: number; height: number; dpr: number; mobile: boolean }
  | {
      t: "mouse";
      type: "down" | "up" | "move" | "wheel";
      x: number;
      y: number;
      /** DOMの MouseEvent.button (0=左, 1=中, 2=右) */
      button: number;
      /** DOMの MouseEvent.buttons */
      buttons: number;
      clickCount: number;
      deltaX: number;
      deltaY: number;
      modifiers: BrowserModifiers;
    }
  | {
      t: "key";
      type: "down" | "up";
      key: string;
      code: string;
      keyCode: number;
      /** 文字を生むキーだけに付く */
      text?: string;
      repeat: boolean;
      modifiers: BrowserModifiers;
    }
  | {
      t: "ime";
      type: "update";
      text: string;
      selectionStart: number;
      selectionEnd: number;
    }
  | { t: "ime"; type: "commit"; text: string }
  | { t: "ime"; type: "cancel" }
  | { t: "paste"; text: string }
  /** フレームを取りこぼしたとき。全画面を送り直してもらう */
  | { t: "refresh" }
  /** URLへ遷移する。スキームが無ければ `http://` を補う。開けないURLには `notice` が返る */
  | { t: "nav"; type: "goto"; url: string }
  | { t: "nav"; type: "back" | "forward" | "reload" | "stop" }
  | { t: "tab"; type: "activate" | "close"; id: string }
  /** 新しいタブ (`about:blank`) */
  | { t: "tab"; type: "new" }
  /**
   * JavaScriptのダイアログへの応答。`id` は `dialog` で知らされた番号で、いま開いている
   * ダイアログの番号でなければ捨てられる。`promptText` は `prompt` に入れる文字列
   */
  | { t: "dialog"; id: number; accept: boolean; promptText?: string }
  /** 選択している文字列を読む。選択があれば `clipboard` が返る */
  | { t: "copy" }
  /** `select` で知らされた `<select>` の選択。`index` は `options` の添字 */
  | { t: "selectChoose"; id: number; index: number }
  | { t: "selectCancel"; id: number }
  | {
      t: "touch";
      type: "start" | "move" | "end" | "cancel";
      /** 触れている点。最大10個 */
      points: BrowserTouchPoint[];
      modifiers: BrowserModifiers;
    };

export interface BrowserTouchPoint {
  id: number;
  x: number;
  y: number;
}

/** いま映しているタブの状態 */
export interface BrowserPageInfo {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface BrowserTabInfo {
  id: string;
  title: string;
  url: string;
}

export type BrowserDialogKind = "alert" | "confirm" | "prompt" | "beforeunload";

export interface BrowserDialogInfo {
  /** サーバーが開いたダイアログごとに振る番号。応答は、この番号で名指しする */
  id: number;
  kind: BrowserDialogKind;
  message: string;
  /** `prompt` の入力欄の初期値。ほかの種類では空 */
  defaultPrompt: string;
}

export interface BrowserSelectOption {
  label: string;
  disabled: boolean;
  /** `<optgroup>` の見出し。属していなければ `null` */
  group: string | null;
}

/**
 * サーバーが送るJSONのメッセージ。フレームは別にバイナリで送る
 * (ヘッダと画像。形は browser-frame-pipeline.ts の `encodeFrameHeader`)。
 * `viewport` は、このあとに届くフレームが描かれたビューポートの寸法 (CSSピクセル) と世代。
 * 視聴者は寸法で座標を換算し、世代の違うフレームを捨てる
 */
export type BrowserServerMessage =
  | { t: "error"; message: string }
  | { t: "viewport"; width: number; height: number; gen: number }
  /** 変わるたびに送る。参加した視聴者にも送る */
  | ({ t: "page" } & BrowserPageInfo)
  /** タブの一覧。変わるたびに送る。参加した視聴者にも送る */
  | { t: "tabs"; tabs: BrowserTabInfo[]; activeId: string }
  /**
   * JavaScriptのダイアログが開いた。開いている間に参加した視聴者にも送る。
   * 同じ `id` がもう一度届いたら、同じダイアログ
   */
  | ({ t: "dialog" } & BrowserDialogInfo)
  /** ダイアログが閉じた (だれかが応答した、またはページが閉じた) */
  | { t: "dialogClosed" }
  /** `copy` への応答。選択が無ければ送らない。送信が詰まっている視聴者へも送らない */
  | { t: "clipboard"; text: string }
  /**
   * `<select>` が押された。`rect` はビューポートのCSSピクセルでの `<select>` の位置。
   * 送信が詰まっている視聴者へは送らない
   */
  | {
      t: "select";
      id: number;
      options: BrowserSelectOption[];
      selectedIndex: number;
      rect: { x: number; y: number; width: number; height: number };
    }
  /** その選択は無効になった (遷移した、ほかの視聴者が選んだ) */
  | { t: "selectClosed"; id: number }
  /** 操作を断ったときの理由。切断はしない */
  | { t: "notice"; message: string };

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
/** 図の一覧に出す種類 (graph の図種と type なしは "graph") */
export type DiagramKind = "deck" | "doc" | "sequence" | "call-tree" | "graph";

export interface DiagramListItem {
  relPath: string;
  displayName: string;
  tracked: boolean;
  kind?: DiagramKind;
  /** ファイルの更新日時 (epoch ミリ秒)。読めなかったら無い */
  mtimeMs?: number;
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
    /** worktree:create で受けた todoId をそのまま返す (自分が頼んだ作成かの判別用) */
    todoId?: string;
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
  /** TODO が足された・完了した・消された。クライアントは todo:list で読み直す */
  "todo:changed": () => void;

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
   * 回答確定は JSONL の tool_result 出現で判定する。クライアントは受けたら端末を開く。
   */
  "session:auq": (data: {
    sessionId: string;
    /** サーバーが hook を受信した epoch ms (JSONL 解決イベントとの前後比較用) */
    at: number;
    /** tool_input.questions の生データ (クライアント側で構造検証する) */
    questions: unknown;
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
      /**
       * 画面を取れたときは常に: 画面末尾の生テキスト (ANSI 除去・末尾空行除去済み)。
       * チャットビューの固定の帯にそのまま表示する。内容は解釈しない
       */
      liveTail?: string;
      /**
       * 会話 (JSONL transcript) の最終更新時刻 (epochミリ秒)。読めなければ null。
       * 一覧をセクションの中で最終更新の降順に並べるために使う。
       * tmux の session_activity は端末の再描画でも動くので使わない
       */
      lastUpdatedAt: number | null;
      /**
       * ブランチのPRとチェックの集計。PRが無い、ghが無い、まだ読んでいない、のどれも null
       */
      prStatus: SessionPrStatus | null;
      /**
       * セッションのプロファイルのプランの使用量。読めない、まだ読んでいない、は null
       */
      planLimits: PlanLimits | null;
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
  "file:updated": (data: { sessionId: string; filePath: string }) => void;
  /** 裏の Claude との会話が変わった (発話が増えた / 答え終えた / 失敗した) */
  "ask:state": (state: AskState) => void;
  "file:content": (data: {
    filePath: string;
    content: string;
    mimeType: string;
    size: number;
    error?: string;
  }) => void;

  // ブラウザセッション
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

  // リモート画面
  "screen:list": (screens: Screen[]) => void;
  "screen:created": (screen: Screen) => void;
  "screen:updated": (screen: Screen) => void;
  "screen:deleted": (data: { id: string }) => void;
  "screen:error": (data: { message: string; code?: string }) => void;
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
  /**
   * 接続が生きているかの確認。サーバーは何もせず callback を呼ぶ。
   * 前面に戻ったクライアントが、切れたことに気づいていない接続を見つけるのに使う
   */
  "health:ping": (callback: () => void) => void;
  // Worktree commands
  "worktree:list": (repoPath: string) => void;
  "worktree:create": (data: {
    repoPath: string;
    branchName: string;
    baseBranch?: string;
    /** 分岐TODOから始める作成。作成できたらそのTODOの始めた先を新しい worktree にする */
    todoId?: string;
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

  /**
   * 音声モード (iPhone) の診断。サーバーはログに1行出すだけで、保存も配信もしない。
   * 認識した文や返答の本文は送らない (文字数だけ)
   */
  "voice:diagnostic": (data: {
    sessionId: string;
    kind: string;
    detail: string;
  }) => void;

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

  // 分岐TODO (すべて ack で返す)。一覧は全 worktree ぶんで、未完了と完了の両方を返す
  "todo:list": (
    data: Record<string, never>,
    cb: (r: TodoListResponse) => void
  ) => void;
  "todo:set-done": (
    data: { id: string; done: boolean },
    cb: (r: TodoOpResponse) => void
  ) => void;
  "todo:set-started": (
    data: { id: string; worktreePath: string },
    cb: (r: TodoOpResponse) => void
  ) => void;
  "todo:delete": (
    data: { id: string },
    cb: (r: TodoOpResponse) => void
  ) => void;

  // Git タブの読み取り (すべて ack で返す)
  "git:log": (
    data: { sessionId: string; skip: number; limit: number },
    cb: (r: GitLogResponse) => void
  ) => void;
  "git:refs": (
    data: { sessionId: string },
    cb: (r: GitRefsResponse) => void
  ) => void;
  "git:status": (
    data: { sessionId: string },
    cb: (r: GitStatusResponse) => void
  ) => void;
  "git:commit": (
    data: { sessionId: string; sha: string },
    cb: (r: GitCommitResponse) => void
  ) => void;
  "git:file-diff": (
    data: {
      sessionId: string;
      target: GitDiffTarget;
      path: string;
      oldPath?: string;
    },
    cb: (r: GitFileDiffResponse) => void
  ) => void;
  "git:fingerprint": (
    data: { sessionId: string },
    cb: (r: GitFingerprintResponse) => void
  ) => void;
  // Git タブの書き込み操作 (すべて ack で返す)
  "git:branch-create": (
    data: {
      sessionId: string;
      name: string;
      startPoint: string;
      /** 削除を元に戻すときだけ。消す前の追跡先 */
      upstream?: GitBranchUpstream;
    },
    cb: (r: GitOpResponse) => void
  ) => void;
  "git:branch-rename": (
    data: { sessionId: string; from: string; to: string },
    cb: (r: GitOpResponse) => void
  ) => void;
  "git:branch-delete": (
    /**
     * removeWorktree はブランチを使っている作業ツリーごと消す (セッションも止める)。
     * 無ければ、使用中のブランチは inWorktree の失敗で断られる
     */
    data: {
      sessionId: string;
      name: string;
      force: boolean;
      removeWorktree?: boolean;
    },
    cb: (r: GitBranchDeleteResponse) => void
  ) => void;
  "git:remote-branch-delete": (
    /** name は追跡ブランチの名前 (`origin/feat/x`)。元のブランチはサーバーが fetch の設定でたどる */
    data: { sessionId: string; remote: string; name: string },
    cb: (r: GitOpResponse) => void
  ) => void;
  "git:fetch": (
    data: { sessionId: string },
    cb: (r: GitOpResponse) => void
  ) => void;
  "git:pull": (
    data: { sessionId: string },
    cb: (r: GitOpResponse) => void
  ) => void;
  "git:push": (
    data: { sessionId: string; name: string },
    cb: (r: GitPushResponse) => void
  ) => void;

  // ファイルビューワー
  "file:read": (data: { sessionId: string; filePath: string }) => void;
  "file:open": (
    data: { sessionId: string; filePath: string },
    cb: (r: FileOpenResponse) => void
  ) => void;
  "file:list": (
    data: { sessionId: string; dirPath: string },
    cb: (r: FileListResponse) => void
  ) => void;
  /** 裏の Claude との会話のいまの状態 */
  "ask:get": (callback: (state: AskState) => void) => void;
  /** 裏の Claude に聞く (答えは ask:state で届く) */
  "ask:send": (
    data: { text: string },
    callback: (result: AskResult) => void
  ) => void;
  /** 裏の Claude との会話をまっさらにする */
  "ask:reset": (callback: (result: AskResult) => void) => void;
  "file:index": (
    data: { sessionId: string },
    cb: (r: FileIndexResponse) => void
  ) => void;
  "file:write": (
    data: {
      sessionId: string;
      filePath: string;
      content: string;
      expectedMtimeMs: number;
      force?: boolean;
    },
    cb: (r: FileWriteResponse) => void
  ) => void;
  "file:subscribe": (data: { sessionId: string; filePath: string }) => void;
  "file:unsubscribe": (data: { sessionId: string; filePath: string }) => void;

  // ブラウザセッション
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

  // リモート画面
  "screen:list": () => void;
  "screen:create": (data: ScreenInput) => void;
  "screen:update": (data: { id: string } & ScreenPatch) => void;
  "screen:delete": (data: { id: string }) => void;
  /** 接続直前に 1 回だけ呼ぶ。未登録なら null */
  /** ボード提案の設定を取得 (鍵は末尾 4 文字だけ) */
  "board-suggest:get": (
    callback: (result: BoardSuggestConfigResult) => void
  ) => void;
  /** ボード提案の設定を変更。保存後の設定を返す */
  "board-suggest:set": (
    patch: BoardSuggestConfigPatch,
    callback: (result: BoardSuggestConfigResult) => void
  ) => void;
  "screen:credentials": (
    id: string,
    callback: (creds: ScreenCredentials | null) => void
  ) => void;
  /** リモート画面のクリップボードを SSH 越しに書き換える (screen-clipboard.ts) */
  "screen:paste": (
    data: { id: string; text: string },
    callback: (result: ScreenPasteResult) => void
  ) => void;
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
/**
 * ボード提案の通知。Claude の返答が終わるたびに Jev (TypeSafe の決定モデル) が
 * 「チャットよりボードのほうが読みやすいか」を判定し、閾値を超えたときだけ出る。
 */
/**
 * 分岐TODO。会話で保留にした話題を Claude が todo_add で足し、人間が完了・削除する。
 * worktree_path ごとに持ち、worktree を消しても残す
 */
export interface Todo {
  id: string;
  worktreePath: string;
  text: string;
  note: string | null;
  /** ms */
  createdAt: number;
  /** 完了した時刻 (ms)。未完了は null */
  doneAt: number | null;
  /** 会話を始めた先の worktree のパス (最後の1件)。始めていなければ null */
  startedWorktreePath: string | null;
  /** 会話を始めた時刻 (ms)。始めていなければ null */
  startedAt: number | null;
}

export type TodoListResponse =
  | { ok: true; todos: Todo[] }
  | { ok: false; error: string };

export type TodoOpResponse = { ok: true } | { ok: false; error: string };

/** ボード提案の設定。鍵そのものは含めない (末尾 4 文字と出どころだけ) */
export interface BoardSuggestConfig {
  enabled: boolean;
  /** Jev の「ボードのほうが読みやすい」確率がこの値以上なら動く (0〜1) */
  threshold: number;
  keyConfigured: boolean;
  /** 設定済みの鍵の末尾 4 文字。未設定は null */
  keyHint: string | null;
  /** settings: 設定画面 / env: OPENROUTER_API_KEY / file: ~/.config/openrouter/api-key */
  keySource: "settings" | "env" | "file" | null;
  /** 分岐TODOの検出 (保留にした話題を Claude に TODO へ足させる) */
  todoEnabled: boolean;
  /** Jev の「保留にした話題がある」確率がこの値以上なら動く (0〜1) */
  todoThreshold: number;
}

/** 設定画面からの変更。apiKey は文字列で保存、null で設定側の鍵を削除、未指定で変更なし */
export interface BoardSuggestConfigPatch {
  enabled?: boolean;
  threshold?: number;
  apiKey?: string | null;
  todoEnabled?: boolean;
  todoThreshold?: number;
}

export type BoardSuggestConfigResult =
  | { ok: true; config: BoardSuggestConfig }
  | { ok: false; error: string };

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

// ============================================================
// 端末 (ttyd) の色
// ============================================================

/**
 * ttyd の背景色と文字色。web の端末の額縁 (TerminalPane / MobileSessionView) も
 * 同じ値を使い、iframe の中と外で段差が出ないようにする (設計書 8.6 節)
 */
export const TERMINAL_BG = "#1c1a17";
export const TERMINAL_FG = "#e6e1da";

// Git タブ
export interface GitRef {
  kind: "head" | "branch" | "remote" | "tag" | "stash";
  /** 表示名 (`main` / `origin/main` / `v1.0`) */
  name: string;
}
export interface GitCommit {
  sha: string;
  parents: string[];
  subject: string;
  authorName: string;
  authorEmail: string;
  /** 作者日時 (UNIX 秒) */
  authorTime: number;
  refs: GitRef[];
}
export interface GitCommitDetail extends GitCommit {
  body: string;
  committerName: string;
  /** コミット日時 (UNIX 秒) */
  committerTime: number;
}
export interface GitFileChange {
  path: string;
  /** リネーム・コピーの元 */
  oldPath?: string;
  status: "A" | "M" | "D" | "R" | "C" | "T" | "U" | "?";
  /** バイナリは null */
  added: number | null;
  removed: number | null;
}
export interface GitBranch {
  name: string;
  sha: string;
  current: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** このブランチを使っている作業ツリー (このworktreeを含む) のパス */
  worktreePath?: string;
  /** worktreePath がリポジトリ本体の作業ツリー (消せないので、ブランチも消せない) */
  mainWorktree?: boolean;
}
export interface GitRefs {
  head: { sha: string | null; branch: string | null };
  branches: GitBranch[];
  /**
   * name は追跡ブランチの名前 (`origin/feat/x`)。remote はそのリモート (名前は `/` を
   * 含みうるので、name を最初の `/` で切って求めてはいけない)。branch は表示用の残りの
   * 部分で、fetch の設定によってはリモートでのブランチ名と違う (消すときは name で指す)。
   * isDefault はリモートの既定のブランチ (`origin/HEAD` の指す先)。
   * unknownRemote は、設定に無いリモートの追跡ブランチ (消したリモートや手で作った
   * `refs/remotes/pr/*` の残り)。どこへ消しに行くか分からないので、リモートからは消せない
   */
  remotes: {
    name: string;
    sha: string;
    remote: string;
    branch: string;
    isDefault?: boolean;
    unknownRemote?: boolean;
  }[];
  tags: { name: string; sha: string }[];
  stashes: { name: string; sha: string; subject: string }[];
}
export type GitDiffTarget =
  | { kind: "commit"; sha: string }
  | { kind: "staged" }
  | { kind: "unstaged" }
  | { kind: "untracked" };
export interface GitStatus {
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];
}
export interface GitFileDiff {
  /** 変更前の内容。追加されたファイルは空文字 */
  oldContent: string;
  /** 変更後の内容。削除されたファイルは空文字 */
  newContent: string;
  /** どちらかが NUL を含む (内容は返さない) */
  binary: boolean;
  /** どちらかが上限を超えた (内容は返さない) */
  tooLarge: boolean;
}
type GitFailure = { ok: false; error: string };
export type GitLogResponse =
  | { ok: true; commits: GitCommit[]; hasMore: boolean }
  | GitFailure;
export type GitRefsResponse = ({ ok: true } & GitRefs) | GitFailure;
export type GitStatusResponse = ({ ok: true } & GitStatus) | GitFailure;
export type GitCommitResponse =
  | { ok: true; commit: GitCommitDetail; files: GitFileChange[] }
  | GitFailure;
export type GitFileDiffResponse = ({ ok: true } & GitFileDiff) | GitFailure;
export type GitFingerprintResponse =
  | { ok: true; fingerprint: string }
  | GitFailure;
/** Git タブの書き込み操作の応答。notMerged は強制すれば消せる削除の失敗 */
export type GitOpResponse =
  | { ok: true }
  | { ok: false; error: string; notMerged?: boolean };
/** ブランチの追跡先 (`branch.<name>.remote` と `branch.<name>.merge`) */
export interface GitBranchUpstream {
  remote: string;
  merge: string;
}
/** sha と upstream は、削除を元に戻すときに git:branch-create へ渡す */
/**
 * 失敗の notMerged は取り込まれていないコミットがある (強制なら消せる)。
 * inWorktree はブランチを使っている作業ツリー (removeWorktree なら消せる)。
 * 成功の removedWorktree は、ブランチと一緒に消した作業ツリー (元に戻すでは戻らない)
 */
export type GitBranchDeleteResponse =
  | {
      ok: true;
      sha: string;
      upstream?: GitBranchUpstream;
      removedWorktree?: string;
    }
  | { ok: false; error: string; notMerged?: boolean; inWorktree?: string };
export type GitPushResponse =
  | { ok: true; remote: string; remoteBranch: string }
  | GitFailure;

// ファイルペイン
export type FileOpenResponse =
  | {
      ok: true;
      content: string;
      mimeType: string;
      size: number;
      mtimeMs: number;
      editable: boolean;
    }
  | { ok: false; error: string };

export interface FileTreeEntry {
  name: string;
  type: "dir" | "file";
  gitStatus?: "M" | "A" | "?" | "D";
}

export type FileListResponse =
  | { ok: true; entries: FileTreeEntry[]; truncated: boolean }
  | { ok: false; error: string };

/** 裏の Claude (コマンドパレットの「聞く」) との会話の 1 発話 */
export interface AskMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface AskState {
  messages: AskMessage[];
  /** 答えを待っている */
  busy: boolean;
  error: string | null;
}

export type AskResult = { ok: true } | { ok: false; error: string };

/** worktree 内の全ファイルのパス (worktree からの相対。gitignore 対象は含まない) */
export type FileIndexResponse =
  | { ok: true; paths: string[]; truncated: boolean }
  | { ok: false; error: string };

export type FileWriteResponse =
  | { ok: true; mtimeMs: number }
  | { ok: false; code: "conflict" | "error"; error: string; mtimeMs?: number };
