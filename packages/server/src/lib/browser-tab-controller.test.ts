/**
 * browser-tab-controllerのテスト。ブラウザ、タブ1つぶんの準備、視聴者への出口は、
 * 呼び出しを記録する偽物。ブリッジを通した振る舞いは browser-cdp-bridge.test.ts にある。
 */

import type { BrowserServerMessage } from "@ark/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserTabController,
  SYNC_DEBOUNCE_MS,
  TABS_DEBOUNCE_MS,
} from "./browser-tab-controller.js";
import { MAX_TRACKED_TABS } from "./browser-tabs.js";

const ACTIVATE = "Target.activateTarget";
const CLOSE = "Target.closeTarget";
const CREATE = "Target.createTarget";
const GET_TARGETS = "Target.getTargets";
const DIALOG_NOTICE = {
  t: "notice",
  message: "ダイアログに応答してから切り替えてください",
};

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

function info(id: string, extra: Record<string, unknown> = {}) {
  return {
    targetId: id,
    type: "page",
    title: `${id}の題`,
    url: `http://localhost:3000/${id}`,
    ...extra,
  };
}

/**
 * `ids` のタブがあるブラウザにつないだ状態を作る (最初のタブへは、まだつないでいない)。
 * 作ったタブのidは `N1`、`N2`、...。`hold` したメソッドと準備は、`release` まで待たせる。
 */
