import { describe, expect, it } from "vitest";
import {
  BrowserTabs,
  MAX_TRACKED_TABS,
  readTargetInfo,
  type TargetInfo,
} from "./browser-tabs.js";

function page(id: string, extra: Partial<TargetInfo> = {}): TargetInfo {
  return {
    id,
    type: "page",
    title: `${id}の題`,
    url: `http://localhost:3000/${id}`,
    openerId: null,
    ...extra,
  };
}

function tabsOf(...ids: string[]): BrowserTabs {
  const tabs = new BrowserTabs();
  for (const id of ids) tabs.add(page(id));
  return tabs;
}

const ids = (tabs: BrowserTabs) => tabs.list().map(tab => tab.id);

describe("readTargetInfo", () => {
  it("CDPのtargetInfoを読む", () => {
    expect(
      readTargetInfo({
        targetId: "T1",
        type: "page",
        title: "題",
        url: "http://localhost/",
        openerId: "T0",
        attached: true,
      })
    ).toEqual({
      id: "T1",
      type: "page",
      title: "題",
      url: "http://localhost/",
      openerId: "T0",
    });
  });

  it("題とURLが無ければ空の文字列、openerIdが無ければnullにする", () => {
    expect(readTargetInfo({ targetId: "T1", type: "page" })).toEqual({
      id: "T1",
      type: "page",
      title: "",
      url: "",
      openerId: null,
    });
  });

  it("題は1024文字、URLは8192文字で切る", () => {
    const info = readTargetInfo({
      targetId: "T1",
      type: "page",
      title: "t".repeat(2000),
      url: "u".repeat(9000),
    });
    expect(info?.title).toHaveLength(1024);
    expect(info?.url).toHaveLength(8192);
  });

  it.each([
    [null],
    ["T1"],
    [{}],
    [{ targetId: 1, type: "page" }],
    [{ targetId: "", type: "page" }],
    [{ targetId: "T1" }],
  ])("形の違う %j は読まない", value => {
    expect(readTargetInfo(value)).toBeNull();
  });
});

