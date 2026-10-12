/**
 * ブラウザ機能のタッチ。canvasを置く領域で受けたタッチを、リモートのページへ送る。
 *
 * Reactのタッチのハンドラはpassiveで、既定の動作を止められないので、領域に自分で
 * リスナーを付ける (passiveでない)。既定の動作を止めるのは、ペインのスクロールと、
 * ブラウザが合成するマウスのイベントを止めるため。
 *
 * 手を出すのは、呼ぶ側が受けると言った相手 (`accepts`) へのタッチだけ。重ねて出した
 * 部品 (ダイアログの枠、選択リスト) と、接続中や切断の表示の上のタッチには触れない
 * (ボタンを指で押せて、中をスクロールできるようにする)。受けたタッチは、送らないとき
 * (`isBlocked`: ダイアログか選択リストが出ている) も、既定の動作は止める。ダイアログの
 * まわりの暗い部分は領域の一部なので、そこに触れてもArkの画面はスクロールしない。
 *
 * 点の番号は `browser-touch.ts` で小さい整数に付け直す。余白 (縦横比を保つために空けた
 * 部分) で始まった指と、上限を超えた指は送らない。`touchmove` は1フレームに1回へ間引き、
 * `touchend` と `touchcancel` の前に送り切る (順序が入れ替わると、離した位置がずれる)。
 *
 * タッチから合成されたマウスのイベントは、送ると1回の押下がリモートに2回届くので、
 * 見分けて捨てる (`isTouchMouse`)。タッチのあと一定の時間のマウスを全部捨てることは
 * しない。タッチとマウスの両方を持つ機械で、本物のマウスの操作まで落ちる。
 * - ブラウザがイベントの出どころを教えるなら (`sourceCapabilities`。Chromium)、それだけで
 *   決める
 * - 教えないなら (Firefox、Safari)、指を離した直後 (`TOUCH_MOUSE_GUARD_MS`) に、離した
 *   位置のすぐ近く (`TOUCH_MOUSE_GUARD_PX`) へ届いたものだけを、合成とみなす
 */

import type { BrowserClientMessage } from "@ark/shared";
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import {
  containsPoint,
  type Size,
  screenToViewport,
} from "@/lib/browser-geometry";
import { modifiersOf } from "@/lib/browser-input";
import { TouchIdMap, type TouchLike, touchPoints } from "@/lib/browser-touch";

/** 指を離してから、この時間 (ミリ秒) までのマウスのイベントを、合成かどうか疑う */
export const TOUCH_MOUSE_GUARD_MS = 400;
/** 離した位置からこの距離 (CSSピクセル) までのマウスのイベントを、合成とみなす */
export const TOUCH_MOUSE_GUARD_PX = 10;

type BrowserTouchMessage = Extract<BrowserClientMessage, { t: "touch" }>;

interface TouchEnd {
  at: number;
  x: number;
  y: number;
}

export interface UseBrowserTouchOptions {
  /** canvasを置く領域。ここにリスナーを付ける */
  containerRef: RefObject<HTMLElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** サーバーが最後に知らせたビューポートの寸法。知らなければ `null` */
  viewportRef: RefObject<Size | null>;
  send: (msg: BrowserClientMessage) => void;
  /** このタッチを受けるか。受けないタッチには、既定の動作も含めて手を出さない */
  accepts: (target: EventTarget | null) => boolean;
  /** 受けたタッチを、リモートへ送らずに捨てるか */
  isBlocked: () => boolean;
  /** 別の用で使い終わったイベントか (選択リストを閉じた押下)。リモートへ送らない */
  isSwallowed: (event: Event) => boolean;
  /**
   * canvasの上で指が触れた。`start` を送る前に呼ぶ。`touch` は最初の指、`area` は領域の
   * 矩形
   */
  onStart: (touch: TouchLike, area: DOMRect) => void;
}

export interface BrowserTouch {
  /** タッチから合成されたマウスのイベントなら `true` */
  isTouchMouse: (event: MouseEvent) => boolean;
  /** 触れたままの指を、リモートで離す (フォーカスが外れたとき) */
  releaseTouches: () => void;
  /** 触れたままの指を、何も送らずに忘れる (送り先が無くなったとき) */
  dropTouches: () => void;
}

