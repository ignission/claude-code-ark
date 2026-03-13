/**
 * TerminalPane Component - ttyd iframe with mobile-friendly input
 *
 * Design: Full terminal experience with mobile input overlay
 * - ttyd iframe for terminal rendering (handles all output display)
 * - Mobile-friendly input bar at bottom
 * - Support for special keys (Ctrl+C, etc.)
 * - Quick command buttons for common operations
 */

import { useRef, useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Square,
  X,
  Maximize2,
  Minimize2,
  Send,
  StopCircle,
  GitBranch,
  Keyboard,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  RefreshCw,
  XCircle,
  ImageIcon,
  Copy,
  Check,
} from "lucide-react";
import type { ManagedSession, SpecialKey, Worktree } from "../../../shared/types";
import { useIsMobile } from "../hooks/useMobile";

interface TerminalPaneProps {
  session: ManagedSession;
  worktree: Worktree | undefined;
  repoName?: string;
  onSendMessage: (message: string) => void;
  onSendKey: (key: SpecialKey) => void;
  onStopSession: () => void;
  onClose: () => void;
  onMaximize?: () => void;
  isMaximized?: boolean;
  onUploadImage?: (base64Data: string, mimeType: string) => void;
  imageUploadResult?: { path: string; filename: string } | null;
  imageUploadError?: string | null;
  onClearImageUploadState?: () => void;
  onCopyBuffer?: () => Promise<string | null>;
}

export function TerminalPane({
  session,
  worktree,
  repoName,
  onSendMessage,
  onSendKey,
  onStopSession,
  onClose,
  onMaximize,
  isMaximized = false,
  onUploadImage,
  imageUploadResult,
  imageUploadError,
  onClearImageUploadState,
  onCopyBuffer,
}: TerminalPaneProps) {
  const isMobile = useIsMobile();
  const [inputValue, setInputValue] = useState("");
  const [showInput, setShowInput] = useState(true);
  const [showQuickCommands, setShowQuickCommands] = useState(false);

  // PCでは入力バーをデフォルト非表示にする
  useEffect(() => {
    if (!isMobile) {
      setShowInput(false);
    }
  }, [isMobile]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [pastedImage, setPastedImage] = useState<{ base64: string; mimeType: string; preview: string } | null>(null);
  const [imageMessage, setImageMessage] = useState("");
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
    setIframeKey((prev) => prev + 1);
  };

  // Handle paste event for image
  const handlePaste = useCallback((e: React.ClipboardEvent | ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const itemsArray = Array.from(items);
    for (const item of itemsArray) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;

        const reader = new FileReader();
        reader.onload = (event) => {
          const dataUrl = event.target?.result as string;
          // data:image/png;base64,xxx... からbase64部分を抽出
          const [header, base64] = dataUrl.split(",");
          const mimeType = header.match(/data:(.*?);/)?.[1] || "image/png";
          setPastedImage({
            base64,
            mimeType,
            preview: dataUrl,
          });
        };
        reader.readAsDataURL(file);
        break;
      }
    }
  }, []);

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
  const handlePasteButtonClick = async () => {
    try {
      const clipboardItems = await navigator.clipboard.read();
      for (const item of clipboardItems) {
        const imageType = item.types.find(type => type.startsWith("image/"));
        if (imageType) {
          const blob = await item.getType(imageType);
          const reader = new FileReader();
          reader.onload = (event) => {
            const dataUrl = event.target?.result as string;
            const [header, base64] = dataUrl.split(",");
            const mimeType = header.match(/data:(.*?);/)?.[1] || "image/png";
            setPastedImage({
              base64,
              mimeType,
              preview: dataUrl,
            });
          };
          reader.readAsDataURL(blob);
          break;
        }
      }
    } catch (err) {
      console.error("Failed to read clipboard:", err);
    }
  };

  // Handle image upload success
  useEffect(() => {
    if (imageUploadResult && pastedImage) {
      // Claude Codeに@パス形式で送信
      const message = imageMessage.trim()
        ? `@${imageUploadResult.path} ${imageMessage}`
        : `@${imageUploadResult.path}`;
      onSendMessage(message);
      setPastedImage(null);
      setImageMessage("");
      onClearImageUploadState?.();
    }
  }, [imageUploadResult, pastedImage, imageMessage, onSendMessage, onClearImageUploadState]);

  // Construct ttyd iframe URL
  // ローカル開発時のみ直接接続、リモートアクセス時はプロキシ経由
  const isLocalAccess = typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
  const ttydIframeSrc = isLocalAccess && session.ttydPort
    ? `http://127.0.0.1:${session.ttydPort}/ttyd/${session.id}/`
    : `/ttyd/${session.id}/`;

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
            {worktree?.branch || session.worktreePath.substring(session.worktreePath.lastIndexOf("/") + 1)}
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
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 md:h-6 md:w-6"
            onClick={handlePasteButtonClick}
            title="Paste image from clipboard"
          >
            <ImageIcon className="w-5 h-5 md:w-3 md:h-3" />
          </Button>
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
            <Keyboard className={`w-5 h-5 md:w-3 md:h-3 ${showInput ? "text-primary" : ""}`} />
          </Button>
          {onMaximize && (
            <Button
              variant="ghost"
              size="icon"
              className="h-10 w-10 md:h-6 md:w-6"
              onClick={onMaximize}
            >
              {isMaximized ? (
                <Minimize2 className="w-5 h-5 md:w-3 md:h-3" />
              ) : (
                <Maximize2 className="w-5 h-5 md:w-3 md:h-3" />
              )}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 md:h-6 md:w-6 text-destructive hover:text-destructive"
            onClick={onStopSession}
            title="Stop session (kills tmux)"
          >
            <Square className="w-5 h-5 md:w-3 md:h-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 md:h-6 md:w-6"
            onClick={onClose}
          >
            <X className="w-5 h-5 md:w-3 md:h-3" />
          </Button>
        </div>
      </header>

      {/* ttyd iframe */}
      <div className="flex-1 min-h-0 bg-[#1a1b26] overflow-hidden">
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

      {/* Image paste preview dialog */}
      {pastedImage && (
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card border border-border rounded-lg p-4 max-w-md w-full mx-4">
            <h3 className="text-sm font-semibold mb-3">画像を送信</h3>
            <div className="mb-3">
              <img
                src={pastedImage.preview}
                alt="Pasted"
                className="max-h-48 mx-auto rounded border border-border"
              />
            </div>
            <div className="mb-3">
              <Textarea
                value={imageMessage}
                onChange={(e) => setImageMessage(e.target.value)}
                placeholder="画像についてのメッセージ（任意）"
                className="min-h-[60px] resize-none text-sm"
                rows={2}
              />
            </div>
            {imageUploadError && (
              <p className="text-destructive text-xs mb-3">{imageUploadError}</p>
            )}
            <div className="flex gap-2 justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPastedImage(null);
                  setImageMessage("");
                  onClearImageUploadState?.();
                }}
              >
                キャンセル
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  onUploadImage?.(pastedImage.base64, pastedImage.mimeType);
                }}
              >
                送信
              </Button>
            </div>
          </div>
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
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  enterKeyHint="send"
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
    </div>
  );
}

export default TerminalPane;
