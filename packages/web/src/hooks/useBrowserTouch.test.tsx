// @vitest-environment jsdom

import type { BrowserClientMessage } from "@ark/shared";
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Size } from "@/lib/browser-geometry";
import type { TouchLike } from "@/lib/browser-touch";
import {
  type BrowserTouch,
  TOUCH_MOUSE_GUARD_MS,
  TOUCH_MOUSE_GUARD_PX,
  useBrowserTouch,
} from "./useBrowserTouch";

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface TouchInit {
  identifier: number;
  clientX: number;
  clientY: number;
}

const AREA: Rect = { left: 10, top: 20, width: 800, height: 600 };

let root: Root;
let container: HTMLDivElement;
/** canvasの矩形。領域と違えば、余白がある */
let canvasRect: Rect = AREA;
let viewport: Size | null = { width: 800, height: 600 };
let accepted = true;
let blocked = false;
let swallowed: Event | null = null;
let api: BrowserTouch;
let now = 1000;
let frameRequests = new Map<number, () => void>();
let nextFrameId = 1;
const send = vi.fn<(msg: BrowserClientMessage) => void>();
const onStart = vi.fn<(touch: TouchLike, area: DOMRect) => void>();

function Harness() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<Size | null>(null);
  api = useBrowserTouch({
    containerRef,
    canvasRef,
    viewportRef,
    send,
    accepts: () => accepted,
    isBlocked: () => blocked,
    isSwallowed: event => event === swallowed,
    onStart,
  });
  return (
    <div
      ref={element => {
        containerRef.current = element;
        viewportRef.current = viewport;
      }}
      data-area
    >
      <canvas ref={canvasRef} />
    </div>
  );
}

function area(): HTMLElement {
  return container.querySelector("[data-area]") as HTMLElement;
}

/** jsdomは `Touch` を作れないので、要る値だけを持つイベントを作る */
function touch(
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  touches: TouchInit[],
  changedTouches: TouchInit[] = touches
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: touches },
    changedTouches: { value: changedTouches },
  });
  return event;
}

function fire(...events: Event[]) {
  act(() => {
    for (const event of events) area().dispatchEvent(event);
  });
}

function runFrame() {
  const pending = [...frameRequests.values()];
  frameRequests.clear();
  for (const run of pending) run();
}

function mouse(
  clientX: number,
  clientY: number,
  firesTouchEvents?: boolean | null
): MouseEvent {
  const event = new MouseEvent("mousedown", { clientX, clientY });
  if (firesTouchEvents !== undefined) {
    Object.defineProperty(event, "sourceCapabilities", {
      value: firesTouchEvents === null ? null : { firesTouchEvents },
    });
  }
  return event;
}

