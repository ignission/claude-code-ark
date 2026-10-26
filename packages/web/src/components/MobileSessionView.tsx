/**
 * MobileSessionView - モバイル用セッション詳細画面
 *
 * ヘッダー (戻る・主ラベル・ブランチ・状態チップ・操作メニュー) と、その直下の状態の帯、
 * 「会話 / 図」の本文と下部バー、それらに重ねる端末の窓で組む。
 * 2つのモードの本文はマウントしたまま `display` で切り替える (図のiframeを張り直さない)。
 *
 * 端末はモードではない。会話の入力欄の上の帯 (画面末尾) を押すと、この画面の全面に
 * 窓 (`FloatingTerminal` のfullscreen) で開き、閉じるまでそのまま操作できる。
 * - 窓の中身 (タブ・ttyd・ファイルとHTMLのビューア・添付の確認ダイアログ・Quick Keys・
 *   入力欄) は常にマウントしたままで、閉じている間は窓ごと隠れる。ttydのiframeは
 *   開閉でアンマウントも付け替えもしない (枠の決まりは `FloatingTerminal.tsx` にある)
 * - 窓はこの画面のルートの直下に置く。モードごとの本文 (`hidden` で切り替わる) の中に
 *   置くと、モードが替わったときに「開いているのに見えない」窓が残る
 * - 開閉の状態は保存しない。この詳細が表示中でなくなったら (一覧へ戻る・別のセッションを
 *   開く) 閉じ、戻ってきても閉じたままにする
 * - 閉じるのは、窓の閉じるボタンと、図を開く操作 (図を開く通知・窓の中のタブで図を選ぶ)。
 *   図を開く操作は、窓を閉じてから図モードを見せる
 * - 窓は、マウントしただけでは開かない。開くのは、この画面での操作の結果だけ:
 *   帯を押す、ファイル / HTMLを開く (ビューアは窓の中にある。合図は `viewerOpenSeq` の
 *   増加で、同じファイルの開き直しでも開く)、
 *   端末の流儀の添付が溜まる (確認ダイアログは窓の中にある)。
 *   ファイルのタブが選ばれたままのセッションをマウントしても、閉じた状態で始める
 * - 開いている間、窓に隠れる部分 (ヘッダー・状態の帯・本文と下部バー) は `inert` にする。
 *   外付けのキーボードのTabで、見えていない会話の入力欄へ移って送信できてしまうため
 * - 開いたらフォーカスを窓の枠へ、閉じたら開く前の要素へ移す。端末や入力欄へは移さない
 *   (ソフトキーボードを勝手に出さない)
 * - 窓は全面なので、開いている間はヘッダーと状態の帯とセグメントが隠れる。
 *   窓のバーにセグメントは置かない (モードを替えるには窓を閉じる)
 *
 * 下部バーはセグメントの下に1タップの操作 (MobileQuickActionRow) を置く。
 * 添付と画像の実体は場所で違い、会話モードは会話の入力欄 (SplitChatPaneHandle。
 * `@path` を入力欄に足す)、端末の窓と図モードは端末側の確認ダイアログへ渡す。
 * 端末そのものへの操作 (バッファのコピー・再読み込み) は、PCと同じく端末の窓の上端の
 * バーに置く (指で押せる44px)。窓の下部バーに残すのは、端末へ打ち込むための操作
 * (1タップの行・Quick Keys・入力欄) だけ。`…` にはセッション全体の操作 (通知・再起動・
 * 削除) だけを残す。
 *
 * 端末の画面末尾 (`liveTail`) は1秒ごとに届き、そのたびにこの部品は描画し直す。
 * 画面末尾を使うのは会話の帯だけなので、端末の窓の中身は要素ごとメモ化し、
 * 画面末尾では変わらない値だけに依存させる。親が毎回作り直して渡す関数は
 * useStableCallback で包んでから使う。
 *
 * 音声モード (iPhone) は会話モードの1タップ操作から入る。状態は useVoiceMode、画面は
 * VoiceModeOverlay。JSONL の購読は増やさず、会話ビューのイベント列を onEventsChange で受け取る。
 */

import {
  type BridgeSessionStatus,
  type ClientToServerEvents,
  type ManagedSession,
  type MessageShortcut,
  type PlanLimits,
  type ServerToClientEvents,
  type SpecialKey,
  TERMINAL_BG,
  type Worktree,
} from "@ark/shared";
import {
  Bell,
  BellOff,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Copy,
  Ellipsis,
  File as FileIcon,
  RefreshCw,
  RotateCw,
  Send,
  Trash2,
  X,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Socket } from "socket.io-client";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useOpenTerminalOnAuq } from "@/hooks/useOpenTerminalOnAuq";
import type { ActiveAuq } from "@/lib/ask-user-question-state";
import { readClipboardImages } from "@/lib/clipboard-images";
import { FLOATING_BAR_BOTTOM } from "@/lib/floating-composer";
import {
  deleteSessionDescription,
  notificationMenuLabel,
  resolveSessionHeaderLabels,
} from "@/lib/session-header";
import {
  resolveStatusKey,
  resolveStatusStrip,
  type StatusTone,
  TONE_CLASSES,
} from "@/lib/status-tone";
import { cn } from "@/lib/utils";
import { fileToBase64, validateFile } from "../hooks/useFileUpload";
import { useStableCallback } from "../hooks/useStableCallback";
import { useTerminalLinkInjection } from "../hooks/useTerminalLinkInjection";
import { useTtydReconnect } from "../hooks/useTtydReconnect";
import { useVisualViewport } from "../hooks/useVisualViewport";
import { useVoiceMode } from "../hooks/useVoiceMode";
import { mobileQuickActions } from "../lib/mobile-quick-actions";
import {
  type DiagramOpenRequest,
  getViewModeForDiagramOpenRequest,
  type MobileSessionViewMode,
  readSavedViewMode,
  shouldOpenTerminalForViewerOpen,
  writeSavedViewMode,
} from "../lib/mobile-session-view-mode";
import { DiagramPane, type DiagramPaneProps } from "./DiagramPane";
import { FileViewerPane } from "./FileViewerPane";
import { FloatingTerminal } from "./FloatingTerminal";
import { HtmlViewerPane } from "./HtmlViewerPane";
import { MessageShortcutManagerDialog } from "./MessageShortcutManagerDialog";
import { MobileQuickActionRow } from "./MobileQuickActionRow";
import { MobileSessionViewModeToggle } from "./MobileSessionViewModeToggle";
import { SplitChatPane, type SplitChatPaneHandle } from "./SplitChatPane";
import { StatusChip } from "./StatusChip";
import type { ViewerTab } from "./TerminalPane";
import { ViewerTabBar } from "./ViewerTabBar";
import { VoiceModeOverlay } from "./VoiceModeOverlay";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** 端末の窓の上端のバーに置く操作。指で押せる44pxの丸いボタン */
const WINDOW_ACTION_BUTTON =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

