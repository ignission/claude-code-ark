/**
 * SplitViewPane - PC用セッションビュー (上部バー + 左ペイン + ファイルペイン + 図ペインの最大3ペイン)
 *
 * 上部バーは1本にまとめる。左にセッションの主ラベル・ブランチ・状態チップ、
 * 中央に「端末 / 会話」の切り替え、右に1タップの操作 (ファイルの添付 / 画像の
 * 貼り付け / メッセージのショートカット / 端末のバッファのコピー / 端末の再読み込み /
 * 入力バーの表示)・図の開閉と `…` メニュー (SessionHeaderMenu)。
 * 端末に関する操作はすべて1タップで届かせ、`…` にはセッション全体の操作
 * (通知・削除) だけを残す。端末専用の操作はTerminalPaneHandle経由で
 * TerminalPaneに頼む。
 * 中ペイン (ファイル) と右ペイン (図) は、それぞれ上部バーのトグルで独立に開閉できる。
 * 並びは 左 | ファイル | 図 で、リサイザは各ペインの手前に 1 本ずつ。
 * - 中ペインの中身は呼び出し側が `filePane` で渡す (SplitViewPane は中身を知らない)。
 *   `fileOpenSeq` が増えたら自動で開く。1 度見せたら、閉じても外さずに hidden で残す
 *   (外すと未保存の編集が消える)。見えているかは `filePane(visible)` で伝える
 * - 右ペインは図が未選択でも開閉できる。中身は DiagramPane（B-0a の図ペイン）
 * - 幅の制約は lib/split-pane-widths.ts (左 360 / ファイル 360 / 図 320 の最小幅。
 *   足りないときはファイル、図の順に縮める)
 * - ドラッグ中は 3 ペインとも pointer-events-none にする (端末と図は iframe)
 *
 * - diagram は TerminalPane のタブ機構から外れ、右ペイン専属になった
 *   （タブ自体は sessionTabs 上には残るが、非表示のまま「開いている印」として使う）
 * - 図（openDiagramTab）の activation id が変わると showBoard を自動 true にする
 * - 左ペインのモード / 各ペインの幅 / 各ペインの開閉状態は localStorage に永続化
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
import { cn } from "@/lib/utils";
import {
  type HeaderQuickAction,
  headerQuickActions,
  inputBarToggleLabel,
  resolveSessionHeaderLabels,
} from "../lib/session-header";
import {
  BOARD_MIN_WIDTH,
  FILE_MIN_WIDTH,
  fitPaneWidths,
  LEFT_MIN_WIDTH,
  RESIZER_WIDTH,
} from "../lib/split-pane-widths";
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

const STORAGE_KEY_FILE_WIDTH = "ark-split-file-width";
const STORAGE_KEY_SHOW_FILES = "ark-split-show-files";
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
  /** 作業中の画面末尾（会話ビューで動きを見せる） */
  liveTail?: string;
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
  /**
   * 中ペインの中身。Dashboard が FilePane を渡す (SplitViewPane は中身を知らない)。
   * visible は「中ペインが開いていて、このセッションが選択中」。閉じている間も
   * マウントしたままなので、中身はこれを見て購読などを絞る
   */
  filePane?: (visible: boolean) => ReactNode;
  /** live なファイルオープンのたびに増える数。増えたら中ペインを開く */
  fileOpenSeq?: number;
}

