/**
 * SplitChatPane - JSONL ベースの会話チャットビュー
 *
 * Claude Code が永続化する JSONL transcript を唯一の会話データソースとして
 * 描画する (assistant text は markdown レンダリング、user input は bubble、
 * tool call は軽量 chip)。**tmux 画面パースは行わない** (チャット UI v3 の
 * 設計原則。busy/AWAITING 等の状態は session:previews の bridgeStatus を使う)。
 *
 * 入力欄は最下部に固定 (layout="mobile" では本文の上に浮かぶガラスバー)。
 * 送信は tmux send-keys 経由 (onSendMessage)。
 * ファイルアップロード (D&D / ペースト / 選択) に対応。
 */

import type {
  BridgeSessionStatus,
  ClientToServerEvents,
  ManagedSession,
  ServerToClientEvents,
  SlashCommandInfo,
  SpecialKey,
} from "@ark/shared";
import { isImagePath, splitTextWithFilePaths } from "@ark/shared/file-paths";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  ChevronDown,
  ChevronRight,
  CircleQuestionMark,
  Download,
  ImageOff,
  Loader2,
  Paperclip,
  Scissors,
  Workflow,
  Wrench,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Socket } from "socket.io-client";
import { toast } from "sonner";
import { AskUserQuestionCard } from "@/components/AskUserQuestionCard";
import { MermaidBlock } from "@/components/MermaidBlock";
import { StatusChip } from "@/components/StatusChip";
import { fileToBase64, validateFile } from "@/hooks/useFileUpload";
import { useSessionJsonl } from "@/hooks/useSessionJsonl";
import { useSlashCommands } from "@/hooks/useSlashCommands";
import {
  type ActiveAuq,
  hasResolvedAuqSince,
  parseAuqInput,
} from "@/lib/ask-user-question-state";
import {
  groupSidechain,
  groupToolCalls,
  type ToolCallEvent,
} from "@/lib/chat-render-items";
import {
  FLOATING_BAR_BOTTOM,
  floatingBarReserve,
} from "@/lib/floating-composer";
import type { JsonlParsedEvent } from "@/lib/jsonl-event-parser";
import { splitTextWithUrls } from "@/lib/linkify";
import { isMermaidCodeClass } from "@/lib/mermaid-block-utils";
import { reconcileEscape } from "@/lib/reconcile-escape";
import { reconcilePending } from "@/lib/reconcile-pending";
import { buildVisualizeConversationPrompt } from "@/lib/visualize-conversation";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface SplitChatPaneProps {
  socket: TypedSocket | null;
  session: ManagedSession;
  /**
   * このペインが現在表示中か。false の間は JSONL を購読しない
   * (全セッションのペインが hidden マウントされるため、無条件購読だと
   * セッション数ぶんの tail が常時走ってしまう)
   */
  isActive: boolean;
  /**
   * session:previews 由来のセッション状態。capture-pane の existence
   * チェックのみで導出される (内容パースなし)。busy 表示と、permission
   * prompt 等の AWAITING フォールバックバナーに使う
   */
  bridgeStatus?: BridgeSessionStatus;
  /**
   * AWAITING 時の確認 UI 生テキスト (ANSI 除去済み画面末尾のミラー)。
   * 「何を聞かれているか」をバナーにそのまま表示する。構造のパースはしない
   */
  awaitingText?: string;
  onSendMessage: (message: string) => void;
  /** AskUserQuestion のキャンセル (Esc) 等で使用 */
  onSendKey: (key: SpecialKey) => void;
  /** ファイルアップロード。返値の path は `@path` で本文に挿入される */
  onUploadFile?: (data: {
    base64Data: string;
    mimeType: string;
    originalFilename?: string;
  }) => Promise<{ path: string; filename: string; originalFilename?: string }>;
  /**
   * "pane" = PC (入力欄は通常の配置)、"mobile" = 入力欄を浮かぶガラスバーにし、
   * 本文をその下に通す。既定は "pane"
   */
  layout?: "pane" | "mobile";
  /** layout="mobile" のとき、ガラスバーの上段 (入力欄の上) に置く要素 */
  composerAccessory?: ReactNode;
  /**
   * 質問カード (AskUserQuestion) の表示有無が変わったときに呼ぶ。
   * マウント時にも現在の値 (false) で1回呼ぶ。モバイルの状態の帯が文言の切り替えに使う。
   * アンマウント時には呼ばない。effectの依存に使うため、呼び出し側は安定した
   * 関数 (useCallback等) を渡すこと
   */
  onActiveAuqChange?: (hasActiveAuq: boolean) => void;
}

/** 入力欄の横の丸いアイコンボタン (添付・図解)。大きさはCOMPOSER_SIZEで足す */
const ROUND_ICON_BUTTON =
  "inline-flex shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50";

/**
 * 入力欄まわりの寸法と入力欄の地の色 (参照モック)。
 * PCは36pxで紙 (カードの上に一段沈める)、モバイルは指で押しやすい40pxで白
 */
const COMPOSER_SIZE = {
  pane: { button: "size-9", input: "min-h-9 py-[7px] bg-background" },
  mobile: { button: "size-10", input: "min-h-10 py-[9px] bg-card" },
} as const;

// ===== JSONL イベントカード =====

function UserInputCard({ text }: { text: string }) {
  return (
    <div className="flex justify-end px-4 pt-4 pb-2">
      <div className="max-w-[78%] whitespace-pre-wrap break-words rounded-xl rounded-br-[4px] bg-primary/14 px-3.5 py-2.5 text-[15px] leading-[1.6] text-foreground">
        {text}
      </div>
    </div>
  );
}

function PendingMessageCard({ text }: { text: string }) {
  return (
    <div className="flex justify-end px-4 pt-4 pb-2">
      <div className="flex max-w-[78%] items-start gap-2 whitespace-pre-wrap break-words rounded-xl rounded-br-[4px] bg-primary/14 px-3.5 py-2.5 text-[15px] leading-[1.6] text-foreground opacity-60">
        <Loader2
          role="img"
          aria-label="送信中"
          className="mt-1 size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
        />
        <span className="min-w-0">{text}</span>
      </div>
    </div>
  );
}

function SlashCommandCard({ name, args }: { name: string; args?: string }) {
  return (
    <div className="flex justify-end px-4 pt-4 pb-2">
      <div className="rounded-full bg-muted px-3 py-1 text-sm font-medium text-muted-foreground">
        {name}
        {args ? ` ${args}` : ""}
      </div>
    </div>
  );
}

