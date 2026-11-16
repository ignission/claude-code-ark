// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DIAGRAM_IMAGE_LAYER_MARKER,
  IMAGE_LAYER,
  injectDiagramImageLayer,
} from "./diagram-image-layer.js";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const source = IMAGE_LAYER.slice(
  IMAGE_LAYER.indexOf(">") + 1,
  IMAGE_LAYER.lastIndexOf("</script>")
);

let sent: Array<{ type: string; src: string; alt: string }>;
let size: { width: number; height: number };
const realRect = Element.prototype.getBoundingClientRect;

/** 層を1回だけ走らせ、port を渡す (document のリスナーはテストをまたいで残るため) */
let started = false;
const current = { post: (_message: unknown) => {} };
function start() {
  if (started) return;
  started = true;
  // biome-ignore lint/security/noGlobalEval: 注入するスクリプトをそのまま走らせる
  (0, eval)(source);
  const port = {
    postMessage: (message: unknown) => current.post(message),
    addEventListener: () => {},
    start: () => {},
  };
  const event = new MessageEvent("message", {
    data: { type: "ark:diagram-init" },
  });
  Object.defineProperty(event, "ports", { value: [port] });
  window.dispatchEvent(event);
}

function click(selector: string) {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`${selector} が無い`);
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
}

beforeEach(() => {
  sent = [];
  size = { width: 300, height: 200 };
  current.post = message => sent.push(message as (typeof sent)[number]);
  Element.prototype.getBoundingClientRect = () =>
    ({ ...size, x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0 }) as DOMRect;
  start();
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = realRect;
  document.body.innerHTML = "";
});

describe("ボードの画像を押す", () => {
  it("img は src と alt をそのまま親へ送る", () => {
    document.body.innerHTML = `<img id="a" src="${PNG}" alt="画面">`;
    click("#a");
    expect(sent).toEqual([
      { type: "ark:diagram-image", src: PNG, alt: "画面" },
    ]);
  });

  it("svg は中の要素を押しても、いちばん外の svg を data URL にして送る", () => {
    document.body.innerHTML =
      '<svg id="s" aria-label="構成"><svg><rect id="r" class="box"/></svg><script>x()</script></svg>';
    click("#r");
    expect(sent).toHaveLength(1);
    expect(sent[0].alt).toBe("構成");
    expect(sent[0].src.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(
      true
    );
    const xml = decodeURIComponent(sent[0].src.split(",")[1]);
    expect(xml).toContain('viewBox="0 0 300 200"');
    expect(xml).toContain("<rect");
    expect(xml).not.toContain("<script");
  });

  it("小さい画像 (アイコン) は送らない", () => {
    size = { width: 24, height: 24 };
    document.body.innerHTML = `<img id="a" src="${PNG}">`;
    click("#a");
    expect(sent).toEqual([]);
  });

  it("リンクやボタンの中、pointer のものは送らない", () => {
    document.body.innerHTML = `
      <a href="x"><img id="a" src="${PNG}"></a>
      <button><img id="b" src="${PNG}"></button>
      <img id="c" src="${PNG}" style="cursor:pointer">`;
    for (const id of ["a", "b", "c"]) click(`#${id}`);
    expect(sent).toEqual([]);
  });

  it("data URL でない画像は送らない", () => {
    document.body.innerHTML = '<img id="a" src="https://example.com/a.png">';
    click("#a");
    expect(sent).toEqual([]);
  });

  it("図が自分で処理した押下 (preventDefault) には手を出さない", () => {
    document.body.innerHTML = `<img id="a" src="${PNG}">`;
    const el = document.querySelector("#a") as HTMLElement;
    el.addEventListener("click", event => event.preventDefault());
    el.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
    );
    expect(sent).toEqual([]);
  });
});

describe("注入", () => {
  it("</body> の直前へ1回だけ入れる", () => {
    const once = injectDiagramImageLayer("<html><body><p>図</p></body></html>");
    expect(once).toContain(`id="${DIAGRAM_IMAGE_LAYER_MARKER}"`);
    expect(once.indexOf(DIAGRAM_IMAGE_LAYER_MARKER)).toBeLessThan(
      once.indexOf("</body>")
    );
    expect(injectDiagramImageLayer(once)).toBe(once);
  });
});