export function useBrowserTouch(options: UseBrowserTouchOptions): BrowserTouch {
  const { containerRef, canvasRef, viewportRef } = options;
  // リスナーを付け直さずに、いまの関数を呼ぶ
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  });
  // 触れている指に割り当てた番号と、間引きで送らずに持っている最新のmove
  const idsRef = useRef<TouchIdMap | null>(null);
  const pendingRef = useRef<BrowserTouchMessage | null>(null);
  const frameRef = useRef<number | null>(null);
  // 最後に離した指 (合成されたマウスのイベントを見分けるため)
  const lastEndsRef = useRef<TouchEnd[]>([]);

  const ids = useCallback((): TouchIdMap => {
    idsRef.current ??= new TouchIdMap();
    return idsRef.current;
  }, []);

  /** 持っているmoveを取り出す。送るかどうかは呼ぶ側が決める */
  const takeMove = useCallback((): BrowserTouchMessage | null => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    return pending;
  }, []);

  const dropTouches = useCallback(() => {
    takeMove();
    ids().clear();
  }, [takeMove, ids]);

  const releaseTouches = useCallback(() => {
    if (ids().size === 0) return;
    // このあとに届くmoveとendは、番号が無いので送られない
    dropTouches();
    optionsRef.current.send({
      t: "touch",
      type: "cancel",
      points: [],
      modifiers: 0,
    });
  }, [dropTouches, ids]);

  const isTouchMouse = useCallback((event: MouseEvent): boolean => {
    const source = (
      event as MouseEvent & {
        sourceCapabilities?: { firesTouchEvents?: boolean } | null;
      }
    ).sourceCapabilities;
    if (source) return source.firesTouchEvents === true;
    const now = performance.now();
    return lastEndsRef.current.some(
      end =>
        now - end.at <= TOUCH_MOUSE_GUARD_MS &&
        Math.hypot(event.clientX - end.x, event.clientY - end.y) <=
          TOUCH_MOUSE_GUARD_PX
    );
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const touchIds = ids();

    const message = (
      type: BrowserTouchMessage["type"],
      e: TouchEvent
    ): BrowserTouchMessage => {
      const rect = canvasRef.current?.getBoundingClientRect();
      const toPoint = (touch: TouchLike) =>
        rect
          ? screenToViewport(
              { x: touch.clientX - rect.left, y: touch.clientY - rect.top },
              rect,
              viewportRef.current
            )
          : null;
      return {
        t: "touch",
        type,
        points: touchPoints(e.touches, touchIds, toPoint),
        modifiers: modifiersOf(e),
      };
    };

    const flushMove = () => {
      const pending = takeMove();
      if (pending) optionsRef.current.send(pending);
    };

    const onStart = (e: TouchEvent) => {
      const current = optionsRef.current;
      if (!current.accepts(e.target)) return;
      e.preventDefault();
      if (current.isBlocked() || current.isSwallowed(e)) return;
      const canvas = canvasRef.current?.getBoundingClientRect();
      if (!canvas || !viewportRef.current) return;
      // 余白で始まった指と、上限を超えた指には、番号を割り当てない
      let first: TouchLike | null = null;
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        if (!containsPoint(canvas, touch.clientX, touch.clientY)) continue;
        if (touchIds.assign(touch.identifier) !== null) first ??= touch;
      }
      if (!first) return;
      current.onStart(first, container.getBoundingClientRect());
      flushMove();
      current.send(message("start", e));
    };

    const onMove = (e: TouchEvent) => {
      if (!optionsRef.current.accepts(e.target)) return;
      e.preventDefault();
      if (touchIds.size === 0) return;
      pendingRef.current = message("move", e);
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        flushMove();
      });
    };

    const onEnd = (type: "end" | "cancel") => (e: TouchEvent) => {
      if (!optionsRef.current.accepts(e.target)) return;
      if (e.cancelable) e.preventDefault();
      const at = performance.now();
      const ends: TouchEnd[] = [];
      let released = false;
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        ends.push({ at, x: touch.clientX, y: touch.clientY });
        if (touchIds.release(touch.identifier)) released = true;
      }
      lastEndsRef.current = ends;
      if (!released) return;
      // 持っているmoveを先に送る
      flushMove();
      optionsRef.current.send(message(type, e));
    };
    const onTouchEnd = onEnd("end");
    const onTouchCancel = onEnd("cancel");

    const listenerOptions = { passive: false };
    container.addEventListener("touchstart", onStart, listenerOptions);
    container.addEventListener("touchmove", onMove, listenerOptions);
    container.addEventListener("touchend", onTouchEnd, listenerOptions);
    container.addEventListener("touchcancel", onTouchCancel, listenerOptions);
    return () => {
      container.removeEventListener("touchstart", onStart);
      container.removeEventListener("touchmove", onMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [containerRef, canvasRef, viewportRef, takeMove, ids]);

  return { isTouchMouse, releaseTouches, dropTouches };
}
