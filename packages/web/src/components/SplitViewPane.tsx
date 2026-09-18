/**
 * SplitViewPane - PC用セッションビュー (上部バー + 左ペイン + 右ペインの左右2ペイン)
 *
 * 上部バーは1本にまとめる。左にセッションの主ラベル・ブランチ・状態チップ、
 * 中央に「端末 / 会話」の切り替え、右に1タップの操作 (ファイルの添付 / 画像の
 * 貼り付け / メッセージのショートカット / 端末のバッファのコピー / 端末の再読み込み /
 * 入力バーの表示)・図の開閉と `…` メニュー (SessionHeaderMenu)。
 * 端末に関する操作はすべて1タップで届かせ、`…` にはセッション全体の操作
 * (通知・削除) だけを残す。端末専用の操作はTerminalPaneHandle経由で
 * TerminalPaneに頼む。
 * 右ペインは図が未選択でも上部バーのトグルで開閉できる。
 * 中身は DiagramPane（B-0a の図ペイン）。
 *
 * - diagram は TerminalPane のタブ機構から外れ、右ペイン専属になった
 *   （タブ自体は sessionTabs 上には残るが、非表示のまま「開いている印」として使う）
 * - 図（openDiagramTab）の activation id が変わると showBoard を自動 true にする
 * - 左ペインのモード / 右ペイン幅 / 右ペイン開閉状態は localStorage に永続化
 * - 左ペインは端末・会話の両方をマウントしたまま display 切替する。ttyd は
 *   iframe（別ブラウジングコンテキスト）なので、アンマウントすると再接続に
 *   なってしまう（.claude/rules/frontend-codegen.md）
 * - 会話ビューには端末への切り替えを持たせない。切り替えは上部バーだけが担う
 */

import type {
  BridgeSessionStatus,
  ClientToServerEvents,
  DiagramCommentsResponse,
  DiagramDeleteResponse,
  DiagramListItem,
  ManagedSession,
  MessageShortcut,
  ServerToClientEvents,
  SpecialKey,
  Worktree,
} from "@ark/shared";
import { Copy, ImagePlus, Keyboard, Paperclip, RefreshCw } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Socket } from "socket.io-client";
import {
  type HeaderQuickAction,
  headerQuickActions,
  inputBarToggleLabel,
  resolveSessionHeaderLabels,
} from "../lib/session-header";
import {
  normalizeSplitViewLeftMode,
  readSavedSplitViewLeftMode,
  SPLIT_VIEW_LEFT_MODE_CHANGE_EVENT,
  type SplitViewLeftMode,
  type SplitViewLeftModeChangeDetail,
  STORAGE_KEY_SPLIT_LEFT_MODE,
  shouldAcceptTerminalFileDrop,
  shouldSubscribeChat,
  writeSavedSplitViewLeftMode,
} from "../lib/split-view-left-mode";
import { resolveStatusKey } from "../lib/status-tone";
import { VIEW_MODE_ICONS } from "../lib/view-mode-icons";
import { DiagramPane } from "./DiagramPane";
import { MessageShortcutManagerDialog } from "./MessageShortcutManagerDialog";
import { MessageShortcutQuickButton } from "./MessageShortcutQuickButton";
import { SegmentedControl, type SegmentOption } from "./SegmentedControl";
import { SessionHeaderMenu } from "./SessionHeaderMenu";
import { SplitChatPane } from "./SplitChatPane";
import { StatusChip } from "./StatusChip";
import {
  TerminalPane,
  type TerminalPaneHandle,
  type ViewerTab,
} from "./TerminalPane";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const BOARD_MIN_WIDTH = 320;
const BOARD_MAX_RATIO = 0.6;
const STORAGE_KEY_BOARD_WIDTH = "ark-split-board-width";
const STORAGE_KEY_SHOW_BOARD = "ark-split-show-board";

/** 上部バーの1タップ操作と `…` に共通の見た目 (32px・角丸・押すと紙色) */
const HEADER_ICON_BUTTON =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground";

const LEFT_MODE_OPTIONS: readonly SegmentOption<SplitViewLeftMode>[] = [
  { value: "terminal", label: "端末", icon: VIEW_MODE_ICONS.terminal },
  { value: "chat", label: "会話", icon: VIEW_MODE_ICONS.chat },
];

