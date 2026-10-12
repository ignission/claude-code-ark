import type { BrowserDialogInfo } from "@ark/shared";
import type React from "react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** 出たときにフォーカスを置く先。`control` は入力欄か主ボタン、`panel` はダイアログの枠 */
export type BrowserDialogFocusMode = "control" | "panel" | "none";

interface BrowserDialogProps {
  dialog: BrowserDialogInfo;
  /** ダイアログを出したページのホスト。分からなければ空 */
  origin: string;
  /** 利用者がこのダイアログにもう応答したか。応答済みの間は、どの操作も受けない */
  answered?: boolean;
  /**
   * フォーカスを置く先を決める。フォーカスを動かす直前に呼ぶので、呼ばれた時点の
   * `document.activeElement` は、ダイアログが出る前の場所。渡さなければ `control`
   */
  focusMode?: () => BrowserDialogFocusMode;
  /** `promptText` は、`prompt` を受け入れたときだけ渡す */
  onRespond: (accept: boolean, promptText?: string) => void;
}

/** サーバーが受け取る `prompt` の文字列の長さの上限 */
export const PROMPT_MAX_LENGTH = 10_000;
/**
 * ダイアログが出てからこの時間 (ミリ秒) までのEnter、Space、Escapeは、応答にしない。
 * 出る前から打っていたキーが、読んでいないダイアログへの応答になるのを防ぐ。
 */
export const DIALOG_KEY_GUARD_MS = 300;
const BEFOREUNLOAD_TITLE = "このページを離れますか?";
const BEFOREUNLOAD_MESSAGE = "行った変更が保存されない可能性があります。";
const ENABLED_CONTROLS = "input:not(:disabled), button:not(:disabled)";

/**
 * リモートのページが出したJavaScriptのダイアログ。canvasを置く領域の上に重ねる。
 *
 * アプリの全体を止めるモーダルではない。覆うのはcanvasを置く領域だけで、ツールバーと
 * タブは、ダイアログが出ている間も使える (ダイアログを出し続けるタブを閉じられる)。
 * そのため `aria-modal` は付けず、ペインの中の `alertdialog` として、見出しと本文を
 * 名前と説明に結ぶ。
 *
 * ページが渡した文字列は、文字としてだけ描く (HTMLとして解釈しない)。改行は保ち、
 * 長ければ中でスクロールする。`beforeunload` は、ブラウザがページの文字列を見せない
 * 決まりなので、決まった文言を出す。
 *
 * 押しても閉じない。閉じるのは、サーバーが閉じたと知らせたとき (親が描くのをやめる)。
 * ほかの視聴者が応答したときも同じ経路で閉じる。応答したあとは、別のダイアログに
 * 替わるか閉じるまで、ボタンと入力欄を無効にする (`answered`)。二度押しや押したままの
 * Enterが、まだ表示していない次のダイアログへの応答になるのを防ぐ。
 *
 * フォーカスは、出たときと、別のダイアログに替わったときに取る。置く先は親が決める
 * (`focusMode`)。ペインの外で打っていたなら、フォーカスは動かさない (`none`)。
 * 利用者がページを操作していたなら入力欄か主ボタンに置き、ほかの場所
 * (URLの入力欄など) で打っていたなら、ダイアログの枠に置く。枠にあれば、打ちかけの
 * EnterやSpaceはどのボタンも押さない。同じ理由で、出た直後 (`DIALOG_KEY_GUARD_MS`) の
 * Enter、Space、Escapeと、押したままの繰り返しは、応答にしない。入力欄で打つ空白は、
 * 応答ではないので止めない。
 *
 * 入力中の文字列は、`dialog` が同じオブジェクトである間は保つ。別のオブジェクトに
 * 替わったら、新しいダイアログとして初期値に戻す。初期値は、サーバーが受け取る長さに
 * 切り詰める。
 *
 * Tabのフォーカスは中を回る。Escapeは取り消しで、取り消しの無い `alert` では閉じる。
 */
