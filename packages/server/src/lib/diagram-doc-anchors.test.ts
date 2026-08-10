import { describe, expect, it } from "vitest";
import { validateDiagramDocAnchors } from "./diagram-doc-anchors.js";
import type { DiagramModel } from "./diagram-model.js";

function model(type: string | undefined): DiagramModel {
  return {
    version: 1,
    type,
    nodes: [
      { id: "s1", label: "概要" },
      { id: "s1-p1", label: "本文" },
      { id: "s1-t1-r1", label: "明細" },
    ],
    edges: [],
    groups: [],
  };
}

describe("validateDiagramDocAnchors", () => {
  it("doc の全 node id が opening tag に1回ずつあれば成功する", () => {
    const result = validateDiagramDocAnchors(
      "<section data-ark-id=\"s1\"><p data-ark-id='s1-p1'>本文</p><div data-ark-id=s1-t1-r1>明細</div></section>",
      model("doc")
    );

    expect(result).toEqual({ ok: true });
  });

  it.each([
    {
      name: "node に対応する anchor がない",
      html: '<section data-ark-id="s1"><p data-ark-id="s1-p1"></p></section>',
      id: "s1-t1-r1",
    },
    {
      name: "model にない anchor がある",
      html: '<section data-ark-id="s1"><p data-ark-id="s1-p1"></p><div data-ark-id="s1-t1-r1"></div><i data-ark-id="unknown"></i></section>',
      id: "unknown",
    },
    {
      name: "同じ anchor の要素が2つある",
      html: '<section data-ark-id="s1"><p data-ark-id="s1-p1"></p><div data-ark-id="s1-t1-r1"></div><i data-ark-id="s1-p1"></i></section>',
      id: "s1-p1",
    },
    {
      name: "1要素内に属性が重複する",
      html: '<section data-ark-id="s1" data-ark-id=\'s1\'><p data-ark-id="s1-p1"></p><div data-ark-id="s1-t1-r1"></div></section>',
      id: "s1",
    },
  ])("$name とき id を含む error を返す", ({ html, id }) => {
    const result = validateDiagramDocAnchors(html, model("doc"));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(id);
  });

  it("script/style/comment 内の文字列を anchor と数えない", () => {
    const html = `
      <section data-ark-id="s1">
        <p data-ark-id='s1-p1'></p>
        <div data-ark-id=s1-t1-r1></div>
        <script>const sample = '<i data-ark-id="fake-script">';</script>
        <style>[data-ark-id="fake-style"] { color: red; }</style>
        <!-- <i data-ark-id="fake-comment"></i> -->
      </section>
    `;

    expect(validateDiagramDocAnchors(html, model("doc"))).toEqual({ ok: true });
  });

  it("別の属性値に含まれる data-ark-id を anchor と数えない", () => {
    const emptyModel = { ...model("doc"), nodes: [] };

    expect(
      validateDiagramDocAnchors(
        '<div title="x data-ark-id=s6"></div>',
        emptyModel
      )
    ).toEqual({ ok: true });
  });

  it("実属性の値だけを返し別の属性値に含まれる文字列を無視する", () => {
    const singleNodeModel = {
      ...model("doc"),
      nodes: [{ id: "s6", label: "本文" }],
    };

    expect(
      validateDiagramDocAnchors(
        '<div data-ark-id="s6" title="data-ark-id=s7"></div>',
        singleNodeModel
      )
    ).toEqual({ ok: true });
  });

  it.each([undefined, "er", "flow", "custom-graph"])(
    "doc 以外 (%s) は data-model-id のまま成功する",
    type => {
      const html =
        '<div data-model-id="s1"><div data-model-id="s1-p1"></div></div>';

      expect(validateDiagramDocAnchors(html, model(type))).toEqual({
        ok: true,
      });
    }
  );
});
