/**
 * ブラウザ機能の入力変換。DOMのイベントを、サーバーへ送るメッセージにする。
 *
 * 日本語入力の決まり: 変換中のキー (`isComposing`) とIMEが受け取ったキー
 * (`keyCode === 229`) は送らない。変換中の文字列と確定はcompositionイベントから
 * 別のメッセージ (`ime`) で送るので、キーも送ると同じ文字が二重に入る。
 */

import type { BrowserClientMessage } from "@ark/shared";

interface ModifierKeys {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface KeyLike extends ModifierKeys {
  key: string;
  code: string;
  keyCode: number;
  repeat: boolean;
  isComposing: boolean;
}

export interface MouseLike extends ModifierKeys {
  clientX: number;
  clientY: number;
  button: number;
  buttons: number;
  detail: number;
}

export interface WheelLike extends MouseLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
}

/** IMEがキーを受け取ったときにブラウザが報告する keyCode */
const IME_KEYCODE = 229;
/** 行単位のwheel (Firefoxなど) を直すときの1行の高さ */
const WHEEL_LINE_PX = 40;

export function modifiersOf(e: ModifierKeys): number {
  return (
    (e.altKey ? 1 : 0) |
    (e.ctrlKey ? 2 : 0) |
    (e.metaKey ? 4 : 0) |
    (e.shiftKey ? 8 : 0)
  );
}

/** 貼り付けはキーとして送らず、pasteイベントの文字列を送る */
export function isPasteShortcut(e: KeyLike): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "v";
}

function textOf(e: KeyLike): string | undefined {
  if (e.ctrlKey || e.metaKey) return undefined;
  if (e.key === "Enter") return "\r";
  // key が1文字なら、そのキーが生む文字 (サロゲートペアは1文字に数える)
  return [...e.key].length === 1 ? e.key : undefined;
}

export function keyMessage(
  e: KeyLike,
  type: "down" | "up"
): BrowserClientMessage | null {
  if (e.isComposing || e.keyCode === IME_KEYCODE) return null;
  const text = type === "down" ? textOf(e) : undefined;
  return {
    t: "key",
    type,
    key: e.key,
    code: e.code,
    keyCode: e.keyCode,
    ...(text === undefined ? {} : { text }),
    repeat: e.repeat,
    modifiers: modifiersOf(e),
  };
}

export function mouseMessage(
  type: "down" | "up" | "move",
  e: MouseLike,
  origin: { left: number; top: number }
): BrowserClientMessage {
  return {
    t: "mouse",
    type,
    x: e.clientX - origin.left,
    y: e.clientY - origin.top,
    button: e.button,
    buttons: e.buttons,
    clickCount: type === "move" ? 0 : Math.max(1, e.detail),
    deltaX: 0,
    deltaY: 0,
    modifiers: modifiersOf(e),
  };
}

export function wheelMessage(
  e: WheelLike,
  origin: { left: number; top: number }
): BrowserClientMessage {
  const scale = e.deltaMode === 1 ? WHEEL_LINE_PX : 1;
  return {
    t: "mouse",
    type: "wheel",
    x: e.clientX - origin.left,
    y: e.clientY - origin.top,
    button: 0,
    buttons: e.buttons,
    clickCount: 0,
    deltaX: e.deltaX * scale,
    deltaY: e.deltaY * scale,
    modifiers: modifiersOf(e),
  };
}
