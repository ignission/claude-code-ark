// @vitest-environment jsdom

import type { ManagedSession, Profile, Worktree } from "@ark/shared";
import {
  act,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionListEntry } from "@/lib/session-sections";
import { presentStatus } from "@/lib/status-tone";
import { resolveSessionRowProfile, SessionListRow } from "./SessionListRow";

const testDoubles = vi.hoisted(() => ({
  rowMenuVariants: vi.fn(),
  // 最後に描いた行のメニューのonOpenChange。Radixの開閉を代わりに起こす
  menuOpenChanges: {} as Partial<
    Record<"context" | "dropdown", (open: boolean) => void>
  >,
}));

vi.mock("./SessionRowMenu", () => ({
  SessionRowMenu: ({ variant }: { variant: string }) => {
    testDoubles.rowMenuVariants(variant);
    return null;
  },
}));

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({
    children,
    onOpenChange,
  }: {
    children?: ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => {
    testDoubles.menuOpenChanges.context = onOpenChange;
    return <>{children}</>;
  },
  ContextMenuTrigger: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
  ContextMenuContent: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({
    children,
    onOpenChange,
  }: {
    children?: ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => {
    testDoubles.menuOpenChanges.dropdown = onOpenChange;
    return <>{children}</>;
  },
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
}));

const worktree: Worktree = {
  id: "wt-1",
  path: "/work/app/.worktrees/login",
  branch: "feature/login",
  commit: "abc1234",
  isMain: false,
  isBare: false,
};
const session: ManagedSession = {
  id: "session-1",
  worktreeId: worktree.id,
  worktreePath: worktree.path,
  repoPath: "/work/app",
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
    key: "wt:wt-1",
    worktree,
    session,
    repoPath: "/work/app",
    repoName: "app",
    disambiguator: "work",
    statusKey: "IDLE",
    ...overrides,
  };
}

function rowProps(
  overrides: Partial<ComponentProps<typeof SessionListRow>> = {}
): ComponentProps<typeof SessionListRow> {
  return {
    variant: "sidebar",
    entry: entryOf(),
    displayName: null,
    previewText: "テストを実行しています",
    profile: null,
    staleProfile: false,
    selected: false,
    editing: false,
    onEditingChange: vi.fn(),
    onSaveDisplayName: vi.fn(),
    menu: { onOpen: vi.fn() },
    onMenuOpenChange: vi.fn(),
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

/** 行を押せる要素 (data-session-key)。主ラベル・2行目・チップはこの中にある */
function openAreaOf(container: ParentNode): HTMLElement {
  const openArea = container.querySelector<HTMLElement>(
    '[data-session-key="wt:wt-1"]'
  );
  expect(openArea).not.toBeNull();
  return openArea as HTMLElement;
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  act(() => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressKey(
  target: HTMLElement,
  key: string,
  init: KeyboardEventInit = {}
): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, ...init })
    );
  });
}

