/**
 * AskWindow - 裏の Claude に聞く、浮かぶウィンドウ (PC のみ)
 *
 * コマンドパレットの「Claude に聞く」で開く。表のセッションの会話には入らず、裏で動く
 * 専用の Claude (サーバーの AskManager) が答える。開いたまま、ほかの操作を続けられる
 * (ダイアログではないので、後ろの画面もノーマルモードのキーもそのまま効く)。
 *
 * - 見出しをつかんで動かせる。位置は覚える (lib/ask-window.ts)
 * - 対話版の claude は、答えを書き終えてから transcript に出す。書かれるそばからは
 *   出せないので、待っている間は「考えています」とだけ出す
 * - 閉じても会話は残る (サーバーが持つ)。「新しく聞く」でまっさらにする
 */

import type { AskState } from "@ark/shared";
import { RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ASK_WINDOW_HEIGHT,
  ASK_WINDOW_WIDTH,
  type AskWindowPosition,
  clampAskWindowPosition,
  defaultAskWindowPosition,
  loadAskWindowPosition,
  saveAskWindowPosition,
} from "@/lib/ask-window";
import { cn } from "@/lib/utils";

export interface AskWindowProps {
  state: AskState;
  /** 送る前に弾かれた理由 (未接続など) */
  sendError: string | null;
  /** 開くたびに増える。増えたら入力欄へフォーカスを置く */
  focusSeq: number;
  onSend: (text: string) => void;
  onReset: () => void;
  onClose: () => void;
}

function viewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

export function AskWindow({
  state,
  sendError,
  focusSeq,
  onSend,
  onReset,
  onClose,
}: AskWindowProps) {
  const [position, setPosition] = useState<AskWindowPosition>(() =>
    clampAskWindowPosition(
      loadAskWindowPosition() ?? defaultAskWindowPosition(viewport()),
      viewport()
    )
  );
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focusSeq は「開いた / 開き直した」ことの合図として依存に置く
  useEffect(() => {
    inputRef.current?.focus();
  }, [focusSeq]);

  // ウィンドウの大きさが変わったら、画面の中へ戻す
  useEffect(() => {
    const onResize = () =>
      setPosition(current => clampAskWindowPosition(current, viewport()));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 発話が増えたら末尾を見せる
  const count = state.messages.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 発話の数と待ちの状態が変わるたびに末尾へ寄せる
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [count, state.busy]);

  const submit = () => {
    const text = draft.trim();
    if (text === "") return;
    onSend(text);
    setDraft("");
  };

  const error = sendError ?? state.error;

  return (
    <section
      aria-label="Claude に聞く"
      data-ask-window=""
      className="panel fixed z-40 flex flex-col overflow-hidden"
      style={{
        left: position.x,
        top: position.y,
        width: ASK_WINDOW_WIDTH,
        height: `min(${ASK_WINDOW_HEIGHT}px, 70vh)`,
      }}
      onKeyDown={event => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header
        className="flex shrink-0 cursor-move touch-none select-none items-center gap-2 bg-well px-4 py-2.5"
        onPointerDown={event => {
          if ((event.target as HTMLElement).closest("button")) return;
          dragRef.current = {
            dx: event.clientX - position.x,
            dy: event.clientY - position.y,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          const drag = dragRef.current;
          if (!drag) return;
          setPosition(
            clampAskWindowPosition(
              { x: event.clientX - drag.dx, y: event.clientY - drag.dy },
              viewport()
            )
          );
        }}
        onPointerUp={() => {
          if (!dragRef.current) return;
          dragRef.current = null;
          saveAskWindowPosition(position);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
      >
        <h2 className="text-[13px] font-semibold">Claude に聞く</h2>
        <span className="text-[11px] text-muted-foreground">
          表のセッションとは別の会話
        </span>
        <button
          type="button"
          title="新しく聞く (会話をまっさらにする)"
          aria-label="新しく聞く"
          disabled={state.messages.length === 0 && !state.busy}
          className="ml-auto inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          onClick={onReset}
        >
          <RotateCcw className="size-3.5" />
        </button>
        <button
          type="button"
          title="閉じる (会話は残る)"
          aria-label="聞くウィンドウを閉じる"
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={onClose}
        >
          <X className="size-4" />
        </button>
      </header>
      <div
        ref={listRef}
        role="log"
        aria-live="polite"
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3"
      >
        {state.messages.length === 0 && !state.busy && (
          <p className="pt-8 text-center text-sm text-muted-foreground">
            ちょっとしたことを聞けます。ファイルは読みません
          </p>
        )}
        {state.messages.map(message => (
          <div
            key={message.id}
            data-role={message.role}
            className={cn(
              message.role === "user"
                ? "ml-8 rounded-xl bg-well px-3 py-2 text-[14px] whitespace-pre-wrap"
                : "md-prose text-[14px] text-foreground"
            )}
          >
            {message.role === "user" ? (
              message.text
            ) : (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {message.text}
              </ReactMarkdown>
            )}
          </div>
        ))}
        {state.busy && (
          <p className="animate-pulse text-sm text-muted-foreground">
            考えています…
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <div className="shrink-0 px-3 pb-3">
        <textarea
          ref={inputRef}
          rows={2}
          value={draft}
          aria-label="Claude に聞く文"
          placeholder="続けて聞く (Enter で送る)"
          className="block w-full resize-none rounded-xl bg-well px-3 py-2 text-[14px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            // 変換の確定の Enter では送らない
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
      </div>
    </section>
  );
}
