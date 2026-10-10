/**
 * SplitViewPane - PC用セッションビュー (上部バー + 左ペイン + 右の作業エリア)
 *
 * 上部バーは1本にまとめる。左にセッションの主ラベル・ブランチ・状態チップ、
 * 中央に「端末 / 会話」の切り替え、右に1タップの操作 (ファイルの添付 / 画像の
 * 貼り付け / メッセージのショートカット / 端末のバッファのコピー / 端末の再読み込み /
 * 入力バーの表示)・作業エリアの開閉 (「パネル」) と `…` メニュー (SessionHeaderMenu)。
 * 端末に関する操作はすべて1タップで届かせ、`…` にはセッション全体の操作
 * (通知・削除) だけを残す。端末専用の操作はTerminalPaneHandle経由で
 * TerminalPaneに頼む。
 *
 * 右側は作業エリア 1 つで、上端のタブ「図 / ファイル / Git」で中身を切り替える。
 * 並びは 左 | 作業エリア で、リサイザは 1 本。
 * (以前は 左 | ファイル | 図 の 3 ペインだった。1680px の画面で 3 つ開くと左ペインが
 * 最小幅の 360px まで縮み、図とコードを並べたいのは図のリンクを踏んだ直後だけだった)
 * - 「図」の中身は DiagramPane。作業エリアを閉じると外す (従来どおり)。
 *   「ファイル」のタブを見ている間は外さずに hidden で残す (iframe を作り直さない)
 * - 「ファイル」の中身は呼び出し側が `filePane` で渡す (SplitViewPane は中身を知らない)。
 *   初めて実際に見せるまでマウントせず、1 度見せたら、タブを替えても作業エリアを
 *   閉じても外さずに hidden で残す (外すと未保存の編集が消える)。
 *   見えているかは `filePane(visible)` で伝える
 * - 「Git」の中身も呼び出し側が `gitPane` で渡す。マウントの扱いは「ファイル」と同じ
 *   (初めて見せるまでマウントせず、見せたあとは hidden で残す)。見ている間は作業エリアを
 *   760px まで広げる (保存している幅は変えない。420px ではグラフが読めない)。
 *   自動で「Git」へ替えることは無い
 * - ピーク: 図のコードリンクを踏むと、タブは替えずに「図」の本体を左右に割り、
 *   図の横へコードを出す。中身は呼び出し側が `peek` で渡す。出している間は
 *   作業エリアを 900px まで広げる (保存している幅は変えない)。作業エリアを閉じても
 *   外さない (未保存の編集を保つ)
 * - 自動で開く: 図の activation id が変わる / `peekSeq` が増える → 開いて「図」へ。
 *   `fileOpenSeq` が増える → 開いて「ファイル」へ。どれもマウント時の値では開かない
 * - 幅の制約は lib/split-pane-widths.ts (左 360 / 作業エリア 360 の最小幅)
 * - ドラッグ中は左ペインも作業エリアも pointer-events-none にする (端末と図は iframe)
 *
 * - diagram は TerminalPane のタブ機構から外れ、作業エリア専属になった
 *   （タブ自体は sessionTabs 上には残るが、非表示のまま「開いている印」として使う）
 * - 左ペインのモード / 作業エリアの幅・開閉・タブは localStorage に永続化
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
import {
  Copy,
  ImagePlus,
  Keyboard,
  Paperclip,
  RefreshCw,
  X,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
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
  fitWorkAreaWidth,
  gitWorkAreaFloor,
  peekWorkAreaFloor,
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

// 作業エリアの幅と開閉。キーの名前は、右ペインが図だけだった頃のものを引き継ぐ
const STORAGE_KEY_WORK_AREA_WIDTH = "ark-split-board-width";
const STORAGE_KEY_SHOW_WORK_AREA = "ark-split-show-board";
const STORAGE_KEY_RIGHT_TAB = "ark-split-right-tab";
/** 保存した幅が無いときの作業エリアの幅 (ツリー 220px とエディタが並ぶ幅) */
const DEFAULT_WORK_AREA_WIDTH = 560;

