// @vitest-environment jsdom

import type { FileListResponse } from "@ark/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileTree } from "./FileTree";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

const listing: Record<string, FileListResponse> = {
  "": {
    ok: true,
    truncated: false,
    entries: [
      { name: "src", type: "dir" },
      { name: "README.md", type: "file", gitStatus: "M" },
    ],
  },
  src: {
    ok: true,
    truncated: false,
    entries: [{ name: "a.ts", type: "file" }],
  },
};

function setup(
  props: Partial<Parameters<typeof FileTree>[0]> = {},
  list = vi.fn(async (dir: string) => listing[dir])
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onOpenFile = vi.fn();
  // apiの同一性が変わると読み直すので、描画をまたいで同じobjectを渡す
  const api = { list };
  const render = async (extra: Partial<Parameters<typeof FileTree>[0]> = {}) =>
    act(async () => {
      root.render(
        <FileTree
          api={api}
          worktreePath="/wt"
          activeFilePath={null}
          onOpenFile={onOpenFile}
          refreshSeq={0}
          {...props}
          {...extra}
        />
      );
    });
  mounted.push({ root, container });
  return { container, list, onOpenFile, render };
}

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
};

const key = (el: Element, k: string) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });

const rows = (c: HTMLElement) => [
  ...c.querySelectorAll<HTMLElement>('[role="treeitem"]'),
];
const rowByName = (c: HTMLElement, name: string) =>
  rows(c).find(r => r.textContent?.includes(name));

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("FileTree", () => {
  it("ルートを描き、ディレクトリを先に並べる", async () => {
    const t = setup();
    await t.render();
    expect(t.list).toHaveBeenCalledWith("");
    expect(rows(t.container).map(r => r.textContent)).toEqual([
      "src",
      "README.mdM",
    ]);
  });

  it("ディレクトリを開くと1度だけlist(src) を呼ぶ", async () => {
    const t = setup();
    await t.render();
    const src = rowByName(t.container, "src") as HTMLElement;
    await act(async () => src.click());
    expect(t.list).toHaveBeenCalledWith("src");
    expect(src.getAttribute("aria-expanded")).toBe("true");
    await act(async () => src.click()); // 閉じる
    await act(async () => src.click()); // 再び開く
    expect(t.list.mock.calls.filter(([d]) => d === "src")).toHaveLength(1);
  });

  it("ファイルのクリックでonOpenFileに相対パスを渡す", async () => {
    const t = setup();
    await t.render();
    await act(async () =>
      (rowByName(t.container, "src") as HTMLElement).click()
    );
    await act(async () =>
      (rowByName(t.container, "a.ts") as HTMLElement).click()
    );
    expect(t.onOpenFile).toHaveBeenCalledWith("src/a.ts");
  });

  it("展開がlocalStorageから復元される", async () => {
    localStorage.setItem("ark-file-tree-expanded:/wt", JSON.stringify(["src"]));
    const t = setup();
    await t.render();
    expect(t.list).toHaveBeenCalledWith("src");
    expect(rowByName(t.container, "a.ts")).toBeTruthy();
  });

  it("refreshSeqが増えると開いているディレクトリを読み直す", async () => {
    localStorage.setItem("ark-file-tree-expanded:/wt", JSON.stringify(["src"]));
    const t = setup();
    await t.render();
    t.list.mockClear();
    await t.render({ refreshSeq: 1 });
    expect(t.list.mock.calls.map(([d]) => d).sort()).toEqual(["", "src"]);
  });

  it("ok: falseのときエラー文を出す", async () => {
    const t = setup(
      {},
      vi.fn(async () => ({ ok: false as const, error: "読めません" }))
    );
    await t.render();
    expect(t.container.textContent).toContain("読めません");
  });

  it("truncatedのとき注記を出す", async () => {
    const t = setup(
      {},
      vi.fn(async () => ({ ok: true as const, entries: [], truncated: true }))
    );
    await t.render();
    expect(t.container.textContent).toContain("一部だけ表示しています");
  });

  it("worktreeが変わる前のlistの応答は、変わった後に反映されない", async () => {
    const old = deferred<FileListResponse>();
    const list = vi.fn((dir: string) =>
      list.mock.calls.length === 1 ? old.promise : Promise.resolve(listing[dir])
    );
    const t = setup({}, list);
    await t.render();
    await t.render({ worktreePath: "/wt2" });
    expect(rows(t.container).map(r => r.textContent)).toEqual([
      "src",
      "README.mdM",
    ]);
    await act(async () =>
      old.resolve({
        ok: true,
        truncated: false,
        entries: [{ name: "stale.ts", type: "file" }],
      })
    );
    expect(rowByName(t.container, "stale.ts")).toBeUndefined();
  });

  it("apiが変わると、ルートと展開中のディレクトリを読み直す", async () => {
    localStorage.setItem("ark-file-tree-expanded:/wt", JSON.stringify(["src"]));
    const t = setup();
    await t.render();
    t.list.mockClear();
    const list2 = vi.fn(async (dir: string) => listing[dir]);
    await t.render({ api: { list: list2 } });
    expect(list2.mock.calls.map(([d]) => d).sort()).toEqual(["", "src"]);
    expect(t.list).not.toHaveBeenCalled();
  });

  it("同じディレクトリの遅い古い応答は、新しい応答を上書きしない", async () => {
    const first = deferred<FileListResponse>();
    const list = vi.fn((_dir: string) =>
      list.mock.calls.length === 1
        ? first.promise
        : Promise.resolve<FileListResponse>({
            ok: true,
            truncated: false,
            entries: [{ name: "new.ts", type: "file" }],
          })
    );
    const t = setup({}, list);
    await t.render();
    await t.render({ refreshSeq: 1 });
    expect(rowByName(t.container, "new.ts")).toBeTruthy();
    await act(async () =>
      first.resolve({
        ok: true,
        truncated: false,
        entries: [{ name: "old.ts", type: "file" }],
      })
    );
    expect(rowByName(t.container, "old.ts")).toBeUndefined();
    expect(rowByName(t.container, "new.ts")).toBeTruthy();
  });

  it("worktreeを変えても旧展開状態を新しいキーへ保存しない", async () => {
    localStorage.setItem("ark-file-tree-expanded:/wt", JSON.stringify(["src"]));
    const t = setup();
    await t.render();
    await t.render({ worktreePath: "/wt2" });
    expect(localStorage.getItem("ark-file-tree-expanded:/wt2")).toBe("[]");
    expect(localStorage.getItem("ark-file-tree-expanded:/wt")).toBe('["src"]');
  });

  it("ディレクトリの失敗表示はそのディレクトリの子の位置に出て、開き直すと再試行する", async () => {
    let fail = true;
    const list = vi.fn(async (dir: string) =>
      dir === "src" && fail
        ? { ok: false as const, error: "src を読めません" }
        : listing[dir]
    );
    const t = setup({}, list);
    await t.render();
    const src = rowByName(t.container, "src") as HTMLElement;
    await act(async () => src.click());
    const tree = t.container.querySelector('[role="tree"]') as HTMLElement;
    const order = [...tree.children].map(c => c.textContent);
    expect(order).toEqual(["src", "src を読めません", "README.mdM"]);
    fail = false;
    await act(async () => src.click()); // 閉じる
    await act(async () => src.click()); // 再び開く
    expect(t.list.mock.calls.filter(([d]) => d === "src")).toHaveLength(2);
    expect(rowByName(t.container, "a.ts")).toBeTruthy();
  });

  it("タブ停止は1行だけで、↑↓ でフォーカスが動きEnterでファイルを開く", async () => {
    const t = setup();
    await t.render();
    await act(async () =>
      (rowByName(t.container, "src") as HTMLElement).click()
    );
    expect(rows(t.container).map(r => r.tabIndex)).toEqual([0, -1, -1]);
    const [src, a, readme] = rows(t.container);
    src.focus();
    await key(src, "ArrowDown");
    expect(document.activeElement).toBe(a);
    expect(rows(t.container).map(r => r.tabIndex)).toEqual([-1, 0, -1]);
    await key(a, "ArrowDown");
    expect(document.activeElement).toBe(readme);
    await key(readme, "ArrowUp");
    expect(document.activeElement).toBe(a);
    await key(a, "Enter");
    expect(t.onOpenFile).toHaveBeenCalledWith("src/a.ts");
  });

  it("ディレクトリでEnterは開閉し、→ で開き ← で閉じる", async () => {
    const t = setup();
    await t.render();
    const src = rowByName(t.container, "src") as HTMLElement;
    await key(src, "Enter");
    expect(src.getAttribute("aria-expanded")).toBe("true");
    await key(src, "Enter");
    expect(src.getAttribute("aria-expanded")).toBe("false");
    await key(src, "ArrowRight");
    expect(src.getAttribute("aria-expanded")).toBe("true");
    await key(src, "ArrowLeft");
    expect(src.getAttribute("aria-expanded")).toBe("false");
    expect(t.onOpenFile).not.toHaveBeenCalled();
  });

  it("activeFilePathに一致する行がaria-selectedになる", async () => {
    localStorage.setItem("ark-file-tree-expanded:/wt", JSON.stringify(["src"]));
    const t = setup({ activeFilePath: "src/a.ts" });
    await t.render();
    const selected = rows(t.container).filter(
      r => r.getAttribute("aria-selected") === "true"
    );
    expect(selected.map(r => r.dataset.path)).toEqual(["src/a.ts"]);
  });
});
