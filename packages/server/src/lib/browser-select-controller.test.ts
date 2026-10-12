/**
 * browser-select-controllerのテスト。CDPと視聴者への出口は、呼び出しを記録する偽物。
 */

import type { BrowserServerMessage } from "@ark/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionDetachedError } from "./browser-cdp-client.js";
import { COPY_TIMEOUT_MS } from "./browser-page-controller.js";
import {
  BrowserSelectController,
  SELECT_NOTIFY_INTERVAL_MS,
  SELECT_WARN_INTERVAL_MS,
} from "./browser-select-controller.js";
import {
  SELECT_BINDING_NAME,
  SELECT_SHIM_SOURCE,
} from "./browser-select-shim.js";

const EVALUATE = "Runtime.evaluate";

function setup(
  options: { viewport?: { width: number; height: number } | null } = {}
) {
  const calls: Array<{ method: string; params?: object }> = [];
  const failing = new Set<string>();
  const sent: Array<{ to: string; message: BrowserServerMessage }> = [];
  let viewport =
    options.viewport === undefined
      ? { width: 800, height: 600 }
      : options.viewport;
  let ids = 0;
  const controller = new BrowserSelectController<string>({
    send(method, params) {
      calls.push({ method, params });
      return failing.has(method)
        ? Promise.reject(new Error(`${method}: failed`))
        : Promise.resolve({});
    },
    toViewer: (viewer, message) => sent.push({ to: viewer, message }),
    toAll: message => sent.push({ to: "all", message }),
    viewport: () => viewport,
    nextId: () => ++ids,
  });
  return {
    controller,
    calls,
    sent,
    failing,
    methods: () => calls.map(call => call.method),
    setViewport(next: { width: number; height: number } | null) {
      viewport = next;
    },
  };
}

const OPTIONS = [
  { label: "りんご", disabled: false, group: null },
  { label: "みかん", disabled: false, group: null },
  { label: "ぶどう", disabled: true, group: "果物" },
];
const RECT = { x: 10, y: 20, width: 120, height: 24 };

function called(pageId: number, extra: Record<string, unknown> = {}) {
  return {
    name: SELECT_BINDING_NAME,
    payload: JSON.stringify({
      id: pageId,
      options: OPTIONS,
      selectedIndex: 1,
      rect: RECT,
      ...extra,
    }),
    executionContextId: 3,
  };
}

