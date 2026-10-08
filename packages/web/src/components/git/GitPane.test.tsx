// @vitest-environment jsdom

import type {
  GitCommit,
  GitFingerprintResponse,
  GitLogResponse,
  GitRefsResponse,
  GitStatus,
  GitStatusResponse,
} from "@ark/shared";
import { act, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitPane } from "./GitPane";
import {
  click,
  linearCommits,
  makeCommit,
  mount,
  ref,
  unmountAll,
} from "./test-helpers";
import type { GitSelection } from "./types";

const fake = vi.hoisted(() => ({
  api: null as unknown,
  createGitApi: null as unknown,
}));
vi.mock("@/lib/git-api", () => ({
  createGitApi: (...args: unknown[]) =>
    (fake.createGitApi as (...a: unknown[]) => unknown)(...args),
}));

// 詳細の振る舞いは GitCommitDetail.test.tsx で見る。ここでは渡した選択だけを見る
vi.mock("./GitCommitDetail", () => ({
  GitCommitDetail: (props: {
    selection: GitSelection | null;
    refreshKey: number;
    refs?: { kind: string; name: string }[];
    onSelectCommit: (sha: string) => void;
  }) => (
    <div
      data-testid="detail"
      data-selection={
        props.selection === null
          ? "none"
          : props.selection.kind === "working"
            ? "working"
            : props.selection.sha
      }
      data-refresh={String(props.refreshKey)}
      data-refs={
        props.refs
          ? props.refs.map(r => `${r.kind}:${r.name}`).join(",")
          : "none"
      }
    >
      <button type="button" onClick={() => props.onSelectCommit("far0000")}>
        parent
      </button>
    </div>
  ),
}));

const EMPTY_STATUS: GitStatus = { staged: [], unstaged: [], untracked: [] };
const DIRTY_STATUS: GitStatus = {
  staged: [],
  unstaged: [{ path: "a.ts", status: "M", added: 1, removed: 0 }],
  untracked: [],
};

/** サーバーの代わり。state を書き換えると、次の問い合わせから応答が変わる */
function makeServer(initial: GitCommit[]) {
  const state = {
    commits: initial,
    status: EMPTY_STATUS,
    fingerprint: "fp-1",
    error: null as string | null,
  };
  const head = () => state.commits[0]?.sha ?? null;
  const api = {
    fingerprint: vi.fn(
      async (): Promise<GitFingerprintResponse> =>
        state.error
          ? { ok: false, error: state.error }
          : { ok: true, fingerprint: state.fingerprint }
    ),
    refs: vi.fn(
      async (): Promise<GitRefsResponse> =>
        state.error
          ? { ok: false, error: state.error }
          : {
              ok: true,
              head: { sha: head(), branch: "main" },
              branches: [
                { name: "main", sha: head() ?? "", current: true },
                { name: "old", sha: "0000001", current: false },
              ],
              remotes: [],
              tags: [],
              stashes: [],
            }
    ),
    status: vi.fn(
      async (): Promise<GitStatusResponse> =>
        state.error
          ? { ok: false, error: state.error }
          : { ok: true, ...state.status }
    ),
    log: vi.fn(
      async (skip: number, limit: number): Promise<GitLogResponse> =>
        state.error
          ? { ok: false, error: state.error }
          : {
              ok: true,
              commits: state.commits.slice(skip, skip + limit),
              hasMore: skip + limit < state.commits.length,
            }
    ),
    commit: vi.fn(),
    fileDiff: vi.fn(),
  };
  return { state, api };
}

type Server = ReturnType<typeof makeServer>;

const socket = {} as never;

function render(server: Server, isActive = true) {
  fake.api = server.api;
  const element = (active: boolean): ReactElement => (
    <GitPane socket={socket} sessionId="s1" isActive={active} />
  );
  const { container, rerender } = mount(element(isActive));
  return {
    container,
    setActive: (active: boolean) => rerender(element(active)),
  };
}

/** 溜まっている応答を流しきる (時間は進めない) */
const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const detail = (scope: ParentNode) =>
  scope.querySelector<HTMLElement>('[data-testid="detail"]');
