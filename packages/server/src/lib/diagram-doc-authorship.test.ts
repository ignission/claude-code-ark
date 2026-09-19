import { describe, expect, it } from "vitest";
import {
  DOC_AUTHOR_ATTRIBUTE,
  DOC_AUTHOR_VALUES,
  isHumanAuthoredBlock,
  validateDiagramDocAuthorship,
} from "./diagram-doc-authorship.js";
import type { DiagramModel } from "./diagram-model.js";

function model(type: string | undefined): DiagramModel {
  return {
    version: 1,
    type,
    nodes: [
      { id: "s1", label: "確認事項" },
      { id: "s1-p1", label: "推奨" },
      { id: "s1-p2", label: "回答" },
    ],
    edges: [],
    groups: [],
  };
}

describe("validateDiagramDocAuthorship", () => {
  it("語彙は human と claude の 2 値で、属性名は data-ark-author である", () => {
    expect(DOC_AUTHOR_ATTRIBUTE).toBe("data-ark-author");
    expect([...DOC_AUTHOR_VALUES]).toEqual(["human", "claude"]);
  });

  it("human / claude / 無印が混在しても成功する", () => {
    const html =
      '<section data-ark-id="s1"><p data-ark-id="s1-p1" data-ark-author="claude">推奨</p><p data-ark-author=\'human\' data-ark-id="s1-p2">回答</p></section>';

    expect(validateDiagramDocAuthorship(html, model("doc"))).toEqual({
      ok: true,
    });
  });

  it("属性が 1 つも無い既存の doc はそのまま成功する", () => {
    const html =
      '<section data-ark-id="s1"><p data-ark-id="s1-p1"></p><p data-ark-id="s1-p2"></p></section>';

    expect(validateDiagramDocAuthorship(html, model("doc"))).toEqual({
      ok: true,
    });
  });

  it.each([
    {
      name: "語彙外の値",
      html: '<section data-ark-id="s1"><p data-ark-id="s1-p1" data-ark-author="agent"></p><p data-ark-id="s1-p2"></p></section>',
      expected: ["s1-p1", "agent"],
    },
    {
      name: "大文字の値",
      html: '<section data-ark-id="s1"><p data-ark-id="s1-p1" data-ark-author="Human"></p><p data-ark-id="s1-p2"></p></section>',
      expected: ["s1-p1", "Human"],
    },
    {
      name: "空の値",
      html: '<section data-ark-id="s1"><p data-ark-id="s1-p1" data-ark-author=""></p><p data-ark-id="s1-p2"></p></section>',
      expected: ["s1-p1", "(空)"],
    },
    {
      name: "data-ark-id の無い要素への付与",
      html: '<section data-ark-id="s1"><p data-ark-id="s1-p1"></p><p data-ark-id="s1-p2"><em data-ark-author="human">B 案</em></p></section>',
      expected: ["data-ark-id"],
    },
    {
      name: "1 要素内の属性重複",
      html: '<section data-ark-id="s1"><p data-ark-id="s1-p1" data-ark-author="human" data-ark-author="claude"></p><p data-ark-id="s1-p2"></p></section>',
      expected: ["s1-p1"],
    },
  ])("$name は error を返す", ({ html, expected }) => {
    const result = validateDiagramDocAuthorship(html, model("doc"));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const fragment of expected) expect(result.error).toContain(fragment);
  });

  it("script/style/comment 内の文字列は検査しない", () => {
    const html = `
      <section data-ark-id="s1">
        <p data-ark-id="s1-p1" data-ark-author="claude"></p>
        <p data-ark-id="s1-p2"></p>
        <script>const sample = '<i data-ark-author="agent">';</script>
        <style>[data-ark-author="bogus"] { color: red; }</style>
        <!-- <i data-ark-author="nobody"></i> -->
      </section>
    `;

    expect(validateDiagramDocAuthorship(html, model("doc"))).toEqual({
      ok: true,
    });
  });

  it("別の属性値に含まれる data-ark-author を属性と数えない", () => {
    const html =
      '<section data-ark-id="s1"><p data-ark-id="s1-p1" title="data-ark-author=agent"></p><p data-ark-id="s1-p2"></p></section>';

    expect(validateDiagramDocAuthorship(html, model("doc"))).toEqual({
      ok: true,
    });
  });

  it.each([undefined, "er", "flow", "custom-graph"])(
    "doc 以外 (%s) は検査せず成功する",
    type => {
      const html =
        '<div data-model-id="s1" data-ark-author="agent"><div data-model-id="s1-p1"></div></div>';

      expect(validateDiagramDocAuthorship(html, model(type))).toEqual({
        ok: true,
      });
    }
  );
});

describe("isHumanAuthoredBlock", () => {
  it("ブロック自身の開始タグが human なら true", () => {
    expect(
      isHumanAuthoredBlock(
        `<p data-ark-id="p1" data-ark-author="human">本文</p>`
      )
    ).toBe(true);
  });

  it("無印は false", () => {
    expect(isHumanAuthoredBlock(`<p data-ark-id="p1">本文</p>`)).toBe(false);
  });

  it("claude は false", () => {
    expect(
      isHumanAuthoredBlock(
        `<p data-ark-id="p1" data-ark-author="claude">本文</p>`
      )
    ).toBe(false);
  });

  it("語彙外の値も human ではないので false", () => {
    expect(
      isHumanAuthoredBlock(
        `<p data-ark-id="p1" data-ark-author="agent">本文</p>`
      )
    ).toBe(false);
  });

  it("子孫が human でも、自身が無印なら false", () => {
    expect(
      isHumanAuthoredBlock(
        `<section data-ark-id="s1">` +
          `<p data-ark-id="s1-p1" data-ark-author="human">本文</p>` +
          `</section>`
      )
    ).toBe(false);
  });

  it("自身が human なら、子孫が claude でも true", () => {
    expect(
      isHumanAuthoredBlock(
        `<section data-ark-id="s1" data-ark-author="human">` +
          `<p data-ark-id="s1-p1" data-ark-author="claude">本文</p>` +
          `</section>`
      )
    ).toBe(true);
  });

  it("開始タグが無ければ false", () => {
    expect(isHumanAuthoredBlock("ただの文字列")).toBe(false);
  });
});
