/**
 * ブラウザ機能の入力変換。DOMのイベントを、サーバーへ送るメッセージにする。
 *
 * 日本語入力の決まり: 変換中のキー (`isComposing`) とIMEが受け取ったキー
 * (`keyCode === 229`) は送らない。変換中の文字列と確定はcompositionイベントから
 * 別のメッセージ (`ime`) で送るので、キーも送ると同じ文字が二重に入る。
 */

import type { BrowserClientMessage } from "@ark/shared";

export type BrowserMouseMessage = Extract<BrowserClientMessage, { t: "mouse" }>;

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
/** ページ単位のwheelを直すときの1ページの高さ */
const WHEEL_PAGE_PX = 800;
/**
 * 貼り付けの1メッセージの長さ (UTF-16のコードユニット数)。
 * サーバーは1メッセージの文字列に上限を持ち、超えたものを捨てる。その半分にしておく
 */
const PASTE_CHUNK_LENGTH = 50_000;

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
  if (e.altKey) return false;
  // WindowsとLinuxのもう1つの貼り付け。Ctrl+Insertはコピーなので除く
  if (e.key === "Insert") return e.shiftKey && !e.ctrlKey && !e.metaKey;
  if (!(e.ctrlKey || e.metaKey)) return false;
  if (e.key.toLowerCase() === "v") return true;
  // キリル配列などは key が v にならない。ASCIIの英字ならDvorakなどの配列なので key に従う
  return e.code === "KeyV" && !/^[a-zA-Z]$/.test(e.key);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 貼り付けの文字列を、1メッセージに収まる長さへ順に分ける。
 * サロゲートペアの間では切らない (切ると、2つの壊れた文字として入力される)。
 */
export function chunkPasteText(
  text: string,
  maxLength = PASTE_CHUNK_LENGTH
): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxLength, text.length);
    if (
      end < text.length &&
      end - 1 > start &&
      isHighSurrogate(text.charCodeAt(end - 1)) &&
      isLowSurrogate(text.charCodeAt(end))
    ) {
      end--;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function textOf(e: KeyLike): string | undefined {
  if (e.metaKey) return undefined;
  const isSingleChar = [...e.key].length === 1; // サロゲートペアは1文字に数える
  // WindowsとLinuxのAltGrは ctrlKey と altKey の両方を報告する。文字キーとして扱う
  if (e.ctrlKey && !(e.altKey && isSingleChar)) return undefined;
  if (e.key === "Enter") return "\r";
  return isSingleChar ? e.key : undefined;
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
): BrowserMouseMessage {
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
): BrowserMouseMessage {
  const scale =
    e.deltaMode === 2 ? WHEEL_PAGE_PX : e.deltaMode === 1 ? WHEEL_LINE_PX : 1;
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
