import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  DIAGRAM_KEYNAV_LAYER_MARKER,
  injectDiagramKeynavLayer,
  KEYNAV_LAYER,
} from "./diagram-keynav-layer.js";

const minimalDoc =
  '<!doctype html><html><head></head><body><p data-ark-id="s1">本文</p></body></html>';

/** 層のスクリプト本体を最小の DOM スタブで走らせる */
function loadLayer() {
  const body = KEYNAV_LAYER.slice(
    KEYNAV_LAYER.indexOf(">") + 1,
    KEYNAV_LAYER.lastIndexOf("</script>")
  );
  const listeners: Record<string, (event: unknown) => void> = {};
  const sent: unknown[] = [];
  const scrolls: string[] = [];
  let onPortMessage: ((message: { data: unknown }) => void) | undefined;
  const port = {
    postMessage: (message: unknown) => sent.push(message),
    start: () => {},
    addEventListener: (_: string, fn: (message: { data: unknown }) => void) => {
      onPortMessage = fn;
    },
  };
  runInNewContext(body, {
    Math,
    document: {
      scrollingElement: { scrollHeight: 4000 },
      addEventListener: (type: string, fn: (event: unknown) => void) => {
        listeners[`document:${type}`] = fn;
      },
    },
    window: {
      innerHeight: 600,
      scrollX: 0,
      scrollBy: (x: number, y: number) => scrolls.push(`by:${x},${y}`),
      scrollTo: (x: number, y: number) => scrolls.push(`to:${x},${y}`),
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
  const press = (key: Record<string, unknown>) => {
    let prevented = false;
    listeners["document:keydown"]?.({
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      isComposing: false,
      ...key,
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {},
    });
    return prevented;
  };
  const receive = (data: unknown) => onPortMessage?.({ data });
  return { init, press, receive, sent, scrolls };
}

describe("前置キー", () => {
  it("Ctrl+; だけを横取りして親へ知らせる", () => {
    const layer = loadLayer();
    layer.init();
    expect(layer.press({ ctrlKey: true, key: ";" })).toBe(true);
    // 日本語配列などで key が変わっても、物理キーで拾う
    expect(layer.press({ ctrlKey: true, key: "+", code: "Semicolon" })).toBe(
      true
    );
    expect(layer.sent).toEqual([
      { type: "ark:diagram-keynav-leader" },
      { type: "ark:diagram-keynav-leader" },
    ]);
  });

  it("ほかのキーには触らない (本文の編集やコメントの入力を変えない)", () => {
    const layer = loadLayer();
    layer.init();
    expect(layer.press({ key: ";" })).toBe(false);
    expect(layer.press({ key: "j" })).toBe(false);
    expect(layer.press({ ctrlKey: true, key: "s" })).toBe(false);
    expect(layer.press({ ctrlKey: true, altKey: true, key: ";" })).toBe(false);
    expect(layer.press({ ctrlKey: true, key: ";", isComposing: true })).toBe(
      false
    );
    expect(layer.sent).toEqual([]);
  });

  it("port を受け取る前は横取りしない (知らせる先が無い)", () => {
    const layer = loadLayer();
    expect(layer.press({ ctrlKey: true, key: ";" })).toBe(false);
  });
});

describe("親からの送りの指示", () => {
  it("行・半ページ・端を、文書のスクロールに直す", () => {
    const layer = loadLayer();
    layer.init();
    layer.receive({ type: "ark:diagram-keynav-scroll", unit: "line", dir: 1 });
    layer.receive({ type: "ark:diagram-keynav-scroll", unit: "page", dir: -1 });
    layer.receive({ type: "ark:diagram-keynav-scroll", unit: "edge", dir: 1 });
    layer.receive({ type: "ark:diagram-keynav-scroll", unit: "edge", dir: -1 });
    expect(layer.scrolls).toEqual([
      "by:0,80",
      "by:0,-300",
      "to:0,4000",
      "to:0,0",
    ]);
  });

  it("ほかの層あての通知では動かない", () => {
    const layer = loadLayer();
    layer.init();
    layer.receive({ type: "ark:diagram-comments-changed" });
    layer.receive(null);
    expect(layer.scrolls).toEqual([]);
  });
});

describe("注入", () => {
  it("</body> の直前へ 1 回だけ入れ、保存で落ちる印を持つ", () => {
    const once = injectDiagramKeynavLayer(minimalDoc);
    expect(once).toContain(`id="${DIAGRAM_KEYNAV_LAYER_MARKER}"`);
    expect(once).toContain('data-ark-harness-ui="1"');
    expect(once.indexOf(DIAGRAM_KEYNAV_LAYER_MARKER)).toBeLessThan(
      once.indexOf("</body>")
    );
    expect(injectDiagramKeynavLayer(once)).toBe(once);
  });

  it("本文に marker の語があるだけの板にも入れる", () => {
    const doc = minimalDoc.replace("本文", DIAGRAM_KEYNAV_LAYER_MARKER);
    expect(injectDiagramKeynavLayer(doc)).toContain(
      `<script id="${DIAGRAM_KEYNAV_LAYER_MARKER}"`
    );
  });
});
