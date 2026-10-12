import type { BrowserServerMessage } from "@ark/shared";
import { describe, expect, it } from "vitest";
import {
  type BrowserSessionState,
  browserSessionReducer,
  initialBrowserSessionState,
} from "./browser-session-state";

function receive(
  state: BrowserSessionState,
  ...messages: BrowserServerMessage[]
): BrowserSessionState {
  return messages.reduce(
    (current, message) =>
      browserSessionReducer(current, { type: "server", message }),
    state
  );
}

const PAGE: Extract<BrowserServerMessage, { t: "page" }> = {
  t: "page",
  url: "http://localhost:5173/",
  title: "アプリ",
  loading: false,
  canGoBack: true,
  canGoForward: false,
};

const TABS: Extract<BrowserServerMessage, { t: "tabs" }> = {
  t: "tabs",
  tabs: [
    { id: "A", title: "アプリ", url: "http://localhost:5173/" },
    { id: "B", title: "", url: "about:blank" },
  ],
  activeId: "A",
};

const DIALOG: Extract<BrowserServerMessage, { t: "dialog" }> = {
  t: "dialog",
  kind: "prompt",
  message: "名前は?",
  defaultPrompt: "太郎",
};

const SELECT: Extract<BrowserServerMessage, { t: "select" }> = {
  t: "select",
  id: 3,
  options: [
    { label: "赤", disabled: false, group: null },
    { label: "青", disabled: true, group: "寒色" },
  ],
  selectedIndex: 0,
  rect: { x: 10, y: 20, width: 100, height: 24 },
};