/**
 * assistant text はモデル出力由来の信用できない Markdown。
 * - 画像はレンダリングしない (外部 URL の自動読込によるトラッキング/
 *   情報漏えいを防ぐ。alt テキストのプレースホルダ表示に置き換える)
 * - リンクは http/https のみ許可し、新規タブ + noopener noreferrer で開く
 */
// remarkFilePaths が検出パスを link ノード化する際に使う内部 sentinel scheme。
// 外部 URL として許可された scheme ではなく、`a` component 上書きで FileLink へ
// 振り替えるための内部マーカー。urlTransform は href を素通しさせるため許可する。
// 実際の配信可否はサーバ側の transcript allowlist が唯一の境界であり、sentinel が
// 任意パスを指していても allowlist 外なら 403 になる。
const INTERNAL_FILE_LINK_SCHEME = "ark-file:";

const MD_URL_TRANSFORM = (url: string): string =>
  /^(https?:|#|ark-file:)/i.test(url) ? url : "";

interface MarkdownNode {
  type?: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MarkdownNode[];
}

function remarkFilePaths() {
  return (tree: MarkdownNode) => {
    transformMarkdownFilePathText(tree);
  };
}

function transformMarkdownFilePathText(node: MarkdownNode): void {
  if (!node.children) return;
  const next: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      const segments = splitTextWithFilePaths(child.value);
      if (segments.some(seg => seg.type === "file")) {
        for (const seg of segments) {
          next.push(
            seg.type === "file"
              ? {
                  type: "link",
                  url: `${INTERNAL_FILE_LINK_SCHEME}${seg.value}`,
                  title: null,
                  children: [{ type: "text", value: seg.value }],
                }
              : { type: "text", value: seg.value }
          );
        }
      } else {
        next.push(child);
      }
      continue;
    }
    if (
      child.type !== "link" &&
      child.type !== "image" &&
      child.type !== "linkReference" &&
      child.type !== "definition"
    ) {
      transformMarkdownFilePathText(child);
    }
    next.push(child);
  }
  node.children = next;
}

function buildSessionFileUrl(
  sessionId: string,
  filePath: string,
  mode: "download" | "inline"
): string {
  const token =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("token");
  let url = `/api/session/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(filePath)}&mode=${mode}`;
  if (token) {
    url += `&token=${encodeURIComponent(token)}`;
  }
  return url;
}

function FileLink({
  sessionId,
  filePath,
  compact = false,
}: {
  sessionId: string;
  filePath: string;
  compact?: boolean;
}) {
  const [missing, setMissing] = useState(false);
  const downloadUrl = buildSessionFileUrl(sessionId, filePath, "download");

  if (compact || !isImagePath(filePath)) {
    return (
      <a
        href={downloadUrl}
        download
        className="break-all text-primary underline underline-offset-2"
      >
        {filePath}
      </a>
    );
  }

  const inlineUrl = buildSessionFileUrl(sessionId, filePath, "inline");
  return (
    <span className="my-2 inline-flex max-w-full flex-col gap-1 rounded-md border border-border bg-muted/30 p-2 align-top">
      {missing ? (
        <span className="flex min-h-20 max-w-full items-center justify-center rounded bg-muted px-3 py-6 text-sm text-muted-foreground">
          ファイルが見つかりません
        </span>
      ) : (
        <img
          src={inlineUrl}
          alt={filePath}
          loading="lazy"
          onError={() => setMissing(true)}
          className="max-h-[200px] max-w-full object-contain rounded bg-background"
        />
      )}
      <span className="flex min-w-0 items-center gap-2">
        <a
          href={downloadUrl}
          download
          className="inline-flex h-7 items-center gap-1 rounded border border-border bg-background px-2 text-xs text-foreground hover:bg-muted"
        >
          <Download className="h-3.5 w-3.5" />
          <span>DL</span>
        </a>
        <span className="min-w-0 break-all font-mono text-xs text-muted-foreground">
          {filePath}
        </span>
      </span>
    </span>
  );
}

function FilePathText({
  text,
  sessionId,
  compact = false,
}: {
  text: string;
  sessionId: string;
  compact?: boolean;
}) {
  return splitTextWithFilePaths(text).map((seg, i) =>
    seg.type === "file" ? (
      <FileLink
        // biome-ignore lint/suspicious/noArrayIndexKey: セグメント列は text から純粋導出され順序不変
        key={i}
        sessionId={sessionId}
        filePath={seg.value}
        compact={compact}
      />
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: 同上
      <span key={i}>{seg.value}</span>
    )
  );
}

function reactNodeToText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(reactNodeToText).join("");
  return "";
}

function createMarkdownComponents(sessionId: string): Components {
  return {
    img: ({ alt }) => (
      <span
        className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
        title="モデル出力由来の外部画像は自動表示しません"
      >
        <ImageOff aria-hidden="true" className="size-3.5 shrink-0" />
        {alt || "画像"}
      </span>
    ),
    a: ({ href, children }) => {
      if (href?.startsWith(INTERNAL_FILE_LINK_SCHEME)) {
        return (
          <FileLink
            sessionId={sessionId}
            filePath={href.slice(INTERNAL_FILE_LINK_SCHEME.length)}
          />
        );
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    },
    pre: ({ children, node: _node, ...props }) => {
      // mermaid ブロックは MermaidBlock 自身が描画するので pre を被せない
      const child = Array.isArray(children) ? children[0] : children;
      const cls =
        child && typeof child === "object" && "props" in child
          ? (child as { props?: { className?: string } }).props?.className
          : undefined;
      if (isMermaidCodeClass(cls)) return <>{children}</>;
      return <pre {...props}>{children}</pre>;
    },
    code: ({ className, children, node: _node, ...props }) => {
      if (isMermaidCodeClass(className)) {
        return <MermaidBlock code={reactNodeToText(children)} />;
      }
      return (
        <code className={className} {...props}>
          <FilePathText
            text={reactNodeToText(children)}
            sessionId={sessionId}
            compact
          />
        </code>
      );
    },
  };
}

function AssistantTextCard({
  text,
  sessionId,
}: {
  text: string;
  sessionId: string;
}) {
  const components = useMemo(
    () => createMarkdownComponents(sessionId),
    [sessionId]
  );
  return (
    <div className="px-4 py-2">
      <div className="md-prose text-[15px] text-foreground">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkFilePaths]}
          urlTransform={MD_URL_TRANSFORM}
          components={components}
        >
          {text}
        </ReactMarkdown>
      </div>
    </div>
  );
}

