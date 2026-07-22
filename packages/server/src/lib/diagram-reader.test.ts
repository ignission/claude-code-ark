import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DIAGRAM_CSP } from "./diagram-file.js";
import { DIAGRAM_HARNESS_MARKER } from "./diagram-harness.js";
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

function write(name: string, body: string, model = MODEL) {
  fs.writeFileSync(
    path.join(dir, name),
    `<!doctype html><html><head></head><body>` +
      `<script type="application/json" id="ark-diagram-model">${model}</script>` +
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

  it("graph の ext と配信時 harness を返す", async () => {
    const graphModel = JSON.stringify({
      version: 1,
      nodes: [
        { id: "order", label: "Order", ext: { x: 40, y: 50 } },
        { id: "user", label: "User", ext: { x: 360, y: 180 } },
      ],
      edges: [
        { id: "e_order_user", from: "order", to: "user", label: "belongs to" },
      ],
      groups: [],
    });
    write(
      "graph.diagram.html",
      '<div data-ark-container="graph"><div data-model-id="order">Order</div><div data-model-id="user">User</div></div>',
      graphModel
    );

    const result = await readDiagram(wt, "graph.diagram.html");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.nodes[0]?.ext).toEqual({ x: 40, y: 50 });
      expect(result.model.nodes[1]?.ext).toEqual({ x: 360, y: 180 });
      expect(result.html).toContain(DIAGRAM_CSP);
      expect(result.html).toContain(DIAGRAM_HARNESS_MARKER);
      expect(result.html).toContain('data-ark-container="graph"');
    }
  });

  it("edge.ext と ER projection を配信時も保持する", async () => {
    const edge = {
      id: "e_order_user",
      from: "order",
      to: "user",
      label: "belongs to",
      ext: {
        from_card: "one",
        to_card: "zero-or-many",
        direction: "forward",
        type: "belongs-to",
      },
    };
    const graphModel = JSON.stringify({
      version: 1,
      nodes: [
        { id: "order", label: "Order", kind: "entity", ext: { x: 40, y: 50 } },
        { id: "user", label: "User", kind: "entity", ext: { x: 360, y: 180 } },
      ],
      edges: [edge],
      groups: [],
    });
    write(
      "er.diagram.html",
      '<div class="er-graph" data-ark-container="graph">' +
        '<section class="entity" data-model-id="order" data-kind="entity">Order</section>' +
        '<section class="entity" data-model-id="user" data-kind="entity">User</section></div>',
      graphModel
    );

    const result = await readDiagram(wt, "er.diagram.html");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.edges[0]).toEqual(edge);
      expect(result.html).toContain('class="er-graph"');
      expect(result.html).toContain('data-kind="entity"');
      expect(result.html).toContain(DIAGRAM_CSP);
      expect(result.html).toContain(DIAGRAM_HARNESS_MARKER);
      expect(result.html).toContain("from_card");
      expect(result.html).toContain("data-ark-edge-cardinality");
    }
  });

  it("group model と graph projection を配信時も保持する", async () => {
    const groupModel = JSON.stringify({
      version: 1,
      nodes: [
        { id: "order", label: "Order", ext: { x: 40, y: 50 } },
        { id: "user", label: "User", ext: { x: 360, y: 180 } },
      ],
      edges: [],
      groups: [
        {
          id: "ordering-context",
          label: "Ordering Context",
          nodes: ["order", "user"],
          ext: { role: "bounded-context" },
        },
      ],
    });
    write(
      "group.diagram.html",
      '<div data-ark-container="graph">' +
        '<section class="group-boundary" data-ark-group data-model-id="ordering-context">' +
        '<span data-model-id="ordering-context">Ordering Context</span></section>' +
        '<div data-model-id="order">Order</div>' +
        '<div data-model-id="user">User</div></div>',
      groupModel
    );

    const result = await readDiagram(wt, "group.diagram.html");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.groups).toEqual([
        {
          id: "ordering-context",
          label: "Ordering Context",
          nodes: ["order", "user"],
          ext: { role: "bounded-context" },
        },
      ]);
      expect(result.html).toContain("data-ark-group");
      expect(result.html).toContain('class="group-boundary"');
      expect(result.html).toContain(DIAGRAM_CSP);
      expect(result.html).toContain(DIAGRAM_HARNESS_MARKER);
    }
  });

  it("任意の model kind と投影 data-kind を配信時も保持する", async () => {
    const kindModel = JSON.stringify({
      version: 1,
      nodes: [
        { id: "command", label: "Command", kind: "command" },
        { id: "service", label: "Service", kind: "service" },
      ],
      edges: [],
      groups: [],
    });
    write(
      "kinds.diagram.html",
      '<div data-model-id="command" data-kind="command">Command</div>' +
        '<div data-model-id="service" data-kind="service">Service</div>',
      kindModel
    );

    const result = await readDiagram(wt, "kinds.diagram.html");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.nodes.map(node => node.kind)).toEqual([
        "command",
        "service",
      ]);
      expect(result.html).toContain('data-kind="command"');
      expect(result.html).toContain('data-kind="service"');
      expect(result.html).toContain(DIAGRAM_CSP);
      expect(result.html).toContain(DIAGRAM_HARNESS_MARKER);
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
