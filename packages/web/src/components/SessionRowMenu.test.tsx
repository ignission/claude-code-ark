// @vitest-environment jsdom

import type { ManagedSession, Profile, Worktree } from "@ark/shared";
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
  DropdownMenuSub: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSubContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSubTrigger: ({ children }: { children?: ReactNode }) => (
    <div data-menu-sub-trigger="">{children}</div>
  ),
  DropdownMenuLabel: ({ children }: { children?: ReactNode }) => (
    <div data-menu-label="">{children}</div>
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
  ContextMenuSub: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  ContextMenuSubContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  ContextMenuSubTrigger: ({ children }: { children?: ReactNode }) => (
    <div data-menu-sub-trigger="">{children}</div>
  ),
  ContextMenuLabel: ({ children }: { children?: ReactNode }) => (
    <div data-menu-label="">{children}</div>
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
const profiles: Profile[] = [
  {
    id: "p-work",
    name: "仕事",
    configDir: "/home/me/.claude-work",
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "p-home",
    name: "個人",
    configDir: "/home/me/.claude-home",
    createdAt: 0,
    updatedAt: 0,
  },
];

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
    notifications: { enabled: true, onChange: vi.fn() },
    onRestart: vi.fn(),
    onCreateWorktree: vi.fn(),
    onOpenRepoGrid: vi.fn(),
    onRemoveRepo: vi.fn(),
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
  it("セッションのある行: 開く・表示名・通知・再起動、リポジトリの操作、最下段に赤い削除を並べる", () => {
    const container = mount(
      <SessionRowMenu variant="dropdown" {...fullMenuProps()} />
    );

    expect(itemLabels(container)).toEqual([
      "開く",
      "表示名を変更",
      "通知をオフにする",
      "再起動",
      "新規worktreeを作成",
      "このリポジトリの全セッションを並べて見る",
      "サイドバーから除外",
      "セッションを削除",
    ]);
    expect(container.querySelector("[data-menu-label]")?.textContent).toBe(
      "リポジトリ"
    );
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
      "通知をオフにする",
      "再起動",
      "新規worktreeを作成",
      "このリポジトリの全セッションを並べて見る",
      "サイドバーから除外",
      "セッションを削除",
    ]);
  });

  it("操作が渡されなかった項目とリポジトリの見出しは出さない", () => {
    const container = mount(
      <SessionRowMenu variant="dropdown" entry={entryOf()} onOpen={vi.fn()} />
    );

    expect(itemLabels(container)).toEqual(["開く"]);
    expect(container.querySelector("[data-menu-label]")).toBeNull();
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
    clickItem(container, "通知をオフにする");
    clickItem(container, "再起動");
    clickItem(container, "新規worktreeを作成");
    clickItem(container, "このリポジトリの全セッションを並べて見る");
    clickItem(container, "サイドバーから除外");
    clickItem(container, "セッションを削除");

    expect(props.onStartRename).toHaveBeenCalledTimes(1);
    expect(props.notifications?.onChange).toHaveBeenCalledWith(false);
    expect(props.onRestart).toHaveBeenCalledTimes(1);
    expect(props.onCreateWorktree).toHaveBeenCalledTimes(1);
    expect(props.onOpenRepoGrid).toHaveBeenCalledTimes(1);
    expect(props.onRemoveRepo).toHaveBeenCalledTimes(1);
    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

  it("このworktreeのプロファイル: 個別の選択と「リポジトリの設定を継承」を出す", () => {
    const onSelect = vi.fn();
    const onOpenProfileManager = vi.fn();
    const container = mount(
      <SessionRowMenu
        variant="dropdown"
        entry={entryOf()}
        onOpen={vi.fn()}
        worktreeProfile={{
          profiles,
          currentProfileId: "p-home",
          inheritedProfileName: "仕事",
          onSelect,
        }}
        onOpenProfileManager={onOpenProfileManager}
      />
    );

    expect(
      container.querySelector("[data-menu-sub-trigger]")?.textContent
    ).toBe("このworktreeのプロファイル");
    expect(itemLabels(container)).toEqual([
      "開く",
      "仕事",
      "個人",
      "リポジトリの設定を継承 (仕事)",
      "プロファイル管理を開く...",
    ]);
    expect(
      container.querySelector('[data-menu-item][data-current="true"]')
        ?.textContent
    ).toBe("個人");

    clickItem(container, "リポジトリの設定を継承 (仕事)");
    clickItem(container, "仕事");
    clickItem(container, "プロファイル管理を開く...");

    expect(onSelect).toHaveBeenNthCalledWith(1, null);
    expect(onSelect).toHaveBeenNthCalledWith(2, "p-work");
    expect(onOpenProfileManager).toHaveBeenCalledTimes(1);
  });

  it("リポジトリの既定プロファイル: 「既定 (~/.claude)」で解除できる", () => {
    const onSelect = vi.fn();
    const container = mount(
      <SessionRowMenu
        variant="dropdown"
        entry={entryOf()}
        onOpen={vi.fn()}
        repoProfile={{ profiles, currentProfileId: null, onSelect }}
      />
    );

    expect(
      container.querySelector("[data-menu-sub-trigger]")?.textContent
    ).toBe("リポジトリの既定プロファイル");
    expect(
      container.querySelector('[data-menu-item][data-current="true"]')
        ?.textContent
    ).toBe("既定 (~/.claude)");

    clickItem(container, "個人");
    clickItem(container, "既定 (~/.claude)");

    expect(onSelect).toHaveBeenNthCalledWith(1, "p-home");
    expect(onSelect).toHaveBeenNthCalledWith(2, null);
  });
});
