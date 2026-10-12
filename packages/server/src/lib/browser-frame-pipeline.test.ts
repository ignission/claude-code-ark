/**
 * browser-frame-pipelineのテスト。視聴者と取り直しは、呼び出しを記録する偽物で代用する。
 * ブリッジを通した振る舞い (CDPのコマンド、視聴者への通知) は browser-cdp-bridge.test.ts にある。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSolidPng } from "./browser-frame-diff.testkit.js";
import {
  BrowserFramePipeline,
  encodeFrameHeader,
  type FrameSink,
  monitorParams,
} from "./browser-frame-pipeline.js";

interface Viewer {
  ready: boolean;
  frames: Buffer[];
}

type Dot = { x: number; y: number; rgb: [number, number, number] };

const WHITE: [number, number, number] = [255, 255, 255];
const BLACK: [number, number, number] = [0, 0, 0];
/** 800x600のビューポートの監視フレームの寸法 */
const MONITOR = { width: 100, height: 75 };
const VIEWPORT = { width: 800, height: 600, dpr: 1 };

function monitor(dots: Dot[] = [], rgb = WHITE): Buffer {
  return buildSolidPng(MONITOR.width, MONITOR.height, rgb, dots);
}

function dot(x: number, y: number): Dot {
  return { x, y, rgb: BLACK };
}

function parse(frame: Buffer) {
  return {
    kind: frame[0],
    gen: frame.readUInt16BE(1),
    rect: {
      x: frame.readUInt16BE(3),
      y: frame.readUInt16BE(5),
      width: frame.readUInt16BE(7),
      height: frame.readUInt16BE(9),
    },
    image: frame.subarray(11).toString(),
  };
}

interface Capture {
  params: {
    format: string;
    quality: number;
    clip: {
      x: number;
      y: number;
      width: number;
      height: number;
      scale: number;
    };
  };
  resolve(): void;
  reject(): void;
}

