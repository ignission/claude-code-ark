/**
 * MobileSessionView - モバイル用セッション詳細画面
 *
 * ターミナル全画面表示 + Quick Keys + 入力バー常時表示。
 * Opsドロップダウンで追加操作（Copy Buffer, Paste Image, Reload, スラッシュコマンド）。
 */

import {
  ChevronLeft,
  Copy,
  GitBranch,
  ImageIcon,
  MoreVertical,
  RefreshCw,
  Send,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
  SpecialKey,
  Worktree,
} from "../../../shared/types";
import { useVisualViewport } from "../hooks/useVisualViewport";
import type { ViewerTab } from "./TerminalPane";
import { FileViewerPane } from "./FileViewerPane";
import { BrowserPane } from "./BrowserPane";

interface MobileSessionViewProps {
  session: ManagedSession;
  worktree: Worktree | undefined;
  onBack: () => void;
  onSendMessage: (message: string) => void;
  onSendKey: (key: SpecialKey) => void;
  onStopSession: () => void;
  onUploadImage?: (base64Data: string, mimeType: string) => void;
  imageUploadResult?: { path: string; filename: string } | null;
  imageUploadError?: string | null;
  onClearImageUploadState?: () => void;
  onCopyBuffer?: () => Promise<string | null>;
  tabs: ViewerTab[];
  activeTabIndex: number;
  onTabSelect: (index: number) => void;
  onTabClose: (index: number) => void;
}

