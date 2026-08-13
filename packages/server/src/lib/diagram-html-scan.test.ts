import { describe, expect, it } from "vitest";
import { scanDiagramHtmlStartTags } from "./diagram-html-scan.js";

describe("scanDiagramHtmlStartTags", () => {
  it("数値文字参照と対応対象の名前付き文字参照をデコードする", () => {
    const [tag] = scanDiagramHtmlStartTags(
      '<DIV data-value="&#97;&#x62;&#X43;&amp;&lt;&gt;&quot;&apos;&nbsp;&copy;" data-plain=unquoted>'
    );

    expect(tag).toEqual({
      name: "div",
      attributes: [
        { name: "data-value", value: "abC&<>\"'\u00a0&copy;" },
        { name: "data-plain", value: "unquoted" },
      ],
    });
  });
});
