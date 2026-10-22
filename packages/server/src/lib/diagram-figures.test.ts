import { describe, expect, it } from "vitest";
import {
  injectFigureProjection,
  renderFigure,
  validateFigureModel,
} from "./diagram-figures.js";
import type { DiagramModel } from "./diagram-model.js";

function model(
  type: string,
  nodes: DiagramModel["nodes"],
  edges: DiagramModel["edges"] = []
): DiagramModel {
  return { version: 1, type, title: "図", nodes, edges, groups: [] };
}

// main から feat が分かれ、feat を main へ取り込んだ形（先頭が新しい）
const GIT = model(
  "git-graph",
  [
    {
      id: "m3",
      label: "Merge feat",
      ext: { branch: "main", sha: "c3", refs: ["main"] },
    },
    {
      id: "f1",
      label: "図種を足す",
      kind: "added",
      ext: { branch: "feat", sha: "b1", refs: ["PR #565"] },
    },
    { id: "m1", label: "起点", ext: { branch: "main", sha: "a1" } },
  ],
  [
    { id: "g1", from: "m1", to: "f1" },
    { id: "g2", from: "m1", to: "m3" },
    { id: "g3", from: "f1", to: "m3" },
  ]
);

describe("git-graph", () => {
  it("ブランチごとに列を分け、古い順の初出で main を左端に置く", () => {
    const html = renderFigure("git-graph", GIT);

    expect(html).toMatch(/ark-git-lane ark-git-c0">main/);
    expect(html).toMatch(/ark-git-lane ark-git-c1">feat/);
    // コミットの行はコメントの付け先になる
    expect(html).toContain('data-ark-id="f1"');
    expect(html).toContain("PR #565");
    expect(html).toContain('<code class="ark-git-sha">b1</code>');
  });

  it("親を 2 つ持つコミットをマージとして描き、取り込んだ線は取り込まれた側の色にする", () => {
    const html = renderFigure("git-graph", GIT);

    expect(html).toMatch(
      /<circle class="ark-git-c0" data-kind="commit" data-merge="1"/
    );
    // feat (列 1) から main のマージへ曲がる線
    expect(html).toMatch(/<path class="ark-git-c1" d="M 32 51 V 51 C/);
  });

  it("branch を書かないコミットは最初の親の列を継ぐ", () => {
    const html = renderFigure(
      "git-graph",
      model(
        "git-graph",
        [
          { id: "b", label: "続き" },
          { id: "a", label: "分岐", ext: { branch: "topic" } },
        ],
        [{ id: "e", from: "a", to: "b" }]
      )
    );

    expect(html).toContain(">topic</span>");
    expect(html).not.toContain(">main</span>");
  });

  it("edge の向きが逆（新しい → 古い）なら理由を返す", () => {
    const result = validateFigureModel(
      "git-graph",
      model(
        "git-graph",
        [
          { id: "new", label: "新" },
          { id: "old", label: "古" },
        ],
        [{ id: "e", from: "new", to: "old" }]
      )
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("親（古い）→ 子（新しい）");
  });
});

describe("timeline", () => {
  it("lane があれば列に分け、kind で印と色を変える", () => {
    const html = renderFigure(
      "timeline",
      model("timeline", [
        { id: "t1", label: "PR を出す", ext: { at: "10/19", lane: "Web" } },
        {
          id: "t2",
          label: "衝突",
          kind: "ng",
          ext: { at: "10/20", lane: "iOS", note: "rebase 待ち" },
        },
      ])
    );

    expect(html).toContain("repeat(2,minmax(0,1fr))");
    expect(html).toContain('<div class="ark-tl-lane">Web</div>');
    expect(html).toContain('data-ark-id="t2" data-kind="ng"');
    expect(html).toContain("✕");
    expect(html).toContain("rebase 待ち");
  });

  it("lane が無ければ見出しの行を出さない", () => {
    const html = renderFigure(
      "timeline",
      model("timeline", [{ id: "t1", label: "a", ext: { at: "1" } }])
    );

    expect(html).not.toContain("ark-tl-lane");
  });

  it("edge を書いたら理由を返す", () => {
    const result = validateFigureModel(
      "timeline",
      model(
        "timeline",
        [
          { id: "a", label: "a" },
          { id: "b", label: "b" },
        ],
        [{ id: "e", from: "a", to: "b" }]
      )
    );

    expect(result.ok).toBe(false);
  });
});

describe("tree", () => {
  it("最後の子かどうかで枝の記号を変え、kind の札を出す", () => {
    const html = renderFigure(
      "tree",
      model(
        "tree",
        [
          { id: "root", label: "worktrees" },
          { id: "a", label: "orista-1364", kind: "kept" },
          { id: "a1", label: "src", ext: { source: "src/index.ts" } },
          { id: "b", label: "orista-1200", kind: "removed" },
        ],
        [
          { id: "e1", from: "root", to: "a" },
          { id: "e2", from: "a", to: "a1" },
          { id: "e3", from: "root", to: "b" },
        ]
      )
    );

    expect(html).toContain(">├─ </span>");
    expect(html).toContain(">│  └─ </span>");
    expect(html).toContain(">└─ </span>");
    expect(html).toContain('<span class="ark-tr-badge">維持</span>');
    expect(html).toContain('<span class="ark-tr-badge">削除</span>');
    expect(html).toContain('<a href="src/index.ts">src</a>');
  });

  it("worktree の外を指す source はリンクにしない", () => {
    const html = renderFigure(
      "tree",
      model("tree", [{ id: "a", label: "x", ext: { source: "../secret.txt" } }])
    );

    expect(html).not.toContain("<a ");
  });
});

describe("compare", () => {
  const COMPARE = model(
    "compare",
    [
      { id: "b1", label: "Inter", ext: { side: "before" } },
      { id: "b2", label: "数字は等幅でない", ext: { side: "before" } },
      { id: "a1", label: "Geist", ext: { side: "after" } },
      { id: "a0", label: "font-numeric を付ける", ext: { side: "after" } },
    ],
    [{ id: "p1", from: "b1", to: "a1" }]
  );

  it("対応で行を揃え、対応の有無と label の一致から kind を決める", () => {
    const html = renderFigure("compare", COMPARE);

    expect(html).toContain("<div>before</div>");
    expect(html).toContain("<div>after</div>");
    expect(html).toMatch(
      /data-kind="changed"><div class="ark-cmp-cell" data-ark-id="b1">/
    );
    expect(html).toMatch(
      /data-kind="removed"><div class="ark-cmp-cell" data-ark-id="b2">/
    );
    expect(html).toMatch(
      /data-kind="added"><div class="ark-cmp-cell ark-cmp-none">/
    );
  });

  it("3 列以上、同じ列どうしの対応、1 対多の対応は理由を返す", () => {
    const three = model("compare", [
      { id: "a", label: "a", ext: { side: "A" } },
      { id: "b", label: "b", ext: { side: "B" } },
      { id: "c", label: "c", ext: { side: "C" } },
    ]);
    expect(validateFigureModel("compare", three).ok).toBe(false);

    const same = model(
      "compare",
      [
        { id: "a", label: "a", ext: { side: "A" } },
        { id: "a2", label: "a2", ext: { side: "A" } },
        { id: "b", label: "b", ext: { side: "B" } },
      ],
      [{ id: "e", from: "a", to: "a2" }]
    );
    expect(validateFigureModel("compare", same).ok).toBe(false);

    const many = model(
      "compare",
      [
        { id: "a", label: "a", ext: { side: "A" } },
        { id: "b", label: "b", ext: { side: "B" } },
        { id: "b2", label: "b2", ext: { side: "B" } },
      ],
      [
        { id: "e1", from: "a", to: "b" },
        { id: "e2", from: "a", to: "b2" },
      ]
    );
    expect(validateFigureModel("compare", many).ok).toBe(false);

    expect(validateFigureModel("compare", COMPARE).ok).toBe(true);
  });
});

describe("injectFigureProjection", () => {
  it("単独の図に、明暗に追従する地と図を差し込む（生成物の印付き）", () => {
    const html = injectFigureProjection(
      "<!doctype html><html><body><script>m</script></body></html>",
      GIT
    );

    expect(html).toContain(
      'class="ark-bk-page ark-fig-page" data-ark-harness-generated="1"'
    );
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html.indexOf("ark-git")).toBeLessThan(html.indexOf("</body>"));
  });

  it("対象外の図種には触らない", () => {
    const raw = "<html><body></body></html>";
    expect(injectFigureProjection(raw, model("er", []))).toBe(raw);
  });

  it("文字の中の HTML は効かせない", () => {
    const html = renderFigure(
      "tree",
      model("tree", [{ id: "a", label: "<img src=x onerror=alert(1)>" }])
    );

    expect(html).not.toContain("<img");
  });
});
