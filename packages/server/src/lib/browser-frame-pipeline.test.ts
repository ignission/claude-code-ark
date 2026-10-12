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
  readFrameMetadata,
  VIEWER_FULL_MIN_INTERVAL_MS,
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

/** スクロールした位置だけを持つメタデータ */
function scrolled(y: number, x = 0) {
  return { size: null, scroll: { x, y } };
}

/** 左上が (x, y) で幅w、高さhの範囲の画素 */
function block(x: number, y: number, w: number, h: number): Dot[] {
  const dots: Dot[] = [];
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) dots.push(dot(x + dx, y + dy));
  }
  return dots;
}

const FULL = { x: 0, y: 0, width: 800, height: 600 };
/** `dot(10, 10)` を広げた矩形 */
const SPOT = { x: 72, y: 72, width: 24, height: 24 };

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

  it("値は整数に丸め、u16に収める", () => {
    const header = encodeFrameHeader(1, 70000, {
      x: -5,
      y: 3.6,
      width: 70000,
      height: 65535.4,
    });
    expect(header).toHaveLength(11);
    expect(header.readUInt16BE(1)).toBe(70000 & 0xffff);
    expect(header.readUInt16BE(3)).toBe(0);
    expect(header.readUInt16BE(5)).toBe(4);
    expect(header.readUInt16BE(7)).toBe(65535);
    expect(header.readUInt16BE(9)).toBe(65535);
  });
});

