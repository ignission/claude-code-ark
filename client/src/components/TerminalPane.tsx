/**
 * TerminalPane Component - ttyd iframe with mobile-friendly input
 *
 * Design: Full terminal experience with mobile input overlay
 * - ttyd iframe for terminal rendering (handles all output display)
 * - Mobile-friendly input bar at bottom
 * - Support for special keys (Ctrl+C, etc.)
 * - Quick command buttons for common operations
 */

import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Copy,
  File as FileIcon,
  GitBranch,
  ImageIcon,
  Keyboard,
  Paperclip,
  RefreshCw,
  Send,
  StopCircle,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import type {
  ManagedSession,
  MessageShortcut,
  SpecialKey,
  Worktree,
} from "../../../shared/types";
import { fileToBase64, validateFile } from "../hooks/useFileUpload";
import { useIsMobile } from "../hooks/useMobile";
import { useTerminalLinkInjection } from "../hooks/useTerminalLinkInjection";
import { FileViewerPane } from "./FileViewerPane";
import { HtmlViewerPane } from "./HtmlViewerPane";
import { MessageShortcutManagerDialog } from "./MessageShortcutManagerDialog";
import { MessageShortcutMenu } from "./MessageShortcutMenu";
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
      error?: string;
    }
  | {
      type: "html";
      id: string;
      filePath: string;
    };

interface TerminalPaneProps {
  session: ManagedSession;
  worktree: Worktree | undefined;
  repoName?: string;
  onSendMessage: (message: string) => void;
  onSendKey: (key: SpecialKey) => void;
  /** セッション削除（停止 + メイン以外のWorktree削除） */
  onDeleteSession: () => void;
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
  messageShortcuts: MessageShortcut[];
  onCreateShortcut: (message: string) => void;
  onUpdateShortcut: (id: string, patch: { message?: string }) => void;
  onDeleteShortcut: (id: string) => void;
}

