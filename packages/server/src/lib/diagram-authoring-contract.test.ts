import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SKILL_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../.claude/skills/diagram-authoring/SKILL.md"
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
});
