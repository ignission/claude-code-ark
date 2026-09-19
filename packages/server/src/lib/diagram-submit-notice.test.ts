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
      baselineBodies: extractDocBlocks(`<p data-ark-id="p1">むかし</p>`),
      savedHtmlRaw: `<p data-ark-id="p1">いま</p>`,
    });
    expect(out.lines).toEqual(["[p1] いま"]);
    expect(out.message).toContain("図の本文を編集しました（a.diagram.html）:");
    expect(out.message).toContain("（いずれも human として記録済み）");
    expect(out.message).not.toContain("改名");
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
