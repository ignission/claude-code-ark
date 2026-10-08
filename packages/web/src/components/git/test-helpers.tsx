import type { GitCommit, GitRef } from "@ark/shared";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

/** Git タブのコンポーネントテストで共有する道具 */

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

export function mount(element: ReactElement): {
  container: HTMLDivElement;
  rerender: (next: ReactElement) => void;
} {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mounted.push({ root, container });
  return { container, rerender: next => act(() => root.render(next)) };
}

export function unmountAll(): void {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
}

export function makeCommit(
  sha: string,
  overrides: Partial<GitCommit> = {}
): GitCommit {
  return {
    sha,
    parents: [],
    subject: `subject ${sha}`,
    authorName: "Alice Example",
    authorEmail: "alice@example.com",
    authorTime: 1_780_000_000,
    refs: [],
    ...overrides,
  };
}

/** 一直線の履歴 (新しい順)。sha は 7 桁の 16 進 */
export function linearCommits(count: number): GitCommit[] {
  const sha = (i: number) => i.toString(16).padStart(7, "0");
  return Array.from({ length: count }, (_, i) =>
    makeCommit(sha(count - i), {
      parents: i < count - 1 ? [sha(count - i - 1)] : [],
    })
  );
}

export const ref = (kind: GitRef["kind"], name: string): GitRef => ({
  kind,
  name,
});

export const click = (el: Element | null | undefined) => {
  if (!el) throw new Error("クリックする要素がありません");
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

export const press = (el: Element | null | undefined, key: string) => {
  if (!el) throw new Error("キーを送る要素がありません");
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    );
  });
};

/** React が管理する input の値を変える (value の setter を経由しないと onChange が出ない) */
export const typeInto = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

/** 溜まっている Promise を流しきる */
export const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
