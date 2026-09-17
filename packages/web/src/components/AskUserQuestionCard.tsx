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
 * - 送出完了から10秒tool_resultが来なければdesync警告 (端末側の確認を促す)
 */

import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SpecialKey,
} from "@ark/shared";
import {
  CircleAlert,
  Loader2,
  Pencil,
  Square,
  SquareCheck,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { StatusChip } from "@/components/StatusChip";
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

  // 単問ならheaderをチップの横に、複数の質問なら各質問の上に出す
  const isSingleQuestion = auq.questions.length === 1;
  const singleHeader = isSingleQuestion ? auq.questions[0].header : undefined;

  return (
    // biome-ignore lint/a11y/useSemanticElements: fieldsetは既定でmin-inline-size: min-contentを持ち、見出しのtruncateや長い選択肢の折り返しがカードの幅を押し広げるため、divにroleを付ける
    <div
      role="group"
      aria-label="質問"
      className="min-h-0 overflow-y-auto rounded-lg border border-border bg-card px-4 pt-4 pb-3 shadow-card"
    >
      <div className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-muted-foreground">
        <StatusChip statusKey="AWAITING" />
        {singleHeader && (
          <span className="min-w-0 truncate">{singleHeader}</span>
        )}
      </div>

      {phase === "desync" && (
        <div className="mt-3 flex items-start gap-2 rounded-sm bg-status-awaiting/15 px-3 py-2 text-[13px] text-foreground">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            回答を確認できませんでした。ターミナル側の状態を確認してください
          </span>
        </div>
      )}

      {screenContext && <ScreenContextBlock text={screenContext} />}

      {auq.questions.map((q, qi) => {
        const draft = drafts[qi];
        return (
          <div key={`${auq.toolUseId}:${qi}`} className="mt-3">
            {!isSingleQuestion && q.header && (
              <div className="mb-1 text-[13px] font-semibold text-muted-foreground">
                {q.header}
              </div>
            )}
            <div className="break-words text-[15px] font-semibold leading-normal text-foreground">
              {q.question}
              {q.multiSelect && (
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  (複数選択可)
                </span>
              )}
            </div>
            <div className="mt-3 flex flex-col gap-2">
              {q.options.map((opt, oi) => {
                const selected =
                  draft?.kind === "options" && draft.indexes.includes(oi);
                return (
                  <button
                    key={`${oi}-${opt.label}`}
                    type="button"
                    disabled={phase === "submitting"}
                    aria-pressed={q.multiSelect ? selected : undefined}
                    onClick={() => {
                      if (isInstantMode) {
                        handleInstantOption(oi);
                      } else if (q.multiSelect) {
                        toggleMultiOption(qi, oi);
                      } else {
                        setDraft(qi, { kind: "options", indexes: [oi] });
                      }
                    }}
                    className={`flex w-full items-start gap-3 rounded-sm border px-3 py-2.5 text-left transition-colors disabled:opacity-50 ${
                      selected
                        ? "border-primary bg-primary/10"
                        : "border-border bg-card hover:border-primary hover:bg-primary/5"
                    }`}
                    title={`${oi + 1}. ${opt.label}`}
                  >
                    <span className="mt-px inline-flex size-[22px] shrink-0 items-center justify-center rounded-[6px] bg-muted text-xs font-semibold text-muted-foreground">
                      {q.multiSelect ? (
                        selected ? (
                          <SquareCheck
                            aria-hidden="true"
                            className="size-3.5"
                          />
                        ) : (
                          <Square aria-hidden="true" className="size-3.5" />
                        )
                      ) : (
                        oi + 1
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[15px] font-semibold leading-normal text-foreground">
                        {opt.label}
                      </span>
                      {opt.description && (
                        <span className="mt-px block text-[13px] leading-normal text-muted-foreground">
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

      <div className="mt-3 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={handleCancel}
          disabled={phase === "submitting"}
          className="rounded-sm px-2 py-1 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          title="キャンセル (Esc)"
        >
          キャンセル
        </button>
        <div className="flex items-center gap-2">
          {phase === "submitting" && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2
                aria-hidden="true"
                className="size-3.5 animate-spin motion-reduce:animate-none"
              />
              送信中...
            </span>
          )}
          {!isInstantMode && phase !== "submitting" && (
            <button
              type="button"
              onClick={handleSubmitAll}
              disabled={!allAnswered}
              className="rounded-sm bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-30"
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
 * 最新行 (末尾) が文脈として最重要なので末尾へスクロールする。
 * カードを保ったまま次の質問へ差し替わる場合があるので text にも追従する
 */
function ScreenContextBlock({ text }: { text: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // text は effect 内で読まないが、本文が差し替わった後に最新行へスクロール
  // し直すための依存。外すとカードを保ったまま次の質問へ変わったときに
  // 古いスクロール位置へ留まる
  // biome-ignore lint/correctness/useExhaustiveDependencies: 上記のとおり意図的
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <div className="mt-3">
      <div className="mb-1 text-[11px] text-muted-foreground">
        直前の画面 (ターミナルの表示そのまま)
      </div>
      <div
        ref={scrollRef}
        className="max-h-36 overflow-y-auto rounded-sm border border-border bg-muted/50 px-2.5 py-1.5"
      >
        <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-[1.55] text-muted-foreground">
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
    <div
      className="flex items-center gap-3 rounded-sm border border-dashed border-border px-3 py-2 focus-within:border-primary focus-within:border-solid"
      title={`${digitLabel}. その他 (自由入力)`}
    >
      <span className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-[6px] bg-muted text-muted-foreground">
        <Pencil aria-hidden="true" className="size-3.5" />
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
        aria-label="その他 (自由入力)"
        placeholder={
          onSubmit ? "その他 (自由入力、Enterで送信)" : "その他 (自由入力)"
        }
        className="min-w-0 flex-1 bg-transparent text-[15px] placeholder:text-muted-foreground focus:outline-none disabled:opacity-50"
      />
      {onSubmit && (
        <button
          type="button"
          onClick={() => onSubmit(value)}
          disabled={!value.trim() || disabled}
          className="shrink-0 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-30"
        >
          送信
        </button>
      )}
    </div>
  );
}
