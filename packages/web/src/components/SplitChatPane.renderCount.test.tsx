// @vitest-environment jsdom

/**
 * 画面末尾 (liveTail) は1秒ごとに差し替わる。そのたびに描画し直すのは帯だけで、
 * 会話の列 (markdownの描画を含む) は描画し直さないことを確かめる。
 * 会話の列が描画されたかは、列の中だけで使う react-markdown の描画回数で数える
 */

import type { ManagedSession } from "@ark/shared";
import { act, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SplitChatPane } from "./SplitChatPane";

const testDoubles = vi.hoisted(() => ({
  markdownRender: vi.fn(),
}));

vi.mock("react-markdown", () => ({
  default: ({ children }: { children?: string }) => {
    testDoubles.markdownRender(children);
    return <div data-testid="markdown">{children}</div>;
  },
}));

type ChatProps = ComponentProps<typeof SplitChatPane>;
type ChatSocket = NonNullable<ChatProps["socket"]>;

function createFakeSocket() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const fake = {
    on(event: string, handler: (data: unknown) => void) {
      const set = handlers.get(event) ?? new Set<(data: unknown) => void>();
      set.add(handler);
      handlers.set(event, set);
      return fake;
    },
    off(event: string, handler: (data: unknown) => void) {
      handlers.get(event)?.delete(handler);
      return fake;
    },
    emit: vi.fn(() => fake),
  };
  const emitServer = (event: string, data: unknown) => {
    act(() => {
      for (const handler of handlers.get(event) ?? []) handler(data);
    });
  };
  return { socket: fake as unknown as ChatSocket, emitServer };
}

const session: ManagedSession = {
  id: "s1",
  worktreeId: "worktree-s1",
  worktreePath: "/worktrees/s1",
  status: "active",
  createdAt: new Date("2026-09-17T00:00:00Z"),
  tmuxSessionName: "tmux-s1",
  ttydPort: 4100,
  ttydUrl: "/ttyd/s1/",
};

const SNAPSHOT = [
  JSON.stringify({
    type: "user",
    uuid: "u1",
    message: { role: "user", content: "テストを直して" },
  }),
  JSON.stringify({
    type: "assistant",
    uuid: "a1",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "**直しました**" }],
    },
  }),
];

let mounted: { root: Root; container: HTMLDivElement } | null = null;

function mountChat(layout: "pane" | "mobile") {
  const { socket, emitServer } = createFakeSocket();
  const onOpenTerminal = vi.fn();
  // 親 (Dashboard / MobileLayout) と同じく、描画のたびに新しい関数と要素を渡す
  const element = (liveTail: string | undefined): ReactElement => (
    <SplitChatPane
      socket={socket}
      session={session}
      isActive
      layout={layout}
      liveTail={liveTail}
      onOpenTerminal={onOpenTerminal}
      onSendMessage={() => undefined}
      onSendKey={() => undefined}
      composerAccessory={layout === "mobile" ? <div>上段</div> : undefined}
    />
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element("$ pnpm test")));
  mounted = { root, container };
  emitServer("session:jsonl-snapshot", { sessionId: "s1", lines: SNAPSHOT });
  return {
    container,
    rerender: (liveTail: string | undefined) =>
      act(() => root.render(element(liveTail))),
  };
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  testDoubles.markdownRender.mockClear();
});

afterEach(() => {
  if (mounted) {
    const { root, container } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
});

describe("SplitChatPane: 画面末尾の更新と再描画", () => {
  const tail = (container: HTMLElement) =>
    container.querySelector('[data-testid="chat-live-tail"]');

  it.each(["pane", "mobile"] as const)(
    "liveTail が変わると帯だけを描画し直し、会話の列は描画し直さない: layout=%s",
    layout => {
      const { container, rerender } = mountChat(layout);
      expect(
        container.querySelector('[data-testid="markdown"]')
      ).not.toBeNull();
      expect(tail(container)?.textContent).toBe("$ pnpm test");
      const rendersBefore = testDoubles.markdownRender.mock.calls.length;
      expect(rendersBefore).toBeGreaterThan(0);

      rerender("$ pnpm test\nPASS");
      rerender("$ pnpm test\nPASS\n❯");

      expect(tail(container)?.textContent).toBe("$ pnpm test\nPASS\n❯");
      expect(testDoubles.markdownRender.mock.calls.length).toBe(rendersBefore);
    }
  );

  it("帯の高さが変わる (画面末尾が届かなくなる) ときも、会話の列は描画し直さない", () => {
    const { container, rerender } = mountChat("pane");
    const rendersBefore = testDoubles.markdownRender.mock.calls.length;

    rerender(undefined);

    expect(tail(container)).toBeNull();
    expect(testDoubles.markdownRender.mock.calls.length).toBe(rendersBefore);
  });
});