interface SplitViewPaneProps {
  socket: TypedSocket | null;
  isConnected: boolean;
  diagramCommentsUpdate: {
    worktreePath: string;
    relPath: string;
    sequence: number;
  } | null;
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
  session: ManagedSession;
  /**
   * このセッションが現在選択中か。SplitViewPane は Dashboard で全セッション
   * ぶんが常時マウントされる（非選択は `hidden`）ため、会話ビューの JSONL
   * 購読はこれと左ペインのモードの両方で絞る（shouldSubscribeChat）
   */
  isActive: boolean;
  /** session:previews 由来のセッション状態（会話ビューの busy / AWAITING 表示） */
  bridgeStatus?: BridgeSessionStatus;
  /** AWAITING 時の確認 UI 生テキスト（会話ビューのバナー表示） */
  awaitingText?: string;
  worktree: Worktree | undefined;
  /** 所属リポジトリの名前。表示名が無いときの主ラベル */
  repoName?: string;
  /** サイドバーで設定したworktreeの表示名。未設定はnull */
  displayName?: string | null;
  tabs: ViewerTab[];
  activeTabIndex: number;
  onTabSelect: (index: number) => void;
  onTabClose: (index: number) => void;
  onSelectDiagram: (relPath: string, worktreePath: string) => void;
  onSendMessage: (message: string) => void;
  onSendKey: (key: SpecialKey) => void;
  onDeleteSession: () => void;
  onUploadFile?: (data: {
    base64Data: string;
    mimeType: string;
    originalFilename?: string;
  }) => Promise<{ path: string; filename: string; originalFilename?: string }>;
  onCopyBuffer?: () => Promise<string | null>;
  messageShortcuts: MessageShortcut[];
  onCreateShortcut: (message: string) => void;
  onUpdateShortcut: (id: string, patch: { message?: string }) => void;
  onDeleteShortcut: (id: string) => void;
  /** Notification APIが使える環境か。falseなら `…` メニューに通知の項目を出さない */
  notificationsSupported?: boolean;
  /** このセッションの通知が有効か (未設定は有効) */
  notificationsEnabled?: boolean;
  onNotificationsEnabledChange?: (enabled: boolean) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readSavedBoardWidth(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_BOARD_WIDTH);
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function readSavedShowBoard(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY_SHOW_BOARD) === "1";
  } catch {
    return false;
  }
}

