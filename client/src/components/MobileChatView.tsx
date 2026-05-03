/**
 * MobileChatView - Beaconチャット用ビュー
 *
 * ターミナル/CRT風の美学を活かした、コマンドセンター感のあるチャットUI。
 * マークダウンレンダリング、インタラクティブな選択肢ボタン、
 * ストリーミング表示、クイックコマンドを提供する。
 */

import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Radar,
  Send,
  Terminal,
  Trash2,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { ChatMessage, UsageProgress } from "../../../shared/types";
import { useComposition } from "../hooks/useComposition";
import { useVisualViewport } from "../hooks/useVisualViewport";

// --- 型定義 ---

interface MobileChatViewProps {
  /** チャット履歴メッセージ */
  messages: ChatMessage[];
  /** ストリーミング中かどうか */
  isStreaming: boolean;
  /** ストリーミング中の部分テキスト */
  streamingText: string;
  /** メッセージ送信コールバック */
  onSendMessage: (message: string) => void;
  /** 戻るボタンコールバック */
  onBack?: () => void;
  /** チャットクリアコールバック */
  onClear?: () => void;
  /** Usage取得（Linux + multiProfileSupported のみ表示） */
  onRequestUsage?: () => void;
  /** Usage取得中フラグ（ボタンdisable + ローディング） */
  usageRequesting?: boolean;
  /** Usage取得進捗（取得中のみ非null） */
  usageProgress?: UsageProgress | null;
  /** プロファイル機能が有効か（falseならUsageボタン非表示） */
  multiProfileSupported?: boolean;
  /** MCP server マネージャを開く */
  onOpenMcpManager?: () => void;
}

/** クイックコマンドの定義 */
type QuickCommand =
  | { kind?: "send"; label: string; message: string }
  | { kind: "usage"; label: string }
  | { kind: "mcp"; label: string };

/** パース済みマークダウンの各セグメント */
type MarkdownSegment =
  | { type: "text"; content: string }
  | { type: "bold"; content: string }
  | { type: "link"; url: string }
  | { type: "code-inline"; content: string }
  | { type: "code-block"; lang: string; content: string }
  | { type: "list-item"; children: MarkdownSegment[] }
  | { type: "heading"; level: number; children: MarkdownSegment[] }
  | {
      type: "numbered-item";
      number: number;
      children: MarkdownSegment[];
      plainText: string;
    }
  | {
      type: "checkbox-item";
      checked: boolean;
      children: MarkdownSegment[];
      plainText: string;
    }
  | { type: "break" };

// --- クイックコマンド定義 ---

const QUICK_COMMANDS: QuickCommand[] = [
  { label: "進捗確認", message: "進捗確認" },
  { label: "判断", message: "判断" },
  { label: "タスク着手", message: "タスク着手" },
  { label: "PR URL", message: "PR URL" },
  { kind: "usage", label: "Usage" },
  { kind: "mcp", label: "MCP" },
];

// --- 簡易マークダウンパーサー ---

function parseMarkdown(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parseInlineSegments(text.slice(lastIndex, match.index), segments);
    }
    segments.push({
      type: "code-block",
      lang: match[1] || "",
      content: match[2].trimEnd(),
    });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parseInlineSegments(text.slice(lastIndex), segments);
  }

  return segments;
}

