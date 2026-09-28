import { describe, expect, it } from "vitest";
import { scanDiagramHtmlStartTags } from "./diagram-html-scan.js";

describe("scanDiagramHtmlStartTags", () => {
  it("数値文字参照と対応対象の名前付き文字参照をデコードする", () => {
    const html =
      '<DIV data-value="&#97;&#x62;&#X43;&amp;&lt;&gt;&quot;&apos;&nbsp;&copy;" data-plain=unquoted>';
    const [tag] = scanDiagramHtmlStartTags(html);

    expect(tag).toEqual({
      name: "div",
      attributes: [
        { name: "data-value", value: "abC&<>\"' &copy;" },
        { name: "data-plain", value: "unquoted" },
      ],
      start: 0,
      end: html.length - 1,
    });
  });

  it("開始タグの開始位置と終了位置を返す", () => {
    const html = `<div><p data-ark-id="s1-p1">本文</p></div>`;
    const tags = scanDiagramHtmlStartTags(html);
    const p = tags.find(tag => tag.name === "p");
    expect(p).toBeDefined();
    expect(html.slice(p!.start, p!.end + 1)).toBe(`<p data-ark-id="s1-p1">`);
  });

  it("textarea と title の中身はタグとして数えず、要素そのものは数える", () => {
    const html =
      '<title data-x="t">&lt;<section data-ark-page="fake-1"></title>' +
      '<textarea data-ark-id="note"><section data-ark-page="fake-2"></TEXTAREA>' +
      '<section data-ark-page="real"></section>';
    const tags = scanDiagramHtmlStartTags(html);

    expect(tags.map(tag => tag.name)).toEqual(["title", "textarea", "section"]);
    expect(
      tags.flatMap(tag =>
        tag.attributes.filter(a => a.name === "data-ark-page").map(a => a.value)
      )
    ).toEqual(["real"]);
  });
});
