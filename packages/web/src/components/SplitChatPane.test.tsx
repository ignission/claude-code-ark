// @vitest-environment jsdom

import type { ManagedSession } from "@ark/shared";
import { act, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SplitChatPane } from "./SplitChatPane";

type ChatSocket = NonNullable<ComponentProps<typeof SplitChatPane>["socket"]>;

/** on / off / emitだけを持つsocketの偽物。サーバーからのpushはemitServerで起こす */
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
    emit: vi.fn(),
  };
  const emitServer = (event: string, data: unknown) => {
    act(() => {
      for (const handler of handlers.get(event) ?? []) handler(data);
    });
  };
  return { socket: fake as unknown as ChatSocket, emitServer };
}

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function mount(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mountedRoots.push({ root, container });
  return container;
}

function makeSession(id: string): ManagedSession {
  return {
    id,
    worktreeId: `worktree-${id}`,
    worktreePath: `/worktrees/${id}`,
    status: "active",
    createdAt: new Date("2026-09-17T00:00:00Z"),
    tmuxSessionName: `tmux-${id}`,
    ttydPort: 4100,
    ttydUrl: `/ttyd/${id}/`,
  };
}

function renderChat(
  overrides: Partial<ComponentProps<typeof SplitChatPane>> = {}
) {
  const { socket, emitServer } = createFakeSocket();
  const onSendMessage = vi.fn();
  const onSendKey = vi.fn();
  const container = mount(
    <SplitChatPane
      socket={socket}
      session={makeSession("s1")}
      isActive
      onSendMessage={onSendMessage}
      onSendKey={onSendKey}
      {...overrides}
    />
  );
  return { container, emitServer, onSendMessage, onSendKey };
}

const line = (record: unknown) => JSON.stringify(record);

/** 依頼 → Read (完了) とBash (実行中) の2件のツール呼び出し */
const TOOL_SNAPSHOT = [
  line({
    type: "user",
    uuid: "u1",
    message: { role: "user", content: "テストを直して" },
  }),
  line({
    type: "assistant",
    uuid: "a1",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "Read",
          input: { file_path: "src/app.ts" },
        },
        {
          type: "tool_use",
          id: "t2",
          name: "Bash",
          input: { command: "pnpm test" },
        },
      ],
    },
  }),
  line({
    type: "user",
    uuid: "r1",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
    },
  }),
];

function findButtonByText(scope: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(scope.querySelectorAll("button")).find(b =>
    b.textContent?.includes(text)
  );
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("SplitChatPane: ツール行の折りたたみ", () => {
  it("連続するツール呼び出しを「作業N件」の1行に畳み、実行中の最新の1件だけを下に出す", () => {
    const { container, emitServer } = renderChat();
    emitServer("session:jsonl-snapshot", {
      sessionId: "s1",
      lines: TOOL_SNAPSHOT,
    });

    const summary = findButtonByText(container, "作業2件");
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("pnpm test");
    expect(container.textContent).not.toContain("src/app.ts");
  });

  it("押すと既存のツール行が開き、実行中の行を二重に出さない", () => {
    const { container, emitServer } = renderChat();
    emitServer("session:jsonl-snapshot", {
      sessionId: "s1",
      lines: TOOL_SNAPSHOT,
    });

    const summary = findButtonByText(container, "作業2件");
    act(() => summary.click());

    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("src/app.ts");
    expect(container.textContent?.split("pnpm test")).toHaveLength(2);
  });
});
