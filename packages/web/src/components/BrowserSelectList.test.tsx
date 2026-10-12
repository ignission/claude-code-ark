// @vitest-environment jsdom

import { act, Profiler, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSelectInfo } from "@/lib/browser-session-state";
import { BrowserSelectList } from "./BrowserSelectList";

const SELECT: BrowserSelectInfo = {
  id: 7,
  options: [
    { label: "選んでください", disabled: true, group: null },
    { label: "赤", disabled: false, group: "暖色" },
    { label: "橙", disabled: true, group: "暖色" },
    { label: "青", disabled: false, group: "寒色" },
    { label: "緑", disabled: false, group: null },
  ],
  selectedIndex: 1,
  rect: { x: 0, y: 0, width: 0, height: 0 },
};

const AREA = { width: 800, height: 600 };
const ANCHOR = { left: 100, top: 50, width: 120, height: 24 };

let root: Root;
let container: HTMLDivElement;
const onChoose = vi.fn<(index: number) => void>();
const onCancel = vi.fn<() => void>();

function render(
  select: BrowserSelectInfo = SELECT,
  anchor = ANCHOR,
  area = AREA
) {
  act(() =>
    root.render(
      <BrowserSelectList
        select={select}
        anchor={anchor}
        area={area}
        onChoose={onChoose}
        onCancel={onCancel}
      />
    )
  );
}

function listbox(): HTMLElement {
  return container.querySelector('[role="listbox"]') as HTMLElement;
}

function options(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[role="option"]')];
}

function active(): string | null | undefined {
  const id = listbox().getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.textContent : null;
}

function press(key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    listbox().dispatchEvent(event);
  });
  return event;
}

