import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DIAGRAM_CSP } from "./diagram-file.js";
import { readDiagram } from "./diagram-reader.js";

let wt: string;
let dir: string;
let outsideDir: string;

const MODEL = JSON.stringify({
  version: 1,
  title: "購買フロー",
  nodes: [{ id: "order", label: "Order" }],
});

beforeEach(() => {
  wt = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ark-diagram-read-"))
  );
  dir = path.join(wt, "docs", "diagrams");
  fs.mkdirSync(dir, { recursive: true });
  outsideDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ark-diagram-read-outside-"))
  );
});

afterEach(() => {
  fs.rmSync(wt, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

function write(name: string, body: string) {
  fs.writeFileSync(
    path.join(dir, name),
    `<!doctype html><html><head></head><body>` +
      `<script type="application/json" id="ark-diagram-model">${MODEL}</script>` +
      body +
      `</body></html>`
  );
}

describe("readDiagram", () => {
  it("モデルと meta CSP 注入済み HTML を返す", async () => {
    write("a.diagram.html", "<div>図</div>");

    const result = await readDiagram(wt, "a.diagram.html");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.title).toBe("購買フロー");
      expect(result.html).toContain(DIAGRAM_CSP);
    }
  });

  it("存在しないファイルは 404 を返す", async () => {
    const result = await readDiagram(wt, "missing.diagram.html");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it("worktree の外を指す指定は 403 を返す", async () => {
    const result = await readDiagram(wt, "../../x.diagram.html");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("モデルブロックが無いファイルは 422 を返す", async () => {
    fs.writeFileSync(
      path.join(dir, "b.diagram.html"),
      "<html><body>図だけ</body></html>"
    );

    const result = await readDiagram(wt, "b.diagram.html");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(422);
  });

  it("worktree 外を指すシンボリックリンクは 403 を返す", async () => {
    // docs/diagrams 配下の見た目上は正しいパスでも、実体（realpath）が
    // worktree 外を指すシンボリックリンクなら文字列上の封じ込め
    // (resolveDiagramPath) だけでは検出できない。fs 実体側の検証が必須。
    const outsideTarget = path.join(outsideDir, "secret.diagram.html");
    fs.writeFileSync(
      outsideTarget,
      `<!doctype html><html><head></head><body>` +
        `<script type="application/json" id="ark-diagram-model">${MODEL}</script>` +
        `<div>秘密</div></body></html>`
    );
    fs.symlinkSync(outsideTarget, path.join(dir, "evil.diagram.html"));

    const result = await readDiagram(wt, "evil.diagram.html");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });
});