/** 1行のインライン要素をパース */
function parseInline(line: string): MarkdownSegment[] {
  const result: MarkdownSegment[] = [];
  const inlineRegex = /(\*\*(.+?)\*\*|`([^`\n]+)`|(https?:\/\/[^\s)]+))/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = inlineRegex.exec(line)) !== null) {
    if (m.index > lastIndex) {
      result.push({ type: "text", content: line.slice(lastIndex, m.index) });
    }
    if (m[2]) {
      result.push({ type: "bold", content: m[2] });
    } else if (m[3]) {
      result.push({ type: "code-inline", content: m[3] });
    } else if (m[4]) {
      result.push({ type: "link", url: m[4] });
    }
    lastIndex = m.index + m[0].length;
  }

  if (lastIndex < line.length) {
    result.push({ type: "text", content: line.slice(lastIndex) });
  }
  return result;
}

/** ブロック要素をパース */
function parseInlineSegments(text: string, segments: MarkdownSegment[]): void {
  const lines = text.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      segments.push({
        type: "heading",
        level: headingMatch[1].length,
        children: parseInline(headingMatch[2]),
      });
    } else if (/^[-*]\s+\[([ xX])\]\s+(.+)$/.test(line)) {
      const cbMatch = line.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
      if (cbMatch) {
        const children = parseInline(cbMatch[2]);
        const plainText = cbMatch[2]
          .replace(/\*\*(.+?)\*\*/g, "$1")
          .replace(/`([^`]+)`/g, "$1");
        segments.push({
          type: "checkbox-item",
          checked: cbMatch[1] !== " ",
          children,
          plainText,
        });
      }
    } else if (/^\d+[.)]\s+(.+)$/.test(line)) {
      const numMatch = line.match(/^(\d+)[.)]\s+(.+)$/);
      if (numMatch) {
        const children = parseInline(numMatch[2]);
        const plainText = numMatch[2]
          .replace(/\*\*(.+?)\*\*/g, "$1")
          .replace(/`([^`]+)`/g, "$1");
        segments.push({
          type: "numbered-item",
          number: parseInt(numMatch[1], 10),
          children,
          plainText,
        });
      }
    } else if (/^[-*]\s+(.+)$/.test(line)) {
      const content = line.replace(/^[-*]\s+/, "");
      segments.push({ type: "list-item", children: parseInline(content) });
    } else {
      segments.push(...parseInline(line));
    }

    // 同種リスト項目の連続のみbrスキップ
    if (i < lines.length - 1) {
      const nextLine = lines[i + 1];
      const listPattern = /^[-*]\s/;
      const numberedPattern = /^\d+[.)]\s/;
      const isList = listPattern.test(line);
      const isNumbered = numberedPattern.test(line);
      const nextIsList = listPattern.test(nextLine);
      const nextIsNumbered = numberedPattern.test(nextLine);
      const skipBreak =
        (isList && nextIsList) || (isNumbered && nextIsNumbered);
      if (!skipBreak) {
        segments.push({ type: "break" });
      }
    }
  }
}

/** セグメント配列をReact要素にレンダリング */
function renderSegments(
  segments: MarkdownSegment[],
  onAction?: (text: string) => void
): ReactNode[] {
  return segments.map((seg, i) => {
    const key = `${seg.type}-${i}-${
      "content" in seg && seg.content ? seg.content.slice(0, 10) : ""
    }`;
    switch (seg.type) {
      case "text":
        return <span key={key}>{seg.content}</span>;
      case "bold":
        return (
          <strong key={key} className="text-foreground font-semibold">
            {seg.content}
          </strong>
        );
      case "link":
        return (
          <a
            key={key}
            href={seg.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2 hover:text-primary/80 break-all"
          >
            {seg.url}
          </a>
        );
      case "code-inline":
        return (
          <code
            key={key}
            className="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-[13px] font-mono"
          >
            {seg.content}
          </code>
        );
      case "code-block":
        return (
          <pre
            key={key}
            className="bg-background/80 rounded-md p-3 my-2 overflow-x-auto text-xs font-mono whitespace-pre-wrap break-words border border-border/40"
          >
            {seg.lang && (
              <span className="text-primary/60 text-[10px] font-mono uppercase tracking-wider block mb-1.5">
                {seg.lang}
              </span>
            )}
            <code className="text-foreground/90">{seg.content}</code>
          </pre>
        );
      case "heading":
        return (
          <div
            key={key}
            className={`font-semibold mt-3 mb-1 tracking-tight ${seg.level <= 2 ? "text-[15px] text-foreground" : "text-sm text-foreground/90"}`}
          >
            {renderSegments(seg.children, onAction)}
          </div>
        );
      case "list-item":
        return (
          <ul key={key} className="list-disc ml-4">
            <li className="my-0.5">{renderSegments(seg.children, onAction)}</li>
          </ul>
        );
      case "numbered-item":
        return (
          <button
            key={key}
            type="button"
            className="group flex items-center gap-2.5 w-full text-left my-0.5 px-3 py-2.5 rounded-lg border border-border/40 bg-card/50 hover:bg-primary/5 hover:border-primary/30 active:bg-primary/10 text-sm transition-all min-h-[44px]"
            onClick={() => onAction?.(seg.plainText)}
          >
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary/15 text-primary text-xs font-mono font-bold shrink-0 group-hover:bg-primary/25 transition-colors">
              {seg.number}
            </span>
            <span className="flex-1">
              {renderSegments(seg.children, onAction)}
            </span>
          </button>
        );
      case "checkbox-item":
        return (
          <button
            type="button"
            key={key}
            className="group flex items-center gap-2.5 w-full text-left my-0.5 px-3 py-2.5 rounded-lg border border-border/40 bg-card/50 hover:bg-primary/5 hover:border-primary/30 active:bg-primary/10 text-sm transition-all min-h-[44px]"
            onClick={() => onAction?.(seg.plainText)}
          >
            <span
              className={`inline-flex items-center justify-center w-4 h-4 rounded border transition-colors ${seg.checked ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/40 group-hover:border-primary/50"}`}
            >
              {seg.checked && <span className="text-[10px] font-bold">✓</span>}
            </span>
            <span className="flex-1">
              {renderSegments(seg.children, onAction)}
            </span>
          </button>
        );
      case "break":
        return <div key={key} className="h-2" />;
      default:
        return null;
    }
  });
}