describe("BrowserTabs", () => {
  it("足した順に並べる", () => {
    const tabs = tabsOf("T1", "T2", "T3");
    expect(tabs.list()).toEqual([
      { id: "T1", title: "T1の題", url: "http://localhost:3000/T1" },
      { id: "T2", title: "T2の題", url: "http://localhost:3000/T2" },
      { id: "T3", title: "T3の題", url: "http://localhost:3000/T3" },
    ]);
    expect(tabs.size).toBe(3);
    expect(tabs.has("T2")).toBe(true);
    expect(tabs.get("T2")).toEqual(tabs.list()[1]);
    expect(tabs.get("T9")).toBeNull();
  });

  it("足したら変わったと答え、同じものを足し直しても変わらない", () => {
    const tabs = new BrowserTabs();
    expect(tabs.add(page("T1"))).toBe(true);
    expect(tabs.add(page("T1"))).toBe(false);
    expect(tabs.size).toBe(1);
  });

  it("もうあるタブを足し直すと、位置を変えずに中身だけ変える", () => {
    const tabs = tabsOf("T1", "T2");
    expect(tabs.add(page("T1", { title: "新しい題" }))).toBe(true);
    expect(ids(tabs)).toEqual(["T1", "T2"]);
    expect(tabs.get("T1")?.title).toBe("新しい題");
  });

  it.each([
    ["worker", page("W1", { type: "worker" })],
    ["iframe", page("F1", { type: "iframe" })],
    ["DevToolsの画面", page("D1", { url: "devtools://devtools/x.html" })],
    ["拡張機能のページ", page("E1", { url: "chrome-extension://abc/p.html" })],
  ])("%s は足さない", (_name, info) => {
    const tabs = new BrowserTabs();
    expect(tabs.add(info)).toBe(false);
    expect(tabs.size).toBe(0);
  });

  it("更新は、追っているタブの題とURLだけを変える", () => {
    const tabs = tabsOf("T1", "T2");
    expect(tabs.update(page("T2", { title: "変えた" }))).toEqual({
      title: true,
    });
    expect(
      tabs.update(page("T2", { title: "変えた", url: "about:blank" }))
    ).toEqual({
      title: false,
    });
    expect(tabs.get("T2")).toEqual({
      id: "T2",
      title: "変えた",
      url: "about:blank",
    });
    expect(ids(tabs)).toEqual(["T1", "T2"]);
  });

  it("見える列が変わらない更新と、追っていないタブの更新は、何も変えない", () => {
    const tabs = tabsOf("T1");
    expect(tabs.update(page("T1"))).toBeNull();
    expect(tabs.update(page("T9"))).toBeNull();
    expect(tabs.update(page("W1", { type: "worker" }))).toBeNull();
    expect(tabs.size).toBe(1);
  });

  it("消したら変わったと答え、無いものを消しても変わらない", () => {
    const tabs = tabsOf("T1", "T2", "T3");
    expect(tabs.remove("T2")).toBe(true);
    expect(tabs.remove("T2")).toBe(false);
    expect(ids(tabs)).toEqual(["T1", "T3"]);
  });

  it("移る先の候補は、直前、直後、そのあとは近い順", () => {
    const tabs = tabsOf("T1", "T2", "T3", "T4", "T5");
    expect(tabs.fallbacks("T3")).toEqual(["T2", "T4", "T1", "T5"]);
    expect(tabs.fallbacks("T1")).toEqual(["T2", "T3", "T4", "T5"]);
    expect(tabs.fallbacks("T5")).toEqual(["T4", "T3", "T2", "T1"]);
  });

  it("1つだけなら候補は無い。一覧に無いidの候補は、一覧の順の全部", () => {
    expect(tabsOf("T1").fallbacks("T1")).toEqual([]);
    expect(tabsOf("T1", "T2").fallbacks("T9")).toEqual(["T1", "T2"]);
  });

  it("追っているタブがDevToolsの画面や拡張機能のページへ移ったら、一覧から外す", () => {
    const tabs = tabsOf("T1", "T2", "T3");
    expect(tabs.update(page("T2", { url: "devtools://devtools/x.html" }))).toBe(
      "removed"
    );
    expect(tabs.update(page("T3", { url: "chrome-extension://abc/p" }))).toBe(
      "removed"
    );
    expect(ids(tabs)).toEqual(["T1"]);
    // 外したタブの、そのあとの更新は当てない
    expect(tabs.update(page("T2"))).toBeNull();
  });

  it("残すと決めたタブは、DevToolsの画面へ移っても外さない", () => {
    const tabs = tabsOf("T1", "T2");
    expect(
      tabs.update(page("T1", { url: "devtools://devtools/x.html" }), true)
    ).toEqual({ title: false });
    expect(ids(tabs)).toEqual(["T1", "T2"]);
  });

  it("開いたタブを覚えているタブの候補は、開いたタブが先、あとは近い順", () => {
    const tabs = tabsOf("T1", "T2", "T3", "T4");
    tabs.follow("T4", "T1");
    expect(tabs.openerOf("T4")).toBe("T1");
    expect(tabs.openerOf("T3")).toBeNull();
    expect(tabs.fallbacks("T4")).toEqual(["T1", "T3", "T2"]);
  });

  it("開いたタブがもう無ければ、近い順だけにする。消したタブのことは忘れる", () => {
    const tabs = tabsOf("T1", "T2", "T3");
    tabs.follow("T3", "T1");
    tabs.remove("T1");
    expect(tabs.openerOf("T3")).toBeNull();
    expect(tabs.fallbacks("T3")).toEqual(["T2"]);
    tabs.follow("T3", "T2");
    tabs.remove("T3");
    tabs.add(page("T3"));
    expect(tabs.openerOf("T3")).toBeNull();
  });

  it("一覧に無いタブは、開いたタブとして覚えない", () => {
    const tabs = tabsOf("T1");
    tabs.follow("T1", "T9");
    tabs.follow("T8", "T1");
    expect(tabs.openerOf("T1")).toBeNull();
    expect(tabs.openerOf("T8")).toBeNull();
  });

  it("上限を超えたぶんを、古い順に、守るタブを除いて選ぶ", () => {
    const all = Array.from({ length: MAX_TRACKED_TABS + 3 }, (_, i) => `T${i}`);
    const tabs = tabsOf(...all);
    expect(tabs.overflow(new Set())).toEqual(["T0", "T1", "T2"]);
    expect(tabs.overflow(new Set(["T0", "T2"]))).toEqual(["T1", "T3", "T4"]);
    expect(
      tabsOf(...all.slice(0, MAX_TRACKED_TABS)).overflow(new Set())
    ).toEqual([]);
  });
});
