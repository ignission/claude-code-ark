import type { BrowserPageInfo } from "@ark/shared";
import { describe, expect, it } from "vitest";
import { BrowserPageState, readHistory } from "./browser-page-state.js";

const MAIN = "F-main";

function setup(mainFrameId: string | null = MAIN) {
  const seen: BrowserPageInfo[] = [];
  const state = new BrowserPageState(info => seen.push(info), mainFrameId);
  return { state, seen };
}

function history(currentIndex: number, urls: string[]) {
  return {
    currentIndex,
    entries: urls.map((url, id) => ({ id, url, title: `title of ${url}` })),
  };
}

describe("BrowserPageState", () => {
  it("何も分かっていない間は、状態を持たない", () => {
    const { state, seen } = setup();
    expect(state.snapshot()).toBeNull();
    state.handleEvent("Page.frameStartedLoading", { frameId: MAIN });
    expect(state.snapshot()).toBeNull();
    expect(seen).toEqual([]);
  });

  it("メインフレームの遷移でURLを更新して知らせる", () => {
    const { state, seen } = setup();
    state.handleEvent("Page.frameNavigated", {
      frame: { id: MAIN, url: "http://localhost:3000/a" },
    });
    expect(seen).toEqual([
      {
        url: "http://localhost:3000/a",
        title: "",
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
    ]);
    expect(state.snapshot()).toEqual(seen[0]);
  });

  it("遷移のURLには、フラグメントを足す", () => {
    const { state } = setup();
    state.handleEvent("Page.frameNavigated", {
      frame: { id: MAIN, url: "http://localhost/a", urlFragment: "#top" },
    });
    expect(state.snapshot()?.url).toBe("http://localhost/a#top");
  });

  it("サブフレームの遷移と読み込みは無視する", () => {
    const { state, seen } = setup();
    state.handleEvent("Page.frameNavigated", {
      frame: { id: MAIN, url: "http://localhost/a" },
    });
    state.handleEvent("Page.frameNavigated", {
      frame: { id: "F-sub", parentId: MAIN, url: "http://localhost/sub" },
    });
    state.handleEvent("Page.navigatedWithinDocument", {
      frameId: "F-sub",
      url: "http://localhost/sub#x",
    });
    state.handleEvent("Page.frameStartedLoading", { frameId: "F-sub" });
    state.handleEvent("Page.frameStoppedLoading", { frameId: "F-sub" });
    expect(seen).toHaveLength(1);
    expect(state.snapshot()?.url).toBe("http://localhost/a");
  });

  it("メインフレームのものとして使ったかを返す", () => {
    const { state } = setup();
    expect(
      state.handleEvent("Page.frameNavigated", {
        frame: { id: MAIN, url: "http://localhost/a" },
      })
    ).toBe(true);
    // 状態が変わらなくても、メインフレームのものなら使ったと返す
    expect(
      state.handleEvent("Page.frameStoppedLoading", { frameId: MAIN })
    ).toBe(true);
    expect(state.handleEvent("Page.loadEventFired", {})).toBe(true);
    expect(
      state.handleEvent("Page.frameStoppedLoading", { frameId: "F-sub" })
    ).toBe(false);
    expect(
      state.handleEvent("Page.frameNavigated", {
        frame: { id: "F-sub", parentId: MAIN, url: "http://localhost/s" },
      })
    ).toBe(false);
    expect(state.handleEvent("Page.unknown", {})).toBe(false);
  });

  it("文書の中の遷移でURLを更新する", () => {
    const { state, seen } = setup();
    state.handleEvent("Page.frameNavigated", {
      frame: { id: MAIN, url: "http://localhost/a" },
    });
    state.handleEvent("Page.navigatedWithinDocument", {
      frameId: MAIN,
      url: "http://localhost/a#b",
    });
    expect(seen.map(info => info.url)).toEqual([
      "http://localhost/a",
      "http://localhost/a#b",
    ]);
  });

  it("読み込みの開始と終了を追う", () => {
    const { state, seen } = setup();
    state.handleEvent("Page.frameNavigated", {
      frame: { id: MAIN, url: "http://localhost/a" },
    });
    state.handleEvent("Page.frameStartedLoading", { frameId: MAIN });
    state.handleEvent("Page.frameStoppedLoading", { frameId: MAIN });
    state.handleEvent("Page.frameStartedLoading", { frameId: MAIN });
    state.handleEvent("Page.loadEventFired", { timestamp: 1 });
    expect(seen.map(info => info.loading)).toEqual([
      false,
      true,
      false,
      true,
      false,
    ]);
  });

  it("分かる前に始まった読み込みは、分かったときの状態に入る", () => {
    const { state, seen } = setup();
    state.handleEvent("Page.frameStartedLoading", { frameId: MAIN });
    state.handleEvent("Page.frameNavigated", {
      frame: { id: MAIN, url: "http://localhost/a" },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].loading).toBe(true);
  });

  it("同じ状態では知らせない", () => {
    const { state, seen } = setup();
    const navigated = { frame: { id: MAIN, url: "http://localhost/a" } };
    state.handleEvent("Page.frameNavigated", navigated);
    state.handleEvent("Page.frameNavigated", navigated);
    state.handleEvent("Page.frameStoppedLoading", { frameId: MAIN });
    state.handleEvent("Page.loadEventFired", {});
    state.applyHistory(history(0, ["http://localhost/a"]));
    state.applyHistory(history(0, ["http://localhost/a"]));
    expect(seen).toHaveLength(2);
  });

  it("メインフレームのidは、遷移から覚え直す", () => {
    const { state } = setup(null);
    // 分かる前は、どのフレームの読み込みか決められないので使わない
    state.handleEvent("Page.frameStartedLoading", { frameId: "F-1" });
    state.handleEvent("Page.frameNavigated", {
      frame: { id: "F-1", url: "http://localhost/a" },
    });
    expect(state.snapshot()?.loading).toBe(false);
    state.handleEvent("Page.frameStartedLoading", { frameId: "F-1" });
    expect(state.snapshot()?.loading).toBe(true);
  });

  it("履歴から、タイトル、URL、戻れるか、進めるかを決める", () => {
    const { state, seen } = setup();
    state.applyHistory(
      history(1, ["http://localhost/a", "http://localhost/b", "about:blank"])
    );
    expect(seen).toEqual([
      {
        url: "http://localhost/b",
        title: "title of http://localhost/b",
        loading: false,
        canGoBack: true,
        canGoForward: true,
      },
    ]);
    state.applyHistory(history(0, ["http://localhost/a"]));
    expect(state.snapshot()).toMatchObject({
      canGoBack: false,
      canGoForward: false,
    });
  });

  it("隣のエントリが開いてよいURLでなければ、戻れる、進めるとはしない", () => {
    const { state } = setup();
    state.applyHistory(
      history(1, [
        "https://example.com/",
        "http://localhost/b",
        "https://example.com/x",
      ])
    );
    expect(state.snapshot()).toMatchObject({
      canGoBack: false,
      canGoForward: false,
    });
    state.applyHistory(
      history(1, ["http://localhost/a", "https://example.com/", "about:blank"])
    );
    expect(state.snapshot()).toMatchObject({
      url: "https://example.com/",
      canGoBack: true,
      canGoForward: true,
    });
  });

  it.each([
    ["空の応答", {}],
    ["null", null],
    ["範囲の外の位置", { currentIndex: 3, entries: [] }],
    ["整数でない位置", history(0.5, ["http://localhost/a"])],
    [
      "文字列でないURL",
      { currentIndex: 0, entries: [{ id: 1, url: 1, title: "t" }] },
    ],
  ])("読めない履歴 (%s) では、前の状態を保つ", (_name, result) => {
    const { state, seen } = setup();
    state.applyHistory(history(0, ["http://localhost/a"]));
    state.applyHistory(result);
    expect(seen).toHaveLength(1);
    expect(state.snapshot()?.title).toBe("title of http://localhost/a");
  });

  it("形の違うイベントは無視する", () => {
    const { state, seen } = setup();
    state.handleEvent("Page.frameNavigated", undefined);
    state.handleEvent("Page.frameNavigated", { frame: { id: MAIN, url: 1 } });
    state.handleEvent("Page.navigatedWithinDocument", { frameId: MAIN });
    state.handleEvent("Page.unknown", { frameId: MAIN });
    expect(seen).toEqual([]);
  });

  it("長いURLとタイトルは切る", () => {
    const { state } = setup();
    state.applyHistory({
      currentIndex: 0,
      entries: [
        {
          id: 1,
          url: `http://localhost/${"a".repeat(10_000)}`,
          title: "t".repeat(10_000),
        },
      ],
    });
    expect(state.snapshot()?.url).toHaveLength(8192);
    expect(state.snapshot()?.title).toHaveLength(1024);
  });

  it("つないだ時点のURLと題を置いても知らせず、頼まれたときに1回だけ知らせる", () => {
    const { state, seen } = setup();
    state.seed("http://localhost/a", "題");
    const seeded = {
      url: "http://localhost/a",
      title: "題",
      loading: false,
      canGoBack: false,
      canGoForward: false,
    };
    expect(state.snapshot()).toEqual(seeded);
    expect(seen).toEqual([]);
    state.announce();
    state.announce();
    expect(seen).toEqual([seeded]);
  });

  it("置いたURLと題は切り、あとから読んだ履歴で置き換わる", () => {
    const { state, seen } = setup();
    state.seed("u".repeat(9000), "t".repeat(2000));
    expect(state.snapshot()?.url).toHaveLength(8192);
    expect(state.snapshot()?.title).toHaveLength(1024);
    state.applyHistory(
      history(1, ["http://localhost/a", "http://localhost/b"])
    );
    expect(seen.at(-1)).toMatchObject({
      url: "http://localhost/b",
      title: "title of http://localhost/b",
      canGoBack: true,
    });
  });

  it("何も分かっていなければ、頼まれても知らせない", () => {
    const { state, seen } = setup();
    state.announce();
    expect(seen).toEqual([]);
  });
});

describe("readHistory", () => {
  it("エントリのidを読む", () => {
    expect(readHistory(history(1, ["a", "b"]))?.entries[0].id).toBe(0);
    expect(
      readHistory({
        currentIndex: 0,
        entries: [{ id: "x", url: "a", title: "" }],
      })
    ).toBeNull();
  });
});