function editingInput(container: ParentNode): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="表示名を編集"]'
  );
  expect(input).not.toBeNull();
  return input as HTMLInputElement;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  testDoubles.rowMenuVariants.mockClear();
  testDoubles.menuOpenChanges = {};
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("SessionListRowの中身", () => {
  it("表示名が無ければリポジトリ名を主ラベルにし、見分け用の親ディレクトリ名を後ろに添える", () => {
    const openArea = openAreaOf(mount(<SessionListRow {...rowProps()} />));

    expect(openArea.getAttribute("role")).toBe("button");
    expect(openArea.getAttribute("title")).toBe("/work/app");
    const label = openArea.querySelector('[data-testid="session-row-label"]');
    expect(label?.childNodes[0]?.textContent).toBe("app");
    expect(
      label?.querySelector('[data-testid="session-row-disambiguator"]')
        ?.textContent
    ).toBe("work");
    expect(
      openArea.querySelector('[data-testid="session-row-detail"]')?.textContent
    ).toBe("feature/login·テストを実行しています");
    expect(openArea.textContent).toContain(presentStatus("IDLE").label);
  });

  it("表示名があれば主ラベルにし、2行目の先頭にリポジトリ名を足す", () => {
    const openArea = openAreaOf(
      mount(<SessionListRow {...rowProps({ displayName: "ログイン画面" })} />)
    );

    expect(
      openArea.querySelector('[data-testid="session-row-label"]')?.textContent
    ).toBe("ログイン画面");
    expect(
      openArea.querySelector('[data-testid="session-row-detail"]')?.textContent
    ).toBe("appwork·feature/login·テストを実行しています");
  });

  it("プロファイルは未割り当てならチップを出さず、割り当てがあれば名前を、個別の上書きには「個別」を添える", () => {
    const none = openAreaOf(mount(<SessionListRow {...rowProps()} />));
    expect(
      none.querySelector('[data-testid="session-row-profile"]')
    ).toBeNull();

    const inherited = openAreaOf(
      mount(
        <SessionListRow
          {...rowProps({ profile: { name: "仕事", individual: false } })}
        />
      )
    );
    expect(
      inherited.querySelector('[data-testid="session-row-profile"]')
        ?.textContent
    ).toBe("仕事");

    mountedRoots.splice(0).forEach(({ root, container }) => {
      act(() => root.unmount());
      container.remove();
    });
    const individual = openAreaOf(
      mount(
        <SessionListRow
          {...rowProps({ profile: { name: "仕事", individual: true } })}
        />
      )
    );
    expect(
      individual.querySelector('[data-testid="session-row-profile"]')
        ?.textContent
    ).toBe("仕事個別");
  });

  it("古い設定の警告と再起動を出し、再起動は行メニューと同じ操作を呼ぶ", () => {
    const menu = { onOpen: vi.fn(), onRestart: vi.fn() };
    const container = mount(
      <SessionListRow {...rowProps({ staleProfile: true, menu })} />
    );

    expect(container.textContent).toContain("古い設定");
    const restart = Array.from(container.querySelectorAll("button")).find(
      button => button.textContent === "再起動"
    );
    act(() => restart?.click());

    expect(menu.onRestart).toHaveBeenCalledTimes(1);
    expect(menu.onOpen).not.toHaveBeenCalled();
  });

  it("行を押すかEnterで開く操作を呼ぶ", () => {
    const menu = { onOpen: vi.fn() };
    const openArea = openAreaOf(
      mount(<SessionListRow {...rowProps({ menu })} />)
    );

    act(() => openArea.click());
    pressKey(openArea, "Enter");

    expect(menu.onOpen).toHaveBeenCalledTimes(2);
  });

  it("行を押してもフォーカスを受け取らず、一覧の中に残っていたフォーカスは外す", () => {
    const container = mount(
      <div data-session-list="">
        <SessionListRow {...rowProps()} />
      </div>
    );
    const menuButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="app (feature/login) のメニュー"]'
    );
    const openArea = openAreaOf(container);
    act(() => menuButton?.focus());
    expect(document.activeElement).toBe(menuButton);

    const mouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      openArea.dispatchEvent(mouseDown);
    });

    expect(mouseDown.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.body);
  });

  it("sidebarは右クリックと…の2か所、cardは⋮の1か所に行メニューを置く", () => {
    const sidebar = mount(<SessionListRow {...rowProps()} />);
    expect(
      sidebar.querySelector(
        'button[aria-label="app (feature/login) のメニュー"]'
      )
    ).not.toBeNull();
    expect(
      new Set(
        testDoubles.rowMenuVariants.mock.calls.map(([variant]) => variant)
      )
    ).toEqual(new Set(["context", "dropdown"]));

    testDoubles.rowMenuVariants.mockClear();
    mount(<SessionListRow {...rowProps({ variant: "card" })} />);
    expect(
      new Set(
        testDoubles.rowMenuVariants.mock.calls.map(([variant]) => variant)
      )
    ).toEqual(new Set(["dropdown"]));
  });
});

describe("SessionListRowのメニューの開閉", () => {
  it("メニューを開いたまま行が消えたら、開いていた分だけ閉じたことを知らせる", () => {
    const onMenuOpenChange = vi.fn();
    mount(<SessionListRow {...rowProps({ onMenuOpenChange })} />);

    act(() => testDoubles.menuOpenChanges.dropdown?.(true));
    act(() => testDoubles.menuOpenChanges.context?.(true));
    expect(onMenuOpenChange.mock.calls).toEqual([[true], [true]]);

    const { root, container } = mountedRoots.splice(0)[0];
    act(() => root.unmount());
    container.remove();

    expect(onMenuOpenChange.mock.calls).toEqual([
      [true],
      [true],
      [false],
      [false],
    ]);
  });

  it("閉じてから行が消えたときは、重ねて閉じたことを知らせない", () => {
    const onMenuOpenChange = vi.fn();
    mount(<SessionListRow {...rowProps({ onMenuOpenChange })} />);

    act(() => testDoubles.menuOpenChanges.dropdown?.(true));
    act(() => testDoubles.menuOpenChanges.dropdown?.(false));

    const { root, container } = mountedRoots.splice(0)[0];
    act(() => root.unmount());
    container.remove();

    expect(onMenuOpenChange.mock.calls).toEqual([[true], [false]]);
  });
});

