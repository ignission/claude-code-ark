import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateDiagramDocAnchors } from "./diagram-doc-anchors.js";
import { validateDiagramDocAuthorship } from "./diagram-doc-authorship.js";
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
const REVIEW_SAMPLE_PATH = path.resolve(
  REPOSITORY_ROOT,
  ".claude/diagrams/_examples/change-review.diagram.html"
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

  it("文書型の本文 authorship（data-ark-author）の contract を定義する", () => {
    const skill = fs.readFileSync(SKILL_PATH, "utf-8");

    expect(skill).toContain("### 本文の書き手（`data-ark-author`）");
    expect(skill).toContain('`data-ark-author="human"`');
    expect(skill).toContain("値は `human` と `claude` の 2 つだけ");
    // 自分の書き手印は廃止した。規約が「claude を付ける」に戻っていないこと
    expect(skill).toContain("自分が書いたブロックに印は付けない");
    expect(skill).not.toContain('`data-ark-author="claude"` を付ける');
    expect(skill).toContain("model に書き手を複製しない");
    expect(skill).toContain("人間が手を入れた本文");
    expect(skill).not.toContain("だけを人間の決定として扱う");
    expect(skill).toContain("容器ブロック");
  });

  it("公開用の受注フロー文書サンプルが doc contract を満たす", () => {
    const html = fs.readFileSync(DOC_SAMPLE_PATH, "utf-8");
    const result = extractModel(html);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.model.type).toBe("doc");
    expect(validateDiagramDocAnchors(html, result.model)).toEqual({ ok: true });
    expect(validateDiagramDocAuthorship(html, result.model)).toEqual({
      ok: true,
    });
    expect(html).toContain('data-ark-author="human"');
    // Claude 側の印は廃止したので、公開サンプルにも残さない
    expect(html).not.toContain('data-ark-author="claude"');

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

  it("コードを指す語のリンクと、変更レビュー文書の型を定義する", () => {
    const skill = fs.readFileSync(SKILL_PATH, "utf-8");

    expect(skill).toContain("コードを指す語はリンクにする");
    expect(skill).toContain('href="src/');
    expect(skill).toContain("#L10-L24");
    expect(skill).toContain("worktree 相対");
    expect(skill).toContain("## 変更レビュー文書");
    for (const heading of ["what / why", "要件", "設計", "実装"]) {
      expect(skill).toContain(heading);
    }
    expect(skill).toContain("図は 1 枚");
    for (const kind of ["`flow`", "`state`", "`er`", "`context-map`"]) {
      expect(skill).toContain(kind);
    }
    expect(skill).toContain("エントリポイント");
    // 実装の節は call-tree 1 枚で、文章で経路をなぞり直さない
    expect(skill).toContain("`call-tree` を 1 枚");
    expect(skill).toContain("文章で図をなぞり直さない");
    expect(skill).not.toMatch(/(?:docs|\.claude)\/diagrams/);
  });

  it("sequence と call-tree の語彙を定義する", () => {
    const skill = fs.readFileSync(SKILL_PATH, "utf-8");

    expect(skill).toContain("### sequence と call-tree の語彙");
    expect(skill).toContain("| `sequence` |");
    expect(skill).toContain("| `call-tree` |");
    // 座標を持たないこと（canvas に載せると時間順と入れ子が壊れる）
    expect(skill).toContain("この 2 つは座標を持たない");
    for (const token of [
      "`edge.ext.style`",
      "`edge.ext.source`",
      "`node.ext.added`",
      "`node.ext.via`",
    ]) {
      expect(skill).toContain(token);
    }
  });

  it("変更レビュー文書の見本が doc contract を満たし、コードへのリンクを含む", () => {
    const html = fs.readFileSync(REVIEW_SAMPLE_PATH, "utf-8");
    const result = extractModel(html);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.model.type).toBe("doc");
    expect(validateDiagramDocAnchors(html, result.model)).toEqual({ ok: true });
    expect(validateDiagramDocAuthorship(html, result.model)).toEqual({
      ok: true,
    });
    expect(html).toMatch(/<a href="[^"/#:][^"]*#L\d+(?:-L\d+)?">/);
    expect(html).not.toMatch(/<a href="https?:/);
    const kinds = new Set(result.model.nodes.map(node => node.kind));
    expect(kinds.has("section")).toBe(true);
    expect(kinds.has("figure")).toBe(true);
  });
});
