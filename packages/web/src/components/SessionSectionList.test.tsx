// @vitest-environment jsdom

import type {
  BridgeSessionStatus,
  ManagedSession,
  Profile,
  Worktree,
} from "@ark/shared";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { presentStatus } from "@/lib/status-tone";
import type { SessionRowMenuProps } from "./SessionRowMenu";
import {
  SessionSectionList,
  type SessionSectionListProps,
} from "./SessionSectionList";

const testDoubles = vi.hoisted(() => ({
  menuProps: new Map<string, unknown>(),
}));

vi.mock("./SessionRowMenu", () => ({
  SessionRowMenu: (props: { entry: { key: string } }) => {
    testDoubles.menuProps.set(props.entry.key, props);
    return null;
  },
}));

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children?: ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
  ContextMenuContent: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  // Radixのメニューはjsdomで開けないため、開いたことを起こすボタンを行ごとに置く
  DropdownMenu: ({
    children,
    onOpenChange,
  }: {
    children?: ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => (
    <>
      {children}
      <button
        type="button"
        data-testid="open-row-menu"
        onClick={() => onOpenChange?.(true)}
      />
    </>
  ),
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
}));

const repoPath = "/work/app";

function makeWorktree(id: string): Worktree {
  return {
    id,
    path: `${repoPath}/.worktrees/${id}`,
    branch: `feature/${id}`,
    commit: "abc1234",
    isMain: false,
    isBare: false,
  };
}

function makeSession(worktree: Worktree): ManagedSession {
  return {
    id: `session-${worktree.id}`,
    worktreeId: worktree.id,
    worktreePath: worktree.path,
    repoPath,
    status: "active",
    createdAt: new Date("2026-09-17T00:00:00Z"),
    tmuxSessionName: `ark-${worktree.id}`,
    ttydPort: 7680,
    ttydUrl: `/ttyd/${worktree.id}/`,
  };
}

const worktrees = ["a", "b", "c"].map(makeWorktree);
const sessions = new Map(
  worktrees.map(worktree => {
    const session = makeSession(worktree);
    return [session.id, session] as const;
  })
);
const profiles: Profile[] = [
  {
    id: "p-work",
    name: "仕事",
    configDir: "/home/me/.claude-work",
    createdAt: 0,
    updatedAt: 0,
  },
];

function statusesOf(
  a: BridgeSessionStatus,
  b: BridgeSessionStatus,
  c: BridgeSessionStatus
): Map<string, BridgeSessionStatus> {
  return new Map([
    ["session-a", a],
    ["session-b", b],
    ["session-c", c],
  ]);
}

function listProps(
  overrides: Partial<SessionSectionListProps> = {}
): SessionSectionListProps {
  return {
    variant: "sidebar",
    sessions,
    worktrees,
    repoList: [repoPath],
    sessionStatuses: statusesOf("IDLE", "TOOL", "READY"),
    sessionPreviews: new Map([["session-a", "どちらにしますか"]]),
    selectedSessionId: null,
    onOpenSession: vi.fn(),
    onStartSession: vi.fn(),
    onDeleteSession: vi.fn(),
    ...overrides,
  };
}

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function mountList(props: SessionSectionListProps) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<SessionSectionList {...props} />));
  mountedRoots.push({ root, container });
  return {
    container,
    rerender: (next: SessionSectionListProps) =>
      act(() => root.render(<SessionSectionList {...next} />)),
  };
}

/** 一覧の直下の並び。見出し (data-section) は"# 見出しの文言"、行はdata-session-keyの値 */
function sequence(container: HTMLElement): string[] {
  const list = container.querySelector("[data-session-list]");
  return Array.from(list?.children ?? []).map(element =>
    element.hasAttribute("data-section")
      ? `# ${element.firstElementChild?.textContent ?? ""}`
      : (element
          .querySelector("[data-session-key]")
          ?.getAttribute("data-session-key") ?? "?")
  );
}

/** 行を押せる要素 (data-session-key) を含む、一覧の直下の要素 */
function rowElementOf(container: HTMLElement, key: string): HTMLElement {
  let element = container.querySelector<HTMLElement>(
    `[data-session-key="${key}"]`
  );
  while (element && !element.parentElement?.hasAttribute("data-session-list")) {
    element = element.parentElement;
  }
  expect(element).not.toBeNull();
  return element as HTMLElement;
}

function pressableOf(container: HTMLElement, key: string): HTMLElement {
  const pressable = container.querySelector<HTMLElement>(
    `[data-session-key="${key}"]`
  );
  expect(pressable).not.toBeNull();
  return pressable as HTMLElement;
}

