import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  DIAGRAM_PINCH_LAYER_MARKER,
  injectDiagramPinchLayer,
  PINCH_LAYER,
} from "./diagram-pinch-layer.js";

const minimalDoc =
  '<!doctype html><html><head></head><body><p data-ark-id="s1">本文</p></body></html>';

/** 層のスクリプト本体を最小の DOM スタブで走らせる */
function loadLayer() {
  const body = PINCH_LAYER.slice(
    PINCH_LAYER.indexOf(">") + 1,
    PINCH_LAYER.lastIndexOf("</script>")
  );
  const listeners: Record<string, (event: unknown) => void> = {};
  const sent: unknown[] = [];
  const port = {
    postMessage: (message: unknown) => sent.push(message),
    start: () => {},
  };
  runInNewContext(body, {
    Math,
    window: {
      addEventListener: (type: string, fn: (event: unknown) => void) => {
        listeners[`window:${type}`] = fn;
      },
    },
  });
  const init = () =>
    listeners["window:message"]?.({
      data: { type: "ark:diagram-init" },
      ports: [port],
    });
  const fire = (type: string, event: Record<string, unknown>) => {
    let prevented = false;
    listeners[`window:${type}`]?.({
      ...event,
      preventDefault: () => {
        prevented = true;
      },
    });
    return prevented;
  };
  return { init, fire, sent };
}

describe("ピンチ", () => {
  it("Ctrl+ホイールの量と位置を親へ送り、ページの拡大は止める", () => {
    const layer = loadLayer();
    layer.init();
    expect(
      layer.fire("wheel", { ctrlKey: true, deltaY: 10, clientX: 5, clientY: 7 })
    ).toBe(true);
    expect(layer.fire("wheel", { ctrlKey: false, deltaY: 10 })).toBe(false);
    expect(layer.sent).toEqual([
      { type: "ark:diagram-pinch", deltaY: 10, clientX: 5, clientY: 7 },
    ]);
  });

  it("2 本指の距離の変化を量にして、指の中点と一緒に送る", () => {
    const layer = loadLayer();
    layer.init();
    const touches = (distance: number) => ({
      touches: [
        { clientX: 0, clientY: 40 },
        { clientX: distance, clientY: 60 },
      ],
    });
    layer.fire("touchstart", touches(100));
    layer.fire("touchmove", touches(200));
    expect(layer.sent).toHaveLength(1);
    const [message] = layer.sent as Array<{
      type: string;
      deltaY: number;
      clientX: number;
      clientY: number;
    }>;
    expect(message.type).toBe("ark:diagram-pinch");
    expect(message.deltaY).toBeCloseTo(
      -400 * Math.log(Math.hypot(200, 20) / Math.hypot(100, 20))
    );
    expect(message.clientX).toBe(100);
    expect(message.clientY).toBe(50);
  });
});

describe("注入", () => {
  it("</body> の直前へ 1 回だけ入れる", () => {
    const once = injectDiagramPinchLayer(minimalDoc);
    expect(once).toContain(`id="${DIAGRAM_PINCH_LAYER_MARKER}"`);
    expect(once.indexOf(DIAGRAM_PINCH_LAYER_MARKER)).toBeLessThan(
      once.indexOf("</body>")
    );
    expect(injectDiagramPinchLayer(once)).toBe(once);
  });

  it("本文に marker の語があるだけの板にも入れる", () => {
    const doc = minimalDoc.replace("本文", DIAGRAM_PINCH_LAYER_MARKER);
    expect(injectDiagramPinchLayer(doc)).toContain(
      `<script id="${DIAGRAM_PINCH_LAYER_MARKER}"`
    );
  });
});
