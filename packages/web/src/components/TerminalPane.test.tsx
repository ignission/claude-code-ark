// @vitest-environment jsdom

import type { ManagedSession } from "@ark/shared";
import { act, type ComponentProps, createRef, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";

const toastDoubles = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: toastDoubles }));

vi.mock("../hooks/useMobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("../hooks/useTerminalLinkInjection", () => ({
  useTerminalLinkInjection: () => undefined,
}));

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function makeSession(): ManagedSession {
  return {
    id: "terminal-handle",
    worktreeId: "worktree-terminal-handle",
    worktreePath: "/worktrees/terminal-handle",
    status: "active",
    createdAt: new Date("2026-09-17T00:00:00Z"),
    tmuxSessionName: "tmux-terminal-handle",
    ttydPort: 4100,
    ttydUrl: "/ttyd/terminal-handle/",
  };
}

function mountTerminal(
  overrides: Partial<ComponentProps<typeof TerminalPane>> = {}
): {
  ref: RefObject<TerminalPaneHandle | null>;
  container: HTMLDivElement;
} {
  const ref = createRef<TerminalPaneHandle>();
  const session = makeSession();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <TerminalPane
        ref={ref}
        session={session}
        worktree={undefined}
        tabs={[{ type: "terminal", id: `terminal-${session.id}` }]}
        activeTabIndex={0}
        onTabSelect={vi.fn()}
        onTabClose={vi.fn()}
        onSendMessage={vi.fn()}
        onSendKey={vi.fn()}
        onUploadFile={vi.fn(async () => ({
          path: "/uploads/a.txt",
          filename: "a.txt",
        }))}
        {...overrides}
      />
    )
  );
  mountedRoots.push({ root, container });
  return { ref, container };
}

function handleOf(
  ref: RefObject<TerminalPaneHandle | null>
): TerminalPaneHandle {
  expect(ref.current).not.toBeNull();
  return ref.current as TerminalPaneHandle;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  toastDoubles.success.mockClear();
  toastDoubles.info.mockClear();
  toastDoubles.error.mockClear();
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  Reflect.deleteProperty(navigator, "clipboard");
  vi.restoreAllMocks();
});

describe("TerminalPane (PC上部バーから呼ぶ操作)", () => {
  it("自前のヘッダーを持たない", () => {
    const { container } = mountTerminal();

    expect(container.querySelector("header")).toBeNull();
    expect(container.querySelector('[title="セッションを削除"]')).toBeNull();
  });

  it("ttydのiframeを暗い額縁の中に置く", () => {
    const { container } = mountTerminal();

    const frame = container.querySelector<HTMLElement>(
      '[data-testid="terminal-frame"]'
    );
    expect(frame).not.toBeNull();
    // TERMINAL_BG (#1c1a17)。jsdomはrgbに正規化することがある
    expect(frame?.style.backgroundColor).toMatch(
      /^(#1c1a17|rgb\(28, 26, 23\))$/
    );
    expect(frame?.querySelector("iframe")).not.toBeNull();
  });

  it("openFilePickerはTerminalPaneに残したfile inputを開く", () => {
    const clickSpy = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => undefined);
    const { ref, container } = mountTerminal();
    expect(container.querySelector('input[type="file"]')).not.toBeNull();

    act(() => handleOf(ref).openFilePicker());

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("toggleInputBarで入力バーを出し入れし、表示の変化を知らせる", () => {
    const onInputBarVisibleChange = vi.fn();
    const { ref, container } = mountTerminal({ onInputBarVisibleChange });
    expect(container.querySelector("textarea")).toBeNull();
    expect(onInputBarVisibleChange).toHaveBeenLastCalledWith(false);

    act(() => handleOf(ref).toggleInputBar());

    expect(container.querySelector("textarea")).not.toBeNull();
    expect(onInputBarVisibleChange).toHaveBeenLastCalledWith(true);
  });

  it("reloadでttydのiframeを作り直す", () => {
    const { ref, container } = mountTerminal();
    const before = container.querySelector("iframe");
    expect(before).not.toBeNull();

    act(() => handleOf(ref).reload());

    const after = container.querySelector("iframe");
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it("copyBufferはバッファをクリップボードへ書き、トーストで知らせる", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const onCopyBuffer = vi.fn(async () => "tmux buffer");
    const { ref } = mountTerminal({ onCopyBuffer });

    act(() => handleOf(ref).copyBuffer());

    await vi.waitFor(() => {
      expect(toastDoubles.success).toHaveBeenCalledWith(
        "端末のバッファをコピーしました"
      );
    });
    expect(writeText).toHaveBeenCalledWith("tmux buffer");
  });
});
