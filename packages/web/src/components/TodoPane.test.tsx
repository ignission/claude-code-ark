// @vitest-environment jsdom

import type { Todo } from "@ark/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TodoPane } from "./TodoPane";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const base = (over: Partial<Todo>): Todo => ({
  id: "1",
  worktreePath: "/w/a",
  text: "ログの形式",
  note: null,
  createdAt: 0,
  doneAt: null,
  ...over,
});

describe("TodoPane", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const mount = (over: Partial<Parameters<typeof TodoPane>[0]> = {}) => {
    const props = {
      todos: [] as Todo[],
      worktreePath: "/w/a",
      error: null,
      onSetDone: vi.fn(),
      onRemove: vi.fn(),
      worktreeLabel: (p: string) => (p === "/w/a" ? "a" : null),
      ...over,
    };
    act(() => root.render(<TodoPane {...props} />));
    return props;
  };

  const byText = (selector: string, text: string) =>
    [...container.querySelectorAll<HTMLElement>(selector)].find(el =>
      el.textContent?.includes(text)
    );
  const click = (el: Element | null | undefined) => {
    if (!el) throw new Error("要素が見つからない");
    act(() => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  it("このセッションの未完了を出し、完了は折りたたみに入れる", () => {
    mount({
      todos: [
        base({ id: "1" }),
        base({ id: "2", text: "済んだ", doneAt: 1 }),
        base({ id: "3", worktreePath: "/w/b", text: "別" }),
      ],
    });
    expect(container.textContent).toContain("ログの形式");
    expect(container.textContent).not.toContain("別");
    expect(container.textContent).not.toContain("済んだ");
    expect(container.textContent).toContain("完了 (1)");
  });

  it("チェックで onSetDone(id, true)、完了済みのチェックで onSetDone(id, false)", () => {
    const props = mount({
      todos: [base({ id: "1" }), base({ id: "2", text: "済んだ", doneAt: 1 })],
    });
    click(container.querySelector('[aria-label="完了にする"]'));
    expect(props.onSetDone).toHaveBeenCalledWith("1", true);

    click(byText("button", "完了 (1)"));
    click(container.querySelector('[aria-label="未完了に戻す"]'));
    expect(props.onSetDone).toHaveBeenCalledWith("2", false);
  });

  it("× で onRemove(id)", () => {
    const props = mount({ todos: [base({ id: "1" })] });
    click(container.querySelector('[aria-label="TODO を消す"]'));
    expect(props.onRemove).toHaveBeenCalledWith("1");
  });

  it("「すべて」に替えると全 worktree の未完了を worktree ごとに出す", () => {
    mount({
      todos: [
        base({ id: "1" }),
        base({ id: "3", worktreePath: "/w/b", text: "別" }),
      ],
    });
    click(byText("button", "すべて"));
    expect(container.querySelector("h3")?.textContent).toBe("a");
    expect(container.textContent).toContain("削除済み worktree");
    expect(container.textContent).toContain("別");
  });

  it("「すべて」の見出しで onOpenWorktree を呼ぶ", () => {
    const onOpenWorktree = vi.fn();
    mount({ todos: [base({ id: "1" })], onOpenWorktree });
    click(byText("button", "すべて"));
    click(container.querySelector("h3 button"));
    expect(onOpenWorktree).toHaveBeenCalledWith("/w/a");
  });

  it("未完了が無ければ空の案内を出す", () => {
    mount({ todos: [base({ id: "2", doneAt: 1 })] });
    expect(container.textContent).toContain("保留にした話題はありません");
  });

  it("error を出す", () => {
    mount({ error: "保存に失敗した" });
    expect(container.textContent).toContain("保存に失敗した");
  });
});