function sent() {
  return send.mock.calls.map(([msg]) => msg);
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  canvasRect = AREA;
  viewport = { width: 800, height: 600 };
  accepted = true;
  blocked = false;
  swallowed = null;
  now = 1000;
  frameRequests = new Map();
  nextFrameId = 1;
  send.mockReset();
  onStart.mockReset();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => {
    const id = nextFrameId++;
    frameRequests.set(id, run);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frameRequests.delete(id);
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return (this instanceof HTMLCanvasElement ? canvasRect : AREA) as DOMRect;
    }
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useBrowserTouch", () => {
  it("`touchstart` は既定の動作を止め、呼ぶ側に知らせてから、ビューポートの座標と小さい番号で送る", () => {
    const finger = { identifier: -1234567, clientX: 110, clientY: 70 };
    const start = touch("touchstart", [finger]);
    onStart.mockImplementation(() => {
      expect(send).not.toHaveBeenCalled();
    });
    fire(start);

    expect(start.defaultPrevented).toBe(true);
    expect(onStart).toHaveBeenCalledWith(finger, AREA);
    expect(sent()).toEqual([
      {
        t: "touch",
        type: "start",
        points: [{ id: 0, x: 100, y: 50 }],
        modifiers: 0,
      },
    ]);
  });

  it("余白を置いて収めているときは、canvasの矩形とビューポートの寸法で換算する", () => {
    // 800x600の領域に1600x600のビューポート。canvasは上下に150の余白を置いた800x300
    canvasRect = { left: 10, top: 170, width: 800, height: 300 };
    viewport = { width: 1600, height: 600 };
    act(() => root.render(<Harness />));
    fire(touch("touchstart", [{ identifier: 1, clientX: 110, clientY: 320 }]));

    expect(sent()).toMatchObject([
      { type: "start", points: [{ id: 0, x: 200, y: 300 }] },
    ]);
  });

  it("余白で始まった指は送らない。既定の動作は止める", () => {
    canvasRect = { left: 10, top: 170, width: 800, height: 300 };
    viewport = { width: 1600, height: 600 };
    act(() => root.render(<Harness />));
    const margin = { identifier: 1, clientX: 110, clientY: 500 };
    const inside = { identifier: 2, clientX: 110, clientY: 320 };
    const start = touch("touchstart", [margin]);
    fire(start, touch("touchmove", [margin]));
    act(() => runFrame());
    expect(start.defaultPrevented).toBe(true);
    expect(onStart).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    // 続けてcanvasに触れた指だけを載せる
    fire(
      touch("touchstart", [margin, inside], [inside]),
      touch("touchend", [inside], [margin])
    );
    expect(sent()).toMatchObject([
      { type: "start", points: [{ id: 0, x: 200, y: 300 }] },
    ]);
  });

  it("`touchmove` は1フレームに最新の1回だけ送り、`touchend` の前に送り切る", () => {
    fire(touch("touchstart", [{ identifier: 9, clientX: 110, clientY: 70 }]));
    send.mockClear();

    const move = touch("touchmove", [
      { identifier: 9, clientX: 120, clientY: 80 },
    ]);
    fire(
      move,
      touch("touchmove", [{ identifier: 9, clientX: 130, clientY: 90 }])
    );
    expect(move.defaultPrevented).toBe(true);
    expect(send).not.toHaveBeenCalled();
    act(() => runFrame());
    expect(sent()).toMatchObject([
      { type: "move", points: [{ id: 0, x: 120, y: 70 }] },
    ]);
    send.mockClear();

    const end = touch(
      "touchend",
      [],
      [{ identifier: 9, clientX: 140, clientY: 100 }]
    );
    fire(
      touch("touchmove", [{ identifier: 9, clientX: 140, clientY: 100 }]),
      end
    );
    act(() => runFrame());

    expect(end.defaultPrevented).toBe(true);
    expect(sent()).toEqual([
      {
        t: "touch",
        type: "move",
        points: [{ id: 0, x: 130, y: 80 }],
        modifiers: 0,
      },
      { t: "touch", type: "end", points: [], modifiers: 0 },
    ]);
  });

  it("指ごとに同じ番号を使い続け、`end` と `cancel` には残っている指を載せる", () => {
    const a = { identifier: 1001, clientX: 110, clientY: 70 };
    const b = { identifier: 1002, clientX: 210, clientY: 170 };
    const c = { identifier: 1003, clientX: 310, clientY: 270 };
    fire(
      touch("touchstart", [a]),
      touch("touchstart", [a, b], [b]),
      touch("touchend", [b], [a]),
      // 空いた番号は、次の指が使う
      touch("touchstart", [b, c], [c]),
      touch("touchcancel", [c], [b])
    );

    expect(sent().map(m => (m.t === "touch" ? [m.type, m.points] : m))).toEqual(
      [
        ["start", [{ id: 0, x: 100, y: 50 }]],
        [
          "start",
          [
            { id: 0, x: 100, y: 50 },
            { id: 1, x: 200, y: 150 },
          ],
        ],
        ["end", [{ id: 1, x: 200, y: 150 }]],
        [
          "start",
          [
            { id: 1, x: 200, y: 150 },
            { id: 0, x: 300, y: 250 },
          ],
        ],
        ["cancel", [{ id: 0, x: 300, y: 250 }]],
      ]
    );
  });

  it("11本目からの指は送らない", () => {
    const fingers = Array.from({ length: 11 }, (_, i) => ({
      identifier: 500 + i,
      clientX: 20 + i * 10,
      clientY: 30,
    }));
    fire(touch("touchstart", fingers));
    const [start] = sent();

    expect(start.t === "touch" && start.points.map(p => p.id)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  it("ビューポートの寸法を知らない間は、送らない", () => {
    viewport = null;
    act(() => root.render(<Harness />));
    const finger = { identifier: 3, clientX: 110, clientY: 70 };
    fire(touch("touchstart", [finger]), touch("touchend", [], [finger]));

    expect(onStart).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("受けないタッチには、既定の動作も含めて手を出さない", () => {
    accepted = false;
    const finger = { identifier: 3, clientX: 110, clientY: 70 };
    const events = [
      touch("touchstart", [finger]),
      touch("touchmove", [finger]),
      touch("touchend", [], [finger]),
    ];
    fire(...events);

    expect(events.map(event => event.defaultPrevented)).toEqual([
      false,
      false,
      false,
    ]);
    expect(send).not.toHaveBeenCalled();
  });

  it("送らない間 (ダイアログが出ている) のタッチは、既定の動作だけを止める", () => {
    blocked = true;
    const finger = { identifier: 3, clientX: 110, clientY: 70 };
    const events = [
      touch("touchstart", [finger]),
      touch("touchmove", [finger]),
      touch("touchend", [], [finger]),
    ];
    fire(...events);
    act(() => runFrame());

    // Arkの画面をスクロールさせない
    expect(events.map(event => event.defaultPrevented)).toEqual([
      true,
      true,
      true,
    ]);
    expect(onStart).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("使い終わった押下 (選択リストを閉じた) は、送らない", () => {
    const finger = { identifier: 3, clientX: 110, clientY: 70 };
    const start = touch("touchstart", [finger]);
    swallowed = start;
    fire(start, touch("touchend", [], [finger]));

    expect(start.defaultPrevented).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("`releaseTouches` は触れたままの指をリモートで離し、`dropTouches` は何も送らずに忘れる", () => {
    const finger = { identifier: 3, clientX: 110, clientY: 70 };
    act(() => api.releaseTouches());
    expect(send).not.toHaveBeenCalled();

    fire(touch("touchstart", [finger]), touch("touchmove", [finger]));
    send.mockClear();
    act(() => api.releaseTouches());
    // 間引きで持っていたmoveは捨てる。そのあとに届いた分は、もう送らない
    act(() => runFrame());
    fire(touch("touchend", [], [finger]));
    expect(sent()).toEqual([
      { t: "touch", type: "cancel", points: [], modifiers: 0 },
    ]);
    send.mockClear();

    fire(touch("touchstart", [finger]));
    send.mockClear();
    act(() => api.dropTouches());
    fire(touch("touchend", [], [finger]));
    expect(send).not.toHaveBeenCalled();
  });

  describe("isTouchMouse", () => {
    const finger = { identifier: 3, clientX: 110, clientY: 70 };

    function tap() {
      fire(touch("touchstart", [finger]), touch("touchend", [], [finger]));
    }

    it("タッチが無ければ、マウスのイベントは本物", () => {
      expect(api.isTouchMouse(mouse(110, 70))).toBe(false);
    });

    it("出どころが分かるなら (`sourceCapabilities`)、それだけで決める", () => {
      tap();
      // 合成されたものは、遅れても、離れていても、合成
      now += TOUCH_MOUSE_GUARD_MS * 10;
      expect(api.isTouchMouse(mouse(500, 400, true))).toBe(true);
      // 本物のマウスは、指を離した直後の同じ位置でも、本物
      tap();
      expect(api.isTouchMouse(mouse(110, 70, false))).toBe(false);
    });

    it("出どころが分からなければ、指を離した直後に、離した位置の近くへ届いたものだけを合成とみなす", () => {
      tap();
      now += TOUCH_MOUSE_GUARD_MS;
      expect(api.isTouchMouse(mouse(110, 70))).toBe(true);
      expect(api.isTouchMouse(mouse(110 + TOUCH_MOUSE_GUARD_PX, 70))).toBe(
        true
      );
      // `sourceCapabilities` が `null` のとき (出どころを教えないイベント) も同じ
      expect(api.isTouchMouse(mouse(110, 70, null))).toBe(true);
      // 離れた位置の本物のマウスは落とさない
      expect(api.isTouchMouse(mouse(110 + TOUCH_MOUSE_GUARD_PX + 1, 70))).toBe(
        false
      );
      expect(api.isTouchMouse(mouse(310, 270))).toBe(false);

      now += 1;
      expect(api.isTouchMouse(mouse(110, 70))).toBe(false);
    });

    it("`touchcancel` で離した位置も、同じように見る", () => {
      fire(touch("touchstart", [finger]), touch("touchcancel", [], [finger]));
      expect(api.isTouchMouse(mouse(110, 70))).toBe(true);
    });
  });
});
