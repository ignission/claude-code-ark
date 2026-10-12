/**
 * ブラウザ機能の `<select>`。ページへ入れるスクリプトと、ページから届く知らせの検査。
 *
 * - `<select>` のポップアップは、ページの外にChromiumが描く。screencastにも取り直しにも
 *   映らないので、視聴者は選択肢を見ることも選ぶこともできない。見えないまま開いた
 *   ポップアップは、そのあとのキー入力 (↓、Enter) を受け取って値を変えてしまう。
 *   そこで、開く操作をページの中で横取りして開かせず、選択肢を視聴者へ知らせて、
 *   Arkの画面で選ばせる
 * - 横取りするのは、captureフェーズの `mousedown` (左ボタン) と、開くキーの `keydown`
 *   (Space、Enter、Alt+↓、Alt+↑、F4)。`preventDefault()` で開かなくなる。タッチのタップも、
 *   Chromiumが `mousedown` に変えるので同じ経路を通る。`mousedown` を止めるとフォーカスも
 *   移らないので、自分で当てる
 * - 対象は、ポップアップで開く `<select>` だけ (`multiple` でなく、`size` が1以下で、
 *   無効でない)。一覧で描かれる `<select>` は画面に映るので、そのままにする
 * - スクリプトは文字列で持つ。Chromiumのページで評価するので、importにもbundlerの
 *   補助関数にも頼れない。構文はES2017まで
 * - スクリプトは、新しい文書のすべてのフレームに入る。知らせと選択は、いちばん上の
 *   文書に入ったものが受け持つ (選ぶ式は、いちばん上の文書で評価される)。iframeの中の
 *   `<select>` は、`frameElement` をたどっていちばん上の文書へ渡し、位置もそこの座標へ直す
 * - 別オリジンのiframeの中の `<select>` は選べない。親の文書に触れないので、いちばん上の
 *   文書へ渡せず、位置も直せない。開く操作は止めるので、見えないポップアップは開かないが、
 *   選択肢も出ない。別プロセスになるiframeには、スクリプトそのものが入らない。
 *   closedなshadow DOMの中の `<select>` と、CSSで変形したiframeの中の位置も扱わない
 * - ページから届く知らせ (bindingのペイロード) は信用しない。bindingはページのどの
 *   スクリプトからも呼べる。形を確かめ、数と長さに上限を置き、知っている列だけを写す。
 *   通らないものは捨てる
 * - ページに置く関数 (選ぶ、取り消す、開く) も、ページのスクリプトから呼べる。呼んでも、
 *   そのページが自分の `<select>` を変えられるだけ。引数は関数の中で確かめる
 * - 選ぶときは、知らせたあとに選択肢の数が変わっていたら何もしない (添字が別の選択肢を
 *   指す)。値が変わるときだけ `selectedIndex` を入れ、`input`、`change` の順に発火する
 * - ページの中で覚える要素には上限を置き、古いものから捨てる
 *
 * CDPにも視聴者にも触らない。
 */

import type { BrowserSelectOption } from "@ark/shared";

/** ページから知らせを受け取るbindingの名前 */
export const SELECT_BINDING_NAME = "__arkSelect";
/** ページに置く、選ぶ関数と取り消す関数の名前 */
const CHOOSE_NAME = "__arkSelectChoose";
const CANCEL_NAME = "__arkSelectCancel";
/** フレームから、いちばん上の文書へ `<select>` を渡す関数の名前 */
const OPEN_NAME = "__arkSelectOpen";

/** 選択肢の数の上限。スクリプトの中の数と揃える */
const MAX_OPTIONS = 1000;
/** ラベルと見出しの上限 (文字数)。スクリプトの中の数と揃える */
const MAX_LABEL_LENGTH = 500;
/** ペイロードの文字列の上限 (文字数)。上限いっぱいの選択肢が収まる大きさ */
const MAX_PAYLOAD_LENGTH = 1_000_000;

/**
 * ページへ入れるスクリプト。同じ文書に何度入れても、働くのは最初の1回だけ。
 * 何が起きてもページへ例外を漏らさない。
 */
