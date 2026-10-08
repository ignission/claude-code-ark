import { describe, expect, it } from "vitest";
import {
  closeFileTab,
  deserializeFileTabs,
  EMPTY_FILE_TABS,
  fileTabKind,
  fileTabsStorageKey,
  openFileInTabs,
  selectFileTab,
  serializeFileTabs,
} from "./file-tabs";

describe("fileTabKind", () => {
  it("絶対パスの .html / .htm だけ html", () => {
    expect(fileTabKind("/a/b.html")).toBe("html");
    expect(fileTabKind("/a/b.HTM")).toBe("html");
    expect(fileTabKind("a/b.html")).toBe("file");
    expect(fileTabKind("/a/b.ts")).toBe("file");
  });
});

describe("openFileInTabs", () => {
  it("新規は末尾に足してアクティブにする", () => {
    const s1 = openFileInTabs(EMPTY_FILE_TABS, "a.ts", "t1", 3, 5);
    const s2 = openFileInTabs(s1, "b.ts", "t2");
    expect(s2.tabs.map(t => t.id)).toEqual(["t1", "t2"]);
    expect(s2.activeId).toBe("t2");
    expect(s1.tabs[0]).toMatchObject({
      kind: "file",
      filePath: "a.ts",
      targetLine: 3,
      targetEndLine: 5,
      revealSeq: 0,
    });
  });

  it("既存は行を更新し revealSeq を進めて再アクティブ化する", () => {
    let s = openFileInTabs(EMPTY_FILE_TABS, "a.ts", "t1", 3);
    s = openFileInTabs(s, "b.ts", "t2");
    s = openFileInTabs(s, "a.ts", "t3", 9, 12);
    expect(s.tabs).toHaveLength(2);
    expect(s.activeId).toBe("t1");
    expect(s.tabs[0]).toMatchObject({
      id: "t1",
      targetLine: 9,
      targetEndLine: 12,
      revealSeq: 1,
    });
  });

  it("html は kind html になる", () => {
    const s = openFileInTabs(EMPTY_FILE_TABS, "/x/y.html", "t1");
    expect(s.tabs[0].kind).toBe("html");
  });
});

describe("closeFileTab", () => {
  const three = () => {
    let s = openFileInTabs(EMPTY_FILE_TABS, "a", "a");
    s = openFileInTabs(s, "b", "b");
    return openFileInTabs(s, "c", "c");
  };

  it("アクティブを閉じたら右隣", () => {
    const s = closeFileTab(selectFileTab(three(), "b"), "b");
    expect(s.activeId).toBe("c");
  });

  it("右隣が無ければ左隣", () => {
    const s = closeFileTab(three(), "c");
    expect(s.activeId).toBe("b");
  });

  it("アクティブ以外を閉じてもアクティブは変わらない", () => {
    const s = closeFileTab(three(), "a");
    expect(s.activeId).toBe("c");
    expect(s.tabs.map(t => t.id)).toEqual(["b", "c"]);
  });

  it("最後の 1 枚を閉じると activeId は null", () => {
    const s = closeFileTab(openFileInTabs(EMPTY_FILE_TABS, "a", "a"), "a");
    expect(s).toEqual({ tabs: [], activeId: null });
  });

  it("存在しない id は何もしない", () => {
    const s = three();
    expect(closeFileTab(s, "zzz")).toBe(s);
  });
});

describe("selectFileTab", () => {
  it("存在しない id は無視する", () => {
    const s = openFileInTabs(EMPTY_FILE_TABS, "a", "a");
    expect(selectFileTab(s, "zzz")).toBe(s);
  });
});

describe("直列化", () => {
  it("往復でタブとアクティブが保たれる (id は振り直し)", () => {
    let s = openFileInTabs(EMPTY_FILE_TABS, "a.ts", "a", 3, 4);
    s = openFileInTabs(s, "/x.html", "b");
    s = selectFileTab(s, "a");
    let n = 0;
    const restored = deserializeFileTabs(serializeFileTabs(s), () => `n${++n}`);
    expect(restored.tabs.map(t => [t.id, t.kind, t.filePath])).toEqual([
      ["n1", "file", "a.ts"],
      ["n2", "html", "/x.html"],
    ]);
    expect(restored.tabs[0]).toMatchObject({
      targetLine: 3,
      targetEndLine: 4,
      revealSeq: 0,
    });
    expect(restored.activeId).toBe("n1");
  });

  it("null / 壊れた JSON / 形違いは EMPTY", () => {
    const mk = () => "x";
    expect(deserializeFileTabs(null, mk)).toEqual(EMPTY_FILE_TABS);
    expect(deserializeFileTabs("{oops", mk)).toEqual(EMPTY_FILE_TABS);
    expect(deserializeFileTabs('{"tabs":5}', mk)).toEqual(EMPTY_FILE_TABS);
    expect(deserializeFileTabs("null", mk)).toEqual(EMPTY_FILE_TABS);
  });

  it("不正なタブ要素は捨てる", () => {
    const raw = JSON.stringify({
      tabs: [{ filePath: 1 }, { filePath: "ok.ts" }],
      activeIndex: 0,
    });
    const s = deserializeFileTabs(raw, () => "i");
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].filePath).toBe("ok.ts");
  });
});

describe("fileTabsStorageKey", () => {
  it("worktree 毎のキー", () => {
    expect(fileTabsStorageKey("/w")).toBe("ark-file-tabs:/w");
  });
});
