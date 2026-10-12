/**
 * ブラウザ機能の、視聴者から来るメッセージの検査とCDPへの変換。
 *
 * - 生のCDPを視聴者へ渡さない。視聴者のWebSocketに来たものをそのままCDPへ流すと、
 *   ページの外 (`Browser.*` / `Target.*`、任意のURLへの遷移) まで操作できてしまう。
 *   受け付けるのは `BrowserClientMessage` だけで、`parseClientMessage` で形を確かめ、
 *   入力は `toCdpCommand` が決めたメソッドにだけ変換する
 * - `parseClientMessage` は知っている列だけを写す。余分な列がCDPまで届くことはない
 * - 文字列と配列には上限を置く。上限を超えたメッセージは、切り詰めずに捨てる
 * - 入力でないメッセージ (寸法、送り直し、ページとタブの操作、ダイアログ、コピー、
 *   `<select>`) は、ここではCDPへ変換しない。ブリッジ (browser-cdp-bridge.ts) と、
 *   その協力モジュールが、それぞれの決まりで扱う
 *
 * CDPにも視聴者にも触らない。
 */

import type { BrowserClientMessage, BrowserTouchPoint } from "@ark/shared";

/** 1メッセージの文字列の上限 (文字数)。貼り付けの本文もこれに収める */
const MAX_TEXT_LENGTH = 100_000;
/** `key` と `code` の上限 (文字数)。DOMのキー名はどれも短い */
const MAX_KEY_LENGTH = 64;
/** アドレスバーに打たれたURLの上限 (文字数) */
const MAX_URL_LENGTH = 2048;
/** `prompt` へ入れる文字列の上限 (文字数) */
const MAX_PROMPT_LENGTH = 10_000;
/** 1つのメッセージに入るタッチの点の上限 */
const MAX_TOUCH_POINTS = 10;
/** タブのid (CDPのターゲットのid) の形 */
const TAB_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

const MOUSE_TYPES = {
  down: "mousePressed",
  up: "mouseReleased",
  move: "mouseMoved",
  wheel: "mouseWheel",
} as const;
/** DOMの `MouseEvent.button` の順 */
const MOUSE_BUTTONS = ["left", "middle", "right"];

/** 有限の数 */
export function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isText(value: unknown, max = MAX_TEXT_LENGTH): value is string {
  return typeof value === "string" && value.length <= max;
}

/** 0以上の整数 (番号、添字) */
function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTabId(value: unknown): value is string {
  return typeof value === "string" && TAB_ID_PATTERN.test(value);
}

/** タッチの点の並びを読む。形が違えば `null` */
function readTouchPoints(value: unknown): BrowserTouchPoint[] | null {
  if (!Array.isArray(value) || value.length > MAX_TOUCH_POINTS) return null;
  const points: BrowserTouchPoint[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const { id, x, y } = item as Record<string, unknown>;
    if (!isIndex(id) || !isNumber(x) || !isNumber(y)) return null;
    points.push({ id, x, y });
  }
  return points;
}

/**
 * 視聴者から来た文字列を `BrowserClientMessage` として読む。形が違えば `null`。
 * 知っている列だけを写すので、余分な列がCDPまで届くことはない。
 */
