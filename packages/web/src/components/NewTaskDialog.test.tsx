// @vitest-environment jsdom

import type { TaskStartResponse } from "@ark/shared";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewTaskDialog, type NewTaskInitial } from "./NewTaskDialog";

// Radix の Dialog は Portal と pointer イベントが絡むので素通しにする
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children?: ReactNode }) => (
    <p>{children}</p>
  ),
  useDialogComposition: () => ({
    isComposing: () => false,
    setComposing: () => {},
    justEndedComposing: () => false,
    markCompositionEnd: () => {},
  }),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function setup(response: TaskStartResponse) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const onStartTask = vi.fn(async () => response);
  const onOpenChange = vi.fn();
  const onStarted = vi.fn();
  const render = (initial: NewTaskInitial) =>
    act(() =>
      root?.render(
        <NewTaskDialog
          open
          onOpenChange={onOpenChange}
          repoList={["/r/app", "/r/lib"]}
          initial={initial}
          onStartTask={onStartTask}
          onStarted={onStarted}
        />
      )
    );
  const field = (id: string) =>
    document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
  const type = (id: string, value: string) => {
    const el = field(id);
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    act(() => {
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const submitButton = () =>
    [...document.querySelectorAll("button")].find(
      b => b.textContent === "起動する"
    ) as HTMLButtonElement;
  const submit = async () => {
    await act(async () => {
      submitButton().click();
    });
  };
  return {
    render,
    field,
    type,
    submit,
    submitButton,
    onStartTask,
    onOpenChange,
    onStarted,
  };
}

const ok: TaskStartResponse = {
  ok: true,
  sessionId: "s1",
  worktreePath: "/r/app-fix",
  branch: "fix",
};

describe("NewTaskDialog", () => {
  it("名前とプロンプトが無いうちは起動できない", () => {
    const { render, type, submitButton } = setup(ok);
    render({ repoPath: "/r/app" });
    expect(submitButton().disabled).toBe(true);
    type("new-task-name", "fix");
    expect(submitButton().disabled).toBe(true);
    type("new-task-prompt", "直して");
    expect(submitButton().disabled).toBe(false);
  });

  it("起動すると task:start の要求を送り、閉じて onStarted を呼ぶ", async () => {
    const { render, type, submit, onStartTask, onOpenChange, onStarted } =
      setup(ok);
    render({ repoPath: "/r/app" });
    type("new-task-name", " fix ");
    type("new-task-prompt", "直して");
    await submit();
    // ベースを空にしておけば送らない (サーバーが既定のブランチを使う)
    expect(onStartTask).toHaveBeenCalledWith({
      repoPath: "/r/app",
      name: "fix",
      prompt: "直して",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onStarted).toHaveBeenCalledWith(ok);
  });

  it("分岐TODOから開いたときは初期値を入れ、親と todoId を添えて送る", async () => {
    const { render, field, submit, onStartTask } = setup(ok);
    render({
      repoPath: "/r/app",
      name: "fix-log",
      prompt: "ログの形式",
      baseBranch: "feat",
      parentWorktreePath: "/r/app-feat",
      todoId: "t1",
    });
    expect(field("new-task-name").value).toBe("fix-log");
    expect(field("new-task-prompt").value).toBe("ログの形式");
    expect(field("new-task-base").value).toBe("feat");
    await submit();
    expect(onStartTask).toHaveBeenCalledWith({
      repoPath: "/r/app",
      name: "fix-log",
      prompt: "ログの形式",
      baseBranch: "feat",
      parentWorktreePath: "/r/app-feat",
      todoId: "t1",
    });
  });

  it("見出しのボタンから開いたとき (親なし) はリポジトリを選ばせ、先頭を既定にする", async () => {
    const { render, field, type, submit, onStartTask } = setup(ok);
    render({ repoPath: null });
    const select = document.getElementById(
      "new-task-repo"
    ) as HTMLSelectElement;
    expect(select.value).toBe("/r/app");
    act(() => {
      select.value = "/r/lib";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    type("new-task-name", "fix");
    type("new-task-prompt", "直して");
    expect(field("new-task-base").value).toBe("");
    await submit();
    expect(onStartTask).toHaveBeenCalledWith({
      repoPath: "/r/lib",
      name: "fix",
      prompt: "直して",
    });
  });

  it("親があるときはリポジトリを選ばせない", () => {
    const { render } = setup(ok);
    render({ repoPath: "/r/app", parentWorktreePath: "/r/app-feat" });
    expect(document.getElementById("new-task-repo")).toBeNull();
  });

  it("失敗したら閉じずに理由を出す", async () => {
    const { render, type, submit, onOpenChange, onStarted } = setup({
      ok: false,
      error: "ブランチ 'fix' は既に別の worktree で使用中です",
    });
    render({ repoPath: "/r/app" });
    type("new-task-name", "fix");
    type("new-task-prompt", "直して");
    await submit();
    expect(document.querySelector("[role=alert]")?.textContent).toContain(
      "使用中"
    );
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
  });
});
