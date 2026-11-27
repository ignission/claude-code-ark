// @vitest-environment jsdom

import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepoHeadingMenu } from "./RepoHeadingMenu";

// Radixのメニューはjsdomで開けないため、部品を素の要素に置き換える (中身は常に描く)
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => (
    <div data-menu-content="">{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children?: ReactNode;
    onSelect?: (event: Event) => void;
  }) => (
    <button
      type="button"
      data-menu-item=""
      onClick={() => onSelect?.(new Event("select"))}
    >
      {children}
    </button>
  ),
}));

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function mount(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mountedRoots.push({ root, container });
  return container;
}

function itemLabels(scope: ParentNode): string[] {
  return Array.from(scope.querySelectorAll("[data-menu-item]")).map(
    element => element.textContent ?? ""
  );
}

function clickItem(scope: ParentNode, label: string): void {
  const item = Array.from(
    scope.querySelectorAll<HTMLButtonElement>("[data-menu-item]")
  ).find(element => element.textContent === label);
  expect(item).toBeDefined();
  act(() => item?.click());
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

describe("RepoHeadingMenu", () => {
  it("「+」でそのリポジトリの新しいタスクを開き、メニューにホーム・作成・表示の操作を並べる", () => {
    const props = {
      onNewTask: vi.fn(),
      onSetHome: vi.fn(),
      onCreateWorktree: vi.fn(),
      onOpenRepoGrid: vi.fn(),
      onRemoveRepo: vi.fn(),
    };
    const container = mount(
      <RepoHeadingMenu variant="sidebar" repoName="app" {...props} />
    );

    expect(itemLabels(container)).toEqual([
      "mainをホームにする",
      "新規worktreeを作成",
      "このリポジトリの全セッションを並べて見る",
      "サイドバーから除外",
    ]);
    const plus = container.querySelector<HTMLButtonElement>(
      'button[aria-label="appで新しいタスク"]'
    );
    expect(plus).not.toBeNull();
    act(() => plus?.click());
    clickItem(container, "mainをホームにする");
    clickItem(container, "新規worktreeを作成");
    clickItem(container, "このリポジトリの全セッションを並べて見る");
    clickItem(container, "サイドバーから除外");

    for (const fn of Object.values(props)) {
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it("操作を渡さなかった項目は出さず、メニューの項目が無ければ `…` も出さない", () => {
    const container = mount(
      <RepoHeadingMenu variant="card" repoName="app" onNewTask={vi.fn()} />
    );

    expect(itemLabels(container)).toEqual([]);
    expect(
      container.querySelector('button[aria-label="appのメニュー"]')
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label="appで新しいタスク"]')
    ).not.toBeNull();
  });
});