function harness(options: { hold?: boolean } = {}) {
  const viewers: Viewer[] = [];
  const captures: Capture[] = [];
  let hold = options.hold ?? false;
  let throwing = false;
  let failing = false;
  const sink: FrameSink<Viewer> = {
    viewers: () => viewers,
    canReceive: viewer => viewer.ready,
    deliver: (viewer, frame) => {
      viewer.frames.push(frame);
    },
    capture(params) {
      if (throwing) throw new Error("capture threw");
      const index = captures.length + 1;
      const data = Buffer.from(`shot-${index}`).toString("base64");
      let resolve!: (value: unknown) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<unknown>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      captures.push({
        params: params as Capture["params"],
        resolve: () => resolve({ data }),
        reject: () => reject(new Error("capture failed")),
      });
      if (failing) reject(new Error("capture failed"));
      else if (!hold) resolve({ data });
      return promise;
    },
  };
  const pipeline = new BrowserFramePipeline<Viewer>(sink);
  return {
    pipeline,
    captures,
    viewers,
    join(ready = true): Viewer {
      const viewer: Viewer = { ready, frames: [] };
      viewers.push(viewer);
      pipeline.requestFull(viewer);
      return viewer;
    },
    setHold(value: boolean) {
      hold = value;
    },
    setThrowing(value: boolean) {
      throwing = value;
    },
    setFailing(value: boolean) {
      failing = value;
    },
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("encodeFrameHeader", () => {
  it("種類、世代、矩形をbig-endianの11バイトにする", () => {
    const header = encodeFrameHeader(3, 0x0102, {
      x: 0x0304,
      y: 0x0506,
      width: 0x0708,
      height: 0x090a,
    });
    expect([...header]).toEqual([3, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe("monitorParams", () => {
  it("PNGで、寸法は切り上げた1/8", () => {
    expect(monitorParams({ width: 1076, height: 834 })).toEqual({
      format: "png",
      maxWidth: 135,
      maxHeight: 105,
      everyNthFrame: 1,
    });
  });
});

describe("BrowserFramePipeline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** 最初の全画面を送り終え、動いていない状態まで進める */
  async function settled(options: { hold?: boolean } = {}) {
    const h = harness();
    h.pipeline.setApplied(VIEWPORT);
    const viewer = h.join();
    h.pipeline.monitorFrame(monitor(), null);
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    h.captures.length = 0;
    viewer.frames.length = 0;
    h.setHold(options.hold ?? false);
    return { ...h, viewer };
  }

  it("監視フレームが届くまでは取り直さず、届いたら鮮明な全画面を1枚送る", async () => {
    const h = harness();
    h.pipeline.setApplied(VIEWPORT);
    const viewer = h.join();
    await flush();
    expect(h.captures).toHaveLength(0);
    h.pipeline.monitorFrame(monitor(), null);
    await flush();
    expect(h.captures.map(c => c.params)).toEqual([
      {
        format: "jpeg",
        quality: 80,
        clip: { x: 0, y: 0, width: 800, height: 600, scale: 1 },
        captureBeyondViewport: false,
        optimizeForSpeed: true,
      },
    ]);
    expect(viewer.frames.map(parse)).toEqual([
      {
        kind: 1,
        gen: h.pipeline.viewport?.gen,
        rect: { x: 0, y: 0, width: 800, height: 600 },
        image: "shot-1",
      },
    ]);
    // 全画面で汚れは消えている。続けて取り直さない
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.captures).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("寸法の当たっていないあいだは、ビューポートを持たない", () => {
    const h = harness();
    expect(h.pipeline.viewport).toBeNull();
    h.pipeline.setApplied(VIEWPORT);
    expect(h.pipeline.viewport).toMatchObject({ width: 800, height: 600 });
    h.pipeline.setApplied(null);
    expect(h.pipeline.viewport).toBeNull();
  });

  it("世代は寸法が変わるたびに1増え、65536で0へ戻る", () => {
    const h = harness();
    h.pipeline.setApplied(VIEWPORT);
    const first = h.pipeline.viewport?.gen ?? -1;
    h.pipeline.setApplied({ ...VIEWPORT, width: 801 });
    expect(h.pipeline.viewport?.gen).toBe(first + 1);
    // 倍率だけの変更では増えない
    h.pipeline.setApplied({ ...VIEWPORT, width: 801, dpr: 2 });
    expect(h.pipeline.viewport?.gen).toBe(first + 1);
    for (let i = 0; i < 65535; i++) {
      h.pipeline.setApplied({ ...VIEWPORT, width: 800 + (i % 2) });
    }
    expect(h.pipeline.viewport?.gen).toBe(first);
  });

  it("取り直しの間に重なった変化は、1つの矩形にまとめる", async () => {
    const h = await settled({ hold: true });
    h.pipeline.monitorFrame(monitor([dot(10, 10)]), null);
    await flush();
    expect(h.captures).toHaveLength(1);
    h.pipeline.monitorFrame(monitor([dot(10, 10), dot(12, 10)]), null);
    h.pipeline.monitorFrame(
      monitor([dot(10, 10), dot(12, 10), dot(12, 12)]),
      null
    );
    h.setHold(false);
    h.captures[0].resolve();
    await flush();
    expect(h.captures).toHaveLength(2);
    // (12, 10) と (12, 12) を1画素ずつ広げた矩形は重なる
    expect(h.captures[1].params.clip).toEqual({
      x: 88,
      y: 72,
      width: 24,
      height: 40,
      scale: 1,
    });
    expect(h.viewer.frames.map(f => parse(f).kind)).toEqual([3, 3]);
  });

  it("溜まった矩形が上限を超えたら、全画面で送る", async () => {
    const h = await settled({ hold: true });
    const spots = [dot(5, 5), dot(30, 5), dot(55, 5), dot(80, 5), dot(5, 40)];
    h.pipeline.monitorFrame(monitor([dot(90, 70)]), null);
    await flush();
    for (let i = 1; i <= spots.length; i++) {
      h.pipeline.monitorFrame(
        monitor([dot(90, 70), ...spots.slice(0, i)]),
        null
      );
    }
    h.setHold(false);
    h.captures[0].resolve();
    await flush();
    expect(h.captures).toHaveLength(2);
    expect(h.captures[1].params.clip).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      scale: 1,
    });
    expect(h.viewer.frames.map(f => parse(f).kind)).toEqual([3, 1]);
  });

  it("取り直しが同期で投げても落ちず、間を置いて全画面を取り直す", async () => {
    const h = await settled();
    h.setThrowing(true);
    expect(() =>
      h.pipeline.monitorFrame(monitor([dot(10, 10)]), null)
    ).not.toThrow();
    await flush();
    expect(h.viewer.frames).toEqual([]);
    h.setThrowing(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.captures).toHaveLength(1);
    expect(h.captures[0].params.clip).toMatchObject({
      width: 800,
      height: 600,
    });
    expect(h.viewer.frames).toHaveLength(1);
  });

  it("取り直しが失敗し続けても、間を置いてしか試さない", async () => {
    const h = await settled();
    h.setFailing(true);
    h.pipeline.monitorFrame(monitor([dot(10, 10)]), null);
    await flush();
    expect(h.captures).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(49);
    expect(h.captures).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.captures).toHaveLength(2);
    expect(h.viewer.frames).toEqual([]);
  });

  it("矩形の途中で失敗したら、残りを取らずに全画面へ切り替える", async () => {
    const h = await settled({ hold: true });
    h.pipeline.monitorFrame(monitor([dot(10, 10), dot(80, 60)]), null);
    await flush();
    h.captures[0].reject();
    await flush();
    expect(h.captures).toHaveLength(1);
    h.setHold(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.captures).toHaveLength(2);
    expect(h.captures[1].params.clip).toMatchObject({
      width: 800,
      height: 600,
    });
  });

  it("取り直しの間に寸法が変わったら、結果を送らない", async () => {
    const h = await settled({ hold: true });
    h.pipeline.monitorFrame(monitor([dot(10, 10)]), null);
    await flush();
    h.pipeline.setApplied({ ...VIEWPORT, width: 640 });
    h.captures[0].resolve();
    await flush();
    expect(h.viewer.frames).toEqual([]);
    // 新しい寸法の最初の監視フレームで、全画面を送り直す
    h.setHold(false);
    h.pipeline.monitorFrame(buildSolidPng(80, 75, WHITE), null);
    await flush();
    expect(h.viewer.frames.map(parse)).toMatchObject([
      { kind: 1, rect: { x: 0, y: 0, width: 640, height: 600 } },
    ]);
  });

  it("止めたら、取り直しの結果を送らず、タイマーを残さない", async () => {
    const h = await settled({ hold: true });
    h.pipeline.monitorFrame(monitor([], BLACK), null);
    await flush();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    h.pipeline.stop();
    expect(vi.getTimerCount()).toBe(0);
    h.captures[0].resolve();
    await flush();
    expect(h.viewer.frames).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("止める前の取り直しが遅れて返っても、始め直したあとの取り直しを巻き込まない", async () => {
    const h = await settled({ hold: true });
    h.pipeline.monitorFrame(monitor([dot(10, 10)]), null);
    await flush();
    h.pipeline.stop();
    h.pipeline.monitorFrame(monitor(), null);
    await flush();
    expect(h.captures).toHaveLength(2);
    h.captures[0].resolve();
    await flush();
    expect(h.viewer.frames).toEqual([]);
    // 古い結果が返っても、いまの取り直しは走ったまま。もう1本は始まらない
    h.pipeline.monitorFrame(monitor([dot(10, 10)]), null);
    await flush();
    expect(h.captures).toHaveLength(2);
    h.captures[1].resolve();
    await flush();
    expect(h.viewer.frames.map(f => parse(f).image)).toEqual(["shot-2"]);
  });

  it("あとから入った視聴者への全画面は、粗い画のままの視聴者の鮮明化を取り消さない", async () => {
    const h = await settled();
    // 動いている: 全画面のすぐあとに、もう一度全面が変わる
    h.pipeline.monitorFrame(monitor([], BLACK), null);
    await flush();
    h.pipeline.monitorFrame(monitor(), null);
    await flush();
    expect(h.viewer.frames.map(f => parse(f).kind)).toEqual([1, 2]);
    const late = h.join();
    await flush();
    expect(late.frames.map(f => parse(f).kind)).toEqual([1]);
    expect(h.viewer.frames).toHaveLength(2);
    // 静かになったら、粗い画を見ている視聴者へ鮮明な全画面が届く
    await vi.advanceTimersByTimeAsync(250);
    expect(h.viewer.frames.map(f => parse(f).kind)).toEqual([1, 2, 1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("粗い画のあとに矩形を送っても、静かになったら鮮明な全画面を送る", async () => {
    const h = await settled();
    h.pipeline.monitorFrame(monitor([], BLACK), null);
    await flush();
    h.pipeline.monitorFrame(monitor(), null);
    await flush();
    h.pipeline.monitorFrame(monitor([dot(10, 10)]), null);
    await flush();
    expect(h.viewer.frames.map(f => parse(f).kind)).toEqual([1, 2, 3]);
    await vi.advanceTimersByTimeAsync(250);
    expect(h.viewer.frames.map(f => parse(f).kind)).toEqual([1, 2, 3, 1]);
  });

  it("全員が詰まっているあいだは取り直さず、空いたら取り直す", async () => {
    const h = await settled();
    h.viewer.ready = false;
    h.pipeline.monitorFrame(monitor([dot(10, 10)]), null);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.captures).toHaveLength(0);
    h.viewer.ready = true;
    await vi.advanceTimersByTimeAsync(50);
    expect(h.captures).toHaveLength(1);
    expect(h.viewer.frames.map(f => parse(f).kind)).toEqual([3]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
