/**
 * markdown → doc 型ボードの変換が、配信側の検証 (readDiagram: model 抽出 →
 * parse → anchors → authorship) をそのまま通ることを確かめる。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIAGRAM_DIR } from "@ark/shared";
import { afterEach, describe, expect, it } from "vitest";
import { readDiagram } from "./diagram-reader.js";
import { markdownToBoardDoc } from "./markdown-to-board-doc.js";

const tempDirs: string[] = [];

function makeWorktree(): string {
  // macOS の tmpdir は symlink 経由なので realpath に揃える
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ark-board-doc-"))
  );
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SAMPLE = `3案とも描画を確認し、表記ゆれ (日本語と英数字の間の空白) とC案の位置ずれを直しました。

## 3案の違い

| 案 | 見た目 | 向く場面 |
|---|---|---|
| A | 端末に近い | 既存ユーザー |
| B | カード型 | モバイル |
| C | ガラス調 <configDir> | 新規 |

- **A案**: \`TerminalPane\` をそのまま使う
- B案: [設計書](https://example.com/spec) を参照
  - 入れ子の項目
- [ ] 未完了のタスク
- [x] 完了したタスク

> 引用: 会話モードではセッション名が消える

\`\`\`ts
const x = "<script>alert(1)</script>";
\`\`\`

次は <b>生の HTML</b> と & 記号。`;

describe("markdownToBoardDoc", () => {
  it("生成物が readDiagram の検証 (model / anchors / authorship) を通る", async () => {
    const worktree = makeWorktree();
    const { html, model, title } = markdownToBoardDoc(SAMPLE, "test");
    const relPath = `${DIAGRAM_DIR}/_auto/s1/x.diagram.html`;
    const absPath = path.join(worktree, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, html);

    const result = await readDiagram(worktree, relPath);
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.model.type).toBe("doc");
    expect(result.model.nodes.length).toBe(model.nodes.length);
    expect(title).toBe("3案の違い");
  });

  it("kind の語彙と id の階層が doc 規約どおりになる", () => {
    const { model } = markdownToBoardDoc(SAMPLE, "test");
    const kinds = new Set(model.nodes.map(n => n.kind));
    expect([...kinds].sort()).toEqual(
      [
        "code",
        "list",
        "list-item",
        "paragraph",
        "quote",
        "section",
        "table",
        "table-row",
        "task",
      ].sort()
    );
    const rows = model.nodes.filter(n => n.kind === "table-row").map(n => n.id);
    expect(rows).toEqual(["b3-r1", "b3-r2", "b3-r3"]);
    const ids = model.nodes.map(n => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("返答の生 HTML と山括弧は文字として出し、script は実行可能な形にしない", () => {
    const { html } = markdownToBoardDoc(SAMPLE, "test");
    expect(html).toContain("&lt;configDir&gt;");
    expect(html).toContain("&lt;b&gt;生の HTML&lt;/b&gt;");
    expect(html).not.toContain("<b>生の HTML</b>");
    // code block 内の <script> はエスケープされる
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html.match(/<script/g)?.length).toBe(1);
    // 危険な href は落とし、https はリンクにする
    expect(html).toContain('href="https://example.com/spec"');
  });

  it("全ブロックに data-ark-author=claude が付き、label は 80 文字以内の抜粋になる", () => {
    const long = `${"あ".repeat(200)}\n\n## 見出し`;
    const { html, model } = markdownToBoardDoc(long, "test");
    const authored = html.match(/data-ark-author="claude"/g)?.length ?? 0;
    expect(authored).toBe(model.nodes.length);
    const paragraph = model.nodes.find(n => n.kind === "paragraph");
    expect(Array.from(paragraph?.label ?? "").length).toBe(80);
    expect(paragraph?.label.endsWith("…")).toBe(true);
  });

  it("見出しが無ければ先頭の文を題名にする", () => {
    const { title } = markdownToBoardDoc("まず結論から。\n\n本文。", "test");
    expect(title).toBe("まず結論から。");
    expect(markdownToBoardDoc("3案とも確認した。", "t").title).toBe(
      "3案とも確認した。"
    );
    expect(markdownToBoardDoc("- 1. 手順の説明", "t").title).toBe("手順の説明");
  });
});
