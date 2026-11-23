// @vitest-environment jsdom

import type {
  BridgeSessionStatus,
  ManagedSession,
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
  DropdownMenu: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
}));

const repoPath = "/work/app";
const zetaRepoPath = "/work/zeta";

function makeWorktree(id: string, repo = repoPath): Worktree {
  return {
    id,
    path: `${repo}/.worktrees/${id}`,
    branch: `feature/${id}`,
    commit: "abc1234",
    isMain: false,
    isBare: false,
  };
}

function makeSession(worktree: Worktree, repo = repoPath): ManagedSession {
  return {
    id: `session-${worktree.id}`,
    worktreeId: worktree.id,
    worktreePath: worktree.path,
    repoPath: repo,
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
    sessionPrStatuses: new Map(),
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

/** 一覧の並び。リポジトリの見出しは"# 見出しの文言"、行はdata-session-keyの値 */
function sequence(container: HTMLElement): string[] {
  const list = container.querySelector("[data-session-list]");
  return Array.from(list?.querySelectorAll("[data-repo-group]") ?? []).flatMap(
    group => [
      `# ${group.querySelector("h2")?.textContent ?? ""}`,
      ...Array.from(group.querySelectorAll("[data-session-key]"), element =>
        element.getAttribute("data-session-key")
      ),
    ]
  );
}

function pressableOf(container: HTMLElement, key: string): HTMLElement {
  const pressable = container.querySelector<HTMLElement>(
    `[data-session-key="${key}"]`
  );
  expect(pressable).not.toBeNull();
  return pressable as HTMLElement;
}

function handleOf(container: HTMLElement, repo: string): HTMLButtonElement {
  const handle = Array.from(
    container.querySelectorAll<HTMLButtonElement>("[data-repo-handle]")
  ).find(element => element.dataset.repoHandle === repo);
  expect(handle).toBeDefined();
  return handle as HTMLButtonElement;
}

/** app (a, b, c) に、名前順で後ろに来る zeta (z) を足した一覧 */
const zetaWorktree = makeWorktree("z", zetaRepoPath);
const twoRepoProps = (overrides: Partial<SessionSectionListProps> = {}) =>
  listProps({
    worktrees: [...worktrees, zetaWorktree],
    sessions: new Map([
      ...sessions,
      ["session-z", makeSession(zetaWorktree, zetaRepoPath)],
    ]),
    repoList: [zetaRepoPath, repoPath],
    ...overrides,
  });

function pointer(
  target: HTMLElement,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  clientY: number
) {
  // jsdom には PointerEvent が無い。React は pointer* の名前で拾うので MouseEvent で足りる
  act(() => {
    target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientY })
    );
  });
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

describe("SessionSectionListのTODO件数", () => {
  it("未完了のTODOがあるセッションの行にだけ件数を出す", () => {
    const { container } = mountList(
      listProps({ sessionTodoCounts: new Map([["session-a", 2]]) })
    );
    const badges = container.querySelectorAll(
      '[aria-label="未完了の TODO 2 件"]'
    );
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe("2");
  });

  it("件数が無ければ出さない", () => {
    const { container } = mountList(listProps());
    expect(container.querySelector('[aria-label^="未完了の TODO"]')).toBeNull();
  });
});

