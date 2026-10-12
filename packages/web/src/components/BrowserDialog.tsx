import type { BrowserDialogInfo } from "@ark/shared";
import type React from "react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface BrowserDialogProps {
  dialog: BrowserDialogInfo;
  /** ダイアログを出したページのホスト。分からなければ空 */
  origin: string;
  /** `promptText` は、`prompt` を受け入れたときだけ渡す */
  onRespond: (accept: boolean, promptText?: string) => void;
}

/** サーバーが受け取る `prompt` の文字列の長さの上限 */
const PROMPT_MAX_LENGTH = 10_000;
const BEFOREUNLOAD_TITLE = "このページを離れますか?";
const BEFOREUNLOAD_MESSAGE = "行った変更が保存されない可能性があります。";

/**
 * リモートのページが出したJavaScriptのダイアログ。canvasを置く領域の上に重ねる
 * (アプリの全体は覆わない。ツールバーとタブは、ダイアログが出ている間も使える)。
 *
 * ページが渡した文字列は、文字としてだけ描く (HTMLとして解釈しない)。改行は保ち、
 * 長ければ中でスクロールする。`beforeunload` は、ブラウザがページの文字列を見せない
 * 決まりなので、決まった文言を出す。
 *
 * 押しても閉じない。閉じるのは、サーバーが閉じたと知らせたとき (親が描くのをやめる)。
 * ほかの視聴者が応答したときも同じ経路で閉じる。応答が届かなかったときは、もう一度
 * 押せる。
 *
 * 入力中の文字列は、`dialog` が同じオブジェクトである間は保つ。別のオブジェクトに
 * 替わったら、新しいダイアログとして初期値に戻す。
 *
 * Tabのフォーカスは中を回る。Escapeは取り消しで、取り消しの無い `alert` では閉じる。
 */
export function BrowserDialog({
  dialog,
  origin,
  onRespond,
}: BrowserDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();
  const [shown, setShown] = useState(dialog);
  const [value, setValue] = useState(dialog.defaultPrompt);
  if (shown !== dialog) {
    setShown(dialog);
    setValue(dialog.defaultPrompt);
  }

  const { kind } = dialog;
  const leaving = kind === "beforeunload";
  const accept = () =>
    kind === "prompt" ? onRespond(true, value) : onRespond(true);
  const cancel = () => onRespond(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: dialogは本文中では読まないが、別のダイアログに替わるたびにフォーカスを入れ直すためのtriggerとして依存に入れている
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus({ preventScroll: true });
      inputRef.current.select();
    } else {
      primaryRef.current?.focus({ preventScroll: true });
    }
  }, [dialog]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (kind === "alert") accept();
      else cancel();
      return;
    }
    if (e.key !== "Tab") return;
    const focusable = [
      ...(panelRef.current?.querySelectorAll<HTMLElement>("input, button") ??
        []),
    ];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 操作を受ける要素ではなく、まわりを押したときにフォーカスがダイアログから外れるのを止めるだけ
    <div
      data-browser-overlay
      className="absolute inset-0 z-20 flex items-center justify-center bg-foreground/15 p-4"
      onMouseDown={e => {
        if (!(e.target as Element).closest("input, button")) e.preventDefault();
      }}
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        onKeyDown={handleKeyDown}
        className="flex max-h-full w-full max-w-sm flex-col gap-3 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-panel"
      >
        <h2 id={titleId} className="shrink-0 text-sm font-medium break-all">
          {leaving
            ? BEFOREUNLOAD_TITLE
            : origin
              ? `${origin} の内容`
              : "ページからのメッセージ"}
        </h2>
        <p
          id={messageId}
          className="max-h-48 min-h-0 overflow-y-auto text-sm break-words whitespace-pre-wrap text-muted-foreground"
        >
          {leaving ? BEFOREUNLOAD_MESSAGE : dialog.message}
        </p>
        {kind === "prompt" && (
          <Input
            ref={inputRef}
            type="text"
            aria-label="入力"
            autoComplete="off"
            maxLength={PROMPT_MAX_LENGTH}
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              accept();
            }}
            className="h-8 shrink-0"
          />
        )}
        <div className="flex shrink-0 justify-end gap-2">
          {kind !== "alert" && (
            <Button type="button" size="sm" variant="outline" onClick={cancel}>
              {leaving ? "とどまる" : "キャンセル"}
            </Button>
          )}
          <Button ref={primaryRef} type="button" size="sm" onClick={accept}>
            {leaving ? "このページを離れる" : "OK"}
          </Button>
        </div>
      </div>
    </div>
  );
}
