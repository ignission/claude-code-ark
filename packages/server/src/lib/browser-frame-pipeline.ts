/**
 * ブラウザ機能の映像の経路。監視フレームから「どこが変わったか」を知り、
 * 変わったところだけを取り直して視聴者へ送る。
 *
 * - 監視と取り直しを分ける。全画面を毎回送ると、1文字の入力でも全画面ぶんの画像が
 *   流れる。そこで、screencastは縮小したPNGにして視聴者へは送らず、前の1枚との差で
 *   変わった矩形だけを知る (browser-frame-diff.ts)。視聴者へ送る画は、その矩形を
 *   `Page.captureScreenshot` で実寸で取り直したもの
 * - 取り直しは同時に1本。1回にかかる時間は矩形の大きさによらずほぼ一定なので、
 *   並べても速くならず、古い結果が新しい結果のあとに届く順序の逆転だけが増える。
 *   取り直しの間に来た変化は「汚れ」として溜め、終わってから続けて取る
 * - 汚れは矩形の集まりか「全面」。矩形が増えすぎるか、面積が大きくなったら全面にする
 *   (細かく取り直すより、1枚で取るほうが速い)
 * - 全面の変化が続いている間 (スクロールなど) は「動いている」とみなし、縮尺と画質を
 *   落とした粗い全画面を、間隔を空けて送る。監視フレームが来なくなって静かになったら、
 *   鮮明な全画面を1枚送って仕上げる。粗い画の上に矩形を重ねても鮮明にはならないので、
 *   仕上げは矩形を送ったあとでも行う
 * - 視聴者ごとに「いまの画面と揃っているか」を持つ。揃っていない視聴者には、鮮明な
 *   全画面が届くまで矩形も粗い全画面も送らない (古い画の上に矩形だけが重なるのを防ぐ)。
 *   揃っていないとみなすのは、参加したとき、ビューポートが変わったとき (全員)、
 *   送信バッファが詰まっていてフレームを1つでも飛ばされたとき、視聴者が送り直しを
 *   頼んだとき。そういう視聴者が受け取れるようになったら、鮮明な全画面を取り直して
 *   その視聴者にだけ送る。ほかの視聴者にも同じ全画面を送るところだった場合に限り、
 *   1回の取り直しで全員へ送る
 * - 「動いている」の判定と仕上げは、揃っている視聴者の全員へ送った全画面で数える。
 *   1人のための送り直しで、ほかの視聴者の画が粗くなったり、粗いまま残ったりしない
 * - ビューポートの寸法が変わるたびに世代を進め、フレームのヘッダに載せる。視聴者は
 *   世代の違うフレームを捨てる。寸法は監視フレームのメタデータから取り、無ければ
 *   最後にページへ当てた寸法を使う
 * - 取り直しの失敗 (ページの遷移中に起きる) と時間切れは、汚れを全面に戻して続ける。
 *   すぐには試し直さない。失敗が続くページで取り直しを繰り返さないため
 * - 最初の監視フレームが届くまでは取り直さない。screencastは始めるとすぐ1枚出すので、
 *   それを合図にすれば、始めた直後に全画面を二度取らずに済む
 *
 * 視聴者とCDPには触らない。視聴者の一覧、送信、取り直しの呼び出しは `FrameSink` で受け取る。
 */

import {
  type CssRect,
  coverage,
  decodePng,
  diffImages,
  MAX_RECTS,
  type MonitorImage,
  toCssRect,
} from "./browser-frame-diff.js";

/** 監視フレームの縮小率 */
export const MONITOR_DIVISOR = 8;
/** 変わった面積の割合がこれを超えたら、矩形ではなく全画面で送る */
export const FULL_COVERAGE = 0.4;
/** 前の全画面からこの時間以内に次の全画面が要るなら「動いている」 (ミリ秒) */
export const MOTION_WINDOW_MS = 250;
/** 監視がこの時間静かなら、鮮明な全画面を送る (ミリ秒) */
export const SETTLE_MS = 250;
/** 粗い全画面を送る最短の間隔 (ミリ秒) */
export const COARSE_MIN_INTERVAL_MS = 100;
/** 粗い全画面の、CSSピクセルに対する縮尺 */
export const COARSE_SCALE = 0.5;
/** 粗い全画面のJPEGの画質 */
export const COARSE_QUALITY = 50;
/** 鮮明な全画面と矩形の画質 */
export const SHARP_QUALITY = 80;
/** CSSピクセルの面積がこれ以下の矩形はWebP (小さく、この大きさなら遅くない)。超えたらJPEG */
export const WEBP_MAX_AREA = 120_000;
/** 取り直しが返らないときに諦める時間 (ミリ秒) */
export const CAPTURE_TIMEOUT_MS = 3000;
/** 送れる視聴者がいないときと、取り直しに失敗したときに、見直す間隔 (ミリ秒) */
export const RETRY_MS = 50;