export function TerminalPane({
  session,
  worktree,
  repoName,
  onSendMessage,
  onSendKey,
  onDeleteSession,
  onUploadFile,
  onCopyBuffer,
  tabs,
  activeTabIndex,
  onTabSelect,
  onTabClose,
  messageShortcuts,
  onCreateShortcut,
  onUpdateShortcut,
  onDeleteShortcut,
}: TerminalPaneProps) {
  const isMobile = useIsMobile();
  const [inputValue, setInputValue] = useState("");
  const [showInput, setShowInput] = useState(true);
  const [showQuickCommands, setShowQuickCommands] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [showShortcutManager, setShowShortcutManager] = useState(false);

  // PCでは入力バーをデフォルト非表示にする
  useEffect(() => {
    if (!isMobile) {
      setShowInput(false);
    }
  }, [isMobile]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeKey, setIframeKey] = useState(0);

  // ttyd iframe内のxterm.jsにリンク検出をインジェクト（共通フック）
  useTerminalLinkInjection(iframeRef, iframeKey);

  // 全ての添付ファイル（画像/非画像）を共通でプレビューダイアログに集約する
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [uploadMessage, setUploadMessage] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [copySuccess, setCopySuccess] = useState(false);

  // tmuxバッファの内容をクリップボードにコピー
  const handleCopyBuffer = async () => {
    if (!onCopyBuffer) return;
    try {
      const text = await onCopyBuffer();
      if (text) {
        await navigator.clipboard.writeText(text);
        setCopySuccess(true);
        setTimeout(() => setCopySuccess(false), 2000);
      }
    } catch (err) {
      console.error("Failed to copy:", err);
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

  // クリップボードから画像を読み取るボタン用
  const handlePasteButtonClick = useCallback(async () => {
    if (!onUploadFile) return;
    try {
      const clipboardItems = await navigator.clipboard.read();
      const files: File[] = [];
      for (const item of clipboardItems) {
        const imageType = item.types.find(type => type.startsWith("image/"));
        if (imageType) {
          const blob = await item.getType(imageType);
          const ext = imageType.split("/")[1] || "png";
          files.push(
            new File([blob], `pasted-image.${ext}`, { type: imageType })
          );
        }
      }
      if (files.length > 0) {
        await addPendingFiles(files);
      }
    } catch (err) {
      console.error("Failed to read clipboard:", err);
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
  useEffect(() => {
    if (!onUploadFile) return;
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
  }, [onUploadFile, handleFilesSelected]);

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

  return (
    <div className="h-full flex flex-col bg-card border border-border rounded-lg overflow-hidden">
      {/* ウィンドウ全体のD&Dオーバーレイ（ドラッグ中のみ表示） */}
      {isDragging && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-blue-500/20 border-4 border-dashed border-blue-500 pointer-events-none">
          <div className="text-2xl font-semibold text-blue-700 dark:text-blue-200 bg-white/90 dark:bg-gray-800/90 px-6 py-4 rounded-lg shadow-lg">
            ファイルをドロップして送信
          </div>
        </div>
      )}

      {/* Header */}
      <header className="h-14 md:h-10 border-b border-border flex items-center justify-between px-4 md:px-3 bg-sidebar shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`status-indicator ${session.status}`} />
          {repoName && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/20 text-primary font-medium shrink-0">
              {repoName}
            </span>
          )}
          <GitBranch className="w-4 h-4 md:w-3 md:h-3 text-muted-foreground shrink-0" />
          <span className="font-mono text-sm md:text-xs truncate text-sidebar-foreground">
            {worktree?.branch ||
              session.worktreePath.substring(
                session.worktreePath.lastIndexOf("/") + 1
              )}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 md:h-6 md:w-6"
            onClick={handleCopyBuffer}
            title="Copy tmux buffer to clipboard"
          >
            {copySuccess ? (
              <Check className="w-5 h-5 md:w-3 md:h-3 text-green-500" />
            ) : (
              <Copy className="w-5 h-5 md:w-3 md:h-3" />
            )}
          </Button>
          {onUploadFile && (
            <Button
              variant="ghost"
              size="icon"
              className="h-10 w-10 md:h-6 md:w-6"
              onClick={handlePasteButtonClick}
              title="Paste image from clipboard"
            >
              <ImageIcon className="w-5 h-5 md:w-3 md:h-3" />
            </Button>
          )}
          {onUploadFile && (
            <label
              className="h-10 w-10 md:h-6 md:w-6 inline-flex items-center justify-center rounded-md cursor-pointer hover:bg-accent hover:text-accent-foreground"
              title="ファイルを添付"
            >
              <input
                type="file"
                multiple
                className="hidden"
                onChange={e => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.length > 0) handleFilesSelected(files);
                  e.target.value = "";
                }}
              />
              <Paperclip className="w-5 h-5 md:w-3 md:h-3" />
            </label>
          )}
          <MessageShortcutMenu
            shortcuts={messageShortcuts}
            onSendMessage={onSendMessage}
            onOpenManager={() => setShowShortcutManager(true)}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 md:h-6 md:w-6"
            onClick={handleReloadIframe}
            title="Reload terminal"
          >
            <RefreshCw className="w-5 h-5 md:w-3 md:h-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 md:h-6 md:w-6"
            onClick={() => setShowInput(!showInput)}
            title={showInput ? "Hide input" : "Show input"}
          >
            <Keyboard
              className={`w-5 h-5 md:w-3 md:h-3 ${showInput ? "text-primary" : ""}`}
            />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 md:h-6 md:w-6 text-destructive hover:text-destructive"
            onClick={() => setShowDeleteDialog(true)}
            title="セッションを削除"
          >
            <Trash2 className="w-5 h-5 md:w-3 md:h-3" />
          </Button>
        </div>
      </header>

      {/* タブバー（共通コンポーネント） */}
      <ViewerTabBar
        tabs={tabs}
        activeTabIndex={activeTabIndex}
        onTabSelect={onTabSelect}
        onTabClose={onTabClose}
      />

      {/* ttyd iframe */}
      <div
        className="flex-1 min-h-0 bg-[#1a1b26] overflow-hidden"
        style={{
          display:
            tabs[activeTabIndex]?.type === "terminal" ? undefined : "none",
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
              <p>Starting terminal...</p>
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
                className="h-11 w-11 md:h-9 md:w-9 glow-green shrink-0"
                disabled={!inputValue.trim()}
              >
                <Send className="w-5 h-5 md:w-4 md:h-4" />
              </Button>
            </div>
          </form>
        </div>
      )}

      <MessageShortcutManagerDialog
        open={showShortcutManager}
        onOpenChange={setShowShortcutManager}
        shortcuts={messageShortcuts}
        onCreate={onCreateShortcut}
        onUpdate={onUpdateShortcut}
        onDelete={onDeleteShortcut}
      />

      {/* 削除確認ダイアログ */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent className="bg-card border-border w-[calc(100%-2rem)] max-w-md mx-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>セッションを削除</AlertDialogTitle>
            <AlertDialogDescription>
              {worktree === undefined
                ? "このセッションを削除しますか？"
                : worktree.isMain
                  ? "このセッションを削除しますか？メインWorktreeは削除されません。"
                  : "このセッションとWorktreeを削除しますか？関連するブランチも削除されます。"}
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
    </div>
  );
}

export default TerminalPane;