describe("readFrameMetadata", () => {
  it("寸法とスクロールした位置を読む", () => {
    expect(
      readFrameMetadata({
        offsetTop: 0,
        pageScaleFactor: 1,
        deviceWidth: 800,
        deviceHeight: 600,
        scrollOffsetX: 0,
        scrollOffsetY: 300,
      })
    ).toEqual({ size: { width: 800, height: 600 }, scroll: { x: 0, y: 300 } });
  });

  it("寸法は1以上の有限の数だけを使い、整数に丸める", () => {
    const size = (deviceWidth: unknown, deviceHeight: unknown) =>
      readFrameMetadata({ deviceWidth, deviceHeight }).size;
    expect(size(390.6, 699.5)).toEqual({ width: 391, height: 700 });
    expect(size(1, 1)).toEqual({ width: 1, height: 1 });
    expect(size(0.9, 700)).toBeNull();
    expect(size(390, 0)).toBeNull();
    expect(size(-390, 700)).toBeNull();
    expect(size(Number.NaN, 700)).toBeNull();
    expect(size(Number.POSITIVE_INFINITY, 700)).toBeNull();
    expect(size("390", 700)).toBeNull();
    // ヘッダに載らない大きさは使わない
    expect(size(65536, 700)).toBeNull();
  });

  it("スクロールした位置は、有限の数でなければ0にする", () => {
    const scroll = (scrollOffsetX: unknown, scrollOffsetY: unknown) =>
      readFrameMetadata({ scrollOffsetX, scrollOffsetY }).scroll;
    expect(scroll(12.5, 300)).toEqual({ x: 12.5, y: 300 });
    expect(scroll(Number.NaN, "300")).toEqual({ x: 0, y: 0 });
    expect(scroll(undefined, Number.POSITIVE_INFINITY)).toEqual({ x: 0, y: 0 });
    expect(readFrameMetadata(null)).toEqual({
      size: null,
      scroll: { x: 0, y: 0 },
    });
    expect(readFrameMetadata("x")).toEqual({
      size: null,
      scroll: { x: 0, y: 0 },
    });
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

  describe("取り直しの位置", () => {
    it("矩形は文書の座標で取り直し、ヘッダはビューポートの座標のままにする", async () => {
      const h = await settled();
      h.pipeline.monitorFrame(monitor([dot(10, 10)]), scrolled(300, 20));
      await flush();
      expect(h.captures.map(c => c.params.clip)).toEqual([
        { x: SPOT.x + 20, y: SPOT.y + 300, width: 24, height: 24, scale: 1 },
      ]);
      expect(h.viewer.frames.map(f => parse(f).rect)).toEqual([SPOT]);
    });

    it("鮮明な全画面も粗い全画面も、スクロールした位置から取り直す", async () => {
      const h = await settled();
      h.pipeline.monitorFrame(monitor([], BLACK), scrolled(300));
      await flush();
      h.pipeline.monitorFrame(monitor(), scrolled(450));
      await flush();
      expect(h.captures.map(c => c.params.clip)).toEqual([
        { x: 0, y: 300, width: 800, height: 600, scale: 1 },
        { x: 0, y: 450, width: 800, height: 600, scale: 0.5 },
      ]);
      expect(h.viewer.frames.map(parse)).toMatchObject([
        { kind: 1, rect: FULL },
        { kind: 2, rect: FULL },
      ]);
    });

    it("スクロールした位置は、最後の監視フレームのものを使う", async () => {
      const h = await settled();
      h.pipeline.monitorFrame(monitor(), scrolled(300));
      h.pipeline.monitorFrame(monitor([dot(10, 10)]), null);
      await flush();
      expect(h.captures[0].params.clip).toEqual({ ...SPOT, scale: 1 });
    });

    it("つなぎ直したら、スクロールした位置を0へ戻す", async () => {
      const h = await settled();
      h.pipeline.monitorFrame(monitor(), scrolled(300));
      h.pipeline.setApplied(null);
      h.pipeline.setApplied(VIEWPORT);
      h.pipeline.requestFull(h.viewer);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.captures).toHaveLength(0);
      h.pipeline.monitorFrame(monitor(), null);
      await flush();
      expect(h.captures.map(c => c.params.clip)).toEqual([
        { ...FULL, scale: 1 },
      ]);
    });
  });

  describe("ダイアログ", () => {
    it("開いているあいだは取り直さず、閉じたら全画面を取り直す", async () => {
      const h = await settled();
      h.pipeline.setDialogOpen(true);
      h.pipeline.monitorFrame(monitor([dot(10, 10)]), null);
      const late = h.join();
      h.pipeline.requestFull(h.viewer);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.captures).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
      h.pipeline.setDialogOpen(false);
      await flush();
      expect(h.captures.map(c => c.params.clip)).toEqual([
        { ...FULL, scale: 1 },
      ]);
      expect(h.viewer.frames.map(f => parse(f).kind)).toEqual([1]);
      expect(late.frames.map(f => parse(f).kind)).toEqual([1]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("開いたときに走っていた取り直しのあと、次を始めない", async () => {
      const h = await settled({ hold: true });
      h.pipeline.monitorFrame(monitor([dot(10, 10), dot(80, 60)]), null);
      await flush();
      expect(h.captures).toHaveLength(1);
      h.pipeline.setDialogOpen(true);
      h.captures[0].resolve();
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.captures).toHaveLength(1);
      h.setHold(false);
      h.pipeline.setDialogOpen(false);
      await flush();
      expect(h.captures).toHaveLength(2);
      expect(h.captures[1].params.clip).toEqual({ ...FULL, scale: 1 });
    });

    it("開いたときに走っていた取り直しは時間切れに任せ、閉じたらすぐ取り直す", async () => {
      const h = await settled({ hold: true });
      h.pipeline.monitorFrame(monitor([dot(10, 10)]), null);
      await flush();
      h.pipeline.setDialogOpen(true);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.captures).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      h.setHold(false);
      h.pipeline.setDialogOpen(false);
      await flush();
      expect(h.captures).toHaveLength(2);
      expect(h.viewer.frames.map(f => parse(f).kind)).toEqual([1]);
    });

    it("screencastを止めても開いたままで、接続を捨てたら閉じた扱いに戻す", async () => {
      const h = await settled();
      h.pipeline.setDialogOpen(true);
      h.pipeline.stop();
      h.pipeline.monitorFrame(monitor(), null);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.captures).toHaveLength(0);
      h.pipeline.setApplied(null);
      h.pipeline.setApplied(VIEWPORT);
      h.pipeline.monitorFrame(monitor(), null);
      await flush();
      expect(h.captures).toHaveLength(1);
    });
  });

  describe("仕上げ", () => {
    /** 粗い全画面を送った直後まで進める */
    async function coarse() {
      const h = await settled();
      h.pipeline.monitorFrame(monitor([], BLACK), null);
      await flush();
      h.pipeline.monitorFrame(monitor(), null);
      await flush();
      expect(h.viewer.frames.map(f => parse(f).kind)).toEqual([1, 2]);
      return h;
    }

    it("小さな変化が続いていても、全面の変化が止まれば鮮明な全画面を送る", async () => {
      const h = await coarse();
      const kinds = () => h.viewer.frames.map(f => parse(f).kind);
      for (let i = 0; i < 20; i++) {
        h.pipeline.monitorFrame(
          monitor(i % 2 === 0 ? [dot(10, 10)] : []),
          null
        );
        await vi.advanceTimersByTimeAsync(100);
        if (i === 1) expect(kinds().filter(k => k === 1)).toHaveLength(1);
        if (i === 2) expect(kinds().filter(k => k === 1)).toHaveLength(2);
      }
      expect(kinds().filter(k => k === 1)).toHaveLength(2);
      expect(kinds().filter(k => k === 2)).toHaveLength(1);
      // 矩形は流れ続ける (仕上げの全画面に含まれたぶんを除く)
      expect(kinds().filter(k => k === 3).length).toBeGreaterThanOrEqual(18);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("変化の無い監視フレームでは、仕上げを先へ延ばさない", async () => {
      const h = await coarse();
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(100);
        h.pipeline.monitorFrame(monitor(), null);
      }
      expect(h.viewer.frames.map(f => parse(f).kind)).toEqual([1, 2, 1]);
    });

    it("全面の変化が続くあいだは、仕上げを先へ延ばす", async () => {
      const h = await coarse();
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(100);
        h.pipeline.monitorFrame(monitor([], i % 2 === 0 ? BLACK : WHITE), null);
      }
      await flush();
      const kinds = h.viewer.frames.map(f => parse(f).kind);
      expect(kinds.slice(2).every(k => k === 2)).toBe(true);
      await vi.advanceTimersByTimeAsync(250);
      expect(h.viewer.frames.map(f => parse(f).kind).at(-1)).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("取り直しの最中に静かになったら、終わってから鮮明な全画面を送る", async () => {
      const h = await coarse();
      h.setHold(true);
      h.pipeline.monitorFrame(monitor([dot(10, 10)]), null);
      await vi.advanceTimersByTimeAsync(250);
      // 同時に2本は走らせない
      expect(h.captures).toHaveLength(3);
      h.captures[2].resolve();
      await flush();
      expect(h.captures).toHaveLength(4);
      expect(h.captures[3].params).toMatchObject({
        quality: 80,
        clip: { ...FULL, scale: 1 },
      });
      h.captures[3].resolve();
      await flush();
      expect(h.viewer.frames.map(f => parse(f).kind)).toEqual([1, 2, 3, 1]);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("視聴者ごとの送り直し", () => {
    const kinds = (viewer: Viewer) => viewer.frames.map(f => parse(f).kind);

    it("送り直しを頼み続ける視聴者には、間隔を空けてしか全画面を送らない", async () => {
      const h = await settled();
      for (let i = 0; i < 20; i++) {
        h.pipeline.requestFull(h.viewer);
        await vi.advanceTimersByTimeAsync(5);
      }
      expect(kinds(h.viewer)).toEqual([1]);
      await vi.advanceTimersByTimeAsync(VIEWER_FULL_MIN_INTERVAL_MS - 100 - 1);
      expect(kinds(h.viewer)).toEqual([1]);
      await vi.advanceTimersByTimeAsync(1);
      expect(kinds(h.viewer)).toEqual([1, 1]);
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.captures).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("頼み続けても、間隔ごとに1枚を超えない", async () => {
      const h = await settled();
      for (let i = 0; i < 399; i++) {
        h.pipeline.requestFull(h.viewer);
        await vi.advanceTimersByTimeAsync(5);
      }
      // 2000msに届く前に、0、500、1000、1500msの4枚
      expect(kinds(h.viewer)).toEqual([1, 1, 1, 1]);
    });

    it("間隔を待っているあいだの矩形は溜めておき、送り直す全画面に含める", async () => {
      const h = await settled();
      h.pipeline.requestFull(h.viewer);
      await flush();
      h.pipeline.requestFull(h.viewer);
      h.pipeline.monitorFrame(monitor([dot(10, 10)]), null);
      await vi.advanceTimersByTimeAsync(VIEWER_FULL_MIN_INTERVAL_MS - 1);
      expect(h.captures).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(kinds(h.viewer)).toEqual([1, 1]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.captures).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("揃っている視聴者への矩形を、送り直しより先に取り直す", async () => {
      const h = await settled({ hold: true });
      const second = h.join();
      await flush();
      h.pipeline.monitorFrame(monitor([dot(10, 10)]), null);
      h.captures[0].resolve();
      await flush();
      expect(kinds(second)).toEqual([1]);
      // 矩形の取り直しの最中に、もう1人が入り、次の変化も来る
      expect(h.captures).toHaveLength(2);
      const third = h.join();
      h.pipeline.monitorFrame(monitor(), null);
      h.captures[1].resolve();
      await flush();
      expect(h.captures).toHaveLength(3);
      expect(h.captures[2].params.clip).toEqual({ ...SPOT, scale: 1 });
      expect(third.frames).toEqual([]);
      h.captures[2].resolve();
      await flush();
      expect(kinds(h.viewer)).toEqual([3, 3]);
      expect(h.captures).toHaveLength(4);
      expect(h.captures[3].params.clip).toEqual({ ...FULL, scale: 1 });
      h.captures[3].resolve();
      await flush();
      expect(kinds(third)).toEqual([1]);
      expect(kinds(h.viewer)).toEqual([3, 3]);
      expect(kinds(second)).toEqual([1, 3, 3]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("矩形が流れ続けていても、待たせすぎずに送り直す", async () => {
      const h = await settled({ hold: true });
      h.pipeline.monitorFrame(monitor([dot(10, 10)]), null);
      await flush();
      const late = h.join();
      const joinedAt = Date.now();
      for (let i = 0; i < 40 && late.frames.length === 0; i++) {
        await vi.advanceTimersByTimeAsync(50);
        h.pipeline.monitorFrame(
          monitor(i % 2 === 0 ? [] : [dot(10, 10)]),
          null
        );
        h.captures.at(-1)?.resolve();
        await flush();
      }
      expect(kinds(late)).toEqual([1]);
      expect(Date.now() - joinedAt).toBeLessThanOrEqual(
        VIEWER_FULL_MIN_INTERVAL_MS + 100
      );
      // それまでの間、揃っている視聴者には矩形が届き続けている
      expect(kinds(h.viewer).length).toBeGreaterThanOrEqual(10);
      expect(kinds(h.viewer).every(kind => kind === 3)).toBe(true);
    });

    it("全員へ送る鮮明な全画面は、間隔を待っている視聴者にも届け、その視聴者の1枚に数える", async () => {
      const h = await settled();
      const second = h.join();
      await flush();
      h.pipeline.requestFull(second);
      h.pipeline.monitorFrame(monitor([], BLACK), null);
      await flush();
      expect(h.captures).toHaveLength(2);
      expect(kinds(h.viewer)).toEqual([1]);
      expect(kinds(second)).toEqual([1, 1]);
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.captures).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("寸法が変わったときの全画面は、間隔を待たせない", async () => {
      const h = await settled();
      h.pipeline.requestFull(h.viewer);
      await flush();
      h.pipeline.setApplied({ ...VIEWPORT, width: 640 });
      h.pipeline.monitorFrame(buildSolidPng(80, 75, WHITE), null);
      await flush();
      expect(h.viewer.frames.map(parse)).toMatchObject([
        { kind: 1, rect: FULL },
        { kind: 1, rect: { x: 0, y: 0, width: 640, height: 600 } },
      ]);
    });

    it("1回の鮮明な全画面を、頼んだ視聴者と揃っている視聴者へ送り、詰まっている視聴者にはあとで送る", async () => {
      const h = await settled();
      const asking = h.join();
      const slow = h.join();
      await vi.advanceTimersByTimeAsync(1000);
      for (const viewer of h.viewers) viewer.frames.length = 0;
      h.captures.length = 0;
      h.setHold(true);
      h.pipeline.monitorFrame(monitor([], BLACK), null);
      await flush();
      expect(h.captures).toHaveLength(1);
      h.pipeline.requestFull(asking);
      slow.ready = false;
      h.setHold(false);
      h.captures[0].resolve();
      await flush();
      expect(h.viewer.frames.map(parse)).toMatchObject([
        { kind: 1, image: "shot-1" },
      ]);
      expect(asking.frames.map(parse)).toMatchObject([
        { kind: 1, image: "shot-1" },
      ]);
      expect(slow.frames).toEqual([]);
      expect(h.captures).toHaveLength(1);
      slow.ready = true;
      await vi.advanceTimersByTimeAsync(50);
      expect(slow.frames.map(parse)).toMatchObject([
        { kind: 1, image: "shot-2" },
      ]);
      expect(h.viewer.frames).toHaveLength(1);
      expect(asking.frames).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("取り直しの最中に入った視聴者には、その結果を送らず、鮮明な全画面から送る", async () => {
      const h = await settled({ hold: true });
      h.pipeline.monitorFrame(monitor([dot(10, 10)]), null);
      await flush();
      const late = h.join();
      h.setHold(false);
      h.captures[0].resolve();
      await flush();
      expect(kinds(h.viewer)).toEqual([3]);
      expect(late.frames.map(parse)).toMatchObject([
        { kind: 1, rect: FULL, image: "shot-2" },
      ]);
    });

    it("鮮明な全画面を送るときに詰まっていた視聴者は、空いたら全画面から受け取る", async () => {
      const h = await settled();
      const slow = h.join();
      await vi.advanceTimersByTimeAsync(1000);
      slow.frames.length = 0;
      slow.ready = false;
      h.pipeline.monitorFrame(monitor([], BLACK), null);
      await flush();
      h.pipeline.monitorFrame(
        monitor([{ x: 10, y: 10, rgb: WHITE }], BLACK),
        null
      );
      await flush();
      expect(kinds(h.viewer)).toEqual([1, 3]);
      expect(slow.frames).toEqual([]);
      slow.ready = true;
      await vi.advanceTimersByTimeAsync(50);
      expect(kinds(slow)).toEqual([1]);
      expect(kinds(h.viewer)).toEqual([1, 3]);
    });

    it("粗い全画面を送るときに詰まっていた視聴者は、空いたら鮮明な全画面から受け取る", async () => {
      const h = await settled();
      const slow = h.join();
      await vi.advanceTimersByTimeAsync(1000);
      slow.frames.length = 0;
      h.pipeline.monitorFrame(monitor([], BLACK), null);
      await flush();
      slow.ready = false;
      h.pipeline.monitorFrame(monitor(), null);
      await flush();
      expect(kinds(h.viewer)).toEqual([1, 2]);
      expect(kinds(slow)).toEqual([1]);
      slow.ready = true;
      await vi.advanceTimersByTimeAsync(50);
      expect(kinds(slow)).toEqual([1, 1]);
      expect(kinds(h.viewer)).toEqual([1, 2]);
    });
  });

  describe("取り直しの失敗", () => {
    it("失敗が続くあいだは、何が来ても間隔を倍に広げてしか試さず、記録も間引く", async () => {
      const h = await settled();
      const warned = vi.mocked(console.warn);
      warned.mockClear();
      h.setFailing(true);
      const startedAt = Date.now();
      const at: number[] = [];
      for (let t = 0; t < 8000; t += 10) {
        const before = h.captures.length;
        h.pipeline.monitorFrame(
          monitor(t % 20 === 0 ? [dot(10, 10)] : []),
          null
        );
        if (t % 100 === 0) h.pipeline.requestFull(h.viewer);
        await vi.advanceTimersByTimeAsync(10);
        for (let i = before; i < h.captures.length; i++) {
          at.push(Date.now() - startedAt);
        }
      }
      // 10ms刻みで見ている。最初の1回は監視フレームと同時で、あとは待ちが明けたとき
      expect(at).toEqual([10, 50, 150, 350, 750, 1550, 3150, 5150, 7150]);
      expect(h.viewer.frames).toEqual([]);
      // 1秒に1行まで。間引いた数を次の行に載せる
      const lines = warned.mock.calls.map(([line]) => String(line));
      expect(lines.length).toBeLessThanOrEqual(8);
      expect(lines[0]).toContain("取り直しに失敗");
      expect(lines[1]).toContain("4件");
    });

    it("成功したら、待ちを最初の長さへ戻す", async () => {
      const h = await settled();
      h.setFailing(true);
      h.pipeline.monitorFrame(monitor([dot(10, 10)]), null);
      await vi.advanceTimersByTimeAsync(349);
      expect(h.captures).toHaveLength(3);
      h.setFailing(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.captures).toHaveLength(4);
      expect(h.viewer.frames).toHaveLength(1);
      h.setFailing(true);
      h.pipeline.monitorFrame(monitor(), null);
      await flush();
      expect(h.captures).toHaveLength(5);
      await vi.advanceTimersByTimeAsync(49);
      expect(h.captures).toHaveLength(5);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.captures).toHaveLength(6);
    });

    it("失敗のあとに止めたら、タイマーを残さない", async () => {
      const h = await settled();
      h.setFailing(true);
      h.pipeline.monitorFrame(monitor([dot(10, 10)]), null);
      await flush();
      expect(vi.getTimerCount()).toBe(1);
      h.pipeline.stop();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("1人への送り直しの失敗では、揃っている視聴者へ全画面を送らない", async () => {
      const h = await settled({ hold: true });
      const late = h.join();
      await flush();
      expect(h.captures).toHaveLength(1);
      h.captures[0].reject();
      await flush();
      h.setHold(false);
      await vi.advanceTimersByTimeAsync(50);
      expect(h.captures).toHaveLength(2);
      expect(late.frames.map(f => parse(f).kind)).toEqual([1]);
      expect(h.viewer.frames).toEqual([]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.captures).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("矩形の形式", () => {
    /** 監視フレームをビューポートと同じ寸法にして、矩形の面積を1画素の単位で決める */
    async function exact(w: number, h: number) {
      const s = harness();
      s.pipeline.setApplied(VIEWPORT);
      const viewer = s.join();
      const blank = buildSolidPng(800, 600, WHITE);
      s.pipeline.monitorFrame(blank, null);
      await vi.advanceTimersByTimeAsync(1000);
      s.captures.length = 0;
      viewer.frames.length = 0;
      // 上下左右に1画素ずつ広がる
      s.pipeline.monitorFrame(
        buildSolidPng(800, 600, WHITE, block(10, 10, w - 2, h - 2)),
        null
      );
      await flush();
      return s.captures.map(c => c.params);
    }

    it("小さい矩形もJPEGで取り直す", async () => {
      expect(await exact(600, 200)).toMatchObject([
        { format: "jpeg", clip: { x: 9, y: 9, width: 600, height: 200 } },
      ]);
    });
  });
});