function setup(ids = ["T1", "T2", "T3"]) {
  const calls: Array<{ method: string; params?: object }> = [];
  /** 起きたことの記録 (`leave:<gone>`、`enter:<id>`、`repaint`、`fail`) */
  const events: string[] = [];
  const sent: Array<{ to: string; message: BrowserServerMessage }> = [];
  const failing = new Set<string>();
  const failEnter = new Set<string>();
  const holding = new Set<string>();
  const held: Array<{ key: string; gate: Deferred }> = [];
  let targets: object[] = ids.map(id => info(id));
  let current: string | null = null;
  let dialog = false;
  let created = 0;

  const wait = (key: string): Promise<void> => {
    if (!holding.has(key)) return Promise.resolve();
    const gate = deferred();
    held.push({ key, gate });
    return gate.promise;
  };

  const controller = new BrowserTabController<string>({
    async send(method, params) {
      calls.push({ method, params });
      await wait(method);
      if (failing.has(method)) throw new Error(`${method}: failed`);
      if (method === CREATE) return { targetId: `N${++created}` };
      if (method === GET_TARGETS) return { targetInfos: targets };
      return {};
    },
    current: () => current,
    leave(gone) {
      events.push(`leave:${gone}`);
      current = null;
    },
    async enter(tab) {
      events.push(`enter:${tab.id}`);
      await wait("enter");
      if (failEnter.has(tab.id)) throw new Error(`${tab.id}: enter failed`);
      current = tab.id;
    },
    dialogOpen: () => dialog,
    repaint: () => events.push("repaint"),
    toViewer: (viewer, message) => sent.push({ to: viewer, message }),
    toAll: message => sent.push({ to: "all", message }),
    fail: () => events.push("fail"),
  });
  for (const id of ids) controller.targetCreated({ targetInfo: info(id) });

  return {
    controller,
    calls,
    events,
    sent,
    failing,
    failEnter,
    holding,
    current: () => current,
    setDialog(open: boolean) {
      dialog = open;
    },
    setTargets(next: object[]) {
      targets = next;
    },
    methods: () => calls.map(call => call.method),
    count: (method: string) => calls.filter(c => c.method === method).length,
    /** 待たせているもののうち、いちばん古い `key` を進める */
    release(key: string) {
      const index = held.findIndex(entry => entry.key === key);
      if (index < 0) throw new Error(`${key} は待たせていません`);
      held.splice(index, 1)[0].gate.resolve();
    },
    /** `key` を待たせるのをやめ、待たせていたものをすべて進める */
    releaseAll(key: string) {
      holding.delete(key);
      for (let i = held.length - 1; i >= 0; i--) {
        if (held[i].key === key) held.splice(i, 1)[0].gate.resolve();
      }
    },
    created(id: string, extra: Record<string, unknown> = {}) {
      controller.targetCreated({ targetInfo: info(id, extra) });
    },
    /** 最後に全員へ知らせた一覧の、idの並び */
    listed() {
      const message = sent.findLast(
        entry => entry.to === "all" && entry.message.t === "tabs"
      )?.message;
      return message?.t === "tabs" ? message.tabs.map(tab => tab.id) : null;
    },
    forget() {
      calls.length = 0;
      events.length = 0;
      sent.length = 0;
    },
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

/** 最初のタブ (`ids` の先頭) を映している状態にする。ここまでの記録は捨てる */
async function opened(ids = ["T1", "T2", "T3"]) {
  const ctx = setup(ids);
  await ctx.controller.open();
  ctx.forget();
  return ctx;
}

describe("BrowserTabController", () => {
  let disposables: Array<{ dispose(): void }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    disposables = [];
  });

  afterEach(() => {
    for (const controller of disposables) controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function start(ids?: string[]) {
    const ctx = await opened(ids);
    disposables.push(ctx.controller);
    return ctx;
  }

  describe("ダイアログが開いている間", () => {
    it("切り替えを断り、送った視聴者にだけ理由を返す", async () => {
      const ctx = await start();
      ctx.setDialog(true);
      ctx.controller.handle("v1", { t: "tab", type: "activate", id: "T2" });
      await flush();
      expect(ctx.events).toEqual([]);
      expect(ctx.calls).toEqual([]);
      expect(ctx.sent).toEqual([{ to: "v1", message: DIALOG_NOTICE }]);
      expect(ctx.current()).toBe("T1");
    });

    it("新しいタブを断り、送った視聴者にだけ理由を返す", async () => {
      const ctx = await start();
      ctx.setDialog(true);
      ctx.controller.handle("v1", { t: "tab", type: "new" });
      await flush();
      expect(ctx.events).toEqual([]);
      expect(ctx.calls).toEqual([]);
      expect(ctx.sent).toEqual([{ to: "v1", message: DIALOG_NOTICE }]);
    });

    it("映しているタブは閉じられ、隣のタブへ移る", async () => {
      const ctx = await start();
      ctx.setDialog(true);
      ctx.controller.handle("v1", { t: "tab", type: "close", id: "T1" });
      ctx.setDialog(false);
      await flush();
      expect(ctx.events).toEqual(["leave:false", "enter:T2"]);
      expect(ctx.calls).toEqual([
        { method: CLOSE, params: { targetId: "T1" } },
      ]);
      expect(ctx.sent.filter(entry => entry.message.t === "notice")).toEqual(
        []
      );
    });

    it("映していないタブも閉じられる", async () => {
      const ctx = await start();
      ctx.setDialog(true);
      ctx.controller.handle("v1", { t: "tab", type: "close", id: "T3" });
      await flush();
      expect(ctx.events).toEqual([]);
      expect(ctx.calls).toEqual([
        { method: CLOSE, params: { targetId: "T3" } },
      ]);
    });

    it("待っていた切り替えと新しいタブも、行うときに開いていれば断る", async () => {
      const ctx = await start();
      ctx.holding.add(CLOSE);
      ctx.controller.handle("v1", { t: "tab", type: "close", id: "T3" });
      ctx.controller.handle("v2", { t: "tab", type: "new" });
      ctx.controller.handle("v1", { t: "tab", type: "activate", id: "T2" });
      await flush();
      ctx.setDialog(true);
      ctx.releaseAll(CLOSE);
      await flush();
      expect(ctx.events).toEqual([]);
      expect(ctx.count(CREATE)).toBe(0);
      expect(ctx.sent.filter(entry => entry.message.t === "notice")).toEqual([
        { to: "v2", message: DIALOG_NOTICE },
        { to: "v1", message: DIALOG_NOTICE },
      ]);
    });

    it("映しているタブが開いたタブへも切り替えず、映しているタブを前面へ戻す", async () => {
      const ctx = await start();
      ctx.setDialog(true);
      ctx.created("T9", { openerId: "T1" });
      await flush();
      expect(ctx.calls).toEqual([
        { method: ACTIVATE, params: { targetId: "T1" } },
      ]);
      expect(ctx.events).toEqual(["repaint"]);
      expect(ctx.current()).toBe("T1");
    });
  });

  describe("切り替えないタブができたとき", () => {
    it.each([
      ["だれが開いたか分からないタブ", {}],
      ["ほかのタブが開いたタブ", { openerId: "T2" }],
    ])(
      "%s なら、映しているタブを前面へ戻し、全画面を送り直させる",
      async (_name, extra) => {
        const ctx = await start();
        ctx.created("T9", extra);
        await flush();
        expect(ctx.calls).toEqual([
          { method: ACTIVATE, params: { targetId: "T1" } },
        ]);
        expect(ctx.events).toEqual(["repaint"]);
      }
    );

    it("切り替えの途中にできたら、切り替えが終わってから、切り替えた先を前面へ戻す", async () => {
      const ctx = await start();
      ctx.holding.add("enter");
      ctx.controller.handle("v1", { t: "tab", type: "activate", id: "T2" });
      await flush();
      ctx.created("T9");
      await flush();
      expect(ctx.calls).toEqual([]);
      ctx.releaseAll("enter");
      await flush();
      expect(ctx.events).toEqual(["leave:false", "enter:T2", "repaint"]);
      expect(ctx.calls).toEqual([
        { method: ACTIVATE, params: { targetId: "T2" } },
      ]);
    });

    it("視聴者が開いた新しいタブでは、前面へ戻す指示を足さない (切り替えるので)", async () => {
      const ctx = await start();
      ctx.holding.add(CREATE);
      ctx.controller.handle("v1", { t: "tab", type: "new" });
      await flush();
      // 作ったことの知らせが、応答より先に届く
      ctx.created("N1", { url: "about:blank" });
      ctx.releaseAll(CREATE);
      await flush();
      ctx.created("N1", { url: "about:blank" });
      await flush();
      expect(ctx.events).toEqual(["leave:false", "enter:N1"]);
      expect(ctx.methods()).toEqual([CREATE]);
    });

    it("もうあるタブの知らせ直しと、タブでないものでは何もしない", async () => {
      const ctx = await start();
      ctx.created("T2", { title: "変えた" });
      ctx.created("W1", { type: "worker" });
      await flush();
      expect(ctx.calls).toEqual([]);
      expect(ctx.events).toEqual([]);
    });

    it("続けていくつもできても、前面へ戻す指示はまとめる", async () => {
      const ctx = await start();
      ctx.holding.add(ACTIVATE);
      for (const id of ["T6", "T7", "T8", "T9"]) ctx.created(id);
      ctx.releaseAll(ACTIVATE);
      await flush();
      ctx.releaseAll(ACTIVATE);
      await flush();
      // 行っている途中の1回と、そのあとの1回
      expect(ctx.count(ACTIVATE)).toBe(2);
      expect(ctx.events).toEqual(["repaint", "repaint"]);
    });

    it("前面へ戻せなければ、全画面は送り直させず、一覧を取り直す", async () => {
      const ctx = await start();
      ctx.failing.add(ACTIVATE);
      ctx.created("T9");
      await flush();
      expect(ctx.events).toEqual([]);
      await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS);
      expect(ctx.count(GET_TARGETS)).toBe(1);
    });

    it("最初のタブへつなぐ前は、何もしない", async () => {
      const ctx = setup();
      ctx.created("T9");
      await ctx.controller.open();
      await flush();
      expect(ctx.count(ACTIVATE)).toBe(0);
      expect(ctx.events).toEqual(["enter:T1"]);
    });
  });

  describe("ページが開いたタブ", () => {
    it("切り替えた先が消えたら、開いたタブへ戻る", async () => {
      const ctx = await start();
      ctx.created("T9", { openerId: "T1" });
      await flush();
      expect(ctx.events).toEqual(["leave:false", "enter:T9"]);
      ctx.forget();
      ctx.controller.targetDestroyed({ targetId: "T9" });
      await flush();
      // 並びでは直前のT3が先だが、開いたT1へ戻る
      expect(ctx.events).toEqual(["leave:true", "enter:T1"]);
    });

    it("sessionが切り離されたときも、開いたタブへ戻る", async () => {
      const ctx = await start();
      ctx.created("T9", { openerId: "T1" });
      await flush();
      ctx.forget();
      ctx.controller.lost();
      await flush();
      expect(ctx.events).toEqual(["leave:true", "enter:T1"]);
    });

    it("開いたタブがもう無ければ、隣のタブへ移る", async () => {
      const ctx = await start();
      ctx.created("T9", { openerId: "T1" });
      await flush();
      ctx.controller.targetDestroyed({ targetId: "T1" });
      ctx.forget();
      ctx.controller.targetDestroyed({ targetId: "T9" });
      await flush();
      expect(ctx.events).toEqual(["leave:true", "enter:T3"]);
    });

    it("自動で切り替えなかったタブは、あとで選んで消えても、隣のタブへ移る", async () => {
      const ctx = await start();
      ctx.created("T9", { openerId: "T2" });
      ctx.controller.handle("v1", { t: "tab", type: "activate", id: "T9" });
      await flush();
      ctx.forget();
      ctx.controller.targetDestroyed({ targetId: "T9" });
      await flush();
      expect(ctx.events).toEqual(["leave:true", "enter:T3"]);
    });

    it("切り替える前に消えていたら、映しているタブを前面へ戻す", async () => {
      const ctx = await start();
      ctx.holding.add(CLOSE);
      ctx.controller.handle("v1", { t: "tab", type: "close", id: "T3" });
      ctx.created("T9", { openerId: "T1" });
      ctx.controller.targetDestroyed({ targetId: "T9" });
      ctx.releaseAll(CLOSE);
      await flush();
      expect(ctx.events).toEqual(["repaint"]);
      expect(ctx.calls.at(-1)).toEqual({
        method: ACTIVATE,
        params: { targetId: "T1" },
      });
    });
  });

  describe("クラッシュ", () => {
    it("移り始めるときに、全員へ1度だけ知らせる", async () => {
      const ctx = await start();
      ctx.controller.crashed("T1");
      ctx.controller.crashed("T1");
      await flush();
      expect(ctx.sent.filter(({ message }) => message.t === "notice")).toEqual([
        {
          to: "all",
          message: { t: "notice", message: "タブがクラッシュしました" },
        },
      ]);
    });

    it("ふつうに閉じたときは知らせない", async () => {
      const ctx = await start();
      ctx.controller.handle("v1", { t: "tab", type: "close", id: "T1" });
      await flush();
      expect(ctx.sent.filter(({ message }) => message.t === "notice")).toEqual(
        []
      );
    });

    it("sessionを離してから閉じ、隣のタブへ移る", async () => {
      const ctx = await start();
      ctx.controller.crashed("T1");
      await flush();
      expect(ctx.events).toEqual(["leave:false", "enter:T2"]);
      expect(ctx.calls).toEqual([
        { method: CLOSE, params: { targetId: "T1" } },
      ]);
    });
  });

  describe("一覧の取り直し", () => {
    it("つなげなかったあとに、消えているタブを外し、足りないタブを足す", async () => {
      const ctx = await start();
      ctx.failEnter.add("T2");
      ctx.setTargets([
        info("T1"),
        info("T3"),
        info("T7"),
        info("W1", { type: "worker" }),
      ]);
      ctx.controller.handle("v1", { t: "tab", type: "activate", id: "T2" });
      await flush();
      expect(ctx.events).toEqual(["leave:false", "enter:T2", "enter:T1"]);
      expect(ctx.count(GET_TARGETS)).toBe(0);
      await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS);
      expect(ctx.count(GET_TARGETS)).toBe(1);
      await vi.advanceTimersByTimeAsync(TABS_DEBOUNCE_MS);
      expect(ctx.listed()).toEqual(["T1", "T3", "T7"]);
      // 足しただけのタブのために、前面へ戻す指示は送らない
      expect(ctx.count(ACTIVATE)).toBe(0);
      expect(ctx.current()).toBe("T1");
    });

    it("失敗が続いても、取り直すのは1回", async () => {
      const ctx = await start();
      ctx.failing.add(CLOSE);
      ctx.controller.handle("v1", { t: "tab", type: "close", id: "T2" });
      ctx.controller.handle("v1", { t: "tab", type: "close", id: "T3" });
      await flush();
      expect(ctx.count(CLOSE)).toBe(2);
      await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS * 3);
      expect(ctx.count(GET_TARGETS)).toBe(1);
    });

    it("映しているタブが消えていたら、ほかのタブへ移る", async () => {
      const ctx = await start();
      ctx.failing.add(CLOSE);
      ctx.setTargets([info("T2"), info("T3")]);
      ctx.controller.handle("v1", { t: "tab", type: "close", id: "T3" });
      await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS);
      expect(ctx.events).toEqual(["leave:true", "enter:T2"]);
    });

    it("取り直せなくても、やり直さない", async () => {
      const ctx = await start();
      ctx.failing.add(CLOSE);
      ctx.failing.add(GET_TARGETS);
      ctx.controller.handle("v1", { t: "tab", type: "close", id: "T3" });
      await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS * 5);
      expect(ctx.count(GET_TARGETS)).toBe(1);
      expect(ctx.events).toEqual([]);
    });

    it("捨てたら、待っていた取り直しを行わない", async () => {
      const ctx = await start();
      ctx.failing.add(CLOSE);
      ctx.controller.handle("v1", { t: "tab", type: "close", id: "T3" });
      await flush();
      ctx.controller.dispose();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS);
      expect(ctx.count(GET_TARGETS)).toBe(0);
    });
  });

  describe("追うタブの上限", () => {
    const many = Array.from({ length: MAX_TRACKED_TABS }, (_, i) => `T${i}`);

    it("超えたら、映しているタブを除いて、古いものから閉じる", async () => {
      const ctx = await start(many);
      ctx.created("X1");
      ctx.created("X2");
      await flush();
      expect(ctx.calls.filter(call => call.method === CLOSE)).toEqual([
        { method: CLOSE, params: { targetId: "T1" } },
        { method: CLOSE, params: { targetId: "T2" } },
      ]);
      await vi.advanceTimersByTimeAsync(TABS_DEBOUNCE_MS);
      expect(ctx.listed()).toEqual(["T0", ...many.slice(3), "X1", "X2"]);
      expect(ctx.current()).toBe("T0");
    });

    it("映しているタブを開いたタブは閉じない", async () => {
      const ctx = await start(many);
      ctx.created("X1", { openerId: "T0" });
      await flush();
      expect(ctx.current()).toBe("X1");
      ctx.created("X2", { openerId: "X1" });
      await flush();
      expect(ctx.current()).toBe("X2");
      // X2を開いたX1と、映しているX2は残る。T0は、もう守らない
      expect(
        ctx.calls
          .filter(call => call.method === CLOSE)
          .map(call => (call.params as { targetId: string }).targetId)
      ).toEqual(["T1", "T0"]);
      expect(ctx.count(ACTIVATE)).toBe(0);
    });

    it("最初から超えていたら、最初のタブへつなぐ前に閉じる", async () => {
      const ctx = setup([...many, "X1"]);
      disposables.push(ctx.controller);
      expect(ctx.calls).toEqual([]);
      await ctx.controller.open();
      expect(ctx.calls).toEqual([
        { method: CLOSE, params: { targetId: "T0" } },
      ]);
      expect(ctx.events).toEqual(["enter:T1"]);
    });
  });

  describe("一覧に出さないページへ移ったタブ", () => {
    const devtools = (id: string) => ({
      targetInfo: info(id, { url: "devtools://devtools/bundled/x.html" }),
    });

    it("映していないタブは、一覧から外す", async () => {
      const ctx = await start();
      expect(ctx.controller.targetInfoChanged(devtools("T2"))).toBe(false);
      await vi.advanceTimersByTimeAsync(TABS_DEBOUNCE_MS);
      expect(ctx.listed()).toEqual(["T1", "T3"]);
      expect(ctx.events).toEqual([]);
    });

    it("映しているタブは外さない (映しているタブが一覧に無い状態を見せない)", async () => {
      const ctx = await start();
      ctx.controller.targetInfoChanged(devtools("T1"));
      await vi.advanceTimersByTimeAsync(TABS_DEBOUNCE_MS);
      expect(ctx.listed()).toEqual(["T1", "T2", "T3"]);
      expect(ctx.events).toEqual([]);
    });
  });

  describe("操作の列", () => {
    /** 列を、上限まで「新しいタブ」で埋める。先頭の「閉じる」は応答を待たせてある */
    async function full() {
      const ctx = await start();
      ctx.holding.add(CLOSE);
      ctx.controller.handle("v1", { t: "tab", type: "close", id: "T3" });
      await flush();
      for (let i = 0; i < 40; i++) {
        ctx.controller.handle("v1", { t: "tab", type: "new" });
      }
      return ctx;
    }

    it("列がいっぱいでも、切り替えは捨てない", async () => {
      const ctx = await full();
      ctx.controller.handle("v1", { t: "tab", type: "activate", id: "T2" });
      ctx.releaseAll(CLOSE);
      await flush();
      expect(ctx.events).toContain("enter:T2");
      expect(ctx.current()).toBe("T2");
    });

    it("列がいっぱいのときに切り替えが続いたら、最後の1つだけを行う", async () => {
      const ctx = await full();
      ctx.created("T4");
      ctx.controller.handle("v1", { t: "tab", type: "activate", id: "T2" });
      ctx.controller.handle("v1", { t: "tab", type: "activate", id: "T4" });
      ctx.releaseAll(CLOSE);
      await flush();
      expect(ctx.events).not.toContain("enter:T2");
      expect(ctx.current()).toBe("T4");
    });

    it("列がいっぱいのときの、切り替えでない操作は捨てる", async () => {
      const ctx = await full();
      ctx.controller.handle("v1", { t: "tab", type: "close", id: "T2" });
      ctx.releaseAll(CLOSE);
      await flush();
      expect(ctx.count(CLOSE)).toBe(1);
    });

    it("どのタブにもつなげなくなったことは、1回だけ知らせる", async () => {
      const ctx = await start();
      for (const id of ["T1", "T2", "T3"]) ctx.failEnter.add(id);
      ctx.failing.add(CREATE);
      ctx.holding.add("enter");
      for (let i = 0; i < 5; i++) ctx.controller.lost();
      ctx.releaseAll("enter");
      await flush();
      expect(ctx.events.filter(event => event === "fail")).toEqual(["fail"]);
    });
  });

  describe("screencastを始められなかったとき", () => {
    it("ほかのタブへ移り、同じつなぎ直しの中では、始められなかったタブへ戻らない", async () => {
      const ctx = await start();
      ctx.controller.castFailed("T1", new Error("x"));
      await flush();
      expect(ctx.events).toEqual(["leave:false", "enter:T2"]);
      ctx.forget();
      ctx.controller.castFailed("T2", new Error("x"));
      await flush();
      // T2の直前はT1だが、T1では始められなかった
      expect(ctx.events).toEqual(["leave:false", "enter:T3"]);
      ctx.forget();
      ctx.controller.castFailed("T3", new Error("x"));
      await flush();
      expect(ctx.methods()).toEqual([CREATE]);
      expect(ctx.events).toEqual(["leave:false", "enter:N1"]);
    });

    it("作ったabout:blankでも始められなければ、つなげなくなったと知らせる", async () => {
      const ctx = await start(["T1"]);
      ctx.controller.castFailed("T1", new Error("x"));
      await flush();
      expect(ctx.current()).toBe("N1");
      ctx.forget();
      ctx.controller.castFailed("N1", new Error("x"));
      await flush();
      expect(ctx.events).toEqual(["fail"]);
      expect(ctx.calls).toEqual([]);
    });

    it("始められたら、始められなかったタブのことを忘れる", async () => {
      const ctx = await start();
      ctx.controller.castFailed("T1", new Error("x"));
      await flush();
      ctx.controller.castStarted("T2");
      ctx.forget();
      ctx.controller.castFailed("T2", new Error("x"));
      await flush();
      expect(ctx.events).toEqual(["leave:false", "enter:T1"]);
    });

    it("視聴者が名指しで選んだら、始められなかったタブも試す", async () => {
      const ctx = await start();
      ctx.controller.castFailed("T1", new Error("x"));
      await flush();
      ctx.forget();
      ctx.controller.handle("v1", { t: "tab", type: "activate", id: "T1" });
      await flush();
      expect(ctx.events).toEqual(["leave:false", "enter:T1"]);
    });

    it("映していないタブのぶんは無視する", async () => {
      const ctx = await start();
      ctx.controller.castFailed("T2", new Error("x"));
      await flush();
      expect(ctx.events).toEqual([]);
    });
  });

  describe("定期の読み直し", () => {
    it("映していないタブの題が変わっていたら、一覧を1回知らせ、変わらなければ知らせない", async () => {
      const ctx = await start();
      ctx.setTargets([info("T1"), info("T2", { title: "裏の題" }), info("T3")]);
      await ctx.controller.poll();
      await vi.advanceTimersByTimeAsync(TABS_DEBOUNCE_MS);
      const tabs = ctx.sent.filter(entry => entry.message.t === "tabs");
      expect(tabs).toHaveLength(1);
      expect(tabs[0].message).toMatchObject({
        tabs: [{ id: "T1" }, { id: "T2", title: "裏の題" }, { id: "T3" }],
        activeId: "T1",
      });
      await ctx.controller.poll();
      await vi.advanceTimersByTimeAsync(TABS_DEBOUNCE_MS);
      expect(ctx.sent.filter(entry => entry.message.t === "tabs")).toHaveLength(
        1
      );
      expect(ctx.count(GET_TARGETS)).toBe(2);
      expect(ctx.events).toEqual([]);
    });

    it("足りないタブを足し、もう無いタブと、一覧に出さないページへ移ったタブを外す", async () => {
      const ctx = await start(["T1", "T2", "T3", "T4"]);
      ctx.setTargets([
        info("T1"),
        info("T3", { url: "devtools://devtools/bundled/x.html" }),
        info("T4"),
        info("T7"),
        info("W1", { type: "worker" }),
      ]);
      await ctx.controller.poll();
      await vi.advanceTimersByTimeAsync(TABS_DEBOUNCE_MS);
      expect(ctx.listed()).toEqual(["T1", "T4", "T7"]);
      expect(ctx.events).toEqual([]);
      expect(ctx.count(ACTIVATE)).toBe(0);
    });

    it("映しているタブは、一覧に出さないページへ移っていても外さない", async () => {
      const ctx = await start();
      ctx.setTargets([
        info("T1", { url: "devtools://devtools/bundled/x.html" }),
        info("T2"),
        info("T3"),
      ]);
      await ctx.controller.poll();
      await vi.advanceTimersByTimeAsync(TABS_DEBOUNCE_MS);
      expect(ctx.listed()).toEqual(["T1", "T2", "T3"]);
      expect(ctx.events).toEqual([]);
    });

    it("操作が走っている間は、読まない", async () => {
      const ctx = await start();
      ctx.holding.add(CLOSE);
      ctx.controller.handle("v1", { t: "tab", type: "close", id: "T3" });
      await flush();
      await ctx.controller.poll();
      expect(ctx.count(GET_TARGETS)).toBe(0);
      ctx.releaseAll(CLOSE);
      await flush();
      await ctx.controller.poll();
      expect(ctx.count(GET_TARGETS)).toBe(1);
    });

    it("読んでいる間に頼まれた操作は、読み終えてから行う", async () => {
      const ctx = await start();
      ctx.holding.add(GET_TARGETS);
      const polled = ctx.controller.poll();
      await flush();
      ctx.controller.handle("v1", { t: "tab", type: "new" });
      await flush();
      expect(ctx.count(CREATE)).toBe(0);
      ctx.releaseAll(GET_TARGETS);
      await polled;
      await flush();
      // 作る前に読んだ一覧で、作ったタブを外さない
      expect(ctx.current()).toBe("N1");
      expect(ctx.events).toEqual(["leave:false", "enter:N1"]);
    });

    it("読めなければ、記録もやり直しもせずにrejectする", async () => {
      const ctx = await start();
      ctx.failing.add(GET_TARGETS);
      await expect(ctx.controller.poll()).rejects.toThrow("failed");
      await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS * 5);
      expect(ctx.count(GET_TARGETS)).toBe(1);
      expect(console.warn).not.toHaveBeenCalled();
      expect(ctx.events).toEqual([]);
    });

    it("最初のタブへつなぐ前と、捨てたあとは、読まない", async () => {
      const before = setup();
      await before.controller.poll();
      expect(before.count(GET_TARGETS)).toBe(0);
      const ctx = await start();
      ctx.controller.dispose();
      await ctx.controller.poll();
      expect(ctx.count(GET_TARGETS)).toBe(0);
    });
  });
});