function readSavedWidth(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function readSavedFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function SplitViewPane(props: SplitViewPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [boardWidth, setBoardWidth] = useState<number>(
    () => readSavedWidth(STORAGE_KEY_BOARD_WIDTH) ?? 420
  );
  const [fileWidth, setFileWidth] = useState<number>(
    () => readSavedWidth(STORAGE_KEY_FILE_WIDTH) ?? 520
  );
  // ドラッグ中のリサイザ。どちらでも 3 ペインとも pointer-events-none にする
  const [isDragging, setIsDragging] = useState<"file" | "board" | null>(null);
  const [showBoard, setShowBoard] = useState<boolean>(() =>
    readSavedFlag(STORAGE_KEY_SHOW_BOARD)
  );
  const [showFiles, setShowFiles] = useState<boolean>(() =>
    readSavedFlag(STORAGE_KEY_SHOW_FILES)
  );
  // ResizeObserver から最新の幅を読むため（購読を張り直さずに済ませる）
  const widthsRef = useRef({ file: fileWidth, board: boardWidth });
  widthsRef.current = { file: fileWidth, board: boardWidth };
  const hasFilePane = props.filePane !== undefined;
  // 幅の計算では、hidden で残しているだけの中ペインを閉じているものとして扱う
  const filesVisible = showFiles && hasFilePane;
  // 中ペインが実際に見えているか (非選択のセッションは Dashboard が hidden にする)
  const filePaneVisible = filesVisible && props.isActive;
  // 1 度見せた中ペインは、閉じても外さない (未保存の編集と undo 履歴を保つ)。
  // 見せたことの無いセッションではマウントしない (開いてもいないファイルを読まない)
  const [fileEverShown, setFileEverShown] = useState(filePaneVisible);
  if (filePaneVisible && !fileEverShown) setFileEverShown(true);
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
        // text-muted-foreground と競合するので、cn (tailwind-merge) で解決させる
        className={cn(
          HEADER_ICON_BUTTON,
          terminalInputBarVisible && "bg-muted text-foreground"
        )}
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

  // fileOpenSeq が前回より増えたら（live なファイルオープン）中ペインを開く。
  // 初回マウントの値では開かない（保存された開閉状態に従う）。
  // effect ではなく描画中に開く: 中ペインは hidden で残っているので、effect で
  // 開くと 1 コミットだけ display:none のままエディタが行へスクロールしようとし、
  // 行指定のスクロールが効かない
  const [seenFileOpenSeq, setSeenFileOpenSeq] = useState(props.fileOpenSeq);
  if (props.fileOpenSeq !== seenFileOpenSeq) {
    setSeenFileOpenSeq(props.fileOpenSeq);
    if (
      props.fileOpenSeq !== undefined &&
      seenFileOpenSeq !== undefined &&
      props.fileOpenSeq > seenFileOpenSeq
    ) {
      setShowFiles(true);
    }
  }
  const prevFileOpenSeqRef = useRef(props.fileOpenSeq);
  useEffect(() => {
    const seq = props.fileOpenSeq;
    const prev = prevFileOpenSeqRef.current;
    if (seq !== undefined && prev !== undefined && seq > prev) {
      try {
        localStorage.setItem(STORAGE_KEY_SHOW_FILES, "1");
      } catch {
        // ignore
      }
    }
    prevFileOpenSeqRef.current = seq;
  }, [props.fileOpenSeq]);

  // コンテナ幅変化時に、ファイル・図の幅を最小幅の制約内に収める（表示中のみ意味あり）
  useEffect(() => {
    const el = containerRef.current;
    if (!el || (!filesVisible && !showBoard)) return;
    const observer = new ResizeObserver(() => {
      const total = el.clientWidth;
      if (total <= 0) return;
      const fit = fitPaneWidths({
        total,
        file: filesVisible ? widthsRef.current.file : null,
        board: showBoard ? widthsRef.current.board : null,
      });
      if (filesVisible) setFileWidth(fit.file);
      if (showBoard) setBoardWidth(fit.board);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [filesVisible, showBoard]);

  const handleMouseDownFile = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging("file");
  }, []);
  const handleMouseDownBoard = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging("board");
  }, []);

  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: MouseEvent) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const { file, board } = widthsRef.current;
      if (isDragging === "file") {
        // ファイルの幅 = (図が開いていれば図の左端、無ければコンテナ右端) - カーソル
        const rightEdge = showBoard
          ? rect.right - board - RESIZER_WIDTH
          : rect.right;
        const next = Math.max(FILE_MIN_WIDTH, rightEdge - e.clientX);
        setFileWidth(
          fitPaneWidths({
            total: rect.width,
            file: next,
            board: showBoard ? board : null,
          }).file
        );
      } else {
        // 図の幅 = コンテナ右端からカーソルまでの距離。ファイルの幅は侵さない
        const room =
          rect.width -
          LEFT_MIN_WIDTH -
          RESIZER_WIDTH -
          (filesVisible ? file + RESIZER_WIDTH : 0);
        const next = rect.right - e.clientX;
        setBoardWidth(Math.max(BOARD_MIN_WIDTH, Math.min(next, room)));
      }
    };
    const onUp = () => {
      const kind = isDragging;
      setIsDragging(null);
      try {
        if (kind === "file") {
          localStorage.setItem(
            STORAGE_KEY_FILE_WIDTH,
            String(widthsRef.current.file)
          );
        } else {
          localStorage.setItem(
            STORAGE_KEY_BOARD_WIDTH,
            String(widthsRef.current.board)
          );
        }
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
  }, [isDragging, showBoard, filesVisible]);

  const handleToggleFiles = useCallback(() => {
    setShowFiles(prev => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY_SHOW_FILES, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

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
          右 = 1タップの操作・図の開閉と `…` メニュー */}
      {/* 狭い幅 (1024px前後) では右側を中身の幅に縮め、主ラベルに幅を回す。
          広い幅だけ左右を同じ幅にしてセグメントを中央に置く。

          さらに狭いとき (コンテナ42rem未満) は「装飾から削る」順で畳む。
          1タップの操作は最後まで消さない:
          1. 文言を読み上げだけに残してアイコンにする (ブランチ・状態チップ・
             セグメント・図)。`sr-only` は position:absolute なので、
             文字だけでなく flex の gap も消える
          2. それでも足りない分は左の箱が引き受ける。主ラベルが縮み、
             最後は `overflow-hidden` で箱の中に収める (上部バーは横に溢れない) */}
      <header className="@container h-13 shrink-0 border-b border-border flex items-center gap-3 pl-5 pr-3">
        <div className="flex flex-1 basis-0 min-w-0 items-center gap-2.5 overflow-hidden">
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
            className="min-w-0 shrink-[999] truncate text-[13px] text-muted-foreground @max-2xl:sr-only"
            title={labels.branch}
          >
            {labels.branch}
          </span>
          <StatusChip
            statusKey={resolveStatusKey(true, props.bridgeStatus)}
            className="shrink-0"
            labelClassName="@max-2xl:sr-only"
          />
        </div>
        <SegmentedControl
          label="左ペインの表示"
          options={LEFT_MODE_OPTIONS}
          value={leftMode}
          onChange={handleLeftModeChange}
          labelClassName="@max-2xl:sr-only"
        />
        <div className="flex flex-none @4xl:flex-1 @4xl:basis-0 min-w-0 items-center justify-end gap-1">
          {quickActions.map(action => quickActionItems[action])}
          {hasFilePane && (
            <button
              type="button"
              onClick={handleToggleFiles}
              aria-label="ファイル"
              aria-pressed={showFiles}
              title={showFiles ? "ファイルを閉じる" : "ファイルを開く"}
              className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sm px-2.5 text-[13px] font-semibold transition-colors ${
                showFiles
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <VIEW_MODE_ICONS.files className="size-4.5" aria-hidden="true" />
              <span className="@max-2xl:sr-only">ファイル</span>
            </button>
          )}
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
            <span className="@max-2xl:sr-only">図</span>
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
              liveTail={props.liveTail}
              onSendMessage={props.onSendMessage}
              onSendKey={props.onSendKey}
              onUploadFile={props.onUploadFile}
            />
          </div>
        </div>

        {/* リサイザ・中ペイン (ファイル)。閉じている間はリサイザごと hidden で残す */}
        {props.filePane && (fileEverShown || filePaneVisible) && (
          <>
            <button
              type="button"
              aria-label="左右の幅を調整"
              onMouseDown={handleMouseDownFile}
              className={cn(
                "relative w-1 shrink-0 cursor-col-resize bg-border hover:bg-primary/50 transition-colors",
                isDragging === "file" && "bg-primary/70",
                !filesVisible && "hidden"
              )}
            >
              <span className="absolute inset-y-0 -left-1 -right-1" />
            </button>
            <div
              style={{ width: fileWidth, flexShrink: 0 }}
              className={cn(
                "h-full overflow-hidden",
                isDragging && "pointer-events-none",
                !filesVisible && "hidden"
              )}
            >
              {props.filePane(filePaneVisible)}
            </div>
          </>
        )}

        {/* リサイザ・右ペイン (図) */}
        {showBoard && (
          <>
            <button
              type="button"
              aria-label="左右の幅を調整"
              onMouseDown={handleMouseDownBoard}
              className={`relative w-1 shrink-0 cursor-col-resize bg-border hover:bg-primary/50 transition-colors ${
                isDragging === "board" ? "bg-primary/70" : ""
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
