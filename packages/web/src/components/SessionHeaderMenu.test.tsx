// @vitest-environment jsdom

import type { MessageShortcut } from "@ark/shared";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionHeaderMenu,
  type SessionHeaderMenuProps,
} from "./SessionHeaderMenu";

// Radixのメニューはjsdomで開けないため、部品を素の要素に置き換える
vi.mock("@/components/ui/dropdown-menu", () => {
  const Pass = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    DropdownMenu: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuSub: Pass,
    DropdownMenuSubTrigger: Pass,
    DropdownMenuSubContent: ({
      children,
      className,
    }: {
      children?: ReactNode;
      className?: string;
    }) => (
      <div data-menu-sub-content="" className={className}>
        {children}
      </div>
    ),
    DropdownMenuLabel: Pass,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuItem: Pass,
    DropdownMenuCheckboxItem: Pass,
  };
});

vi.mock("./MessageShortcutManagerDialog", () => ({
  MessageShortcutManagerDialog: () => null,
}));

const shortcuts: MessageShortcut[] = Array.from({ length: 30 }, (_, i) => ({
  id: `shortcut-${i}`,
  message: `定型文${i}`,
  sortOrder: i,
  createdAt: 0,
  updatedAt: 0,
}));

function menuProps(): SessionHeaderMenuProps {
  return {
    leftMode: "chat",
    worktree: undefined,
    messageShortcuts: shortcuts,
    onSendMessage: vi.fn(),
    onCreateShortcut: vi.fn(),
    onUpdateShortcut: vi.fn(),
    onDeleteShortcut: vi.fn(),
    notificationsSupported: false,
    notificationsEnabled: false,
    onDeleteSession: vi.fn(),
    onReloadTerminal: vi.fn(),
    inputBarVisible: true,
    onToggleInputBar: vi.fn(),
  };
}

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("SessionHeaderMenu", () => {
  it("メッセージショートカットのサブメニューは画面の高さに収め、はみ出す分はスクロールさせる", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<SessionHeaderMenu {...menuProps()} />));
    mountedRoots.push({ root, container });

    const subContent = container.querySelector("[data-menu-sub-content]");
    expect(subContent?.textContent).toContain("定型文29");
    expect(subContent?.classList).toContain(
      "max-h-(--radix-dropdown-menu-content-available-height)"
    );
    expect(subContent?.classList).toContain("overflow-y-auto");
  });
});
