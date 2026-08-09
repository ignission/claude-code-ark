import { describe, expect, it } from "vitest";
import { injectBuiltinProjection } from "./diagram-builtin.js";
import type { DiagramModel } from "./diagram-model.js";

const page = (body: string) =>
  `<!doctype html><html><head></head><body>${body}</body></html>`;

const modelScript =
  '<script type="application/json" id="ark-diagram-model">{}</script>';

function model(overrides: Partial<DiagramModel> = {}): DiagramModel {
  return {
    version: 1,
    type: "er",
    title: "注文まわり",
    nodes: [
      {
        id: "order",
        label: "Order",
        kind: "entity",
        fields: [
          { id: "o_id", label: "id PK" },
          { id: "o_status", label: "status" },
        ],
      },
      { id: "customer", label: "Customer", kind: "entity" },
    ],
    edges: [
      {
        id: "e1",
        from: "customer",
        to: "order",
        label: "places",
        ext: { from_card: "one", to_card: "zero-or-many" },
      },
    ],
    groups: [{ id: "g1", label: "Ordering", nodes: ["order", "customer"] }],
    ...overrides,
  };
}

describe("injectBuiltinProjection", () => {
  it("既知の図種で投影が無ければ node・field・group を生成する", () => {
    const out = injectBuiltinProjection(page(modelScript), model());

    // graph container と図種の印
    expect(out).toContain('data-ark-container="graph"');
    expect(out).toContain('data-ark-builtin="er"');
    // node root と label が同じ id を持つ（ハーネスの投影契約）
    expect(out).toContain('data-model-id="order"');
    expect(out).toContain("Order");
    // field は li として id 付きで出る
    expect(out).toContain('data-model-id="o_id"');
    expect(out).toContain("id PK");
    expect(out).toContain('data-model-id="o_status"');
    // group は data-ark-group + group-label
    expect(out).toContain("data-ark-group");
    expect(out).toContain('data-model-id="g1"');
    expect(out).toContain("Ordering");
    // kind は投影 root の data-kind に載る
    expect(out).toContain('data-kind="entity"');
  });

  it("生成物は送信 HTML から取り除かれる印を持つ", () => {
    // 図ファイルをモデルだけに保つのが目的。印が無いと最初の保存で
    // 生成された投影がファイルに焼き付き、二重管理に戻ってしまう
    const out = injectBuiltinProjection(page(modelScript), model());

    expect(out).toContain('data-ark-harness-generated="1"');
    expect(out).toMatch(/<style[^>]*data-ark-harness-ui="1"/);
  });

  it("label・field・kind を HTML エスケープする", () => {
    const out = injectBuiltinProjection(
      page(modelScript),
      model({
        nodes: [
          {
            id: 'x"><img src=x onerror=alert(1)>',
            label: '<script>alert("xss")</script>',
            kind: 'entity"><b>',
            fields: [{ id: "f1", label: "<b>bold</b>" }],
          },
        ],
        edges: [],
        groups: [],
      })
    );

    expect(out).not.toContain("<script>alert(");
    expect(out).not.toContain("<img src=x");
    expect(out).not.toContain("<b>bold</b>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&lt;b&gt;bold&lt;/b&gt;");
  });

  it("kind=note は本文を note 投影として生成する", () => {
    const out = injectBuiltinProjection(
      page(modelScript),
      model({
        type: "event-storming",
        nodes: [
          { id: "n1", label: "メモ", kind: "note", noteText: "未決の論点" },
        ],
        edges: [],
        groups: [],
      })
    );

    expect(out).toContain("data-ark-harness-note");
    expect(out).toContain("未決の論点");
  });

  it("event-storming の kind 見出しは DOM ではなく CSS 由来にする", () => {
    // 静的テキストで書くと、ハーネスで kind を変えた後も古い名前が残る
    // （root の data-kind しか更新されないため。実機で再現済み）
    const out = injectBuiltinProjection(
      page(modelScript),
      model({
        type: "event-storming",
        nodes: [{ id: "e1", label: "Order placed", kind: "event" }],
        edges: [],
        groups: [],
      })
    );

    expect(out).toContain('data-ark-builtin="event-storming"');
    // kind 名は DOM に焼き込まない
    expect(out).not.toContain("ark-builtin-kind-name");
    // 色だけに頼らないための可視名は CSS 変数 + ::before で出す
    expect(out).toContain('--kn:"event"');
    expect(out).toMatch(/\.ark-builtin-node::before\{content:var\(--kg/);
  });

  it.each([
    [
      "flow",
      [
        "step",
        "command",
        "decision",
        "policy",
        "event",
        "outcome",
        "error",
        "actor",
        "note",
      ],
    ],
    ["state", ["initial", "state", "terminal-ok", "terminal-cancel", "note"]],
    [
      "context-map",
      ["core", "supporting", "generic", "developed", "external", "note"],
    ],
  ] as const)("%s は語彙の全 kind を node root だけに当てる", (type, kinds) => {
    const out = injectBuiltinProjection(
      page(modelScript),
      model({
        type,
        nodes: kinds.map((kind, index) => ({
          id: `n${index}`,
          label: `ノード${index}`,
          kind,
        })),
        edges: [],
        groups: [],
      })
    );
    const style = out.slice(out.indexOf("<style"), out.indexOf("</style>"));
    // style 内の同じ文字列で通ってしまわないよう、判定は graph の中だけで行う
    const graphStart = out.indexOf('<div data-ark-container="graph"');
    expect(graphStart).toBeGreaterThanOrEqual(0);
    const graphHtml = out.slice(graphStart);

    expect(out).toContain(`data-ark-builtin="${type}"`);
    for (const kind of kinds) {
      expect(style).toContain(`.ark-builtin-node[data-kind="${kind}"]`);
      // data-kind は node root（article）に直接付く
      expect(graphHtml).toMatch(
        new RegExp(`<article\\b[^>]*data-kind="${kind}"`)
      );
    }
    // 素の [data-kind] は label span にも当たるので使わない
    const kindRules = style.match(/\[data-kind=/g) ?? [];
    const scoped = style.match(/\.ark-builtin-node\[data-kind=/g) ?? [];
    expect(scoped).toHaveLength(kindRules.length);
  });

  it("state の2つの終端を色以外でも区別する", () => {
    // 色覚・モノクロ表示でも「正常終了」と「取消」を読み分けられること
    const out = injectBuiltinProjection(
      page(modelScript),
      model({ type: "state", nodes: [], edges: [], groups: [] })
    );
    const rule = (kind: string) =>
      out.match(
        new RegExp(`\\.ark-builtin-node\\[data-kind="${kind}"\\]\\{[^}]*\\}`)
      )?.[0] ?? "";

    const glyph = (kind: string) => rule(kind).match(/--kg:"([^"]*)"/)?.[1];

    // 入れ替わりも検出できるよう、kind とグリフの対応まで固定する
    expect(glyph("initial")).toBe("\\25CF"); // ●
    expect(glyph("state")).toBe("\\25CB"); // ○
    expect(glyph("terminal-ok")).toBe("\\2714"); // ✔
    expect(glyph("terminal-cancel")).toBe("\\2716"); // ✖
    // 取消は線種でも区別する
    expect(rule("terminal-cancel")).toContain("border-style:dashed");
  });

  it("引用符なしの graph 属性を持つ図にも触らない", () => {
    // HTML は data-ark-container=graph も許す。見落とすと graph が二重になる
    const authored = page(
      `${modelScript}<div data-ark-container=graph><div data-model-id="order">Order</div></div>`
    );

    expect(injectBuiltinProjection(authored, model())).toBe(authored);
  });

  it("script 本文や comment の中の文字列を graph と誤認しない", () => {
    // 誤認すると投影を生成せず白紙になる
    const decoy =
      '<script type="application/json" id="ark-diagram-model">' +
      '{"note":"data-ark-container=\\"graph\\" と書いただけ"}</script>' +
      '<!-- data-ark-container="graph" -->';

    const out = injectBuiltinProjection(page(decoy), model());

    // 生成された graph container はちょうど1つ
    // （CSS の selector やコメント内の文字列とは区別する）
    expect(
      out.match(/data-ark-container="graph" data-ark-builtin="er"/g)
    ).toHaveLength(1);
    expect(out).toContain("ark-builtin-node");
  });

  it("未知の図種と図種なしには何もしない", () => {
    const html = page(modelScript);

    expect(injectBuiltinProjection(html, model({ type: "mindmap" }))).toBe(
      html
    );
    expect(injectBuiltinProjection(html, model({ type: undefined }))).toBe(
      html
    );
  });

  it("生成物が自前の graph container を持つ図には何もしない", () => {
    // 手書き投影の図は従来どおり作者のものを尊重する
    const authored = page(
      `${modelScript}<div data-ark-container="graph"><div data-model-id="order">Order</div></div>`
    );

    expect(injectBuiltinProjection(authored, model())).toBe(authored);
  });

  it("二重適用しても投影は増えない", () => {
    const once = injectBuiltinProjection(page(modelScript), model());
    const twice = injectBuiltinProjection(once, model());

    expect(twice).toBe(once);
    expect(once.match(/data-ark-container="graph"/g)).toHaveLength(1);
  });

  it("body が無い文書でも末尾に生成する", () => {
    const out = injectBuiltinProjection(modelScript, model());

    expect(out).toContain('data-ark-container="graph"');
    expect(out.indexOf(modelScript)).toBeLessThan(
      out.indexOf('data-ark-container="graph"')
    );
  });

  it("kind 別スタイルを node root だけに当てる", () => {
    // ハーネスは label span にも data-kind を同期する。素の [data-kind] で
    // 書くと label にも枠線や幅が乗り、二重枠として描画される（実機で確認）
    const out = injectBuiltinProjection(page(modelScript), model());
    const style = out.slice(out.indexOf("<style"), out.indexOf("</style>"));
    const kindRules = style.match(/\[data-kind=/g) ?? [];
    const scoped = style.match(/\.ark-builtin-node\[data-kind=/g) ?? [];

    expect(kindRules.length).toBeGreaterThan(0);
    expect(scoped).toHaveLength(kindRules.length);
  });

  it("外部リソースを参照しない", () => {
    const out = injectBuiltinProjection(page(modelScript), model());

    expect(out).not.toContain("https://");
    expect(out).not.toContain("@font-face");
    expect(out).not.toContain('rel="stylesheet"');
  });
});