describe("SessionSectionListの並べ方", () => {
  it("リポジトリの見出しの下に、リポジトリ名の順で並べる", () => {
    const { container } = mountList(twoRepoProps());

    expect(sequence(container)).toEqual([
      "# app",
      "wt:a",
      "wt:b",
      "wt:c",
      "# zeta",
      "wt:z",
    ]);
  });

  it("状態が変わっても行は動かず、同じDOM要素のまま札だけ替わる", () => {
    const props = twoRepoProps({
      sessionStatuses: statusesOf("IDLE", "TOOL", "READY"),
    });
    const { container, rerender } = mountList(props);
    const rowC = pressableOf(container, "wt:c");

    rerender({
      ...props,
      sessionStatuses: statusesOf("TOOL", "READY", "AWAITING"),
    });

    expect(sequence(container)).toEqual([
      "# app",
      "wt:a",
      "wt:b",
      "wt:c",
      "# zeta",
      "wt:z",
    ]);
    expect(pressableOf(container, "wt:c")).toBe(rowC);
    expect(
      rowC.querySelector("[data-status]")?.getAttribute("data-status")
    ).toBe("AWAITING");
  });

  it("「あなたの番」の件数を外へ知らせる", () => {
    const onYourTurnCountChange = vi.fn();
    mountList(
      listProps({
        sessionStatuses: statusesOf("IDLE", "TOOL", "AWAITING"),
        onYourTurnCountChange,
      })
    );
    expect(onYourTurnCountChange).toHaveBeenLastCalledWith(2);
  });

  it("保存した順があれば、その順にリポジトリを並べる", () => {
    const { container } = mountList(
      twoRepoProps({ repoOrder: [zetaRepoPath, repoPath] })
    );
    expect(sequence(container)[0]).toBe("# zeta");
  });

  it("並べ替えを渡さないか、リポジトリが1つだけなら、つまみを出さない", () => {
    const none = mountList(twoRepoProps());
    expect(none.container.querySelector("[data-repo-handle]")).toBeNull();

    const single = mountList(listProps({ onRepoOrderChange: vi.fn() }));
    expect(single.container.querySelector("[data-repo-handle]")).toBeNull();
  });

  it("つまみの上下キーで1つずつ動かし、動かしたあともつまみにフォーカスを残す", () => {
    const onRepoOrderChange = vi.fn();
    const props = twoRepoProps({ onRepoOrderChange });
    const { container, rerender } = mountList(props);
    const handle = handleOf(container, zetaRepoPath);
    expect(handle.getAttribute("aria-label")).toBe(
      "zetaの位置を動かす (ドラッグか上下キー)"
    );
    act(() => handle.focus());

    act(() => {
      handle.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
      );
    });
    // 一番下からは下へ動かない
    expect(onRepoOrderChange).not.toHaveBeenCalled();

    act(() => {
      handle.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })
      );
    });
    expect(onRepoOrderChange).toHaveBeenCalledWith([zetaRepoPath, repoPath]);

    rerender({ ...props, repoOrder: [zetaRepoPath, repoPath] });
    expect(sequence(container)[0]).toBe("# zeta");
    expect(document.activeElement).toBe(handleOf(container, zetaRepoPath));
  });

  it("つまみをドラッグしている間は並べた順で描き、離したときに見えていないパスも残して保存する", () => {
    const onRepoOrderChange = vi.fn();
    const { container } = mountList(
      twoRepoProps({ onRepoOrderChange, repoOrder: ["/work/hidden"] })
    );
    // かたまりの位置: app は 0-100、zeta は 100-200
    for (const group of container.querySelectorAll<HTMLElement>(
      "[data-repo-group]"
    )) {
      const top = group.dataset.repoGroup === repoPath ? 0 : 100;
      group.getBoundingClientRect = () =>
        ({ top, height: 100, bottom: top + 100 }) as DOMRect;
    }
    const handle = handleOf(container, zetaRepoPath);

    pointer(handle, "pointerdown", 150);
    pointer(handle, "pointermove", 10);

    expect(sequence(container)[0]).toBe("# zeta");
    expect(onRepoOrderChange).not.toHaveBeenCalled();

    pointer(handle, "pointerup", 10);
    expect(onRepoOrderChange).toHaveBeenCalledWith([
      zetaRepoPath,
      repoPath,
      "/work/hidden",
    ]);
  });

  it("ドラッグを取り消したら保存せず、元の順に戻す", () => {
    const onRepoOrderChange = vi.fn();
    const { container } = mountList(twoRepoProps({ onRepoOrderChange }));
    for (const group of container.querySelectorAll<HTMLElement>(
      "[data-repo-group]"
    )) {
      const top = group.dataset.repoGroup === repoPath ? 0 : 100;
      group.getBoundingClientRect = () =>
        ({ top, height: 100, bottom: top + 100 }) as DOMRect;
    }
    const handle = handleOf(container, zetaRepoPath);

    pointer(handle, "pointerdown", 150);
    pointer(handle, "pointermove", 10);
    pointer(handle, "pointercancel", 10);

    expect(sequence(container)[0]).toBe("# app");
    expect(onRepoOrderChange).not.toHaveBeenCalled();
  });

  it("ホームの行を外して行が無くなったリポジトリは、見出しも出さない", () => {
    const { container } = mountList(
      twoRepoProps({ homeWorktreePath: zetaWorktree.path })
    );
    expect(sequence(container)).toEqual(["# app", "wt:a", "wt:b", "wt:c"]);
  });

  it("リポジトリが未登録でも、動いているセッションと会話が直近に動いたセッションは出す", () => {
    const { container } = mountList(
      listProps({
        repoList: [],
        sessionStatuses: statusesOf("IDLE", "TOOL", "IDLE"),
        sessionLastUpdatedAt: new Map([
          ["session-a", Date.now() - 60_000],
          ["session-c", Date.now() - 3 * 24 * 60 * 60 * 1000],
        ]),
      })
    );

    expect(sequence(container)).toEqual([
      "# app",
      "s:session-a",
      "s:session-b",
    ]);
  });

  it("行が1件も無くてもdata-session-listの要素は残り、新規作成の案内を出す", () => {
    const { container } = mountList(
      listProps({
        repoList: [],
        sessionStatuses: statusesOf("IDLE", "READY", "READY"),
      })
    );

    const list = container.querySelector("[data-session-list]");
    expect(list).not.toBeNull();
    expect(list?.textContent).toContain("セッションがありません");
  });
});