type MobileDiagramPaneProps = Omit<
  DiagramPaneProps,
  "sessionId" | "worktreePath" | "relPath"
>;

/** プレビューダイアログに蓄積する添付ファイル */
interface PendingFile {
  base64: string;
  mimeType: string;
  filename: string;
  /** 画像の場合のdataURL、非画像の場合はnull */
  preview: string | null;
  size: number;
}

export interface MobileSessionViewProps extends MobileDiagramPaneProps {
  /** 「TODO」モードの本文 (TodoPane)。無ければ空の本文 */
  todoPane?: ReactNode;
  /** 会話ビュー（SplitChatPane）の JSONL 購読・AUQ 受信に使う */
  socket: TypedSocket | null;
  /** この詳細が現在表示中か。会話ビューの購読を表示中に限定する */
  isActive: boolean;
  /** session:previews 由来のセッション状態（busy/AWAITING 表示用） */
  bridgeStatus?: BridgeSessionStatus;
  /** AWAITING 時の確認 UI 生テキスト（バナー表示用） */
  awaitingText?: string;
  /** 端末の画面末尾 (会話の入力欄の上の帯にそのまま出す) */
  liveTail?: string;
  /** プランの使用量 (入力欄の横に出す) */
  planLimits?: PlanLimits;
  session: ManagedSession;
  worktree: Worktree | undefined;
  /** 主ラベルに使うリポジトリ名 (basename)。所属が分からなければ undefined */
  repoName?: string;
  /** worktree のカスタム表示名。あれば主ラベルにする */
  displayName?: string | null;
  /** Notification API 対応環境でだけ「このセッションの通知をオン/オフにする」を出す */
  notificationsSupported?: boolean;
  /** このセッションの通知が有効か (未設定なら有効) */
  notificationsEnabled?: boolean;
  onNotificationsEnabledChange?: (enabled: boolean) => void;
  onBack: () => void;
  onSendMessage: (message: string) => void;
  onSendKey: (key: SpecialKey) => void;
  /** セッション削除（停止 + メイン以外のWorktree削除） */
  onDeleteSession: () => void;
  /**
   * セッション再起動（tmux kill → 新セッション作成。会話履歴は失われる）。
   * 未指定ならメニュー項目を表示しない
   */
  onRestartSession?: () => void;
  onUploadFile?: (data: {
    base64Data: string;
    mimeType: string;
    originalFilename?: string;
  }) => Promise<{
    path: string;
    filename: string;
    originalFilename?: string;
  }>;
  onCopyBuffer?: () => Promise<string | null>;
  tabs: ViewerTab[];
  activeTabIndex: number;
  /** ファイル / HTMLを開く操作の通し番号。増えたら端末の窓を開く */
  viewerOpenSeq: number;
  diagramOpenRequest: DiagramOpenRequest | null;
  onTabSelect: (index: number) => void;
  onTabClose: (index: number) => void;
  messageShortcuts: MessageShortcut[];
  onCreateShortcut: (message: string) => void;
  onUpdateShortcut: (id: string, patch: { message?: string }) => void;
  onDeleteShortcut: (id: string) => void;
}

