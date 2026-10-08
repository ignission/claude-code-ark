// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileTab, FileTabsState } from "@/lib/file-tabs";
import { FilePane } from "./FilePane";

const createFileApi = vi.hoisted(() =>
  vi.fn((_socket: unknown, sessionId: string) => ({ sessionId }))
);
vi.mock("@/lib/file-api", () => ({ createFileApi }));

// FileEditor の振る舞いは FileEditor.test.tsx で見る。ここでは dirty と保存の合図だけ出す
vi.mock("./FileEditor", () => ({
  FileEditor: (props: {
    tab: FileTab;
    isVisible: boolean;
    onDirtyChange: (tabId: string, dirty: boolean) => void;
    onSaved: () => void;
  }) => (
    <div
      data-testid="file-editor"
      data-path={props.tab.filePath}
      data-visible={String(props.isVisible)}
    >
      <button
        type="button"
        onClick={() => props.onDirtyChange(props.tab.id, true)}
      >
        dirty:{props.tab.id}
      </button>
      <button
        type="button"
        onClick={() => props.onDirtyChange(props.tab.id, false)}
      >
        clean:{props.tab.id}
      </button>
      <button type="button" onClick={props.onSaved}>
        saved:{props.tab.id}
      </button>
    </div>
  ),
}));

vi.mock("./FileTree", () => ({
  FileTree: (props: {
    activeFilePath: string | null;
    refreshSeq: number;
    onOpenFile: (filePath: string) => void;
  }) => (
    <div
      data-testid="file-tree"
      data-active={String(props.activeFilePath)}
      data-refresh-seq={String(props.refreshSeq)}
    >
      <button type="button" onClick={() => props.onOpenFile("src/new.ts")}>
        open-from-tree
      </button>
    </div>
  ),
}));

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

const tab = (id: string, filePath: string): FileTab => ({
  id,
  kind:
    filePath.startsWith("/") && filePath.endsWith(".html") ? "html" : "file",
  filePath,
  revealSeq: 0,
});

const twoTabs: FileTabsState = {
  tabs: [tab("a", "src/a.ts"), tab("b", "docs/b.md")],
  activeId: "a",
};

// 中身は使わない (createFileApi を差し替えている)
const socket = {} as NonNullable<Parameters<typeof FilePane>[0]["socket"]>;

async function setup(props: Partial<Parameters<typeof FilePane>[0]> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onOpenFile = vi.fn();
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const render = (extra: Partial<Parameters<typeof FilePane>[0]> = {}) =>
    act(async () => {
      root.render(
        <FilePane
          socket={socket}
          sessionId="s1"
          worktreePath="/wt"
          state={twoTabs}
          onOpenFile={onOpenFile}
          onSelect={onSelect}
          onClose={onClose}
          isActive
          {...props}
          {...extra}
        />
      );
    });
  mounted.push({ root, container });
  await render();
  return { container, onOpenFile, onSelect, onClose, render, root };
}

const tabs = (c: HTMLElement) => [
  ...c.querySelectorAll<HTMLElement>('[role="tab"]'),
];
const editors = (c: HTMLElement) => [
  ...c.querySelectorAll<HTMLElement>('[data-testid="file-editor"]'),
];
const tree = (c: HTMLElement) =>
  c.querySelector<HTMLElement>('[data-testid="file-tree"]');
const byLabel = (c: HTMLElement, label: string) =>
  [...c.querySelectorAll("button")].find(
    b => b.getAttribute("aria-label") === label || b.textContent === label
  );

async function click(c: HTMLElement, label: string) {
  const el = byLabel(c, label);
  if (!el) throw new Error(`ボタンがありません: ${label}`);
  await act(async () => {
    el.click();
  });
}