export const SELECT_SHIM_SOURCE = `(() => {
  const MARK = "__arkSelectShim";
  if (window[MARK]) return;
  try {
    Object.defineProperty(window, MARK, { value: true });
  } catch (error) {
    return;
  }
  const MAX_OPEN = 32;
  const MAX_OPTIONS = ${MAX_OPTIONS};
  const MAX_LABEL = ${MAX_LABEL_LENGTH};
  const MAX_DEPTH = 32;
  const opened = new Map();
  let nextId = 0;

  const qualifies = el => {
    try {
      return (
        !!el &&
        el.nodeType === 1 &&
        el.localName === "select" &&
        el.namespaceURI === "http://www.w3.org/1999/xhtml" &&
        !el.multiple &&
        !(el.size > 1) &&
        !el.matches(":disabled")
      );
    } catch (error) {
      return false;
    }
  };

  const groupOf = option => {
    const parent = option.parentElement;
    return parent && parent.localName === "optgroup" ? parent : null;
  };

  const optionDisabled = option => {
    const group = groupOf(option);
    return !!(option.disabled || (group && group.disabled));
  };

  const hostWindow = () => {
    try {
      let view = window;
      for (let i = 0; i < MAX_DEPTH; i++) {
        if (view.parent === view) return view;
        const frame = view.frameElement;
        if (!frame) return null;
        view = frame.ownerDocument.defaultView;
        if (!view) return null;
      }
    } catch (error) {}
    return null;
  };

  const rectOf = el => {
    const box = el.getBoundingClientRect();
    let x = box.left;
    let y = box.top;
    let view = el.ownerDocument.defaultView;
    for (let i = 0; view !== window; i++) {
      if (!view || i >= MAX_DEPTH) return null;
      const frame = view.frameElement;
      if (!frame) return null;
      const outer = frame.getBoundingClientRect();
      x += outer.left + frame.clientLeft;
      y += outer.top + frame.clientTop;
      view = frame.ownerDocument.defaultView;
    }
    return { x, y, width: box.width, height: box.height };
  };

  const open = el => {
    try {
      if (!qualifies(el)) return;
      const notify = window.${SELECT_BINDING_NAME};
      if (typeof notify !== "function") return;
      const rect = rectOf(el);
      if (!rect) return;
      const all = el.options;
      const count = Math.min(all.length, MAX_OPTIONS);
      if (count === 0) return;
      const options = [];
      for (let i = 0; i < count; i++) {
        const option = all[i];
        const group = groupOf(option);
        options.push({
          label: String(option.label || option.text).slice(0, MAX_LABEL),
          disabled: optionDisabled(option),
          group: group ? String(group.label).slice(0, MAX_LABEL) : null
        });
      }
      const stale = [];
      opened.forEach((entry, key) => {
        if (entry.el === el) stale.push(key);
      });
      stale.forEach(key => opened.delete(key));
      while (opened.size >= MAX_OPEN) opened.delete(opened.keys().next().value);
      const id = nextId++;
      opened.set(id, { el, length: all.length });
      const selected = el.selectedIndex;
      notify(
        JSON.stringify({
          id,
          options,
          selectedIndex: selected >= 0 && selected < count ? selected : -1,
          rect
        })
      );
    } catch (error) {}
  };

  const choose = (id, index) => {
    try {
      if (!Number.isInteger(id) || !Number.isInteger(index)) return false;
      const entry = opened.get(id);
      if (!entry) return false;
      opened.delete(id);
      const el = entry.el;
      if (!qualifies(el) || el.options.length !== entry.length) return false;
      if (index < 0 || index >= el.options.length) return false;
      if (optionDisabled(el.options[index])) return false;
      if (el.selectedIndex === index) return false;
      el.selectedIndex = index;
      const view = el.ownerDocument.defaultView || window;
      el.dispatchEvent(new view.Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new view.Event("change", { bubbles: true }));
      return true;
    } catch (error) {
      return false;
    }
  };

  const cancel = id => {
    try {
      return opened.delete(id);
    } catch (error) {
      return false;
    }
  };

  const targetOf = event => {
    try {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      let el = path.length > 0 ? path[0] : event.target;
      if (
        el &&
        el.nodeType === 1 &&
        (el.localName === "option" || el.localName === "optgroup")
      ) {
        el = el.closest("select");
      }
      return qualifies(el) ? el : null;
    } catch (error) {
      return null;
    }
  };

  const intercept = (event, el) => {
    event.preventDefault();
    try {
      el.focus();
    } catch (error) {}
    try {
      const host = hostWindow();
      const pass = host && host.${OPEN_NAME};
      if (typeof pass === "function") pass(el);
    } catch (error) {}
  };

  const expose = (name, value) => {
    try {
      Object.defineProperty(window, name, { value });
    } catch (error) {}
  };
  expose("${OPEN_NAME}", open);
  expose("${CHOOSE_NAME}", choose);
  expose("${CANCEL_NAME}", cancel);

  window.addEventListener(
    "mousedown",
    event => {
      if (event.button !== 0) return;
      const el = targetOf(event);
      if (el) intercept(event, el);
    },
    true
  );
  window.addEventListener(
    "keydown",
    event => {
      const key = event.key;
      const arrow = key === "ArrowDown" || key === "ArrowUp";
      if (arrow ? !event.altKey : key !== " " && key !== "Enter" && key !== "F4") {
        return;
      }
      const el = targetOf(event);
      if (el) intercept(event, el);
    },
    true
  );
})()`;

