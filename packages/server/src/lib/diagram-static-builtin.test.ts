import { describe, expect, it } from "vitest";
import type { DiagramModel } from "./diagram-model.js";
import {
  injectStaticBuiltinProjection,
  isStaticBuiltinType,
} from "./diagram-static-builtin.js";

const page = (body = "") =>
  `<!doctype html><html><head></head><body>${body}</body></html>`;

function sequenceModel(overrides: Partial<DiagramModel> = {}): DiagramModel {
  return {
    version: 1,
    type: "sequence",
    title: "リンクを押してから行が光るまで",
    nodes: [
      { id: "iframe", label: "board iframe" },
      { id: "layer", label: "link layer", kind: "new" },
      { id: "parent", label: "parent window" },
    ],
    edges: [
      {
        id: "s1",
        from: "iframe",
        to: "layer",
        label: 'click a[href="…#L33"]',
      },
      {
        id: "s2",
        from: "layer",
        to: "layer",
        label: "preventDefault()",
        ext: {
          source: "packages/server/src/lib/diagram-link-layer.ts#L33-L48",
        },
      },
      {
        id: "s3",
        from: "layer",
        to: "parent",
        label: "postMessage(href)",
        ext: { style: "async" },
      },
      { id: "s4", from: "parent", to: "iframe", label: "ack" },
    ],
    groups: [],
    ...overrides,
  } as DiagramModel;
}

function callTreeModel(overrides: Partial<DiagramModel> = {}): DiagramModel {
  return {
    version: 1,
    type: "call-tree",
    title: "リンクを押す経路",
    nodes: [
      { id: "doc", label: "board doc" },
      {
        id: "layer",
        label: "diagram-link-layer.ts",
        kind: "added",
        ext: {
          source: "packages/server/src/lib/diagram-link-layer.ts#L33-L48",
          added: 96,
          removed: 0,
          note: "遷移を止め href を渡す",
        },
      },
      {
        id: "reader",
        label: "diagram-reader.ts",
        ext: { added: 5, removed: 2, via: "call" },
      },
      { id: "orphan", label: "親のいないフレーム" },
    ],
    edges: [
      { id: "e1", from: "doc", to: "layer" },
      { id: "e2", from: "layer", to: "reader" },
    ],
    groups: [],
    ...overrides,
  } as DiagramModel;
}

describe("isStaticBuiltinType", () => {
  it("sequence と call-tree だけを静的図種として扱う", () => {
    expect(isStaticBuiltinType("sequence")).toBe(true);
    expect(isStaticBuiltinType("call-tree")).toBe(true);
    expect(isStaticBuiltinType("flow")).toBe(false);
    expect(isStaticBuiltinType("doc")).toBe(false);
    expect(isStaticBuiltinType(undefined)).toBe(false);
  });
});

describe("injectStaticBuiltinProjection - 共通", () => {
  it("対象外の図種には触らない", () => {
    const html = page("<p>本文</p>");
    const other = { ...sequenceModel(), type: "flow" } as DiagramModel;
    expect(injectStaticBuiltinProjection(html, other)).toBe(html);
  });

  it("投影を </body> の前へ入れ、生成物と CSS に剥がす印を付ける", () => {
    const out = injectStaticBuiltinProjection(page(), sequenceModel());
    expect(out.indexOf("ark-static-panel")).toBeLessThan(
      out.indexOf("</body>")
    );
    expect(out).toContain('<style data-ark-harness-ui="1">');
    expect(out).toContain('data-ark-harness-generated="1"');
  });

  it("自前の投影を持つ図には二重に入れない", () => {
    const once = injectStaticBuiltinProjection(page(), sequenceModel());
    expect(injectStaticBuiltinProjection(once, sequenceModel())).toBe(once);
  });

  it("モデル JSON の中の data-ark-static は二重注入の判定に使わない", () => {
    const withModelText = page(
      '<script type="application/json" id="ark-diagram-model">{"note":"data-ark-static=1"}</script>'
    );
    expect(
      injectStaticBuiltinProjection(withModelText, sequenceModel())
    ).toContain("ark-static-panel");
  });

  it("label と source を HTML エスケープする", () => {
    const evil = sequenceModel({
      nodes: [
        { id: "a", label: '<img src=x onerror="alert(1)">' },
        { id: "b", label: "b" },
      ],
      edges: [
        {
          id: "s1",
          from: "a",
          to: "b",
          label: "</span><script>alert(1)</script>",
          ext: { source: 'x.ts" onmouseover="alert(1)' },
        },
      ],
    });
    const out = injectStaticBuiltinProjection(page(), evil);
    expect(out).not.toContain("<img src=x");
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).not.toContain('onmouseover="alert(1)"');
  });
});

