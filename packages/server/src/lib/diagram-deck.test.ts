import { describe, expect, it } from "vitest";
import {
  commentAnchorNodes,
  DIAGRAM_DECK_HIDDEN_ATTR,
  DIAGRAM_DECK_MARKER,
  DIAGRAM_PAGE_CHANGE_EVENT,
  injectDeckProjection,
  parseDeckPages,
  validateDiagramDeck,
} from "./diagram-deck.js";
import type { DiagramModel } from "./diagram-model.js";

const page = (body = "") =>
  `<!doctype html><html><head></head><body>${body}</body></html>`;

const occurrences = (value: string, token: string) =>
  value.split(token).length - 1;

function deckModel(pages: unknown[], overrides: Partial<DiagramModel> = {}) {
  return {
    version: 1,
    type: "deck",
    title: "リンクを押してから行が光るまで",
    nodes: [],
    edges: [],
    groups: [],
    ext: { pages },
    ...overrides,
  } as DiagramModel;
}

const SEQUENCE_PAGE = {
  id: "p-seq",
  type: "sequence",
  title: "クリックから postMessage まで",
  nodes: [
    { id: "iframe", label: "board iframe" },
    { id: "layer", label: "link layer", kind: "new" },
  ],
  edges: [{ id: "s1", from: "iframe", to: "layer", label: "click a[href]" }],
};

const CALL_TREE_PAGE = {
  id: "p-tree",
  type: "call-tree",
  title: "リンクを押す経路",
  nodes: [
    { id: "doc", label: "board doc" },
    {
      id: "link",
      label: "diagram-link-layer.ts",
      kind: "added",
      ext: { added: 96, removed: 0 },
    },
  ],
  edges: [{ id: "e1", from: "doc", to: "link" }],
};

const HTML_PAGE = { id: "p-why", type: "html", title: "なぜ親で解釈するか" };