// --- サブコンポーネント ---

/** ユーザーメッセージバブル */
function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end px-4 py-0.5">
      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-4 py-2.5 text-sm leading-normal break-words font-medium shadow-sm shadow-primary/20">
        {content}
      </div>
    </div>
  );
}

/** アシスタントメッセージバブル */
function AssistantBubble({
  content,
  onAction,
}: {
  content: string;
  onAction?: (text: string) => void;
}) {
  const segments = useMemo(() => parseMarkdown(content), [content]);
  const rendered = useMemo(
    () => renderSegments(segments, onAction),
    [segments, onAction]
  );
  return (
    <div className="flex justify-start px-4 py-0.5">
      <div className="max-w-[88%] rounded-2xl rounded-bl-sm bg-card border border-border/30 px-4 py-3 text-sm leading-normal break-words">
        {rendered}
      </div>
    </div>
  );
}

/** ツール使用の折りたたみ表示 */
function ToolUseBlock({
  toolName,
  input,
  result,
}: {
  toolName: string;
  input: string;
  result?: string;
}) {
  return (
    <div className="px-4 py-0.5">
      <Collapsible>
        <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors group w-full py-1">
          <ChevronRight className="w-3.5 h-3.5 transition-transform group-data-[state=open]:rotate-90" />
          <Terminal className="w-3.5 h-3.5" />
          <span className="font-mono font-medium">{toolName}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-1 ml-5 rounded-lg border border-border/30 bg-background/60 overflow-hidden">
            <div className="px-3 py-2 font-mono text-xs text-muted-foreground whitespace-pre-wrap break-words">
              {input}
            </div>
            {result && (
              <>
                <div className="border-t border-border/20" />
                <div className="px-3 py-2 font-mono text-xs text-foreground/80 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                  {result}
                </div>
              </>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/** ストリーミング中の表示 */
function StreamingBubble({ text }: { text: string }) {
  const segments = useMemo(() => (text ? parseMarkdown(text) : []), [text]);
  const rendered = useMemo(() => renderSegments(segments), [segments]);
  return (
    <div className="flex justify-start px-4 py-0.5">
      <div className="max-w-[88%] min-w-[60px] rounded-2xl rounded-bl-sm bg-card border border-border/30 px-4 py-3 text-sm leading-normal break-words">
        {text ? rendered : null}
        <span className="inline-flex items-center gap-1 ml-1.5 align-middle">
          <span className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-[beacon-dot_1.4s_ease-in-out_infinite]" />
          <span className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-[beacon-dot_1.4s_ease-in-out_infinite_0.2s]" />
          <span className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-[beacon-dot_1.4s_ease-in-out_infinite_0.4s]" />
        </span>
      </div>
    </div>
  );
}

/** 空状態の表示 */
function EmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-8 text-center">
      <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-5">
        <Radar className="w-8 h-8 text-primary/70" />
      </div>
      <p className="text-foreground/80 text-sm font-medium">Beacon</p>
      <p className="text-muted-foreground text-xs mt-1.5 max-w-[240px] leading-relaxed">
        セッションの進捗確認やworktree管理をここから行えます
      </p>
    </div>
  );
}

// --- メインコンポーネント ---

export function MobileChatView({
  messages,
  isStreaming,
  streamingText,
  onSendMessage,
  onBack,
  onClear,
  onRequestUsage,
  usageRequesting = false,
  usageProgress = null,
  multiProfileSupported = false,
  onOpenMcpManager,
}: MobileChatViewProps) {
  const { height: viewportHeight, isKeyboardVisible } = useVisualViewport();
  const [inputValue, setInputValue] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // IME対応
  const composition = useComposition<HTMLInputElement>({
    onKeyDown: e => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
  });

  const handleSend = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed || isStreaming) return;
    isNearBottom.current = true;
    onSendMessage(trimmed);
    setInputValue("");
  }, [inputValue, isStreaming, onSendMessage]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      handleSend();
    },
    [handleSend]
  );

  const handleQuickCommand = useCallback(
    (message: string) => {
      if (isStreaming) return;
      isNearBottom.current = true;
      onSendMessage(message);
    },
    [isStreaming, onSendMessage]
  );

  // 選択肢（番号付きリスト）タップ時のハンドラー
  const handleAction = useCallback(
    (message: string) => {
      isNearBottom.current = true;
      onSendMessage(message);
    },
    [onSendMessage]
  );

  // 自動スクロール（ユーザーが上にスクロール中は抑制）
  const isNearBottom = useRef(true);
  const handleScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    isNearBottom.current =
      el.scrollTop + el.clientHeight >= el.scrollHeight - 80;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: メッセージ到着時に自動スクロールする意図的な依存配列
  useEffect(() => {
    if (isNearBottom.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, streamingText]);

  const isInputDisabled = isStreaming;
  const hasMessages = messages.length > 0 || isStreaming;

  return (
    <div
      className="h-full flex flex-col min-h-0 safe-area-x"
      style={
        isKeyboardVisible
          ? { height: `${viewportHeight}px`, maxHeight: `${viewportHeight}px` }
          : undefined
      }
    >
      {/* ヘッダー */}
      <header className="h-14 border-b border-border/50 flex items-center justify-between px-3 bg-sidebar shrink-0 safe-area-top">
        <div className="flex items-center gap-2 min-w-0">
          {onBack && (
            <Button
              variant="ghost"
              size="icon"
              className="h-10 w-10 shrink-0"
              onClick={onBack}
            >
              <ChevronLeft className="w-5 h-5" />
            </Button>
          )}
          <div className="flex items-center gap-2">
            <Radar className="w-4 h-4 text-primary/70" />
            <span className="font-semibold text-sm tracking-tight">Beacon</span>
          </div>
        </div>
        {onClear && messages.length > 0 && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-destructive/50 hover:text-destructive hover:bg-destructive/10"
            onClick={onClear}
            disabled={isStreaming}
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        )}
      </header>

      {/* メッセージエリア */}
      <div
        ref={messagesContainerRef}
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
        onScroll={handleScroll}
      >
        {hasMessages ? (
          <div className="py-3">
            {messages.map((msg, idx) => (
              <div
                key={msg.id}
                className={
                  idx > 0 && messages[idx - 1].role !== msg.role
                    ? "mt-4"
                    : "mt-1"
                }
              >
                {msg.role === "user" ? (
                  <UserBubble content={msg.content} />
                ) : (
                  <AssistantBubble
                    content={msg.content}
                    onAction={handleAction}
                  />
                )}
                {msg.toolUse && (
                  <ToolUseBlock
                    toolName={msg.toolUse.toolName}
                    input={msg.toolUse.input}
                    result={msg.toolUse.result}
                  />
                )}
              </div>
            ))}
            {isStreaming && (
              <div className="mt-1">
                <StreamingBubble text={streamingText} />
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        ) : (
          <EmptyState />
        )}
      </div>

      {/* クイックコマンド */}
      {QUICK_COMMANDS.length > 0 && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-t border-border/30 bg-sidebar overflow-x-auto select-none scrollbar-none">
          {QUICK_COMMANDS.map(cmd => {
            // Usageボタン: multiProfileSupported のときのみ表示
            if (cmd.kind === "usage") {
              if (!multiProfileSupported || !onRequestUsage) return null;
              // 進捗中のラベル: 「取得中 (1/2 personal)」のように表示。
              // completed=N (=total) は最後の取得完了直後にのみ届くため、
              // ここでは「処理中の index = completed + 1」で表示する
              const currentIdx = usageProgress
                ? Math.min(usageProgress.completed + 1, usageProgress.total)
                : 0;
              const progressLabel = usageProgress
                ? `${currentIdx}/${usageProgress.total} ${usageProgress.currentProfileName}`
                : "取得中";
              // Beacon streaming 中でも Usage は実行可能 (server側で
              // beacon:external-message を queue 制御し streaming を阻害しない)
              return (
                <Button
                  key={cmd.label}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-3 text-xs shrink-0 rounded-full border-border/50 text-muted-foreground hover:text-primary hover:border-primary/40 transition-colors"
                  disabled={usageRequesting}
                  onClick={onRequestUsage}
                >
                  {usageRequesting ? (
                    <>
                      <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                      {progressLabel}
                    </>
                  ) : (
                    cmd.label
                  )}
                </Button>
              );
            }
            // MCP server マネージャを開くボタン
            if (cmd.kind === "mcp") {
              if (!onOpenMcpManager) return null;
              return (
                <Button
                  key={cmd.label}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-3 text-xs shrink-0 rounded-full border-border/50 text-muted-foreground hover:text-primary hover:border-primary/40 transition-colors"
                  onClick={onOpenMcpManager}
                >
                  {cmd.label}
                </Button>
              );
            }
            return (
              <Button
                key={cmd.label}
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-3 text-xs shrink-0 rounded-full border-border/50 text-muted-foreground hover:text-primary hover:border-primary/40 transition-colors"
                disabled={isInputDisabled}
                onClick={() => handleQuickCommand(cmd.message)}
              >
                {cmd.label}
              </Button>
            );
          })}
        </div>
      )}

      {/* 入力バー */}
      <form
        onSubmit={handleSubmit}
        className="px-3 pt-2.5 pb-4 border-t border-border/50 bg-sidebar safe-area-bottom"
      >
        <div className="flex gap-2 items-center">
          <div className="flex-1 relative">
            <input
              ref={inputRef}
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              onKeyDown={composition.onKeyDown}
              onCompositionStart={composition.onCompositionStart}
              onCompositionEnd={composition.onCompositionEnd}
              enterKeyHint="send"
              placeholder="メッセージを入力..."
              disabled={isStreaming}
              className="w-full h-11 bg-input border border-border/50 rounded-xl px-4 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 transition-all disabled:opacity-50"
            />
          </div>
          <Button
            type="submit"
            size="icon"
            className="h-11 w-11 shrink-0 rounded-xl shadow-sm shadow-primary/20"
            disabled={isInputDisabled || !inputValue.trim()}
          >
            {isStreaming ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Send className="w-5 h-5" />
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}
