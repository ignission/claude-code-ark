// @vitest-environment jsdom

import type { ManagedSession, Worktree } from "@ark/shared";
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionListEntry } from "@/lib/session-sections";
import { SessionRowMenu, type SessionRowMenuProps } from "./SessionRowMenu";

// Radixのメニューはjsdomで開けないため、部品を素の要素に置き換える
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenuGroup: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    onSelect,
    variant,
    ...rest
  }: {
    children?: ReactNode;
    onSelect?: (event: Event) => void;
    variant?: string;
  }) => (
    <button
      type="button"
      data-menu-item=""
      data-variant={variant}
      {...rest}
      onClick={() => onSelect?.(new Event("select"))}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenuGroup: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  ContextMenuSeparator: () => <hr />,
  ContextMenuItem: ({
    children,
    onSelect,
    variant,
    ...rest
  }: {
    children?: ReactNode;
    onSelect?: (event: Event) => void;
    variant?: string;
  }) => (
    <button
      type="button"
      data-menu-item=""
      data-variant={variant}
      {...rest}
      onClick={() => onSelect?.(new Event("select"))}
    >
      {children}
    </button>
  ),
}));

const repoPath = "/work/app";
const worktree: Worktree = {
  id: "wt-1",
  path: `${repoPath}/.worktrees/login`,
  branch: "feature/login",
  commit: "abc1234",
  isMain: false,
  isBare: false,
};
const session: ManagedSession = {
  id: "session-1",
  worktreeId: worktree.id,
  worktreePath: worktree.path,
  repoPath,
  status: "active",
  createdAt: new Date("2026-09-17T00:00:00Z"),
  tmuxSessionName: "ark-session-1",
  ttydPort: 7680,
  ttydUrl: "/ttyd/session-1/",
};
function entryOf(overrides: Partial<SessionListEntry> = {}): SessionListEntry {
  return {
    key: `wt:${worktree.id}`,
    worktree,
    session,
    repoPath,
    repoName: "app",
    disambiguator: null,
    statusKey: "IDLE",
    ...overrides,
  };
}

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

function fullMenuProps(): Omit<SessionRowMenuProps, "variant"> {
  return {
    entry: entryOf(),
    onOpen: vi.fn(),
    onStartRename: vi.fn(),
    onRestart: vi.fn(),
    onDelete: vi.fn(),
  };
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

describe("SessionRowMenu", () => {
  it("セッションのある行: 開く・表示名・再起動、最下段に赤い削除を並べる (リポジトリの操作は見出しにある)", () => {
    const container = mount(
      <SessionRowMenu variant="dropdown" {...fullMenuProps()} />
    );

    expect(itemLabels(container)).toEqual([
      "開く",
      "表示名を変更",
      "再起動",
      "セッションを削除",
    ]);
    expect(
      container.querySelector('[data-menu-item][data-variant="destructive"]')
        ?.textContent
    ).toBe("セッションを削除");
  });

  it("右クリックのメニューにも同じ中身を出す", () => {
    const container = mount(
      <SessionRowMenu variant="context" {...fullMenuProps()} />
    );

    expect(itemLabels(container)).toEqual([
      "開く",
      "表示名を変更",
      "再起動",
      "セッションを削除",
    ]);
  });

  it("操作が渡されなかった項目と区切りは出さない", () => {
    const container = mount(
      <SessionRowMenu variant="dropdown" entry={entryOf()} onOpen={vi.fn()} />
    );

    expect(itemLabels(container)).toEqual(["開く"]);
    expect(container.querySelector("hr")).toBeNull();
  });

  it("未起動のworktreeの行: 「セッションを起動」と「Worktreeを削除」にする", () => {
    const onOpen = vi.fn();
    const container = mount(
      <SessionRowMenu
        variant="dropdown"
        entry={entryOf({ session: null, statusKey: "NOT_STARTED" })}
        onOpen={onOpen}
        onDelete={vi.fn()}
      />
    );

    expect(itemLabels(container)).toEqual([
      "セッションを起動",
      "Worktreeを削除",
    ]);
    clickItem(container, "セッションを起動");
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("項目を選ぶと対応する操作を呼ぶ", () => {
    const props = fullMenuProps();
    const container = mount(<SessionRowMenu variant="dropdown" {...props} />);

    clickItem(container, "表示名を変更");
    clickItem(container, "再起動");
    clickItem(container, "セッションを削除");

    expect(props.onStartRename).toHaveBeenCalledTimes(1);
    expect(props.onRestart).toHaveBeenCalledTimes(1);
    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

  it("子タスクの分離は「開く」の直後に出し、選ぶと呼ぶ", () => {
    const onSplitTask = vi.fn();
    const container = mount(
      <SessionRowMenu
        variant="context"
        entry={entryOf()}
        onOpen={vi.fn()}
        onSplitTask={onSplitTask}
        onStartRename={vi.fn()}
      />
    );

    expect(itemLabels(container)).toEqual([
      "開く",
      "子タスクを分離...",
      "表示名を変更",
    ]);
    clickItem(container, "子タスクを分離...");
    expect(onSplitTask).toHaveBeenCalledTimes(1);
  });
});

describe("SessionRowMenuの休止の項目", () => {
  it("休止していなければ「休止にする」、手動で休止にしていれば「休止から戻す」を出し、選ぶと反転した値を渡す", () => {
    const onChange = vi.fn();
    const resting = mount(
      <SessionRowMenu
        variant="dropdown"
        entry={entryOf()}
        onOpen={vi.fn()}
        rest={{ rested: false, onChange }}
      />
    );
    expect(itemLabels(resting)).toContain("休止にする");
    clickItem(resting, "休止にする");

    const rested = mount(
      <SessionRowMenu
        variant="dropdown"
        entry={entryOf()}
        onOpen={vi.fn()}
        rest={{ rested: true, onChange }}
      />
    );
    expect(itemLabels(rested)).toContain("休止から戻す");
    clickItem(rested, "休止から戻す");

    expect(onChange).toHaveBeenNthCalledWith(1, true);
    expect(onChange).toHaveBeenNthCalledWith(2, false);
  });
});
