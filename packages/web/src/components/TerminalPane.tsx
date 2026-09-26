/**
 * TerminalPane Component - PC左ペインの端末表示
 *
 * 操作は上部バー (SplitViewPane) が持ち、端末専用の操作は
 * TerminalPaneHandleとして公開する。
 * - ttyd iframeを暗い額縁 (TERMINAL_BG) で囲む
 * - 入力バー (Quick Keysと入力欄) は上部バーの1タップのボタンから出し入れする
 * - ファイルのD&D・貼り付け・添付は、このペインの中の確認画面を経て送る
 */

import {
  type ManagedSession,
  type SpecialKey,
  TERMINAL_BG,
  TERMINAL_FG,
  type Worktree,
} from "@ark/shared";
import {
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  File as FileIcon,
  Send,
  StopCircle,
  X,
  XCircle,
} from "lucide-react";
import {
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { readClipboardImages } from "@/lib/clipboard-images";
import { fileToBase64, validateFile } from "../hooks/useFileUpload";
import { useIsMobile } from "../hooks/useMobile";
import { useTerminalLinkInjection } from "../hooks/useTerminalLinkInjection";
import { useTtydReconnect } from "../hooks/useTtydReconnect";
import { FileViewerPane } from "./FileViewerPane";
import { HtmlViewerPane } from "./HtmlViewerPane";
import { ViewerTabBar } from "./ViewerTabBar";

/** プレビューダイアログに蓄積する添付ファイル */
interface PendingFile {
  base64: string;
  mimeType: string;
  filename: string;
  /** 画像の場合のdataURL、非画像の場合はnull */
  preview: string | null;
  size: number;
}

export type ViewerTab =
  | { type: "terminal"; id: string }
  | {
      type: "file";
      id: string;
      filePath: string;
      content: string;
      mimeType: string;
      size: number;
      targetLine?: number | null;
      targetEndLine?: number | null;
      error?: string;
    }
  | {
      type: "html";
      id: string;
      filePath: string;
    }
  | {
      type: "diagram";
      id: string;
      worktreePath: string;
      relPath: string;
      /**
       * リロード直後の DB 復元（lastDiagramPath）で開かれたタブなら true。
       * SplitViewPane の「現在図 id が変わったら右ペインを自動表示する」トリガーから
       * 除外するために使う（復元のたびに右ペインが強制で開くのを防ぐ）。
       * board_open による通常のライブオープンでは付与しない。
       */
      restoredOnLoad?: boolean;
    };

/** PC上部バーの `…` メニューから呼ぶ、端末専用の操作 */
export interface TerminalPaneHandle {
  /** tmuxバッファをクリップボードへ */
  copyBuffer: () => void;
  /** クリップボードの画像を添付プレビューへ */
  pasteImage: () => void;
  /** TerminalPane内に残した <input type="file"> をclick() */
  openFilePicker: () => void;
  /** ttyd iframeを作り直す */
  reload: () => void;
  /** 入力バーの表示切替 */
  toggleInputBar: () => void;
}

interface TerminalPaneProps {
  ref?: Ref<TerminalPaneHandle>;
  session: ManagedSession;
  worktree: Worktree | undefined;
  /**
   * このペインが実際に画面へ出ているか（既定 true）。
   *
   * ファイル D&D は ttyd iframe がドラッグイベントを親に届けないため
   * window レベルで受けている。TerminalPane は全セッションぶんが常時
   * マウントされ、さらに左ペインが会話モードのときも `display:none` で
   * 残置されるので、無条件に window で受けると「見えていないペイン」にも
   * ドロップが入り、あとで開いたときに身に覚えのない送信プレビューが出る。
   * 表示中の 1 枚だけが受け取るようにこれで絞る。
   */
  isVisible?: boolean;
  onSendMessage: (message: string) => void;
  onSendKey: (key: SpecialKey) => void;
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
  onTabSelect: (index: number) => void;
  onTabClose: (index: number) => void;
  /** 入力バーの表示が変わったとき。`…` メニューのチェック表示に使う */
  onInputBarVisibleChange?: (visible: boolean) => void;
}

export function TerminalPane({
  ref,
  session,
  worktree,
  isVisible = true,
  onSendMessage,
  onSendKey,
  onUploadFile,
  onCopyBuffer,
  tabs,
  activeTabIndex,
  onTabSelect,
  onTabClose,
  onInputBarVisibleChange,
}: TerminalPaneProps) {
  const isMobile = useIsMobile();
  const [inputValue, setInputValue] = useState("");
  const [showInput, setShowInput] = useState(true);
  const [showQuickCommands, setShowQuickCommands] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // PCでは入力バーをデフォルト非表示にする
  useEffect(() => {
    if (!isMobile) {
      setShowInput(false);
    }
  }, [isMobile]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // ファイル選択のinput。上部バーのメニュー (Radix Portal) の中に置くと、
  // メニューが閉じた瞬間に消えて、OSのファイル選択画面から戻ってもonChangeが
  // 届かない。このペインに残し、openFilePicker()でclick()だけを呼ばせる
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [iframeKey, setIframeKey] = useState(0);

  // ttyd iframe内のxterm.jsにリンク検出をインジェクト（共通フック）
  useTerminalLinkInjection(iframeRef, iframeKey);

  // 全ての添付ファイル（画像/非画像）を共通でプレビューダイアログに集約する
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [uploadMessage, setUploadMessage] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // tmuxバッファの内容をクリップボードにコピーする。`…` メニューは選んだ
  // 時点で閉じるので、結果はトーストで知らせる
  const handleCopyBuffer = async () => {
    if (!onCopyBuffer) return;
    try {
      const text = await onCopyBuffer();
      if (text) {
        await navigator.clipboard.writeText(text);
        toast.success("端末のバッファをコピーしました");
      } else {
        toast.info("コピーできる内容がありません");
      }
    } catch (err) {
      console.error("Failed to copy:", err);
      toast.error("バッファをコピーできませんでした");
    }
  };

  // Focus textarea when input bar is shown
  useEffect(() => {
    if (showInput && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [showInput]);

  // Handle form submission
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputValue.trim()) {
      onSendMessage(inputValue);
      setInputValue("");
    }
  };

  // Handle Enter key in textarea (with shift for newline)
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  // Reload iframe
  const handleReloadIframe = () => {
    setIframeKey(prev => prev + 1);
  };

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

  // Handle paste event for image / file
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

  // Listen for paste events when textarea is focused
  useEffect(() => {
    const handleDocumentPaste = (e: ClipboardEvent) => {
      if (document.activeElement === textareaRef.current) {
        handlePaste(e);
      }
    };
    document.addEventListener("paste", handleDocumentPaste);
    return () => document.removeEventListener("paste", handleDocumentPaste);
  }, [handlePaste]);

  // クリップボードから画像を読み取るボタン用。押した時点で上部バーの
  // メニューは閉じているので、結果はcopyBufferと同様にトーストで知らせる
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

  // ファイル選択/D&D用のハンドラ
  const handleFilesSelected = useCallback(
    async (files: File[]) => {
      if (!onUploadFile) return;
      await addPendingFiles(files);
    },
    [onUploadFile, addPendingFiles]
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

  // ウィンドウ全体でファイルD&Dを受け付ける
  // ttyd iframe はクロスフレーム分離でドラッグイベントを親に届けないため、
  // window レベルのリスナーで検知して全画面オーバーレイを表示する
  // onUploadFile が未定義（アップロード非対応）の場合はリスナーを登録しない
  // 非表示のペイン（他セッション / 左ペインが会話モード）でも登録しない。
  // window リスナーは表示状態と無関係に発火するため（isVisible の項参照）
  useEffect(() => {
    if (!onUploadFile || !isVisible) return;
    let dragCounter = 0;

    const handleDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      dragCounter++;
      setIsDragging(true);
    };
    const handleDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
    };
    const handleDragLeave = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        setIsDragging(false);
      }
    };
    const handleDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      dragCounter = 0;
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) handleFilesSelected(files);
    };

    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDrop);
    return () => {
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleDrop);
    };
  }, [onUploadFile, isVisible, handleFilesSelected]);

  // ファイル選択/D&D後のtextarea自動挿入は廃止（プレビューダイアログ経由に統一）

  // Construct ttyd iframe URL
  // トンネル経由のアクセス時はURLのトークンをiframeにも付与
  const urlToken =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("token")
      : null;
  const ttydBasePath = `/ttyd/${session.id}/`;
  // 常にプロキシ経由でアクセスし同一オリジンを維持する
  // （リンクインジェクト等でiframe内DOMにアクセスするため必須）
  const ttydIframeSrc = urlToken
    ? `${ttydBasePath}?token=${urlToken}`
    : ttydBasePath;

  // Quick commands for mobile
  const quickCommands = [
    { label: "/resume", cmd: "/resume" },
    { label: "/help", cmd: "/help" },
    { label: "/status", cmd: "/status" },
    { label: "/clear", cmd: "/clear" },
    { label: "/compact", cmd: "/compact" },
  ];

  // diagram タブは右ペイン（SplitViewPane の DiagramPane）専属になった
  // ため、タブバーには表示しない。visibleTabIndexMap[表示用index] = 元のtabs配列index
  const visibleTabIndexMap: number[] = [];
  const visibleTabs: ViewerTab[] = [];
  tabs.forEach((tab, i) => {
    if (tab.type === "diagram") return;
    visibleTabIndexMap.push(i);
    visibleTabs.push(tab);
  });
  const visibleActiveTabIndex = visibleTabIndexMap.indexOf(activeTabIndex);
  // 防御: activeTabIndex がタブバーに出ない diagram タブを指してしまった場合
  // （本来は useViewerTabs.handleTabClose の index 補正で回避されるが、想定外の
  // 経路で着地した場合に備えた保険）、visibleTabIndexMap に見つからず
  // visibleActiveTabIndex が -1 になる。この状態のまま下の描画分岐
  // （terminal/file/html）を raw な activeTabIndex で判定すると、
  // どれにも該当せず左ペインが完全に空白になってしまう。
  // 根本修正だけだと将来別の経路で同じ状態に陥ったとき同じ空白が再発し、
  // 防御だけだと activeTabIndex 自体の状態は壊れたままになるため、両方入れる。
  // terminal（index 0、常にタブバーに存在し close 不可）へフォールバックする。
  const isActiveTabHidden = visibleActiveTabIndex < 0;
  const effectiveActiveTabIndex = isActiveTabHidden ? 0 : activeTabIndex;
  const safeVisibleActiveTabIndex = isActiveTabHidden
    ? 0
    : visibleActiveTabIndex;

  // スリープ復帰やモバイルのバックグラウンド復帰で ttyd の WebSocket が落ちると
  // 端末は "Press ⏎ to Reconnect" のまま固まる。表示中のターミナルに限って
  // 検出し、iframe を貼り直して復帰させる。
  useTtydReconnect(iframeRef, iframeKey, {
    isVisible: isVisible && tabs[effectiveActiveTabIndex]?.type === "terminal",
    onReload: handleReloadIframe,
  });

  // 上部バー (SplitViewPane) から端末専用の操作を呼べるようにする。
  // どれも上部バーの1タップのボタンから呼ぶ (`…` には残していない)
  useImperativeHandle(ref, () => ({
    copyBuffer: () => {
      handleCopyBuffer();
    },
    pasteImage: () => {
      handlePasteButtonClick();
    },
    openFilePicker: () => {
      fileInputRef.current?.click();
    },
    reload: handleReloadIframe,
    toggleInputBar: () => setShowInput(prev => !prev),
  }));

  useEffect(() => {
    onInputBarVisibleChange?.(showInput);
  }, [showInput, onInputBarVisibleChange]);

  return (
    <div className="relative h-full flex flex-col overflow-hidden">
      {/* ウィンドウ全体のD&Dオーバーレイ（ドラッグ中のみ表示） */}
      {isDragging && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-primary/15 border-4 border-dashed border-primary pointer-events-none">
          <div className="text-2xl font-semibold text-primary bg-card/90 px-6 py-4 rounded-lg shadow-card">
            ファイルをドロップして送信
          </div>
        </div>
      )}

      {/* タブバー（共通コンポーネント）。diagram は右ペイン専属になったのでタブ一覧からは除外し、
          表示用インデックスと元の tabs 配列インデックスを相互変換する */}
      <ViewerTabBar
        tabs={visibleTabs}
        activeTabIndex={safeVisibleActiveTabIndex}
        onTabSelect={idx => onTabSelect(visibleTabIndexMap[idx])}
        onTabClose={idx => onTabClose(visibleTabIndexMap[idx])}
      />

      {/* ttyd iframe。明るい画面の中の「暗い窓」として額縁で囲む。
          背景色はttydと同じTERMINAL_BG (Tailwindの任意値クラスでの直書きはしない) */}
      <div
        className="flex-1 min-h-0 p-1"
        style={{
          display:
            tabs[effectiveActiveTabIndex]?.type === "terminal"
              ? undefined
              : "none",
        }}
      >
        <div
          data-testid="terminal-frame"
          className="h-full rounded-lg p-2 overflow-hidden"
          style={{ backgroundColor: TERMINAL_BG }}
        >
          {session.ttydUrl || session.ttydPort ? (
            <iframe
              key={iframeKey}
              ref={iframeRef}
              src={ttydIframeSrc}
              className="block w-full h-full border-0"
              title={`Terminal - ${worktree?.branch || session.id}`}
              allow="clipboard-read; clipboard-write; keyboard-map"
            />
          ) : (
            <div
              className="flex items-center justify-center h-full"
              style={{ color: TERMINAL_FG }}
            >
              <div className="text-center">
                <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full mx-auto mb-4" />
                <p>端末を起動しています</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ファイルビューワー / ブラウザ */}
      {tabs[effectiveActiveTabIndex]?.type === "file" &&
        (() => {
          const tab = tabs[effectiveActiveTabIndex] as ViewerTab & {
            type: "file";
          };
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
      {tabs[effectiveActiveTabIndex]?.type === "html" &&
        (() => {
          const tab = tabs[effectiveActiveTabIndex] as ViewerTab & {
            type: "html";
          };
          return (
            <div className="flex-1 min-h-0">
              <HtmlViewerPane filePath={tab.filePath} />
            </div>
          );
        })()}
      {/* 添付ファイル プレビューダイアログ（画像/非画像共通） */}
      {pendingFiles.length > 0 && (
        <div
          className="absolute inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          data-testid="terminal-upload-preview"
        >
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
                      setPendingFiles(prev => prev.filter((_, i) => i !== idx))
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
              autoFocus
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

      {/* Mobile-friendly Input Bar */}
      {showInput && (
        <div className="border-t border-border bg-sidebar shrink-0">
          {/* Quick commands toggle */}
          <div className="flex items-center justify-between px-3 py-1 border-b border-border/50">
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowQuickCommands(!showQuickCommands)}
            >
              {showQuickCommands ? (
                <ChevronUp className="w-3 h-3" />
              ) : (
                <ChevronDown className="w-3 h-3" />
              )}
              Quick commands
            </button>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => onSendKey("y")}
                title="Send 'y' (yes)"
              >
                y
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => onSendKey("n")}
                title="Send 'n' (no)"
              >
                n
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => onSendKey("S-Tab")}
                title="Send Shift+Tab (back)"
              >
                <ChevronLeft className="w-3 h-3 mr-1" />
                S-Tab
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => onSendKey("Escape")}
                title="Send Escape (cancel)"
              >
                <XCircle className="w-3 h-3 mr-1" />
                Esc
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                onClick={() => onSendKey("C-c")}
                title="Send Ctrl+C (interrupt)"
              >
                <StopCircle className="w-3 h-3 mr-1" />
                Ctrl+C
              </Button>
            </div>
          </div>

          {/* Quick commands panel */}
          {showQuickCommands && (
            <div className="flex gap-2 px-3 py-2 border-b border-border/50 overflow-x-auto">
              {quickCommands.map(({ label, cmd }) => (
                <Button
                  key={cmd}
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="shrink-0 text-xs font-mono h-8"
                  onClick={() => onSendMessage(cmd)}
                >
                  {label}
                </Button>
              ))}
            </div>
          )}

          {/* Main input */}
          <form onSubmit={handleSubmit} className="p-3 md:p-2">
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <Textarea
                  ref={textareaRef}
                  value={inputValue}
                  onChange={e => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type message... (Enter to send)"
                  className="min-h-[44px] max-h-32 resize-none font-mono text-sm bg-input"
                  rows={1}
                />
              </div>
              <Button
                type="submit"
                size="icon"
                className="h-11 w-11 md:h-9 md:w-9 shrink-0"
                disabled={!inputValue.trim()}
              >
                <Send className="w-5 h-5 md:w-4 md:h-4" />
              </Button>
            </div>
          </form>
        </div>
      )}

      {/* 添付ファイル選択用の隠しinput (fileInputRefの説明を参照) */}
      {onUploadFile && (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={e => {
            const files = Array.from(e.target.files ?? []);
            if (files.length > 0) handleFilesSelected(files);
            e.target.value = "";
          }}
        />
      )}
    </div>
  );
}

export default TerminalPane;