function selectBody(id: number) {
  return { t: "select", id, options: OPTIONS, selectedIndex: 1, rect: RECT };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

/** 次の知らせが受け付けられるところまで、時刻だけを進める (タイマーは動かさない) */
function nextNotice(): void {
  vi.setSystemTime(Date.now() + SELECT_NOTIFY_INTERVAL_MS);
}

describe("BrowserSelectController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("準備", () => {
    it("Runtimeを有効にし、bindingを足し、スクリプトを新しい文書といまの文書へ入れる", async () => {
      const { controller, calls } = setup();
      await controller.prepare();
      expect(calls).toEqual([
        { method: "Runtime.enable", params: undefined },
        { method: "Runtime.addBinding", params: { name: "__arkSelect" } },
        {
          method: "Page.addScriptToEvaluateOnNewDocument",
          params: { source: SELECT_SHIM_SOURCE },
        },
        {
          method: EVALUATE,
          params: {
            expression: SELECT_SHIM_SOURCE,
            awaitPromise: false,
            returnByValue: true,
            timeout: COPY_TIMEOUT_MS,
          },
        },
      ]);
    });

    it.each([
      "Runtime.enable",
      "Runtime.addBinding",
      "Page.addScriptToEvaluateOnNewDocument",
    ])(
      "%s に失敗しても準備は成功し、警告を1回だけ出して、続きを送らない",
      async method => {
        const { controller, failing, methods } = setup();
        failing.add(method);
        await expect(controller.prepare()).resolves.toBeUndefined();
        await flush();
        expect(methods().at(-1)).toBe(method);
        expect(console.warn).toHaveBeenCalledTimes(1);
      }
    );

    it("渡された送り方で準備のコマンドを送り、その失敗 (時間切れなど) でも準備は成功する", async () => {
      const { controller, methods } = setup();
      const stepped: string[] = [];
      await expect(
        controller.prepare(async method => {
          stepped.push(method);
          if (method === "Runtime.addBinding") {
            throw new Error("Runtime.addBinding: 応答がありません");
          }
        })
      ).resolves.toBeUndefined();
      await flush();
      expect(stepped).toEqual(["Runtime.enable", "Runtime.addBinding"]);
      // いまの文書への評価も送らない
      expect(methods()).toEqual([]);
      expect(console.warn).toHaveBeenCalledTimes(1);
    });

    it("sessionが切り離された失敗は、準備の失敗にする", async () => {
      const { controller } = setup();
      await expect(
        controller.prepare(async () => {
          throw new SessionDetachedError();
        })
      ).rejects.toThrow("CDPのsessionが切り離されました");
      expect(console.warn).not.toHaveBeenCalled();
    });

    it("いまの文書へ入れるのに失敗しても、準備は成功する", async () => {
      const { controller, failing } = setup();
      failing.add(EVALUATE);
      await expect(controller.prepare()).resolves.toBeUndefined();
      await flush();
      expect(console.warn).toHaveBeenCalledTimes(1);
    });

    it("途中で捨てられたらrejectし、続きを送らない", async () => {
      const { controller, methods } = setup();
      const preparing = controller.prepare();
      controller.dispose();
      await expect(preparing).rejects.toThrow();
      expect(methods()).toEqual(["Runtime.enable"]);
    });
  });

  describe("知らせ", () => {
    it("通った知らせを、自分で振った番号で全員へ送る", () => {
      const { controller, sent } = setup();
      controller.bindingCalled(called(7));
      expect(sent).toEqual([{ to: "all", message: selectBody(1) }]);
      expect(controller.openId).toBe(1);
    });

    it("位置をビューポートの中へ収める", () => {
      const { controller, sent } = setup();
      controller.bindingCalled(
        called(0, { rect: { x: -20, y: 590, width: 100, height: 30 } })
      );
      expect(sent[0].message).toMatchObject({
        rect: { x: 0, y: 590, width: 80, height: 10 },
      });
    });

    it("別の名前のbindingは無視する", () => {
      const { controller, sent } = setup();
      controller.bindingCalled({ ...called(0), name: "__other" });
      controller.bindingCalled(undefined);
      controller.bindingCalled({ name: SELECT_BINDING_NAME, payload: 1 });
      expect(sent).toEqual([]);
    });

    it("映していないタブの知らせは捨てる", () => {
      const { controller, sent } = setup({ viewport: null });
      controller.bindingCalled(called(0));
      expect(sent).toEqual([]);
      expect(controller.openId).toBeNull();
    });

    it("壊れた知らせは捨て、警告は1秒に1回までにする", () => {
      const { controller, sent } = setup();
      const broken = { name: SELECT_BINDING_NAME, payload: "{" };
      for (let i = 0; i < 5; i++) controller.bindingCalled(broken);
      controller.bindingCalled(called(0, { options: [] }));
      expect(sent).toEqual([]);
      expect(console.warn).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(SELECT_WARN_INTERVAL_MS);
      controller.bindingCalled(broken);
      expect(console.warn).toHaveBeenCalledTimes(2);
    });

    it("開いている間の新しい知らせは、前のものを閉じてから置き換える", () => {
      const { controller, sent } = setup();
      controller.bindingCalled(called(7));
      nextNotice();
      controller.bindingCalled(called(8));
      expect(sent.map(entry => entry.message)).toEqual([
        selectBody(1),
        { t: "selectClosed", id: 1 },
        selectBody(2),
      ]);
      expect(controller.openId).toBe(2);
    });

    it("前に受け付けてから間隔が明けるまでに届いた知らせは、形が正しくても捨てる", () => {
      const { controller, sent } = setup();
      controller.bindingCalled(called(7));
      for (let i = 0; i < 19; i++) controller.bindingCalled(called(8 + i));
      vi.setSystemTime(Date.now() + SELECT_NOTIFY_INTERVAL_MS - 1);
      controller.bindingCalled(called(40));
      // 捨てた知らせは、前に開いた選択を閉じない
      expect(sent.map(entry => entry.message)).toEqual([selectBody(1)]);
      expect(controller.openId).toBe(1);
      expect(console.warn).not.toHaveBeenCalled();

      vi.setSystemTime(Date.now() + 1);
      controller.bindingCalled(called(41));
      expect(sent.map(entry => entry.message)).toEqual([
        selectBody(1),
        { t: "selectClosed", id: 1 },
        selectBody(2),
      ]);
    });

    it("捨てた知らせは、間隔を数え直さない。形の違う知らせも数えない", () => {
      const { controller, sent } = setup();
      controller.bindingCalled(called(7));
      vi.setSystemTime(Date.now() + SELECT_NOTIFY_INTERVAL_MS - 1);
      controller.bindingCalled(called(8));
      controller.bindingCalled({ name: SELECT_BINDING_NAME, payload: "{" });
      vi.setSystemTime(Date.now() + 1);
      controller.bindingCalled(called(9));
      expect(sent.map(entry => entry.message).at(-1)).toEqual(selectBody(2));
    });

    it("入った視聴者へ、開いている選択を知らせる", () => {
      const { controller, sent } = setup();
      controller.greet("late");
      controller.bindingCalled(called(7));
      controller.greet("late");
      expect(sent.at(-1)).toEqual({ to: "late", message: selectBody(1) });
      expect(sent).toHaveLength(2);
    });
  });

  describe("選ぶ", () => {
    it("ページの中のidと添字だけを埋めた式を評価し、全員へ閉じたと知らせる", () => {
      const { controller, calls, sent } = setup();
      controller.bindingCalled(called(7));
      controller.handle("v", { t: "selectChoose", id: 1, index: 0 });
      expect(calls).toEqual([
        {
          method: EVALUATE,
          params: {
            expression: "window.__arkSelectChoose(7, 0)",
            awaitPromise: false,
            returnByValue: true,
            timeout: COPY_TIMEOUT_MS,
          },
        },
      ]);
      expect(sent.at(-1)).toEqual({
        to: "all",
        message: { t: "selectClosed", id: 1 },
      });
      expect(controller.openId).toBeNull();
    });

    it("評価に失敗しても閉じる", async () => {
      const { controller, failing, sent } = setup();
      failing.add(EVALUATE);
      controller.bindingCalled(called(7));
      controller.handle("v", { t: "selectChoose", id: 1, index: 0 });
      await flush();
      expect(sent.at(-1)?.message).toEqual({ t: "selectClosed", id: 1 });
      expect(console.warn).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["開いていない番号", { id: 2, index: 0 }],
      ["ページの中のid", { id: 7, index: 0 }],
      ["範囲外の添字", { id: 1, index: 3 }],
      ["無効と知らせた選択肢", { id: 1, index: 2 }],
    ])("%s は無視し、開いたままにする", (_name, choice) => {
      const { controller, calls, sent } = setup();
      controller.bindingCalled(called(7));
      controller.handle("v", { t: "selectChoose", ...choice });
      expect(calls).toEqual([]);
      expect(sent).toHaveLength(1);
      expect(controller.openId).toBe(1);
    });

    it("選んだあとの同じ番号と、置き換えられた番号は無視する", () => {
      const { controller, calls } = setup();
      controller.bindingCalled(called(7));
      nextNotice();
      controller.bindingCalled(called(8));
      controller.handle("v", { t: "selectChoose", id: 1, index: 0 });
      expect(calls).toEqual([]);
      controller.handle("v", { t: "selectChoose", id: 2, index: 0 });
      controller.handle("v", { t: "selectChoose", id: 2, index: 0 });
      expect(calls).toHaveLength(1);
    });

    it("何も開いていなければ何もしない", () => {
      const { controller, calls, sent } = setup();
      controller.handle("v", { t: "selectChoose", id: 1, index: 0 });
      controller.handle("v", { t: "selectCancel", id: 1 });
      expect(calls).toEqual([]);
      expect(sent).toEqual([]);
    });
  });

  describe("閉じる", () => {
    it("取り消しは、ページの中の要素も捨てさせ、全員へ知らせる", () => {
      const { controller, calls, sent } = setup();
      controller.bindingCalled(called(7));
      controller.handle("v", { t: "selectCancel", id: 1 });
      expect(calls).toEqual([
        {
          method: EVALUATE,
          params: {
            expression: "window.__arkSelectCancel(7)",
            awaitPromise: false,
            returnByValue: true,
            timeout: COPY_TIMEOUT_MS,
          },
        },
      ]);
      expect(sent.at(-1)?.message).toEqual({ t: "selectClosed", id: 1 });
    });

    it("取り消しの評価に失敗しても閉じる", async () => {
      const { controller, failing, sent } = setup();
      failing.add(EVALUATE);
      controller.bindingCalled(called(7));
      controller.handle("v", { t: "selectCancel", id: 1 });
      await flush();
      expect(sent.at(-1)?.message).toEqual({ t: "selectClosed", id: 1 });
    });

    it("違う番号の取り消しは無視する", () => {
      const { controller, calls, sent } = setup();
      controller.bindingCalled(called(7));
      controller.handle("v", { t: "selectCancel", id: 5 });
      expect(calls).toEqual([]);
      expect(sent).toHaveLength(1);
    });

    it("メインフレームが遷移したら閉じる。iframeの遷移では閉じない", () => {
      const { controller, calls, sent } = setup();
      controller.bindingCalled(called(7));
      controller.frameNavigated({ frame: { id: "F2", parentId: "T1" } });
      controller.frameNavigated(undefined);
      expect(sent).toHaveLength(1);
      controller.frameNavigated({ frame: { id: "T1" } });
      expect(sent.at(-1)?.message).toEqual({ t: "selectClosed", id: 1 });
      // 文書はもう無い。ページへは何も送らない
      expect(calls).toEqual([]);
    });

    it("`close` は1回だけ知らせる", () => {
      const { controller, sent } = setup();
      controller.close();
      controller.bindingCalled(called(7));
      controller.close();
      controller.close();
      expect(sent.map(entry => entry.message)).toEqual([
        selectBody(1),
        { t: "selectClosed", id: 1 },
      ]);
    });

    it("捨てたあとは何も送らず、何も受け付けない", () => {
      const { controller, calls, sent } = setup();
      controller.bindingCalled(called(7));
      controller.dispose();
      expect(controller.openId).toBeNull();
      controller.bindingCalled(called(8));
      controller.handle("v", { t: "selectChoose", id: 1, index: 0 });
      controller.frameNavigated({ frame: { id: "T1" } });
      controller.greet("late");
      controller.close();
      expect(calls).toEqual([]);
      expect(sent).toHaveLength(1);
    });
  });
});
