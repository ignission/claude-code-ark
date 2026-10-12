// @vitest-environment jsdom
/// <reference lib="dom" />
/**
 * browser-select-shimのテスト。ページへ入れる文字列そのものを、jsdomの文書の上で
 * 評価して確かめる。bindingは偽物の関数で代用する。
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clampSelectRect,
  parseSelectPayload,
  SELECT_BINDING_NAME,
  SELECT_SHIM_SOURCE,
  selectCancelExpression,
  selectChooseExpression,
} from "./browser-select-shim.js";

type AnyWindow = Window &
  Record<string, unknown> & { eval(source: string): unknown };

const top = window as unknown as AnyWindow;
let binding: ReturnType<typeof vi.fn>;

/** bindingへ最後に渡されたペイロード */
function lastPayload(): {
  id: number;
  options: Array<{ label: string; disabled: boolean; group: string | null }>;
  selectedIndex: number;
  rect: { x: number; y: number; width: number; height: number };
} {
  const call = binding.mock.calls.at(-1);
  if (!call) throw new Error("bindingが呼ばれていません");
  return JSON.parse(call[0] as string);
}

function place(
  el: Element,
  rect: { left: number; top: number; width: number; height: number }
): void {
  el.getBoundingClientRect = () => rect as DOMRect;
}

function mount(html: string, doc: Document = document): HTMLSelectElement {
  const host = doc.createElement("div");
  host.innerHTML = html;
  doc.body.appendChild(host);
  const select = host.querySelector("select");
  if (!select) throw new Error("selectがありません");
  return select;
}

const FRUITS = `<select>
  <option>りんご</option>
  <option selected>みかん</option>
  <option disabled>ぶどう</option>
</select>`;

function mousedown(el: Element, init: MouseEventInit = {}): MouseEvent {
  const view = el.ownerDocument.defaultView as Window & typeof globalThis;
  const event = new view.MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    ...init,
  });
  el.dispatchEvent(event);
  return event;
}

function keydown(el: Element, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...init,
  });
  el.dispatchEvent(event);
  return event;
}

function choose(id: number, index: number): unknown {
  return top.eval(selectChooseExpression(id, index));
}

/** `input` と `change` が届いた順 */
function record(el: Element): string[] {
  const seen: string[] = [];
  for (const type of ["input", "change"]) {
    document.addEventListener(type, event => {
      if (event.target === el) seen.push(type);
    });
  }
  return seen;
}

beforeAll(() => {
  top.eval(SELECT_SHIM_SOURCE);
});

beforeEach(() => {
  document.body.innerHTML = "";
  binding = vi.fn();
  top[SELECT_BINDING_NAME] = binding;
});

