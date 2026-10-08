// @vitest-environment jsdom

import type { GitRefs } from "@ark/shared";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitSidebar } from "./GitSidebar";
import { click, mount, unmountAll } from "./test-helpers";

type Props = ComponentProps<typeof GitSidebar>;

const refs: GitRefs = {
  head: { sha: "aaa1111", branch: "main" },
  branches: [
    {
      name: "main",
      sha: "aaa1111",
      current: true,
      upstream: "origin/main",
      ahead: 2,
      behind: 1,
    },
    { name: "feat/x", sha: "bbb2222", current: false, ahead: 0, behind: 3 },
    { name: "local-only", sha: "ccc3333", current: false },
  ],
  remotes: [
    { name: "origin/HEAD", sha: "aaa1111" },
    { name: "origin/main", sha: "ddd4444" },
    { name: "origin/feat/x", sha: "bbb2222" },
    { name: "upstream/main", sha: "eee5555" },
  ],
  tags: [{ name: "v1.0", sha: "fff6666" }],
  stashes: [{ name: "stash@{0}", sha: "abc7777", subject: "WIP on main" }],
};

function setup(overrides: Partial<Props> = {}) {
  const onSelectWorking = vi.fn();
  const onShowAll = vi.fn();
  const onSelectSha = vi.fn();
  const props: Props = {
    refs,
    changeCount: 0,
    selection: null,
    onSelectWorking,
    onShowAll,
    onSelectSha,
    ...overrides,
  };
  const { container, rerender } = mount(<GitSidebar {...props} />);
  return {
    container,
    onSelectWorking,
    onShowAll,
    onSelectSha,
    rerender: (next: Partial<Props>) =>
      rerender(<GitSidebar {...props} {...next} />),
  };
}

const group = (scope: ParentNode, id: string) =>
  scope.querySelector(`[data-group="${id}"]`) as HTMLElement;
const groupToggle = (scope: ParentNode, id: string) =>
  group(scope, id).querySelector("button[aria-expanded]") as HTMLButtonElement;
const refButtons = (scope: ParentNode, id: string) => [
  ...group(scope, id).querySelectorAll<HTMLButtonElement>("button[data-sha]"),
];
const buttonByText = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll("button")].find(b =>
    b.textContent?.startsWith(text)
  );

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
});

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

describe("GitSidebar", () => {
  it("ブランチ・リモート・タグ・スタッシュをグループで並べる", () => {
    const { container } = setup();
    expect(refButtons(container, "branches").map(b => b.textContent)).toEqual([
      "main↑2 ↓1",
      "feat/x↓3",
      "local-only",
    ]);
    // リモートは名前ごとにまとめ、origin/HEAD は出さない
    const remotes = [
      ...group(container, "remotes").querySelectorAll<HTMLElement>(
        "[data-remote]"
      ),
    ];
    expect(remotes.map(el => el.dataset.remote)).toEqual([
      "origin",
      "upstream",
    ]);
    expect(
      [...remotes[0].querySelectorAll("button")].map(b => b.textContent)
    ).toEqual(["main", "feat/x"]);
    expect(refButtons(container, "tags").map(b => b.textContent)).toEqual([
      "v1.0",
    ]);
    expect(refButtons(container, "stashes").map(b => b.textContent)).toEqual([
      "WIP on main",
    ]);
  });

  it("いまのブランチに印を付けて太字にし、ahead / behind を出す", () => {
    const { container } = setup();
    const [main, featX, localOnly] = refButtons(container, "branches");
    expect(main.querySelector('[aria-label="いまのブランチ"]')).not.toBeNull();
    expect(main.querySelector(".font-semibold")?.textContent).toBe("main");
    expect(featX.querySelector('[aria-label="いまのブランチ"]')).toBeNull();
    expect(featX.querySelector(".font-semibold")).toBeNull();
    expect(
      main.querySelector('[data-testid="git-ahead-behind"]')?.textContent
    ).toBe("↑2 ↓1");
    expect(
      featX.querySelector('[data-testid="git-ahead-behind"]')?.textContent
    ).toBe("↓3");
    expect(
      localOnly.querySelector('[data-testid="git-ahead-behind"]')
    ).toBeNull();
  });

  it("ref を押すと、そのコミットの sha を渡す", () => {
    const { container, onSelectSha } = setup();
    click(refButtons(container, "branches")[1]);
    expect(onSelectSha).toHaveBeenLastCalledWith("bbb2222");
    click(refButtons(container, "remotes")[2]);
    expect(onSelectSha).toHaveBeenLastCalledWith("eee5555");
    click(refButtons(container, "tags")[0]);
    expect(onSelectSha).toHaveBeenLastCalledWith("fff6666");
    click(refButtons(container, "stashes")[0]);
    expect(onSelectSha).toHaveBeenLastCalledWith("abc7777");
  });

  it("「変更」は数があるときだけ (n) を付け、押すと未コミットの変更を選ぶ", () => {
    const { container, onSelectWorking, onShowAll, rerender } = setup();
    expect(buttonByText(container, "変更")?.textContent).toBe("変更");
    rerender({ changeCount: 3 });
    expect(buttonByText(container, "変更")?.textContent).toBe("変更 (3)");
    click(buttonByText(container, "変更"));
    expect(onSelectWorking).toHaveBeenCalledTimes(1);

    click(buttonByText(container, "すべてのコミット"));
    expect(onShowAll).toHaveBeenCalledTimes(1);
  });

  it("選んでいるものを強調する", () => {
    const { container, rerender } = setup({ selection: { kind: "working" } });
    expect(buttonByText(container, "変更")?.getAttribute("aria-current")).toBe(
      "true"
    );
    rerender({ selection: { kind: "commit", sha: "bbb2222" } });
    expect(
      buttonByText(container, "変更")?.getAttribute("aria-current")
    ).toBeNull();
    // hover:bg-muted/60 と区別して、塗りそのものを見る
    const highlighted = (el: Element) => el.classList.contains("bg-muted");
    expect(highlighted(refButtons(container, "branches")[1])).toBe(true);
    expect(highlighted(refButtons(container, "branches")[0])).toBe(false);
  });

  it("グループは折りたため、折りたたみを localStorage に残す", () => {
    const { container } = setup();
    expect(groupToggle(container, "tags").getAttribute("aria-expanded")).toBe(
      "true"
    );
    click(groupToggle(container, "tags"));
    expect(groupToggle(container, "tags").getAttribute("aria-expanded")).toBe(
      "false"
    );
    expect(refButtons(container, "tags")).toHaveLength(0);
    expect(localStorage.getItem("ark-git-sidebar-groups")).toBe('["tags"]');
    unmountAll();

    // 開き直しても折りたたんだまま
    const again = setup();
    expect(
      groupToggle(again.container, "tags").getAttribute("aria-expanded")
    ).toBe("false");
    expect(refButtons(again.container, "branches")).toHaveLength(3);
    click(groupToggle(again.container, "tags"));
    expect(localStorage.getItem("ark-git-sidebar-groups")).toBe("[]");
  });

  it("refs が無くても (読み込み前) 落ちない", () => {
    const { container } = setup({ refs: null });
    expect(refButtons(container, "branches")).toHaveLength(0);
    expect(buttonByText(container, "すべてのコミット")).toBeDefined();
  });

  it("localStorage が使えなくても動く", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { container } = setup();
    click(groupToggle(container, "branches"));
    expect(refButtons(container, "branches")).toHaveLength(0);
  });
});