export function MobileSessionView({
  session,
  worktree,
  onBack,
  onSendMessage,
  onSendKey,
  onStopSession,
  onUploadImage,
  imageUploadResult,
  imageUploadError,
  onClearImageUploadState,
  onCopyBuffer,
  tabs,
  activeTabIndex,
  onTabSelect,
  onTabClose,
}: MobileSessionViewProps) {
  const { height: viewportHeight, isKeyboardVisible } = useVisualViewport();
  const [inputValue, setInputValue] = useState("");
  const [iframeKey, setIframeKey] = useState(0);
  const [pastedImage, setPastedImage] = useState<{
    base64: string;
    mimeType: string;
    preview: string;
  } | null>(null);
  const [imageMessage, setImageMessage] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // ttyd iframe URL構築
  const isLocalAccess =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1");
  // トンネル経由のアクセス時はURLのトークンをiframeにも付与
  const urlToken =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("token")
      : null;
  const ttydBasePath = `/ttyd/${session.id}/`;
  const ttydIframeSrc =
    isLocalAccess && session.ttydPort
      ? `http://127.0.0.1:${session.ttydPort}${ttydBasePath}`
      : urlToken
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

  // クリップボードから画像を読み取り
  const handlePaste = useCallback(
    (e: React.ClipboardEvent | ClipboardEvent) => {
      if (!onUploadImage) return;
      const items = e.clipboardData?.items;
      if (!items) return;

      const itemsArray = Array.from(items);
      for (const item of itemsArray) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (!file) continue;

          const reader = new FileReader();
          reader.onload = event => {
            const dataUrl = event.target?.result as string;
            const [header, base64] = dataUrl.split(",");
            const mimeType = header.match(/data:(.*?);/)?.[1] || "image/png";
            setPastedImage({ base64, mimeType, preview: dataUrl });
          };
          reader.readAsDataURL(file);
          break;
        }
      }
    },
    [onUploadImage]
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
  const handlePasteButtonClick = async () => {
    if (!onUploadImage) return;
    try {
      const clipboardItems = await navigator.clipboard.read();
      for (const item of clipboardItems) {
        const imageType = item.types.find(type => type.startsWith("image/"));
        if (imageType) {
          const blob = await item.getType(imageType);
          const reader = new FileReader();
          reader.onload = event => {
            const dataUrl = event.target?.result as string;
            const [header, base64] = dataUrl.split(",");
            const mimeType = header.match(/data:(.*?);/)?.[1] || "image/png";
            setPastedImage({ base64, mimeType, preview: dataUrl });
          };
          reader.readAsDataURL(blob);
          break;
        }
      }
    } catch (err) {
      console.error("Failed to read clipboard:", err);
    }
  };

  // 画像アップロード成功時に自動送信
  useEffect(() => {
    if (imageUploadResult && pastedImage) {
      const message = imageMessage.trim()
        ? `@${imageUploadResult.path} ${imageMessage}`
        : `@${imageUploadResult.path}`;
      onSendMessage(message);
      setPastedImage(null);
      setImageMessage("");
      onClearImageUploadState?.();
    }
  }, [
    imageUploadResult,
    pastedImage,
    imageMessage,
    onSendMessage,
    onClearImageUploadState,
  ]);

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

  // ttyd iframe内のxterm.jsにリンク検出をインジェクト
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const injectLinkProvider = () => {
      try {
        const iframeWindow = iframe.contentWindow;
        if (!iframeWindow) return;

        const checkTerm = setInterval(() => {
          // biome-ignore lint/suspicious/noExplicitAny: ttyd iframe内のxterm.jsオブジェクトにアクセスするため
          const term = (iframeWindow as any).term;
          if (!term || !term.registerLinkProvider) return;
          clearInterval(checkTerm);

          // biome-ignore lint/suspicious/noExplicitAny: ttyd iframe内の状態管理フラグ
          if ((iframeWindow as any).__arkLinkInjected) return;
          // biome-ignore lint/suspicious/noExplicitAny: ttyd iframe内の状態管理フラグ
          (iframeWindow as any).__arkLinkInjected = true;

          term.registerLinkProvider({
            // biome-ignore lint/suspicious/noExplicitAny: xterm.js link provider API
            provideLinks(
              lineNumber: number,
              callback: (links: any[] | undefined) => void
            ) {
              const line = term.buffer.active.getLine(lineNumber - 1);
              if (!line) {
                callback(undefined);
                return;
              }
              const text = line.translateToString();
              // biome-ignore lint/suspicious/noExplicitAny: xterm.js link objects
              const links: any[] = [];

              // ファイルパス検出
              const fileRegex =
                /(?:file:)?([a-zA-Z0-9_.\-/]+\.[a-zA-Z0-9]+)(?::(\d+))?/g;
              let match: RegExpExecArray | null;
              while ((match = fileRegex.exec(text)) !== null) {
                const fullMatch = match[0];
                const filePath = match[1];
                const lineNum = match[2] ? Number.parseInt(match[2]) : null;
                if (!filePath.includes("/") && !fullMatch.startsWith("file:"))
                  continue;
                links.push({
                  range: {
                    start: { x: match.index + 1, y: lineNumber },
                    end: {
                      x: match.index + fullMatch.length + 1,
                      y: lineNumber,
                    },
                  },
                  text: fullMatch,
                  activate() {
                    window.parent.postMessage(
                      { type: "ark:open-file", path: filePath, line: lineNum },
                      window.location.origin
                    );
                  },
                });
              }

              // localhost URL検出
              const urlRegex =
                /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?[/\w.\-?&=%#]*/g;
              while ((match = urlRegex.exec(text)) !== null) {
                const matchedUrl = match[0];
                links.push({
                  range: {
                    start: { x: match.index + 1, y: lineNumber },
                    end: {
                      x: match.index + matchedUrl.length + 1,
                      y: lineNumber,
                    },
                  },
                  text: matchedUrl,
                  activate() {
                    window.parent.postMessage(
                      { type: "ark:open-url", url: matchedUrl },
                      window.location.origin
                    );
                  },
                });
              }

              callback(links.length > 0 ? links : undefined);
            },
          });
        }, 500);

        setTimeout(() => clearInterval(checkTerm), 10000);
      } catch {
        // クロスオリジンエラー等は無視
      }
    };

    iframe.addEventListener("load", injectLinkProvider);
    if (iframe.contentDocument?.readyState === "complete") {
      injectLinkProvider();
    }

    return () => {
      iframe.removeEventListener("load", injectLinkProvider);
    };
  }, [iframeKey]);

  // スワイプスクロールモード
  const [scrollMode, setScrollMode] = useState(false);
  const swipeStateRef = useRef<{ startY: number; sentLines: number } | null>(
    null
  );
  const LINE_HEIGHT = 20; // 1行あたりのpx閾値

  // スクロールモードON時にcopy-modeに入り、OFF時にqで抜ける
  const toggleScrollMode = useCallback(() => {
    if (scrollMode) {
      onSendKey("q");
      setScrollMode(false);
    } else {
      onSendKey("copy-mode");
      setScrollMode(true);
    }
  }, [scrollMode, onSendKey]);

  const handleOverlayTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    swipeStateRef.current = { startY: touch.clientY, sentLines: 0 };
  }, []);

  const handleOverlayTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const state = swipeStateRef.current;
      if (!state) return;
      e.preventDefault();
      const touch = e.touches[0];
      const deltaY = state.startY - touch.clientY;
      const totalLines = Math.floor(Math.abs(deltaY) / LINE_HEIGHT);
      const newLines = totalLines - state.sentLines;
      if (newLines > 0) {
        const key: SpecialKey = deltaY > 0 ? "scroll-up" : "scroll-down";
        for (let i = 0; i < newLines; i++) {
          onSendKey(key);
        }
        state.sentLines = totalLines;
      }
    },
    [onSendKey]
  );

  const handleOverlayTouchEnd = useCallback(() => {
    swipeStateRef.current = null;
  }, []);

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
              {onUploadImage && (
                <DropdownMenuItem onClick={handlePasteButtonClick}>
                  <ImageIcon className="w-4 h-4 mr-2" />
                  Paste Image
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
          {/* 削除ボタン */}
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 text-destructive hover:text-destructive"
            onClick={onStopSession}
            title="セッションを削除"
          >
            <Trash2 className="w-5 h-5" />
          </Button>
        </div>
      </header>

      {/* タブバー */}
      {tabs.length > 1 && (
        <div className="flex items-center border-b border-border bg-muted/30 overflow-x-auto shrink-0">
          {tabs.map((tab, i) => {
            const isActive = i === activeTabIndex;
            const label =
              tab.type === "terminal"
                ? "Terminal"
                : tab.type === "file"
                  ? (tab.filePath.split("/").pop() ?? "File")
                  : new URL(tab.url).host;
            return (
              <div
                key={`${tab.type}-${i}`}
                className={`flex items-center gap-1 px-3 py-1.5 text-xs cursor-pointer border-r border-border whitespace-nowrap ${
                  isActive
                    ? "bg-background text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                }`}
                onClick={() => onTabSelect(i)}
              >
                <span>{label}</span>
                {tab.type !== "terminal" && (
                  <button
                    className="ml-1 hover:text-destructive"
                    onClick={e => {
                      e.stopPropagation();
                      onTabClose(i);
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ttyd iframe + スクロールモード時のオーバーレイ */}
      <div
        className="flex-1 min-h-0 bg-[#1a1b26] overflow-hidden relative"
        style={{
          display:
            tabs[activeTabIndex]?.type === "terminal" ? undefined : "none",
        }}
      >
        {session.ttydUrl || session.ttydPort ? (
          <>
            <iframe
              key={iframeKey}
              ref={iframeRef}
              src={ttydIframeSrc}
              className="w-full h-full border-0"
              title={`Terminal - ${worktree?.branch || session.id}`}
              allow="clipboard-read; clipboard-write; keyboard-map"
            />
            {/* スクロールモード中のみ表示されるスワイプ検出オーバーレイ */}
            {scrollMode && (
              <div
                className="absolute inset-0 bg-primary/5"
                style={{ touchAction: "none" }}
                onTouchStart={handleOverlayTouchStart}
                onTouchMove={handleOverlayTouchMove}
                onTouchEnd={handleOverlayTouchEnd}
                onTouchCancel={handleOverlayTouchEnd}
              />
            )}
          </>
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
      {tabs[activeTabIndex]?.type === "browser" &&
        (() => {
          const tab = tabs[activeTabIndex] as ViewerTab & { type: "browser" };
          return (
            <div className="flex-1 min-h-0">
              <BrowserPane url={tab.url} />
            </div>
          );
        })()}

      {/* 画像ペーストプレビュー */}
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
                onChange={e => setImageMessage(e.target.value)}
                placeholder="画像についてのメッセージ（任意）"
                className="min-h-[60px] resize-none text-sm"
                rows={2}
              />
            </div>
            {imageUploadError && (
              <p className="text-destructive text-xs mb-3">
                {imageUploadError}
              </p>
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

      {/* Quick Keys: スクロールモードトグル + ↑/↓/Esc/Ctrl+C/S-Tab 常時表示 */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-t border-border/50 bg-sidebar overflow-x-auto select-none">
        {/* スクロールモードトグル: ON=スワイプでスクロール、OFF=通常操作 */}
        <Button
          type="button"
          variant={scrollMode ? "default" : "ghost"}
          size="sm"
          className={`h-8 px-3 text-xs shrink-0 ${scrollMode ? "bg-primary text-primary-foreground" : ""}`}
          onClick={toggleScrollMode}
        >
          {scrollMode ? "Scroll ✓" : "Scroll"}
        </Button>
        {/* 区切り線 */}
        <div className="w-px h-5 bg-border/50 mx-1" />
        {/* 既存のQuick Keys */}
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
    </div>
  );
}
