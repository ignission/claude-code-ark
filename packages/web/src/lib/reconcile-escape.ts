/**
 * SplitChatPane の Esc キー押下挙動を Claude Code 本体と合わせるための
 * 純粋関数。state の書き換えや tmux 送信は呼び出し側が action を見て実行する。
 *
 * 4 分岐:
 *   1. スラッシュ補完オープン中    → 補完を閉じる
 *   2. 入力欄に文字あり            → 入力欄をクリア
 *   3. 入力欄空 + 直前送信あり     → tmux に Escape を送る + 入力欄に直前
 *                                    送信テキストを復元 + 該当 pending を除去
 *   4. 入力欄空 + 直前送信なし     → tmux に Escape を送る (純粋な中断)
 *
 * 1 と 2 では tmux に Escape を送らない。Ark の textarea は Claude の
 * 入力欄のミラーであり、入力中の文字はまだ Claude に届いていないため。
 */

export interface EscapeContext {
  /** 現在 textarea に入っているテキスト */
  inputValue: string;
  /** スラッシュ補完が開いているか (true なら最優先で閉じる) */
  slashOpen: boolean;
  /** 直近に送信したテキスト ("" = なし) */
  lastSubmitted: string;
}

export type EscapeAction =
  | { kind: "close-slash" }
  | { kind: "clear-input" }
  | {
      kind: "interrupt";
      restore: string | null;
      removePendingText: string | null;
    };

export function reconcileEscape(ctx: EscapeContext): EscapeAction {
  if (ctx.slashOpen) {
    return { kind: "close-slash" };
  }
  if (ctx.inputValue.length > 0) {
    return { kind: "clear-input" };
  }
  if (ctx.lastSubmitted.length > 0) {
    return {
      kind: "interrupt",
      restore: ctx.lastSubmitted,
      removePendingText: ctx.lastSubmitted,
    };
  }
  return { kind: "interrupt", restore: null, removePendingText: null };
}