type RightTab = "board" | "files" | "git";

const RIGHT_TABS: readonly {
  value: RightTab;
  label: string;
  icon: (typeof VIEW_MODE_ICONS)[keyof typeof VIEW_MODE_ICONS];
}[] = [
  { value: "board", label: "図", icon: VIEW_MODE_ICONS.board },
  { value: "files", label: "ファイル", icon: VIEW_MODE_ICONS.files },
  { value: "git", label: "Git", icon: VIEW_MODE_ICONS.git },
];

/** 上部バーの1タップ操作と `…` に共通の見た目 (32px・角丸・押すと紙色) */
const HEADER_ICON_BUTTON =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground";

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
   * 「ファイル」のタブの中身。Dashboard が FilePane を渡す (SplitViewPane は中身を知らない)。
   * 渡さなければ「ファイル」のタブを出さない。
   * visible は「作業エリアが開いていて、ファイルのタブで、このセッションが選択中」。
   * 見えていない間もマウントしたままなので、中身はこれを見て購読などを絞る
   */
  filePane?: (visible: boolean) => ReactNode;
  /**
   * 「Git」のタブの中身。Dashboard が GitPane を渡す。渡さなければ「Git」のタブを出さない。
   * visible は「作業エリアが開いていて、Git のタブで、このセッションが選択中」。
   * 「ファイル」と同じく、1 度見せたら見えていない間もマウントしたまま
   */
  gitPane?: (visible: boolean) => ReactNode;
  /** live なファイルオープンのたびに増える数。増えたら作業エリアを開いて「ファイル」へ替える */
  fileOpenSeq?: number;
  /**
   * ピーク (図の横に出すコード) の中身。null / 未指定なら出さない。
   * visible は「作業エリアが開いていて、図のタブで、このセッションが選択中」
   */
  peek?: ((visible: boolean) => ReactNode) | null;
  /** ピークを開くたびに増える数。増えたら作業エリアを開いて「図」へ替える */
  peekSeq?: number;
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

function readSavedRightTab(): RightTab {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_RIGHT_TAB);
    return saved === "files" || saved === "git" ? saved : "board";
  } catch {
    return "board";
  }
}

function writeSaved(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 保存できなくても動作には影響しない
  }
}

/**
 * 親が渡す通し番号が前回より増えたときだけ onIncrease を呼ぶ。初回マウントの値では
 * 呼ばない (保存された開閉状態に従う)。
 * effect ではなく描画中に呼ぶ: 作業エリアの中身は hidden で残っているので、effect で
 * 開くと 1 コミットだけ display:none のままエディタが行へスクロールしようとし、
 * 行指定のスクロールが効かない。onIncrease には setState だけを書くこと
 */
function useSeqIncrease(seq: number | undefined, onIncrease: () => void): void {
  const [seen, setSeen] = useState(seq);
  if (seq !== seen) {
    setSeen(seq);
    if (seq !== undefined && seen !== undefined && seq > seen) onIncrease();
  }
}

/** useSeqIncrease と同じ条件で、描画のあとに副作用 (localStorage への保存) を流す */
function useSeqIncreaseEffect(
  seq: number | undefined,
  onIncrease: () => void
): void {
  const prevRef = useRef(seq);
  const onIncreaseRef = useRef(onIncrease);
  onIncreaseRef.current = onIncrease;
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = seq;
    if (seq !== undefined && prev !== undefined && seq > prev) {
      onIncreaseRef.current();
    }
  }, [seq]);
}

