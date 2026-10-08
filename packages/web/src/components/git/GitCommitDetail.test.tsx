// @vitest-environment jsdom

import type {
  GitCommitDetail as CommitDetail,
  GitCommitResponse,
  GitFileChange,
  GitFileDiffResponse,
  GitStatus,
} from "@ark/shared";
import { act, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitCommitDetail } from "./GitCommitDetail";
import {
  click,
  flush,
  makeCommit,
  mount,
  ref,
  unmountAll,
} from "./test-helpers";

// 差分の描画 (CodeMirror) は GitDiffView.test.tsx で見る。ここでは渡した内容だけを見る
vi.mock("./GitDiffView", () => ({
  default: (props: {
    path: string;
    oldContent: string;
    newContent: string;
  }) => (
    <div
      data-testid="diff-view"
      data-path={props.path}
      data-old={props.oldContent}
      data-new={props.newContent}
    />
  ),
}));

vi.mock("../FileIcon", () => ({
  FileIcon: ({ name }: { name: string }) => (
    <i data-testid="file-icon" data-name={name} />
  ),
}));

type Props = ComponentProps<typeof GitCommitDetail>;

const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime();

const change = (
  path: string,
  status: GitFileChange["status"],
  added: number | null = 1,
  removed: number | null = 0,
  oldPath?: string
): GitFileChange => ({ path, status, added, removed, oldPath });

const detail = (
  sha: string,
  overrides: Partial<CommitDetail> = {}
): CommitDetail => ({
  ...makeCommit(sha),
  body: "",
  committerName: "Alice Example",
  committerTime: 1_780_000_000,
  ...overrides,
});

const okDiff = (
  oldContent: string,
  newContent: string
): GitFileDiffResponse => ({
  ok: true,
  oldContent,
  newContent,
  binary: false,
  tooLarge: false,
});

const commitFiles = [
  change("packages/web/src/FilePeek.tsx", "M", 57, 38),
  change("packages/web/src/FileIcon.tsx", "A", 80, 0),
  change("docs/old.md", "D", 0, 12),
  change("src/new-name.ts", "R", 2, 1, "src/old-name.ts"),
  change("logo.png", "M", null, null),
];

function setup(overrides: Partial<Props> = {}) {
  const commit = vi.fn(
    async (sha: string): Promise<GitCommitResponse> => ({
      ok: true,
      commit: detail(sha, {
        subject: "ピークの見出しをまとめる",
        body: "1 行目\n\n3 行目\n",
        parents: ["1111111aaaaaaa", "2222222bbbbbbb"],
        refs: [ref("head", "main")],
      }),
      files: commitFiles,
    })
  );
  const fileDiff = vi.fn(
    async (_target: unknown, path: string): Promise<GitFileDiffResponse> =>
      okDiff(`old ${path}`, `new ${path}`)
  );
  const onSelectCommit = vi.fn();
  const props: Props = {
    api: { commit, fileDiff },
    selection: { kind: "commit", sha: "abc1234def" },
    status: null,
    refreshKey: 1,
    onSelectCommit,
    now: NOW,
    ...overrides,
  };
  const { container, rerender } = mount(<GitCommitDetail {...props} />);
  return {
    container,
    commit,
    fileDiff,
    onSelectCommit,
    props,
    rerender: (next: Partial<Props>) =>
      rerender(<GitCommitDetail {...props} {...next} />),
  };
}

const tabs = (scope: ParentNode) => [
  ...scope.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
];
const tabByLabel = (scope: ParentNode, label: string) =>
  tabs(scope).find(t => t.textContent?.startsWith(label));
const fileRows = (scope: ParentNode) => [
  ...scope.querySelectorAll<HTMLButtonElement>("button[data-path]"),
];
const diffView = (scope: ParentNode) =>
  scope.querySelector<HTMLElement>('[data-testid="diff-view"]');