export function parseClientMessage(raw: string): BrowserClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const m = value as Record<string, unknown>;

  switch (m.t) {
    case "resize":
      if (
        !isNumber(m.width) ||
        !isNumber(m.height) ||
        !isNumber(m.dpr) ||
        typeof m.mobile !== "boolean"
      ) {
        return null;
      }
      return {
        t: "resize",
        width: m.width,
        height: m.height,
        dpr: m.dpr,
        mobile: m.mobile,
      };
    case "mouse":
      if (
        (m.type !== "down" &&
          m.type !== "up" &&
          m.type !== "move" &&
          m.type !== "wheel") ||
        !isNumber(m.x) ||
        !isNumber(m.y) ||
        !isNumber(m.button) ||
        !isNumber(m.buttons) ||
        !isNumber(m.clickCount) ||
        !isNumber(m.deltaX) ||
        !isNumber(m.deltaY) ||
        !isNumber(m.modifiers)
      ) {
        return null;
      }
      return {
        t: "mouse",
        type: m.type,
        x: m.x,
        y: m.y,
        button: m.button,
        buttons: m.buttons,
        clickCount: m.clickCount,
        deltaX: m.deltaX,
        deltaY: m.deltaY,
        modifiers: m.modifiers,
      };
    case "key":
      if (
        (m.type !== "down" && m.type !== "up") ||
        !isText(m.key, MAX_KEY_LENGTH) ||
        !isText(m.code, MAX_KEY_LENGTH) ||
        !isNumber(m.keyCode) ||
        typeof m.repeat !== "boolean" ||
        !isNumber(m.modifiers) ||
        (m.text !== undefined && !isText(m.text))
      ) {
        return null;
      }
      return {
        t: "key",
        type: m.type,
        key: m.key,
        code: m.code,
        keyCode: m.keyCode,
        repeat: m.repeat,
        modifiers: m.modifiers,
        ...(m.text === undefined ? {} : { text: m.text }),
      };
    case "ime":
      if (m.type === "cancel") return { t: "ime", type: "cancel" };
      if (m.type === "commit") {
        return isText(m.text)
          ? { t: "ime", type: "commit", text: m.text }
          : null;
      }
      if (m.type === "update") {
        if (
          !isText(m.text) ||
          !isNumber(m.selectionStart) ||
          !isNumber(m.selectionEnd)
        ) {
          return null;
        }
        return {
          t: "ime",
          type: "update",
          text: m.text,
          selectionStart: m.selectionStart,
          selectionEnd: m.selectionEnd,
        };
      }
      return null;
    case "paste":
      return isText(m.text) ? { t: "paste", text: m.text } : null;
    case "refresh":
      return { t: "refresh" };
    case "nav":
      if (m.type === "goto") {
        return isText(m.url, MAX_URL_LENGTH)
          ? { t: "nav", type: "goto", url: m.url }
          : null;
      }
      if (
        m.type === "back" ||
        m.type === "forward" ||
        m.type === "reload" ||
        m.type === "stop"
      ) {
        return { t: "nav", type: m.type };
      }
      return null;
    case "tab":
      if (m.type === "new") return { t: "tab", type: "new" };
      if (m.type === "activate" || m.type === "close") {
        return isTabId(m.id) ? { t: "tab", type: m.type, id: m.id } : null;
      }
      return null;
    case "dialog":
      if (
        typeof m.accept !== "boolean" ||
        (m.promptText !== undefined && !isText(m.promptText, MAX_PROMPT_LENGTH))
      ) {
        return null;
      }
      return {
        t: "dialog",
        accept: m.accept,
        ...(m.promptText === undefined ? {} : { promptText: m.promptText }),
      };
    case "copy":
      return { t: "copy" };
    case "selectChoose":
      return isIndex(m.id) && isIndex(m.index)
        ? { t: "selectChoose", id: m.id, index: m.index }
        : null;
    case "selectCancel":
      return isIndex(m.id) ? { t: "selectCancel", id: m.id } : null;
    case "touch": {
      if (
        (m.type !== "start" &&
          m.type !== "move" &&
          m.type !== "end" &&
          m.type !== "cancel") ||
        !isNumber(m.modifiers)
      ) {
        return null;
      }
      const points = readTouchPoints(m.points);
      return (
        points && {
          t: "touch",
          type: m.type,
          points,
          modifiers: m.modifiers,
        }
      );
    }
    default:
      return null;
  }
}

/** 押されているボタン (`MouseEvent.buttons`) から、CDPに渡すボタンを1つ選ぶ */
function buttonFromButtons(buttons: number): string {
  if (buttons & 1) return "left";
  if (buttons & 2) return "right";
  if (buttons & 4) return "middle";
  return "none";
}

/**
 * 入力のメッセージをCDPのコマンドへ変換する。入力でないもの (寸法、送り直し、ページと
 * タブの操作、ダイアログ、コピー、`<select>`) は `null` (ブリッジが自分で扱う)。
 * タッチも、ここでは変換しない。
 */
export function toCdpCommand(
  msg: BrowserClientMessage
): { method: string; params: object } | null {
  switch (msg.t) {
    case "resize":
    case "refresh":
    case "nav":
    case "tab":
    case "dialog":
    case "copy":
    case "selectChoose":
    case "selectCancel":
    case "touch":
      return null;
    case "mouse": {
      const base = {
        type: MOUSE_TYPES[msg.type],
        x: msg.x,
        y: msg.y,
        buttons: msg.buttons,
        clickCount: msg.clickCount,
        modifiers: msg.modifiers,
      };
      if (msg.type === "wheel") {
        return {
          method: "Input.dispatchMouseEvent",
          params: {
            ...base,
            button: "none",
            deltaX: msg.deltaX,
            deltaY: msg.deltaY,
          },
        };
      }
      return {
        method: "Input.dispatchMouseEvent",
        params: {
          ...base,
          button:
            msg.type === "move"
              ? buttonFromButtons(msg.buttons)
              : (MOUSE_BUTTONS[msg.button] ?? "none"),
        },
      };
    }
    case "key": {
      // textを付けたkeyDownだけが文字を入力する。keyUpに付けると二重に入る
      const text = msg.type === "down" ? msg.text : undefined;
      return {
        method: "Input.dispatchKeyEvent",
        params: {
          type:
            msg.type === "up"
              ? "keyUp"
              : text !== undefined
                ? "keyDown"
                : "rawKeyDown",
          key: msg.key,
          code: msg.code,
          modifiers: msg.modifiers,
          windowsVirtualKeyCode: msg.keyCode,
          nativeVirtualKeyCode: msg.keyCode,
          ...(text === undefined ? {} : { text, unmodifiedText: text }),
          autoRepeat: msg.repeat,
        },
      };
    }
    case "ime":
      if (msg.type === "commit") {
        return { method: "Input.insertText", params: { text: msg.text } };
      }
      if (msg.type === "update") {
        return {
          method: "Input.imeSetComposition",
          params: {
            text: msg.text,
            selectionStart: msg.selectionStart,
            selectionEnd: msg.selectionEnd,
          },
        };
      }
      return {
        method: "Input.imeSetComposition",
        params: { text: "", selectionStart: 0, selectionEnd: 0 },
      };
    case "paste":
      return { method: "Input.insertText", params: { text: msg.text } };
  }
}
