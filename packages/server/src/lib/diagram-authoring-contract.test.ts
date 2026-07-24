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
});