/** フレームのヘッダの長さ (バイト) */
export const FRAME_HEADER_BYTES = 11;
/** フレームの種類。ヘッダの先頭の1バイト */
export const FRAME_SHARP = 1;
export const FRAME_COARSE = 2;
export const FRAME_RECT = 3;
export type FrameKind =
  | typeof FRAME_SHARP
  | typeof FRAME_COARSE
  | typeof FRAME_RECT;

const U16_MAX = 0xffff;

interface Size {
  width: number;
  height: number;
}

/** ページへ当てたビューポート。`dpr` はページへ伝えた倍率 */
export interface AppliedViewport extends Size {
  dpr: number;
}

/** フレームが描かれるビューポートの寸法 (CSSピクセル) と世代 */
export interface FrameViewport extends Size {
  gen: number;
}

/** パイプラインが外へ頼むこと。`V` は視聴者 */
export interface FrameSink<V> {
  viewers(): Iterable<V>;
  /** いま送ってよいか (つながっていて、送信バッファが詰まっていない) */
  canReceive(viewer: V): boolean;
  /** フレームを1つ送る。投げない (送れなかった視聴者は、受け取った側が外す) */
  deliver(viewer: V, frame: Buffer): void;
  /** `Page.captureScreenshot` を呼ぶ。応答は `{ data: base64 }` */
  capture(params: object): Promise<unknown>;
}

/**
 * バイナリのフレームの先頭に付けるヘッダ。数値はbig-endian。
 * 0: 種類、1-2: 世代、3-4: x、5-6: y、7-8: 幅、9-10: 高さ (CSSピクセル)。
 */
export function encodeFrameHeader(
  kind: FrameKind,
  gen: number,
  rect: CssRect
): Buffer {
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header[0] = kind;
  header.writeUInt16BE(gen & U16_MAX, 1);
  header.writeUInt16BE(toU16(rect.x), 3);
  header.writeUInt16BE(toU16(rect.y), 5);
  header.writeUInt16BE(toU16(rect.width), 7);
  header.writeUInt16BE(toU16(rect.height), 9);
  return header;
}

function toU16(value: number): number {
  return Math.min(U16_MAX, Math.max(0, Math.round(value)));
}

/** 監視フレームにするための `Page.startScreencast` の引数 */
export function monitorParams(viewport: Size): object {
  return {
    format: "png",
    maxWidth: Math.ceil(viewport.width / MONITOR_DIVISOR),
    maxHeight: Math.ceil(viewport.height / MONITOR_DIVISOR),
    everyNthFrame: 1,
  };
}

function captureParams(
  format: "jpeg" | "webp",
  quality: number,
  rect: CssRect,
  scale: number
): object {
  return {
    format,
    quality,
    clip: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      scale,
    },
    captureBeyondViewport: false,
    optimizeForSpeed: true,
  };
}

function touches(a: CssRect, b: CssRect): boolean {
  return (
    a.x <= b.x + b.width &&
    b.x <= a.x + a.width &&
    a.y <= b.y + b.height &&
    b.y <= a.y + a.height
  );
}

function union(a: CssRect, b: CssRect): CssRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/** 重なるか接している矩形を、まとめられなくなるまで1つにする */
function mergeRects(input: CssRect[]): CssRect[] {
  const rects = input.slice();
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < rects.length && !merged; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        if (touches(rects[i], rects[j])) {
          rects[i] = union(rects[i], rects[j]);
          rects.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }
  return rects;
}

