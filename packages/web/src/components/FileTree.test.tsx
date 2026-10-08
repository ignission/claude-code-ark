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
  const render = async (extra: Partial<Parameters<typeof FileTree>[0]> = {}) =>
    act(async () => {
      root.render(
        <FileTree
          api={{ list }}
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

  it("ディレクトリを開くと 1 度だけ list(src) を呼ぶ", async () => {
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

  it("ファイルのクリックで onOpenFile に相対パスを渡す", async () => {
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

  it("展開が localStorage から復元される", async () => {
    localStorage.setItem("ark-file-tree-expanded:/wt", JSON.stringify(["src"]));
    const t = setup();
    await t.render();
    expect(t.list).toHaveBeenCalledWith("src");
    expect(rowByName(t.container, "a.ts")).toBeTruthy();
  });

  it("refreshSeq が増えると開いているディレクトリを読み直す", async () => {
    localStorage.setItem("ark-file-tree-expanded:/wt", JSON.stringify(["src"]));
    const t = setup();
    await t.render();
    t.list.mockClear();
    await t.render({ refreshSeq: 1 });
    expect(t.list.mock.calls.map(([d]) => d).sort()).toEqual(["", "src"]);
  });

  it("ok: false のときエラー文を出す", async () => {
    const t = setup(
      {},
      vi.fn(async () => ({ ok: false as const, error: "読めません" }))
    );
    await t.render();
    expect(t.container.textContent).toContain("読めません");
  });

  it("truncated のとき注記を出す", async () => {
    const t = setup(
      {},
      vi.fn(async () => ({ ok: true as const, entries: [], truncated: true }))
    );
    await t.render();
    expect(t.container.textContent).toContain("一部だけ表示しています");
  });
});