describe("parseDeckPages", () => {
  it("ページを並び順どおりに返す", () => {
    const result = parseDeckPages(
      deckModel([SEQUENCE_PAGE, HTML_PAGE, CALL_TREE_PAGE])
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages.map(p => [p.id, p.type])).toEqual([
      ["p-seq", "sequence"],
      ["p-why", "html"],
      ["p-tree", "call-tree"],
    ]);
    const seq = result.pages[0];
    expect(seq.type === "sequence" && seq.model.edges[0].label).toBe(
      "click a[href]"
    );
  });

  it("ページが無いデッキは拒否する", () => {
    expect(parseDeckPages(deckModel([])).ok).toBe(false);
    expect(
      parseDeckPages({ ...deckModel([]), ext: undefined } as DiagramModel).ok
    ).toBe(false);
  });

  it("語彙に無いページの type は拒否する", () => {
    const result = parseDeckPages(
      deckModel([{ id: "p1", type: "er", nodes: [], edges: [] }])
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("er");
  });

  it("ページ内のモデルは既存の図と同じ検証を通す", () => {
    const result = parseDeckPages(
      deckModel([
        {
          ...SEQUENCE_PAGE,
          edges: [{ id: "s1", from: "iframe", to: "ghost" }],
        },
      ])
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ghost");
  });

  it("id はページをまたいで一意でなければならない", () => {
    const result = parseDeckPages(
      deckModel([
        SEQUENCE_PAGE,
        {
          ...CALL_TREE_PAGE,
          nodes: [{ id: "iframe", label: "重複" }],
          edges: [],
        },
      ])
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("iframe");
  });

  it("ページの id どうし、ページの id と node の id も重複できない", () => {
    expect(parseDeckPages(deckModel([HTML_PAGE, HTML_PAGE])).ok).toBe(false);
    expect(
      parseDeckPages(deckModel([{ ...SEQUENCE_PAGE, id: "layer" }])).ok
    ).toBe(false);
  });
});

describe("validateDiagramDeck", () => {
  it("デッキ以外の図は検証しない", () => {
    const model = { ...deckModel([]), type: "flow" } as DiagramModel;
    expect(validateDiagramDeck(page(), model)).toEqual({ ok: true });
  });

  it("html ページには data-ark-page の section がちょうど1つ要る", () => {
    const model = deckModel([SEQUENCE_PAGE, HTML_PAGE]);

    expect(validateDiagramDeck(page(), model).ok).toBe(false);
    expect(
      validateDiagramDeck(
        page(
          '<section data-ark-page="p-why">a</section><section data-ark-page="p-why">b</section>'
        ),
        model
      ).ok
    ).toBe(false);
    expect(
      validateDiagramDeck(
        page('<section data-ark-page="p-why">理由</section>'),
        model
      )
    ).toEqual({ ok: true });
  });

  it("html ページでない id を指す data-ark-page は拒否する", () => {
    const result = validateDiagramDeck(
      page('<section data-ark-page="p-seq">手書き</section>'),
      deckModel([SEQUENCE_PAGE])
    );

    expect(result.ok).toBe(false);
  });

  it("ページの定義が壊れていれば、その理由を返す", () => {
    const result = validateDiagramDeck(page(), deckModel([]));

    expect(result.ok).toBe(false);
  });
});

describe("injectDeckProjection", () => {
  const html = page(
    '<section data-ark-page="p-why"><h2>親で解釈する</h2></section>'
  );
  const model = deckModel([SEQUENCE_PAGE, HTML_PAGE, CALL_TREE_PAGE]);

  it("内蔵図種のページを生成し、html ページは差し込み口を置く", () => {
    const out = injectDeckProjection(html, model);

    const seq = out.indexOf('data-ark-page="p-seq"');
    const slot = out.indexOf('data-ark-deck-slot="p-why"');
    const tree = out.indexOf('data-ark-page="p-tree"');
    expect(seq).toBeGreaterThan(-1);
    expect(slot).toBeGreaterThan(seq);
    expect(tree).toBeGreaterThan(slot);
    expect(out).toContain('data-ark-static="sequence"');
    expect(out).toContain('data-ark-static="call-tree"');
    // 生成した行にはコメントの anchor が付く
    expect(out).toContain('data-ark-id="s1"');
    expect(out).toContain('data-ark-id="link"');
  });

  it("めくる操作と一覧表示の切り替えを持つ", () => {
    const out = injectDeckProjection(html, model);

    expect(out).toContain(DIAGRAM_DECK_MARKER);
    expect(out).toContain('data-ark-deck-go="-1"');
    expect(out).toContain('data-ark-deck-go="1"');
    expect(out).toContain("data-ark-deck-mode");
    // srcdoc の iframe では href="#…" が親の URL へ遷移するので使わない
    expect(out).not.toMatch(/href="#/);
  });

  it("表示の切り替えは包む要素で行い、自由形 section の display に触らない", () => {
    const out = injectDeckProjection(html, model);

    // html ページの差し込み口そのものがページの包む要素になる
    expect(out).toContain(
      '<div class="ark-deck-page" data-ark-deck-slot="p-why">'
    );
    expect(out).toContain(
      `.ark-deck-page[${DIAGRAM_DECK_HIDDEN_ATTR}]{display:none}`
    );
    expect(out).not.toMatch(/\.ark-deck-page[^{]*\{display:block/);
    expect(out).toContain("slot.appendChild(el)");
    // 表示が変わるたびにコメント層へ知らせる
    expect(out).toContain(`new Event("${DIAGRAM_PAGE_CHANGE_EVENT}")`);
  });

  it("生成物は保存時に落ちるよう data-ark-harness-ui を付ける", () => {
    const out = injectDeckProjection(html, model);
    const injected = out.slice(out.indexOf("</section>") + "</section>".length);

    expect(injected).toContain('<style data-ark-harness-ui="1">');
    expect(injected).toMatch(/<script id="[^"]+" data-ark-harness-ui="1">/);
  });

  it("二重に注入しない", () => {
    const once = injectDeckProjection(html, model);
    expect(injectDeckProjection(once, model)).toBe(once);
    expect(occurrences(once, `id="${DIAGRAM_DECK_MARKER}"`)).toBe(1);
  });

  it("ページの文字列はエスケープする", () => {
    const out = injectDeckProjection(
      page(),
      deckModel([
        {
          ...SEQUENCE_PAGE,
          title: "<img src=x onerror=alert(1)>",
        },
      ])
    );

    expect(out).not.toContain("<img src=x");
  });

  it("デッキ以外と、ページ定義が壊れたデッキには何もしない", () => {
    const flow = { ...model, type: "flow" } as DiagramModel;
    expect(injectDeckProjection(html, flow)).toBe(html);
    expect(injectDeckProjection(html, deckModel([]))).toBe(html);
  });
});

describe("commentAnchorNodes", () => {
  it("デッキはページ内の node もコメントの付け先にする", () => {
    const nodes = commentAnchorNodes(
      deckModel([SEQUENCE_PAGE, HTML_PAGE, CALL_TREE_PAGE])
    );

    expect(nodes.map(node => node.id).sort()).toEqual([
      "doc",
      "iframe",
      "layer",
      "link",
    ]);
  });

  it("デッキ以外は一番上の node だけ", () => {
    const nodes = commentAnchorNodes({
      version: 1,
      type: "flow",
      nodes: [{ id: "a", label: "A" }],
      edges: [],
      groups: [],
    });

    expect(nodes.map(node => node.id)).toEqual(["a"]);
  });
});
