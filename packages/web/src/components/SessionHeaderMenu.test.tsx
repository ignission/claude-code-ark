// @vitest-environment jsdom

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
    DropdownMenuContent: ({ children }: { children?: ReactNode }) => (
      <div data-menu-content="">{children}</div>
    ),
    DropdownMenuLabel: Pass,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuItem: Pass,
    DropdownMenuCheckboxItem: Pass,
  };
});

function menuProps(
  overrides: Partial<SessionHeaderMenuProps> = {}
): SessionHeaderMenuProps {
  return {
    worktree: undefined,
    notificationsSupported: false,
    notificationsEnabled: false,
    onDeleteSession: vi.fn(),
    ...overrides,
  };
}

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function mount(props: SessionHeaderMenuProps): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<SessionHeaderMenu {...props} />));
  mountedRoots.push({ root, container });
  return container;
}

function menuContent(container: HTMLDivElement): HTMLElement {
  const content = container.querySelector<HTMLElement>("[data-menu-content]");
  expect(content).not.toBeNull();
  return content as HTMLElement;
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

describe("SessionHeaderMenu", () => {
  it("1タップのボタンへ移した操作は残さない", () => {
    const content = menuContent(mount(menuProps()));

    expect(content.textContent).not.toContain("メッセージショートカット");
    expect(content.textContent).not.toContain("ファイルを添付");
    expect(content.textContent).not.toContain("画像を貼り付け");
    expect(content.textContent).not.toContain("端末のバッファをコピー");
    expect(content.textContent).not.toContain("端末を再読み込み");
    expect(content.textContent).not.toContain("入力バー");
  });

  it("残すのはセッション全体の操作だけ (通知と、最下段の削除)", () => {
    const content = menuContent(
      mount(
        menuProps({
          notificationsSupported: true,
          onNotificationsEnabledChange: vi.fn(),
        })
      )
    );

    expect(content.textContent).toContain("このセッションの通知をオンにする");
    expect(content.textContent).toContain("セッションを削除");
    expect(content.lastElementChild?.textContent).toBe("セッションを削除");
  });

  it("出す項目が削除だけのときは、先頭に区切り線を残さない", () => {
    const content = menuContent(mount(menuProps()));

    expect(content.firstElementChild?.tagName).not.toBe("HR");
    expect(content.querySelectorAll("hr")).toHaveLength(0);
  });

  it("通知を出せるときだけ、削除とのあいだに区切り線を引く", () => {
    const content = menuContent(
      mount(
        menuProps({
          notificationsSupported: true,
          onNotificationsEnabledChange: vi.fn(),
        })
      )
    );

    expect(content.querySelectorAll("hr")).toHaveLength(1);
  });
});
