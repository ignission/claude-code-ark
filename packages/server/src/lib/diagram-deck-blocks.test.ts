import { describe, expect, it } from "vitest";
import {
  parseDeckBlocks,
  renderDeckBlocks,
  renderInline,
} from "./diagram-deck-blocks.js";

const render = (blocks: unknown[], title?: string) => {
  const parsed = parseDeckBlocks(blocks);
  if (!parsed.ok) throw new Error(parsed.error);
  return renderDeckBlocks(title, parsed.blocks);
};

describe("parseDeckBlocks", () => {
  it("語彙にある部品を受け付ける", () => {
    const result = parseDeckBlocks([
      { kind: "text", text: "補足" },
      { kind: "chips", items: [{ text: "通る", tone: "ok" }] },
      { kind: "cards", items: [{ title: "A", value: "12", items: ["x"] }] },
      { kind: "flow", items: ["a", "b"] },
      { kind: "table", head: ["k", "v"], rows: [["a", ""]] },
      { kind: "list", items: ["a"], ordered: true },
      { kind: "code", text: "+a", diff: true },
      { kind: "bars", items: [{ label: "a", value: 3, text: "3件" }] },
    ]);

    expect(result.ok).toBe(true);
  });

  it("部品が 1 つも無いページは拒否する", () => {
    expect(parseDeckBlocks([]).ok).toBe(false);
    expect(parseDeckBlocks(undefined).ok).toBe(false);
  });

  it.each([
    [[{ kind: "svg" }], 'blocks[0]: kind "svg" は使えません'],
    [[{ kind: "text", text: "a", style: "x" }], '"style" は使えません'],
    [[{ kind: "text", text: "a", html: "<b>" }], '"html" は使えません'],
    [
      [{ kind: "chips", items: [{ text: "a", tone: "red" }] }],
      'blocks[0].items[0].tone: tone "red" は使えません',
    ],
    [[{ kind: "cards", items: [{ tone: "ok" }] }], "のどれかが要ります"],
    [
      [{ kind: "table", head: ["a", "b"], rows: [["x"]] }],
      "列の数が揃っていません",
    ],
    [
      [{ kind: "bars", items: [{ label: "a", value: "3" }] }],
      "0 以上の数が要ります",
    ],
    [[{ kind: "flow", items: [] }], "1 つ以上の配列が要ります"],
  ])("語彙の外は、場所と使える語を添えて拒否する (%#)", (blocks, message) => {
    const result = parseDeckBlocks(blocks);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });
});

describe("renderInline", () => {
  it("色・コード・リンクだけを HTML にする", () => {
    expect(renderInline("{ng:4分の1}は `CSS` と [foo](src/foo.ts#L10)")).toBe(
      '<span class="ark-bk-tone" data-tone="ng">4分の1</span>は <code>CSS</code> と <a href="src/foo.ts#L10">foo</a>'
    );
  });

  it("HTML は文字として出す (タグを書いても効かない)", () => {
    const html = renderInline('<b style="color:red">x</b> {a:<i>y</i>} `<s>`');

    expect(html).not.toMatch(/<(b|i|s)[ >]/);
    expect(html).toContain("&lt;b style=&quot;color:red&quot;&gt;");
  });

  it("https のリンクは通し、外へ出る href はリンクにしない", () => {
    expect(renderInline("[docs](https://example.com/a)")).toContain(
      '<a href="https://example.com/a">'
    );
    for (const href of [
      "javascript:alert(1)",
      "../secret",
      "/etc/passwd",
      "#x",
    ]) {
      expect(renderInline(`[x](${href})`)).not.toContain("<a ");
    }
  });
});

describe("renderDeckBlocks", () => {
  it("見出しと部品を並べる", () => {
    const html = render(
      [{ kind: "chips", items: [{ text: "通る", tone: "ok" }] }],
      "{a:結論}の一文"
    );

    expect(html).toContain(
      '<h2 class="ark-bk-title"><span class="ark-bk-tone" data-tone="a">結論</span>の一文</h2>'
    );
    expect(html).toContain(
      '<span class="ark-bk-chip" data-tone="ok">通る</span>'
    );
  });

  it("棒は最大の値を 100% にして比で描く", () => {
    const html = render([
      {
        kind: "bars",
        items: [
          { label: "a", value: 200 },
          { label: "b", value: 50, tone: "ng" },
        ],
      },
    ]);

    expect(html).toContain('style="width:100.0%"');
    expect(html).toContain('<i data-tone="ng" style="width:25.0%"></i>');
    // 0 は 0 のまま描く (最小幅を当てて量があるように見せない)
    expect(
      render([
        {
          kind: "bars",
          items: [
            { label: "a", value: 0 },
            { label: "b", value: 9 },
          ],
        },
      ])
    ).toContain('<i style="width:0.0%"></i>');
    // text が無ければ値をそのまま出す
    expect(html).toContain("<b>200</b>");
  });

  it("diff を立てたコードだけ、+ / - の行に印を付ける", () => {
    const text = "-old\n+new\n same";

    expect(render([{ kind: "code", text, diff: true }])).toContain(
      '<span data-diff="del">-old</span><span data-diff="add">+new</span><span> same</span>'
    );
    expect(render([{ kind: "code", text }])).not.toContain("data-diff");
  });

  it("コードの中身はエスケープする", () => {
    expect(render([{ kind: "code", text: "<script>x</script>" }])).toContain(
      "&lt;script&gt;x&lt;/script&gt;"
    );
  });
});