export function SplitViewPane(props: SplitViewPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [workWidth, setWorkWidth] = useState<number>(
    () => readSavedWidth(STORAGE_KEY_WORK_AREA_WIDTH) ?? DEFAULT_WORK_AREA_WIDTH
  );
  // ドラッグ中は左ペインも作業エリアも pointer-events-none にする
  const [isDragging, setIsDragging] = useState(false);
  const [showWorkArea, setShowWorkArea] = useState<boolean>(() =>
    readSavedFlag(STORAGE_KEY_SHOW_WORK_AREA)
  );
  const [savedRightTab, setRightTab] = useState<RightTab>(readSavedRightTab);
  // ピークの間の下限 (900px まで) を描画時に決めるために持つ。0 は未計測
  const [containerWidth, setContainerWidth] = useState(0);
  // mouseup と ResizeObserver から最新の幅を読むため（購読を張り直さずに済ませる）
  const workWidthRef = useRef(workWidth);
  workWidthRef.current = workWidth;

  const hasFilePane = props.filePane !== undefined;
  const hasGitPane = props.gitPane !== undefined;
  // 中身を渡されていないタブは出さず、選べない
  const rightTabs = RIGHT_TABS.filter(
    tab =>
      tab.value === "board" ||
      (tab.value === "files" && hasFilePane) ||
      (tab.value === "git" && hasGitPane)
  );
  const rightTab: RightTab = rightTabs.some(t => t.value === savedRightTab)
    ? savedRightTab
    : "board";
  const boardTabActive = rightTab === "board";
  // 「ファイル」の中身が実際に見えているか (非選択のセッションは Dashboard が hidden にする)
  const filePaneVisible =
    showWorkArea && rightTab === "files" && props.isActive;
  // 1 度見せた「ファイル」は、タブを替えても閉じても外さない (未保存の編集と undo 履歴を保つ)。
  // 見せたことの無いセッションではマウントしない (開いてもいないファイルを読まない)
  const [fileEverShown, setFileEverShown] = useState(filePaneVisible);
  if (filePaneVisible && !fileEverShown) setFileEverShown(true);
  // 「Git」も同じ扱い。見せたことの無いセッションでは git を呼ばず、1 度見せたら
  // 読み込んだ一覧と選択を保つ
  const gitPaneVisible = showWorkArea && rightTab === "git" && props.isActive;
  const [gitEverShown, setGitEverShown] = useState(gitPaneVisible);
  if (gitPaneVisible && !gitEverShown) setGitEverShown(true);
  // 図は、作業エリアを開いてから「図」のタブを 1 度見せるまでマウントしない
  // (隠れたまま iframe を読み込ませない)。見せたあとはタブを替えても hidden で残し、
  // 作業エリアを閉じたら外す (右ペインが図だけだった頃と同じ)
  const [boardShown, setBoardShown] = useState(showWorkArea && boardTabActive);
  if (!showWorkArea && boardShown) setBoardShown(false);
  else if (showWorkArea && boardTabActive && !boardShown) setBoardShown(true);

  const peek = props.peek ?? null;
  const peekVisible = showWorkArea && boardTabActive && props.isActive;
  // ピークを出している間は、図とコードを並べて読める幅 (900px) まで広げる。
  // 保存している幅は変えず、ピークを閉じれば元の幅に戻る
  const peekWidens = peek !== null && boardTabActive;
  // 「Git」のタブの間は、グラフと件名が並ぶ幅 (760px) まで広げる。同じく保存しない
  const gitWidens = rightTab === "git";
  /** 今のタブで作業エリアに要る下限。広げる理由が無ければ null */
  const workAreaFloor: ((total: number) => number) | null = peekWidens
    ? peekWorkAreaFloor
    : gitWidens
      ? gitWorkAreaFloor
      : null;
  const renderedWorkWidth = workAreaFloor
    ? Math.max(workWidth, workAreaFloor(containerWidth))
    : workWidth;
  const workAreaFloorRef = useRef(workAreaFloor);
  workAreaFloorRef.current = workAreaFloor;
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

  // current diagram の activation id が変わったら作業エリアを開いて「図」のタブへ替える。
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
      setShowWorkArea(true);
      setRightTab("board");
    }
    prevDiagramIdRef.current = currentId;
  }, [diagramTab]);

  // fileOpenSeq が増えたら（live なファイルオープン・ピークの昇格）「ファイル」を、
  // peekSeq が増えたら（図のコードリンク）「図」を、作業エリアごと開いて見せる
  useSeqIncrease(props.fileOpenSeq, () => {
    setShowWorkArea(true);
    setRightTab("files");
  });
  useSeqIncreaseEffect(props.fileOpenSeq, () => {
    writeSaved(STORAGE_KEY_SHOW_WORK_AREA, "1");
    writeSaved(STORAGE_KEY_RIGHT_TAB, "files");
  });
  useSeqIncrease(props.peekSeq, () => {
    setShowWorkArea(true);
    setRightTab("board");
  });
  useSeqIncreaseEffect(props.peekSeq, () => {
    writeSaved(STORAGE_KEY_SHOW_WORK_AREA, "1");
    writeSaved(STORAGE_KEY_RIGHT_TAB, "board");
  });

  // コンテナ幅の変化に合わせて、作業エリアの幅を最小幅の制約内に収める（表示中のみ意味あり）
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !showWorkArea) return;
    const observer = new ResizeObserver(() => {
      const total = el.clientWidth;
      if (total <= 0) return;
      setContainerWidth(total);
      setWorkWidth(fitWorkAreaWidth(total, workWidthRef.current));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [showWorkArea]);

  const handleResizerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: MouseEvent) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // 作業エリアの幅 = コンテナ右端からカーソルまでの距離
      const next = fitWorkAreaWidth(rect.width, rect.right - e.clientX);
      // ピークの間 (900px まで) と「Git」のタブの間 (760px まで) は下限より狭くできない。
      // 狭くしても描画は下限のままで、見えない幅だけが保存されてしまう
      const floor = workAreaFloorRef.current;
      setWorkWidth(floor ? Math.max(next, floor(rect.width)) : next);
    };
    const onUp = () => {
      setIsDragging(false);
      writeSaved(STORAGE_KEY_WORK_AREA_WIDTH, String(workWidthRef.current));
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
  }, [isDragging]);

  const handleToggleWorkArea = useCallback(() => {
    setShowWorkArea(prev => {
      const next = !prev;
      writeSaved(STORAGE_KEY_SHOW_WORK_AREA, next ? "1" : "0");
      return next;
    });
  }, []);

  const handleCloseWorkArea = useCallback(() => {
    setShowWorkArea(false);
    writeSaved(STORAGE_KEY_SHOW_WORK_AREA, "0");
  }, []);

  const selectRightTab = useCallback((tab: RightTab) => {
    setRightTab(tab);
    writeSaved(STORAGE_KEY_RIGHT_TAB, tab);
  }, []);

  // タブとパネルを結ぶ id。SplitViewPane はセッションごとに並んでマウントされるので、
  // useId で分ける
  const domId = useId();
  const rightTabDomId = (tab: RightTab) => `${domId}-tab-${tab}`;
  const rightPanelDomId = (tab: RightTab) => `${domId}-panel-${tab}`;

  /** ←/→ で隣のタブへ移る (選択とフォーカスを一緒に動かす) */
  const handleRightTabKeyDown = (
    e: KeyboardEvent<HTMLButtonElement>,
    index: number
  ) => {
    const count = rightTabs.length;
    const nextIndex =
      e.key === "ArrowRight"
        ? (index + 1) % count
        : e.key === "ArrowLeft"
          ? (index - 1 + count) % count
          : null;
    if (nextIndex === null) return;
    e.preventDefault();
    if (nextIndex === index) return;
    const next = rightTabs[nextIndex].value;
    selectRightTab(next);
    document.getElementById(rightTabDomId(next))?.focus();
  };

  return (
    <div className="h-full flex flex-col">
      {/* 左のパネル (上部バー + 端末 / 会話) と作業エリアのパネルを、すき間で離して
          並べる。区切りの線は引かない。すき間がそのままリサイザになる */}
      <div
        ref={containerRef}
        data-testid="split-view-body"
        className="flex-1 min-h-0 flex relative"
      >
        <div
          className={`panel h-full flex-1 min-w-0 flex flex-col overflow-hidden ${
            isDragging ? "pointer-events-none" : ""
          }`}
        >
          {/* 上部バー: 左 = 主ラベル・ブランチ・状態チップ、中央 = 端末 / 会話、
          右 = 1タップの操作・作業エリアの開閉と `…` メニュー */}
          {/* 狭い幅 (1024px前後) では右側を中身の幅に縮め、主ラベルに幅を回す。
          広い幅だけ左右を同じ幅にしてセグメントを中央に置く。

          さらに狭いとき (コンテナ42rem未満) は「装飾から削る」順で畳む。
          1タップの操作は最後まで消さない:
          1. 文言を読み上げだけに残してアイコンにする (ブランチ・状態チップ・
             セグメント・パネル)。`sr-only` は position:absolute なので、
             文字だけでなく flex の gap も消える
          2. それでも足りない分は左の箱が引き受ける。主ラベルが縮み、
             最後は `overflow-hidden` で箱の中に収める (上部バーは横に溢れない) */}
          {/* 上部バーは左のパネルの中にあるので、作業エリアを広げると幅が足りなくなる。
              そのときは右側の操作を2段目へ折り返す (切れて押せなくなるのを防ぐ)。
              左の箱は basis-0 なので、折り返すのはセグメントと操作が収まらないときだけ */}
          <header className="@container min-h-13 shrink-0 flex flex-wrap items-center justify-end gap-x-3 gap-y-1 py-2 pl-5 pr-3">
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
              <button
                type="button"
                onClick={handleToggleWorkArea}
                aria-label="パネル"
                aria-pressed={showWorkArea}
                title={showWorkArea ? "パネルを閉じる" : "パネルを開く"}
                className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold transition-colors ${
                  showWorkArea
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                <VIEW_MODE_ICONS.panel
                  className="size-4.5"
                  aria-hidden="true"
                />
                <span className="@max-2xl:sr-only">パネル</span>
              </button>
              <SessionHeaderMenu
                worktree={props.worktree}
                notificationsSupported={props.notificationsSupported ?? false}
                notificationsEnabled={props.notificationsEnabled ?? true}
                onNotificationsEnabledChange={
                  props.onNotificationsEnabledChange
                }
                onDeleteSession={props.onDeleteSession}
              />
            </div>
          </header>

          {/* 左ペイン: 端末 / 会話（上部バーで切替。両方マウントしたまま display 切替）
            リサイズ中は pointer-events-none にする。ターミナルは ttyd の iframe
            （別ブラウジングコンテキスト）で、分割線を左へドラッグしてカーソルが
            この上に乗ると mousemove / mouseup を iframe が飲み込み、window の
            リスナーへ届かなくなる。結果、幅が更新されず（ターミナルが狭くならない）、
            mouseup も発火せずドラッグが解除されない（カーソル追従が止まらない）。
            作業エリア（図も iframe）と同様に透過させて window リスナーへ届かせる。 */}
          <div className="min-h-0 flex-1 overflow-hidden">
            {/* 端末: ttyd の再接続を避けるため hidden で残置する */}
            <div className={leftMode === "terminal" ? "h-full" : "hidden"}>
              <TerminalPane
                ref={terminalRef}
                session={props.session}
                worktree={props.worktree}
                isVisible={shouldAcceptTerminalFileDrop(
                  props.isActive,
                  leftMode
                )}
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
        </div>

        {/* リサイザ・作業エリア。閉じている間も、外せない中身 (1 度見せた「ファイル」・
            「Git」とピーク) があればリサイザごと hidden で残す */}
        {(showWorkArea || fileEverShown || gitEverShown || peek !== null) && (
          <>
            <button
              type="button"
              aria-label="左右の幅を調整"
              onMouseDown={handleResizerMouseDown}
              className={cn(
                "group relative w-2 shrink-0 cursor-col-resize bg-transparent",
                !showWorkArea && "hidden"
              )}
            >
              <span
                className={cn(
                  "absolute inset-y-4 left-0.5 right-0.5 rounded-full transition-colors group-hover:bg-primary/40",
                  isDragging && "bg-primary/60"
                )}
              />
            </button>
            <div
              style={{ width: renderedWorkWidth, flexShrink: 0 }}
              className={cn(
                "panel flex h-full flex-col overflow-hidden",
                isDragging && "pointer-events-none",
                !showWorkArea && "hidden"
              )}
            >
              {/* タブ列: 図 / ファイル / Git と、作業エリアを閉じる × */}
              <div className="flex h-13 shrink-0 items-center gap-2 pr-3 pl-3 text-[13px]">
                <div
                  role="tablist"
                  aria-label="パネルの表示"
                  className="inline-flex min-w-0 items-center gap-0.5 rounded-full bg-muted p-0.5 dark:bg-background"
                >
                  {rightTabs.map((tab, index) => {
                    const selected = tab.value === rightTab;
                    return (
                      <button
                        key={tab.value}
                        type="button"
                        role="tab"
                        id={rightTabDomId(tab.value)}
                        aria-selected={selected}
                        aria-controls={rightPanelDomId(tab.value)}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => selectRightTab(tab.value)}
                        onKeyDown={e => handleRightTabKeyDown(e, index)}
                        // 選択中は丸いカプセルで持ち上げる (上部バーの「端末 / 会話」と同じ見た目)
                        className={cn(
                          "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3.5 font-semibold transition-colors",
                          selected
                            ? "bg-card text-foreground shadow-card"
                            : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        <tab.icon className="size-4" aria-hidden="true" />
                        <span>{tab.label}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="flex-1" />
                <button
                  type="button"
                  aria-label="パネルを閉じる"
                  title="パネルを閉じる"
                  onClick={handleCloseWorkArea}
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              </div>

              {/* 図。ピークがあれば左右に割って、図の横へコードを出す (3 本目のリサイザは無い) */}
              <div
                role="tabpanel"
                id={rightPanelDomId("board")}
                aria-labelledby={rightTabDomId("board")}
                className={cn(
                  "flex min-h-0 flex-1",
                  !boardTabActive && "hidden"
                )}
              >
                <div className="h-full min-w-0 flex-1 overflow-hidden">
                  {boardShown && (
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
                  )}
                </div>
                {peek !== null && (
                  <div
                    data-testid="split-view-peek"
                    className="mr-2 mb-2 ml-2 w-1/2 min-w-[320px] shrink-0 overflow-hidden rounded-xl bg-well"
                  >
                    {peek(peekVisible)}
                  </div>
                )}
              </div>

              {/* ファイル。初めて見せるまでマウントしない */}
              {props.filePane && (fileEverShown || filePaneVisible) && (
                <div
                  role="tabpanel"
                  id={rightPanelDomId("files")}
                  aria-labelledby={rightTabDomId("files")}
                  className={cn(
                    "min-h-0 flex-1 overflow-hidden",
                    rightTab !== "files" && "hidden"
                  )}
                >
                  {props.filePane(filePaneVisible)}
                </div>
              )}

              {/* Git。初めて見せるまでマウントしない */}
              {props.gitPane && (gitEverShown || gitPaneVisible) && (
                <div
                  role="tabpanel"
                  id={rightPanelDomId("git")}
                  aria-labelledby={rightTabDomId("git")}
                  className={cn(
                    "min-h-0 flex-1 overflow-hidden",
                    rightTab !== "git" && "hidden"
                  )}
                >
                  {props.gitPane(gitPaneVisible)}
                </div>
              )}
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
