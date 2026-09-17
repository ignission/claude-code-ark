// @vitest-environment jsdom

import {
  act,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSidebar } from "./SessionSidebar";

const testDoubles = vi.hoisted(() => ({
  sectionList: vi.fn(),
}));

vi.mock("./SessionSectionList", () => ({
  SessionSectionList: (props: Record<string, unknown>) => {
    testDoubles.sectionList(props);
    return <div data-testid="section-list" />;
  },
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
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

function sidebarProps(): ComponentProps<typeof SessionSidebar> {
  return {
    sessions: new Map(),
    worktrees: [],
    repoList: ["/work/app"],
    sessionStatuses: new Map([["session-1", "IDLE"]]),
    sessionPreviews: new Map([["session-1", "どちらにしますか"]]),
    selectedSessionId: "session-1",
    onOpenSession: vi.fn(),
    onStartSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onSelectRepoGrid: vi.fn(),
    onNewSession: vi.fn(),
    onOpenAbout: vi.fn(),
  };
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  testDoubles.sectionList.mockClear();
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("SessionSidebar", () => {
  it("ワードマーク「Ark」のメニューからAboutを開く", () => {
    const props = sidebarProps();
    const container = mount(<SessionSidebar {...props} />);

    expect(
      container.querySelector('button[aria-label="Arkのメニュー"]')?.textContent
    ).toBe("Ark");
    const about = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-menu-item]")
    ).find(item => item.textContent === "About Ark");
    act(() => about?.click());

    expect(props.onOpenAbout).toHaveBeenCalledTimes(1);
  });

  it("一覧をサイドバーの形で描き、一覧のpropsをそのまま渡す", () => {
    const props = sidebarProps();
    mount(<SessionSidebar {...props} />);

    const listProps = testDoubles.sectionList.mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    expect(listProps).toMatchObject({
      variant: "sidebar",
      selectedSessionId: "session-1",
      repoList: ["/work/app"],
    });
    expect(listProps.sessionStatuses).toBe(props.sessionStatuses);
    expect(listProps.sessionPreviews).toBe(props.sessionPreviews);
    expect(listProps.onSelectRepoGrid).toBe(props.onSelectRepoGrid);
    expect(listProps).not.toHaveProperty("onNewSession");
    expect(listProps).not.toHaveProperty("onOpenAbout");
  });
});