export function SplitViewPane(props: SplitViewPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [boardWidth, setBoardWidth] = useState<number>(
    () => readSavedBoardWidth() ?? 420
  );
  const [isDragging, setIsDragging] = useState(false);
  const [showBoard, setShowBoard] = useState<boolean>(() =>
    readSavedShowBoard()
  );
  // 左ペインのモード。選択は PC 全体で共有し、常時マウント済みの別セッション
  // および別ブラウザタブからの変更にも追随する。
  const [leftMode, setLeftMode] = useState<SplitViewLeftMode>(
    readSavedSplitViewLeftMode
  );

  useEffect(() => {
    const handleLeftModeChange = (event: Event) => {
      const { mode } = (event as CustomEvent<SplitViewLeftModeChangeDetail>)
        .detail;
      setLeftMode(mode);
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY_SPLIT_LEFT_MODE) {
        setLeftMode(normalizeSplitViewLeftMode(event.newValue));
      }
    };

    window.addEventListener(
      SPLIT_VIEW_LEFT_MODE_CHANGE_EVENT,
      handleLeftModeChange
    );
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(
        SPLIT_VIEW_LEFT_MODE_CHANGE_EVENT,
        handleLeftModeChange
      );
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const handleLeftModeChange = useCallback((next: SplitViewLeftMode) => {
    writeSavedSplitViewLeftMode(next);
    setLeftMode(next);
  }, []);

  // 端末専用の操作は1タップのボタンからTerminalPaneに頼む。入力バーの表示は、
  // ボタンの文言と押下状態 (aria-pressed) のためにTerminalPaneから知らせてもらう
  const terminalRef = useRef<TerminalPaneHandle>(null);
  const [terminalInputBarVisible, setTerminalInputBarVisible] = useState(false);
  // ショートカットの管理ダイアログは1タップのボタンから開く。ボタン側に持たせると
  // メニューが閉じた時点でダイアログごと消えるので、ここ (バーの外) に置く
  const [showShortcutManager, setShowShortcutManager] = useState(false);

  // 1タップで届かせる操作。どれを出すかの判断はlib/session-header.tsに寄せる
  const quickActions = headerQuickActions({
    leftMode,
    canUploadFile: props.onUploadFile !== undefined,
    canCopyBuffer: props.onCopyBuffer !== undefined,
  });
  const inputBarLabel = inputBarToggleLabel(terminalInputBarVisible);
  // Recordにして、HeaderQuickActionを足したときの描き忘れを型で拾う
  const quickActionItems: Record<HeaderQuickAction, ReactNode> = {
    "attach-file": (
      <button
        key="attach-file"
        type="button"
        aria-label="ファイルを添付"
        title="ファイルを添付"
        onClick={() => terminalRef.current?.openFilePicker()}
        className={HEADER_ICON_BUTTON}
      >
        <Paperclip className="size-5" aria-hidden="true" />
      </button>
    ),
    "paste-image": (
      <button
        key="paste-image"
        type="button"
        aria-label="画像を貼り付け"
        title="画像を貼り付け"
        onClick={() => terminalRef.current?.pasteImage()}
        className={HEADER_ICON_BUTTON}
      >
        <ImagePlus className="size-5" aria-hidden="true" />
      </button>
    ),
    "message-shortcuts": (
      <MessageShortcutQuickButton
        key="message-shortcuts"
        shortcuts={props.messageShortcuts}
        onSendMessage={props.onSendMessage}
        onManage={() => setShowShortcutManager(true)}
        className={HEADER_ICON_BUTTON}
      />
    ),
    "copy-buffer": (
      <button
        key="copy-buffer"
        type="button"
        aria-label="端末のバッファをコピー"
        title="端末のバッファをコピー"
        onClick={() => terminalRef.current?.copyBuffer()}
        className={HEADER_ICON_BUTTON}
      >
        <Copy className="size-5" aria-hidden="true" />
      </button>
    ),
    "reload-terminal": (
      <button
        key="reload-terminal"
        type="button"
        aria-label="端末を再読み込み"
        title="端末を再読み込み"
        onClick={() => terminalRef.current?.reload()}
        className={HEADER_ICON_BUTTON}
      >
        <RefreshCw className="size-5" aria-hidden="true" />
      </button>
    ),
    // 出したままにできる操作なので、今の状態を押下状態 (aria-pressed) で示す
    "toggle-input-bar": (
      <button
        key="toggle-input-bar"
        type="button"
        aria-label={inputBarLabel}
        aria-pressed={terminalInputBarVisible}
        title={inputBarLabel}
        onClick={() => terminalRef.current?.toggleInputBar()}
        className={
          terminalInputBarVisible
            ? `${HEADER_ICON_BUTTON} bg-muted text-foreground`
            : HEADER_ICON_BUTTON
        }
      >
        <Keyboard className="size-5" aria-hidden="true" />
      </button>
    ),
  };

  const labels = resolveSessionHeaderLabels({
    displayName: props.displayName,
    repoName: props.repoName,
    branch: props.worktree?.branch,
    worktreePath: props.session.worktreePath,
  });

  // 現在図は session ごとに最大1件。diagram タブは左タブバーから除外され、
  // ここでのみ参照する。
  const diagramTab = props.tabs.find(t => t.type === "diagram");

  // current diagram の activation id が変わったら右ペインを自動表示する。
  // tabs は session 単位でスコープされているため、他セッションの変化には反応しない。
  // 同じ relPath の board_open でも id は新しくなるため再表示できる。
  //
  // 「lastDiagramPath からの復元」除外について:
  // このコンポーネントは Dashboard.tsx で全セッション分が session.id をキーに
  // 常時マウントされている（selectedSessionId でなくても hidden で存在し続ける）。
  // ページロード直後、対象セッションが sessions に現れた最初のレンダーでは
  // props.tabs はまだ [terminal] のみ（sessionTabs の復元用 setState は
  // Dashboard 側の別 effect で非同期に行われるため、同一コミットには乗らない）。
  // そのため「マウント時点で図タブが既にあれば増加とみなさない」という直感的な
  // 前提は成り立たない ― prevBoardCountRef は常にマウント直後は 0 から始まり、
  // 直後に復元 openDiagramTab が発火すると 0→1 の「増加」として観測されてしまう。
  // ここでは live な board_open / user switch だけを自動表示したいので、
  // restoredOnLoad タグの付いた復元タブは除外する
  // （タグは openDiagramTab の呼び出し元 = Dashboard.tsx の復元 effect が付与する）。
  const prevDiagramIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const currentId = diagramTab?.id;
    if (
      currentId !== undefined &&
      currentId !== prevDiagramIdRef.current &&
      diagramTab?.restoredOnLoad !== true
    ) {
      setShowBoard(true);
    }
    prevDiagramIdRef.current = currentId;
  }, [diagramTab]);

  // コンテナ幅変化時に board 幅を最大比率内に丸める（表示中のみ意味あり）
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !showBoard) return;
    const observer = new ResizeObserver(() => {
      const total = el.clientWidth;
      if (total <= 0) return;
      const max = Math.floor(total * BOARD_MAX_RATIO);
      setBoardWidth(prev => clamp(prev, BOARD_MIN_WIDTH, max));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [showBoard]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: MouseEvent) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const total = rect.width;
      // 右ペイン（board）の幅 = コンテナ右端からカーソルまでの距離
      const next = rect.right - e.clientX;
      const max = Math.floor(total * BOARD_MAX_RATIO);
      const clamped = clamp(next, BOARD_MIN_WIDTH, max);
      setBoardWidth(clamped);
    };
    const onUp = () => {
      setIsDragging(false);
      try {
        localStorage.setItem(STORAGE_KEY_BOARD_WIDTH, String(boardWidth));
      } catch {
        // ignore
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isDragging, boardWidth]);

  const handleToggleBoard = useCallback(() => {
    setShowBoard(prev => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY_SHOW_BOARD, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  return (
    <div className="h-full flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-card">
      {/* 上部バー: 左 = 主ラベル・ブランチ・状態チップ、中央 = 端末 / 会話、
          右 = 図の開閉と `…` メニュー */}
      {/* 狭い幅 (1024px前後) では右側を中身の幅に縮め、主ラベルに幅を回す。
          広い幅だけ左右を同じ幅にしてセグメントを中央に置く */}
      <header className="@container h-13 shrink-0 border-b border-border flex items-center gap-3 pl-5 pr-3">
        <div className="flex flex-1 basis-0 min-w-0 items-center gap-2.5">
          {/* 主ラベルを先に守り、ブランチから省略する。縮み率をブランチ側に
              大きく振ることで、ブランチが尽きるまで主ラベルは縮まない。
              主ラベルも縮めるのは、右側 (1タップの操作) が増えて左が
              狭まったとき、状態チップを押し出して上部バーからはみ出さないため */}
          <span
            className="min-w-0 max-w-[60%] truncate text-[17px] font-semibold tracking-[-0.01em]"
            title={labels.primary}
          >
            {labels.primary}
          </span>
          <span
            className="min-w-0 shrink-[999] truncate text-[13px] text-muted-foreground"
            title={labels.branch}
          >
            {labels.branch}
          </span>
          <StatusChip
            statusKey={resolveStatusKey(true, props.bridgeStatus)}
            className="shrink-0"
          />
        </div>
        <SegmentedControl
          label="左ペインの表示"
          options={LEFT_MODE_OPTIONS}
          value={leftMode}
          onChange={handleLeftModeChange}
        />
        <div className="flex flex-none @4xl:flex-1 @4xl:basis-0 min-w-0 items-center justify-end gap-1">
          {quickActions.map(action => quickActionItems[action])}
          <button
            type="button"
            onClick={handleToggleBoard}
            aria-label="図"
            aria-pressed={showBoard}
            title={showBoard ? "図を閉じる" : "図を開く"}
            className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sm px-2.5 text-[13px] font-semibold transition-colors ${
              showBoard
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            <VIEW_MODE_ICONS.board className="size-4.5" aria-hidden="true" />
            <span>図</span>
          </button>
          <SessionHeaderMenu
            worktree={props.worktree}
            notificationsSupported={props.notificationsSupported ?? false}
            notificationsEnabled={props.notificationsEnabled ?? true}
            onNotificationsEnabledChange={props.onNotificationsEnabledChange}
            onDeleteSession={props.onDeleteSession}
          />
        </div>
      </header>

      <div ref={containerRef} className="flex-1 min-h-0 flex relative">
        {/* 左ペイン: 端末 / 会話（上部バーで切替。両方マウントしたまま display 切替）
            リサイズ中は pointer-events-none にする。ターミナルは ttyd の iframe
            （別ブラウジングコンテキスト）で、分割線を左へドラッグしてカーソルが
            この上に乗ると mousemove / mouseup を iframe が飲み込み、window の
            リスナーへ届かなくなる。結果、幅が更新されず（ターミナルが狭くならない）、
            mouseup も発火せずドラッグが解除されない（カーソル追従が止まらない）。
            右ペイン（ボード）と同様に透過させて window リスナーへ届かせる。 */}
        <div
          className={`h-full flex-1 min-w-0 overflow-hidden ${
            isDragging ? "pointer-events-none" : ""
          }`}
        >
          {/* 端末: ttyd の再接続を避けるため hidden で残置する */}
          <div className={leftMode === "terminal" ? "h-full" : "hidden"}>
            <TerminalPane
              ref={terminalRef}
              session={props.session}
              worktree={props.worktree}
              isVisible={shouldAcceptTerminalFileDrop(props.isActive, leftMode)}
              tabs={props.tabs}
              activeTabIndex={props.activeTabIndex}
              onTabSelect={props.onTabSelect}
              onTabClose={props.onTabClose}
              onSendMessage={props.onSendMessage}
              onSendKey={props.onSendKey}
              onUploadFile={props.onUploadFile}
              onCopyBuffer={props.onCopyBuffer}
              onInputBarVisibleChange={setTerminalInputBarVisible}
            />
          </div>

          {/* 会話: JSONL tail のチャットビュー。入力欄 / AUQ カード / slash 補完 /
              ファイルアップロード / busy・AWAITING 表示を内包する */}
          <div className={leftMode === "chat" ? "h-full" : "hidden"}>
            <SplitChatPane
              socket={props.socket}
              session={props.session}
              isActive={shouldSubscribeChat(props.isActive, leftMode)}
              bridgeStatus={props.bridgeStatus}
              awaitingText={props.awaitingText}
              onSendMessage={props.onSendMessage}
              onSendKey={props.onSendKey}
              onUploadFile={props.onUploadFile}
            />
          </div>
        </div>

        {/* リサイザ・右ペイン */}
        {showBoard && (
          <>
            <button
              type="button"
              aria-label="左右の幅を調整"
              onMouseDown={handleMouseDown}
              className={`relative w-1 shrink-0 cursor-col-resize bg-border hover:bg-primary/50 transition-colors ${
                isDragging ? "bg-primary/70" : ""
              }`}
            >
              <span className="absolute inset-y-0 -left-1 -right-1" />
            </button>
            <div
              style={{ width: boardWidth, flexShrink: 0 }}
              className={`h-full overflow-hidden border-l border-border ${
                isDragging ? "pointer-events-none" : ""
              }`}
            >
              <DiagramPane
                socket={props.socket}
                isConnected={props.isConnected}
                diagramCommentsUpdate={props.diagramCommentsUpdate}
                listDiagrams={props.listDiagrams}
                deleteDiagram={props.deleteDiagram}
                getDiagramComments={props.getDiagramComments}
                createDiagramComment={props.createDiagramComment}
                replyDiagramComment={props.replyDiagramComment}
                resolveDiagramComment={props.resolveDiagramComment}
                deleteDiagramComment={props.deleteDiagramComment}
                sendDiagramComment={props.sendDiagramComment}
                sessionId={props.session.id}
                worktreePath={
                  diagramTab?.worktreePath ?? props.session.worktreePath
                }
                relPath={diagramTab?.relPath}
                onSelectDiagram={props.onSelectDiagram}
              />
            </div>
          </>
        )}
      </div>

      <MessageShortcutManagerDialog
        open={showShortcutManager}
        onOpenChange={setShowShortcutManager}
        shortcuts={props.messageShortcuts}
        onCreate={props.onCreateShortcut}
        onUpdate={props.onUpdateShortcut}
        onDelete={props.onDeleteShortcut}
      />
    </div>
  );
}