/** 取り直しの応答から画像を取り出す。形が違えば `null` */
function imageOf(result: unknown): Buffer | null {
  if (typeof result !== "object" || result === null) return null;
  const { data } = result as { data?: unknown };
  if (typeof data !== "string" || data.length === 0) return null;
  return Buffer.from(data, "base64");
}

function warn(what: string, error?: unknown): void {
  if (error === undefined) {
    console.warn(`[BrowserBridge] ${what}`);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[BrowserBridge] ${what}: ${message}`);
}

/** まだ取り直していない変化。矩形の集まり (空なら変化なし) か全面 */
type Dirty = CssRect[] | "full";

export class BrowserFramePipeline<V extends object> {
  private applied: AppliedViewport | null = null;
  /** フレームが描かれるビューポートの寸法。寸法が当たっていない間は `null` */
  private size: Size | null = null;
  private gen = 0;
  /**
   * 画面が切り替わるたびに進める (寸法か倍率の変更、停止)。
   * 進む前に始めた取り直しの結果は、いまの画面のものではないので送らない
   */
  private scene = 0;
  /** いまのscreencastの監視フレームを1枚でも受け取ったか */
  private watching = false;
  private previous: MonitorImage | null = null;
  private dirty: Dirty = [];
  /** いまの画面と揃っている視聴者。ここに居ない視聴者には、鮮明な全画面から送る */
  private inSync = new WeakSet<V>();
  /** 走っている取り直しの印。`null` なら走っていない。止めたあとの古い取り直しを見分ける */
  private job: object | null = null;
  /** 待っている取り直しを、結果なしで終わらせる */
  private cancelCapture: (() => void) | null = null;
  /** 揃っている視聴者の全員へ、最後に全画面を送った時刻 */
  private lastFullAt: number | null = null;
  private lastCoarseAt: number | null = null;
  /** 揃っている視聴者が見ているのが粗い画か。鮮明な全画面を送るまで続く */
  private coarseShown = false;
  /** 静かになったので、動いているかによらず鮮明な全画面を送る */
  private sharpDue = false;
  /** 送れる視聴者と粗い全画面の間隔を待って、見直すタイマー */
  private wakeTimer: NodeJS.Timeout | null = null;
  private settleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly sink: FrameSink<V>) {}

  /** フレームが描かれるビューポートの寸法と世代。寸法が当たっていない間は `null` */
  get viewport(): FrameViewport | null {
    return this.size && { ...this.size, gen: this.gen };
  }

  /**
   * ページへ当てた寸法を伝える。`null` はページが無くなったとき。
   * 画面が切り替わるので、監視をやり直し、全員を揃っていない扱いにする。
   */
  setApplied(viewport: AppliedViewport | null): void {
    this.applied = viewport && {
      width: viewport.width,
      height: viewport.height,
      dpr: viewport.dpr,
    };
    this.stop();
    this.inSync = new WeakSet();
  }

  /**
   * screencastを止めたとき。監視の状態、汚れ、タイマーを捨てる。
   * 走っている取り直しの結果は送らない。
   */
  stop(): void {
    this.scene++;
    this.watching = false;
    this.previous = null;
    this.dirty = [];
    this.job = null;
    this.lastFullAt = null;
    this.lastCoarseAt = null;
    this.coarseShown = false;
    this.sharpDue = false;
    this.clearWake();
    this.clearSettle();
    this.cancelCapture?.();
    // メタデータから取った寸法は、止めたscreencastのもの
    this.resize(this.applied);
  }

  /** 視聴者に鮮明な全画面を送り直す (参加したとき、視聴者が頼んだとき) */
  requestFull(viewer: V): void {
    this.inSync.delete(viewer);
    this.pump();
  }

  /**
   * 監視フレームを1枚受け取る。`metadataSize` はフレームのメタデータにあった
   * ビューポートの寸法で、読めなければ `null`。
   */
  monitorFrame(png: Buffer, metadataSize: Size | null): void {
    const size = metadataSize ?? this.applied;
    if (!size) return;
    if (this.resize(size)) {
      // 寸法の違う画面どうしは比べられない。取り直しの途中の結果も古い寸法のもの
      this.scene++;
      this.previous = null;
      this.dirty = [];
      this.inSync = new WeakSet();
    }
    const image = decodePng(png);
    const previous = this.previous;
    this.previous = image;
    this.watching = true;
    if (!image || !previous) {
      this.dirty = "full";
    } else {
      const diff = diffImages(previous, image);
      if (diff === "full") this.dirty = "full";
      else this.addDirty(diff.map(rect => toCssRect(rect, image, size)));
    }
    if (this.coarseShown) this.armSettle();
    this.pump();
  }

  /** 寸法が変わったら世代を進める。変わったかを返す */
  private resize(size: Size | null): boolean {
    const current = this.size;
    if (size === null) {
      this.size = null;
      return current !== null;
    }
    if (current?.width === size.width && current.height === size.height) {
      return false;
    }
    this.size = { width: size.width, height: size.height };
    this.gen = (this.gen + 1) & U16_MAX;
    return true;
  }

  private addDirty(rects: CssRect[]): void {
    const size = this.size;
    if (this.dirty === "full" || rects.length === 0 || !size) return;
    const merged = mergeRects([...this.dirty, ...rects]);
    this.dirty =
      merged.length > MAX_RECTS || coverage(merged, size) > FULL_COVERAGE
        ? "full"
        : merged;
  }

  /**
   * いま取り直せるものがあれば、1つ始める。揃っていない視聴者への全画面が先で、
   * 次が、揃っている視聴者への汚れ。取り直しが終わるたび、変化が来るたびに呼ぶ。
   */
  private pump(): void {
    this.clearWake();
    const size = this.size;
    if (!this.watching || this.job || !size) return;

    const viewers = [...this.sink.viewers()];
    const synced = viewers.filter(viewer => this.inSync.has(viewer));
    const behind = viewers.length - synced.length;
    const ready = (viewer: V) => this.sink.canReceive(viewer);
    const now = Date.now();
    const sharp =
      this.sharpDue ||
      this.lastFullAt === null ||
      now - this.lastFullAt > MOTION_WINDOW_MS;
    const full: CssRect = { x: 0, y: 0, ...size };
    const dirty = this.dirty;

    if (viewers.some(viewer => !this.inSync.has(viewer) && ready(viewer))) {
      // 揃っている視聴者が居ないか、同じ鮮明な全画面を送るところなら、1回で全員へ送る
      const shared = synced.length === 0 || (dirty === "full" && sharp);
      if (shared) this.takeDirty();
      this.run(job => this.sendFull(job, full, false, shared));
      return;
    }

    const pending = dirty === "full" || dirty.length > 0;
    if (pending && synced.some(ready)) {
      if (dirty !== "full") {
        this.takeDirty();
        this.run(job => this.sendRects(job, dirty));
        return;
      }
      if (sharp) {
        this.takeDirty();
        this.run(job => this.sendFull(job, full, false, true));
        return;
      }
      const wait =
        this.lastCoarseAt === null
          ? 0
          : this.lastCoarseAt + COARSE_MIN_INTERVAL_MS - now;
      if (wait > 0) {
        // 揃っていない視聴者が空くのも待っているなら、そちらの間隔でも見直す
        this.wake(behind > 0 ? Math.min(wait, RETRY_MS) : wait);
        return;
      }
      this.takeDirty();
      this.run(job => this.sendFull(job, full, true, true));
      return;
    }

    // 送る相手が詰まっている。空くのを待つ
    if (behind > 0 || (pending && synced.length > 0)) this.wake(RETRY_MS);
  }

  /** 汚れを取り出したことにする。取り直しを始める直前に呼ぶ */
  private takeDirty(): void {
    this.dirty = [];
    this.sharpDue = false;
  }

  /**
   * 取り直しを1本走らせる。`task` は、送り終えたら `true`、失敗したら `false` を返す。
   * 止められた取り直し (`this.job` が別物) は、終わっても何もしない。
   */
  private run(task: (job: object) => Promise<boolean>): void {
    const job = {};
    this.job = job;
    task(job)
      .catch(error => {
        warn("フレームの送信に失敗", error);
        return false;
      })
      .then(ok => {
        if (this.job !== job) return;
        this.job = null;
        if (ok) {
          this.pump();
          return;
        }
        this.dirty = "full";
        this.wake(RETRY_MS);
      })
      .catch(error => warn("取り直しの後始末に失敗", error));
  }

  /**
   * 全画面を取り直して送る。揃っていない視聴者には鮮明な全画面だけを送り、揃える。
   * `shared` なら揃っている視聴者にも送り、受け取れなかった視聴者を揃っていない扱いにする。
   */
  private async sendFull(
    job: object,
    rect: CssRect,
    coarse: boolean,
    shared: boolean
  ): Promise<boolean> {
    const { scene, gen } = this;
    const dpr = this.applied?.dpr ?? 1;
    const image = await this.capture(
      coarse
        ? captureParams("jpeg", COARSE_QUALITY, rect, COARSE_SCALE / dpr)
        : captureParams("jpeg", SHARP_QUALITY, rect, 1)
    );
    if (this.job !== job || this.scene !== scene) return true;
    if (!image) return false;
    const frame = Buffer.concat([
      encodeFrameHeader(coarse ? FRAME_COARSE : FRAME_SHARP, gen, rect),
      image,
    ]);
    for (const viewer of [...this.sink.viewers()]) {
      const synced = this.inSync.has(viewer);
      if (synced ? !shared : coarse) continue;
      if (!this.sink.canReceive(viewer)) {
        this.inSync.delete(viewer);
        continue;
      }
      this.sink.deliver(viewer, frame);
      this.inSync.add(viewer);
    }
    // 送っている間に最後の視聴者が外れて止められたら、タイマーを残さない
    if (this.job !== job || this.scene !== scene || !shared) return true;
    this.lastFullAt = Date.now();
    if (coarse) {
      this.lastCoarseAt = this.lastFullAt;
      this.coarseShown = true;
      this.armSettle();
    } else {
      this.coarseShown = false;
      this.clearSettle();
    }
    return true;
  }

  /** 矩形を順に取り直し、揃っている視聴者へ順に送る */
  private async sendRects(job: object, rects: CssRect[]): Promise<boolean> {
    const { scene, gen } = this;
    for (const rect of rects) {
      const image = await this.capture(
        captureParams(
          rect.width * rect.height <= WEBP_MAX_AREA ? "webp" : "jpeg",
          SHARP_QUALITY,
          rect,
          1
        )
      );
      if (this.job !== job || this.scene !== scene) return true;
      if (!image) return false;
      const frame = Buffer.concat([
        encodeFrameHeader(FRAME_RECT, gen, rect),
        image,
      ]);
      for (const viewer of [...this.sink.viewers()]) {
        if (!this.inSync.has(viewer)) continue;
        if (this.sink.canReceive(viewer)) this.sink.deliver(viewer, frame);
        else this.inSync.delete(viewer);
      }
      if (this.job !== job || this.scene !== scene) return true;
    }
    return true;
  }

  /**
   * 取り直す。失敗、時間切れ、止められたときは `null` で終わる。rejectしない。
   * 時間切れのあとに返った結果は捨てる。
   */
  private capture(params: object): Promise<Buffer | null> {
    return new Promise(resolve => {
      let done = false;
      const finish = (image: Buffer | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this.cancelCapture === cancel) this.cancelCapture = null;
        resolve(image);
      };
      const cancel = () => finish(null);
      const timer = setTimeout(() => {
        warn("取り直しが返りません");
        finish(null);
      }, CAPTURE_TIMEOUT_MS);
      this.cancelCapture = cancel;
      let pending: Promise<unknown>;
      try {
        pending = this.sink.capture(params);
      } catch (error) {
        warn("取り直しに失敗", error);
        finish(null);
        return;
      }
      pending.then(
        result => finish(imageOf(result)),
        error => {
          // 止めたあと、時間切れのあとの失敗は、もう誰も待っていない
          if (!done) warn("取り直しに失敗", error);
          finish(null);
        }
      );
    });
  }

  private wake(delay: number): void {
    this.clearWake();
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.pump();
    }, delay);
  }

  private clearWake(): void {
    if (!this.wakeTimer) return;
    clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
  }

  private armSettle(): void {
    this.clearSettle();
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.sharpDue = true;
      this.dirty = "full";
      this.pump();
    }, SETTLE_MS);
  }

  private clearSettle(): void {
    if (!this.settleTimer) return;
    clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }
}