describe("SessionSectionListの手動の休止", () => {
  function sessionsWithRested(restedIds: string[]) {
    return new Map(
      Array.from(sessions, ([id, session]) => [
        id,
        restedIds.includes(id) ? { ...session, restedAt: 1_000 } : session,
      ])
    );
  }

  it("手動で休止にした行は、位置を変えずに札を休止にし、あなたの番の件数から外す", () => {
    const onYourTurnCountChange = vi.fn();
    const { container } = mountList(
      listProps({
        sessions: sessionsWithRested(["session-a"]),
        sessionStatuses: statusesOf("IDLE", "TOOL", "AWAITING"),
        onYourTurnCountChange,
      })
    );

    expect(sequence(container)).toEqual(["# app", "wt:a", "wt:b", "wt:c"]);
    const chip = pressableOf(container, "wt:a").querySelector("[data-status]");
    expect(chip?.getAttribute("data-status")).toBe("RESTED");
    expect(chip?.textContent).toBe(presentStatus("RESTED").label);
    expect(onYourTurnCountChange).toHaveBeenLastCalledWith(1);
  });

  it("「休止にする」はあなたの番の行にだけ出し、手動で休止にした行には「休止から戻す」を出す", () => {
    const onSetSessionRested = vi.fn();
    mountList(
      listProps({
        sessions: sessionsWithRested(["session-c"]),
        sessionStatuses: statusesOf("IDLE", "TOOL", "IDLE"),
        onSetSessionRested,
      })
    );

    expect(menuOf("wt:a").rest?.rested).toBe(false);
    expect(menuOf("wt:b").rest).toBeUndefined();
    expect(menuOf("wt:c").rest?.rested).toBe(true);

    act(() => menuOf("wt:a").rest?.onChange(true));
    act(() => menuOf("wt:c").rest?.onChange(false));
    expect(onSetSessionRested).toHaveBeenNthCalledWith(1, "session-a", true);
    expect(onSetSessionRested).toHaveBeenNthCalledWith(2, "session-c", false);
  });

  it("待機・停止の行には、休止の項目を出さない", () => {
    mountList(
      listProps({
        sessionStatuses: statusesOf("IDLE", "TOOL", "READY"),
        onSetSessionRested: vi.fn(),
      })
    );

    expect(menuOf("wt:c").rest).toBeUndefined();
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
});