export function MobileSessionView({
  socket,
  isActive,
  bridgeStatus,
  awaitingText,
  liveTail,
  planLimits,
  session,
  worktree,
  repoName,
  displayName,
  notificationsSupported = false,
  notificationsEnabled = true,
  onNotificationsEnabledChange,
  onBack,
  onSendMessage: onSendMessageProp,
  onSendKey: onSendKeyProp,
  onDeleteSession,
  onRestartSession,
  onUploadFile: onUploadFileProp,
  onCopyBuffer: onCopyBufferProp,
  tabs,
  activeTabIndex,
  viewerOpenSeq,
  diagramOpenRequest,
  onTabSelect: onTabSelectProp,
  onTabClose: onTabCloseProp,
  messageShortcuts,
  onCreateShortcut,
  onUpdateShortcut,
  onDeleteShortcut,
  isConnected,
  diagramCommentsUpdate,
  listDiagrams,
  deleteDiagram,
  getDiagramComments,
  createDiagramComment,
  replyDiagramComment,
  resolveDiagramComment,
  deleteDiagramComment,
  sendDiagramComment,
  onSelectDiagram,
  todoPane,
}: MobileSessionViewProps) {
  // 親は描画のたびに関数を作り直して渡してくる。端末の窓の中身 (メモ化した要素) が
  // そのたびに作り直されないよう、同一性の変わらない関数で包んでから使う
  const onSendMessage = useStableCallback(onSendMessageProp);
  const onSendKey = useStableCallback(onSendKeyProp);
  const onUploadFile = useStableCallback(onUploadFileProp);
  const onCopyBuffer = useStableCallback(onCopyBufferProp);
  const onTabSelect = useStableCallback(onTabSelectProp);
  const onTabClose = useStableCallback(onTabCloseProp);
  const { height: viewportHeight, isKeyboardVisible } = useVisualViewport();
  const [inputValue, setInputValue] = useState("");
  const [iframeKey, setIframeKey] = useState(0);
  // 表示モード (会話 / 図)。既定は会話。最後の選択を永続化。
  const [viewMode, setViewMode] =
    useState<MobileSessionViewMode>(readSavedViewMode);
  // 端末の窓の開閉。保存せず、この詳細が表示中でなくなったら閉じる
  // (戻ってきたときに、開いたままの窓が残っていないように描画中に戻す)
  const [terminalOpen, setTerminalOpen] = useState(false);
  if (!isActive && terminalOpen) setTerminalOpen(false);
  // 開く前にフォーカスのあった要素。開くと `inert` で外れるので、開く時点で覚える
  const rootRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // 覚えるのは閉じた状態から開くときだけ。開いている間の開く合図 (窓の中のリンクで
  // ファイルを開く、添付が溜まる) で、窓の中の要素に書き換えない
  const terminalOpenRef = useRef(terminalOpen);
  terminalOpenRef.current = terminalOpen;
  const openTerminal = useCallback(() => {
    if (terminalOpenRef.current) return;
    const focused = document.activeElement;
    returnFocusRef.current = focused instanceof HTMLElement ? focused : null;
    setTerminalOpen(true);
  }, []);
  const closeTerminal = useCallback(() => setTerminalOpen(false), []);
  // 表示中でなくなって閉じたときは、見えていない画面なのでフォーカスに触らない
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const focusTerminalWindow = useCallback(() => {
    if (!isActiveRef.current) return;
    rootRef.current
      ?.querySelector<HTMLElement>('[data-keynav="terminal-window"]')
      ?.focus({ preventScroll: true });
  }, []);
  const restoreFocusAfterClose = useCallback(() => {
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (isActiveRef.current && target?.isConnected) {
      target.focus({ preventScroll: true });
    }
  }, []);

  const handleViewModeChange = useCallback((next: MobileSessionViewMode) => {
    writeSavedViewMode(next);
    setViewMode(next);
  }, []);

  // diagram:open の明示通知がこのセッション向けに変化したときだけ board を開く。
  // 端末の窓が開いていれば、閉じてから見せる。
  const handledDiagramOpenSequenceRef = useRef<number | null>(null);
  useEffect(() => {
    const nextViewMode = getViewModeForDiagramOpenRequest(
      session.id,
      diagramOpenRequest,
      handledDiagramOpenSequenceRef.current
    );
    handledDiagramOpenSequenceRef.current =
      diagramOpenRequest?.sequence ?? null;
    if (nextViewMode) {
      setTerminalOpen(false);
      setViewMode(nextViewMode);
    }
  }, [diagramOpenRequest, session.id]);

  // ファイル / HTMLのビューアは端末と同じタブの並びにあり、窓の中に出る。
  // 開く操作があったら (通し番号が増えたら)、窓を開いて見せる。タブの種類の変化では
  // 見ない (ファイルを見て閉じたあと別のファイルを開くと、種類は変わらない)。
  // マウントした時点の番号では開かない (窓が開くのは、この画面での操作の結果だけ)
  const activeTabType = tabs[activeTabIndex]?.type;
  const seenViewerOpenSeqRef = useRef(viewerOpenSeq);
  useEffect(() => {
    if (
      !shouldOpenTerminalForViewerOpen(
        seenViewerOpenSeqRef.current,
        viewerOpenSeq
      )
    ) {
      seenViewerOpenSeqRef.current = viewerOpenSeq;
      return;
    }
    seenViewerOpenSeqRef.current = viewerOpenSeq;
    openTerminal();
  }, [viewerOpenSeq, openTerminal]);

  // 窓の中のタブバーでユーザー自身が図を選んだ場合も、窓を閉じて図モードを開く。
  const handleViewerTabSelect = useCallback(
    (index: number) => {
      onTabSelect(index);
      if (tabs[index]?.type === "diagram") {
        setTerminalOpen(false);
        setViewMode("board");
      }
    },
    [onTabSelect, tabs]
  );
  // 全ての添付ファイル（画像/非画像）を共通でプレビューダイアログに集約する
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [uploadMessage, setUploadMessage] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showRestartDialog, setShowRestartDialog] = useState(false);
  const [showShortcutManager, setShowShortcutManager] = useState(false);
  // 回答待ちの質問 (AskUserQuestion)。SplitChatPane から受け取り、端末の窓を開くのと、
  // 状態の帯の文言と音声モードに使う。
  // 会話モード以外では JSONL の購読が止まり、回答済みの判定が遅れて true が残ることがある。
  // 帯は AWAITING のときだけこの値を見る (resolveStatusStrip) ので、確認が済めば帯は消える。
  // この値だけで帯を出す形に書き換えないこと
  const [activeAuq, setActiveAuq] = useState<ActiveAuq | null>(null);
  const hasActiveAuq = activeAuq !== null;
  const openTerminalOnAuq = useOpenTerminalOnAuq(isActive, openTerminal);
  const handleActiveAuqChange = useCallback(
    (auq: ActiveAuq | null) => {
      setActiveAuq(auq);
      openTerminalOnAuq(auq);
    },
    [openTerminalOnAuq]
  );
  // 音声モード (iPhone)。会話ビューのイベント列と回答待ちの質問を受け取り、話して送り、返答を読む。
  // 診断はサーバーのログに1行残す (本文は送らない)
  const emitVoiceDiagnostic = useCallback(
    (kind: string, detail: string) => {
      socket?.emit("voice:diagnostic", { sessionId: session.id, kind, detail });
    },
    [socket, session.id]
  );
  const voice = useVoiceMode({
    isActive,
    isConnected,
    bridgeStatus,
    activeAuq,
    onSendMessage,
    onDiagnostic: emitVoiceDiagnostic,
  });
  const statusStrip = resolveStatusStrip({
    bridgeStatus,
    hasActiveAuq,
    isConnected,
    viewMode,
  });
  // 下部バーの上段に置く「会話 / 図」。2つのモードの本文はマウントしたまま
  // `display` で切り替えるので、同じ要素を各モードのバーに置く (表示されるのは1つだけ)。
  // 角丸は会話モードのガラスバー (28px角丸・内側の余白8px) と同心になるよう丸くする
  const viewModeSegment = (
    <MobileSessionViewModeToggle
      value={viewMode}
      onChange={handleViewModeChange}
      className="w-full rounded-full [&_button]:h-[34px] [&_button]:flex-1 [&_button]:justify-center [&_button]:rounded-full"
    />
  );

  // 端末の流儀の添付 (`pendingFiles`) の確認ダイアログは端末の窓の中にあるので、
  // 添付が溜まったら窓を開いてダイアログを見せる (図モードの添付もここを通る)。
  const pendingCount = pendingFiles.length;
  useEffect(() => {
    if (pendingCount > 0) openTerminal();
  }, [pendingCount, openTerminal]);

  const inputRef = useRef<HTMLInputElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // 会話モードの画像の貼り付けを会話の入力欄の流儀 (`@path` を入力欄に足す) で行うための取っ手
  const chatRef = useRef<SplitChatPaneHandle>(null);
  // ファイル選択input は下部バーの1タップの操作から click() だけを呼ばせる。
  // Radix の Portal (メニュー) の中に置くと、閉じた瞬間に Portal が unmount され、
  // OS のファイル選択画面から戻った時に input が DOM に存在せず onChange が発火しない。
  const fileInputRef = useRef<HTMLInputElement>(null);

  // トンネル経由のアクセス時はURLのトークンをiframeにも付与
  const urlToken =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("token")
      : null;
  const ttydBasePath = `/ttyd/${session.id}/`;
  // 常にプロキシ経由でアクセスし同一オリジンを維持する
  const ttydIframeSrc = urlToken
    ? `${ttydBasePath}?token=${urlToken}`
    : ttydBasePath;

  // メッセージ送信（空文字でもEnterとして送信 = ターミナルへの空行送信）
  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      onSendMessage(inputValue);
      setInputValue("");
    },
    [inputValue, onSendMessage]
  );

  // Enter送信（inputなのでShift+Enterチェック不要）
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSubmit(e);
      }
    },
    [handleSubmit]
  );

  // iframeリロード
  const handleReloadIframe = useCallback(() => {
    setIframeKey(prev => prev + 1);
  }, []);

  // 受け取ったFileをpendingFilesへ追加（画像/非画像共通）
  // 部分失敗の場合でもエラーを握りつぶさず、まとめて表示する
  const addPendingFiles = useCallback(async (files: File[]) => {
    const next: PendingFile[] = [];
    const errors: string[] = [];
    for (const file of files) {
      const v = validateFile(file);
      if (!v.ok) {
        console.warn(v.reason);
        errors.push(`${file.name}: ${v.reason ?? "未対応のファイルです"}`);
        continue;
      }
      try {
        const { base64, mimeType, filename } = await fileToBase64(file);
        const isImage = mimeType.startsWith("image/");
        const preview = isImage ? `data:${mimeType};base64,${base64}` : null;
        next.push({ base64, mimeType, filename, preview, size: file.size });
      } catch (err) {
        console.error("ファイル読み込みに失敗:", err);
        errors.push(`${file.name}: 読み込みに失敗しました`);
      }
    }
    if (next.length > 0) {
      setPendingFiles(prev => [...prev, ...next]);
    }
    if (errors.length > 0) {
      setUploadError(errors.join("\n"));
    } else {
      setUploadError(null);
    }
  }, []);

  // クリップボードから画像/ファイルを読み取り
  const handlePaste = useCallback(
    (e: React.ClipboardEvent | ClipboardEvent) => {
      if (!onUploadFile) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        addPendingFiles(files);
      }
    },
    [onUploadFile, addPendingFiles]
  );

  // ペーストイベントのリスナー
  useEffect(() => {
    const handleDocumentPaste = (e: ClipboardEvent) => {
      if (document.activeElement === inputRef.current) {
        handlePaste(e);
      }
    };
    document.addEventListener("paste", handleDocumentPaste);
    return () => document.removeEventListener("paste", handleDocumentPaste);
  }, [handlePaste]);

  // クリップボードからの画像ペーストボタン。空振りと失敗はトーストで知らせる
  // (端末側の TerminalPane / 会話側の SplitChatPane と同じ作法)
  const handlePasteButtonClick = useCallback(async () => {
    if (!onUploadFile) return;
    try {
      const files = await readClipboardImages();
      if (files.length > 0) {
        await addPendingFiles(files);
      } else {
        toast.info("クリップボードに画像がありません");
      }
    } catch (err) {
      console.error("Failed to read clipboard:", err);
      toast.error("クリップボードを読み取れませんでした");
    }
  }, [onUploadFile, addPendingFiles]);

  // ファイル選択ハンドラ
  const handleFilesSelected = useCallback(
    async (files: File[]) => {
      await addPendingFiles(files);
    },
    [addPendingFiles]
  );

  // 「送信」押下: 全ファイルを順次アップロードし、@path1 @path2 ... {msg} 形式で送信
  const handleSendWithFiles = useCallback(async () => {
    if (pendingFiles.length === 0 || !onUploadFile) return;
    setIsSending(true);
    setUploadError(null);
    try {
      const paths: string[] = [];
      for (const pf of pendingFiles) {
        const result = await onUploadFile({
          base64Data: pf.base64,
          mimeType: pf.mimeType,
          originalFilename: pf.filename,
        });
        paths.push(result.path);
      }
      const refs = paths.map(p => `@${p}`).join(" ");
      const trimmed = uploadMessage.trim();
      const message = trimmed ? `${refs} ${trimmed}` : refs;
      onSendMessage(message);
      setPendingFiles([]);
      setUploadMessage("");
    } catch (err) {
      console.error("ファイルアップロード失敗:", err);
      setUploadError(
        err instanceof Error ? err.message : "アップロードに失敗しました"
      );
    } finally {
      setIsSending(false);
    }
  }, [pendingFiles, uploadMessage, onUploadFile, onSendMessage]);

  // 「キャンセル」押下
  const handleCancelPending = useCallback(() => {
    setPendingFiles([]);
    setUploadMessage("");
    setUploadError(null);
  }, []);

  // tmuxバッファコピー
  const handleCopyBuffer = async () => {
    if (!onCopyBuffer) return;
    try {
      const text = await onCopyBuffer();
      if (text) {
        await navigator.clipboard.writeText(text);
      }
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  // ttyd iframe内のxterm.jsにリンク検出をインジェクト（共通フック）
  useTerminalLinkInjection(iframeRef, iframeKey);

  // バックグラウンド復帰で ttyd の WebSocket が落ちると端末は
  // "Press ⏎ to Reconnect" のまま固まる。窓を開いて見えているターミナルに限って検出し、
  // iframe を貼り直して復帰させる（共通フック）。
  useTtydReconnect(iframeRef, iframeKey, {
    isVisible: isActive && terminalOpen && activeTabType === "terminal",
    onReload: handleReloadIframe,
  });

  // 1タップの操作。表示モードのバー (会話・図で同じ要素を置く。見えるのは1枚) と、
  // 端末の窓のバーに、それぞれ行を置く。どのボタンを出すかは lib/mobile-quick-actions.ts
  // に寄せる (会話モードは会話の入力欄が自前の添付ボタンを持つので、行には出さない)。
  // 添付と画像は、会話モードの行だけ会話の入力欄の流儀にする。図モードと端末の窓は
  // 端末側の確認ダイアログ (窓の中) へ渡す
  const openShortcutManager = useCallback(
    () => setShowShortcutManager(true),
    []
  );
  const attachForTerminal = useCallback(
    () => fileInputRef.current?.click(),
    []
  );
  const modeQuickActionRow = (
    <MobileQuickActionRow
      actions={mobileQuickActions({
        surface: viewMode,
        canUploadFile: onUploadFile !== undefined,
        canUseVoice: voice.supported,
      })}
      messageShortcuts={messageShortcuts}
      onSendMessage={onSendMessage}
      onManageShortcuts={openShortcutManager}
      onStartVoice={voice.enter}
      onAttachFile={onUploadFile ? attachForTerminal : undefined}
      onPasteImage={
        onUploadFile
          ? () => {
              if (viewMode === "chat") chatRef.current?.pasteImage();
              else handlePasteButtonClick();
            }
          : undefined
      }
    />
  );
  // 端末そのものへの操作。窓の上端のバーに、閉じるボタンの手前に並べる。
  // 窓を開いている間だけ出す (閉じている間は、同じ名前のボタンを画面に残さない)
  const terminalWindowActions = terminalOpen && (
    <>
      {onCopyBuffer && (
        <button
          type="button"
          aria-label="端末のバッファをコピー"
          title="端末のバッファをコピー"
          onClick={handleCopyBuffer}
          className={WINDOW_ACTION_BUTTON}
        >
          <Copy className="size-5" aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        aria-label="端末を再読み込み"
        title="端末を再読み込み"
        onClick={handleReloadIframe}
        className={WINDOW_ACTION_BUTTON}
      >
        <RefreshCw className="size-5" aria-hidden="true" />
      </button>
    </>
  );

  // 端末の窓の中身。画面末尾が届くたびの描画で作り直さないよう、要素ごとメモ化する
  // (依存に入れるのは、画面末尾では変わらない値だけ)
  const terminalBody = useMemo(
    () => (
      <div
        data-testid="mobile-view-terminal"
        className="flex h-full min-h-0 flex-col"
      >
        {/* タブバー（共通コンポーネント） */}
        <ViewerTabBar
          tabs={tabs}
          activeTabIndex={activeTabIndex}
          onTabSelect={handleViewerTabSelect}
          onTabClose={onTabClose}
        />

        {/* ttyd iframe */}
        <div
          className="flex-1 min-h-0 overflow-hidden relative"
          style={{
            display:
              tabs[activeTabIndex]?.type === "terminal" ? undefined : "none",
            backgroundColor: TERMINAL_BG,
          }}
        >
          {session.ttydUrl || session.ttydPort ? (
            <iframe
              key={iframeKey}
              ref={iframeRef}
              src={ttydIframeSrc}
              className="w-full h-full border-0"
              title={`Terminal - ${worktree?.branch || session.id}`}
              allow="clipboard-read; clipboard-write; keyboard-map"
            />
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <div className="text-center">
                <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full mx-auto mb-4" />
                <p>ターミナルを起動中...</p>
              </div>
            </div>
          )}
        </div>

        {/* ファイルビューワー / ブラウザ */}
        {tabs[activeTabIndex]?.type === "file" &&
          (() => {
            const tab = tabs[activeTabIndex] as ViewerTab & { type: "file" };
            return (
              <div className="flex-1 min-h-0">
                <FileViewerPane
                  filePath={tab.filePath}
                  content={tab.content}
                  mimeType={tab.mimeType}
                  size={tab.size}
                  targetLine={tab.targetLine}
                  targetEndLine={tab.targetEndLine}
                  error={tab.error}
                />
              </div>
            );
          })()}
        {tabs[activeTabIndex]?.type === "html" &&
          (() => {
            const tab = tabs[activeTabIndex] as ViewerTab & { type: "html" };
            return (
              <div className="flex-1 min-h-0">
                <HtmlViewerPane filePath={tab.filePath} />
              </div>
            );
          })()}
        {/* 添付ファイル プレビューダイアログ（画像/非画像共通） */}
        {pendingFiles.length > 0 && (
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-card border border-border rounded-lg p-4 max-w-md w-full">
              <h3 className="text-sm font-semibold mb-3">
                ファイルを送信（{pendingFiles.length}件）
              </h3>
              <div className="space-y-2 max-h-60 overflow-y-auto mb-3">
                {pendingFiles.map((pf, idx) => (
                  <div
                    key={`${pf.filename}-${idx}`}
                    className="flex items-center gap-2 text-sm border border-border rounded p-2"
                  >
                    {pf.preview ? (
                      <img
                        src={pf.preview}
                        alt={pf.filename}
                        className="w-12 h-12 object-cover rounded shrink-0"
                      />
                    ) : (
                      <div className="w-12 h-12 flex items-center justify-center bg-muted rounded shrink-0">
                        <FileIcon className="w-6 h-6 text-muted-foreground" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="truncate" title={pf.filename}>
                        {pf.filename}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {(pf.size / 1024).toFixed(1)} KB
                      </div>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 shrink-0"
                      onClick={() =>
                        setPendingFiles(prev =>
                          prev.filter((_, i) => i !== idx)
                        )
                      }
                      disabled={isSending}
                      title="このファイルを取り除く"
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
              </div>
              <Textarea
                value={uploadMessage}
                onChange={e => setUploadMessage(e.target.value)}
                placeholder="メッセージを追加（任意）"
                className="min-h-[60px] resize-none text-sm mb-3"
                rows={2}
                disabled={isSending}
              />
              {uploadError && (
                <p className="text-destructive text-xs mb-3">{uploadError}</p>
              )}
              <div className="flex gap-2 justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleCancelPending}
                  disabled={isSending}
                >
                  キャンセル
                </Button>
                <Button
                  size="sm"
                  onClick={handleSendWithFiles}
                  disabled={isSending}
                >
                  {isSending ? "送信中..." : "送信"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* 添付ファイル エラートースト（モーダル未表示時の全件失敗や検証失敗を表示） */}
        {uploadError && pendingFiles.length === 0 && (
          <div className="px-3 py-2 bg-destructive/10 text-destructive text-sm border-t border-destructive/20 whitespace-pre-line flex items-start justify-between gap-2">
            <span className="flex-1">{uploadError}</span>
            <button
              type="button"
              className="text-xs underline shrink-0"
              onClick={() => setUploadError(null)}
            >
              閉じる
            </button>
          </div>
        )}

        {/* 端末の窓の下部バー。ガラスをやめて不透明にし、端末に重ねない
                (ttyd は iframe の大きさに合わせて描くので、端末の領域はバーの上端までにする)。
                上段に1タップの操作、下段にQuick Keysと入力欄。どれも端末へ打ち込むための
                操作で、セグメントは置かない */}
        <div
          data-testid="mobile-terminal-bar"
          data-mobile-bottom-bar=""
          className="shrink-0 border-t border-border bg-card px-3 pt-2"
          style={{ paddingBottom: FLOATING_BAR_BOTTOM }}
        >
          {/* 端末へ打ち込むための1タップの操作。窓を開いている間だけ出す */}
          {terminalOpen && (
            <MobileQuickActionRow
              actions={mobileQuickActions({
                surface: "terminal",
                canUploadFile: onUploadFile !== undefined,
              })}
              messageShortcuts={messageShortcuts}
              onSendMessage={onSendMessage}
              onManageShortcuts={openShortcutManager}
              onAttachFile={onUploadFile ? attachForTerminal : undefined}
              onPasteImage={onUploadFile ? handlePasteButtonClick : undefined}
            />
          )}

          {/* Quick Keys: ↑/↓/Esc/Ctrl+C/S-Tab 常時表示 */}
          <div className="mt-1 flex items-center gap-1 overflow-x-auto select-none">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-3 text-xs shrink-0"
              onClick={() => onSendKey("Up")}
            >
              ↑
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-3 text-xs shrink-0"
              onClick={() => onSendKey("Down")}
            >
              ↓
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-3 text-xs shrink-0"
              onClick={() => onSendKey("Escape")}
            >
              Esc
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-3 text-xs text-destructive hover:text-destructive shrink-0"
              onClick={() => onSendKey("C-c")}
            >
              Ctrl+C
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-3 text-xs shrink-0"
              onClick={() => onSendKey("S-Tab")}
            >
              S-Tab
            </Button>
          </div>

          {/* 入力欄: 空のまま送るとEnterを送る (handleSubmit) */}
          <form
            onSubmit={handleSubmit}
            className="mt-1 flex items-center gap-2"
          >
            <Input
              ref={inputRef}
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              enterKeyHint="send"
              placeholder="メッセージを入力... (Enter送信)"
              className="h-11 flex-1 rounded-full bg-background px-4 text-sm"
            />
            <Button
              type="submit"
              size="icon"
              aria-label="送信"
              className="size-11 shrink-0 rounded-full"
            >
              <Send className="size-5" />
            </Button>
          </form>
        </div>
      </div>
    ),
    [
      tabs,
      activeTabIndex,
      handleViewerTabSelect,
      onTabClose,
      session.id,
      session.ttydUrl,
      session.ttydPort,
      iframeKey,
      ttydIframeSrc,
      worktree?.branch,
      pendingFiles,
      isSending,
      uploadMessage,
      uploadError,
      handleCancelPending,
      handleSendWithFiles,
      terminalOpen,
      onUploadFile,
      messageShortcuts,
      onSendMessage,
      openShortcutManager,
      attachForTerminal,
      handlePasteButtonClick,
      onSendKey,
      handleSubmit,
      handleKeyDown,
      inputValue,
    ]
  );

  // `…` に残すのはセッション全体の操作だけ。通知を出せない環境 (Notification API の
  // 無いブラウザ) もあるので、区切り線は直前のまとまりが実際に出たときだけ引く
  const canChangeNotifications =
    notificationsSupported && onNotificationsEnabledChange !== undefined;

  // 表示モードのバーの上段。会話と図のバーで同じ間隔 (4px) になるよう、
  // セグメントと1タップの操作をここでひとまとまりにする
  const bottomBarTop = (
    <div className="flex flex-col gap-1">
      {viewModeSegment}
      {modeQuickActionRow}
    </div>
  );

  // ヘッダーの主ラベル (表示名 → リポジトリ名 → worktree のフォルダ名) とブランチ。PC の上部バーと同じ決め方
  const headerLabels = resolveSessionHeaderLabels({
    displayName,
    repoName,
    branch: worktree?.branch,
    worktreePath: session.worktreePath,
  });

  return (
    <div
      ref={rootRef}
      // `relative` は端末の窓 (`absolute inset-0`) の基準に使う
      className="relative flex-1 flex flex-col min-h-0 safe-area-x"
      style={
        isKeyboardVisible
          ? { height: `${viewportHeight}px`, maxHeight: `${viewportHeight}px` }
          : undefined
      }
    >
      {/* 窓に隠れる部分。窓が開いている間は操作もフォーカスも受けない。
          `contents` で箱を作らず、ルートのflexの並びをそのまま保つ */}
      <div inert={terminalOpen} className="contents">
        {/* ヘッダー: 戻る・主ラベル・ブランチ・状態チップ・操作メニュー。
          safe area の余白は外側の header に付け、行の高さ (56px) と分ける */}
        <header className="shrink-0 bg-background safe-area-top">
          <div className="flex h-14 items-center gap-1 pl-1.5 pr-2">
            <Button
              variant="ghost"
              size="icon"
              className="size-10 shrink-0 rounded-sm"
              onClick={onBack}
              aria-label="一覧へ戻る"
            >
              <ChevronLeft className="size-[22px]" />
            </Button>
            <div className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="min-w-0 truncate text-[17px] font-semibold tracking-[-0.01em]">
                {headerLabels.primary}
              </span>
              <span className="min-w-0 max-w-[40%] shrink-0 truncate text-[13px] text-muted-foreground">
                {headerLabels.branch}
              </span>
            </div>
            <StatusChip statusKey={resolveStatusKey(true, bridgeStatus)} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-10 shrink-0 rounded-sm"
                  aria-label="その他の操作"
                >
                  <Ellipsis className="size-[22px]" />
                </Button>
              </DropdownMenuTrigger>
              {/* 添付・画像・ショートカット・スラッシュコマンドは下部バーの1タップの操作に、
                端末に関する操作 (バッファのコピー・再読み込み) は端末の窓のバーにある。
                ここに置くのはセッション全体の操作だけ。
                区切り線は、直前のまとまりが実際に出たときだけ引く */}
              <DropdownMenuContent align="end" className="w-64">
                {canChangeNotifications && (
                  <>
                    <DropdownMenuItem
                      onSelect={() =>
                        onNotificationsEnabledChange(!notificationsEnabled)
                      }
                    >
                      {notificationsEnabled ? <BellOff /> : <Bell />}
                      {notificationMenuLabel(notificationsEnabled)}
                    </DropdownMenuItem>
                    {onRestartSession && <DropdownMenuSeparator />}
                  </>
                )}
                {onRestartSession && (
                  <DropdownMenuItem onSelect={() => setShowRestartDialog(true)}>
                    <RotateCw />
                    セッションを再起動
                  </DropdownMenuItem>
                )}
                {(canChangeNotifications || onRestartSession) && (
                  <DropdownMenuSeparator />
                )}
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => setShowDeleteDialog(true)}
                >
                  <Trash2 />
                  セッションを削除
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {/* 状態の帯 (32px)。文言は状態と回答待ちの質問の有無だけから作り、端末の画面は解釈しない。
          会話モードでは AwaitingPad が入力欄の上に出て、質問なら端末の窓が開くので、ボタンを付けない */}
        {statusStrip && (
          <div className="shrink-0 px-3 pb-2">
            <div
              data-testid="mobile-status-strip"
              className={cn(
                "flex h-8 items-center gap-2 rounded-sm px-3 text-[13px] font-semibold text-foreground",
                TONE_CLASSES[statusStrip.tone].softBg
              )}
            >
              <StatusStripIcon tone={statusStrip.tone} />
              <span role="status" className="min-w-0 flex-1 truncate">
                {statusStrip.text}
              </span>
              {statusStrip.offerChat && (
                <button
                  type="button"
                  onClick={() => handleViewModeChange("chat")}
                  className="flex h-8 shrink-0 items-center gap-0.5 text-[13px] font-semibold text-foreground"
                >
                  会話で答える
                  <ChevronRight
                    className={cn(
                      "size-3.5",
                      TONE_CLASSES[statusStrip.tone].text
                    )}
                    aria-hidden="true"
                  />
                </button>
              )}
            </div>
          </div>
        )}

        {/* 会話モード (既定): JSONL チャットビュー。入力欄はセグメントと一体の浮かぶガラスバーで、
          本文はバーの下を通る (位置と本文の余白は SplitChatPane の layout="mobile" が持つ)。
          ttyd を持たないため display:none で残置しても再接続コストはない。 */}
        <div
          data-testid="mobile-view-chat"
          className={
            viewMode === "chat" ? "flex-1 flex flex-col min-h-0" : "hidden"
          }
        >
          <SplitChatPane
            ref={chatRef}
            socket={socket}
            session={session}
            // 図モードの間も、端末の窓を開いている間も購読を続ける。止めると、そのあいだに答えた質問の解決が
            // JSONL から届かず、状態の帯が「質問があります」のまま残る
            isActive={isActive}
            bridgeStatus={bridgeStatus}
            awaitingText={awaitingText}
            liveTail={liveTail}
            planLimits={planLimits}
            onSendMessage={onSendMessage}
            onSendKey={onSendKey}
            onUploadFile={onUploadFile}
            onOpenTerminal={openTerminal}
            onActiveAuqChange={handleActiveAuqChange}
            onEventsChange={voice.pushEvents}
            layout="mobile"
            composerAccessory={bottomBarTop}
          />
        </div>

        {/* 図モード: DiagramPane は他モードでもマウントしたまま hidden で切り替える。
          MessageChannel port と iframe の接続をモード切替で張り直さない。 */}
        <div
          data-testid="mobile-view-board"
          className={
            viewMode === "board" ? "flex-1 flex flex-col min-h-0" : "hidden"
          }
        >
          <div className="flex min-h-0 flex-1 flex-col">
            <DiagramPane
              socket={socket}
              isConnected={isConnected}
              diagramCommentsUpdate={diagramCommentsUpdate}
              listDiagrams={listDiagrams}
              deleteDiagram={deleteDiagram}
              getDiagramComments={getDiagramComments}
              createDiagramComment={createDiagramComment}
              replyDiagramComment={replyDiagramComment}
              resolveDiagramComment={resolveDiagramComment}
              deleteDiagramComment={deleteDiagramComment}
              sendDiagramComment={sendDiagramComment}
              sessionId={session.id}
              worktreePath={session.worktreePath}
              openKey={tabs.find(tab => tab.type === "diagram")?.id}
              relPath={tabs.find(tab => tab.type === "diagram")?.relPath}
              onSelectDiagram={onSelectDiagram}
            />
          </div>
          {/* 図モードの下部バーはセグメントと1タップの操作だけ。図の iframe は中に下端固定の UI
            (diagram-harness.ts の .ark-harness-toolbar、コメント層の解決済みトグル) を持つので、
            ガラスを重ねずに図の領域をバーの上端までにする。
            端末の窓のバーと同じく罫線と紙の色で、図の下端 UI と分ける */}
          <div
            data-testid="mobile-board-bar"
            data-mobile-bottom-bar=""
            className="shrink-0 border-t border-border bg-card px-3 pt-2"
            style={{ paddingBottom: FLOATING_BAR_BOTTOM }}
          >
            {bottomBarTop}
          </div>
        </div>
      </div>

      {/* TODOモード: 本文は一覧だけ。下部バーは表示モードのセグメントだけ置く */}
      <div
        data-testid="mobile-view-todo"
        className={
          viewMode === "todo" ? "flex-1 flex flex-col min-h-0" : "hidden"
        }
      >
        <div className="flex min-h-0 flex-1 flex-col">
          {viewMode === "todo" && todoPane}
        </div>
        <div
          data-testid="mobile-todo-bar"
          data-mobile-bottom-bar=""
          className="shrink-0 border-t border-border bg-card px-3 pt-2"
          style={{ paddingBottom: FLOATING_BAR_BOTTOM }}
        >
          {viewModeSegment}
        </div>
      </div>

      {/* 端末の窓: タブ + ttyd + ファイル / HTMLのビューア + 添付の確認ダイアログ +
          Quick Keys + 入力バー。この画面のルートを基準に全面へ重ねる。中身は常にここへ
          マウントしたままで、閉じている間は窓ごと隠れる (ttydの接続を保つ)。
          端末そのものへの操作は上端のバー (actions) に置く */}
      <FloatingTerminal
        open={terminalOpen}
        onClose={closeTerminal}
        onOpened={focusTerminalWindow}
        onClosed={restoreFocusAfterClose}
        variant="fullscreen"
        actions={terminalWindowActions}
      >
        {terminalBody}
      </FloatingTerminal>

      {/* 添付ファイル選択用の隠しinput
          DropdownMenuContent の外に置くことで、メニューが閉じても DOM に残り続け、
          OS のファイル選択画面から戻った時に onChange が確実に発火する。 */}
      {onUploadFile && (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={async e => {
            const files = Array.from(e.target.files ?? []);
            await handleFilesSelected(files);
            e.target.value = "";
          }}
        />
      )}

      {/* 削除確認ダイアログ */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent className="bg-card border-border w-[calc(100%-2rem)] max-w-md mx-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>セッションを削除</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteSessionDescription(worktree)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="h-12 md:h-10">
              キャンセル
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 h-12 md:h-10"
              onClick={() => {
                onDeleteSession();
                setShowDeleteDialog(false);
              }}
            >
              削除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 再起動確認ダイアログ */}
      <AlertDialog open={showRestartDialog} onOpenChange={setShowRestartDialog}>
        <AlertDialogContent className="bg-card border-border w-[calc(100%-2rem)] max-w-md mx-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>セッションを再起動しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              このセッションを再起動するとClaude会話履歴・実行中コマンド・ターミナル内容がすべて失われます。続行しますか？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="h-12 md:h-10">
              キャンセル
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-12 md:h-10"
              onClick={() => {
                onRestartSession?.();
                setShowRestartDialog(false);
              }}
            >
              再起動
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <MessageShortcutManagerDialog
        open={showShortcutManager}
        onOpenChange={setShowShortcutManager}
        shortcuts={messageShortcuts}
        onCreate={onCreateShortcut}
        onUpdate={onUpdateShortcut}
        onDelete={onDeleteShortcut}
      />

      <VoiceModeOverlay
        state={voice.state}
        bridgeStatus={bridgeStatus}
        onExit={voice.exit}
        onTapMic={voice.tapMic}
        onCancel={voice.cancel}
        onSendNow={voice.sendNow}
        onStopSpeaking={voice.stopSpeaking}
        onExpand={voice.expand}
        onResume={voice.resume}
        onRetryUnsent={voice.retryUnsent}
        onDismissUnsent={voice.dismissUnsent}
        rate={voice.rate}
        onCycleRate={voice.cycleRate}
        subscribeLevel={voice.subscribeLevel}
      />
    </div>
  );
}

/** 状態の帯の先頭のアイコン。帯の文言と同じく、トーンだけから決める */
function StatusStripIcon({ tone }: { tone: StatusTone }) {
  if (tone === "busy") {
    return (
      <span
        className={cn("status-dots", TONE_CLASSES.busy.text)}
        aria-hidden="true"
      >
        <span />
        <span />
        <span />
      </span>
    );
  }
  const className = cn("size-4 shrink-0", TONE_CLASSES[tone].text);
  if (tone === "awaiting") {
    return <CircleHelp className={className} aria-hidden="true" />;
  }
  return <CircleAlert className={className} aria-hidden="true" />;
}
