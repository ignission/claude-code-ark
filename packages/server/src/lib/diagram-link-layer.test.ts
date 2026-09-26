import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  DIAGRAM_LINK_LAYER_MARKER,
  injectDiagramLinkLayer,
  LINK_LAYER,
} from "./diagram-link-layer.js";

const minimalDoc =
  '<!doctype html><html><head></head><body><p data-ark-id="s1">本文</p></body></html>';

/** リンク層のスクリプト本体を最小の DOM スタブで走らせ、click ハンドラと init ハンドラを取り出す */
function loadLayer() {
  const body = LINK_LAYER.slice(
    LINK_LAYER.indexOf(">") + 1,
    LINK_LAYER.lastIndexOf("</script>")
  );
  const listeners: Record<string, (event: unknown) => void> = {};
  let selection: { isCollapsed: boolean; toString: () => string } = {
    isCollapsed: true,
    toString: () => "",
  };
  const selectText = (text: string) => {
    selection = { isCollapsed: false, toString: () => text };
  };
  const sent: unknown[] = [];
  const port = {
    postMessage: (message: unknown) => sent.push(message),
    start: () => {},
    addEventListener: () => {},
  };
  runInNewContext(body, {
    document: {
      addEventListener: (type: string, fn: (event: unknown) => void) => {
        listeners[`document:${type}`] = fn;
      },
    },
    window: {
      addEventListener: (type: string, fn: (event: unknown) => void) => {
        listeners[`window:${type}`] = fn;
      },
      getSelection: () => selection,
    },
  });
  const init = () =>
    listeners["window:message"]?.({
      data: { type: "ark:diagram-init" },
      ports: [port],
    });
  const aux = (href: string | null, button: number) => {
    let prevented = false;
    const anchor =
      href === null
        ? null
        : { getAttribute: (name: string) => (name === "href" ? href : null) };
    listeners["document:auxclick"]?.({
      button,
      target: {
        closest: (selector: string) => (selector === "a[href]" ? anchor : null),
      },
      preventDefault: () => {
        prevented = true;
      },
    });
    return prevented;
  };
  const click = (href: string | null, options: { button?: number } = {}) => {
    let prevented = false;
    const anchor =
      href === null
        ? null
        : { getAttribute: (name: string) => (name === "href" ? href : null) };
    listeners["document:click"]?.({
      button: options.button ?? 0,
      target: {
        closest: (selector: string) => (selector === "a[href]" ? anchor : null),
      },
      preventDefault: () => {
        prevented = true;
      },
    });
    return prevented;
  };
  return { init, click, aux, selectText, sent };
}

describe("injectDiagramLinkLayer", () => {
  it("</body> 直前へ marker を 1 回だけ注入する", () => {
    const injected = injectDiagramLinkLayer(minimalDoc);
    expect(injected).toContain(DIAGRAM_LINK_LAYER_MARKER);
    expect(injected.indexOf(DIAGRAM_LINK_LAYER_MARKER)).toBe(
      injected.lastIndexOf(DIAGRAM_LINK_LAYER_MARKER)
    );
    expect(injected.indexOf(DIAGRAM_LINK_LAYER_MARKER)).toBeLessThan(
      injected.lastIndexOf("</body>")
    );
    expect(injectDiagramLinkLayer(injected)).toBe(injected);
  });

  it("本文に marker の語があるだけの板にも注入する (bare includes にしない)", () => {
    const prose = `<!doctype html><html><body><p data-ark-id="s1">この板は ${DIAGRAM_LINK_LAYER_MARKER} を説明する</p></body></html>`;
    const injected = injectDiagramLinkLayer(prose);
    expect(injected).toMatch(
      new RegExp(`<script[^>]*\\bid=["']${DIAGRAM_LINK_LAYER_MARKER}["']`)
    );
    expect(injectDiagramLinkLayer(injected)).toBe(injected);
  });

  it("</body> が無ければ末尾に付ける", () => {
    const injected = injectDiagramLinkLayer("<p>x</p>");
    expect(injected.endsWith("</script>")).toBe(true);
  });
});

describe("保存 HTML への焼き付き防止", () => {
  it("script に data-ark-harness-ui を付ける (保存時に落とされる印)", () => {
    expect(LINK_LAYER).toContain('data-ark-harness-ui="1"');
    expect(injectDiagramLinkLayer(minimalDoc)).toContain(
      'data-ark-harness-ui="1"'
    );
  });
});

describe("リンク層のクリック処理", () => {
  it("相対パスは遷移を止めて親へ href をそのまま送る", () => {
    const layer = loadLayer();
    layer.init();
    expect(layer.click("src/foo.ts#L10-L24")).toBe(true);
    expect(layer.sent).toEqual([
      { type: "ark:diagram-open-link", href: "src/foo.ts#L10-L24" },
    ]);
  });

  it("http(s) も親へ送る (新しいタブで開くかは親が決める)", () => {
    const layer = loadLayer();
    layer.init();
    expect(layer.click("https://example.com/x")).toBe(true);
    expect(layer.sent).toEqual([
      { type: "ark:diagram-open-link", href: "https://example.com/x" },
    ]);
  });

  it("# 始まりは文書内アンカーなので触らない", () => {
    const layer = loadLayer();
    layer.init();
    expect(layer.click("#s6")).toBe(false);
    expect(layer.sent).toEqual([]);
  });

  it("javascript: などのスキームは遷移を止めて無視する", () => {
    const layer = loadLayer();
    layer.init();
    expect(layer.click("javascript:alert(1)")).toBe(true);
    expect(layer.click("data:text/html,x")).toBe(true);
    expect(layer.sent).toEqual([]);
  });

  it("port が届く前でも遷移だけは止める", () => {
    const layer = loadLayer();
    expect(layer.click("src/foo.ts")).toBe(true);
    expect(layer.sent).toEqual([]);
  });

  it("中クリック (auxclick) も拾う。sandbox が新しいタブを塞ぐため", () => {
    const layer = loadLayer();
    layer.init();
    expect(layer.aux("src/foo.ts#L10", 1)).toBe(true);
    expect(layer.sent).toEqual([
      { type: "ark:diagram-open-link", href: "src/foo.ts#L10" },
    ]);
  });

  it("中クリック以外の auxclick (右クリック等) は触らない", () => {
    const layer = loadLayer();
    layer.init();
    expect(layer.aux("src/foo.ts", 2)).toBe(false);
    expect(layer.sent).toEqual([]);
  });

  it("本文を選択したままのクリックでは開かない (遷移は止める)", () => {
    const layer = loadLayer();
    layer.init();
    layer.selectText("並び替えは SessionSectionList の");
    expect(layer.click("packages/web/src/x.ts#L10")).toBe(true);
    expect(layer.sent).toEqual([]);
  });

  it("<a> 以外のクリックは何もしない", () => {
    const layer = loadLayer();
    layer.init();
    expect(layer.click(null)).toBe(false);
  });
});