describe("SessionListRowの表示名の編集", () => {
  it("編集を始めると今の主ラベルを入れた入力欄にフォーカスし、Enterで前後の空白を除いて保存する", () => {
    const props = rowProps({ editing: true, displayName: "旧名" });
    const container = mount(<SessionListRow {...props} />);
    const input = editingInput(container);

    expect(input.value).toBe("旧名");
    expect(document.activeElement).toBe(input);

    typeInto(input, "  新しい名前 ");
    pressKey(input, "Enter");

    expect(props.onSaveDisplayName).toHaveBeenCalledWith("新しい名前");
    expect(props.onEditingChange).toHaveBeenCalledWith(false);
  });

  it("空、またはリポジトリ名と同じ値を保存すると表示名を解除する", () => {
    const emptied = rowProps({ editing: true, displayName: "旧名" });
    const emptyInput = editingInput(mount(<SessionListRow {...emptied} />));
    typeInto(emptyInput, "   ");
    pressKey(emptyInput, "Enter");
    expect(emptied.onSaveDisplayName).toHaveBeenCalledWith(null);

    mountedRoots.splice(0).forEach(({ root, container }) => {
      act(() => root.unmount());
      container.remove();
    });
    const sameAsRepo = rowProps({ editing: true, displayName: "旧名" });
    const repoInput = editingInput(mount(<SessionListRow {...sameAsRepo} />));
    typeInto(repoInput, "app");
    pressKey(repoInput, "Enter");
    expect(sameAsRepo.onSaveDisplayName).toHaveBeenCalledWith(null);
  });

  it("Escapeでは保存せずに編集を終え、値が変わっていなければ保存を呼ばない", () => {
    const canceled = rowProps({ editing: true, displayName: "旧名" });
    const input = editingInput(mount(<SessionListRow {...canceled} />));
    typeInto(input, "取り消す名前");
    pressKey(input, "Escape");
    expect(canceled.onSaveDisplayName).not.toHaveBeenCalled();
    expect(canceled.onEditingChange).toHaveBeenCalledWith(false);

    mountedRoots.splice(0).forEach(({ root, container }) => {
      act(() => root.unmount());
      container.remove();
    });
    const unchanged = rowProps({ editing: true, displayName: "旧名" });
    const sameInput = editingInput(mount(<SessionListRow {...unchanged} />));
    pressKey(sameInput, "Enter");
    expect(unchanged.onSaveDisplayName).not.toHaveBeenCalled();
    expect(unchanged.onEditingChange).toHaveBeenCalledWith(false);
  });

  it("日本語入力の変換中のEnterでは保存せず、入力欄の外に出たら保存する", () => {
    const props = rowProps({ editing: true, displayName: null });
    const input = editingInput(mount(<SessionListRow {...props} />));
    typeInto(input, "ろぐいん");
    pressKey(input, "Enter", { isComposing: true });
    expect(props.onSaveDisplayName).not.toHaveBeenCalled();

    act(() => input.blur());
    expect(props.onSaveDisplayName).toHaveBeenCalledWith("ろぐいん");
  });
});

describe("resolveSessionRowProfile", () => {
  const profileById = new Map(profiles.map(profile => [profile.id, profile]));
  const worktreePath = worktree.path;

  it("プロファイル機能が無効ならnull", () => {
    expect(
      resolveSessionRowProfile({
        enabled: false,
        worktreePath,
        repoPath: "/work/app",
        profileById,
        repoProfileLinks: new Map([["/work/app", "p-work"]]),
      })
    ).toBeNull();
  });

  it("worktree個別の上書きを優先し、個別であることを返す", () => {
    expect(
      resolveSessionRowProfile({
        enabled: true,
        worktreePath,
        repoPath: "/work/app",
        profileById,
        repoProfileLinks: new Map([["/work/app", "p-work"]]),
        worktreeProfileLinks: new Map([[worktreePath, "p-home"]]),
      })
    ).toEqual({ name: "個人", individual: true });
  });

  it("個別が無ければリポジトリの既定を継承する", () => {
    expect(
      resolveSessionRowProfile({
        enabled: true,
        worktreePath,
        repoPath: "/work/app",
        profileById,
        repoProfileLinks: new Map([["/work/app", "p-work"]]),
        worktreeProfileLinks: new Map(),
      })
    ).toEqual({ name: "仕事", individual: false });
  });

  it("どちらも未割り当て、または削除済みのプロファイルならnull", () => {
    expect(
      resolveSessionRowProfile({
        enabled: true,
        worktreePath,
        repoPath: "/work/app",
        profileById,
      })
    ).toBeNull();
    expect(
      resolveSessionRowProfile({
        enabled: true,
        worktreePath,
        repoPath: "/work/app",
        profileById,
        repoProfileLinks: new Map([["/work/app", "p-deleted"]]),
      })
    ).toBeNull();
  });
});
