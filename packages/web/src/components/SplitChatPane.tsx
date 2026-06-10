/**
 * SplitChatPane - JSONL ベースの会話チャットビュー
 *
 * Claude Code が永続化する JSONL transcript を唯一の会話データソースとして
 * 描画する (assistant text は markdown レンダリング、user input は bubble、
 * tool call は軽量 chip)。**tmux 画面パースは行わない** (チャット UI v3 の
 * 設計原則。busy/AWAITING 等の状態は session:previews の bridgeStatus を使う)。
 *
 * 入力欄は最下部に固定。送信は tmux send-keys 経由 (onSendMessage)。
 * ファイルアップロード (D&D / ペースト / 選択) に対応。
 */

import type {
  BridgeSessionStatus,
  ClientToServerEvents,
  ManagedSession,
  ServerToClientEvents,
  SpecialKey,
} from "@ark/shared";
import { ArrowDown, Loader2, Paperclip, Send } from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Socket } from "socket.io-client";
import { toast } from "sonner";
import { AskUserQuestionCard } from "@/components/AskUserQuestionCard";
import { Button } from "@/components/ui/button";
import { fileToBase64, validateFile } from "@/hooks/useFileUpload";
import { useSessionJsonl } from "@/hooks/useSessionJsonl";
import {
  type ActiveAuq,
  hasResolvedAuqSince,
  parseAuqInput,
} from "@/lib/ask-user-question-state";
import type { JsonlParsedEvent } from "@/lib/jsonl-event-parser";
import { reconcileEscape } from "@/lib/reconcile-escape";
import { reconcilePending } from "@/lib/reconcile-pending";

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
  onSendMessage: (message: string) => void;
  /** AskUserQuestion のキャンセル (Esc) 等で使用 */
  onSendKey: (key: SpecialKey) => void;
  /** ファイルアップロード。返値の path は `@path` で本文に挿入される */
  onUploadFile?: (data: {
    base64Data: string;
    mimeType: string;
    originalFilename?: string;
  }) => Promise<{ path: string; filename: string; originalFilename?: string }>;
  /** 右側 ttyd の表示状態 (ヘッダのトグルボタンを ON/OFF 表示するために使う) */
  showTerminal?: boolean;
  /** ターミナルの表示切替 (undefined のとき トグルボタンを描画しない) */
  onToggleTerminal?: () => void;
}

// ===== JSONL イベントカード =====

function UserInputCard({ text }: { text: string }) {
  return (
    <div className="flex justify-end px-4 pt-4 pb-2">
      <div className="max-w-[85%] bg-primary text-primary-foreground rounded-2xl rounded-tr-md px-4 py-2.5 text-[16px] leading-relaxed whitespace-pre-wrap break-words shadow-sm">
        {text}
      </div>
    </div>
  );
}

function PendingMessageCard({ text }: { text: string }) {
  return (
    <div className="flex justify-end px-4 pt-4 pb-2">
      <div className="max-w-[85%] bg-primary/70 text-primary-foreground rounded-2xl rounded-tr-md px-4 py-2.5 text-[16px] leading-relaxed whitespace-pre-wrap break-words shadow-sm flex items-start gap-2">
        <Loader2 className="w-3.5 h-3.5 animate-spin mt-1 shrink-0 opacity-80" />
        <span className="min-w-0">{text}</span>
      </div>
    </div>
  );
}

function SlashCommandCard({ name, args }: { name: string; args?: string }) {
  return (
    <div className="flex justify-end px-4 pt-4 pb-2">
      <div className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 rounded-full px-3 py-1 text-sm font-mono">
        {name}
        {args ? ` ${args}` : ""}
      </div>
    </div>
  );
}

function AssistantTextCard({ text }: { text: string }) {
  return (
    <div className="px-4 py-2">
      <div className="md-prose text-[16px] text-foreground leading-[1.65]">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    </div>
  );
}

