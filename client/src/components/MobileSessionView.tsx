/**
 * MobileSessionView - モバイル用セッション詳細画面
 *
 * ターミナル全画面表示 + Quick Keys + 入力バー常時表示。
 * Opsドロップダウンで追加操作（Copy Buffer, Paste Image, Reload, スラッシュコマンド）。
 */

import {
  ChevronLeft,
  Copy,
  File as FileIcon,
  GitBranch,
  ImageIcon,
  MoreVertical,
  RefreshCw,
  Send,
  Trash2,
  X,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type {
  ManagedSession,
  MessageShortcut,
  SpecialKey,
  Worktree,
} from "../../../shared/types";
import { fileToBase64, validateFile } from "../hooks/useFileUpload";
import { useTerminalLinkInjection } from "../hooks/useTerminalLinkInjection";
import { useVisualViewport } from "../hooks/useVisualViewport";
import { FileViewerPane } from "./FileViewerPane";
import { MessageShortcutManagerDialog } from "./MessageShortcutManagerDialog";
import { MessageShortcutMenu } from "./MessageShortcutMenu";
import type { ViewerTab } from "./TerminalPane";
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

interface MobileSessionViewProps {
  session: ManagedSession;
  worktree: Worktree | undefined;
  onBack: () => void;
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

export function MobileSessionView({
  session,
  worktree,
  onBack,
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
}: MobileSessionViewProps) {
  const { height: viewportHeight, isKeyboardVisible } = useVisualViewport();
  const [inputValue, setInputValue] = useState("");
  const [iframeKey, setIframeKey] = useState(0);
  // 全ての添付ファイル（画像/非画像）を共通でプレビューダイアログに集約する
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [uploadMessage, setUploadMessage] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showShortcutManager, setShowShortcutManager] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // ファイル選択input は DropdownMenuContent (Radix Portal) の外に配置する。
  // 内部に置くとメニューを閉じた瞬間に Portal が unmount され、
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
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSendMessage(inputValue);
    setInputValue("");
  };

  // Enter送信（inputなのでShift+Enterチェック不要）
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  // iframeリロード
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

  // クリップボードからの画像ペーストボタン
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

  // スラッシュコマンド
  const slashCommands = [
    { label: "/resume", cmd: "/resume" },
    { label: "/help", cmd: "/help" },
    { label: "/status", cmd: "/status" },
    { label: "/clear", cmd: "/clear" },
    { label: "/compact", cmd: "/compact" },
  ];

  return (
    <div
      className="flex-1 flex flex-col min-h-0 safe-area-x"
      style={
        isKeyboardVisible
          ? { height: `${viewportHeight}px`, maxHeight: `${viewportHeight}px` }
          : undefined
      }
    >
      {/* ヘッダー: 戻る、ブランチ名、Opsドロップダウン、Stopボタン */}
      <header className="h-12 border-b border-border flex items-center justify-between px-2 bg-sidebar shrink-0 safe-area-top">
        <div className="flex items-center gap-1 min-w-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 shrink-0"
            onClick={onBack}
          >
            <ChevronLeft className="w-5 h-5" />
          </Button>
          <div className={`status-indicator ${session.status} shrink-0`} />
          <GitBranch className="w-4 h-4 text-muted-foreground shrink-0" />
          <span className="font-mono text-sm truncate">
            {worktree?.branch ||
              session.worktreePath.substring(
                session.worktreePath.lastIndexOf("/") + 1
              )}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <MessageShortcutMenu
            shortcuts={messageShortcuts}
            onSendMessage={onSendMessage}
            onOpenManager={() => setShowShortcutManager(true)}
            size="lg"
          />
          {/* Opsドロップダウン */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-10 w-10">
                <MoreVertical className="w-5 h-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {onCopyBuffer && (
                <DropdownMenuItem onClick={handleCopyBuffer}>
                  <Copy className="w-4 h-4 mr-2" />
                  Copy Buffer
                </DropdownMenuItem>
              )}
              {onUploadFile && (
                <DropdownMenuItem onClick={handlePasteButtonClick}>
                  <ImageIcon className="w-4 h-4 mr-2" />
                  Paste Image
                </DropdownMenuItem>
              )}
              {onUploadFile && (
                <DropdownMenuItem onClick={() => fileInputRef.current?.click()}>
                  <FileIcon className="mr-2 h-4 w-4" />
                  ファイルを添付
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={handleReloadIframe}>
                <RefreshCw className="w-4 h-4 mr-2" />
                Reload Terminal
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {slashCommands.map(({ label, cmd }) => (
                <DropdownMenuItem
                  key={cmd}
                  onClick={() => onSendMessage(cmd)}
                  className="font-mono text-xs"
                >
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {/* 削除ボタン（セッション停止 + メイン以外のWorktree削除） */}
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 text-destructive hover:text-destructive"
            onClick={() => setShowDeleteDialog(true)}
            title="セッションを削除"
          >
            <Trash2 className="w-5 h-5" />
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
        className="flex-1 min-h-0 bg-[#1a1b26] overflow-hidden relative"
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
                error={tab.error}
              />
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

      {/* Quick Keys: ↑/↓/Esc/Ctrl+C/S-Tab 常時表示 */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-t border-border/50 bg-sidebar overflow-x-auto select-none">
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

      {/* 入力バー: 常時表示 */}
      <form
        onSubmit={handleSubmit}
        className="p-3 border-t border-border bg-sidebar safe-area-bottom"
      >
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <Input
              ref={inputRef}
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              enterKeyHint="send"
              placeholder="メッセージを入力... (Enter送信)"
              className="h-11 font-mono text-sm bg-input"
            />
          </div>
          <Button
            type="submit"
            size="icon"
            className="h-11 w-11 glow-green shrink-0"
          >
            <Send className="w-5 h-5" />
          </Button>
        </div>
      </form>

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

      <MessageShortcutManagerDialog
        open={showShortcutManager}
        onOpenChange={setShowShortcutManager}
        shortcuts={messageShortcuts}
        onCreate={onCreateShortcut}
        onUpdate={onUpdateShortcut}
        onDelete={onDeleteShortcut}
      />
    </div>
  );
}
