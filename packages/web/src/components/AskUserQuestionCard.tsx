/**
 * AskUserQuestionCard - 回答待ち AskUserQuestion の入力欄上パネル
 *
 * データソースは JSONL の tool_use.input.questions のみ (画面パース無し)。
 * 回答は tmux へのキー送出列 (buildKeySequence) で行い、確定は JSONL に
 * tool_result が出現したこと (= 親が activeAuq を null にしてアンマウント)
 * で検知する。ターミナル直接操作と競合しても JSONL が唯一の真実なので
 * 必ず収束する。
 *
 * - 単問 single-select: 選択肢クリックで即送出 (1 タップ)
 * - multiSelect / 複数質問: 全問選択 → 「回答を送信」で一括送出
 * - 送出列の各 wait 後に確定済みチェック (余分なキーの誤爆防止)
 * - 送出完了から 10 秒 tool_result が来なければ desync 警告 + ターミナル誘導
 */

import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SpecialKey,
} from "@ark/shared";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import {
  type ActiveAuq,
  type AuqAnswer,
  type AuqKeyStep,
  buildKeySequence,
  freeTextDigit,
} from "@/lib/ask-user-question-state";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface AskUserQuestionCardProps {
  socket: TypedSocket | null;
  sessionId: string;
  auq: ActiveAuq;
  /**
   * hook 受信時の tmux 画面スナップショット (verbatim・無解釈)。
   * AUQ 表示中は直前の会話が JSONL に書かれないため、質問の文脈は
   * これでしか提示できない。null なら非表示
   */
  screenContext?: string | null;
  onSendKey: (key: SpecialKey) => void;
  /** desync 時の「ターミナルで確認」(ttyd を開く)。未指定なら文言のみ */
  onOpenTerminal?: () => void;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

type Phase = "selecting" | "submitting" | "desync";

/** 質問ごとの選択途中状態 */
type Draft =
  | { kind: "options"; indexes: number[] }
  | { kind: "free"; text: string }
  | null;

export function AskUserQuestionCard({
  socket,
  sessionId,
  auq,
  screenContext,
  onSendKey,
  onOpenTerminal,
}: AskUserQuestionCardProps) {
  const [phase, setPhase] = useState<Phase>("selecting");
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    auq.questions.map(() => null)
  );

  // 送出ループの中止判定用。toolUseId が変わる = 別の質問 (このカードは
  // key={toolUseId} で作り直される想定だが保険)。アンマウントでも中止。
  const aliveRef = useRef(true);
  const desyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (desyncTimerRef.current) clearTimeout(desyncTimerRef.current);
    };
  }, []);

  const dispatchStep = (step: AuqKeyStep) => {
    switch (step.kind) {
      case "digit":
        onSendKey(step.value as SpecialKey);
        break;
      case "key":
        onSendKey(step.value);
        break;
      case "literal":
        socket?.emit("session:send-literal", { sessionId, text: step.value });
        break;
      case "wait":
        break; // runSequence 側で await する
    }
  };

  const runSequence = async (steps: AuqKeyStep[]) => {
    setPhase("submitting");
    for (const step of steps) {
      // tool_result 出現で親が null を渡しアンマウントされる → 残りを中止
      if (!aliveRef.current) return;
      if (step.kind === "wait") {
        await sleep(step.ms);
      } else {
        dispatchStep(step);
      }
    }
    if (!aliveRef.current) return;
    // 送出完了。通常は数百 ms で tool_result が JSONL に書かれて
    // カードごと消える。来なければ TUI と desync している
    desyncTimerRef.current = setTimeout(() => {
      if (aliveRef.current) setPhase("desync");
    }, 10_000);
  };

  const submitAnswers = (answers: AuqAnswer[]) => {
    const steps = buildKeySequence(auq.questions, answers);
    if (!steps) {
      setPhase("desync"); // 送出列を構築できない (選択肢 10 個超等) → ターミナル誘導
      return;
    }
    void runSequence(steps);
  };

  /** 単問 single-select: クリック即送出 */
  const isInstantMode =
    auq.questions.length === 1 && !auq.questions[0].multiSelect;

  const handleInstantOption = (index: number) => {
    if (phase === "submitting") return;
    submitAnswers([{ kind: "options", indexes: [index] }]);
  };

  const handleInstantFree = (text: string) => {
    const value = text.trim();
    if (!value || phase === "submitting") return;
    submitAnswers([{ kind: "free", text: value }]);
  };

  /** 複数質問 / multiSelect: ドラフトを編集して一括送出 */
  const setDraft = (qi: number, draft: Draft) => {
    setDrafts(prev => prev.map((d, i) => (i === qi ? draft : d)));
  };

  const toggleMultiOption = (qi: number, index: number) => {
    setDrafts(prev =>
      prev.map((d, i) => {
        if (i !== qi) return d;
        const cur = d?.kind === "options" ? d.indexes : [];
        const next = cur.includes(index)
          ? cur.filter(x => x !== index)
          : [...cur, index];
        return next.length > 0 ? { kind: "options", indexes: next } : null;
      })
    );
  };

  const allAnswered = drafts.every(d => {
    if (!d) return false;
    if (d.kind === "free") return d.text.trim().length > 0;
    return d.indexes.length > 0;
  });

  const handleSubmitAll = () => {
    if (!allAnswered || phase === "submitting") return;
    const answers: AuqAnswer[] = drafts.map(d => {
      if (!d) throw new Error("unreachable: allAnswered checked");
      return d.kind === "free" ? { kind: "free", text: d.text.trim() } : d;
    });
    submitAnswers(answers);
  };

  const handleCancel = () => {
    if (phase === "submitting") return;
    onSendKey("Escape");
  };

  return (
    <div className="border-t border-border bg-muted/30 px-3 py-2.5 shrink-0 max-h-[45%] overflow-y-auto">
      {phase === "desync" && (
        <div className="mb-2 text-[13px] bg-amber-500/15 text-amber-700 dark:text-amber-300 rounded-md px-2.5 py-1.5 flex items-center justify-between gap-2">
          <span>
            回答を確認できませんでした。ターミナル側の状態を確認してください
          </span>
          {onOpenTerminal && (
            <button
              type="button"
              onClick={onOpenTerminal}
              className="shrink-0 underline font-medium"
            >
              ターミナルで確認
            </button>
          )}
        </div>
      )}

      {screenContext && <ScreenContextBlock text={screenContext} />}

      {auq.questions.map((q, qi) => {
        const draft = drafts[qi];
        return (
          <div key={`${auq.toolUseId}:${qi}`} className="mb-2 last:mb-0">
            <div className="text-sm font-medium text-foreground mb-2 flex items-start gap-2">
              <span className="shrink-0 leading-[1.4]">❓</span>
              <span className="break-words min-w-0">
                {q.header && (
                  <span className="inline-block text-[11px] bg-muted text-muted-foreground rounded px-1.5 py-0.5 mr-1.5 align-middle">
                    {q.header}
                  </span>
                )}
                {q.question}
                {q.multiSelect && (
                  <span className="text-[11px] text-muted-foreground ml-1.5">
                    (複数選択可)
                  </span>
                )}
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              {q.options.map((opt, oi) => {
                const selected =
                  draft?.kind === "options" && draft.indexes.includes(oi);
                return (
                  <button
                    key={`${oi}-${opt.label}`}
                    type="button"
                    disabled={phase === "submitting"}
                    onClick={() => {
                      if (isInstantMode) {
                        handleInstantOption(oi);
                      } else if (q.multiSelect) {
                        toggleMultiOption(qi, oi);
                      } else {
                        setDraft(qi, { kind: "options", indexes: [oi] });
                      }
                    }}
                    className={`text-sm border rounded-md px-2.5 py-1.5 flex items-start gap-2 transition-colors text-left disabled:opacity-50 ${
                      selected
                        ? "bg-primary/10 border-primary text-foreground"
                        : "bg-background hover:bg-accent hover:text-accent-foreground border-border"
                    }`}
                    title={`${oi + 1}. ${opt.label}`}
                  >
                    <span className="font-mono text-muted-foreground shrink-0">
                      {q.multiSelect ? (selected ? "☑" : "☐") : `${oi + 1}.`}
                    </span>
                    <span className="min-w-0">
                      <span className="block">{opt.label}</span>
                      {opt.description && (
                        <span className="block text-xs text-muted-foreground mt-0.5">
                          {opt.description}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
              {/* 自由入力 (Type something.)。digit が 9 を超える構成では
                  buildKeySequence が null になるため表示しない */}
              {freeTextDigit(q) <= 9 && (
                <FreeTextRow
                  digitLabel={freeTextDigit(q)}
                  disabled={phase === "submitting"}
                  value={draft?.kind === "free" ? draft.text : ""}
                  onChange={text =>
                    setDraft(qi, text ? { kind: "free", text } : null)
                  }
                  onSubmit={
                    isInstantMode ? text => handleInstantFree(text) : undefined
                  }
                />
              )}
            </div>
          </div>
        );
      })}

      <div className="mt-2 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={handleCancel}
          disabled={phase === "submitting"}
          className="text-[13px] text-muted-foreground hover:text-foreground px-2 py-0.5 transition-colors disabled:opacity-50"
          title="キャンセル (Esc)"
        >
          キャンセル
        </button>
        <div className="flex items-center gap-2">
          {phase === "submitting" && (
            <span className="text-[12px] text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              送信中...
            </span>
          )}
          {!isInstantMode && phase !== "submitting" && (
            <button
              type="button"
              onClick={handleSubmitAll}
              disabled={!allAnswered}
              className="text-[13px] bg-primary text-primary-foreground rounded-md px-3 py-1 font-medium disabled:opacity-30 disabled:cursor-not-allowed"
            >
              回答を送信
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 質問直前のターミナル画面の verbatim 表示。
 * 最新行 (末尾) が文脈として最重要なのでマウント時に末尾へスクロールする
 */
function ScreenContextBlock({ text }: { text: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  return (
    <div className="mb-2">
      <div className="text-[11px] text-muted-foreground mb-1">
        直前の画面（ターミナルの表示そのまま）
      </div>
      <div
        ref={scrollRef}
        className="max-h-36 overflow-y-auto rounded-md border border-border bg-background/60 px-2.5 py-1.5"
      >
        <pre className="text-[11px] font-mono whitespace-pre-wrap break-words text-muted-foreground leading-[1.55]">
          {text}
        </pre>
      </div>
    </div>
  );
}

function FreeTextRow({
  digitLabel,
  disabled,
  value,
  onChange,
  onSubmit,
}: {
  digitLabel: number;
  disabled: boolean;
  value: string;
  onChange: (text: string) => void;
  /** 単問 single-select のとき Enter / ボタンで即送出 */
  onSubmit?: (text: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 bg-background border border-border rounded-md px-2.5 py-1.5 focus-within:border-primary">
      <span className="font-mono text-muted-foreground text-sm shrink-0">
        {digitLabel}.
      </span>
      <input
        type="text"
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (
            e.key === "Enter" &&
            !e.nativeEvent.isComposing &&
            onSubmit &&
            value.trim()
          ) {
            e.preventDefault();
            onSubmit(value);
          }
        }}
        placeholder={
          onSubmit ? "自由に入力 (Enter で送信)" : "自由に入力 (任意)"
        }
        className="flex-1 text-sm bg-transparent focus:outline-none placeholder:text-muted-foreground disabled:opacity-50"
      />
      {onSubmit && (
        <button
          type="button"
          onClick={() => onSubmit(value)}
          disabled={!value.trim() || disabled}
          className="text-[10px] bg-primary text-primary-foreground rounded px-2 py-0.5 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          送信
        </button>
      )}
    </div>
  );
}
