// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useViewerTabs } from "./useViewerTabs";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const sessions = new Map([["s1", { worktreePath: "/repo" }]]);
const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

/** 再レンダーごとに差し替わるので、毎回最新の戻り値を読む */
function mountHook(
  onOpenFile?: (
    sessionId: string,
    filePath: string,
    line?: number | null,
    endLine?: number | null,
    source?: "board"
  ) => void,
  readFile: (sessionId: string, filePath: string) => void = vi.fn()
) {
  const latest: { api: ReturnType<typeof useViewerTabs> | null } = {
    api: null,
  };
  function Probe() {
    latest.api = useViewerTabs(
      "s1",
      sessions,
      readFile,
      null,
      undefined,
      true,
      onOpenFile
    );
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
  window.localStorage.clear();
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("useViewerTabs のファイルタブ", () => {
  it("ファイルを開くと、端末のタブ列へファイルのタブを足す (PCの左ペインの表示は保存しない)", () => {
    const api = mountHook();

    act(() => {
      api().openFileTab("s1", "packages/web/src/x.ts", 40, 58);
    });

    expect(window.localStorage.getItem("ark-split-left-mode")).toBeNull();

    const tabs = api().getTabsForSession("s1");
    expect(tabs.map(t => t.type)).toEqual(["terminal", "file"]);
    const fileTab = tabs[1];
    expect(fileTab.type === "file" && fileTab.targetLine).toBe(40);
    // 範囲で指定されたときは終了行も持つ (ハイライトを 1 行で切らない)
    expect(fileTab.type === "file" && fileTab.targetEndLine).toBe(58);
  });
});

describe("useViewerTabs のタブの同一性", () => {
  it("タブを開いていないセッションには、呼ぶたびに同じ配列を返す (受け取る側のメモ化を壊さない)", () => {
    const api = mountHook();

    const first = api().getTabsForSession("s9");
    const second = api().getTabsForSession("s9");

    expect(first.map(t => t.type)).toEqual(["terminal"]);
    expect(second).toBe(first);
  });
});

describe("useViewerTabs の onOpenFile", () => {
  function postOpenFile(data: Record<string, unknown>) {
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "ark:open-file", ...data },
          origin: window.location.origin,
        })
      );
    });
  }

  it("渡されていれば委譲し、タブも readFile も触らない", () => {
    const onOpenFile = vi.fn();
    const readFile = vi.fn();
    const api = mountHook(onOpenFile, readFile);
    postOpenFile({ path: "src/a.ts", line: 3, endLine: 5 });
    expect(onOpenFile).toHaveBeenCalledWith("s1", "src/a.ts", 3, 5, undefined);
    expect(readFile).not.toHaveBeenCalled();
    expect(api().getTabsForSession("s1")).toHaveLength(1);
  });

  it("図のリンクから開いた印 (source) をそのまま渡す。知らない値は落とす", () => {
    const onOpenFile = vi.fn();
    mountHook(onOpenFile);
    postOpenFile({ path: "src/a.ts", line: 3, endLine: 5, source: "board" });
    expect(onOpenFile).toHaveBeenLastCalledWith(
      "s1",
      "src/a.ts",
      3,
      5,
      "board"
    );
    postOpenFile({ path: "src/b.ts", source: "terminal" });
    expect(onOpenFile).toHaveBeenLastCalledWith(
      "s1",
      "src/b.ts",
      undefined,
      undefined,
      undefined
    );
  });

  it("渡されていなければ従来どおりタブを足して readFile を呼ぶ", () => {
    const readFile = vi.fn();
    const api = mountHook(undefined, readFile);
    postOpenFile({ path: "src/a.ts" });
    expect(readFile).toHaveBeenCalledWith("s1", "src/a.ts");
    expect(api().getTabsForSession("s1")).toHaveLength(2);
  });
});