const openButton = (scope: ParentNode) =>
  [...scope.querySelectorAll("button")].find(b =>
    b.textContent?.includes("ファイルで開く")
  ) as HTMLButtonElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("GitCommitDetail", () => {
  it("何も選んでいなければ案内を出し、何も取りに行かない", async () => {
    const { container, commit } = setup({ selection: null });
    await flush();
    expect(container.textContent).toContain("コミットを選ぶと");
    expect(commit).not.toHaveBeenCalled();
  });

  it("既定は「変更」のタブで、ファイルの数を出す", async () => {
    const { container, commit } = setup();
    expect(container.textContent).toContain("読み込み中…");
    await flush();
    expect(commit).toHaveBeenCalledWith("abc1234def");
    expect(tabs(container).map(t => t.textContent)).toEqual([
      "コミット",
      "変更 5",
    ]);
    expect(tabByLabel(container, "変更")?.getAttribute("aria-selected")).toBe(
      "true"
    );
  });

  it("ファイル一覧に状態・名前・ディレクトリ・増減を出す", async () => {
    const { container } = setup();
    await flush();
    const rows = fileRows(container);
    expect(rows.map(r => r.dataset.path)).toEqual(commitFiles.map(f => f.path));
    expect(
      rows.map(
        r => r.querySelector('[data-testid="git-file-status"]')?.textContent
      )
    ).toEqual(["M", "A", "D", "R", "M"]);
    expect(rows[0].querySelector(".font-semibold")?.textContent).toBe(
      "FilePeek.tsx"
    );
    expect(rows[0].textContent).toContain("packages/web/src/");
    expect(
      rows.map(
        r => r.querySelector('[data-testid="git-file-counts"]')?.textContent
      )
    ).toEqual(["+57 −38", "+80", "−12", "+2 −1", undefined]);
    // リネームは「元 → 先」
    expect(rows[3].textContent).toContain("old-name.ts → new-name.ts");
    expect(rows[3].title).toBe("src/old-name.ts → src/new-name.ts");
    // バイナリは増減の代わりにその旨
    expect(rows[4].textContent).toContain("バイナリ");
  });

  it("先頭のファイルを自動で選び、その差分を出す", async () => {
    const { container, fileDiff } = setup();
    await flush();
    await flush();
    expect(fileDiff).toHaveBeenCalledTimes(1);
    expect(fileDiff).toHaveBeenCalledWith(
      { kind: "commit", sha: "abc1234def" },
      "packages/web/src/FilePeek.tsx",
      undefined
    );
    expect(fileRows(container)[0].getAttribute("aria-selected")).toBe("true");
    expect(diffView(container)?.dataset.path).toBe(
      "packages/web/src/FilePeek.tsx"
    );
    expect(diffView(container)?.dataset.old).toBe(
      "old packages/web/src/FilePeek.tsx"
    );
    expect(diffView(container)?.dataset.new).toBe(
      "new packages/web/src/FilePeek.tsx"
    );
    expect(
      container.querySelector('[data-testid="git-diff-path"]')?.textContent
    ).toBe("packages/web/src/FilePeek.tsx");
  });

  it("ファイルを選ぶと、その (対象, パス, 元のパス) で差分を取る", async () => {
    const { container, fileDiff } = setup();
    await flush();
    await flush();
    click(fileRows(container)[3]);
    await flush();
    expect(fileDiff).toHaveBeenLastCalledWith(
      { kind: "commit", sha: "abc1234def" },
      "src/new-name.ts",
      "src/old-name.ts"
    );
    expect(diffView(container)?.dataset.path).toBe("src/new-name.ts");
    expect(
      container.querySelector('[data-testid="git-diff-path"]')?.textContent
    ).toBe("src/old-name.ts → src/new-name.ts");
  });

  it("遅れて届いた古い差分で、新しい選択を上書きしない", async () => {
    const pending: Array<(r: GitFileDiffResponse) => void> = [];
    const fileDiff = vi.fn(
      () =>
        new Promise<GitFileDiffResponse>(resolve => {
          pending.push(resolve);
        })
    );
    const { container, props } = setup();
    unmountAll();
    const again = mount(
      <GitCommitDetail
        {...props}
        api={{ commit: props.api.commit, fileDiff }}
      />
    );
    await flush();
    expect(container.isConnected).toBe(false);
    click(fileRows(again.container)[1]);
    await flush();
    expect(pending).toHaveLength(2);
    // 2 つ目 (新しい選択) が先に返り、1 つ目があとから返る
    await act(async () => pending[1](okDiff("", "second")));
    await flush();
    await act(async () => pending[0](okDiff("", "first")));
    await flush();
    expect(diffView(again.container)?.dataset.new).toBe("second");
  });

  it("バイナリ・大きすぎるファイル・失敗はその旨を出す", async () => {
    const responses: Record<string, GitFileDiffResponse> = {
      "logo.png": {
        ok: true,
        oldContent: "",
        newContent: "",
        binary: true,
        tooLarge: false,
      },
      "docs/old.md": {
        ok: true,
        oldContent: "",
        newContent: "",
        binary: false,
        tooLarge: true,
      },
      "src/new-name.ts": { ok: false, error: "差分を取れませんでした" },
    };
    const fileDiff = vi.fn(
      async (_t: unknown, path: string) => responses[path] ?? okDiff("a", "b")
    );
    const base = setup();
    unmountAll();
    const { container } = mount(
      <GitCommitDetail
        {...base.props}
        api={{ commit: base.props.api.commit, fileDiff }}
      />
    );
    await flush();
    await flush();

    click(fileRows(container)[4]);
    await flush();
    expect(container.textContent).toContain("バイナリファイルです");
    expect(diffView(container)).toBeNull();

    click(fileRows(container)[2]);
    await flush();
    expect(container.textContent).toContain("大きすぎるため表示できません");

    click(fileRows(container)[3]);
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "差分を取れませんでした"
    );
  });

  it("「ファイルで開く」は ark:open-file を投げる。削除されたファイルでは押せない", async () => {
    const postMessage = vi
      .spyOn(window, "postMessage")
      .mockImplementation(() => undefined);
    const { container } = setup();
    await flush();
    await flush();
    expect(openButton(container).disabled).toBe(false);
    click(openButton(container));
    expect(postMessage).toHaveBeenCalledWith(
      { type: "ark:open-file", path: "packages/web/src/FilePeek.tsx" },
      window.location.origin
    );

    click(fileRows(container)[2]);
    await flush();
    expect(openButton(container).disabled).toBe(true);
  });

  it("「コミット」のタブに件名・本文・作者・ハッシュ・親・ref を出す", async () => {
    const { container, onSelectCommit } = setup();
    await flush();
    click(tabByLabel(container, "コミット"));
    expect(container.querySelector("h3")?.textContent).toBe(
      "ピークの見出しをまとめる"
    );
    expect(
      container.querySelector('[data-testid="git-commit-body"]')?.textContent
    ).toBe("1 行目\n\n3 行目");
    expect(container.textContent).toContain("Alice Example");
    expect(container.textContent).toContain("alice@example.com");
    expect(
      container.querySelector('[data-testid="git-full-sha"]')?.textContent
    ).toBe("abc1234def");
    expect(container.querySelector('[data-ref-kind="head"]')?.textContent).toBe(
      "main"
    );
    // コミッターが作者と同じなら出さない
    expect(container.querySelector('[data-testid="git-committer"]')).toBeNull();

    const parents = [
      ...container.querySelectorAll<HTMLButtonElement>("button[data-parent]"),
    ];
    expect(parents.map(p => p.textContent)).toEqual(["1111111", "2222222"]);
    click(parents[1]);
    expect(onSelectCommit).toHaveBeenCalledWith("2222222bbbbbbb");
  });

  it("refは渡されたいまの値を出し、変わってもコミットを取り直さない", async () => {
    const { container, commit, rerender } = setup({
      refs: [ref("head", "main"), ref("tag", "v1")],
    });
    await flush();
    click(tabByLabel(container, "コミット"));
    const labels = () =>
      [...container.querySelectorAll<HTMLElement>("[data-ref-kind]")].map(
        el => `${el.dataset.refKind}:${el.textContent}`
      );
    expect(labels()).toEqual(["head:main", "tag:v1"]);

    // 新しいコミットが積まれてHEADでなくなった (応答のrefはhead:mainのまま)
    rerender({ refs: [ref("tag", "v1")] });
    await flush();
    expect(labels()).toEqual(["tag:v1"]);

    rerender({ refs: [] });
    await flush();
    expect(labels()).toEqual([]);
    expect(commit).toHaveBeenCalledTimes(1);

    // 一覧に無いコミット (refs未指定) は応答のrefを出す
    rerender({ refs: undefined });
    await flush();
    expect(labels()).toEqual(["head:main"]);
  });

  it("競合したファイルには「バイナリ」と出さない", async () => {
    const { container } = setup({
      selection: { kind: "working" },
      status: {
        staged: [],
        unstaged: [change("c.txt", "U", null, null)],
        untracked: [],
      },
    });
    await flush();
    expect(fileRows(container)).toHaveLength(1);
    expect(container.textContent).not.toContain("バイナリ");
  });

  it("コミッターが作者と違うときだけ、コミッターの行を出す", async () => {
    const commit = vi.fn(
      async (sha: string): Promise<GitCommitResponse> => ({
        ok: true,
        commit: detail(sha, { committerName: "GitHub" }),
        files: [],
      })
    );
    const base = setup();
    unmountAll();
    const { container } = mount(
      <GitCommitDetail
        {...base.props}
        api={{ commit, fileDiff: base.props.api.fileDiff }}
      />
    );
    await flush();
    expect(container.textContent).toContain("変更はありません");
    click(tabByLabel(container, "コミット"));
    expect(
      container.querySelector('[data-testid="git-committer"]')?.textContent
    ).toContain("GitHub");
    expect(container.textContent).toContain("なし (最初のコミット)");
  });

  it("ハッシュをコピーでき、少しのあいだ印を出す", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { container } = setup();
    await flush();
    click(tabByLabel(container, "コミット"));
    const button = () =>
      container.querySelector(
        'button[aria-label="ハッシュをコピー"]'
      ) as HTMLButtonElement;
    click(button());
    await flush();
    expect(writeText).toHaveBeenCalledWith("abc1234def");
    expect(button().title).toBe("コピーしました");
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(button().title).toBe("ハッシュをコピー");
  });

  it("クリップボードが使えなくても落ちない", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    });
    const { container } = setup();
    await flush();
    click(tabByLabel(container, "コミット"));
    click(container.querySelector('button[aria-label="ハッシュをコピー"]'));
    await flush();
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="ハッシュをコピー"]'
      )?.title
    ).toBe("ハッシュをコピー");
  });

  it("コミットを取れなければ理由を出し、再試行できる", async () => {
    let fail = true;
    const commit = vi.fn(
      async (sha: string): Promise<GitCommitResponse> =>
        fail
          ? { ok: false, error: "コミットが見つかりません" }
          : { ok: true, commit: detail(sha), files: commitFiles }
    );
    const base = setup();
    unmountAll();
    const { container } = mount(
      <GitCommitDetail
        {...base.props}
        api={{ commit, fileDiff: base.props.api.fileDiff }}
      />
    );
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "コミットが見つかりません"
    );
    fail = false;
    click(
      [...container.querySelectorAll("button")].find(
        b => b.textContent === "再試行"
      )
    );
    await flush();
    expect(fileRows(container)).toHaveLength(5);
  });

  describe("未コミットの変更", () => {
    const status: GitStatus = {
      staged: [change("src/staged.ts", "M", 3, 1)],
      unstaged: [
        change("src/staged.ts", "M", 1, 0),
        change("src/changed.ts", "M", 2, 2),
      ],
      untracked: [change("notes.md", "?", 4, 0)],
    };

    it("「変更」だけを出し、ステージ済み・変更・未追跡に分ける", async () => {
      const { container, commit, fileDiff } = setup({
        selection: { kind: "working" },
        status,
      });
      await flush();
      await flush();
      expect(commit).not.toHaveBeenCalled();
      expect(tabs(container).map(t => t.textContent)).toEqual(["変更 4"]);
      expect(
        [...container.querySelectorAll('[data-testid="git-file-group"]')].map(
          el => el.textContent
        )
      ).toEqual(["ステージ済み1", "変更2", "未追跡1"]);
      // 先頭 (ステージ済み) を自動で選ぶ
      expect(fileDiff).toHaveBeenLastCalledWith(
        { kind: "staged" },
        "src/staged.ts",
        undefined
      );

      // 同じパスでも、グループごとに別の対象で取る
      click(fileRows(container)[1]);
      await flush();
      expect(fileDiff).toHaveBeenLastCalledWith(
        { kind: "unstaged" },
        "src/staged.ts",
        undefined
      );
      expect(
        fileRows(container).map(r => r.getAttribute("aria-selected"))
      ).toEqual(["false", "true", "false", "false"]);

      click(fileRows(container)[3]);
      await flush();
      expect(fileDiff).toHaveBeenLastCalledWith(
        { kind: "untracked" },
        "notes.md",
        undefined
      );
    });

    it("読み直し (refreshKey) のたびに、選んでいるファイルの差分を取り直す", async () => {
      const { fileDiff, rerender, container } = setup({
        selection: { kind: "working" },
        status,
      });
      await flush();
      await flush();
      expect(fileDiff).toHaveBeenCalledTimes(1);
      rerender({ selection: { kind: "working" }, status, refreshKey: 2 });
      await flush();
      expect(fileDiff).toHaveBeenCalledTimes(2);
      // 取り直しのあいだも前の差分を出したまま
      expect(diffView(container)).not.toBeNull();
    });

    it("コミットの差分は、読み直しても取り直さない", async () => {
      const { fileDiff, rerender } = setup();
      await flush();
      await flush();
      expect(fileDiff).toHaveBeenCalledTimes(1);
      rerender({ refreshKey: 2 });
      await flush();
      expect(fileDiff).toHaveBeenCalledTimes(1);
    });

    it("変更が無ければその旨を出す", async () => {
      const { container } = setup({
        selection: { kind: "working" },
        status: { staged: [], unstaged: [], untracked: [] },
      });
      await flush();
      expect(container.textContent).toContain("未コミットの変更はありません");
    });
  });
  it("未追跡のファイルには「バイナリ」と出さない", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const root = createRoot(container);
    const api = {
      fileDiff: vi.fn(async () => ({
        ok: true,
        oldContent: "",
        newContent: "x\n",
        binary: false,
        tooLarge: false,
      })),
      commit: vi.fn(),
    };
    await act(async () => {
      root.render(
        <GitCommitDetail
          api={api as never}
          selection={{ kind: "working" }}
          status={{
            staged: [],
            unstaged: [],
            untracked: [
              { path: "new.txt", status: "?", added: null, removed: null },
            ],
          }}
          refreshKey={0}
          onSelectCommit={() => {}}
        />
      );
    });
    expect(container.textContent).toContain("new.txt");
    expect(container.textContent).not.toContain("バイナリ");
    act(() => root.unmount());
    container.remove();
  });
});
