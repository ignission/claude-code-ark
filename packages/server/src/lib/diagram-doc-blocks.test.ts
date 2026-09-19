import { describe, expect, it } from "vitest";
import { extractDocBlocks } from "./diagram-doc-blocks.js";

describe("extractDocBlocks", () => {
  it("data-ark-id を持つ要素を id で引けるようにする", () => {
    const html = `<body><p data-ark-id="s1-p1">ひとつめ</p><p data-ark-id="s1-p2">ふたつめ</p></body>`;
    const blocks = extractDocBlocks(html);
    expect([...blocks.keys()]).toEqual(["s1-p1", "s1-p2"]);
    expect(blocks.get("s1-p1")?.text).toBe("ひとつめ");
    expect(blocks.get("s1-p1")?.html).toBe(
      `<p data-ark-id="s1-p1">ひとつめ</p>`
    );
  });

  it("入れ子のブロックを取り違えない", () => {
    const html = `<section data-ark-id="s1"><p data-ark-id="s1-p1">なか</p></section>`;
    const blocks = extractDocBlocks(html);
    expect(blocks.get("s1")?.text).toBe("なか");
    expect(blocks.get("s1-p1")?.html).toBe(`<p data-ark-id="s1-p1">なか</p>`);
  });

  it("同じタグ名の入れ子でも対応する閉じタグを選ぶ", () => {
    const html = `<div data-ark-id="a"><div>なか</div>そと</div>`;
    expect(extractDocBlocks(html).get("a")?.text).toBe("なか そと");
  });

  it("void 要素は内側を持たない", () => {
    const html = `<img data-ark-id="s1-f1" alt="図">`;
    const blocks = extractDocBlocks(html);
    expect(blocks.get("s1-f1")?.text).toBe("");
    expect(blocks.get("s1-f1")?.html).toBe(
      `<img data-ark-id="s1-f1" alt="図">`
    );
  });

  it("本文の空白を1つに畳む", () => {
    const html = '<p data-ark-id="p">  あ\n  い  </p>';
    expect(extractDocBlocks(html).get("p")?.text).toBe("あ い");
  });

  it("閉じタグ名の前方一致に惑わされない（`</p` と `</pre`）", () => {
    const html = `<p data-ark-id="p1">まえ<pre>なか</pre>あと</p>`;
    const blocks = extractDocBlocks(html);
    expect(blocks.get("p1")?.html).toBe(
      `<p data-ark-id="p1">まえ<pre>なか</pre>あと</p>`
    );
    expect(blocks.get("p1")?.text).toBe("まえ なか あと");
  });

  it("text で HTML エンティティをデコードする", () => {
    const html = '<p data-ark-id="e">if a &lt; b &amp; c &gt; d</p>';
    const blocks = extractDocBlocks(html);
    expect(blocks.get("e")?.text).toBe("if a < b & c > d");
  });

  it("コメントの中の `</p>` に惑わされず本文を最後まで拾う", () => {
    const html =
      '<p data-ark-id="x">a<!-- memo: </p> should not close -->b</p>';
    const blocks = extractDocBlocks(html);
    expect(blocks.get("x")?.html).toBe(html);
    expect(blocks.get("x")?.text).toBe("a b");
  });

  it("属性値の中の `</p>` に惑わされず本文を最後まで拾う", () => {
    const html = '<p data-ark-id="x">a<a title="</p>">link</a>b</p>';
    const blocks = extractDocBlocks(html);
    expect(blocks.get("x")?.html).toBe(html);
    expect(blocks.get("x")?.text).toBe("a link b");
  });

  it("void 要素の一覧に param を含む", () => {
    const html = '<param data-ark-id="s1-f1" name="v" value="1">';
    const blocks = extractDocBlocks(html);
    expect(blocks.get("s1-f1")?.text).toBe("");
    expect(blocks.get("s1-f1")?.html).toBe(html);
  });

  it("閉じタグが見つからないブロックは黙って読み飛ばす（意図した仕様）", () => {
    const html = '<p data-ark-id="p1">閉じタグが無い';
    const blocks = extractDocBlocks(html);
    expect(blocks.has("p1")).toBe(false);
  });

  it("script の raw text 中の閉じタグに惑わされず、中身を本文に含めない", () => {
    const html =
      '<p data-ark-id="p1">前<script>const x = "</p>"</script>後</p>';
    const blocks = extractDocBlocks(html);
    expect(blocks.get("p1")?.html).toBe(html);
    expect(blocks.get("p1")?.text).toBe("前 後");
  });

  it("style の raw text 中の閉じタグにも惑わされない", () => {
    const html =
      '<p data-ark-id="p1">前<style>p::after{content:"</p>"}</style>後</p>';
    const blocks = extractDocBlocks(html);
    expect(blocks.get("p1")?.html).toBe(html);
    expect(blocks.get("p1")?.text).toBe("前 後");
  });
});
