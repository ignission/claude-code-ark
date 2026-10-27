// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateWorktreeDialog } from "./CreateWorktreeDialog";

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

function setup() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const onCreateWorktree = vi.fn();
  const render = (open: boolean, initial: { b?: string; base?: string }) =>
    act(() =>
      root?.render(
        <CreateWorktreeDialog
          open={open}
          onOpenChange={() => {}}
          selectedRepoPath="/repo"
          onCreateWorktree={onCreateWorktree}
          initialBranchName={initial.b}
          initialBaseBranch={initial.base}
        />
      )
    );
  const input = (id: string) =>
    document.getElementById(id) as HTMLInputElement | null;
  const type = (id: string, value: string) => {
    const el = input(id) as HTMLInputElement;
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    act(() => {
      set?.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  return { render, input, type, onCreateWorktree };
}

describe("CreateWorktreeDialog: 初期値", () => {
  it("開いたとき、渡された初期値が入力欄に入る", () => {
    const { render, input } = setup();
    render(true, { b: "todo-abcdef", base: "feat/x" });
    expect(input("branch")?.value).toBe("todo-abcdef");
    expect(input("baseBranch")?.value).toBe("feat/x");
  });

  it("初期値を渡さなければ空", () => {
    const { render, input } = setup();
    render(true, {});
    expect(input("branch")?.value).toBe("");
    expect(input("baseBranch")?.value).toBe("");
  });

  it("閉じて開き直すたびに、そのときの初期値で入れ直す (直した値は残さない)", () => {
    const { render, input, type } = setup();
    render(true, { b: "todo-aaaaaa", base: "main" });
    type("branch", "手で直した");
    render(false, { b: "todo-aaaaaa", base: "main" });
    render(true, { b: "todo-bbbbbb", base: "dev" });
    expect(input("branch")?.value).toBe("todo-bbbbbb");
    expect(input("baseBranch")?.value).toBe("dev");
  });

  it("開いている間に初期値のpropsが変わっても、入力中の値は消さない", () => {
    const { render, input, type } = setup();
    render(true, { b: "todo-aaaaaa" });
    type("branch", "手で直した");
    render(true, { b: "todo-bbbbbb" });
    expect(input("branch")?.value).toBe("手で直した");
  });
});