/** /compact 実行で会話が要約されたことを示すセパレータ */
function CompactMarkerCard() {
  return (
    <div className="flex items-center gap-3 px-6 py-3 select-none">
      <div className="flex-1 border-t border-dashed border-border" />
      <span className="text-[11px] text-muted-foreground shrink-0">
        ✂ 会話を要約しました (/compact)
      </span>
      <div className="flex-1 border-t border-dashed border-border" />
    </div>
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
      <div className="text-sm text-muted-foreground mb-1.5 flex items-center gap-1.5">
        <span>❓</span>
        <span className="font-medium">
          {result
            ? isDecline
              ? "質問はキャンセルされました"
              : "質問への回答:"
            : "AskUserQuestion"}
        </span>
      </div>
      <div className="text-base space-y-1">
        {questions.map((q, i) => {
          const answer = answers.get(q.question);
          return (
            <div
              key={`${i}-${q.question}`}
              className="flex gap-1.5 items-start"
            >
              <span className="text-muted-foreground shrink-0">·</span>
              <div className="min-w-0 flex-1">
                <span className="text-foreground">{q.question}</span>
                {answer && (
                  <>
                    <span className="text-muted-foreground"> → </span>
                    <span className="font-medium text-primary">{answer}</span>
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
  // 1 行サマリを抽出: file_path / command / pattern / url など、最初に見つかった "らしい" 値
  const summary = useMemo(() => {
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
  }, [input]);

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
      <div className="inline-flex items-center gap-2 text-xs text-muted-foreground max-w-full">
        <span className="opacity-60 shrink-0">⚙</span>
        <span className="font-mono text-foreground shrink-0">{tool}</span>
        {summary && (
          <span className="font-mono opacity-70 truncate min-w-0">
            {summary}
          </span>
        )}
      </div>
    </div>
  );
}

function EventCard({ event }: { event: JsonlParsedEvent }) {
  switch (event.kind) {
    case "user-input":
      return <UserInputCard text={event.text} />;
    case "slash-command":
      return <SlashCommandCard name={event.name} args={event.args} />;
    case "assistant-text":
      return <AssistantTextCard text={event.text} />;
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

// ===== 本体 =====

export function SplitChatPane({
  socket,
  session,
  isActive,
  bridgeStatus,
  onSendMessage,
  onSendKey,
  onUploadFile,
  showTerminal,
  onToggleTerminal,
}: SplitChatPaneProps) {
  const [inputValue, setInputValue] = useState("");

  // JSONL: 会話の構造化履歴 (markdown レンダリング用)。アクティブ時のみ購読
  const {
    events,
    isSubscribed: jsonlSubscribed,
    loadMore,
    hasMore,
  } = useSessionJsonl(socket, isActive ? session.id : null);

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

  // biome-ignore lint/correctness/useExhaustiveDependencies(session.id): セッション切替を検知して pending を破棄するための意図的な依存
  useEffect(() => {
    setPending([]);
  }, [session.id]);

  // 回答待ちの AskUserQuestion。
  // 表示開始 = PreToolUse hook 由来の session:auq イベント (対話版 claude は
  // AUQ の tool_use を回答確定まで JSONL に書かないため hook が唯一の情報源)。
  // カードを閉じる = JSONL に解決イベント (tool_use + tool_result) が出現。
  const [hookAuq, setHookAuq] = useState<{
    at: number;
    auq: ActiveAuq;
  } | null>(null);

  useEffect(() => {
    if (!socket) return;
    const handler = (data: {
      sessionId: string;
      at: number;
      questions: unknown;
    }) => {
      if (data.sessionId !== session.id) return;
      const questions = parseAuqInput({ questions: data.questions });
      if (!questions) return;
      setHookAuq({
        at: data.at,
        auq: { toolUseId: `hook:${data.at}`, questions },
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

  // ===== スクロール追従 + 上端で過去読み込み =====
  const jsonlScrollRef = useRef<HTMLDivElement>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);
  // 「過去読み込み中」を ref で持つ。同じスクロールイベントで多重発火させないため
  const loadingMoreRef = useRef(false);
  // 過去読み込み発火時の scrollHeight / scrollTop。受信後に新しい高さとの差を
  // 足してスクロール位置を視覚的に固定する
  const prevScrollMetricsRef = useRef<{ height: number; top: number } | null>(
    null
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies(events): イベント追加 (高さ変化) のたびに末尾追従スクロールを再実行するための意図的な依存
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
  }, [events, isNearBottom]);

  // 「下までジャンプ」ボタン用。一気に末尾へ飛ばす副作用ハンドラ。
  // isNearBottom も true にしておくことで以降の自動追従も復活する。
  const scrollToBottom = useCallback(() => {
    const el = jsonlScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setIsNearBottom(true);
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
    setPending(prev => [
      ...prev,
      {
        id: `p:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        text: value,
        sentAt: Date.now(),
      },
    ]);
    setInputValue("");
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
    // Esc は Claude Code 本体と同じ挙動 (4 分岐) を reconcileEscape に委譲する。
    // 副作用 (setState / tmux 送信) はここで action 種別に応じて発火させる。
    // slashOpen は slash 補完実装 (Step 9) までは常に false。
    if (e.key === "Escape" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const action = reconcileEscape({
        inputValue,
        slashOpen: false,
        lastSubmitted: lastSubmittedRef.current,
      });
      if (action.kind === "close-slash") {
        // slash 補完未実装のため到達しない
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

  return (
    <div className="h-full flex flex-col bg-background">
      <header className="border-b border-border px-4 py-2.5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base">💬</span>
          <div className="min-w-0">
            <div className="font-bold text-sm text-foreground truncate">
              会話
            </div>
            <div className="text-[11px] text-muted-foreground truncate">
              {session.worktreePath.split("/").pop() ?? "session"} ·{" "}
              {events.length} イベント
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {(bridgeStatus === "THINK" || bridgeStatus === "TOOL") && (
            <span className="text-[11px] text-muted-foreground flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              {bridgeStatus === "TOOL" ? "ツール実行中" : "考え中"}
            </span>
          )}
          <span
            className={`w-1.5 h-1.5 rounded-full ${jsonlSubscribed ? "bg-emerald-500" : "bg-slate-400"}`}
            title={jsonlSubscribed ? "JSONL 購読中" : "未購読"}
          />
          {onToggleTerminal && (
            <button
              type="button"
              onClick={onToggleTerminal}
              className={`text-[11px] px-2 py-1 rounded-md font-medium flex items-center gap-1 transition-colors ${
                showTerminal
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted hover:bg-muted/70 text-foreground"
              }`}
              title={showTerminal ? "ターミナルを閉じる" : "ターミナルを開く"}
            >
              <span>🖥</span>
              <span>{showTerminal ? "閉じる" : "ターミナル"}</span>
            </button>
          )}
        </div>
      </header>

      {/* JSONL イベントリスト (上段、flex-1)。
          relative ラッパーで囲み「下へジャンプ」ボタンをスクロール領域に
          重ねて配置する。スクロール領域自体は absolute inset-0 で内側を埋める。 */}
      <div className="flex-1 min-h-0 relative">
        <div
          ref={jsonlScrollRef}
          className="absolute inset-0 overflow-y-auto py-2"
        >
          {events.length === 0 && pending.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground pt-8">
              このセッションの履歴はまだありません
            </div>
          ) : (
            <>
              {hasMore && (
                <div className="flex justify-center py-2 text-sm text-muted-foreground">
                  読み込み中...
                </div>
              )}
              {events.map(ev => (
                <EventCard key={ev.id} event={ev} />
              ))}
              {pending.map(p => (
                <PendingMessageCard key={p.id} text={p.text} />
              ))}
            </>
          )}
        </div>
        {!isNearBottom && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 w-9 h-9 rounded-full bg-foreground/85 text-background shadow-lg hover:bg-foreground flex items-center justify-center transition-colors"
            title="最新まで一気にスクロール"
            aria-label="最新まで一気にスクロール"
          >
            <ArrowDown className="w-4 h-4" />
          </button>
        )}
      </div>

      {activeAuq && (
        <AskUserQuestionCard
          key={activeAuq.toolUseId}
          socket={socket}
          sessionId={session.id}
          auq={activeAuq}
          onSendKey={onSendKey}
          onOpenTerminal={
            onToggleTerminal && !showTerminal ? onToggleTerminal : undefined
          }
        />
      )}

      {/* permission prompt 等のユーザー判断待ちフォールバック。
          AskUserQuestion は専用カードが出る (hook 経由) ため、カード表示中
          は出さない。hook が取りこぼされた場合のセーフティネットも兼ねる */}
      {bridgeStatus === "AWAITING" && !activeAuq && (
        <div className="border-t border-border bg-amber-500/10 px-3 py-2 shrink-0 flex items-center justify-between gap-2">
          <span className="text-[13px] text-amber-700 dark:text-amber-300 min-w-0">
            ⏳ Claude が入力を求めています
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => onSendKey("1")}
              className="text-[12px] font-mono bg-background border border-border rounded px-2 py-0.5 hover:bg-accent transition-colors"
              title="1 を送信"
            >
              1
            </button>
            <button
              type="button"
              onClick={() => onSendKey("2")}
              className="text-[12px] font-mono bg-background border border-border rounded px-2 py-0.5 hover:bg-accent transition-colors"
              title="2 を送信"
            >
              2
            </button>
            {onToggleTerminal && !showTerminal && (
              <button
                type="button"
                onClick={onToggleTerminal}
                className="text-[12px] underline text-amber-700 dark:text-amber-300 px-1"
              >
                ターミナルで確認
              </button>
            )}
          </div>
        </div>
      )}

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
        className={`border-t border-border px-3 py-2.5 shrink-0 flex gap-2 items-end relative ${
          isDragging ? "ring-2 ring-primary/50 bg-primary/5" : ""
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
              className="p-2 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors self-end"
              title="ファイル添付 (D&D / ペーストも可)"
              disabled={uploadingCount > 0}
            >
              {uploadingCount > 0 ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Paperclip className="w-4 h-4" />
              )}
            </button>
          </>
        )}
        <textarea
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={onUploadFile ? handlePaste : undefined}
          placeholder={
            onUploadFile
              ? "メッセージを入力 (Enter で送信、Shift+Enter で改行、画像は D&D / ペーストも可)"
              : "メッセージを入力 (Enter で送信、Shift+Enter で改行)"
          }
          rows={1}
          className="flex-1 px-3 py-2 text-sm bg-muted/40 border border-border rounded-lg focus:outline-none focus:border-primary placeholder:text-muted-foreground resize-none min-h-[36px] max-h-32"
        />
        <Button
          type="submit"
          size="sm"
          disabled={!inputValue.trim()}
          className="self-end"
        >
          <Send className="w-3.5 h-3.5" />
        </Button>
        {isDragging && onUploadFile && (
          <div className="absolute inset-0 bg-background/80 backdrop-blur-sm border-2 border-dashed border-primary rounded-lg flex items-center justify-center text-sm font-medium text-primary pointer-events-none">
            ここにドロップ
          </div>
        )}
      </form>
    </div>
  );
}
