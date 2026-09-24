// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileSessionList } from "./MobileSessionList";

const testDoubles = vi.hoisted(() => ({
  sectionList: vi.fn(),
}));

vi.mock("./SessionSectionList", () => ({
  SessionSectionList: (props: Record<string, unknown>) => {
    testDoubles.sectionList(props);
    return <div data-testid="section-list" />;
  },
}));

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function mount(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mountedRoots.push({ root, container });
  return container;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  testDoubles.sectionList.mockClear();
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("MobileSessionList", () => {
  it("見出し「Ark」と新規作成を出し、一覧をPCと同じ並べ方のカードで描く", () => {
    const onNewSession = vi.fn();
    const sessionStatuses = new Map([["session-1", "IDLE" as const]]);
    const sessionPreviews = new Map([["session-1", "テストを実行しています"]]);
    const worktreeDisplayNames = new Map([["/repo/worktree", "ログイン画面"]]);
    const container = mount(
      <MobileSessionList
        sessions={new Map()}
        worktrees={[]}
        repoList={["/repo"]}
        sessionStatuses={sessionStatuses}
        sessionPreviews={sessionPreviews}
        worktreeDisplayNames={worktreeDisplayNames}
        onOpenSession={vi.fn()}
        onStartSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onDeleteWorktree={vi.fn()}
        onNewSession={onNewSession}
      />
    );

    expect(container.querySelector("h1")?.textContent).toBe("Ark");
    const newButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="新規セッション"]'
    );
    act(() => newButton?.click());
    expect(onNewSession).toHaveBeenCalledTimes(1);

    const listProps = testDoubles.sectionList.mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    expect(listProps).toMatchObject({
      variant: "card",
      selectedSessionId: null,
      repoList: ["/repo"],
    });
    expect(listProps.sessionStatuses).toBe(sessionStatuses);
    expect(listProps.sessionPreviews).toBe(sessionPreviews);
    expect(listProps.worktreeDisplayNames).toBe(worktreeDisplayNames);
    expect(listProps).not.toHaveProperty("onSelectRepoGrid");
    expect(listProps).not.toHaveProperty("onNewSession");
  });

  it("画面の管理は、画面が未登録でも見出しから開ける", () => {
    const onOpenScreenManager = vi.fn();
    const container = mount(
      <MobileSessionList
        sessions={new Map()}
        worktrees={[]}
        repoList={[]}
        sessionStatuses={new Map()}
        sessionPreviews={new Map()}
        worktreeDisplayNames={new Map()}
        onOpenSession={vi.fn()}
        onStartSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onDeleteWorktree={vi.fn()}
        onNewSession={vi.fn()}
        onOpenScreenManager={onOpenScreenManager}
      />
    );
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="画面の管理"]'
    );
    act(() => button?.click());
    expect(onOpenScreenManager).toHaveBeenCalledTimes(1);

    const listProps = testDoubles.sectionList.mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    expect(listProps).not.toHaveProperty("onOpenScreenManager");
  });
});