/** 非表示のタブは、hidden の付いた祖先を持つ */
const isHidden = (el: HTMLElement) => el.closest(".hidden") !== null;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  createFileApi.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("FilePane", () => {
  it("タブを並べ、全部マウントしたままアクティブだけ見せる", async () => {
    const t = await setup();
    expect(tabs(t.container).map(el => el.textContent)).toEqual([
      "a.ts",
      "b.md",
    ]);
    expect(
      tabs(t.container).map(el => el.getAttribute("aria-selected"))
    ).toEqual(["true", "false"]);
    const [a, b] = editors(t.container);
    expect(a.dataset.visible).toBe("true");
    expect(isHidden(a)).toBe(false);
    expect(b.dataset.visible).toBe("false");
    expect(isHidden(b)).toBe(true);
  });

  it("ペインが見えていない間は、どのタブも見えていないと伝える (マウントは保つ)", async () => {
    const t = await setup({ isActive: false });
    expect(editors(t.container).map(el => el.dataset.visible)).toEqual([
      "false",
      "false",
    ]);
    // タブの選択 (hidden の付け方) は変えない
    expect(editors(t.container).map(isHidden)).toEqual([false, true]);

    await t.render({ isActive: true });
    expect(editors(t.container).map(el => el.dataset.visible)).toEqual([
      "true",
      "false",
    ]);
  });

  it("タブを押すと onSelect、× で onClose を呼ぶ", async () => {
    const t = await setup();
    await click(t.container, "b.md");
    expect(t.onSelect).toHaveBeenCalledWith("b");
    await click(t.container, "b.md を閉じる");
    expect(t.onClose).toHaveBeenCalledWith("b");
    // 閉じるボタンは選択のボタンの中に入れない
    expect(t.container.querySelector("button button")).toBeNull();
  });

  it("タブは選択のボタン自身で、パネルと結び、閉じるボタンを含まない", async () => {
    const t = await setup();
    const [a, b] = tabs(t.container);
    expect([a.tagName, b.tagName]).toEqual(["BUTTON", "BUTTON"]);
    expect([a, b].map(el => el.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
    ]);
    // Tab キーで入れるのはアクティブなタブだけ
    expect([a.tabIndex, b.tabIndex]).toEqual([0, -1]);

    const panels = [
      ...t.container.querySelectorAll<HTMLElement>('[role="tabpanel"]'),
    ];
    expect(panels).toHaveLength(2);
    expect(a.id).not.toBe(b.id);
    expect([a, b].map(el => el.getAttribute("aria-controls"))).toEqual(
      panels.map(p => p.id)
    );
    expect(panels.map(p => p.getAttribute("aria-labelledby"))).toEqual([
      a.id,
      b.id,
    ]);

    // 閉じるボタンはタブの外。tablist の直下は見た目だけの包み
    expect(a.querySelector("button")).toBeNull();
    expect(a.parentElement?.getAttribute("role")).toBe("presentation");
    expect(a.parentElement?.parentElement?.getAttribute("role")).toBe(
      "tablist"
    );
    expect(byLabel(t.container, "a.ts を閉じる")?.parentElement).toBe(
      a.parentElement
    );
  });

  it("socket が無くパネルが無い間は、aria-controls を付けない", async () => {
    const t = await setup({ socket: null });
    expect(tabs(t.container)[0].hasAttribute("aria-controls")).toBe(false);
  });

  it("←/→ と Home/End で隣のタブへ移り、端では回り込む", async () => {
    const t = await setup();
    const press = (el: HTMLElement, key: string) => {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        el.dispatchEvent(event);
      });
      return event;
    };
    const [a, b] = tabs(t.container);
    a.focus();
    expect(press(a, "ArrowRight").defaultPrevented).toBe(true);
    expect(t.onSelect).toHaveBeenLastCalledWith("b");
    expect(document.activeElement).toBe(b);

    press(b, "ArrowRight");
    expect(t.onSelect).toHaveBeenLastCalledWith("a");
    expect(document.activeElement).toBe(a);

    press(a, "ArrowLeft");
    expect(t.onSelect).toHaveBeenLastCalledWith("b");
    press(b, "Home");
    expect(t.onSelect).toHaveBeenLastCalledWith("a");
    press(a, "End");
    expect(t.onSelect).toHaveBeenLastCalledWith("b");

    // ほかのキーは奪わない
    t.onSelect.mockClear();
    expect(press(a, "Tab").defaultPrevented).toBe(false);
    expect(t.onSelect).not.toHaveBeenCalled();
  });

  it("dirty のタブに ● を出し、閉じるときに確認する", async () => {
    const t = await setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await click(t.container, "dirty:a");
    expect(tabs(t.container)[0].textContent).toContain("●");
    expect(tabs(t.container)[1].textContent).not.toContain("●");
    // ● は読み上げず、代わりの文言を持つ
    const mark = [...tabs(t.container)[0].querySelectorAll("span")].find(
      el => el.textContent === "●"
    );
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
    expect(tabs(t.container)[0].querySelector(".sr-only")?.textContent).toBe(
      "未保存"
    );

    await click(t.container, "a.ts を閉じる");
    expect(confirm).toHaveBeenCalledWith(
      "保存していない変更があります。閉じますか？"
    );
    expect(t.onClose).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await click(t.container, "a.ts を閉じる");
    expect(t.onClose).toHaveBeenCalledWith("a");
  });

  it("dirty でないタブは確認なしで閉じる", async () => {
    const t = await setup();
    const confirm = vi.spyOn(window, "confirm");
    await click(t.container, "dirty:a");
    await click(t.container, "clean:a");
    await click(t.container, "a.ts を閉じる");
    expect(confirm).not.toHaveBeenCalled();
    expect(t.onClose).toHaveBeenCalledWith("a");
  });

  it("dirty がある間だけ beforeunload を張る", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const count = (spy: typeof add | typeof remove) =>
      spy.mock.calls.filter(c => c[0] === "beforeunload").length;
    const t = await setup();
    expect(count(add)).toBe(0);

    await click(t.container, "dirty:a");
    await click(t.container, "dirty:b");
    expect(count(add)).toBe(1);
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    await click(t.container, "clean:a");
    expect(count(remove)).toBe(0);
    await click(t.container, "clean:b");
    expect(count(remove)).toBe(1);

    // アンマウントでも外す
    await click(t.container, "dirty:a");
    expect(count(add)).toBe(2);
    act(() => t.root.unmount());
    expect(count(remove)).toBe(2);
  });

  it("閉じられたタブの dirty は残さない", async () => {
    const t = await setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const remove = vi.spyOn(window, "removeEventListener");
    await click(t.container, "dirty:a");
    await click(t.container, "a.ts を閉じる");
    await t.render({ state: { tabs: [twoTabs.tabs[1]], activeId: "b" } });
    expect(remove.mock.calls.filter(c => c[0] === "beforeunload").length).toBe(
      1
    );
  });

  it("タブが 0 枚のときは案内を出す", async () => {
    const t = await setup({ state: { tabs: [], activeId: null } });
    expect(t.container.textContent).toContain(
      "ツリーからファイルを選ぶか、会話やボードのリンクを押すと開きます"
    );
    expect(editors(t.container)).toHaveLength(0);
  });

  it("ツリーへは相対パスのアクティブタブだけを伝え、選ぶと onOpenFile を呼ぶ", async () => {
    const t = await setup();
    expect(tree(t.container)?.dataset.active).toBe("src/a.ts");
    await click(t.container, "open-from-tree");
    expect(t.onOpenFile).toHaveBeenCalledWith("src/new.ts");

    const abs: FileTabsState = {
      tabs: [tab("h", "/tmp/report.html"), tab("x", "/tmp/x.txt")],
      activeId: "h",
    };
    await t.render({ state: abs });
    expect(tree(t.container)?.dataset.active).toBe("null");
    await t.render({ state: { ...abs, activeId: "x" } });
    expect(tree(t.container)?.dataset.active).toBe("null");
  });

  it("保存と読み直しの合図でツリーを読み直させる", async () => {
    const t = await setup();
    expect(tree(t.container)?.dataset.refreshSeq).toBe("0");
    await click(t.container, "saved:a");
    expect(tree(t.container)?.dataset.refreshSeq).toBe("1");
  });

  it("ツリーは折りたため、状態を保存する", async () => {
    const t = await setup();
    expect(isHidden(tree(t.container) as HTMLElement)).toBe(false);
    await click(t.container, "ファイルツリーを折りたたむ");
    expect(isHidden(tree(t.container) as HTMLElement)).toBe(true);
    expect(localStorage.getItem("ark-file-tree-collapsed")).toBe("1");
    await click(t.container, "ファイルツリーを開く");
    expect(isHidden(tree(t.container) as HTMLElement)).toBe(false);
    expect(localStorage.getItem("ark-file-tree-collapsed")).toBe("0");
  });

  it("折りたたみの状態を復元する", async () => {
    localStorage.setItem("ark-file-tree-collapsed", "1");
    const t = await setup();
    expect(isHidden(tree(t.container) as HTMLElement)).toBe(true);
  });

  it("socket が無い間は何も読まない", async () => {
    const t = await setup({ socket: null });
    expect(createFileApi).not.toHaveBeenCalled();
    expect(tree(t.container)).toBeNull();
    expect(editors(t.container)).toHaveLength(0);
    // タブは見せておく
    expect(tabs(t.container)).toHaveLength(2);
  });

  it("api は socket と sessionId が変わらない限り作り直さない", async () => {
    const t = await setup();
    await t.render({ state: { ...twoTabs, activeId: "b" } });
    expect(createFileApi).toHaveBeenCalledTimes(1);
    await t.render({ sessionId: "s2" });
    expect(createFileApi).toHaveBeenCalledTimes(2);
  });
});
