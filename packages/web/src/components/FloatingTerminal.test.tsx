// @vitest-environment jsdom

import { act, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FloatingTerminal } from "./FloatingTerminal";

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

type Props = ComponentProps<typeof FloatingTerminal>;

function element(overrides: Partial<Props> = {}): ReactElement {
  return (
    <div className="relative">
      <FloatingTerminal open={false} onClose={vi.fn()} {...overrides}>
        <iframe title="terminal" data-testid="content" />
      </FloatingTerminal>
    </div>
  );
}

function mount(overrides: Partial<Props> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element(overrides)));
  mountedRoots.push({ root, container });
  return {
    container,
    rerender: (next: Partial<Props>) => act(() => root.render(element(next))),
  };
}

const backdrop = (scope: ParentNode) =>
  scope.querySelector<HTMLElement>('[data-testid="floating-terminal"]');
const windowEl = (scope: ParentNode) =>
  scope.querySelector<HTMLElement>('[data-testid="floating-terminal-window"]');
const content = (scope: ParentNode) =>
  scope.querySelector<HTMLElement>('[data-testid="content"]');
const pointerDown = (target: Element | null) =>
  act(() => {
    target?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  });
/** 押して離す (pointerdown → click)。button は押したボタン (0 = 主ボタン) */
const press = (target: Element | null, button = 0) =>
  act(() => {
    target?.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button })
    );
    target?.dispatchEvent(
      new MouseEvent(button === 0 ? "click" : "auxclick", {
        bubbles: true,
        button,
      })
    );
  });

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("FloatingTerminal", () => {
  it("閉じている間も中身をマウントしたまま、hidden で隠す", () => {
    const { container } = mount();

    expect(content(container)).not.toBeNull();
    expect(content(container)?.closest(".hidden")).toBe(backdrop(container));
    // 隠れている間はダイアログとして数えさせない
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("開閉しても中身の要素は同じまま (作り直さず、親も付け替えない)", () => {
    const { container, rerender } = mount();
    const before = content(container);
    const parentBefore = before?.parentElement;

    rerender({ open: true });
    expect(content(container)).toBe(before);
    expect(content(container)?.parentElement).toBe(parentBefore);
    expect(content(container)?.closest(".hidden")).toBeNull();

    rerender({ open: false });
    expect(content(container)).toBe(before);
    expect(content(container)?.parentElement).toBe(parentBefore);
    expect(content(container)?.closest(".hidden")).not.toBeNull();
  });

  it("開いている間は、見出しと閉じるボタンを持つダイアログになる", () => {
    const { container } = mount({ open: true });
    const dialog = container.querySelector('[role="dialog"]');

    expect(dialog).toBe(windowEl(container));
    expect(dialog?.getAttribute("aria-label")).toBe("端末");
    // モーダルではない
    expect(dialog?.hasAttribute("aria-modal")).toBe(false);
    expect(dialog?.querySelector("h2")?.textContent).toBe("端末");
    expect(
      dialog?.querySelector('button[aria-label="端末を閉じる"]')
    ).not.toBeNull();
    // キーボード操作の層に、アプリのダイアログとして数えさせない印
  });

  it("見出しは title で替えられ、actions は閉じるボタンの手前に並ぶ", () => {
    const { container } = mount({
      open: true,
      title: "ログ",
      actions: <button type="button" aria-label="操作" />,
    });
    const dialog = windowEl(container);

    expect(dialog?.getAttribute("aria-label")).toBe("ログ");
    expect(dialog?.querySelector("h2")?.textContent).toBe("ログ");
    const labels = Array.from(dialog?.querySelectorAll("button") ?? []).map(
      button => button.getAttribute("aria-label")
    );
    expect(labels).toEqual(["操作", "端末を閉じる"]);
  });

  it("閉じるボタンで onClose を呼ぶ", () => {
    const onClose = vi.fn();
    const { container } = mount({ open: true, onClose });

    act(() =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="端末を閉じる"]')
        ?.click()
    );

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("窓の外 (暗くした部分) を押して離すと閉じ、窓の中を押しても閉じない", () => {
    const onClose = vi.fn();
    const { container } = mount({ open: true, onClose });

    press(content(container));
    press(windowEl(container));
    press(windowEl(container)?.querySelector("h2") ?? null);
    expect(onClose).not.toHaveBeenCalled();

    press(backdrop(container));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("窓の外を押しただけ (離す前) では閉じない。閉じたあとに click が残らないようにする", () => {
    const onClose = vi.fn();
    const { container } = mount({ open: true, onClose });

    pointerDown(backdrop(container));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("窓の外を右ボタン・中ボタンで押しても閉じない", () => {
    const onClose = vi.fn();
    const { container } = mount({ open: true, onClose });

    press(backdrop(container), 2);
    press(backdrop(container), 1);
    // 主ボタン以外の click が届く環境でも閉じない
    act(() => {
      backdrop(container)?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, button: 2 })
      );
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("窓の中で押し始めて外で離しても閉じない", () => {
    const onClose = vi.fn();
    const { container } = mount({ open: true, onClose });

    // 押し始めと離した場所が違うと、click は共通の祖先 (背景) に届く
    pointerDown(windowEl(container)?.querySelector("h2") ?? null);
    act(() => {
      backdrop(container)?.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("窓そのものがフォーカスを受けられる (端末がまだ無いときのフォーカスの置き場)", () => {
    const { container } = mount({ open: true });
    const win = windowEl(container);

    expect(win?.getAttribute("tabindex")).toBe("-1");
    expect(win?.getAttribute("data-focus-target")).toBe("terminal-window");
    win?.focus();
    expect(document.activeElement).toBe(win);
  });

  it("背景を押したときだけ、mousedown の既定の動き (フォーカスの移動) を止める", () => {
    const { container } = mount({ open: true });
    const down = (target: Element | null) => {
      const event = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        target?.dispatchEvent(event);
      });
      return event.defaultPrevented;
    };

    expect(down(content(container))).toBe(false);
    expect(down(windowEl(container))).toBe(false);
    expect(down(backdrop(container))).toBe(true);
  });

  it("Esc では閉じず、キーを止めもしない", () => {
    const onClose = vi.fn();
    const { container } = mount({ open: true, onClose });
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    const seen = vi.fn();
    document.addEventListener("keydown", seen);

    act(() => {
      content(container)?.dispatchEvent(event);
    });
    document.removeEventListener("keydown", seen);

    expect(onClose).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("開いたあとに onOpened、閉じたあとに onClosed を1回ずつ呼ぶ (マウント時には呼ばない)", () => {
    const onOpened = vi.fn();
    const onClosed = vi.fn();
    const { container, rerender } = mount({ onOpened, onClosed });
    expect(onOpened).not.toHaveBeenCalled();
    expect(onClosed).not.toHaveBeenCalled();

    // 呼ばれた時点で、表示の切り替えは済んでいる
    onOpened.mockImplementation(() => {
      expect(content(container)?.closest(".hidden")).toBeNull();
    });
    onClosed.mockImplementation(() => {
      expect(content(container)?.closest(".hidden")).not.toBeNull();
    });

    rerender({ open: true, onOpened, onClosed });
    expect(onOpened).toHaveBeenCalledTimes(1);
    expect(onClosed).not.toHaveBeenCalled();

    // 開いたままの再描画では呼び直さない (関数が替わっても)
    rerender({ open: true, onOpened: vi.fn(), onClosed });
    expect(onOpened).toHaveBeenCalledTimes(1);

    rerender({ open: false, onOpened, onClosed });
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("window は親の中央に90% x 80% (最小480 x 320、親より大きくしない) で重ねる", () => {
    const { container } = mount({ open: true });

    expect(backdrop(container)?.className).toContain("absolute");
    expect(backdrop(container)?.className).toContain("inset-0");
    expect(backdrop(container)?.className).toContain("items-center");
    expect(backdrop(container)?.className).toContain("justify-center");
    expect(windowEl(container)?.className).toContain(
      "w-[min(100%,max(90%,480px))]"
    );
    expect(windowEl(container)?.className).toContain(
      "h-[min(100%,max(80%,320px))]"
    );
  });

  it("fullscreen は親の全面を埋める", () => {
    const { container } = mount({ open: true, variant: "fullscreen" });

    expect(backdrop(container)?.className).toContain("inset-0");
    expect(windowEl(container)?.className).toContain("h-full");
    expect(windowEl(container)?.className).toContain("w-full");
    expect(windowEl(container)?.className).not.toContain("90%");
  });

  it("fullscreen は上端のバーをノッチの下へずらし、閉じるボタンを指で押せる大きさにする", () => {
    const full = mount({ open: true, variant: "fullscreen" });
    expect(windowEl(full.container)?.className).toContain("safe-area-top");
    expect(windowEl(full.container)?.className).toContain("safe-area-x");
    expect(
      full.container.querySelector('button[aria-label="端末を閉じる"]')
        ?.className
    ).toContain("size-11");

    const win = mount({ open: true });
    expect(windowEl(win.container)?.className).not.toContain("safe-area");
    expect(
      win.container.querySelector('button[aria-label="端末を閉じる"]')
        ?.className
    ).toContain("size-8");
  });
});