function menuOf(key: string): SessionRowMenuProps {
  const props = testDoubles.menuProps.get(key);
  expect(props).toBeDefined();
  return props as SessionRowMenuProps;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  testDoubles.menuProps.clear();
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("SessionSectionListの並べ方", () => {
  it("注意の順に3セクションで並べ、「あなたの番」に件数を出し、空のセクションは出さない", () => {
    const { container } = mountList(
      listProps({ sessionStatuses: statusesOf("IDLE", "TOOL", "AWAITING") })
    );

    expect(sequence(container)).toEqual([
      "# あなたの番",
      "wt:c",
      "wt:a",
      "# 作業中",
      "wt:b",
    ]);
    expect(
      container.querySelector(
        '[data-section="your-turn"] [data-testid="section-count"]'
      )?.textContent
    ).toBe("2");
    expect(container.querySelector('[data-section="resting"]')).toBeNull();
  });

  it("セクションの中は会話の最終更新が新しい順に並べる", () => {
    const { container } = mountList(
      listProps({
        sessionStatuses: statusesOf("IDLE", "IDLE", "IDLE"),
        sessionLastUpdatedAt: new Map([
          ["session-a", 100],
          ["session-b", 300],
          ["session-c", 200],
        ]),
      })
    );

    expect(sequence(container)).toEqual([
      "# あなたの番",
      "wt:b",
      "wt:c",
      "wt:a",
    ]);
  });

  it("一覧の中にフォーカスがある間は、最終更新が動いても位置を保ち、外れたら並べ直す", () => {
    // 最終更新は会話のたびに動くので、押そうとした行が足元で入れ替わりやすい
    const props = listProps({
      sessionStatuses: statusesOf("IDLE", "IDLE", "IDLE"),
      sessionLastUpdatedAt: new Map([
        ["session-a", 300],
        ["session-b", 200],
        ["session-c", 100],
      ]),
    });
    const { container, rerender } = mountList(props);
    expect(sequence(container)).toEqual([
      "# あなたの番",
      "wt:a",
      "wt:b",
      "wt:c",
    ]);
    const openA = pressableOf(container, "wt:a");
    act(() => openA.focus());

    rerender({
      ...props,
      sessionLastUpdatedAt: new Map([
        ["session-a", 300],
        ["session-b", 200],
        ["session-c", 400],
      ]),
    });

    expect(sequence(container)).toEqual([
      "# あなたの番",
      "wt:a",
      "wt:b",
      "wt:c",
    ]);

    act(() => openA.blur());

    expect(sequence(container)).toEqual([
      "# あなたの番",
      "wt:c",
      "wt:a",
      "wt:b",
    ]);
  });

  it("セクションをまたいで移っても、行は同じ親の同じDOM要素のまま", () => {
    const props = listProps();
    const { container, rerender } = mountList(props);
    expect(sequence(container)).toEqual([
      "# あなたの番",
      "wt:a",
      "# 作業中",
      "wt:b",
      "# 休止中",
      "wt:c",
    ]);
    const list = container.querySelector("[data-session-list]");
    const rowB = rowElementOf(container, "wt:b");
    const pressableB = pressableOf(container, "wt:b");

    rerender({
      ...props,
      sessionStatuses: statusesOf("IDLE", "AWAITING", "READY"),
    });

    expect(sequence(container)).toEqual([
      "# あなたの番",
      "wt:b",
      "wt:a",
      "# 休止中",
      "wt:c",
    ]);
    expect(rowElementOf(container, "wt:b")).toBe(rowB);
    expect(pressableOf(container, "wt:b")).toBe(pressableB);
    expect(rowB.parentElement).toBe(list);
  });

  it("一覧の中にフォーカスがある間は、行がセクションをまたいでも位置を保ってチップと件数だけ更新し、フォーカスが外れたら並べ直す", () => {
    const props = listProps({
      sessionStatuses: statusesOf("IDLE", "TOOL", "THINK"),
    });
    const { container, rerender } = mountList(props);
    expect(sequence(container)).toEqual([
      "# あなたの番",
      "wt:a",
      "# 作業中",
      "wt:b",
      "wt:c",
    ]);
    const openA = pressableOf(container, "wt:a");
    act(() => openA.focus());

    rerender({
      ...props,
      sessionStatuses: statusesOf("IDLE", "AWAITING", "THINK"),
    });

    expect(sequence(container)).toEqual([
      "# あなたの番",
      "wt:a",
      "# 作業中",
      "wt:b",
      "wt:c",
    ]);
    expect(pressableOf(container, "wt:b").textContent).toContain(
      presentStatus("AWAITING").label
    );
    expect(
      container.querySelector('[data-testid="section-count"]')?.textContent
    ).toBe("2");

    act(() => openA.blur());

    expect(sequence(container)).toEqual([
      "# あなたの番",
      "wt:b",
      "wt:a",
      "# 作業中",
      "wt:c",
    ]);
  });

  it("保留中にセクションが空になっても、その見出しを同じ位置に残して下の行を動かさず、保留が解けたら消す", () => {
    const props = listProps();
    const { container, rerender } = mountList(props);
    const before = [
      "# あなたの番",
      "wt:a",
      "# 作業中",
      "wt:b",
      "# 休止中",
      "wt:c",
    ];
    expect(sequence(container)).toEqual(before);
    const openA = pressableOf(container, "wt:a");
    act(() => openA.focus());

    rerender({
      ...props,
      sessionStatuses: statusesOf("IDLE", "AWAITING", "READY"),
    });

    expect(sequence(container)).toEqual(before);
    expect(
      container.querySelector('[data-testid="section-count"]')?.textContent
    ).toBe("2");

    act(() => openA.blur());

    expect(sequence(container)).toEqual([
      "# あなたの番",
      "wt:b",
      "wt:a",
      "# 休止中",
      "wt:c",
    ]);
    expect(container.querySelector('[data-section="working"]')).toBeNull();
  });

  it("保留中に「あなたの番」が空になると、見出しは残して件数のバッジだけ隠す", () => {
    const props = listProps();
    const { container, rerender } = mountList(props);
    const openB = pressableOf(container, "wt:b");
    act(() => openB.focus());

    rerender({
      ...props,
      sessionStatuses: statusesOf("TOOL", "TOOL", "READY"),
    });

    expect(sequence(container)).toEqual([
      "# あなたの番",
      "wt:a",
      "# 作業中",
      "wt:b",
      "# 休止中",
      "wt:c",
    ]);
    expect(container.querySelector('[data-testid="section-count"]')).toBeNull();

    act(() => openB.blur());

    expect(sequence(container)).toEqual([
      "# 作業中",
      "wt:a",
      "wt:b",
      "# 休止中",
      "wt:c",
    ]);
  });

  it("保留の前に空だったセクションの見出しは、保留中に行が入っても描かない", () => {
    const props = listProps({
      sessionStatuses: statusesOf("TOOL", "TOOL", "TOOL"),
    });
    const { container, rerender } = mountList(props);
    const openA = pressableOf(container, "wt:a");
    act(() => openA.focus());
    expect(sequence(container)).toEqual(["# 作業中", "wt:a", "wt:b", "wt:c"]);

    rerender({
      ...props,
      sessionStatuses: statusesOf("IDLE", "TOOL", "TOOL"),
    });

    expect(sequence(container)).toEqual(["# 作業中", "wt:a", "wt:b", "wt:c"]);
    expect(container.querySelector('[data-section="your-turn"]')).toBeNull();

    act(() => openA.blur());

    expect(sequence(container)).toEqual([
      "# あなたの番",
      "wt:a",
      "# 作業中",
      "wt:b",
      "wt:c",
    ]);
  });

  it("…のメニューを閉じてフォーカスがボタンに残っても、行を押せば保留が解けて並べ直す", () => {
    const props = listProps({
      sessionStatuses: statusesOf("IDLE", "TOOL", "THINK"),
    });
    const { container, rerender } = mountList(props);
    const menuButtonA = rowElementOf(
      container,
      "wt:a"
    ).querySelector<HTMLButtonElement>(
      'button[aria-label="app (feature/a) のメニュー"]'
    );
    act(() => menuButtonA?.focus());

    rerender({
      ...props,
      sessionStatuses: statusesOf("IDLE", "AWAITING", "THINK"),
    });
    expect(sequence(container)).toEqual([
      "# あなたの番",
      "wt:a",
      "# 作業中",
      "wt:b",
      "wt:c",
    ]);

    act(() => {
      pressableOf(container, "wt:b").dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      );
    });

    expect(sequence(container)).toEqual([
      "# あなたの番",
      "wt:b",
      "wt:a",
      "# 作業中",
      "wt:c",
    ]);
  });

  it("…のメニューを開いたまま行が消えても、保留を残さずに並べ直す", () => {
    const props = listProps({
      sessionStatuses: statusesOf("IDLE", "TOOL", "THINK"),
    });
    const { container, rerender } = mountList(props);
    act(() =>
      rowElementOf(container, "wt:c")
        .querySelector<HTMLButtonElement>('[data-testid="open-row-menu"]')
        ?.click()
    );

    const withoutC = {
      ...props,
      worktrees: worktrees.filter(worktree => worktree.id !== "c"),
      sessions: new Map(
        [...sessions].filter(([sessionId]) => sessionId !== "session-c")
      ),
    };
    rerender(withoutC);
    expect(sequence(container)).toEqual([
      "# あなたの番",
      "wt:a",
      "# 作業中",
      "wt:b",
    ]);

    rerender({
      ...withoutC,
      sessionStatuses: statusesOf("IDLE", "AWAITING", "THINK"),
    });

    expect(sequence(container)).toEqual(["# あなたの番", "wt:b", "wt:a"]);
  });

  it("行が1件も無ければ新規作成の案内を出す", () => {
    const { container } = mountList(listProps({ repoList: [] }));

    expect(container.textContent).toContain("セッションがありません");
  });

  it("行が1件も無くてもdata-session-listの要素は残り、案内文を含む", () => {
    const { container } = mountList(listProps({ repoList: [] }));

    const list = container.querySelector("[data-session-list]");
    expect(list).not.toBeNull();
    expect(list?.textContent).toContain("セッションがありません");
  });
});

