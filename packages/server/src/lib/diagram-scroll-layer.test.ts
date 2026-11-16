import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  DIAGRAM_SCROLL_LAYER_MARKER,
  injectDiagramScrollLayer,
  SCROLL_LAYER,
} from "./diagram-scroll-layer.js";

const minimalDoc =
  "<!doctype html><html><head></head><body><p>本文</p></body></html>";

type Listener = (event: Record<string, unknown>) => void;

/** 層のスクリプト本体を最小の DOM スタブで走らせる */
function loadLayer() {
  const source = SCROLL_LAYER.slice(
    SCROLL_LAYER.indexOf(">") + 1,
    SCROLL_LAYER.lastIndexOf("</script>")
  );
  const windowListeners: Record<string, Listener> = {};
  const portListeners: Listener[] = [];
  const sent: unknown[] = [];
  const scrolledTo: Array<[number, number]> = [];
  const port = {
    postMessage: (message: unknown) => sent.push(message),
    addEventListener: (_type: string, fn: Listener) => portListeners.push(fn),
    start: () => {},
  };
  const win = {
    scrollX: 0,
    scrollY: 0,
    addEventListener: (type: string, fn: Listener) => {
      windowListeners[type] = fn;
    },
    scrollTo: (x: number, y: number) => scrolledTo.push([x, y]),
  };
  runInNewContext(source, { window: win, setTimeout });
  const init = () =>
    windowListeners.message?.({
      data: { type: "ark:diagram-init" },
      ports: [port],
    });
  const scroll = (x: number, y: number) => {
    win.scrollX = x;
    win.scrollY = y;
    windowListeners.scroll?.({});
  };
  const fromParent = (data: unknown) => {
    for (const listener of portListeners) listener({ data });
  };
  return { init, scroll, fromParent, sent, scrolledTo };
}

describe("スクロール位置", () => {
  it("続けて動かしても、まとめて最後の位置を1回だけ親へ送る", () => {
    vi.useFakeTimers();
    try {
      const layer = loadLayer();
      layer.init();
      layer.scroll(0, 10);
      layer.scroll(0, 250);
      expect(layer.sent).toEqual([]);
      vi.advanceTimersByTime(100);
      expect(layer.sent).toEqual([
        { type: "ark:diagram-scroll", x: 0, y: 250 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("親に言われた位置へ戻す。数でない位置は無視する", () => {
    const layer = loadLayer();
    layer.init();
    layer.fromParent({ type: "ark:diagram-restore-scroll", x: 4, y: 320 });
    layer.fromParent({ type: "ark:diagram-restore-scroll", x: "4", y: 1 });
    layer.fromParent({ type: "ark:diagram-select", active: true });
    expect(layer.scrolledTo).toEqual([[4, 320]]);
  });
});

describe("注入", () => {
  it("</body> の直前へ 1 回だけ入れる", () => {
    const once = injectDiagramScrollLayer(minimalDoc);
    expect(once).toContain(`id="${DIAGRAM_SCROLL_LAYER_MARKER}"`);
    expect(once.indexOf(DIAGRAM_SCROLL_LAYER_MARKER)).toBeLessThan(
      once.indexOf("</body>")
    );
    expect(injectDiagramScrollLayer(once)).toBe(once);
  });

  it("本文に marker の語があるだけの板にも入れる", () => {
    const doc = minimalDoc.replace("本文", DIAGRAM_SCROLL_LAYER_MARKER);
    expect(injectDiagramScrollLayer(doc)).toContain(
      `<script id="${DIAGRAM_SCROLL_LAYER_MARKER}"`
    );
  });
});
