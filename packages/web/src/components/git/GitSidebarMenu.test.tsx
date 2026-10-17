// @vitest-environment jsdom

import type { GitRefs } from "@ark/shared";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitSidebar } from "./GitSidebar";
import { click, mount, unmountAll } from "./test-helpers";
import type { GitOpsActions } from "./useGitOps";

// Radix のメニューは jsdom で開けないので、中身をその場に描く
vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children?: ReactNode }) => (
    <div data-testid="menu-root">{children}</div>
  ),
  ContextMenuTrigger: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
  ContextMenuContent: ({ children }: { children?: ReactNode }) => (
    <div role="menu">{children}</div>
  ),
  ContextMenuSeparator: () => null,
  ContextMenuItem: ({
    children,
    disabled,
    onSelect,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onSelect?: () => void;
  }) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => onSelect?.()}
    >
      {children}
    </button>
  ),
}));

const refs: GitRefs = {
  head: { sha: "aaa1111", branch: "main" },
  branches: [
    {
      name: "main",
      sha: "aaa1111",
      current: true,
      upstream: "origin/main",
      worktreePath: "/w/main",
    },
    {
      name: "used",
      sha: "bbb2222",
      current: false,
      worktreePath: "/w/other",
    },
    { name: "free", sha: "ccc3333", current: false },
  ],
  remotes: [
    {
      name: "origin/main",
      sha: "aaa1111",
      remote: "origin",
      branch: "main",
      isDefault: true,
    },
    {
      name: "origin/feat/x",
      sha: "ddd4444",
      remote: "origin",
      branch: "feat/x",
    },
    {
      name: "team/origin/topic",
      sha: "eee5555",
      remote: "team/origin",
      branch: "topic",
    },
    {
      name: "pr/587",
      sha: "fff6666",
      remote: "pr",
      branch: "587",
      unknownRemote: true,
    },
  ],
  tags: [],
  stashes: [],
};

function makeOps(): GitOpsActions {
  return {
    createBranchAt: vi.fn(),
    renameBranch: vi.fn(),
    deleteBranch: vi.fn(),
    deleteRemoteBranch: vi.fn(),
    pushBranch: vi.fn(),
    fetch: vi.fn(),
    pull: vi.fn(),
  };
}

function setup(remoteBusy = false) {
  const ops = makeOps();
  const { container } = mount(
    <GitSidebar
      refs={refs}
      changeCount={0}
      selection={null}
      onSelectWorking={vi.fn()}
      onShowAll={vi.fn()}
      onSelectSha={vi.fn()}
      ops={ops}
      remoteBusy={remoteBusy}
    />
  );
  /** title がその名前の行のメニュー */
  const menuOf = (title: string) => {
    const row = [...container.querySelectorAll("button[title]")].find(b =>
      b.getAttribute("title")?.startsWith(title)
    );
    const root = row?.closest('[data-testid="menu-root"]');
    if (!root) throw new Error(`${title} のメニューがありません`);
    return root;
  };
  const item = (menu: Element, label: string) =>
    [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b =>
      b.textContent?.includes(label)
    );
  return { ops, menuOf, item };
}

afterEach(unmountAll);

describe("GitSidebar の右クリック", () => {
  it("ローカルのブランチの操作を呼ぶ", () => {
    const { ops, menuOf, item } = setup();
    const free = menuOf("free");
    click(item(free, "ここから新しいブランチ"));
    expect(ops.createBranchAt).toHaveBeenCalledWith("ccc3333");
    click(item(free, "名前を変更"));
    expect(ops.renameBranch).toHaveBeenCalledWith("free");
    click(item(free, "push"));
    expect(ops.pushBranch).toHaveBeenCalledWith("free");
    click(item(free, "削除"));
    expect(ops.deleteBranch).toHaveBeenCalledWith("free");
    // pull はいまのブランチだけ
    expect(item(free, "pull")).toBeUndefined();
    click(item(menuOf("main"), "pull"));
    expect(ops.pull).toHaveBeenCalled();
  });

  it("いまのブランチと、ほかの作業ツリーで使用中のブランチは削除できない", () => {
    const { menuOf, item } = setup();
    expect(item(menuOf("main"), "削除")?.disabled).toBe(true);
    expect(menuOf("main").textContent).toContain(
      "いまのブランチは削除できません"
    );
    const used = menuOf("used");
    expect(item(used, "削除")?.disabled).toBe(true);
    expect(used.textContent).toContain("/w/other");
    expect(item(menuOf("free"), "削除")?.disabled).toBe(false);
  });

  it("リモートのブランチを消す。既定のブランチは消せない", () => {
    const { ops, menuOf, item } = setup();
    click(item(menuOf("origin/feat/x"), "リモートから削除"));
    expect(ops.deleteRemoteBranch).toHaveBeenCalledWith(
      "origin",
      "origin/feat/x"
    );
    // リモートの名前が / を含んでも、サーバーが分けたリモートの名前で消す
    click(item(menuOf("team/origin/topic"), "リモートから削除"));
    expect(ops.deleteRemoteBranch).toHaveBeenLastCalledWith(
      "team/origin",
      "team/origin/topic"
    );
    expect(item(menuOf("origin/main"), "リモートから削除")?.disabled).toBe(
      true
    );
  });

  it("設定に無いリモートの追跡ブランチは、リモートから消せない", () => {
    const { menuOf, item } = setup();
    const pr = menuOf("pr/587");
    expect(item(pr, "リモートから削除")?.disabled).toBe(true);
    expect(pr.textContent).toContain("リモート pr は設定にありません");
    expect(item(pr, "ここから新しいブランチ")?.disabled).toBe(false);
  });

  it("リモートの操作の最中はどの操作も押せない", () => {
    const { menuOf, item } = setup(true);
    expect(item(menuOf("free"), "push")?.disabled).toBe(true);
    expect(item(menuOf("origin/feat/x"), "リモートから削除")?.disabled).toBe(
      true
    );
    expect(item(menuOf("free"), "名前を変更")?.disabled).toBe(true);
    expect(item(menuOf("free"), "削除")?.disabled).toBe(true);
  });
});
