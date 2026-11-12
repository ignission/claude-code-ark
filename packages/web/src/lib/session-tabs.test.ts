import { describe, expect, it } from "vitest";
import {
  closeSessionTab,
  normalizeSessionTabs,
  openSessionTab,
  pruneSessionTabs,
  replaceSessionTab,
} from "./session-tabs";

describe("normalizeSessionTabs", () => {
  it("文字列の配列だけを通し、重複と空文字を落とす", () => {
    expect(normalizeSessionTabs(["a", "b", "a", "", 1, null])).toEqual([
      "a",
      "b",
    ]);
  });

  it("配列でなければ空にする", () => {
    expect(normalizeSessionTabs(null)).toEqual([]);
    expect(normalizeSessionTabs("a")).toEqual([]);
    expect(normalizeSessionTabs({ 0: "a" })).toEqual([]);
  });
});

describe("openSessionTab", () => {
  it("無ければ末尾に加える", () => {
    expect(openSessionTab(["a"], "b")).toEqual(["a", "b"]);
  });

  it("既にあれば同じ配列を返し、並びを変えない", () => {
    const tabs = ["a", "b"];
    expect(openSessionTab(tabs, "a")).toBe(tabs);
  });
});

describe("closeSessionTab", () => {
  it("右隣を代わりに選ぶ", () => {
    expect(closeSessionTab(["a", "b", "c"], "b")).toEqual({
      tabs: ["a", "c"],
      neighbor: "c",
    });
  });

  it("右端を閉じたら左隣を選ぶ", () => {
    expect(closeSessionTab(["a", "b", "c"], "c")).toEqual({
      tabs: ["a", "b"],
      neighbor: "b",
    });
  });

  it("最後の1つを閉じたら選ぶものは無い", () => {
    expect(closeSessionTab(["a"], "a")).toEqual({ tabs: [], neighbor: null });
  });

  it("無いタブは何も変えない", () => {
    const tabs = ["a"];
    expect(closeSessionTab(tabs, "x")).toEqual({ tabs, neighbor: null });
  });
});

describe("pruneSessionTabs", () => {
  it("無くなったセッションのタブを落とす", () => {
    expect(pruneSessionTabs(["a", "b", "c"], id => id !== "b")).toEqual([
      "a",
      "c",
    ]);
  });

  it("変わらなければ同じ配列を返す", () => {
    const tabs = ["a", "b"];
    expect(pruneSessionTabs(tabs, () => true)).toBe(tabs);
  });
});

describe("replaceSessionTab", () => {
  it("同じ位置のまま新しいIDに付け替える", () => {
    expect(replaceSessionTab(["a", "b", "c"], "b", "b2")).toEqual([
      "a",
      "b2",
      "c",
    ]);
  });

  it("新しいIDのタブが別にあれば、そちらを落とす", () => {
    expect(replaceSessionTab(["a", "b", "b2"], "b", "b2")).toEqual(["a", "b2"]);
  });

  it("古いIDのタブが無ければ同じ配列を返す", () => {
    const tabs = ["a"];
    expect(replaceSessionTab(tabs, "x", "y")).toBe(tabs);
  });
});
