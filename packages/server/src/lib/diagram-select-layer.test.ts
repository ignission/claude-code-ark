import { runInNewContext } from "node:vm";
import { DIAGRAM_SELECTION_TEXT_LIMIT } from "@ark/shared";
import { describe, expect, it } from "vitest";
import {
  DIAGRAM_SELECT_LAYER_MARKER,
  injectDiagramSelectLayer,
  SELECT_LAYER,
} from "./diagram-select-layer.js";

const minimalDoc =
  "<!doctype html><html><head></head><body><p>本文</p></body></html>";

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface FakeText {
  value: string;
  rect: Rect;
  /** inline の文字は、この名前が同じなら同じブロックの中にある */
  block: string;
  inline?: boolean;
  hidden?: boolean;
  /** script や層の中など、読み飛ばす場所にある */
  skipped?: boolean;
}

type Listener = (event: Record<string, unknown>) => void;

/** 層のスクリプト本体を、文字の位置だけを持つ最小の DOM スタブで走らせる */
function loadLayer(texts: FakeText[]) {
  const source = SELECT_LAYER.slice(
    SELECT_LAYER.indexOf(">") + 1,
    SELECT_LAYER.lastIndexOf("</script>")
  );
  const windowListeners: Record<string, Listener> = {};
  const portListeners: Listener[] = [];
  const sent: unknown[] = [];
  const port = {
    postMessage: (message: unknown) => sent.push(message),
    addEventListener: (_type: string, fn: Listener) => portListeners.push(fn),
    start: () => {},
  };

  const body = {
    children: [] as FakeElement[],
    appendChild(child: FakeElement) {
      child.parentNode = body;
      body.children.push(child);
    },
    removeChild(child: FakeElement) {
      body.children = body.children.filter(item => item !== child);
      child.parentNode = null;
    },
  };

  interface FakeElement {
    style: Record<string, string>;
    listeners: Record<string, Listener>;
    parentNode: unknown;
    setAttribute: () => void;
    appendChild: () => void;
    addEventListener: (type: string, fn: Listener) => void;
  }
  const createElement = (): FakeElement => {
    const element: FakeElement = {
      style: {},
      listeners: {},
      parentNode: null,
      setAttribute: () => {},
      appendChild: () => {},
      addEventListener: (type, fn) => {
        element.listeners[type] = fn;
      },
    };
    return element;
  };

  // インラインの親は、名前の同じブロックを共有する。インラインでない親は、それ自体がブロック
  const blocks = new Map<string, { parentElement: unknown }>();
  const sharedBlock = (name: string) => {
    let block = blocks.get(name);
    if (!block) {
      block = { parentElement: body };
      blocks.set(name, block);
    }
    return block;
  };
  const nodes = texts.map(text => ({
    nodeValue: text.value,
    rect: text.rect,
    parentElement: {
      parentElement: text.inline ? sharedBlock(text.block) : body,
      inline: text.inline === true,
      hidden: text.hidden === true,
      closest: () => (text.skipped ? {} : null),
    },
  }));

  let selected: (typeof nodes)[number] | null = null;
  runInNewContext(source, {
    Math,
    NodeFilter: { SHOW_TEXT: 4 },
    document: {
      body,
      createElement,
      createTreeWalker: () => {
        let index = 0;
        return { nextNode: () => nodes[index++] ?? null };
      },
      createRange: () => ({
        selectNodeContents: (node: (typeof nodes)[number]) => {
          selected = node;
        },
        getClientRects: () => {
          const rect = selected?.rect;
          if (!rect) return [];
          return [
            {
              ...rect,
              width: rect.right - rect.left,
              height: rect.bottom - rect.top,
            },
          ];
        },
      }),
    },
    window: {
      addEventListener: (type: string, fn: Listener) => {
        windowListeners[type] = fn;
      },
      getComputedStyle: (element: { hidden?: boolean; inline?: boolean }) => ({
        visibility: element.hidden ? "hidden" : "visible",
        display: element.inline ? "inline" : "block",
      }),
    },
  });

  windowListeners.message?.({
    data: { type: "ark:diagram-init" },
    ports: [port],
  });

  const fromParent = (data: unknown) => {
    for (const listener of portListeners) listener({ data });
  };
  const veil = () => body.children[0];
  const drag = (from: [number, number], to: [number, number]) => {
    const target = veil();
    const event = (point: [number, number]) => ({
      clientX: point[0],
      clientY: point[1],
      pointerId: 1,
      preventDefault: () => {},
    });
    target?.listeners.pointerdown?.(event(from));
    target?.listeners.pointermove?.(event(to));
    target?.listeners.pointerup?.(event(to));
  };
  const key = (name: string) => windowListeners.keydown?.({ key: name });
  return { fromParent, veil, drag, key, sent };
}

const at = (left: number, top: number): Rect => ({
  left,
  top,
  right: left + 100,
  bottom: top + 20,
});