describe("SELECT_SHIM_SOURCE", () => {
  it("bundlerの補助関数にもimportにも頼らない", () => {
    expect(SELECT_SHIM_SOURCE).not.toMatch(/__name|\bimport\b|\brequire\b/);
    // ES2017に無い構文を使わない
    expect(SELECT_SHIM_SOURCE).not.toMatch(/\?\.|\?\?|catch\s*\{/);
  });

  it("入れる関数は列挙されない", () => {
    const names = Object.keys(top);
    for (const name of [
      "__arkSelectChoose",
      "__arkSelectCancel",
      "__arkSelectOpen",
    ]) {
      expect(typeof top[name]).toBe("function");
      expect(names).not.toContain(name);
    }
  });

  describe("横取り", () => {
    it("mousedownを止め、フォーカスを当て、選択肢と位置を知らせる", () => {
      const select = mount(FRUITS);
      place(select, { left: 10.5, top: 20, width: 120, height: 24 });
      const event = mousedown(select);
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(select);
      expect(binding).toHaveBeenCalledTimes(1);
      expect(lastPayload()).toEqual({
        id: expect.any(Number),
        options: [
          { label: "りんご", disabled: false, group: null },
          { label: "みかん", disabled: false, group: null },
          { label: "ぶどう", disabled: true, group: null },
        ],
        selectedIndex: 1,
        rect: { x: 10.5, y: 20, width: 120, height: 24 },
      });
    });

    it("開くたびに違うidを付ける", () => {
      const select = mount(FRUITS);
      mousedown(select);
      const first = lastPayload().id;
      mousedown(select);
      expect(lastPayload().id).not.toBe(first);
    });

    it("optgroupの見出しと無効、labelの属性を読む", () => {
      const select = mount(`<select>
        <option label="表示">本文</option>
        <option label="">本文だけ</option>
        <optgroup label="果物"><option>りんご</option></optgroup>
        <optgroup label="止" disabled><option>なし</option></optgroup>
      </select>`);
      mousedown(select);
      expect(lastPayload().options).toEqual([
        { label: "表示", disabled: false, group: null },
        { label: "本文だけ", disabled: false, group: null },
        { label: "りんご", disabled: false, group: "果物" },
        { label: "なし", disabled: true, group: "止" },
      ]);
    });

    it("長いラベルは切り、多すぎる選択肢は先頭だけを知らせる", () => {
      const select = mount("<select></select>");
      for (let i = 0; i < 1001; i++) {
        const option = document.createElement("option");
        option.textContent = i === 0 ? "あ".repeat(600) : `o${i}`;
        select.appendChild(option);
      }
      select.selectedIndex = 1000;
      mousedown(select);
      const payload = lastPayload();
      expect(payload.options).toHaveLength(1000);
      expect(payload.options[0].label).toHaveLength(500);
      expect(payload.selectedIndex).toBe(-1);
    });

    it.each([
      ["multiple", "<select multiple><option>a</option></select>"],
      ["sizeが2以上", '<select size="3"><option>a</option></select>'],
      ["disabled", "<select disabled><option>a</option></select>"],
      [
        "無効なfieldsetの中",
        "<fieldset disabled><select><option>a</option></select></fieldset>",
      ],
    ])("%s は横取りしない", (_name, html) => {
      const select = mount(html);
      const event = mousedown(select);
      expect(event.defaultPrevented).toBe(false);
      expect(binding).not.toHaveBeenCalled();
    });

    it("select以外と、左以外のボタンは横取りしない", () => {
      const select = mount(`${FRUITS}<input>`);
      const input = document.querySelector("input") as HTMLInputElement;
      expect(mousedown(input).defaultPrevented).toBe(false);
      expect(mousedown(select, { button: 2 }).defaultPrevented).toBe(false);
      expect(binding).not.toHaveBeenCalled();
    });

    it("選択肢が無ければ、止めるだけで知らせない", () => {
      const select = mount("<select></select>");
      expect(mousedown(select).defaultPrevented).toBe(true);
      expect(binding).not.toHaveBeenCalled();
    });

    it.each<[string, KeyboardEventInit]>([
      ["Space", { key: " " }],
      ["Enter", { key: "Enter" }],
      ["Alt+ArrowDown", { key: "ArrowDown", altKey: true }],
      ["Alt+ArrowUp", { key: "ArrowUp", altKey: true }],
      ["F4", { key: "F4" }],
    ])("%s のkeydownも横取りする", (_name, init) => {
      const select = mount(FRUITS);
      expect(keydown(select, init).defaultPrevented).toBe(true);
      expect(binding).toHaveBeenCalledTimes(1);
      expect(lastPayload().selectedIndex).toBe(1);
    });

    it.each<[string, KeyboardEventInit]>([
      ["Altの無いArrowDown", { key: "ArrowDown" }],
      ["文字", { key: "a" }],
      ["Tab", { key: "Tab" }],
    ])("%s は横取りしない", (_name, init) => {
      const select = mount(FRUITS);
      expect(keydown(select, init).defaultPrevented).toBe(false);
      expect(binding).not.toHaveBeenCalled();
    });

    it("二重に入れても1回しか反応しない", () => {
      top.eval(SELECT_SHIM_SOURCE);
      top.eval(SELECT_SHIM_SOURCE);
      mousedown(mount(FRUITS));
      expect(binding).toHaveBeenCalledTimes(1);
    });

    it("bindingが投げても、ページへ例外を漏らさない", () => {
      binding.mockImplementation(() => {
        throw new Error("boom");
      });
      const select = mount(FRUITS);
      expect(() => mousedown(select)).not.toThrow();
    });
  });

  describe("選ぶ", () => {
    it("selectedIndexを入れ、input、changeの順に発火する", () => {
      const select = mount(FRUITS);
      const seen = record(select);
      const events: Event[] = [];
      select.addEventListener("input", event => events.push(event));
      select.addEventListener("change", event => events.push(event));
      mousedown(select);
      expect(choose(lastPayload().id, 0)).toBe(true);
      expect(select.selectedIndex).toBe(0);
      // documentまで届く (bubbles)
      expect(seen).toEqual(["input", "change"]);
      expect(events.map(event => event.bubbles)).toEqual([true, true]);
      expect(events[0].composed).toBe(true);
    });

    it("同じ選択肢なら何もしない", () => {
      const select = mount(FRUITS);
      const seen = record(select);
      mousedown(select);
      expect(choose(lastPayload().id, 1)).toBe(false);
      expect(seen).toEqual([]);
    });

    it.each([
      ["範囲外", 3],
      ["負", -1],
      ["無効な選択肢", 2],
    ])("%s の添字は何もしない", (_name, index) => {
      const select = mount(FRUITS);
      const seen = record(select);
      mousedown(select);
      expect(choose(lastPayload().id, index)).toBe(false);
      expect(select.selectedIndex).toBe(1);
      expect(seen).toEqual([]);
    });

    it("無効なoptgroupの中の選択肢は選ばない", () => {
      const select = mount(`<select>
        <option>a</option>
        <optgroup label="g" disabled><option>b</option></optgroup>
      </select>`);
      mousedown(select);
      expect(choose(lastPayload().id, 1)).toBe(false);
      expect(select.selectedIndex).toBe(0);
    });

    it("知らないidと、整数でない引数は何もしない", () => {
      const select = mount(FRUITS);
      mousedown(select);
      const { id } = lastPayload();
      const fn = top.__arkSelectChoose as (...args: unknown[]) => unknown;
      expect(fn(id + 1000, 0)).toBe(false);
      expect(fn(String(id), 0)).toBe(false);
      expect(fn(id, 0.5)).toBe(false);
      expect(fn(id, "0")).toBe(false);
      expect(fn()).toBe(false);
      expect(select.selectedIndex).toBe(1);
      // 整数でない引数では、覚えた要素を捨てない
      expect(fn(id, 0)).toBe(true);
    });

    it("一度選んだidは、もう使えない", () => {
      const select = mount(FRUITS);
      mousedown(select);
      const { id } = lastPayload();
      expect(choose(id, 0)).toBe(true);
      expect(choose(id, 1)).toBe(false);
      expect(select.selectedIndex).toBe(0);
    });

    it("取り消したidは、もう使えない", () => {
      const select = mount(FRUITS);
      mousedown(select);
      const { id } = lastPayload();
      top.eval(selectCancelExpression(id));
      expect(choose(id, 0)).toBe(false);
      expect(select.selectedIndex).toBe(1);
    });

    it("知らせたあとに選択肢の数が変わっていたら選ばない", () => {
      const select = mount(`<select>
        <option>a</option>
        <option selected>b</option>
        <option>c</option>
      </select>`);
      const seen = record(select);
      mousedown(select);
      // 添字1は、知らせたときは「b」だったが、いまは「c」を指す
      select.remove(0);
      expect(choose(lastPayload().id, 1)).toBe(false);
      expect(select.value).toBe("b");
      expect(seen).toEqual([]);
    });

    it("知らせたあとに無効になったselectは選ばない", () => {
      const select = mount(FRUITS);
      mousedown(select);
      select.disabled = true;
      expect(choose(lastPayload().id, 0)).toBe(false);
      expect(select.selectedIndex).toBe(1);
    });

    it("覚える要素は32個まで。古いものから捨てる", () => {
      const first = mount(FRUITS);
      mousedown(first);
      const firstId = lastPayload().id;
      const selects = Array.from({ length: 32 }, () => mount(FRUITS));
      for (const select of selects) mousedown(select);
      const lastId = lastPayload().id;
      expect(choose(firstId, 0)).toBe(false);
      expect(first.selectedIndex).toBe(1);
      expect(choose(lastId, 0)).toBe(true);
    });

    it("同じ要素を開き直したら、前のidは使えない", () => {
      const select = mount(FRUITS);
      mousedown(select);
      const old = lastPayload().id;
      mousedown(select);
      expect(choose(old, 0)).toBe(false);
      expect(choose(lastPayload().id, 0)).toBe(true);
    });
  });

  describe("iframeの中", () => {
    function frame(): { iframe: HTMLIFrameElement; child: AnyWindow } {
      const iframe = document.createElement("iframe");
      document.body.appendChild(iframe);
      const child = iframe.contentWindow as unknown as AnyWindow;
      child.eval(SELECT_SHIM_SOURCE);
      return { iframe, child };
    }

    it("位置をいちばん上の文書の座標へ直し、いちばん上の関数で選べる", () => {
      const { iframe, child } = frame();
      place(iframe, { left: 100, top: 200, width: 300, height: 150 });
      const select = mount(FRUITS, child.document);
      place(select, { left: 5, top: 7, width: 80, height: 20 });
      const childBinding = vi.fn();
      child[SELECT_BINDING_NAME] = childBinding;
      const event = mousedown(select);
      expect(event.defaultPrevented).toBe(true);
      expect(childBinding).not.toHaveBeenCalled();
      expect(binding).toHaveBeenCalledTimes(1);
      expect(lastPayload().rect).toEqual({
        x: 105,
        y: 207,
        width: 80,
        height: 20,
      });
      expect(lastPayload().options).toHaveLength(3);
      expect(choose(lastPayload().id, 0)).toBe(true);
      expect(select.selectedIndex).toBe(0);
    });

    it("親の文書に届かないiframeでは、止めるだけで知らせない", () => {
      const { child } = frame();
      // 別オリジンの親を持つフレームでは `frameElement` が `null` になる
      Object.defineProperty(child, "frameElement", {
        value: null,
        configurable: true,
      });
      const select = mount(FRUITS, child.document);
      const childBinding = vi.fn();
      child[SELECT_BINDING_NAME] = childBinding;
      const event = mousedown(select);
      expect(event.defaultPrevented).toBe(true);
      expect(binding).not.toHaveBeenCalled();
      expect(childBinding).not.toHaveBeenCalled();
    });
  });
});

describe("selectChooseExpression / selectCancelExpression", () => {
  it("数だけを埋めた固定の式になる", () => {
    expect(selectChooseExpression(3, 12)).toBe(
      "window.__arkSelectChoose(3, 12)"
    );
    expect(selectCancelExpression(3)).toBe("window.__arkSelectCancel(3)");
  });

  it.each([
    [1.5, 0],
    [0, Number.NaN],
    [Number.POSITIVE_INFINITY, 0],
    ["1" as unknown as number, 0],
    [0, "0); alert(1" as unknown as number],
  ])("整数でない引数 (%j, %j) では投げる", (id, index) => {
    expect(() => selectChooseExpression(id, index)).toThrow();
  });

  it("整数でないidの取り消しは投げる", () => {
    expect(() => selectCancelExpression("1" as unknown as number)).toThrow();
  });
});

describe("parseSelectPayload", () => {
  const valid = {
    id: 4,
    options: [
      { label: "a", disabled: false, group: null },
      { label: "b", disabled: true, group: "g" },
    ],
    selectedIndex: 1,
    rect: { x: 1, y: 2, width: 30, height: 4 },
  };
  const parse = (value: unknown) => parseSelectPayload(JSON.stringify(value));

  it("正しい形を通し、知っている列だけを写す", () => {
    expect(parse(valid)).toEqual(valid);
    expect(
      parse({
        ...valid,
        extra: 1,
        options: [{ label: "a", disabled: false, group: null, value: "x" }],
        selectedIndex: -1,
        rect: { ...valid.rect, right: 9 },
      })
    ).toEqual({
      id: 4,
      options: [{ label: "a", disabled: false, group: null }],
      selectedIndex: -1,
      rect: valid.rect,
    });
  });

  it("ラベルと見出しは500文字で切る", () => {
    const parsed = parse({
      ...valid,
      options: [
        { label: "x".repeat(501), disabled: false, group: "g".repeat(501) },
      ],
      selectedIndex: 0,
    });
    expect(parsed?.options[0].label).toHaveLength(500);
    expect(parsed?.options[0].group).toHaveLength(500);
  });

  it("選択肢は1,000個まで", () => {
    const options = (count: number) =>
      Array.from({ length: count }, () => valid.options[0]);
    expect(
      parse({ ...valid, options: options(1000), selectedIndex: 0 })?.options
    ).toHaveLength(1000);
    expect(
      parse({ ...valid, options: options(1001), selectedIndex: 0 })
    ).toBeNull();
    expect(parse({ ...valid, options: [], selectedIndex: -1 })).toBeNull();
  });

  it.each([
    ["JSONでない", "{"],
    ["オブジェクトでない", "1"],
    ["null", "null"],
    ["配列", "[]"],
  ])("%s 文字列を捨てる", (_name, raw) => {
    expect(parseSelectPayload(raw)).toBeNull();
  });

  it("大きすぎる文字列は読まずに捨てる", () => {
    const raw = JSON.stringify({
      ...valid,
      options: [{ label: "x".repeat(2_000_000), disabled: false, group: null }],
      selectedIndex: 0,
    });
    expect(parseSelectPayload(raw)).toBeNull();
  });

  it("文字列でないものを捨てる", () => {
    expect(parseSelectPayload(valid as unknown as string)).toBeNull();
  });

  it.each([
    [{ ...valid, id: -1 }],
    [{ ...valid, id: 1.5 }],
    [{ ...valid, id: "1" }],
    [{ ...valid, options: "x" }],
    [{ ...valid, options: [null, valid.options[1]] }],
    [{ ...valid, options: [{ label: 1, disabled: false, group: null }] }],
    [{ ...valid, options: [{ label: "a", disabled: 0, group: null }] }],
    [{ ...valid, options: [{ label: "a", disabled: false, group: 1 }] }],
    [{ ...valid, options: [{ label: "a", disabled: false }] }],
    [{ ...valid, selectedIndex: 2 }],
    [{ ...valid, selectedIndex: -2 }],
    [{ ...valid, selectedIndex: 0.5 }],
    [{ ...valid, selectedIndex: "0" }],
    [{ ...valid, rect: null }],
    [{ ...valid, rect: { x: 1, y: 2, width: 3 } }],
    [{ ...valid, rect: { x: "1", y: 2, width: 3, height: 4 } }],
    [{ ...valid, rect: { x: 1, y: 2, width: -3, height: 4 } }],
    [{ ...valid, rect: { x: 1, y: 2, width: 3, height: -4 } }],
  ])("%j を捨てる", value => {
    expect(parse(value)).toBeNull();
  });

  it("有限でない数を捨てる", () => {
    expect(
      parseSelectPayload(
        '{"id":1,"options":[{"label":"a","disabled":false,"group":null}],"selectedIndex":0,"rect":{"x":1e999,"y":0,"width":1,"height":1}}'
      )
    ).toBeNull();
  });
});

describe("clampSelectRect", () => {
  const viewport = { width: 800, height: 600 };

  it("ビューポートの中の矩形は変えない", () => {
    const rect = { x: 10, y: 20, width: 100, height: 24 };
    expect(clampSelectRect(rect, viewport)).toEqual(rect);
  });

  it("はみ出たぶんを切る", () => {
    expect(
      clampSelectRect({ x: -30, y: 590, width: 100, height: 24 }, viewport)
    ).toEqual({ x: 0, y: 590, width: 70, height: 10 });
  });

  it("すっかり外にある矩形は、端に寄せた幅0、高さ0の矩形にする", () => {
    expect(
      clampSelectRect({ x: 5000, y: -900, width: 100, height: 24 }, viewport)
    ).toEqual({ x: 800, y: 0, width: 0, height: 0 });
  });
});
