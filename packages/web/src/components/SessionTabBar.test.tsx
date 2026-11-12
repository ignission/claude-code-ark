// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionTabBar, type SessionTabItem } from "./SessionTabBar";

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
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

const TABS: SessionTabItem[] = [
  { sessionId: "s1", label: "api-fix", statusKey: "IDLE" },
  { sessionId: "s2", label: "board", statusKey: "THINK" },
];

describe("SessionTabBar", () => {
  it("開いたセッションをタブで並べ、選んでいるものに印を付ける", () => {
    const container = mount(
      <SessionTabBar
        tabs={TABS}
        activeSessionId="s2"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    expect(tabs.map(tab => tab.textContent)).toEqual([
      expect.stringContaining("api-fix"),
      expect.stringContaining("board"),
    ]);
    expect(tabs.map(tab => tab.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
    ]);
    // タブと、それが見せる画面を結ぶ
    expect(tabs.map(tab => tab.id)).toEqual([
      "session-tab-s1",
      "session-tab-s2",
    ]);
    expect(tabs.map(tab => tab.getAttribute("aria-controls"))).toEqual([
      "session-panel-s1",
      "session-panel-s2",
    ]);
  });

  it("タブを押すと選び、×を押すと閉じる (選ぶ方は呼ばない)", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const container = mount(
      <SessionTabBar
        tabs={TABS}
        activeSessionId="s1"
        onSelect={onSelect}
        onClose={onClose}
      />
    );
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    act(() => tabs[1].click());
    expect(onSelect).toHaveBeenCalledWith("s2");

    onSelect.mockClear();
    const close = container.querySelector<HTMLButtonElement>(
      'button[aria-label="boardのタブを閉じる"]'
    );
    act(() => close?.click());
    expect(onClose).toHaveBeenCalledWith("s2");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("中クリックで閉じる", () => {
    const onClose = vi.fn();
    const container = mount(
      <SessionTabBar
        tabs={TABS}
        activeSessionId="s1"
        onSelect={vi.fn()}
        onClose={onClose}
      />
    );
    const tab = container.querySelector('[data-session-id="s1"]');
    act(() => {
      tab?.dispatchEvent(
        new MouseEvent("auxclick", { bubbles: true, button: 1 })
      );
    });
    expect(onClose).toHaveBeenCalledWith("s1");
  });

  it("最後の1つは閉じさせない", () => {
    const onClose = vi.fn();
    const container = mount(
      <SessionTabBar
        tabs={[TABS[0]]}
        activeSessionId="s1"
        onSelect={vi.fn()}
        onClose={onClose}
      />
    );
    expect(container.querySelector('button[aria-label*="閉じる"]')).toBeNull();
    const tab = container.querySelector('[data-session-id="s1"]');
    act(() => {
      tab?.dispatchEvent(
        new MouseEvent("auxclick", { bubbles: true, button: 1 })
      );
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("同じラベルが並んだときだけ、リポジトリ名を添える", () => {
    const container = mount(
      <SessionTabBar
        tabs={[
          {
            sessionId: "s1",
            label: "main",
            repoName: "api",
            statusKey: "IDLE",
          },
          {
            sessionId: "s2",
            label: "main",
            repoName: "web",
            statusKey: "IDLE",
          },
          {
            sessionId: "s3",
            label: "docs",
            repoName: "web",
            statusKey: "IDLE",
          },
        ]}
        activeSessionId="s1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const texts = [...container.querySelectorAll('[role="tab"]')].map(
      tab => tab.textContent ?? ""
    );
    expect(texts[0]).toContain("api");
    expect(texts[1]).toContain("web");
    expect(texts[2]).not.toContain("web");
  });

  it("タブが無ければ何も出さない", () => {
    const container = mount(
      <SessionTabBar
        tabs={[]}
        activeSessionId={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(container.innerHTML).toBe("");
  });
});