describe("browserSessionReducer", () => {
  it("初期値は、何も知らない状態", () => {
    expect(initialBrowserSessionState).toEqual({
      page: null,
      tabs: [],
      activeId: null,
      dialog: null,
      dialogAnswered: false,
      select: null,
      notice: null,
      noticeSeq: 0,
    });
  });

  it("`page` でページの状態を覚える", () => {
    const state = receive(initialBrowserSessionState, PAGE);
    expect(state.page).toEqual({
      url: "http://localhost:5173/",
      title: "アプリ",
      loading: false,
      canGoBack: true,
      canGoForward: false,
    });
  });

  it("中身の同じ `page` が続けて届いても、状態を作り直さない", () => {
    const state = receive(initialBrowserSessionState, PAGE);
    expect(receive(state, { ...PAGE })).toBe(state);
    expect(receive(state, { ...PAGE, loading: true })).not.toBe(state);
  });

  it("`tabs` でタブの一覧と、映しているタブを覚える", () => {
    const state = receive(initialBrowserSessionState, TABS);
    expect(state.tabs).toEqual(TABS.tabs);
    expect(state.activeId).toBe("A");
  });

  it("`dialog` で開き、`dialogClosed` で閉じる", () => {
    const open = receive(initialBrowserSessionState, DIALOG);
    expect(open.dialog).toEqual({
      kind: "prompt",
      message: "名前は?",
      defaultPrompt: "太郎",
    });
    expect(receive(open, { t: "dialogClosed" }).dialog).toBeNull();
  });

  it("同じ `dialog` がもう一度届いても、同じダイアログとして扱う", () => {
    const open = receive(initialBrowserSessionState, DIALOG);
    const again = receive(open, { ...DIALOG });
    expect(again).toBe(open);
    expect(again.dialog).toBe(open.dialog);
    // 中身が違えば別のダイアログ
    expect(receive(open, { ...DIALOG, message: "年齢は?" }).dialog).not.toBe(
      open.dialog
    );
  });

  it("`dialog` が届いたら、開いていた選択リストを閉じる", () => {
    const open = receive(initialBrowserSessionState, SELECT);
    const state = receive(open, DIALOG);
    expect(state.select).toBeNull();
    expect(state.dialog).not.toBeNull();

    // 同じダイアログがもう一度届いたときも閉じる
    const again = receive(state, SELECT, { ...DIALOG });
    expect(again.select).toBeNull();
    expect(again.dialog).toBe(state.dialog);
  });

  it("応答したダイアログは、別のダイアログに替わるか、閉じるまで、応答済みとして覚える", () => {
    const open = receive(initialBrowserSessionState, DIALOG);
    expect(open.dialogAnswered).toBe(false);
    const answered = browserSessionReducer(open, { type: "dialogAnswered" });
    expect(answered.dialogAnswered).toBe(true);
    expect(answered.dialog).toBe(open.dialog);
    // 同じダイアログがもう一度届いても、応答済みのまま
    expect(receive(answered, { ...DIALOG }).dialogAnswered).toBe(true);

    expect(
      receive(answered, { ...DIALOG, message: "年齢は?" }).dialogAnswered
    ).toBe(false);
    expect(receive(answered, { t: "dialogClosed" }).dialogAnswered).toBe(false);
    // 開いていなければ、何も変えない
    expect(
      browserSessionReducer(initialBrowserSessionState, {
        type: "dialogAnswered",
      })
    ).toBe(initialBrowserSessionState);
  });

  it("`select` で開き、同じ `id` の `selectClosed` で閉じる", () => {
    const open = receive(initialBrowserSessionState, SELECT);
    expect(open.select).toMatchObject({ id: 3, selectedIndex: 0 });
    expect(open.select?.options).toHaveLength(2);
    expect(receive(open, { t: "selectClosed", id: 2 }).select).toBe(
      open.select
    );
    expect(receive(open, { t: "selectClosed", id: 3 }).select).toBeNull();
  });

  it("手元で閉じた選択リストは、同じ `id` のものだけ閉じる", () => {
    const open = receive(initialBrowserSessionState, SELECT);
    expect(
      browserSessionReducer(open, { type: "selectDismissed", id: 9 }).select
    ).toBe(open.select);
    expect(
      browserSessionReducer(open, { type: "selectDismissed", id: 3 }).select
    ).toBeNull();
  });

  it("遷移したら、開いていた選択リストを閉じる", () => {
    const open = receive(initialBrowserSessionState, PAGE, SELECT);
    // URLが同じまま状態だけ変わったときは閉じない
    expect(receive(open, { ...PAGE, loading: true }).select).not.toBeNull();
    expect(
      receive(open, { ...PAGE, url: "http://localhost:5173/next" }).select
    ).toBeNull();
  });

  it("映すタブが替わったら、開いていた選択リストを閉じる", () => {
    const open = receive(initialBrowserSessionState, TABS, SELECT);
    // 一覧が変わっただけでは閉じない
    expect(
      receive(open, { ...TABS, tabs: [TABS.tabs[0]] }).select
    ).not.toBeNull();
    expect(receive(open, { ...TABS, activeId: "B" }).select).toBeNull();
  });

  it("`notice` は新しいものが前のものを置き換え、同じ文言でも別の知らせになる", () => {
    const first = receive(initialBrowserSessionState, {
      t: "notice",
      message: "開けません",
    });
    expect(first.notice).toEqual({ seq: 1, message: "開けません" });
    const second = receive(first, { t: "notice", message: "開けません" });
    expect(second.notice).toEqual({ seq: 2, message: "開けません" });
    const local = browserSessionReducer(second, {
      type: "notice",
      message: "コピーできませんでした",
    });
    expect(local.notice).toEqual({ seq: 3, message: "コピーできませんでした" });
  });

  it("消す時刻が来た知らせは、いま出ているものと同じときだけ消す", () => {
    const first = receive(initialBrowserSessionState, {
      t: "notice",
      message: "1つめ",
    });
    const second = receive(first, { t: "notice", message: "2つめ" });
    expect(
      browserSessionReducer(second, { type: "noticeExpired", seq: 1 }).notice
    ).toEqual({ seq: 2, message: "2つめ" });
    expect(
      browserSessionReducer(second, { type: "noticeExpired", seq: 2 }).notice
    ).toBeNull();
  });

  it("再接続で初期値に戻す", () => {
    const state = receive(
      initialBrowserSessionState,
      PAGE,
      TABS,
      DIALOG,
      SELECT,
      { t: "notice", message: "開けません" }
    );
    expect(browserSessionReducer(state, { type: "reset" })).toBe(
      initialBrowserSessionState
    );
  });

  it("このreducerが扱わない種類と、未知の種類は無視する", () => {
    const state = receive(initialBrowserSessionState, PAGE);
    expect(receive(state, { t: "viewport", width: 1, height: 1, gen: 1 })).toBe(
      state
    );
    expect(receive(state, { t: "clipboard", text: "x" })).toBe(state);
    expect(
      receive(state, { t: "future" } as unknown as BrowserServerMessage)
    ).toBe(state);
  });

  it("形の崩れたメッセージは無視する", () => {
    const state = receive(initialBrowserSessionState, PAGE, TABS);
    const broken = [
      { t: "page", url: 1 },
      { t: "tabs", tabs: "x", activeId: "A" },
      { t: "tabs", tabs: [{ id: 1 }], activeId: "A" },
      { t: "dialog", kind: "other", message: "", defaultPrompt: "" },
      { t: "select", id: 1, options: null, selectedIndex: 0, rect: {} },
      { t: "notice", message: 5 },
    ] as unknown as BrowserServerMessage[];
    expect(receive(state, ...broken)).toBe(state);
  });
});
