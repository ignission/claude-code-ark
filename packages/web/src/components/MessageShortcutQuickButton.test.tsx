// @vitest-environment jsdom

import type { MessageShortcut } from "@ark/shared";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageShortcutQuickButton } from "./MessageShortcutQuickButton";

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function mount(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mountedRoots.push({ root, container });
  return container;
}

/**
 * Radix の DropdownMenuTrigger は pointerdown で開くため、素の click() だけでは
 * 開かない (jsdom で確認済み)。開いた内容は Portal で document.body 直下に出る。
 */
function openDropdown(trigger: Element | null | undefined): void {
  expect(trigger).not.toBeNull();
  expect(trigger).toBeDefined();
  act(() => {
    (trigger as HTMLElement).dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true })
    );
    (trigger as HTMLElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true })
    );
  });
}

function shortcut(id: string, message: string): MessageShortcut {
  return { id, message, sortOrder: 0, createdAt: 0, updatedAt: 0 };
}

const many: MessageShortcut[] = Array.from({ length: 30 }, (_, i) =>
  shortcut(`shortcut-${i}`, `定型文${i}`)
);

function menuItems(): HTMLElement[] {
  return Array.from(
    document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
  );
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("MessageShortcutQuickButton", () => {
  it("`…` を開かず、ボタン1つで一覧まで届く", () => {
    const container = mount(
      <MessageShortcutQuickButton
        shortcuts={many}
        onSendMessage={vi.fn()}
        onManage={vi.fn()}
      />
    );
    const trigger = container.querySelector(
      'button[aria-label="メッセージのショートカット"]'
    );

    openDropdown(trigger);

    const menu = document.body.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain("定型文0");
    expect(menu?.textContent).toContain("定型文29");
  });

  it("選ぶと、切り詰めていない本文を送る", () => {
    const onSendMessage = vi.fn();
    const long = `${"あ".repeat(60)}\n2行目`;
    const container = mount(
      <MessageShortcutQuickButton
        shortcuts={[shortcut("sc-1", long)]}
        onSendMessage={onSendMessage}
        onManage={vi.fn()}
      />
    );

    openDropdown(
      container.querySelector('button[aria-label="メッセージのショートカット"]')
    );
    const item = menuItems().find(el => el.textContent?.startsWith("あ"));
    act(() => item?.click());

    expect(onSendMessage).toHaveBeenCalledWith(long);
  });

  it("ショートカットが無ければ、その旨と管理だけを出す", () => {
    const onManage = vi.fn();
    const container = mount(
      <MessageShortcutQuickButton
        shortcuts={[]}
        onSendMessage={vi.fn()}
        onManage={onManage}
      />
    );

    openDropdown(
      container.querySelector('button[aria-label="メッセージのショートカット"]')
    );
    const menu = document.body.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain("ショートカットがありません");

    const manage = menuItems().find(
      el => el.textContent === "ショートカットを管理"
    );
    act(() => manage?.click());
    expect(onManage).toHaveBeenCalledTimes(1);
  });
});