const rows = (scope: ParentNode) => [
  ...scope.querySelectorAll<HTMLElement>('[role="option"]'),
];
const selectedRow = (scope: ParentNode) =>
  scope.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
const buttonByText = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll("button")].find(b =>
    b.textContent?.startsWith(text)
  );

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.useFakeTimers();
  fake.createGitApi = vi.fn(() => fake.api);
});

afterEach(() => {
  unmountAll();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GitPane", () => {
  it("socket が無ければ接続中を出し、何も問い合わせない", () => {
    const { container } = mount(
      <GitPane socket={null} sessionId="s1" isActive />
    );
    expect(container.textContent).toContain("接続中…");
    expect(fake.createGitApi).not.toHaveBeenCalled();
  });

  it("初めて見えたときに refs・status・先頭の 300 件を読み、HEAD を選ぶ", async () => {
    const commits = linearCommits(400);
    const server = makeServer(commits);
    const { container } = render(server);
    expect(
      container.querySelector('[data-testid="git-skeleton"]')
    ).not.toBeNull();
    await settle();
    expect(fake.createGitApi).toHaveBeenCalledWith(socket, "s1");
    expect(server.api.refs).toHaveBeenCalledTimes(1);
    expect(server.api.status).toHaveBeenCalledTimes(1);
    expect(server.api.log.mock.calls).toEqual([[0, 300]]);
    expect(container.querySelector('[data-testid="git-skeleton"]')).toBeNull();
    // 既定の選択は HEAD
    expect(detail(container)?.dataset.selection).toBe(commits[0].sha);
    expect(selectedRow(container)?.dataset.sha).toBe(commits[0].sha);
    // サイドバーにブランチが出る
    expect(buttonByText(container, "main")).toBeDefined();
  });

  it("コミットが無く変更だけがあるときは、未コミットの変更を選ぶ", async () => {
    const server = makeServer([]);
    server.state.status = DIRTY_STATUS;
    const { container } = render(server);
    await settle();
    expect(detail(container)?.dataset.selection).toBe("working");
    expect(rows(container).map(r => r.dataset.kind)).toEqual(["working"]);
  });

  it("空のリポジトリ (git log が失敗する) でも、空の一覧を出す", async () => {
    const server = makeServer([]);
    server.api.log.mockResolvedValue({
      ok: false,
      error: "does not have any commits yet",
    });
    const { container } = render(server);
    await settle();
    expect(container.textContent).toContain("コミットがありません");
    expect(detail(container)?.dataset.selection).toBe("none");
  });

  it("見えている間だけ 3 秒ごとに指紋を問い合わせ、隠れている間は何もしない", async () => {
    const server = makeServer(linearCommits(3));
    const { setActive } = render(server);
    await settle();
    expect(server.api.fingerprint).toHaveBeenCalledTimes(1);

    await advance(3000);
    await advance(3000);
    expect(server.api.fingerprint).toHaveBeenCalledTimes(3);
    // 指紋が同じなら読み直さない
    expect(server.api.refs).toHaveBeenCalledTimes(1);

    setActive(false);
    await advance(30_000);
    expect(server.api.fingerprint).toHaveBeenCalledTimes(3);

    // 見えた瞬間に 1 回問い合わせ、そこからまた 3 秒ごと
    setActive(true);
    await settle();
    expect(server.api.fingerprint).toHaveBeenCalledTimes(4);
    await advance(3000);
    expect(server.api.fingerprint).toHaveBeenCalledTimes(5);
  });

  it("見えていない状態でマウントされたら、見えるまで読まない", async () => {
    const server = makeServer(linearCommits(3));
    const { container, setActive } = render(server, false);
    await advance(10_000);
    expect(server.api.fingerprint).not.toHaveBeenCalled();
    expect(server.api.log).not.toHaveBeenCalled();

    setActive(true);
    await settle();
    expect(rows(container)).toHaveLength(3);
  });

  it("指紋が変わったら読み直し、選択を保つ", async () => {
    const commits = linearCommits(5);
    const server = makeServer(commits);
    const { container } = render(server);
    await settle();
    click(rows(container)[2]);
    expect(detail(container)?.dataset.selection).toBe(commits[2].sha);
    const refresh = detail(container)?.dataset.refresh;

    // 新しいコミットが積まれ、作業ツリーも汚れた
    const added = makeCommit("fffffff", { parents: [commits[0].sha] });
    server.state.commits = [added, ...commits];
    server.state.status = DIRTY_STATUS;
    server.state.fingerprint = "fp-2";
    await advance(3000);

    expect(server.api.refs).toHaveBeenCalledTimes(2);
    expect(rows(container).map(r => r.dataset.sha ?? r.dataset.kind)).toEqual([
      "working",
      "fffffff",
      ...commits.map(c => c.sha),
    ]);
    // 選んでいたコミットはそのまま
    expect(detail(container)?.dataset.selection).toBe(commits[2].sha);
    expect(selectedRow(container)?.dataset.sha).toBe(commits[2].sha);
    // 詳細には読み直したことが伝わる
    expect(detail(container)?.dataset.refresh).not.toBe(refresh);
    expect(buttonByText(container, "変更")?.textContent).toBe("変更 (1)");
  });

  it("選んでいたコミットが消えたら (amend 等) HEAD へ戻す", async () => {
    const commits = linearCommits(4);
    const server = makeServer(commits);
    const { container } = render(server);
    await settle();
    click(rows(container)[0]);

    // 先頭が書き換わった
    const amended = makeCommit("eeeeeee", { parents: [commits[1].sha] });
    server.state.commits = [amended, ...commits.slice(1)];
    server.state.fingerprint = "fp-2";
    await advance(3000);
    expect(detail(container)?.dataset.selection).toBe("eeeeeee");
  });

  it("3,000 件より先まで読み足して選んだコミットは、読み直しで範囲の外へ出ても保つ", async () => {
    const commits = linearCommits(4000);
    commits[3100] = makeCommit("far0000", {
      parents: commits[3100].parents,
    });
    commits[3099] = { ...commits[3099], parents: ["far0000"] };
    const server = makeServer(commits);
    const { container } = render(server);
    await settle();
    // 親のハッシュから飛ぶ (3,000 件まで読み足しても見つからない)
    click(buttonByText(container, "parent"));
    await settle();
    // 手で続きを読み、選んだコミットを一覧に入れる
    click(buttonByText(container, "さらに読み込む"));
    await settle();
    expect(server.api.log.mock.calls.at(-1)).toEqual([3000, 300]);

    server.state.fingerprint = "fp-2";
    await advance(3000);
    expect(server.api.log.mock.calls.at(-1)).toEqual([2700, 300]);
    expect(detail(container)?.dataset.selection).toBe("far0000");
  });

  it("未コミットの変更を選んでいて変更が無くなったら、HEAD へ戻す", async () => {
    const commits = linearCommits(2);
    const server = makeServer(commits);
    server.state.status = DIRTY_STATUS;
    const { container } = render(server);
    await settle();
    click(rows(container)[0]);
    expect(detail(container)?.dataset.selection).toBe("working");

    server.state.status = EMPTY_STATUS;
    server.state.fingerprint = "fp-2";
    await advance(3000);
    expect(detail(container)?.dataset.selection).toBe(commits[0].sha);
  });

  it("読み直しは読み込み済みの件数ぶんを、300 件ずつ読む", async () => {
    const commits = linearCommits(1000);
    const server = makeServer(commits);
    const { container } = render(server);
    await settle();
    click(buttonByText(container, "さらに読み込む"));
    await settle();
    expect(server.api.log.mock.calls).toEqual([
      [0, 300],
      [300, 300],
    ]);

    server.api.log.mockClear();
    server.state.fingerprint = "fp-2";
    await advance(3000);
    expect(server.api.log.mock.calls).toEqual([
      [0, 300],
      [300, 300],
    ]);
  });

  it("問い合わせが重なっても、古い読み込みの結果で新しい状態を上書きしない", async () => {
    const commits = linearCommits(3);
    const server = makeServer(commits);
    const { container } = render(server);
    await settle();

    // 1 回目の読み直し (遅い) と 2 回目の読み直し (速い) を重ねる
    const older = [makeCommit("1111111"), ...commits];
    const newer = [makeCommit("2222222"), ...commits];
    let releaseSlow: (r: GitRefsResponse) => void = () => undefined;
    const refsOf = (list: GitCommit[]): GitRefsResponse => ({
      ok: true,
      head: { sha: list[0].sha, branch: "main" },
      branches: [],
      remotes: [],
      tags: [],
      stashes: [],
    });
    server.api.refs.mockImplementationOnce(
      () =>
        new Promise<GitRefsResponse>(resolve => {
          releaseSlow = resolve;
        })
    );
    server.state.commits = older;
    click(container.querySelector('button[aria-label="読み直す"]'));
    await settle();

    server.state.commits = newer;
    click(container.querySelector('button[aria-label="読み直す"]'));
    await settle();
    expect(rows(container)[0].dataset.sha).toBe("2222222");
    const refresh = detail(container)?.dataset.refresh;
    const logCalls = server.api.log.mock.calls.length;

    // 遅れて 1 回目が返っても、2 回目の結果のまま (state を書かない)
    server.state.commits = older;
    await act(async () => {
      releaseSlow(refsOf(older));
      await vi.advanceTimersByTimeAsync(0);
    });
    // 1 回目の読み込み自体は最後まで進んでいる
    expect(server.api.log.mock.calls.length).toBe(logCalls + 1);
    expect(rows(container)[0].dataset.sha).toBe("2222222");
    expect(detail(container)?.dataset.refresh).toBe(refresh);
  });

  it("指紋の問い合わせは重ねて走らせない", async () => {
    const server = makeServer(linearCommits(2));
    render(server);
    await settle();
    let release: (r: GitFingerprintResponse) => void = () => undefined;
    server.api.fingerprint.mockImplementationOnce(
      () =>
        new Promise<GitFingerprintResponse>(resolve => {
          release = resolve;
        })
    );
    await advance(3000);
    expect(server.api.fingerprint).toHaveBeenCalledTimes(2);
    // 応答が返らないあいだは、次の周期でも問い合わせない
    await advance(9000);
    expect(server.api.fingerprint).toHaveBeenCalledTimes(2);

    await act(async () => {
      release({ ok: true, fingerprint: "fp-1" });
      await vi.advanceTimersByTimeAsync(0);
    });
    await advance(3000);
    expect(server.api.fingerprint).toHaveBeenCalledTimes(3);
  });

  it("読めなければサーバーの理由を出し、再試行で読み直す", async () => {
    const server = makeServer(linearCommits(2));
    server.state.error = "git リポジトリではありません";
    const { container } = render(server);
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "git リポジトリではありません"
    );
    expect(rows(container)).toHaveLength(0);

    server.state.error = null;
    click(buttonByText(container, "再試行"));
    await settle();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(rows(container)).toHaveLength(2);
  });

  it("読めなかったあとも、指紋が取れるようになったら自分で読み直す", async () => {
    const server = makeServer(linearCommits(2));
    server.state.error = "サーバーから応答がありません";
    const { container } = render(server);
    await settle();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    server.state.error = null;
    await advance(3000);
    expect(rows(container)).toHaveLength(2);
  });

  it("最初の読み込みで指紋だけ取れて残りが失敗しても、同じ指紋の次の周期で読み直す", async () => {
    const server = makeServer(linearCommits(2));
    server.api.refs.mockResolvedValueOnce({ ok: false, error: "timeout" });
    const { container } = render(server);
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "timeout"
    );

    // 指紋はfp-1のまま
    await advance(3000);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(rows(container)).toHaveLength(2);
    expect(server.api.refs).toHaveBeenCalledTimes(2);

    // 立ち直ったあとは、指紋が変わらなければ読み直さない
    await advance(3000);
    expect(server.api.refs).toHaveBeenCalledTimes(2);
  });

  it("再試行のボタンでの読み直しが失敗しても、次の周期で読み直す", async () => {
    const server = makeServer(linearCommits(2));
    server.api.refs.mockResolvedValueOnce({ ok: false, error: "timeout" });
    const { container } = render(server);
    await settle();
    server.api.refs.mockResolvedValueOnce({ ok: false, error: "timeout" });
    click(buttonByText(container, "再試行"));
    await settle();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    await advance(3000);
    expect(rows(container)).toHaveLength(2);
  });

  it("続きの読み込みに失敗したら自動では頼み直さず、再試行の行から読み直せる", async () => {
    const server = makeServer(linearCommits(800));
    const { container } = render(server);
    await settle();
    expect(server.api.log).toHaveBeenCalledTimes(1);

    const scrollToEnd = () => {
      const el = container.querySelector('[role="listbox"]') as HTMLDivElement;
      Object.defineProperty(el, "clientHeight", {
        configurable: true,
        value: 280,
      });
      act(() => {
        el.scrollTop = 300 * 28 - 280;
        el.dispatchEvent(new Event("scroll"));
      });
    };
    server.api.log.mockResolvedValueOnce({ ok: false, error: "timeout" });
    scrollToEnd();
    await settle();
    // 失敗した1回だけ。末尾が見えたままでも繰り返さない
    expect(server.api.log).toHaveBeenCalledTimes(2);
    await advance(3000);
    scrollToEnd();
    await settle();
    expect(server.api.log).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("続きを読み込めませんでした");

    click(buttonByText(container, "再試行"));
    await settle();
    expect(server.api.log).toHaveBeenCalledTimes(3);
    expect(server.api.log.mock.calls.at(-1)).toEqual([300, 300]);
    expect(container.textContent).not.toContain("続きを読み込めませんでした");
  });

  it("続きの読み込みの失敗は、読み直しが成功したら消える", async () => {
    const server = makeServer(linearCommits(800));
    const { container } = render(server);
    await settle();
    server.api.log.mockResolvedValueOnce({ ok: false, error: "timeout" });
    click(buttonByText(container, "old"));
    await settle();
    expect(container.textContent).toContain("続きを読み込めませんでした");

    server.state.fingerprint = "fp-2";
    await advance(3000);
    expect(container.textContent).not.toContain("続きを読み込めませんでした");
  });

  it("選んだコミットのいまのrefを、読み込み済みの一覧から詳細へ渡す", async () => {
    const [top, ...rest] = linearCommits(3);
    const server = makeServer([
      { ...top, refs: [ref("head", "main")] },
      ...rest,
    ]);
    const { container } = render(server);
    await settle();
    expect(detail(container)?.dataset.refs).toBe("head:main");

    // 新しいコミットが積まれ、選んでいたコミットはHEADでなくなる
    server.state.commits = [
      makeCommit("fffffff", {
        parents: [top.sha],
        refs: [ref("head", "main")],
      }),
      { ...top, refs: [] },
      ...rest,
    ];
    server.state.fingerprint = "fp-2";
    await advance(3000);
    expect(detail(container)?.dataset.selection).toBe(top.sha);
    expect(detail(container)?.dataset.refs).toBe("");

    // 一覧に無いコミットは渡さない (詳細が自分の応答のrefを出す)
    click(buttonByText(container, "parent"));
    await settle();
    expect(detail(container)?.dataset.refs).toBe("none");
  });

  it("一度出したあとの読み直しが失敗しても、出しているものを残して次の周期で試し直す", async () => {
    const server = makeServer(linearCommits(2));
    const { container } = render(server);
    await settle();

    server.state.fingerprint = "fp-2";
    server.api.refs.mockResolvedValueOnce({ ok: false, error: "timeout" });
    await advance(3000);
    expect(rows(container)).toHaveLength(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();

    server.state.commits = [makeCommit("fffffff"), ...server.state.commits];
    await advance(3000);
    expect(rows(container)).toHaveLength(3);
  });

  it("サイドバーの ref を押すと、読み込み済みに無ければ見つかるまで読み足して選ぶ", async () => {
    // 0000001 (old ブランチ) は末尾。先頭の 300 件には入らない
    const commits = linearCommits(800);
    const server = makeServer(commits);
    const { container } = render(server);
    await settle();
    expect(server.api.log).toHaveBeenCalledTimes(1);

    click(buttonByText(container, "old"));
    // 詳細は先に替わる (sha だけで取れる)
    expect(detail(container)?.dataset.selection).toBe("0000001");
    await settle();
    expect(server.api.log.mock.calls).toEqual([
      [0, 300],
      [300, 300],
      [600, 300],
    ]);
    expect(detail(container)?.dataset.selection).toBe("0000001");
  });

  it("読み足しは 3,000 件で打ち切る", async () => {
    const server = makeServer(linearCommits(4000));
    const { container } = render(server);
    await settle();
    // 一覧に無い sha (親のハッシュから飛ぶ)
    click(buttonByText(container, "parent"));
    await settle();
    expect(server.api.log).toHaveBeenCalledTimes(10);
    expect(server.api.log.mock.calls.at(-1)).toEqual([2700, 300]);
    expect(detail(container)?.dataset.selection).toBe("far0000");
  });

  it("サイドバーの「変更」で未コミットの変更を選ぶ", async () => {
    const server = makeServer(linearCommits(2));
    server.state.status = DIRTY_STATUS;
    const { container } = render(server);
    await settle();
    click(buttonByText(container, "変更"));
    expect(detail(container)?.dataset.selection).toBe("working");
    expect(selectedRow(container)?.dataset.kind).toBe("working");
  });

  it("サイドバーの折りたたみを localStorage に残す", async () => {
    const server = makeServer(linearCommits(2));
    const { container } = render(server);
    await settle();
    const sidebar = () =>
      container.querySelector('nav[aria-label="Git の参照"]')?.parentElement;
    expect(sidebar()?.classList.contains("hidden")).toBe(false);

    click(
      container.querySelector('button[aria-label="サイドバーを折りたたむ"]')
    );
    expect(sidebar()?.classList.contains("hidden")).toBe(true);
    expect(localStorage.getItem("ark-git-sidebar-collapsed")).toBe("1");
    unmountAll();

    const again = render(server);
    await settle();
    expect(
      again.container.querySelector('button[aria-label="サイドバーを開く"]')
    ).not.toBeNull();
  });

  it("詳細の高さは比率で持ち、ドラッグで変えて 0.2〜0.8 に収める", async () => {
    localStorage.setItem("ark-git-detail-height", "0.3");
    const server = makeServer(linearCommits(2));
    const { container } = render(server);
    await settle();
    const detailArea = container.querySelector(
      '[data-testid="git-detail-area"]'
    ) as HTMLElement;
    expect(detailArea.style.flexGrow).toBe("0.3");

    const column = detailArea.parentElement as HTMLElement;
    vi.spyOn(column, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 1000,
      height: 1000,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const handle = container.querySelector(
      'button[aria-label="一覧と詳細の高さを調整"]'
    ) as HTMLElement;
    act(() => {
      handle.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      );
    });
    act(() => {
      window.dispatchEvent(new MouseEvent("mousemove", { clientY: 400 }));
    });
    expect(detailArea.style.flexGrow).toBe("0.6");
    // 上へ引きすぎても 0.8 で止まる
    act(() => {
      window.dispatchEvent(new MouseEvent("mousemove", { clientY: 10 }));
    });
    expect(detailArea.style.flexGrow).toBe("0.8");
    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup"));
    });
    expect(localStorage.getItem("ark-git-detail-height")).toBe("0.8");
  });

  it("保存した高さが壊れていれば既定 (0.45) にする", async () => {
    localStorage.setItem("ark-git-detail-height", "abc");
    const server = makeServer(linearCommits(1));
    const { container } = render(server);
    await settle();
    expect(
      (
        container.querySelector(
          '[data-testid="git-detail-area"]'
        ) as HTMLElement
      ).style.flexGrow
    ).toBe("0.45");
  });
});
