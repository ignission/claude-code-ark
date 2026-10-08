// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitCommitList } from "./GitCommitList";
import {
  click,
  linearCommits,
  makeCommit,
  mount,
  press,
  ref,
  typeInto,
  unmountAll,
} from "./test-helpers";

type Props = ComponentProps<typeof GitCommitList>;

const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime();
const secondsAgo = (s: number) => Math.floor(NOW / 1000) - s;

function setup(overrides: Partial<Props> = {}) {
  const onSelect = vi.fn();
  const onLoadMore = vi.fn();
  const onReload = vi.fn();
  const props: Props = {
    commits: [],
    headSha: null,
    workingCount: 0,
    selection: null,
    onSelect,
    hasMore: false,
    loadingMore: false,
    onLoadMore,
    onReload,
    now: NOW,
    ...overrides,
  };
  const { container, rerender } = mount(<GitCommitList {...props} />);
  return {
    container,
    onSelect,
    onLoadMore,
    onReload,
    rerender: (next: Partial<Props>) =>
      rerender(<GitCommitList {...props} {...next} />),
  };
}

const listbox = (scope: ParentNode) =>
  scope.querySelector('[role="listbox"]') as HTMLDivElement;
const options = (scope: ParentNode) => [
  ...scope.querySelectorAll<HTMLElement>('[role="option"]'),
];
const filterInput = (scope: ParentNode) =>
  scope.querySelector('input[type="search"]') as HTMLInputElement;

