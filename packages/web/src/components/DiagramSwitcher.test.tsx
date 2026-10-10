// @vitest-environment jsdom

import type { DiagramListItem } from "@ark/shared";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DiagramSwitcher,
  describeDeleteTracking,
  getDiagramDeleteWarning,
  handleDiagramDeleteConfirmation,
} from "./DiagramSwitcher";

// Radix の AlertDialog は Portal と pointer イベントが絡むので素通しにする
vi.mock("./ui/alert-dialog", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    AlertDialog: ({
      open,
      children,
    }: {
      open: boolean;
      children?: ReactNode;
    }) => (open ? <div role="alertdialog">{children}</div> : null),
    AlertDialogContent: Pass,
    AlertDialogHeader: Pass,
    AlertDialogFooter: Pass,
    AlertDialogTitle: ({ children }: { children?: ReactNode }) => (
      <h2>{children}</h2>
    ),
    AlertDialogDescription: Pass,
    AlertDialogCancel: ({ children }: { children?: ReactNode }) => (
      <button type="button">{children}</button>
    ),
    AlertDialogAction: ({
      children,
      onClick,
    }: {
      children?: ReactNode;
      onClick?: (event: React.MouseEvent) => void;
    }) => (
      <button type="button" data-testid="confirm-delete" onClick={onClick}>
        {children}
      </button>
    ),
  };
});

const DAY = 24 * 60 * 60 * 1000;
const diagrams: DiagramListItem[] = [
  {
    relPath: ".claude/diagrams/a.diagram.html",
    displayName: "注文フロー",
    tracked: true,
    kind: "sequence",
    mtimeMs: Date.now() - 3 * DAY,
  },
  {
    relPath: ".claude/diagrams/nested/b.diagram.html",
    displayName: "b.diagram.html",
    tracked: false,
    kind: "doc",
    mtimeMs: Date.now() - 400 * DAY,
  },
  {
    relPath: ".claude/diagrams/c.diagram.html",
    displayName: "コマンドパレット",
    tracked: false,
    kind: "deck",
    mtimeMs: Date.now() - 1000,
  },
];

let container: HTMLDivElement;
let root: Root;

type Props = Parameters<typeof DiagramSwitcher>[0];
function render(overrides: Partial<Props> = {}) {
  const props: Props = {
    diagrams,
    currentRelPath: diagrams[0].relPath,
    onSelect: vi.fn(),
    onDelete: vi.fn(async () => true),
    ...overrides,
  };
  act(() => root.render(<DiagramSwitcher {...props} />));
  return props;
}
const bar = () => document.querySelector<HTMLElement>("[data-diagram-toolbar]");
const back = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label="図の一覧"]');
const forward = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label="図へ進む"]');
const browser = () => document.querySelector("[data-diagram-browser]");
const listbox = () => document.querySelector<HTMLElement>('[role="listbox"]');
const search = () =>
  document.querySelector<HTMLInputElement>('input[aria-label="図を探す"]');
const rowNames = () =>
  [...document.querySelectorAll('[role="option"]')].map(
    row => row.querySelector("span > span")?.textContent
  );
const selected = () =>
  document
    .querySelector('[role="option"][aria-selected="true"]')
    ?.querySelector("span > span")?.textContent;
