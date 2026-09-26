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
    },
  });
  const init = () =>
    listeners["window:message"]?.({
      data: { type: "ark:diagram-init" },
      ports: [port],
    });
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
  return { init, click, sent };
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

  it("</body> が無ければ末尾に付ける", () => {
    const injected = injectDiagramLinkLayer("<p>x</p>");
    expect(injected.endsWith("</script>")).toBe(true);
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

  it("<a> 以外のクリックは何もしない", () => {
    const layer = loadLayer();
    layer.init();
    expect(layer.click(null)).toBe(false);
  });
});
