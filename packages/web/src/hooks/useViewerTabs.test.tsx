// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SPLIT_VIEW_LEFT_MODE_CHANGE_EVENT,
  writeSavedSplitViewLeftMode,
} from "../lib/split-view-left-mode";
import { useViewerTabs } from "./useViewerTabs";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const sessions = new Map([["s1", { worktreePath: "/repo" }]]);
const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

/** 再レンダーごとに差し替わるので、毎回最新の戻り値を読む */
function mountHook() {
  const latest: { api: ReturnType<typeof useViewerTabs> | null } = {
    api: null,
  };
  function Probe() {
    latest.api = useViewerTabs("s1", sessions, vi.fn(), null);
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<Probe />));
  mounted.push({ root, container });
  return () => {
    if (!latest.api) throw new Error("hook did not run");
    return latest.api;
  };
}

beforeEach(() => {
  writeSavedSplitViewLeftMode("chat");
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("useViewerTabs のファイルタブ", () => {
  it("ファイルを開くと左ペインをビューア側へ切り替える", () => {
    const api = mountHook();
    const modes: string[] = [];
    const listener = (event: Event) => {
      modes.push((event as CustomEvent<{ mode: string }>).detail.mode);
    };
    window.addEventListener(SPLIT_VIEW_LEFT_MODE_CHANGE_EVENT, listener);

    act(() => {
      api().openFileTab("s1", "packages/web/src/x.ts", 40);
    });

    window.removeEventListener(SPLIT_VIEW_LEFT_MODE_CHANGE_EVENT, listener);
    // 会話モードのままだとタブは増えるのに画面が変わらないので、必ず切り替える
    expect(modes).toContain("terminal");
    expect(window.localStorage.getItem("ark-split-left-mode")).toBe("terminal");

    const tabs = api().getTabsForSession("s1");
    expect(tabs.map(t => t.type)).toEqual(["terminal", "file"]);
    const fileTab = tabs[1];
    expect(fileTab.type === "file" && fileTab.targetLine).toBe(40);
  });
});
