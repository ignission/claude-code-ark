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
    expect(dialog?.hasAttribute("data-keynav-nonmodal")).toBe(true);
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

  it("窓の外 (暗くした部分) を押すと閉じ、窓の中を押しても閉じない", () => {
    const onClose = vi.fn();
    const { container } = mount({ open: true, onClose });

    pointerDown(content(container));
    pointerDown(windowEl(container));
    pointerDown(windowEl(container)?.querySelector("h2") ?? null);
    expect(onClose).not.toHaveBeenCalled();

    pointerDown(backdrop(container));
    expect(onClose).toHaveBeenCalledTimes(1);
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
});
