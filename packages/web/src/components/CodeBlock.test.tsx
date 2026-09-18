// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeBlock } from "./CodeBlock";

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function mount(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mountedRoots.push({ root, container });
  return container;
}

function mountBlock(code: string): HTMLDivElement {
  return mount(
    <CodeBlock code={code}>
      <code>{code}</code>
    </CodeBlock>
  );
}

function copyButton(scope: ParentNode): HTMLButtonElement {
  const button = scope.querySelector<HTMLButtonElement>(
    'button[aria-label="コードをコピー"]'
  );
  if (!button) throw new Error("コピーボタンが無い");
  return button;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
  });
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  // navigator.clipboard を差し替えるので、他のテストへ漏らさない
  Reflect.deleteProperty(navigator, "clipboard");
  vi.useRealTimers();
});

function stubClipboard(writeText: unknown): void {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

describe("CodeBlock", () => {
  it("押すと渡された生のコードをクリップボードへ書く", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const container = mountBlock("pnpm test\n  echo done");

    await click(copyButton(container));

    expect(writeText).toHaveBeenCalledWith("pnpm test\n  echo done");
  });

  it("成功するとチェック表示になり、一定時間で元に戻る", async () => {
    vi.useFakeTimers();
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    const container = mountBlock("pnpm test");

    await click(copyButton(container));

    expect(container.querySelector(".lucide-check")).not.toBeNull();
    expect(container.querySelector(".lucide-copy")).toBeNull();
    expect(container.textContent).toContain("コピーしました");

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(container.querySelector(".lucide-check")).toBeNull();
    expect(container.querySelector(".lucide-copy")).not.toBeNull();
    expect(container.textContent).not.toContain("コピーしました");
  });

  it("navigator.clipboard が無い環境では失敗を画面に出す", async () => {
    Reflect.deleteProperty(navigator, "clipboard");
    const container = mountBlock("pnpm test");

    await click(copyButton(container));

    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toBe("コピーできませんでした");
    expect(status?.className).not.toContain("sr-only");
  });

  it("writeText が拒否されたら失敗を画面に出す", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    const container = mountBlock("pnpm test");

    await click(copyButton(container));

    expect(container.textContent).toContain("コピーできませんでした");
  });
});