describe("範囲選択", () => {
  it("親に言われるまで膜を置かず、言われたら置き、やめさせると外す", () => {
    const layer = loadLayer([]);
    expect(layer.veil()).toBeUndefined();
    layer.fromParent({ type: "ark:diagram-select", active: true });
    expect(layer.veil()).toBeDefined();
    layer.fromParent({ type: "ark:diagram-select", active: false });
    expect(layer.veil()).toBeUndefined();
  });

  it("囲んだ四角と重なる文字だけを、上から順に行にして送る", () => {
    const layer = loadLayer([
      { value: "注文を受ける", rect: at(0, 0), block: "a" },
      { value: "在庫を引き当てる", rect: at(0, 100), block: "b" },
      { value: "発送する", rect: at(0, 300), block: "c" },
    ]);
    layer.fromParent({ type: "ark:diagram-select", active: true });
    layer.drag([10, 5], [80, 110]);
    expect(layer.sent).toEqual([
      {
        type: "ark:diagram-selection",
        text: "注文を受ける\n在庫を引き当てる",
        truncated: false,
      },
    ]);
    // 選び終えたら膜は外れ、図をまた普通に触れる
    expect(layer.veil()).toBeUndefined();
  });

  it("同じブロックの中の文字は、区切りを足さずに1行へつなぐ", () => {
    const layer = loadLayer([
      { value: "太字", rect: at(0, 0), block: "a", inline: true },
      { value: "の続き  と\n改行", rect: at(100, 0), block: "a", inline: true },
    ]);
    layer.fromParent({ type: "ark:diagram-select", active: true });
    layer.drag([0, 0], [300, 30]);
    expect(layer.sent).toEqual([
      {
        type: "ark:diagram-selection",
        text: "太字の続き と 改行",
        truncated: false,
      },
    ]);
  });

  it("インラインの要素の間の空白は、両側を写すときに空白として残す", () => {
    const layer = loadLayer([
      { value: "not", rect: at(0, 0), block: "a", inline: true },
      { value: " ", rect: at(100, 0), block: "a", inline: true },
      { value: "approved", rect: at(110, 0), block: "a", inline: true },
      { value: "\n  ", rect: at(0, 40), block: "b", inline: true },
      { value: "次の行", rect: at(0, 40), block: "b", inline: true },
    ]);
    layer.fromParent({ type: "ark:diagram-select", active: true });
    layer.drag([0, 0], [300, 80]);
    expect(layer.sent).toEqual([
      {
        type: "ark:diagram-selection",
        text: "not approved\n次の行",
        truncated: false,
      },
    ]);
  });

  it("見えていない文字と、script や層の中の文字は写さない", () => {
    const layer = loadLayer([
      { value: "見える", rect: at(0, 0), block: "a" },
      { value: "隠れている", rect: at(0, 20), block: "b", hidden: true },
      { value: "var x=1", rect: at(0, 40), block: "c", skipped: true },
      { value: "   ", rect: at(0, 60), block: "d" },
    ]);
    layer.fromParent({ type: "ark:diagram-select", active: true });
    layer.drag([0, 0], [300, 300]);
    expect(layer.sent).toEqual([
      { type: "ark:diagram-selection", text: "見える", truncated: false },
    ]);
  });

  it("文字の無いところを囲んだら、空の文字列を送る", () => {
    const layer = loadLayer([
      { value: "遠くの文字", rect: at(500, 500), block: "a" },
    ]);
    layer.fromParent({ type: "ark:diagram-select", active: true });
    layer.drag([0, 0], [50, 50]);
    expect(layer.sent).toEqual([
      { type: "ark:diagram-selection", text: "", truncated: false },
    ]);
  });

  it("上限を超える文字は切り、切ったことを一緒に送る", () => {
    const layer = loadLayer([
      {
        value: "あ".repeat(DIAGRAM_SELECTION_TEXT_LIMIT + 10),
        rect: at(0, 0),
        block: "a",
      },
    ]);
    layer.fromParent({ type: "ark:diagram-select", active: true });
    layer.drag([0, 0], [50, 10]);
    const [message] = layer.sent as Array<{ text: string; truncated: boolean }>;
    expect(message.text).toHaveLength(DIAGRAM_SELECTION_TEXT_LIMIT);
    expect(message.truncated).toBe(true);
  });

  it("ドラッグせずに押しただけでは選んだことにせず、待ち続ける", () => {
    const layer = loadLayer([{ value: "文字", rect: at(0, 0), block: "a" }]);
    layer.fromParent({ type: "ark:diagram-select", active: true });
    layer.drag([10, 10], [11, 11]);
    expect(layer.sent).toEqual([]);
    expect(layer.veil()).toBeDefined();
  });

  it("Escape でやめ、やめたことを親へ知らせる", () => {
    const layer = loadLayer([]);
    layer.key("Escape");
    expect(layer.sent).toEqual([]);
    layer.fromParent({ type: "ark:diagram-select", active: true });
    layer.key("Escape");
    expect(layer.veil()).toBeUndefined();
    expect(layer.sent).toEqual([{ type: "ark:diagram-select-cancel" }]);
  });
});

describe("注入", () => {
  it("</body> の直前へ 1 回だけ入れる", () => {
    const once = injectDiagramSelectLayer(minimalDoc);
    expect(once).toContain(`id="${DIAGRAM_SELECT_LAYER_MARKER}"`);
    expect(once.indexOf(DIAGRAM_SELECT_LAYER_MARKER)).toBeLessThan(
      once.indexOf("</body>")
    );
    expect(injectDiagramSelectLayer(once)).toBe(once);
  });

  it("本文に marker の語があるだけの板にも入れる", () => {
    const doc = minimalDoc.replace("本文", DIAGRAM_SELECT_LAYER_MARKER);
    expect(injectDiagramSelectLayer(doc)).toContain(
      `<script id="${DIAGRAM_SELECT_LAYER_MARKER}"`
    );
  });
});
