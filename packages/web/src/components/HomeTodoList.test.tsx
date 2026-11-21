// @vitest-environment jsdom

import type { Todo } from "@ark/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { m } from "@/lib/i18n";
import { HomeTodoList } from "./HomeTodoList";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const todo = (id: string, text: string, repoPath: string | null): Todo => ({
  id,
  worktreePath: "/note",
  text,
  note: null,
  createdAt: 0,
  doneAt: null,
  startedWorktreePath: null,
  startedAt: null,
  branchName: null,
  repoPath,
});

describe("HomeTodoList", () => {
  it("1 件も無ければ何も出さない", () => {
    act(() =>
      root.render(
        <HomeTodoList variant="sidebar" todos={[]} onStart={vi.fn()} />
      )
    );
    expect(container.innerHTML).toBe("");
  });

  it("見出しと件数、本文、行き先のリポジトリ名を出し、押すとその TODO を始める", () => {
    const onStart = vi.fn();
    const todos = [
      todo("a", "見積もりを出す", "/dev/acme/app"),
      todo("b", "メモを直す", null),
    ];
    act(() =>
      root.render(
        <HomeTodoList variant="card" todos={todos} onStart={onStart} />
      )
    );
    const heading = container.querySelector("h2");
    expect(heading?.textContent).toContain(m.session.home.notStarted);
    expect(heading?.textContent).toContain("2");
    const buttons = container.querySelectorAll("button");
    expect(buttons[0].textContent).toContain("見積もりを出す");
    expect(buttons[0].textContent).toContain("app");
    expect(buttons[1].textContent).toBe("メモを直す");
    act(() => buttons[0].click());
    expect(onStart).toHaveBeenCalledWith(todos[0]);
  });
});