const openList = () => act(() => back()?.click());
function key(
  target: Element | null,
  name: string,
  init: KeyboardEventInit = {}
) {
  act(() => {
    target?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: name,
        bubbles: true,
        cancelable: true,
        ...init,
      })
    );
  });
}
function type(text: string) {
  const input = search();
  if (!input) throw new Error("no search");
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("DiagramSwitcher", () => {
  it("図の画面では、バーにいまの図の名前を出し、「戻る」で一覧へ行ける", () => {
    render();
    expect(bar()?.textContent).toContain("注文フロー");
    expect(browser()).toBeNull();
    expect(back()?.disabled).toBe(false);
    expect(forward()?.disabled).toBe(true);
  });

  it("一覧の画面では、バーに件数を出し、「進む」で開いていた図へ戻れる", () => {
    render();
    openList();
    expect(bar()?.textContent).toContain("図3件");
    expect(bar()?.textContent).not.toContain("注文フロー");
    expect(back()?.disabled).toBe(true);
    expect(forward()?.disabled).toBe(false);
    act(() => forward()?.click());
    expect(browser()).toBeNull();
  });

  it("図を選んでいないときは、一覧を開いた状態から始める", () => {
    render({ currentRelPath: undefined });
    expect(browser()).not.toBeNull();
    expect(document.activeElement).toBe(search());
    // 進む先の図が無い
    expect(forward()?.disabled).toBe(true);
  });

  it("図が開いたら一覧を閉じ、図が無くなったら開く (復元や board_open で図が替わる)", () => {
    const props = render({ currentRelPath: undefined });
    expect(browser()).not.toBeNull();
    render({ ...props, currentRelPath: diagrams[0].relPath });
    expect(browser()).toBeNull();
    openList();
    render({ ...props, currentRelPath: diagrams[2].relPath });
    expect(browser()).toBeNull();
    render({ ...props, currentRelPath: undefined });
    expect(browser()).not.toBeNull();
  });

  it("図が無ければ、その旨を出す", () => {
    render({ diagrams: [], currentRelPath: undefined });
    expect(bar()?.textContent).toContain("0件");
    expect(browser()?.textContent).toContain("図がありません");
  });

  it("一覧に無い図を開いているときは、ファイル名を出す", () => {
    render({ currentRelPath: ".claude/diagrams/stale.diagram.html" });
    expect(bar()?.textContent).toContain("stale.diagram.html");
  });

  it("開くと、更新の新しい順に名前・種類・更新日時を並べる", () => {
    render();
    openList();
    expect(rowNames()).toEqual([
      "コマンドパレット",
      "注文フロー",
      "b.diagram.html",
    ]);
    const first = document.querySelector('[role="option"]')?.textContent ?? "";
    expect(first).toContain("デッキ");
    expect(first).toMatch(/今日 \d\d:\d\d/);
    // いまの図の行を選んだ状態で開く
    expect(selected()).toBe("注文フロー");
    expect(
      document.querySelector('[role="option"][aria-current="true"]')
        ?.textContent
    ).toContain("注文フロー");
  });

  it("名前と違うときだけ、パスを横に出す", () => {
    render();
    openList();
    const texts = [...document.querySelectorAll('[role="option"]')].map(
      row => row.textContent ?? ""
    );
    expect(texts[1]).toContain("a.diagram.html");
    expect(texts[2].match(/b\.diagram\.html/g)).toHaveLength(1);
  });

  it("絞り込みの欄で名前とパスを絞り込める", () => {
    render();
    openList();
    type("nested");
    expect(rowNames()).toEqual(["b.diagram.html"]);
    type("無い語");
    expect(browser()?.textContent).toContain("一致する図がありません");
  });

  it("見出しで並べ替え、選んだ並びを覚える", () => {
    render();
    openList();
    act(() =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="名前で並べ替え"]')
        ?.click()
    );
    expect(rowNames()[0]).toBe("b.diagram.html");
    act(() => root.unmount());
    root = createRoot(container);
    render();
    openList();
    expect(rowNames()[0]).toBe("b.diagram.html");
  });

  it("矢印で選び、Enter で開いて閉じる (絞り込みの欄からも一覧からも)", () => {
    const props = render();
    openList();
    key(search(), "ArrowUp");
    expect(selected()).toBe("コマンドパレット");
    key(search(), "Enter");
    expect(props.onSelect).toHaveBeenCalledWith(diagrams[2].relPath);
    expect(browser()).toBeNull();

    openList();
    key(listbox(), "End");
    expect(selected()).toBe("b.diagram.html");
    key(listbox(), "Home");
    expect(selected()).toBe("コマンドパレット");
    key(listbox(), "PageDown");
    expect(selected()).toBe("b.diagram.html");
    key(listbox(), "Enter");
    expect(props.onSelect).toHaveBeenLastCalledWith(diagrams[1].relPath);
  });

  it("変換の確定の Enter では開かない", () => {
    const props = render();
    openList();
    key(search(), "Enter", { isComposing: true });
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(browser()).not.toBeNull();
  });

  it("行を押すと開く。Esc でも図の画面へ戻る", () => {
    const props = render();
    openList();
    act(() =>
      document.querySelectorAll<HTMLElement>('[role="option"]')[0].click()
    );
    expect(props.onSelect).toHaveBeenCalledWith(diagrams[2].relPath);
    expect(browser()).toBeNull();
    openList();
    key(listbox(), "Escape");
    expect(browser()).toBeNull();
  });

  it("図を選んでいないときは、Esc で閉じない (見せるものが無い)", () => {
    render({ currentRelPath: undefined });
    key(search(), "Escape");
    expect(browser()).not.toBeNull();
  });

  it("行の削除ボタンは確認を挟み、その行の図だけを消す", async () => {
    const props = render();
    openList();
    const del = document.querySelector<HTMLButtonElement>(
      'button[aria-label="「コマンドパレット」を削除"]'
    );
    act(() => del?.click());
    // 行を開く操作にはしない
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(
      document.querySelector('[role="alertdialog"]')?.textContent
    ).toContain("「コマンドパレット」を削除しますか？");
    expect(props.onDelete).not.toHaveBeenCalled();
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="confirm-delete"]')
        ?.click();
    });
    expect(props.onDelete).toHaveBeenCalledWith(diagrams[2].relPath, false);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("確認を開いている間に一覧が読み直されたら、新しい内容で確認し直す", async () => {
    const onDelete = vi.fn(async () => false);
    const props = render({ onDelete });
    openList();
    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="「コマンドパレット」を削除"]'
        )
        ?.click()
    );
    const confirm = () =>
      document.querySelector<HTMLButtonElement>(
        '[data-testid="confirm-delete"]'
      );
    await act(async () => confirm()?.click());
    expect(onDelete).toHaveBeenLastCalledWith(diagrams[2].relPath, false);
    // 断られて一覧が読み直され、その図が Git 管理になっていた
    render({
      ...props,
      diagrams: diagrams.map(item =>
        item === diagrams[2] ? { ...item, tracked: true } : item
      ),
    });
    expect(
      document.querySelector('[role="alertdialog"]')?.textContent
    ).toContain("Git管理");
    await act(async () => confirm()?.click());
    expect(onDelete).toHaveBeenLastCalledWith(diagrams[2].relPath, true);
    // 一覧から消えたら、確認も閉じる
    render({ ...props, diagrams: diagrams.slice(0, 2) });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("削除ボタンにフォーカスがあるときの Enter は、行を開かずボタンに任せる", () => {
    const props = render();
    openList();
    const del = document.querySelector<HTMLButtonElement>(
      'button[aria-label="「コマンドパレット」を削除"]'
    );
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      del?.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(browser()).not.toBeNull();
  });

  it("削除の結果の知らせを、一覧の中にも出す (一覧がバーの下を覆うため)", () => {
    render({ notice: "コメントのファイルを消せませんでした" });
    openList();
    expect(browser()?.querySelector('[role="status"]')?.textContent).toBe(
      "コメントのファイルを消せませんでした"
    );
  });

  describe("まとめて選んで消す", () => {
    const box = (name: string) =>
      document.querySelector<HTMLInputElement>(
        `input[aria-label="「${name}」を選択"]`
      );
    const allBox = () =>
      document.querySelector<HTMLInputElement>(
        'input[aria-label="見えている図をすべて選択"]'
      );
    const selectionBar = () =>
      document.querySelector("[data-diagram-selection]");
    const bulkDelete = () =>
      [...(selectionBar()?.querySelectorAll("button") ?? [])].find(button =>
        button.textContent?.includes("選んだ図を削除")
      );
    const confirm = () =>
      document.querySelector<HTMLButtonElement>(
        '[data-testid="confirm-delete"]'
      );
    const dialog = () => document.querySelector('[role="alertdialog"]');

    it("行のチェックで選び、選んだ数を出す。行は開かない", () => {
      const props = render();
      openList();
      expect(selectionBar()).toBeNull();
      act(() => box("コマンドパレット")?.click());
      act(() => box("b.diagram.html")?.click());
      expect(selectionBar()?.textContent).toContain("2件を選択中");
      expect(props.onSelect).not.toHaveBeenCalled();
      expect(allBox()?.indeterminate).toBe(true);
      act(() =>
        [...(selectionBar()?.querySelectorAll("button") ?? [])]
          .find(button => button.textContent === "選択を解除")
          ?.click()
      );
      expect(selectionBar()).toBeNull();
    });

    it("見出しのチェックは、見えている行だけをすべて選ぶ / 外す", () => {
      render();
      openList();
      type("diagram.html nested");
      act(() => allBox()?.click());
      expect(selectionBar()?.textContent).toContain("1件を選択中");
      type("");
      expect(allBox()?.checked).toBe(false);
      act(() => allBox()?.click());
      expect(selectionBar()?.textContent).toContain("3件を選択中");
      expect(allBox()?.checked).toBe(true);
      act(() => allBox()?.click());
      expect(selectionBar()).toBeNull();
    });

    it("Shift を押しながら選ぶと、前に選んだ行までをまとめて選ぶ", () => {
      render();
      openList();
      act(() => box("コマンドパレット")?.click());
      act(() => {
        box("b.diagram.html")?.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            shiftKey: true,
          })
        );
      });
      expect(selectionBar()?.textContent).toContain("3件を選択中");
    });

    it("一覧のキーでも選べる (Space / Ctrl+A / Delete)", () => {
      render();
      openList();
      key(listbox(), "Home");
      key(listbox(), " ");
      expect(box("コマンドパレット")?.checked).toBe(true);
      key(listbox(), "a", { ctrlKey: true });
      expect(selectionBar()?.textContent).toContain("3件を選択中");
      key(listbox(), "Delete");
      expect(dialog()?.textContent).toContain("3件の図を削除しますか？");
    });

    it("確認に名前と内訳を出し、1 件ずつ順に消す", async () => {
      const order: string[] = [];
      const onDelete = vi.fn(async (relPath: string) => {
        order.push(relPath);
        return true;
      });
      render({ onDelete });
      openList();
      act(() => allBox()?.click());
      act(() => bulkDelete()?.click());
      const text = dialog()?.textContent ?? "";
      expect(text).toContain("3件の図を削除しますか？");
      expect(text).toContain("コマンドパレット");
      expect(text).toContain("Git管理 1件 / 未追跡 2件");
      // Git 管理の図が混ざっていれば、差分が残ることも伝える
      expect(text).toContain("worktree に削除差分が残ります");
      expect(confirm()?.textContent).toBe("3件を削除する");
      expect(onDelete).not.toHaveBeenCalled();
      await act(async () => confirm()?.click());
      expect(order).toEqual(diagrams.map(item => item.relPath));
      expect(onDelete).toHaveBeenCalledWith(diagrams[0].relPath, true);
      expect(dialog()).toBeNull();
      expect(selectionBar()).toBeNull();
    });

    it("消せなかった図は選んだまま残し、件数を知らせる", async () => {
      const onDelete = vi.fn(
        async (relPath: string) => relPath !== diagrams[0].relPath
      );
      render({ onDelete });
      openList();
      act(() => allBox()?.click());
      act(() => bulkDelete()?.click());
      await act(async () => confirm()?.click());
      expect(dialog()).toBeNull();
      expect(browser()?.querySelector('[role="status"]')?.textContent).toBe(
        "3件のうち1件を削除できませんでした"
      );
      expect(selectionBar()?.textContent).toContain("1件を選択中");
      expect(box("注文フロー")?.checked).toBe(true);
    });

    it("一覧から消えた図は、選んだ数に数えない", () => {
      const props = render();
      openList();
      act(() => allBox()?.click());
      render({ ...props, diagrams: diagrams.slice(0, 1) });
      expect(selectionBar()?.textContent).toContain("1件を選択中");
    });

    it("内訳の言葉", () => {
      expect(describeDeleteTracking(diagrams.slice(1))).toBe("未追跡 2件");
      expect(describeDeleteTracking(diagrams.slice(0, 1))).toBe("Git管理 1件");
    });
  });

  it("未接続・更新中・削除中は、削除ボタンを押せない", () => {
    for (const props of [
      { isConnected: false },
      { listLoading: true },
      { isDeleting: true },
      { onDelete: undefined },
    ]) {
      render(props);
      if (!browser()) openList();
      const buttons = [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[role="option"] button'
        ),
      ];
      expect(buttons.length).toBe(3);
      expect(buttons.every(button => button.disabled)).toBe(true);
    }
  });

  it("一覧の失敗と再試行をバーに出す", () => {
    const onRetry = vi.fn();
    render({ listError: "取得に失敗しました", onRetry });
    expect(container.textContent).toContain("取得に失敗しました");
    act(() =>
      [...document.querySelectorAll("button")]
        .find(button => button.textContent === "再試行")
        ?.click()
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("tracked/untracked ごとの取り消せない警告を返す", () => {
    const tracked = getDiagramDeleteWarning(diagrams[0]);
    const untracked = getDiagramDeleteWarning(diagrams[1]);

    expect(tracked).toContain("コメント sidecar も削除");
    expect(tracked).toContain("worktree に削除差分が残ります");
    expect(tracked).toContain("Git で復元");
    expect(tracked).toContain("Git 未追跡のファイルは復元できません");
    expect(untracked).toContain("コメント sidecar も削除");
    expect(untracked).toContain("Git 未追跡のファイルは復元できません");
    expect(untracked).toContain("取り消せません");
  });

  it("cancel は callback 無し、confirm は 1件だけを渡して成否を返す", async () => {
    const onDelete = vi.fn(async () => false);

    await expect(
      handleDiagramDeleteConfirmation(false, diagrams[0], onDelete)
    ).resolves.toBe(false);
    expect(onDelete).not.toHaveBeenCalled();
    await expect(
      handleDiagramDeleteConfirmation(true, diagrams[1], onDelete)
    ).resolves.toBe(false);
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledWith(diagrams[1].relPath, false);
  });
});
