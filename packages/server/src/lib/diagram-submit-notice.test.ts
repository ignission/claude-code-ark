import { describe, expect, it } from "vitest";
import { extractDocBlocks } from "./diagram-doc-blocks.js";
import type { DiagramModel } from "./diagram-model.js";
import { buildSubmitNotice } from "./diagram-submit-notice.js";

const docModel = (label: string): DiagramModel =>
  ({
    version: 1,
    type: "doc",
    title: "t",
    nodes: [{ id: "p1", label }],
    edges: [],
    groups: [],
  }) as DiagramModel;

const flowModel = (label: string): DiagramModel =>
  ({
    version: 1,
    type: "flow",
    title: "t",
    nodes: [{ id: "n1", label }],
    edges: [],
    groups: [],
  }) as DiagramModel;

describe("buildSubmitNotice", () => {
  it("doc はブロック本文だけを送り、モデル差分の改名行を混ぜない", () => {
    const out = buildSubmitNotice({
      relPath: "a.diagram.html",
      baselineModel: docModel("むかし"),
      savedModel: docModel("いま"),
      baselineBodies: extractDocBlocks(
        `<p data-ark-id="p1" data-ark-author="human">むかし</p>`
      ),
      savedHtmlRaw: `<p data-ark-id="p1" data-ark-author="human">いま</p>`,
    });
    expect(out.lines).toEqual(["[p1] いま"]);
    expect(out.message).toContain("図の本文を編集しました（a.diagram.html）:");
    expect(out.message).toContain("（いずれも human として記録済み）");
    expect(out.message).not.toContain("改名");
  });

  it("human 印の無いブロックが混ざると、全体の主張を出さず行に印を付ける", () => {
    const out = buildSubmitNotice({
      relPath: "a.diagram.html",
      baselineModel: docModel("むかし"),
      savedModel: docModel("いま"),
      baselineBodies: extractDocBlocks(
        `<p data-ark-id="p1" data-ark-author="human">むかし</p>` +
          `<p data-ark-id="p2" data-ark-author="human">むかし</p>`
      ),
      savedHtmlRaw:
        `<p data-ark-id="p1" data-ark-author="human">いま</p>` +
        `<p data-ark-id="p2">外から変わった</p>`,
    });
    expect(out.lines).toEqual([
      "[p1] いま",
      "[p2] (human 印なし) 外から変わった",
    ]);
    expect(out.message).toContain("図の本文を編集しました（a.diagram.html）:");
    expect(out.message).not.toContain("いずれも human として記録済み");
  });

  it("human 印が1つも無ければ末尾の文言を出さない", () => {
    const out = buildSubmitNotice({
      relPath: "a.diagram.html",
      baselineModel: docModel("むかし"),
      savedModel: docModel("いま"),
      baselineBodies: extractDocBlocks(`<p data-ark-id="p1">むかし</p>`),
      savedHtmlRaw: `<p data-ark-id="p1">いま</p>`,
    });
    expect(out.lines).toEqual(["[p1] (human 印なし) いま"]);
    expect(out.message).not.toContain("human として記録済み");
  });

  it("組み上がった文面の全文", () => {
    const out = buildSubmitNotice({
      relPath: "board.diagram.html",
      baselineModel: docModel("むかし"),
      savedModel: docModel("いま"),
      baselineBodies: extractDocBlocks(
        `<p data-ark-id="s1" data-ark-author="human">むかし</p>` +
          `<p data-ark-id="s2" data-ark-author="human">むかし</p>`
      ),
      savedHtmlRaw:
        `<p data-ark-id="s1" data-ark-author="human">人間が直した</p>` +
        `<p data-ark-id="s2">別セッションが書いた</p>`,
    });
    expect(out.message).toBe(
      [
        "図の本文を編集しました（board.diagram.html）:",
        "- [s1] 人間が直した",
        "- [s2] (human 印なし) 別セッションが書いた",
      ].join("\n")
    );
  });

  it("全部 human なら末尾に記録済みの一文が付く", () => {
    const out = buildSubmitNotice({
      relPath: "board.diagram.html",
      baselineModel: docModel("むかし"),
      savedModel: docModel("いま"),
      baselineBodies: extractDocBlocks(
        `<p data-ark-id="s1" data-ark-author="human">むかし</p>`
      ),
      savedHtmlRaw: `<p data-ark-id="s1" data-ark-author="human">人間が直した</p>`,
    });
    expect(out.message).toBe(
      [
        "図の本文を編集しました（board.diagram.html）:",
        "- [s1] 人間が直した",
        "（いずれも human として記録済み）",
      ].join("\n")
    );
  });

  it("doc の baseline が無いときは何も送らず baseline だけ返す", () => {
    const out = buildSubmitNotice({
      relPath: "a.diagram.html",
      baselineModel: docModel("あ"),
      savedModel: docModel("あ"),
      baselineBodies: undefined,
      savedHtmlRaw: `<p data-ark-id="p1">あ</p>`,
    });
    expect(out.lines).toEqual([]);
    expect(out.message).toBeNull();
    expect(out.savedBodies.get("p1")?.text).toBe("あ");
  });

  it("graph は従来どおりモデル差分を送る", () => {
    const out = buildSubmitNotice({
      relPath: "b.diagram.html",
      baselineModel: flowModel("むかし"),
      savedModel: flowModel("いま"),
      baselineBodies: undefined,
      savedHtmlRaw: "",
    });
    expect(out.message).toContain("図を編集しました（b.diagram.html）:");
    expect(out.lines.join("")).toContain("改名");
  });

  it("変更が無ければ message は null", () => {
    const out = buildSubmitNotice({
      relPath: "b.diagram.html",
      baselineModel: flowModel("おなじ"),
      savedModel: flowModel("おなじ"),
      baselineBodies: undefined,
      savedHtmlRaw: "",
    });
    expect(out.lines).toEqual([]);
    expect(out.message).toBeNull();
  });
});