describe("SessionSectionListの行メニューの配線", () => {
  it("「表示名を変更」でその行を編集にし、Enterでworktreeのパスと名前を保存する", () => {
    const onSetWorktreeDisplayName = vi.fn();
    const { container } = mountList(listProps({ onSetWorktreeDisplayName }));

    act(() => menuOf("wt:a").onStartRename?.());
    const input = container.querySelector<HTMLInputElement>(
      '[data-session-key="wt:a"] input[aria-label="表示名を編集"]'
    );
    expect(document.activeElement).toBe(input);

    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    act(() => {
      setValue?.call(input, "ログイン");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      input?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });

    expect(onSetWorktreeDisplayName).toHaveBeenCalledWith(
      worktrees[0].path,
      "ログイン"
    );
    expect(
      container.querySelector('input[aria-label="表示名を編集"]')
    ).toBeNull();
  });

  it("「削除」で確認ダイアログを出し、確定するとセッションとworktreeを渡す", () => {
    const onDeleteSession = vi.fn();
    mountList(listProps({ onDeleteSession }));

    act(() => menuOf("wt:b").onDelete?.());
    expect(document.body.textContent).toContain(
      "このセッションとWorktreeを削除しますか？関連するブランチも削除されます。"
    );
    const confirm = Array.from(document.body.querySelectorAll("button")).find(
      button => button.textContent === "削除"
    );
    act(() => confirm?.click());

    expect(onDeleteSession).toHaveBeenCalledWith("session-b", worktrees[1]);
  });

  it("RepoGridViewへの導線は、渡したときだけ行メニューに出す", () => {
    const onSelectRepoGrid = vi.fn();
    mountList(listProps({ onSelectRepoGrid }));

    act(() => menuOf("wt:a").onOpenRepoGrid?.());
    expect(onSelectRepoGrid).toHaveBeenCalledWith(repoPath);

    testDoubles.menuProps.clear();
    mountList(listProps());
    expect(menuOf("wt:a").onOpenRepoGrid).toBeUndefined();
  });

  it("プロファイルの項目とチップは、プロファイル機能が有効なときだけ出す", () => {
    const { container } = mountList(
      listProps({
        capabilities: { multiProfileSupported: true },
        profiles,
        repoProfileLinks: new Map([[repoPath, "p-work"]]),
        worktreeProfileLinks: new Map(),
        onSetWorktreeProfile: vi.fn(),
        onSetRepoProfile: vi.fn(),
        onOpenProfileManager: vi.fn(),
      })
    );

    expect(menuOf("wt:a").worktreeProfile).toMatchObject({
      currentProfileId: null,
      inheritedProfileName: "仕事",
    });
    expect(menuOf("wt:a").repoProfile).toMatchObject({
      currentProfileId: "p-work",
    });
    expect(
      container.querySelector(
        '[data-session-key="wt:a"] [data-testid="session-row-profile"]'
      )?.textContent
    ).toBe("仕事");

    testDoubles.menuProps.clear();
    const disabled = mountList(
      listProps({
        capabilities: { multiProfileSupported: false },
        profiles,
        repoProfileLinks: new Map([[repoPath, "p-work"]]),
        onSetWorktreeProfile: vi.fn(),
        onSetRepoProfile: vi.fn(),
        onOpenProfileManager: vi.fn(),
      })
    );
    expect(menuOf("wt:a").worktreeProfile).toBeUndefined();
    expect(menuOf("wt:a").repoProfile).toBeUndefined();
    expect(
      disabled.container.querySelector('[data-testid="session-row-profile"]')
    ).toBeNull();
  });
});