/** /compact 実行で会話が要約されたことを示すセパレータ */
function CompactMarkerCard() {
  return (
    <div className="flex items-center gap-3 px-6 py-3 select-none">
      <div className="flex-1 border-t border-dashed border-border" />
      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
        <Scissors aria-hidden="true" className="size-3" />
        会話を要約しました (/compact)
      </span>
      <div className="flex-1 border-t border-dashed border-border" />
    </div>
  );
}

/**
 * プレーンテキスト中の URL をクリック可能なリンクにして描画する。
 * リンク方針は assistant markdown と揃える (http/https のみ・新規タブ・noopener)。
 */
function Linkify({ text }: { text: string }) {
  return splitTextWithUrls(text).map((seg, i) =>
    seg.type === "url" ? (
      <a
        // biome-ignore lint/suspicious/noArrayIndexKey: セグメント列は text から純粋導出され順序不変
        key={i}
        href={seg.value}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all text-primary underline underline-offset-2"
      >
        {seg.value}
      </a>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: 同上
      <span key={i}>{seg.value}</span>
    )
  );
}

function AskUserQuestionResultCard({
  input,
  result,
  structuredResult,
  isError,
}: {
  input: Record<string, unknown>;
  result: string | undefined;
  structuredResult?: unknown;
  isError?: boolean;
}) {
  const questions =
    (input.questions as { question: string }[] | undefined) ?? [];
  // 回答の第一情報源は tool_result と同一レコードの toolUseResult
  // (構造化 JSON、自由入力の回答もそのまま入る)。取れない場合は
  // tool_result content の "Q"="A" テキストへフォールバックする。
  const answers = useMemo(() => {
    const map = new Map<string, string>();
    const structured = structuredResult as
      | { answers?: Record<string, unknown> }
      | undefined;
    if (
      structured &&
      typeof structured === "object" &&
      structured.answers &&
      typeof structured.answers === "object"
    ) {
      for (const [q, a] of Object.entries(structured.answers)) {
        if (typeof a === "string") map.set(q, a);
      }
      if (map.size > 0) return map;
    }
    if (!result) return map;
    const re = /"([^"]+)"="([^"]+)"/g;
    let m: RegExpExecArray | null;
    m = re.exec(result);
    while (m !== null) {
      map.set(m[1], m[2]);
      m = re.exec(result);
    }
    return map;
  }, [result, structuredResult]);
  const isDecline =
    isError === true || (result?.includes("User declined") ?? false);

  return (
    <div className="px-4 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-sm text-muted-foreground">
        <CircleQuestionMark aria-hidden="true" className="size-4 shrink-0" />
        <span className="font-medium">
          {result
            ? isDecline
              ? "質問はキャンセルされました"
              : "質問への回答"
            : "AskUserQuestion"}
        </span>
      </div>
      <div className="space-y-1 text-[15px]">
        {questions.map((q, i) => {
          const answer = answers.get(q.question);
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: 質問文だけでは重複時に key が衝突するため
              key={`${i}-${q.question}`}
              className="flex gap-1.5 items-start"
            >
              <span className="text-muted-foreground shrink-0">·</span>
              <div className="min-w-0 flex-1">
                <span className="text-foreground">
                  <Linkify text={q.question} />
                </span>
                {answer && (
                  <>
                    <span className="text-muted-foreground"> → </span>
                    <span className="font-medium text-primary">
                      <Linkify text={answer} />
                    </span>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 入力引数から1行サマリを取る: file_path / command / pattern / urlなど、最初に見つかった "らしい" 値 */
function summarizeToolInput(input: Record<string, unknown>): string {
  const keys = [
    "file_path",
    "command",
    "pattern",
    "query",
    "url",
    "path",
    "description",
    "prompt",
  ];
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string" && v.length > 0) {
      return v.length > 100 ? `${v.slice(0, 100)}…` : v;
    }
  }
  return "";
}

/** ツール呼び出し1件の1行表示 (ツール名 + 引数の要約) */
function ToolCallRow({
  tool,
  input,
  running = false,
}: {
  tool: string;
  input: Record<string, unknown>;
  /** 折りたたんだまとまりの下に出す「実行中の最新の1件」か */
  running?: boolean;
}) {
  const summary = useMemo(() => summarizeToolInput(input), [input]);
  return (
    <div className="inline-flex max-w-full items-center gap-2 text-xs text-muted-foreground">
      <Wrench
        aria-hidden="true"
        className={`size-3.5 shrink-0 ${running ? "text-status-busy" : "opacity-60"}`}
      />
      {running && <span className="sr-only">実行中:</span>}
      <span className="shrink-0 font-medium text-foreground">{tool}</span>
      {summary && (
        <span className="min-w-0 truncate font-mono opacity-70">{summary}</span>
      )}
    </div>
  );
}

function ToolCallCard({
  tool,
  input,
  result,
  structuredResult,
  isError,
}: {
  tool: string;
  input: Record<string, unknown>;
  result: string | undefined;
  structuredResult?: unknown;
  isError?: boolean;
}) {
  // AskUserQuestion は専用レンダリング
  if (tool === "AskUserQuestion") {
    return (
      <AskUserQuestionResultCard
        input={input}
        result={result}
        structuredResult={structuredResult}
        isError={isError}
      />
    );
  }

  return (
    <div className="px-4 py-1">
      <ToolCallRow tool={tool} input={input} />
    </div>
  );
}

/**
 * sidechainの外で連続するツール呼び出しの折りたたみ表示 (「作業N件」)。
 * 閉じているときは、実行中のまとまりに限りrunningのうち最新の1件を下に出す
 */
function ToolGroupCard({
  calls,
  latestRunning,
  expanded,
  onToggle,
  surfaceClassName,
}: {
  calls: ToolCallEvent[];
  latestRunning: ToolCallEvent | null;
  expanded: boolean;
  onToggle: () => void;
  /** 要約ボタンの背景。周りの面から1段ずらす */
  surfaceClassName: string;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div className="px-4 py-1.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={`inline-flex h-9 max-w-full items-center gap-2 rounded-sm border border-border pr-3 pl-2.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground ${surfaceClassName}`}
      >
        <Chevron aria-hidden="true" className="size-4 shrink-0" />
        <span className="font-semibold text-foreground">
          作業{calls.length}件
        </span>
      </button>
      {expanded ? (
        <div className="mt-1 border-l-2 border-border pl-3">
          {calls.map(call => (
            <div key={call.id} className="py-0.5">
              <ToolCallRow
                tool={call.tool}
                input={call.input}
                running={call.status === "running"}
              />
            </div>
          ))}
        </div>
      ) : (
        latestRunning && (
          <div className="mt-1 pl-1">
            <ToolCallRow
              tool={latestRunning.tool}
              input={latestRunning.input}
              running
            />
          </div>
        )
      )}
    </div>
  );
}

/**
 * AWAITING フォールバックのミニ操作パッド。
 *
 * hook 未注入セッション (AUQ カードが出ない) や permission prompt で、
 * ターミナルを開かずに確認 UI を操作する。確認 UI の生テキスト表示 +
 * キーパッド (数字ジャンプ/トグル・矢印・Space・Enter・Esc) +
 * 自由入力 (Type something 用 literal 送信)。
 * 画面の構造はパースしない: ユーザーが生テキストを読んでキーを選ぶ。
 */
function AwaitingPad({
  socket,
  sessionId,
  awaitingText,
  onSendKey,
}: {
  socket: TypedSocket | null;
  sessionId: string;
  awaitingText?: string;
  onSendKey: (key: SpecialKey) => void;
}) {
  const [freeText, setFreeText] = useState("");

  const submitFreeText = () => {
    const value = freeText;
    if (!value.trim() || !socket) return;
    // 「Type something」行にフォーカスした状態 (数字キーでジャンプ済み) で
    // literal 送信 → Enter で確定する。C-u は送らない (選択 UI 上の
    // 不要な端末操作になるため)。チャット入力欄の session:send を使わない
    // のも同じ理由 (C-u + 即 Enter が確認 UI を誤操作する)
    socket.emit("session:send-literal", { sessionId, text: value });
    setTimeout(() => onSendKey("Enter"), 250);
    setFreeText("");
  };

  const keyBtn = (label: string, key: SpecialKey, title: string) => (
    <button
      key={label}
      type="button"
      onClick={() => onSendKey(key)}
      className="rounded-sm border border-border bg-background px-2 py-0.5 font-mono text-xs transition-colors hover:bg-muted"
      title={title}
    >
      {label}
    </button>
  );

  return (
    <div className="rounded-lg border border-border bg-card px-4 pt-3.5 pb-3 shadow-card">
      <div className="flex min-w-0 items-center gap-2">
        <StatusChip statusKey="AWAITING" />
        <span className="min-w-0 text-[13px] font-semibold text-foreground">
          Claudeが入力を求めています
        </span>
      </div>
      {awaitingText && (
        <pre className="mt-2 overflow-x-auto whitespace-pre rounded-sm border border-border bg-muted/50 px-2.5 py-2 font-mono text-[11px] leading-[1.5] text-foreground/80">
          {awaitingText}
        </pre>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {(["1", "2", "3", "4", "5", "6"] as const).map(d =>
          keyBtn(d, d, `${d}を送信 (選択肢ジャンプ/トグル)`)
        )}
        <span className="w-2" />
        {keyBtn("↑", "Up", "フォーカスを上へ")}
        {keyBtn("↓", "Down", "フォーカスを下へ")}
        {keyBtn("→", "Right", "次のタブ / Submitへ")}
        {keyBtn("Space", "Space", "チェックをトグル")}
        {keyBtn("Enter", "Enter", "フォーカス中の項目を選択/確定")}
        {keyBtn("Esc", "Escape", "キャンセル")}
      </div>
      <div className="mt-2 flex items-center gap-2 rounded-full border border-border bg-background py-1 pr-1 pl-3 focus-within:border-primary">
        <input
          type="text"
          value={freeText}
          onChange={e => setFreeText(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submitFreeText();
            }
          }}
          aria-label="自由入力"
          placeholder="自由入力: 先にType somethingの番号を押してから入力 (Enterで確定)"
          className="min-w-0 flex-1 bg-transparent py-0.5 text-[13px] placeholder:text-muted-foreground focus:outline-none"
        />
        <button
          type="button"
          onClick={submitFreeText}
          disabled={!freeText.trim()}
          className="shrink-0 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-30"
        >
          入力して確定
        </button>
      </div>
    </div>
  );
}

/**
 * subagent (isSidechain) の連続イベントを 1 ブロックに集約した折りたたみ表示。
 * 大量のツール呼び出しがメイン会話を埋めないようにする。
 */
function SidechainGroupCard({
  events,
  sessionId,
}: {
  events: JsonlParsedEvent[];
  sessionId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div className="px-4 py-1">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <Chevron aria-hidden="true" className="size-3.5 shrink-0" />
        <Bot aria-hidden="true" className="size-3.5 shrink-0" />
        <span>サブエージェント ({events.length}件)</span>
      </button>
      {expanded && (
        <div className="mt-1 border-l-2 border-border pl-2 opacity-80">
          {events.map(ev => (
            <EventCard key={ev.id} event={ev} sessionId={sessionId} />
          ))}
        </div>
      )}
    </div>
  );
}

function EventCard({
  event,
  sessionId,
}: {
  event: JsonlParsedEvent;
  sessionId: string;
}) {
  switch (event.kind) {
    case "user-input":
      return <UserInputCard text={event.text} />;
    case "slash-command":
      return <SlashCommandCard name={event.name} args={event.args} />;
    case "assistant-text":
      return <AssistantTextCard text={event.text} sessionId={sessionId} />;
    case "compact-marker":
      return <CompactMarkerCard />;
    case "tool-call":
      // 回答待ちの AskUserQuestion は入力欄上のアクティブカード
      // (AskUserQuestionCard) が担当するので履歴側には出さない。
      // tool_result が来て done になったら回答済みカードとして表示する
      if (
        event.tool === "AskUserQuestion" &&
        event.status === "running" &&
        event.isSidechain !== true
      ) {
        return null;
      }
      return (
        <ToolCallCard
          tool={event.tool}
          input={event.input}
          result={event.result}
          structuredResult={event.structuredResult}
          isError={event.isError}
        />
      );
    case "thinking":
      return null;
    default:
      return null;
  }
}

/**
 * 要素の高さ (px) をResizeObserverで追う。enabledがfalseの間は0。
 * ResizeObserverの無い環境 (jsdom等) では最初の1回だけ測る
 */
function useElementHeight(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean
): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) {
      setHeight(0);
      return;
    }
    const measure = () => setHeight(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, enabled]);
  return height;
}

// ===== 本体 =====

export function SplitChatPane({
  socket,
  session,
  isActive,
  bridgeStatus,
  awaitingText,
  onSendMessage,
  onSendKey,
  onUploadFile,
  layout = "pane",
  composerAccessory,
  onActiveAuqChange,
}: SplitChatPaneProps) {
  const [inputValue, setInputValue] = useState("");

  // JSONL: 会話の構造化履歴 (markdown レンダリング用)。アクティブ時のみ購読
  const { events, loadMore, hasMore } = useSessionJsonl(
    socket,
    isActive ? session.id : null
  );

  // Claude 処理中に送ったメッセージを即時表示するための pending state。
  // JSONL に同じテキストの user-input が現れたら自動で消える。
  const [pending, setPending] = useState<
    { id: string; text: string; sentAt: number }[]
  >([]);

  // events 更新のたびに pending を整理: マッチしたものを除去。ロジックは
  // テスト容易性のため reconcilePending に純粋関数として切り出してある。
  useEffect(() => {
    setPending(prev => reconcilePending(prev, events, Date.now()));
  }, [events]);

  // built-in slash command (/compact, /clear 等) は JSONL に user-input として
  // 記録されないため、ローカルで永続的に表示する slash-command イベントを保持する。
  const [localSlashCommands, setLocalSlashCommands] = useState<
    { id: string; name: string; args?: string; sentAt: number }[]
  >([]);

  // biome-ignore lint/correctness/useExhaustiveDependencies(session.id): セッション切替を検知して pending を破棄するための意図的な依存
  useEffect(() => {
    setPending([]);
    setLocalSlashCommands([]);
  }, [session.id]);

  // ===== Slash command 補完 =====
  const { commands: slashCommands } = useSlashCommands(
    socket,
    isActive ? session.id : null
  );
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const filteredSlashCommands = useMemo(() => {
    if (!slashOpen) return [];
    const q = inputValue.trim().toLowerCase();
    if (!q.startsWith("/")) return [];
    return slashCommands
      .filter(c => c.name.toLowerCase().startsWith(q))
      .slice(0, 8);
  }, [slashOpen, slashCommands, inputValue]);

  useEffect(() => {
    const firstLine = inputValue.split("\n")[0] ?? "";
    const shouldOpen = firstLine.startsWith("/");
    setSlashOpen(shouldOpen);
    if (shouldOpen) setSlashIndex(0);
  }, [inputValue]);

  const appendLocalSlashCommand = useCallback((name: string, args?: string) => {
    setLocalSlashCommands(prev => [
      ...prev,
      {
        id: `lsc:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        name,
        args,
        sentAt: Date.now(),
      },
    ]);
  }, []);

  const applySlashCommand = useCallback(
    (cmd: SlashCommandInfo) => {
      setSlashOpen(false);
      if (cmd.source === "built-in") {
        onSendMessage(cmd.name);
        appendLocalSlashCommand(cmd.name);
        setInputValue("");
        return;
      }
      setInputValue(prev => {
        const lines = prev.split("\n");
        lines[0] = `${cmd.name} `;
        return lines.join("\n");
      });
    },
    [onSendMessage, appendLocalSlashCommand]
  );

  // 入力値が built-in slash command と一致するか判定する
  const matchBuiltInSlashCommand = useCallback(
    (value: string): { name: string; args?: string } | null => {
      const firstLine = value.split("\n")[0]?.trim() ?? "";
      if (!firstLine.startsWith("/")) return null;
      const [head, ...rest] = firstLine.split(/\s+/);
      const cmd = slashCommands.find(
        c => c.source === "built-in" && c.name === head
      );
      if (!cmd) return null;
      const args = rest.join(" ").trim();
      return { name: cmd.name, args: args || undefined };
    },
    [slashCommands]
  );

  // 回答待ちの AskUserQuestion。
  // 表示開始 = PreToolUse hook 由来の session:auq イベント (対話版 claude は
  // AUQ の tool_use を回答確定まで JSONL に書かないため hook が唯一の情報源)。
  // カードを閉じる = JSONL に解決イベント (tool_use + tool_result) が出現。
  const [hookAuq, setHookAuq] = useState<{
    at: number;
    auq: ActiveAuq;
    /** hook 受信時の tmux 画面 (verbatim)。直前の文脈は JSONL に無いため */
    screen: string | null;
  } | null>(null);

  useEffect(() => {
    if (!socket) return;
    const handler = (data: {
      sessionId: string;
      at: number;
      questions: unknown;
      screen: string | null;
    }) => {
      if (data.sessionId !== session.id) return;
      const questions = parseAuqInput({ questions: data.questions });
      if (!questions) return;
      setHookAuq({
        at: data.at,
        auq: { toolUseId: `hook:${data.at}`, questions },
        screen: typeof data.screen === "string" ? data.screen : null,
      });
    };
    socket.on("session:auq", handler);
    return () => {
      socket.off("session:auq", handler);
    };
  }, [socket, session.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies(session.id): セッション切替を検知して回答待ちカードを破棄するための意図的な依存
  useEffect(() => {
    setHookAuq(null);
  }, [session.id]);

  // JSONL に解決イベント (回答/Esc 拒否) が書かれたらカードを閉じる
  useEffect(() => {
    if (!hookAuq) return;
    if (hasResolvedAuqSince(events, hookAuq.at)) setHookAuq(null);
  }, [events, hookAuq]);

  const activeAuq = hookAuq?.auq ?? null;

  // 質問カードの有無を親へ知らせる (モバイルの状態の帯が文言の切り替えに使う)
  const hasActiveAuq = activeAuq !== null;
  useEffect(() => {
    onActiveAuqChange?.(hasActiveAuq);
  }, [hasActiveAuq, onActiveAuqChange]);

  // 連続するsubagentイベントと、sidechainの外で連続するツール呼び出しを
  // それぞれ折りたたみのまとまりへ
  const renderItems = useMemo(
    () => groupToolCalls(groupSidechain(events)),
    [events]
  );

  // 「作業N件」の展開状態 (まとまりのidの集合)。カード内のstateにしないのは、
  // 非表示 (isActive=false) の間はuseSessionJsonlがeventsを空にしてカードが
  // アンマウントされるため。本体に持てば端末と会話を切り替えても開いたまま残る
  const [expandedToolGroups, setExpandedToolGroups] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const toggleToolGroup = useCallback((id: string) => {
    setExpandedToolGroups(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies(session.id): セッション切替を検知して展開状態を破棄するための意図的な依存
  useEffect(() => {
    setExpandedToolGroups(new Set());
  }, [session.id]);

  // 入力欄。会話エリアのクリックでここにフォーカスを移す
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ===== スクロール追従 + 上端で過去読み込み =====
  const jsonlScrollRef = useRef<HTMLDivElement>(null);
  // モバイルの浮かぶバー (と上に積んだカード) の高さ。本文の下端の余白に使う
  const isMobile = layout === "mobile";
  const floatingStackRef = useRef<HTMLDivElement>(null);
  const floatingStackHeight = useElementHeight(floatingStackRef, isMobile);
  const bottomReserve = isMobile
    ? floatingBarReserve(floatingStackHeight)
    : undefined;
  const [isNearBottom, setIsNearBottom] = useState(true);
  // 「過去読み込み中」を ref で持つ。同じスクロールイベントで多重発火させないため
  const loadingMoreRef = useRef(false);
  // 過去読み込み発火時の scrollHeight / scrollTop。受信後に新しい高さとの差を
  // 足してスクロール位置を視覚的に固定する
  const prevScrollMetricsRef = useRef<{ height: number; top: number } | null>(
    null
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies(events): イベント追加 (高さ変化) のたびに末尾追従スクロールを再実行するための意図的な依存
  // biome-ignore lint/correctness/useExhaustiveDependencies(expandedToolGroups): 「作業N件」の開閉 (高さ変化) のたびに末尾追従スクロールを再実行するための意図的な依存
  // biome-ignore lint/correctness/useExhaustiveDependencies(floatingStackHeight): モバイルで入力欄が伸びて本文の下端の余白が増えるたびに末尾追従スクロールを再実行するための意図的な依存
  useEffect(() => {
    const el = jsonlScrollRef.current;
    if (!el) return;
    // 過去読み込み直後はスクロール位置を保存値 + 高さ差分に補正 (視覚的に固定)
    if (prevScrollMetricsRef.current) {
      const { height, top } = prevScrollMetricsRef.current;
      const diff = el.scrollHeight - height;
      el.scrollTop = top + diff;
      prevScrollMetricsRef.current = null;
      loadingMoreRef.current = false;
      return;
    }
    if (isNearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [events, isNearBottom, expandedToolGroups, floatingStackHeight]);

  // 「下までジャンプ」ボタン用。一気に末尾へ飛ばす副作用ハンドラ。
  // isNearBottom も true にしておくことで以降の自動追従も復活する。
  const scrollToBottom = useCallback(() => {
    const el = jsonlScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setIsNearBottom(true);
  }, []);

  // 会話エリアのクリックで入力欄にフォーカスする。ただし
  //  - テキスト選択中 (ドラッグでコピー等) はフォーカスを奪わない
  //  - ボタン / リンク / 入力など操作要素のクリックは本来の挙動を優先する
  // (AskUserQuestion の選択肢ボタン、ファイルリンク、「最新へ」ボタン等)
  const handleConversationClick = useCallback((e: React.MouseEvent) => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    // e.target は Node 型保証がない (closest 非存在で例外になり得る) ため
    // Element であることを実行時に確認してから扱う
    const target = e.target;
    if (!(target instanceof Element)) return;
    // 操作要素・フォーカス可能要素のクリックは本来の挙動を優先する。
    // contenteditable は属性値 ("" / true / plaintext-only) を問わず拾う
    if (
      target.closest(
        "button, a, input, textarea, select, [role='button'], [role='link'], [tabindex], [contenteditable]"
      )
    ) {
      return;
    }
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const el = jsonlScrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      setIsNearBottom(distance < 100);
      // 上端に近づいたら過去履歴を自動ロード
      if (
        el.scrollTop < 200 &&
        hasMore &&
        !loadingMoreRef.current &&
        events.length > 0
      ) {
        loadingMoreRef.current = true;
        prevScrollMetricsRef.current = {
          height: el.scrollHeight,
          top: el.scrollTop,
        };
        loadMore();
      }
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [hasMore, loadMore, events.length]);

  // ===== 送信 =====
  // 直近に送信したテキストを保持する。Esc 押下時に Claude Code 本体と同じく
  // 「中断 + 入力欄に直前のテキストを復元」を再現するため。
  // 復元したら ref をクリアし、次の submit で上書きされる。
  const lastSubmittedRef = useRef<string>("");

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const value = inputValue.trim();
    if (!value) return;
    lastSubmittedRef.current = value;
    onSendMessage(value);
    // built-in slash command (/compact, /clear 等) は JSONL に user-input として
    // 記録されないため、pending bubble だと永遠に spinner が残る。
    // 代わりにローカル slash-command カードを即時追加する。
    const builtIn = matchBuiltInSlashCommand(value);
    if (builtIn) {
      appendLocalSlashCommand(builtIn.name, builtIn.args);
    } else {
      setPending(prev => [
        ...prev,
        {
          id: `p:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
          text: value,
          sentAt: Date.now(),
        },
      ]);
    }
    setInputValue("");
  };

  // 「会話を図解」: 現在の Claude セッションに会話の図解を依頼する。
  // 入力欄は触らず、図解プロンプトを送信して pending を楽観表示する
  // (返答の ```mermaid は MermaidBlock がインライン描画する)。
  const handleVisualizeConversation = () => {
    const prompt = buildVisualizeConversationPrompt();
    lastSubmittedRef.current = prompt;
    onSendMessage(prompt);
    setPending(prev => [
      ...prev,
      {
        id: `p:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        text: prompt,
        sentAt: Date.now(),
      },
    ]);
  };

  // ===== ファイルアップロード =====
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);
  const recentUploadsRef = useRef<Map<string, number>>(new Map());

  const uploadAndAppend = useCallback(
    async (files: File[]) => {
      if (!onUploadFile || files.length === 0) return;
      const now = Date.now();
      const DEDUP_MS = 5000;
      const dedup: File[] = [];
      for (const [k, ts] of recentUploadsRef.current) {
        if (now - ts > 60_000) recentUploadsRef.current.delete(k);
      }
      for (const f of files) {
        const key = `${f.name}|${f.size}|${f.type}|${f.lastModified}`;
        const last = recentUploadsRef.current.get(key) ?? 0;
        if (now - last < DEDUP_MS) continue;
        recentUploadsRef.current.set(key, now);
        dedup.push(f);
      }
      if (dedup.length === 0) return;
      setUploadingCount(c => c + dedup.length);
      try {
        for (const file of dedup) {
          const v = validateFile(file);
          if (!v.ok) {
            toast.error(v.reason ?? `${file.name}: 未対応のファイル`);
            continue;
          }
          try {
            const { base64, mimeType, filename } = await fileToBase64(file);
            const res = await onUploadFile({
              base64Data: base64,
              mimeType,
              originalFilename: filename,
            });
            setInputValue(prev => {
              const ref = `@${res.path}`;
              if (prev.includes(ref)) return prev;
              return prev.length === 0 || /\s$/.test(prev)
                ? `${prev}${ref} `
                : `${prev} ${ref} `;
            });
          } catch (err) {
            toast.error(
              `${file.name}: アップロード失敗 (${err instanceof Error ? err.message : String(err)})`
            );
          }
        }
      } finally {
        setUploadingCount(c => Math.max(0, c - dedup.length));
      }
    },
    [onUploadFile]
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (!onUploadFile) return;
      const collected: File[] = [];
      const seen = new Set<string>();
      const push = (f: File | null) => {
        if (!f) return;
        const key = `${f.name}|${f.size}|${f.type}`;
        if (seen.has(key)) return;
        seen.add(key);
        collected.push(f);
      };
      for (const f of Array.from(e.clipboardData.files)) push(f);
      for (const item of Array.from(e.clipboardData.items)) {
        if (item.kind === "file") push(item.getAsFile());
      }
      if (collected.length === 0) return;
      e.preventDefault();
      uploadAndAppend(collected);
    },
    [onUploadFile, uploadAndAppend]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (!onUploadFile) return;
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) uploadAndAppend(files);
    },
    [onUploadFile, uploadAndAppend]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen && filteredSlashCommands.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex(i => (i + 1) % filteredSlashCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex(
          i =>
            (i - 1 + filteredSlashCommands.length) %
            filteredSlashCommands.length
        );
        return;
      }
      if (
        (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) &&
        !e.nativeEvent.isComposing
      ) {
        e.preventDefault();
        const target = filteredSlashCommands[slashIndex];
        if (target) applySlashCommand(target);
        return;
      }
    }
    // Esc は Claude Code 本体と同じ挙動 (4 分岐) を reconcileEscape に委譲する。
    // 副作用 (setState / tmux 送信) はここで action 種別に応じて発火させる。
    if (e.key === "Escape" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const action = reconcileEscape({
        inputValue,
        slashOpen: slashOpen && filteredSlashCommands.length > 0,
        lastSubmitted: lastSubmittedRef.current,
      });
      if (action.kind === "close-slash") {
        setSlashOpen(false);
      } else if (action.kind === "clear-input") {
        setInputValue("");
      } else {
        onSendKey("Escape");
        if (action.restore !== null) {
          setInputValue(action.restore);
          lastSubmittedRef.current = "";
        }
        if (action.removePendingText !== null) {
          const norm = action.removePendingText.trim();
          setPending(prev => prev.filter(p => p.text.trim() !== norm));
        }
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit(e as unknown as FormEvent);
    }
  };

  // 補完候補。PCは入力欄の枠、モバイルは下部のスタックの上端に合わせて出す
  const slashMenu = slashOpen && filteredSlashCommands.length > 0 && (
    <div className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-lg border border-border bg-popover shadow-card">
      {filteredSlashCommands.map((cmd, i) => (
        <button
          type="button"
          key={cmd.name}
          onMouseDown={e => {
            e.preventDefault();
            applySlashCommand(cmd);
          }}
          onMouseEnter={() => setSlashIndex(i)}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
            i === slashIndex
              ? "bg-accent text-accent-foreground"
              : "hover:bg-muted/50"
          }`}
        >
          <span className="shrink-0 font-medium text-foreground">
            {cmd.name}
          </span>
          {cmd.description && (
            <span className="flex-1 truncate text-xs text-muted-foreground">
              {cmd.description}
            </span>
          )}
          {/* 種類は文言で見分ける。状態の色をカテゴリの色に転用しない */}
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {cmd.source}
          </span>
        </button>
      ))}
    </div>
  );

  const composerSize = COMPOSER_SIZE[layout];

  const composerForm = (
    <form
      onSubmit={handleSubmit}
      onDragEnter={e => {
        if (!onUploadFile) return;
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragOver={e => {
        if (!onUploadFile) return;
        e.preventDefault();
      }}
      onDragLeave={e => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setIsDragging(false);
      }}
      onDrop={handleDrop}
      className={`relative flex items-end gap-1.5 rounded-[20px] ${
        isDragging ? "ring-2 ring-primary/50" : ""
      }`}
    >
      {onUploadFile && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,application/pdf,text/*,.md,.json,.csv"
            className="hidden"
            onChange={e => {
              const files = Array.from(e.target.files ?? []);
              if (files.length > 0) uploadAndAppend(files);
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className={`${ROUND_ICON_BUTTON} ${composerSize.button}`}
            aria-label="ファイルを添付"
            title="ファイルを添付 (D&D・貼り付けも可)"
            disabled={uploadingCount > 0}
          >
            {uploadingCount > 0 ? (
              <Loader2 className="size-5 animate-spin motion-reduce:animate-none" />
            ) : (
              <Paperclip className="size-5" />
            )}
          </button>
        </>
      )}
      <button
        type="button"
        onClick={handleVisualizeConversation}
        className={`${ROUND_ICON_BUTTON} ${composerSize.button}`}
        aria-label="会話を図解"
        title="会話を図解 (Claudeにmermaid図で要約させる)"
      >
        <Workflow className="size-5" />
      </button>
      <textarea
        ref={inputRef}
        value={inputValue}
        onChange={e => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={onUploadFile ? handlePaste : undefined}
        aria-label="メッセージ"
        placeholder={
          isMobile
            ? "メッセージを入力"
            : onUploadFile
              ? "メッセージを入力 (Enterで送信、Shift+Enterで改行。画像はD&D・貼り付けも可)"
              : "メッセージを入力 (Enterで送信、Shift+Enterで改行)"
        }
        rows={1}
        className={`field-sizing-content max-h-32 min-w-0 flex-1 resize-none rounded-[20px] border border-border px-3.5 text-[15px] leading-[1.4] placeholder:text-muted-foreground focus:border-primary focus:outline-none ${composerSize.input}`}
      />
      <button
        type="submit"
        disabled={!inputValue.trim()}
        aria-label="送信"
        className={`inline-flex shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:cursor-not-allowed disabled:opacity-40 ${composerSize.button}`}
      >
        <ArrowUp className="size-5" />
      </button>
      {isDragging && onUploadFile && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[20px] border-2 border-dashed border-primary bg-background/90 text-sm font-medium text-primary">
          ここにドロップ
        </div>
      )}
    </form>
  );

  // permission prompt 等のユーザー判断待ちフォールバック。
  // AskUserQuestion は専用カードが出る (hook 経由) ため、カード表示中
  // は出さない。hook が取りこぼされた場合のセーフティネットも兼ねる
  const showAwaitingPad = bridgeStatus === "AWAITING" && !activeAuq;
  // 入力欄の上に固定で出すカード (質問カード / 確認待ちのキー操作)
  const dockedCard = activeAuq ? (
    <AskUserQuestionCard
      key={activeAuq.toolUseId}
      socket={socket}
      sessionId={session.id}
      auq={activeAuq}
      screenContext={hookAuq?.screen ?? null}
      onSendKey={onSendKey}
    />
  ) : showAwaitingPad ? (
    <AwaitingPad
      socket={socket}
      sessionId={session.id}
      awaitingText={awaitingText}
      onSendKey={onSendKey}
    />
  ) : null;

  return (
    <div className="relative flex h-full flex-col">
      {/* JSONL イベントリスト (上段、flex-1)。
          relative ラッパーで囲み「下へジャンプ」ボタンをスクロール領域に
          重ねて配置する。スクロール領域自体は absolute inset-0 で内側を埋める。 */}
      <div className="relative min-h-0 flex-1">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: クリックで入力欄にフォーカスを移すだけの補助操作。会話ログ自体は非対話要素のまま */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: キーボード利用者は Tab で入力欄 (textarea) に直接到達できるため、キーハンドラは不要 */}
        <div
          ref={jsonlScrollRef}
          onClick={handleConversationClick}
          className="absolute inset-0 overflow-y-auto"
        >
          <div
            data-testid="chat-scroll-content"
            className="mx-auto w-full max-w-[760px] py-2"
            style={bottomReserve ? { paddingBottom: bottomReserve } : undefined}
          >
            {events.length === 0 &&
            pending.length === 0 &&
            localSlashCommands.length === 0 ? (
              <div className="pt-8 text-center text-sm text-muted-foreground">
                このセッションの履歴はまだありません
              </div>
            ) : (
              <>
                {hasMore && (
                  <div className="flex justify-center py-2 text-sm text-muted-foreground">
                    読み込み中...
                  </div>
                )}
                {renderItems.map(item => {
                  if (item.kind === "sidechain") {
                    return (
                      <SidechainGroupCard
                        key={item.id}
                        events={item.events}
                        sessionId={session.id}
                      />
                    );
                  }
                  if (item.kind === "tool-group") {
                    return (
                      <ToolGroupCard
                        key={item.id}
                        calls={item.calls}
                        latestRunning={item.latestRunning}
                        expanded={expandedToolGroups.has(item.id)}
                        onToggle={() => toggleToolGroup(item.id)}
                        surfaceClassName={
                          isMobile ? "bg-card" : "bg-background"
                        }
                      />
                    );
                  }
                  return (
                    <EventCard
                      key={item.event.id}
                      event={item.event}
                      sessionId={session.id}
                    />
                  );
                })}
                {localSlashCommands.map(c => (
                  <SlashCommandCard key={c.id} name={c.name} args={c.args} />
                ))}
                {pending.map(p => (
                  <PendingMessageCard key={p.id} text={p.text} />
                ))}
              </>
            )}
          </div>
        </div>
        {!isNearBottom && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute left-1/2 z-10 flex size-9 -translate-x-1/2 items-center justify-center rounded-full bg-foreground/85 text-background shadow-card transition-colors hover:bg-foreground"
            style={{ bottom: bottomReserve ?? "12px" }}
            title="最新まで一気にスクロール"
            aria-label="最新まで一気にスクロール"
          >
            <ArrowDown className="size-4" />
          </button>
        )}
      </div>

      {isMobile ? (
        // カードとガラスバーを1つのスタックに積み、本文コンテナの下端から浮かせる。
        // ガラスはバーだけに使い、カードは不透明のまま上に置く
        <div
          ref={floatingStackRef}
          data-testid="floating-composer"
          className="absolute inset-x-3 z-10 flex max-h-[70%] flex-col gap-2"
          style={{ bottom: FLOATING_BAR_BOTTOM }}
        >
          {slashMenu}
          {dockedCard && (
            <div className="-mx-1 min-h-0 overflow-y-auto px-1 pb-2">
              {dockedCard}
            </div>
          )}
          {/* data-mobile-bottom-bar: Task 12の検証スクリプトが下部バーの位置を測る目印
              (端末・図モードのバーにはTask 10が付ける) */}
          <div
            data-mobile-bottom-bar=""
            className="glass-bar flex shrink-0 flex-col gap-2 rounded-[28px] p-2"
          >
            {composerAccessory}
            {composerForm}
          </div>
        </div>
      ) : (
        <>
          {dockedCard && (
            <div className="max-h-[45%] shrink-0 overflow-y-auto px-4 pt-2 pb-3">
              <div className="mx-auto w-full max-w-[760px]">{dockedCard}</div>
            </div>
          )}
          <div className="shrink-0 border-t border-border px-4 pt-3 pb-3.5">
            <div className="relative mx-auto w-full max-w-[792px]">
              {slashMenu}
              {composerForm}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