export function BrowserDialog({
  dialog,
  origin,
  answered = false,
  focusMode,
  onRespond,
}: BrowserDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  // いまのダイアログを出した時刻。出すまでは、どのキーも応答にしない
  const shownAtRef = useRef(Number.POSITIVE_INFINITY);
  // keydownを止めたSpace。ボタンはkeyupで押されるので、keyupも止める
  const suppressedSpaceRef = useRef(false);
  const titleId = useId();
  const messageId = useId();
  const [shown, setShown] = useState(dialog);
  const [value, setValue] = useState(() =>
    dialog.defaultPrompt.slice(0, PROMPT_MAX_LENGTH)
  );
  if (shown !== dialog) {
    setShown(dialog);
    setValue(dialog.defaultPrompt.slice(0, PROMPT_MAX_LENGTH));
  }

  const { kind } = dialog;
  const leaving = kind === "beforeunload";
  const respond = (accept: boolean) => {
    if (answered) return;
    if (accept && kind === "prompt") onRespond(true, value);
    else onRespond(accept);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: dialogは本文中では読まないが、別のダイアログに替わるたびに時刻を計り直し、フォーカスを入れ直すためのtriggerとして依存に入れている。focusModeは、その時点の1回だけ呼ぶ
  useEffect(() => {
    shownAtRef.current = performance.now();
    suppressedSpaceRef.current = false;
    const control = inputRef.current ?? primaryRef.current;
    const mode = focusMode?.();
    if (mode === "none") return;
    if (mode === "panel" || !control || control.disabled) {
      panelRef.current?.focus({ preventScroll: true });
      return;
    }
    control.focus({ preventScroll: true });
    inputRef.current?.select();
  }, [dialog]);

  // 無効にした部品にフォーカスを残さない (残すと、キーがどこにも届かなくなる)
  useEffect(() => {
    const panel = panelRef.current;
    if (answered && panel?.contains(document.activeElement)) {
      panel.focus({ preventScroll: true });
    }
  }, [answered]);

  /** 応答にしないキーなら `true`。出た直後のキーと、押したままの繰り返し */
  const isGuarded = (e: React.KeyboardEvent<HTMLDivElement>): boolean => {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Escape") return false;
    // 変換中のキーは、IMEに任せる
    if (e.nativeEvent.isComposing) return false;
    if (e.key === " " && e.target instanceof HTMLInputElement) return false;
    return (
      e.repeat || performance.now() - shownAtRef.current < DIALOG_KEY_GUARD_MS
    );
  };

  const handleKeyDownCapture = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isGuarded(e)) return;
    // 既定の動作 (フォーカスのあるボタンを押す) も止める
    e.preventDefault();
    e.stopPropagation();
    if (e.key === " ") suppressedSpaceRef.current = true;
  };

  const handleKeyUpCapture = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== " " || !suppressedSpaceRef.current) return;
    suppressedSpaceRef.current = false;
    e.preventDefault();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      respond(kind === "alert");
      return;
    }
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    const focusable = [
      ...(panel?.querySelectorAll<HTMLElement>(ENABLED_CONTROLS) ?? []),
    ];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) {
      // 押せる部品が無い (応答済み) 間は、枠に留める
      e.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 操作を受ける要素ではなく、まわりを押したときにフォーカスがダイアログから外れるのを止めるだけ
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-foreground/15 p-4"
      onMouseDown={e => {
        if (!(e.target as Element).closest("input, button")) e.preventDefault();
      }}
    >
      <div
        ref={panelRef}
        data-browser-overlay
        role="alertdialog"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        tabIndex={-1}
        onKeyDownCapture={handleKeyDownCapture}
        onKeyUpCapture={handleKeyUpCapture}
        onKeyDown={handleKeyDown}
        className="flex max-h-full w-full max-w-sm flex-col gap-3 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-panel outline-none"
      >
        <h2 id={titleId} className="shrink-0 text-sm font-medium break-all">
          {leaving
            ? BEFOREUNLOAD_TITLE
            : origin
              ? `${origin}の内容`
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
            disabled={answered}
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              respond(true);
            }}
            className="h-8 shrink-0"
          />
        )}
        <div className="flex shrink-0 justify-end gap-2">
          {kind !== "alert" && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={answered}
              onClick={() => respond(false)}
            >
              {leaving ? "とどまる" : "キャンセル"}
            </Button>
          )}
          <Button
            ref={primaryRef}
            type="button"
            size="sm"
            disabled={answered}
            onClick={() => respond(true)}
          >
            {leaving ? "このページを離れる" : "OK"}
          </Button>
        </div>
      </div>
    </div>
  );
}
