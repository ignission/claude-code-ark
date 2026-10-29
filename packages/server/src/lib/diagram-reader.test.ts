import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIAGRAM_DIR } from "@ark/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DIAGRAM_CSP } from "./diagram-file.js";
import { DIAGRAM_KEYNAV_LAYER_MARKER } from "./diagram-keynav-layer.js";
import { DIAGRAM_LINK_LAYER_MARKER } from "./diagram-link-layer.js";
import { readDiagram, readDiagramTitle } from "./diagram-reader.js";

let wt: string;
let dir: string;
let outsideDir: string;

beforeEach(() => {
  wt = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ark-diagram-read-"))
  );
  dir = path.join(wt, DIAGRAM_DIR);
  fs.mkdirSync(dir, { recursive: true });
  outsideDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ark-diagram-read-outside-"))
  );
});

afterEach(() => {
  fs.rmSync(wt, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

function write(name: string, body: string, head = "") {
  fs.writeFileSync(
    path.join(dir, name),
    `<!doctype html><html><head>${head}</head><body>${body}</body></html>`
  );
}

describe("readDiagram", () => {
  it("書いた HTML に meta CSP とリンク・キーの層だけを足して返す", async () => {
    write("a.diagram.html", "<div>図</div><script>draw()</script>");

    const result = await readDiagram(wt, "a.diagram.html");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.html).toContain(DIAGRAM_CSP);
      expect(result.html).toContain(DIAGRAM_LINK_LAYER_MARKER);
      expect(result.html).toContain(DIAGRAM_KEYNAV_LAYER_MARKER);
      expect(result.html).toContain("<div>図</div><script>draw()</script>");
    }
  });

  it("モデルブロックが無い HTML もそのまま配信する", async () => {
    fs.writeFileSync(
      path.join(dir, "b.diagram.html"),
      "<html><body>図だけ</body></html>"
    );

    const result = await readDiagram(wt, "b.diagram.html");

    expect(result.ok).toBe(true);
  });

  it("存在しないファイルは 404 を返す", async () => {
    const result = await readDiagram(wt, "missing.diagram.html");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it("旧 docs/diagrams にだけある同名ファイルは読まない", async () => {
    const legacyDir = path.join(wt, "docs", "diagrams");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, "legacy.diagram.html"),
      `<!doctype html><html><head></head><body>` +
        `<div>旧ルート</div></body></html>`
    );

    const result = await readDiagram(wt, "legacy.diagram.html");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it("worktree の外を指す指定は 403 を返す", async () => {
    const result = await readDiagram(wt, "../../x.diagram.html");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("EACCES (権限エラー) は 404 に畳まず 403 で errno を含めて返す", async () => {
    // ENOENT 以外の FS エラーまで「見つかりません」に畳むと、Claude 側は
    // 「ファイルが無い」と誤解して無意味な再生成を繰り返してしまう。
    write("perm.diagram.html", "<div>図</div>");
    const target = path.join(dir, "perm.diagram.html");
    fs.chmodSync(target, 0o000);

    try {
      const result = await readDiagram(wt, "perm.diagram.html");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(403);
        expect(result.error).toContain("EACCES");
      }
    } finally {
      fs.chmodSync(target, 0o644);
    }
  });

  it("EISDIR (ディレクトリ) は 404 に畳まず 500 で errno を含めて返す", async () => {
    fs.mkdirSync(path.join(dir, "adir.diagram.html"));

    const result = await readDiagram(wt, "adir.diagram.html");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.error).toContain("EISDIR");
    }
  });

  it("worktree 外を指すシンボリックリンクは 403 を返す", async () => {
    // DIAGRAM_DIR 配下の見た目上は正しいパスでも、実体（realpath）が
    // worktree 外を指すシンボリックリンクなら文字列上の封じ込め
    // (resolveDiagramPath) だけでは検出できない。fs 実体側の検証が必須。
    const outsideTarget = path.join(outsideDir, "secret.diagram.html");
    fs.writeFileSync(
      outsideTarget,
      `<!doctype html><html><head></head><body>` +
        `<div>秘密</div></body></html>`
    );
    fs.symlinkSync(outsideTarget, path.join(dir, "evil.diagram.html"));

    const result = await readDiagram(wt, "evil.diagram.html");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.error).toContain(DIAGRAM_DIR);
      expect(result.error).not.toContain("docs/diagrams");
    }
  });
});

describe("readDiagramTitle", () => {
  it("<title> を返し、無ければ null", async () => {
    write("t.diagram.html", "<div>x</div>", "<title>構成図</title>");
    write("u.diagram.html", "<div>x</div>");

    const titled = await readDiagramTitle(wt, "t.diagram.html");
    const untitled = await readDiagramTitle(wt, "u.diagram.html");

    expect(titled.ok && titled.title).toBe("構成図");
    expect(untitled.ok && untitled.title).toBeNull();
  });
});