/** jsdom はレイアウトを持たないので、表示領域の高さを決めてからスクロールさせる */
function scrollTo(scope: ParentNode, top: number, height = 280) {
  const el = listbox(scope);
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    value: height,
  });
  act(() => {
    el.scrollTop = top;
    el.dispatchEvent(new Event("scroll"));
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

const threeCommits = [
  makeCommit("ccc3333", {
    parents: ["bbb2222"],
    subject: "ピークの見出しをまとめる",
    authorTime: secondsAgo(3 * 60),
    refs: [ref("head", "main"), ref("remote", "origin/main")],
  }),
  makeCommit("bbb2222", {
    parents: ["aaa1111"],
    subject: "Add the file pane",
    authorName: "Bob",
    authorEmail: "bob@example.com",
    authorTime: secondsAgo(26 * 3600),
    refs: [ref("tag", "v1.0")],
  }),
  makeCommit("aaa1111", {
    subject: "initial",
    authorTime: secondsAgo(40 * 86400),
  }),
];

describe("GitCommitList", () => {
  it("件名・ref の札・作者・相対時刻を並べる", () => {
    const { container } = setup({ commits: threeCommits, headSha: "ccc3333" });
    const rows = options(container);
    expect(rows.map(r => r.dataset.sha)).toEqual([
      "ccc3333",
      "bbb2222",
      "aaa1111",
    ]);
    expect(rows[0].textContent).toContain("ピークの見出しをまとめる");
    expect(rows[0].textContent).toContain("3分前");
    expect(
      [...rows[0].querySelectorAll("[data-ref-kind]")].map(el => [
        el.getAttribute("data-ref-kind"),
        el.textContent,
      ])
    ).toEqual([
      ["head", "main"],
      ["remote", "origin/main"],
    ]);
    expect(rows[1].querySelector('[data-ref-kind="tag"]')?.textContent).toBe(
      "v1.0"
    );
    expect(rows[1].textContent).toContain("昨日");
    expect(
      rows[1].querySelector('[data-testid="git-avatar"]')?.textContent
    ).toBe("B");
    // 時刻の title に絶対時刻と短いハッシュ
    const time = rows[2].querySelector("[title*='aaa1111']");
    expect(time?.getAttribute("title")).toMatch(
      /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2} · aaa1111$/
    );
    // グラフは行ごとに 1 つ。HEAD には外側の輪が付く
    expect(container.querySelectorAll("svg[height='28']")).toHaveLength(3);
    expect(rows[0].querySelector('[data-node="head-ring"]')).not.toBeNull();
    expect(rows[1].querySelector('[data-node="head-ring"]')).toBeNull();
  });

  it("ref が 3 つを超えたら、先頭の 2 つと「+n」にまとめる", () => {
    const { container } = setup({
      commits: [
        makeCommit("aaa1111", {
          refs: [
            ref("tag", "v2"),
            ref("remote", "origin/main"),
            ref("branch", "feat/x"),
            ref("head", "main"),
          ],
        }),
      ],
    });
    const labels = [...container.querySelectorAll("[data-ref-kind]")];
    expect(labels.map(el => el.textContent)).toEqual(["main", "feat/x", "+2"]);
    expect(labels[2].getAttribute("title")).toBe(
      "main\nfeat/x\norigin/main\nv2"
    );
  });

  it("ブランチの札が無い HEAD (detached) には「HEAD」の札を出す", () => {
    const { container } = setup({
      commits: [makeCommit("aaa1111")],
      headSha: "aaa1111",
    });
    expect(container.querySelector('[data-ref-kind="head"]')?.textContent).toBe(
      "HEAD"
    );
  });

  it("未コミットの変更の行は、変更があるときだけ先頭に出る", () => {
    const { container, rerender, onSelect } = setup({
      commits: threeCommits,
      headSha: "ccc3333",
    });
    expect(container.querySelector('[data-kind="working"]')).toBeNull();

    rerender({ workingCount: 3 });
    const rows = options(container);
    expect(rows).toHaveLength(4);
    expect(rows[0].dataset.kind).toBe("working");
    expect(rows[0].textContent).toBe("未コミットの変更 (3)");
    expect(rows[0].querySelector('[data-node="working"]')).not.toBeNull();
    // HEAD の行へ線がつながる
    expect(rows[0].querySelector('path[data-kind="out"]')).not.toBeNull();
    expect(rows[1].querySelector('path[data-kind="in"]')).not.toBeNull();

    click(rows[0]);
    expect(onSelect).toHaveBeenCalledWith({ kind: "working" });
  });

  it("クリックで選び、選んだ行に aria-selected が付く", () => {
    const { container, onSelect, rerender } = setup({ commits: threeCommits });
    click(options(container)[1]);
    expect(onSelect).toHaveBeenCalledWith({ kind: "commit", sha: "bbb2222" });

    rerender({ selection: { kind: "commit", sha: "bbb2222" } });
    expect(
      options(container).map(r => r.getAttribute("aria-selected"))
    ).toEqual(["false", "true", "false"]);
    expect(listbox(container).getAttribute("aria-activedescendant")).toBe(
      options(container)[1].id
    );
  });

  it("↑/↓/Home/End で選択を動かす", () => {
    const { container, onSelect, rerender } = setup({
      commits: threeCommits,
      workingCount: 1,
      headSha: "ccc3333",
      selection: { kind: "commit", sha: "ccc3333" },
    });
    press(listbox(container), "ArrowDown");
    expect(onSelect).toHaveBeenLastCalledWith({
      kind: "commit",
      sha: "bbb2222",
    });
    press(listbox(container), "ArrowUp");
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "working" });
    press(listbox(container), "End");
    expect(onSelect).toHaveBeenLastCalledWith({
      kind: "commit",
      sha: "aaa1111",
    });
    press(listbox(container), "Home");
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "working" });

    // 端では動かさない
    onSelect.mockClear();
    rerender({ selection: { kind: "commit", sha: "aaa1111" } });
    press(listbox(container), "ArrowDown");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("PageDown / PageUp は 1 画面ぶん動かし、選んだ行を見える位置へ寄せる", () => {
    const commits = linearCommits(200);
    const { container, onSelect, rerender } = setup({
      commits,
      selection: { kind: "commit", sha: commits[0].sha },
    });
    scrollTo(container, 0);
    // 280px = 10 行。1 画面ぶんは 9 行
    press(listbox(container), "PageDown");
    expect(onSelect).toHaveBeenLastCalledWith({
      kind: "commit",
      sha: commits[9].sha,
    });
    rerender({ selection: { kind: "commit", sha: commits[9].sha } });
    press(listbox(container), "PageDown");
    expect(onSelect).toHaveBeenLastCalledWith({
      kind: "commit",
      sha: commits[18].sha,
    });
    // 18 行目の下端 (19 × 28) が見えるところまで送る
    expect(listbox(container).scrollTop).toBe(19 * 28 - 280);

    rerender({ selection: { kind: "commit", sha: commits[18].sha } });
    press(listbox(container), "PageUp");
    expect(onSelect).toHaveBeenLastCalledWith({
      kind: "commit",
      sha: commits[9].sha,
    });
  });

  it("絞り込むと一致した行だけになり、グラフを描かない", () => {
    const { container } = setup({
      commits: threeCommits,
      headSha: "ccc3333",
      workingCount: 2,
    });
    typeInto(filterInput(container), "bob");
    expect(options(container).map(r => r.dataset.sha)).toEqual(["bbb2222"]);
    expect(container.querySelector("svg[height='28']")).toBeNull();
    // 未コミットの変更の行も出さない
    expect(container.querySelector('[data-kind="working"]')).toBeNull();

    typeInto(filterInput(container), "CCC33");
    expect(options(container).map(r => r.dataset.sha)).toEqual(["ccc3333"]);

    typeInto(filterInput(container), "どこにも無い");
    expect(options(container)).toHaveLength(0);
    expect(container.textContent).toContain("一致するコミットがありません");

    click(container.querySelector('button[aria-label="絞り込みを解除"]'));
    expect(options(container)).toHaveLength(4);
    expect(container.querySelectorAll("svg[height='28']")).toHaveLength(4);
  });

  it("見えている範囲とその前後だけを描く", () => {
    const commits = linearCommits(2000);
    const { container } = setup({ commits });
    scrollTo(container, 0);
    // 全行ぶんの高さは確保する
    const spacer = listbox(container).firstElementChild as HTMLElement;
    expect(spacer.style.height).toBe(`${2000 * 28}px`);
    expect(options(container).length).toBeLessThan(40);
    expect(options(container)[0].dataset.sha).toBe(commits[0].sha);

    scrollTo(container, 1000 * 28);
    const rows = options(container);
    expect(rows.length).toBeLessThan(40);
    expect(rows.map(r => r.dataset.sha)).toContain(commits[1000].sha);
    expect(rows.map(r => r.dataset.sha)).not.toContain(commits[0].sha);
    // 行は自分の位置に置かれる
    const row = rows.find(r => r.dataset.sha === commits[1000].sha);
    expect(row?.style.top).toBe(`${1000 * 28}px`);
  });

  it("末尾までスクロールしたら続きを頼む。読み込み中と続きが無いときは頼まない", () => {
    const commits = linearCommits(300);
    const { container, onLoadMore, rerender } = setup({
      commits,
      hasMore: true,
    });
    scrollTo(container, 0);
    expect(onLoadMore).not.toHaveBeenCalled();

    scrollTo(container, 300 * 28 - 280);
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    // 読み込み中は重ねて頼まない
    rerender({ loadingMore: true });
    scrollTo(container, 300 * 28 - 290);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("読み込み中…");

    rerender({ loadingMore: false, hasMore: false });
    scrollTo(container, 300 * 28 - 280);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("絞り込み中は自動では読まず、ボタンで続きを頼める", () => {
    const { container, onLoadMore } = setup({
      commits: linearCommits(20),
      hasMore: true,
    });
    typeInto(filterInput(container), "subject");
    scrollTo(container, 20 * 28);
    expect(onLoadMore).not.toHaveBeenCalled();
    click(
      [...container.querySelectorAll("button")].find(
        b => b.textContent === "さらに読み込む"
      )
    );
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("reveal の seq が変わったら、その行を中央へ寄せる", () => {
    const commits = linearCommits(500);
    const { container, rerender } = setup({ commits });
    scrollTo(container, 0);
    rerender({
      reveal: { selection: { kind: "commit", sha: commits[300].sha }, seq: 1 },
    });
    // (280 - 28) / 2 = 126 だけ上に余白を取る
    expect(listbox(container).scrollTop).toBe(300 * 28 - 126);
    expect(options(container).map(r => r.dataset.sha)).toContain(
      commits[300].sha
    );
  });

  it("読み直すボタンで onReload を呼ぶ", () => {
    const { container, onReload } = setup({ commits: threeCommits });
    click(container.querySelector('button[aria-label="読み直す"]'));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