describe("injectStaticBuiltinProjection - sequence", () => {
  it("参加者をモデルの順に列として並べる", () => {
    const out = injectStaticBuiltinProjection(page(), sequenceModel());
    const order = ["board iframe", "link layer", "parent window"].map(name =>
      out.indexOf(name)
    );
    expect(order[0]).toBeGreaterThan(0);
    expect(order[0]).toBeLessThan(order[1] ?? 0);
    expect(order[1]).toBeLessThan(order[2] ?? 0);
    expect(out).toContain("4 steps");
  });

  it("step に通し番号と向きを付ける（自己宛は self）", () => {
    const out = injectStaticBuiltinProjection(page(), sequenceModel());
    expect(out).toContain('data-ark-id="s1"');
    expect(out).toContain('data-dir="right"');
    expect(out).toContain('data-dir="self"');
    expect(out).toContain('data-dir="left"');
    expect(out).toContain('<span class="ark-seq-no">1</span>');
  });

  it("style は既定 call、指定があればそれを data 属性に出す", () => {
    const out = injectStaticBuiltinProjection(page(), sequenceModel());
    expect(out).toContain('data-style="call"');
    expect(out).toContain('data-style="async"');
  });

  it("実在しない参加者を指す step は落とし、他の step は残す", () => {
    const broken = sequenceModel({
      edges: [
        { id: "s1", from: "iframe", to: "unknown", label: "落ちる" },
        { id: "s2", from: "iframe", to: "layer", label: "残る" },
      ],
    });
    const out = injectStaticBuiltinProjection(page(), broken);
    expect(out).not.toContain('data-ark-id="s1"');
    expect(out).toContain('data-ark-id="s2"');
  });

  it("step は 1 件も無くても落ちない", () => {
    const out = injectStaticBuiltinProjection(
      page(),
      sequenceModel({ edges: [] })
    );
    expect(out).toContain("ark-static-panel");
    expect(out).toContain("0 steps");
  });
});

describe("injectStaticBuiltinProjection - call-tree", () => {
  it("edge の親子から深さを決め、深さ優先で並べる", () => {
    const out = injectStaticBuiltinProjection(page(), callTreeModel());
    const doc = out.indexOf('data-ark-id="doc"');
    const layer = out.indexOf('data-ark-id="layer"');
    const reader = out.indexOf('data-ark-id="reader"');
    expect(doc).toBeLessThan(layer);
    expect(layer).toBeLessThan(reader);
  });

  it("親から辿れないフレームも落とさず末尾に出す", () => {
    const out = injectStaticBuiltinProjection(page(), callTreeModel());
    expect(out).toContain('data-ark-id="orphan"');
    expect(out.indexOf('data-ark-id="orphan"')).toBeGreaterThan(
      out.indexOf('data-ark-id="reader"')
    );
  });

  it("差分量を行ごとに出し、見出しに合計を出す", () => {
    const out = injectStaticBuiltinProjection(page(), callTreeModel());
    expect(out).toContain("+96");
    expect(out).toContain("+5");
    expect(out).toContain("−2");
    expect(out).toContain("+101 −2");
  });

  it("kind=added は new を添え、via と note を出す", () => {
    const out = injectStaticBuiltinProjection(page(), callTreeModel());
    expect(out).toContain(">new<");
    expect(out).toContain('data-kind="added"');
    expect(out).toContain("遷移を止め href を渡す");
    expect(out).toContain(">call<");
  });

  it("差分量がどこにも無ければフレーム数を見出しに出す", () => {
    const out = injectStaticBuiltinProjection(
      page(),
      callTreeModel({
        nodes: [{ id: "a", label: "a" }],
        edges: [],
      })
    );
    expect(out).toContain("1 frames");
  });

  it("循環していても無限に辿らない", () => {
    const out = injectStaticBuiltinProjection(
      page(),
      callTreeModel({
        nodes: [
          { id: "a", label: "a" },
          { id: "b", label: "b" },
        ],
        edges: [
          { id: "e1", from: "a", to: "b" },
          { id: "e2", from: "b", to: "a" },
        ],
      })
    );
    expect(out).toContain('data-ark-id="a"');
    expect(out).toContain('data-ark-id="b"');
  });
});

describe("コードの在処のリンク", () => {
  it("worktree 相対パスだけリンクにする", () => {
    const out = injectStaticBuiltinProjection(page(), callTreeModel());
    expect(out).toContain(
      '<a href="packages/server/src/lib/diagram-link-layer.ts#L33-L48">'
    );
  });

  it("図の外へ出る href は素のテキストに落とす", () => {
    for (const source of [
      "https://example.com/x.ts",
      "/etc/passwd",
      "../../etc/passwd",
      "#L10",
      "javascript:alert(1)",
    ]) {
      const out = injectStaticBuiltinProjection(
        page(),
        callTreeModel({
          nodes: [{ id: "a", label: "frame", ext: { source } }],
          edges: [],
        })
      );
      expect(out).not.toContain("<a href=");
      expect(out).toContain("frame");
    }
  });
});
