// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileTabsStorageKey } from "../lib/file-tabs";
import { useFileTabs } from "./useFileTabs";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Sessions = Map<string, { worktreePath: string }>;
const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

function mountHook(initial: Sessions) {
  const latest: { api: ReturnType<typeof useFileTabs> | null } = {
    api: null,
  };
  let current = initial;
  function Probe({ sessions }: { sessions: Sessions }) {
    latest.api = useFileTabs(sessions);
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<Probe sessions={current} />));
  mounted.push({ root, container });
  return {
    api: () => {
      if (!latest.api) throw new Error("hook did not run");
      return latest.api;
    },
    setSessions: (next: Sessions) => {
      current = next;
      act(() => root.render(<Probe sessions={current} />));
    },
  };
}

const one = () => new Map([["s1", { worktreePath: "/repo" }]]);

beforeEach(() => localStorage.clear());
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  localStorage.clear();
});

describe("useFileTabs", () => {
  it("開く・選ぶ・閉じるが効き、getOpenSeq は openFile でだけ増える", () => {
    const h = mountHook(one());
    expect(h.api().getFileTabs("s1").tabs).toEqual([]);
    expect(h.api().getOpenSeq("s1")).toBe(0);

    act(() => h.api().openFile("s1", "a.ts", 3, 5));
    act(() => h.api().openFile("s1", "b.ts"));
    expect(
      h
        .api()
        .getFileTabs("s1")
        .tabs.map(t => t.filePath)
    ).toEqual(["a.ts", "b.ts"]);
    expect(h.api().getOpenSeq("s1")).toBe(2);

    const [a, b] = h.api().getFileTabs("s1").tabs;
    act(() => h.api().selectFile("s1", a.id));
    expect(h.api().getFileTabs("s1").activeId).toBe(a.id);
    act(() => h.api().closeFile("s1", b.id));
    expect(h.api().getFileTabs("s1").tabs).toHaveLength(1);
    expect(h.api().getOpenSeq("s1")).toBe(2);
  });

  it("状態が変わるたびに worktree のキーへ保存する", () => {
    const h = mountHook(one());
    act(() => h.api().openFile("s1", "a.ts", 7));
    const raw = localStorage.getItem(fileTabsStorageKey("/repo"));
    expect(raw).toContain("a.ts");
  });

  it("初めて認識したセッションで 1 度だけ復元し、openSeq は増えない", () => {
    const seed = mountHook(one());
    act(() => seed.api().openFile("s1", "a.ts", 7));

    const h = mountHook(one());
    expect(
      h
        .api()
        .getFileTabs("s1")
        .tabs.map(t => t.filePath)
    ).toEqual(["a.ts"]);
    expect(h.api().getFileTabs("s1").activeId).not.toBeNull();
    expect(h.api().getOpenSeq("s1")).toBe(0);

    // 復元後に localStorage を書き換えても、再レンダーで再復元しない
    localStorage.setItem(fileTabsStorageKey("/repo"), "{}");
    h.setSessions(one());
    expect(h.api().getFileTabs("s1").tabs).toHaveLength(1);
  });

  it("後から現れたセッションも復元する", () => {
    localStorage.setItem(
      fileTabsStorageKey("/other"),
      JSON.stringify({
        tabs: [{ kind: "file", filePath: "z.ts" }],
        activeFilePath: "z.ts",
      })
    );
    const h = mountHook(one());
    h.setSessions(
      new Map([
        ["s1", { worktreePath: "/repo" }],
        ["s2", { worktreePath: "/other" }],
      ])
    );
    expect(h.api().getFileTabs("s2").tabs[0].filePath).toBe("z.ts");
  });

  it("localStorage が例外を投げても落ちない", () => {
    const orig = Storage.prototype.getItem;
    const origSet = Storage.prototype.setItem;
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    Storage.prototype.setItem = () => {
      throw new Error("blocked");
    };
    try {
      const h = mountHook(one());
      act(() => h.api().openFile("s1", "a.ts"));
      expect(h.api().getFileTabs("s1").tabs).toHaveLength(1);
      expect(h.api().getFileTabs("s1").activeId).not.toBeNull();
    } finally {
      Storage.prototype.getItem = orig;
      Storage.prototype.setItem = origSet;
    }
  });

  it("復元前に開かれたタブとは統合し、保存済みタブを失わない", () => {
    localStorage.setItem(
      fileTabsStorageKey("/repo"),
      JSON.stringify({
        tabs: [{ kind: "file", filePath: "saved.ts" }],
        activeFilePath: "saved.ts",
      })
    );
    const h = mountHook(new Map());
    act(() => {
      h.api().openFile("s1", "live.ts");
      h.setSessions(one());
    });
    const state = h.api().getFileTabs("s1");
    expect(state.tabs.map(t => t.filePath)).toEqual(["saved.ts", "live.ts"]);
    expect(state.activeId).toBe(state.tabs[1].id);
    const raw = localStorage.getItem(fileTabsStorageKey("/repo")) ?? "";
    expect(raw).toContain("saved.ts");
    expect(raw).toContain("live.ts");
  });

  it("セッションが現れる前の状態は保存済み扱いにせず、現れたら書く", () => {
    const h = mountHook(new Map());
    act(() => h.api().openFile("s1", "a.ts"));
    expect(localStorage.getItem(fileTabsStorageKey("/repo"))).toBeNull();
    h.setSessions(one());
    expect(localStorage.getItem(fileTabsStorageKey("/repo"))).toContain("a.ts");
  });
});
