import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateDiagramDocAnchors } from "./diagram-doc-anchors.js";
import { extractModel } from "./diagram-file.js";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.."
);
const SKILL_PATH = path.resolve(
  REPOSITORY_ROOT,
  ".claude/skills/diagram-authoring/SKILL.md"
);
const DOC_SAMPLE_PATH = path.resolve(
  REPOSITORY_ROOT,
  ".claude/diagrams/_examples/order-flow-design.diagram.html"
);
const DOC_SAMPLE_COMMENTS_PATH = DOC_SAMPLE_PATH.replace(
  /\.diagram\.html$/u,
  ".comments.json"
);

describe("diagram-authoring skill の書き出し先 contract", () => {
  it("board_open.path の説明を正準 source とし directory literal を保持しない", () => {
    const skill = fs.readFileSync(SKILL_PATH, "utf-8");

    expect(skill).toContain("`board_open.path` の説明");
    expect(skill).toContain("parent directory が存在しない場合だけ作成");
    expect(skill).not.toMatch(/(?:docs|\.claude)\/diagrams/);
  });

  it("文書型の node と HTML 投影の authoring contract を定義する", () => {
    const skill = fs.readFileSync(SKILL_PATH, "utf-8");

    expect(skill).toContain('type: "doc"');
    expect(skill).not.toMatch(/^\|\s*`doc`\s*\|/m);
    for (const kind of [
      "section",
      "paragraph",
      "table",
      "table-row",
      "list",
      "list-item",
      "panel",
      "figure",
      "code",
      "quote",
      "task",
      "summary",
    ]) {
      expect(skill).toContain(`\`${kind}\``);
    }
    expect(skill).toContain("`data-ark-id`");
    expect(skill).toContain("階層 prefix");
    expect(skill).toContain("行単位を既定");
    expect(skill).toContain("本文は HTML");
    expect(skill).toContain("60〜80文字の抜粋");
    expect(skill).toContain("外部リソースを参照しない");
    for (const id of [
      "`s6`",
      "`s6-p1`",
      "`s6-t1`",
      "`s6-t1-r2`",
      "`s6-t1-r2-c3`",
    ]) {
      expect(skill).toContain(id);
    }
    expect(skill).toContain("`<nodeId>--f<n>`");
    expect(skill).toContain(
      "`DiagramModel` や `DiagramNode` に文書専用 field を追加しない"
    );
    expect(skill).toContain("flat groups");
    expect(skill).toContain("全文を model に複製しない");
  });

  it("公開用の受注フロー文書サンプルが doc contract を満たす", () => {
    const html = fs.readFileSync(DOC_SAMPLE_PATH, "utf-8");
    const result = extractModel(html);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.model.type).toBe("doc");
    expect(validateDiagramDocAnchors(html, result.model)).toEqual({ ok: true });

    const allowedKinds = new Set([
      "section",
      "paragraph",
      "table",
      "table-row",
      "list",
      "list-item",
      "panel",
      "figure",
      "code",
      "quote",
      "task",
      "summary",
    ]);
    expect(
      result.model.nodes.every(node => allowedKinds.has(node.kind ?? ""))
    ).toBe(true);
    expect(new Set(result.model.nodes.map(node => node.kind))).toEqual(
      new Set([
        "section",
        "panel",
        "table",
        "table-row",
        "paragraph",
        "summary",
      ])
    );
    expect(
      result.model.nodes
        .filter(node => node.id !== "s1")
        .every(node => node.id.startsWith("s1-"))
    ).toBe(true);
    expect(result.model.edges).toEqual([]);
    expect(result.model.groups.length).toBeGreaterThan(0);
    expect(html).toContain("<style>");
    expect(html).not.toMatch(
      /(?:https?:\/\/|<link\b|@import\b|@font-face\b|<meta\b[^>]*content-security-policy)/i
    );
    expect(fs.existsSync(DOC_SAMPLE_COMMENTS_PATH)).toBe(false);
  });
});