function fire(target: EventTarget, type: string) {
  act(() => {
    target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true })
    );
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  onChoose.mockReset();
  onCancel.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("BrowserSelectList", () => {
  it("選択肢をlistboxに並べ、いまの選択を示し、フォーカスを取る", () => {
    render();

    expect(options().map(el => el.textContent)).toEqual([
      "選んでください",
      "赤",
      "橙",
      "青",
      "緑",
    ]);
    expect(options().map(el => el.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
      "false",
      "false",
      "false",
    ]);
    expect(options().map(el => el.getAttribute("aria-disabled"))).toEqual([
      "true",
      "false",
      "true",
      "false",
      "false",
    ]);
    expect(document.activeElement).toBe(listbox());
    expect(active()).toBe("赤");
  });

  it("`group` は、変わるところに選べない見出しとして出す", () => {
    render();
    const headings = [...container.querySelectorAll("[data-select-group]")].map(
      el => el.textContent
    );

    expect(headings).toEqual(["暖色", "寒色"]);
    // listboxの子として数えさせない (選択肢ではない)
    for (const el of container.querySelectorAll("[data-select-group]")) {
      expect(el.getAttribute("role")).toBe("presentation");
    }
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(5);
  });

  it("選択肢を押すと、その添字で選ぶ。無効の選択肢は押せない", () => {
    render();
    fire(options()[2], "click");
    expect(onChoose).not.toHaveBeenCalled();

    fire(options()[3], "click");
    expect(onChoose.mock.calls).toEqual([[3]]);
  });

  it("上下の矢印は無効の選択肢を飛ばし、端で止まる", () => {
    render();
    expect(press("ArrowDown").defaultPrevented).toBe(true);
    expect(active()).toBe("青");
    press("ArrowDown");
    expect(active()).toBe("緑");
    press("ArrowDown");
    expect(active()).toBe("緑");
    press("ArrowUp");
    press("ArrowUp");
    expect(active()).toBe("赤");
    press("ArrowUp");
    expect(active()).toBe("赤");
  });

  it("HomeとEndは、選べる最初と最後へ移る", () => {
    render();
    press("End");
    expect(active()).toBe("緑");
    press("Home");
    expect(active()).toBe("赤");
  });

  it("Enterで、いま指している選択肢を選ぶ", () => {
    render();
    press("ArrowDown");
    const enter = press("Enter");

    expect(enter.defaultPrevented).toBe(true);
    expect(onChoose.mock.calls).toEqual([[3]]);
  });

  it("いまの選択が無効か範囲の外なら、選べる最初の選択肢を指す", () => {
    render({ ...SELECT, selectedIndex: 0 });
    expect(active()).toBe("赤");

    render({ ...SELECT, id: 8, selectedIndex: -1 });
    expect(active()).toBe("赤");
  });

  it("選べる選択肢が無ければ、Enterを押しても選ばない", () => {
    render({
      ...SELECT,
      options: [{ label: "なし", disabled: true, group: null }],
      selectedIndex: 0,
    });
    press("ArrowDown");
    press("Enter");

    expect(onChoose).not.toHaveBeenCalled();
  });

  it("EscapeとTabで取り消す", () => {
    render();
    const pressed = press("Escape");
    press("Tab");

    expect(pressed.defaultPrevented).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("リストの外を押すと取り消し、中を押しても取り消さない", () => {
    render();
    fire(options()[0], "mousedown");
    expect(onCancel).not.toHaveBeenCalled();

    fire(document.body, "mousedown");
    expect(onCancel).toHaveBeenCalledTimes(1);

    act(() => {
      document.body.dispatchEvent(new Event("touchstart", { bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("中を押しても、フォーカスをリストから外さない", () => {
    render();
    const down = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      options()[1].dispatchEvent(down);
    });

    expect(down.defaultPrevented).toBe(true);
  });

  it("`<select>` のすぐ下に、同じ幅以上で、高さを限って出す", () => {
    render();
    const style = listbox().style;

    expect(style.left).toBe("100px");
    expect(style.top).toBe("76px");
    expect(style.bottom).toBe("");
    expect(style.minWidth).toBe("120px");
    expect(style.maxHeight).toBe("320px");
    expect(listbox().className.split(" ")).toContain("overflow-y-auto");
    expect(listbox().hasAttribute("data-browser-overlay")).toBe(true);
  });

  it("下にはみ出すなら、上に出す", () => {
    render(SELECT, { left: 100, top: 560, width: 120, height: 24 });
    const style = listbox().style;

    expect(style.top).toBe("");
    expect(style.bottom).toBe("42px");
  });

  it("アンマウントしたら、外を押しても何もしない", () => {
    render();
    act(() => root.render(null));
    fire(document.body, "mousedown");

    expect(onCancel).not.toHaveBeenCalled();
  });

  it("`aria-selected` はEnterで選ばれる選択肢に付け、ページのいまの選択はチェックで示す", () => {
    render();
    press("ArrowDown");

    expect(options().map(el => el.getAttribute("aria-selected"))).toEqual([
      "false",
      "false",
      "false",
      "true",
      "false",
    ]);
    expect(options().map(el => el.querySelector("svg") !== null)).toEqual([
      false,
      true,
      false,
      false,
      false,
    ]);
  });

  it("マウスを動かしても、指している選択肢を変えず、描き直さない", () => {
    const onRender = vi.fn();
    const many = {
      ...SELECT,
      options: Array.from({ length: 1000 }, (_, i) => ({
        label: `選択肢${i}`,
        disabled: false,
        group: null,
      })),
      selectedIndex: 0,
    };
    act(() =>
      root.render(
        <Profiler id="list" onRender={onRender}>
          <BrowserSelectList
            select={many}
            anchor={ANCHOR}
            area={AREA}
            onChoose={onChoose}
            onCancel={onCancel}
          />
        </Profiler>
      )
    );
    onRender.mockClear();
    for (const index of [5, 6, 7, 500]) fire(options()[index], "mousemove");

    expect(onRender).not.toHaveBeenCalled();
    expect(active()).toBe("選択肢0");
    // 押せば、指している選択肢ではなく、押した選択肢を選ぶ
    fire(options()[500], "click");
    expect(onChoose.mock.calls).toEqual([[500]]);
  });

  it("`shouldTakeFocus` が `false` を返したら、フォーカスを取らない。押せば選べる", () => {
    const outside = document.createElement("input");
    document.body.append(outside);
    outside.focus();
    const shouldTakeFocus = vi.fn(() => false);
    act(() =>
      root.render(
        <BrowserSelectList
          select={SELECT}
          anchor={ANCHOR}
          area={AREA}
          shouldTakeFocus={shouldTakeFocus}
          onChoose={onChoose}
          onCancel={onCancel}
        />
      )
    );

    expect(shouldTakeFocus).toHaveBeenCalled();
    expect(document.activeElement).toBe(outside);
    fire(options()[3], "click");
    expect(onChoose.mock.calls).toEqual([[3]]);
    outside.remove();
  });

  it("右端の近くでは、領域の中へ寄せて、幅を右端までに限る", () => {
    render(SELECT, { left: 750, top: 50, width: 120, height: 24 });
    const style = listbox().style;

    expect(style.left).toBe("680px");
    expect(style.maxWidth).toBe("120px");
  });

  it("上にも下にも置けなければ、領域の中に高さを持たせて出す", () => {
    render(
      SELECT,
      { left: 100, top: 20, width: 120, height: 24 },
      { width: 800, height: 60 }
    );
    const style = listbox().style;

    expect(style.top).toBe("0px");
    expect(style.maxHeight).toBe("60px");
  });

  it("`StrictMode` でも、フォーカスを取り、外を1回押したら1回だけ取り消す", () => {
    act(() =>
      root.render(
        <StrictMode>
          <BrowserSelectList
            select={SELECT}
            anchor={ANCHOR}
            area={AREA}
            onChoose={onChoose}
            onCancel={onCancel}
          />
        </StrictMode>
      )
    );

    expect(document.activeElement).toBe(listbox());
    fire(document.body, "mousedown");
    expect(onCancel).toHaveBeenCalledTimes(1);
    press("ArrowDown");
    press("Enter");
    expect(onChoose.mock.calls).toEqual([[3]]);
  });
});