function integer(value: number, name: string): number {
  if (!Number.isInteger(value)) throw new Error(`${name}が整数ではありません`);
  return value;
}

/**
 * ページで評価する、選ぶ式。埋め込むのは整数2つだけ (ページの中のidと、選択肢の添字)。
 * 整数でなければ投げる。文字列を埋め込むと、ページで任意のスクリプトを動かせてしまう。
 */
export function selectChooseExpression(id: number, index: number): string {
  return `window.${CHOOSE_NAME}(${integer(id, "id")}, ${integer(index, "index")})`;
}

/** ページで評価する、取り消す式。埋め込むのは整数1つだけ */
export function selectCancelExpression(id: number): string {
  return `window.${CANCEL_NAME}(${integer(id, "id")})`;
}

export interface SelectRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** ページから届いた知らせ。`id` はページの中の番号で、視聴者へは渡さない */
export interface SelectPayload {
  id: number;
  options: BrowserSelectOption[];
  selectedIndex: number;
  rect: SelectRect;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readOption(value: unknown): BrowserSelectOption | null {
  if (typeof value !== "object" || value === null) return null;
  const { label, disabled, group } = value as Record<string, unknown>;
  if (typeof label !== "string" || typeof disabled !== "boolean") return null;
  if (group !== null && typeof group !== "string") return null;
  return {
    label: label.slice(0, MAX_LABEL_LENGTH),
    disabled,
    group: group === null ? null : group.slice(0, MAX_LABEL_LENGTH),
  };
}

function readRect(value: unknown): SelectRect | null {
  if (typeof value !== "object" || value === null) return null;
  const { x, y, width, height } = value as Record<string, unknown>;
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(width) ||
    !isFiniteNumber(height)
  ) {
    return null;
  }
  if (width < 0 || height < 0) return null;
  return { x, y, width, height };
}

/**
 * bindingのペイロードを読む。形が違えば `null`。ページのどのスクリプトからも送れる
 * 文字列なので、知っている列だけを写し、ラベルと見出しは切り詰める。
 */
export function parseSelectPayload(raw: string): SelectPayload | null {
  if (typeof raw !== "string" || raw.length > MAX_PAYLOAD_LENGTH) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const p = value as Record<string, unknown>;
  if (typeof p.id !== "number" || !Number.isSafeInteger(p.id) || p.id < 0) {
    return null;
  }
  if (
    !Array.isArray(p.options) ||
    p.options.length < 1 ||
    p.options.length > MAX_OPTIONS
  ) {
    return null;
  }
  const options: BrowserSelectOption[] = [];
  for (const item of p.options) {
    const option = readOption(item);
    if (!option) return null;
    options.push(option);
  }
  const selectedIndex = p.selectedIndex;
  if (
    typeof selectedIndex !== "number" ||
    !Number.isInteger(selectedIndex) ||
    selectedIndex < -1 ||
    selectedIndex >= options.length
  ) {
    return null;
  }
  const rect = readRect(p.rect);
  if (!rect) return null;
  return { id: p.id, options, selectedIndex, rect };
}

/** 矩形を、ビューポートに収まる部分へ切る。外にあれば、端に寄せた幅0、高さ0の矩形になる */
export function clampSelectRect(
  rect: SelectRect,
  viewport: { width: number; height: number }
): SelectRect {
  const clamp = (value: number, max: number) =>
    Math.min(max, Math.max(0, value));
  const left = clamp(rect.x, viewport.width);
  const top = clamp(rect.y, viewport.height);
  return {
    x: left,
    y: top,
    width: clamp(rect.x + rect.width, viewport.width) - left,
    height: clamp(rect.y + rect.height, viewport.height) - top,
  };
}
