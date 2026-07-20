# B-0a 図の生成と表示 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude が生成した `.diagram.html` が Ark のペインに表示され、ファイルを編集すると自動で再投影される。

**Architecture:** 図はモデル（JSON）と投影（HTML）を 1 ファイルに埋め込み、worktree 内の `docs/diagrams/` に置く。サーバーは読み取り時に meta CSP を注入して配信し、fs.watch で更新を検知して socket で通知する。Claude は `board_open` でペインを開かせる。編集と還流は B-0b。

**Tech Stack:** TypeScript / Express / Socket.IO / vitest / React 19

## Global Constraints

- spec は `docs/superpowers/specs/2026-07-20-html-diagram-harness-design.md`（99da71c）。判断の正はそちら
- 図ファイルの置き場は `<worktree>/docs/diagrams/*.diagram.html`（判断4.1）
- 生成 HTML には meta CSP を **Ark 側が注入する**。内容は実測で確定した次の 1 行（判断4.2.1）
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;">`
- コア語彙は node / edge / field / group と label のみ標準化。図種固有は `ext` に逃がす（判断4.3）
- iframe は `sandbox="allow-scripts"`（`allow-same-origin` を付けない）。不透明オリジンを保つ
- テスト実行: `pnpm --filter @ark/server test`（server）、`pnpm vitest run`（全体）
- 型チェック: `pnpm --dir . exec tsc -b`
- web 側にコンポーネントテストの基盤は無い。ロジックは `lib/` の純関数に切り出してテストする
- ServerToClientEvents に callback 付きイベントを作らない（既存規約）
- MCP ツールは例外を投げず `textResult` で返す（既存規約）

---

### Task 1: モデル語彙の型と検証

**Files:**
- Create: `packages/server/src/lib/diagram-model.ts`
- Test: `packages/server/src/lib/diagram-model.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `DiagramModel` / `DiagramNode` / `DiagramEdge` / `DiagramField` / `DiagramGroup` 型、`parseDiagramModel(json: string): { ok: true; model: DiagramModel } | { ok: false; error: string }`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// packages/server/src/lib/diagram-model.test.ts
import { describe, expect, it } from "vitest";
import { parseDiagramModel } from "./diagram-model.js";

describe("parseDiagramModel", () => {
  it("コア語彙のモデルを受け付ける", () => {
    const json = JSON.stringify({
      version: 1,
      title: "購買フロー",
      nodes: [
        {
          id: "order",
          label: "Order",
          fields: [
            { id: "f_id", label: "id" },
            { id: "f_status", label: "status" },
          ],
        },
      ],
      edges: [{ id: "e1", from: "order", to: "order", label: "self" }],
    });

    const result = parseDiagramModel(json);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.title).toBe("購買フロー");
      expect(result.model.nodes[0]?.fields?.[1]?.label).toBe("status");
    }
  });

  it("図種固有の情報は ext に保持する", () => {
    const json = JSON.stringify({
      version: 1,
      nodes: [{ id: "n1", label: "N", ext: { cardinality: "1..N" } }],
    });

    const result = parseDiagramModel(json);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.nodes[0]?.ext).toEqual({ cardinality: "1..N" });
    }
  });

  it("id が重複するモデルを拒否する", () => {
    const json = JSON.stringify({
      version: 1,
      nodes: [
        { id: "dup", label: "A" },
        { id: "dup", label: "B" },
      ],
    });

    const result = parseDiagramModel(json);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("dup");
  });

  it("存在しないノードを指す edge を拒否する", () => {
    const json = JSON.stringify({
      version: 1,
      nodes: [{ id: "a", label: "A" }],
      edges: [{ id: "e1", from: "a", to: "missing" }],
    });

    const result = parseDiagramModel(json);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("missing");
  });

  it("壊れた JSON を拒否する", () => {
    const result = parseDiagramModel("{ not json");

    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `pnpm --filter @ark/server exec vitest run src/lib/diagram-model.test.ts`
Expected: FAIL — `Failed to resolve import "./diagram-model.js"`

- [ ] **Step 3: 最小の実装を書く**

```ts
// packages/server/src/lib/diagram-model.ts
/**
 * 図の意味モデル（コア語彙）。
 *
 * 標準化するのは node / edge / field / group と label だけで、図種固有の意味は
 * `ext` に逃がす（判断4.3）。サーバーが意味差分の文を組み立てられる最小限に絞り、
 * 図種を増やしても実装を足さずに済むようにする。
 */

export interface DiagramField {
  id: string;
  label: string;
  ext?: Record<string, unknown>;
}

export interface DiagramNode {
  id: string;
  label: string;
  /** entity / step / state など。サーバーは解釈せず、投影側と skill の取り決め */
  kind?: string;
  fields?: DiagramField[];
  ext?: Record<string, unknown>;
}

export interface DiagramEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  ext?: Record<string, unknown>;
}

export interface DiagramGroup {
  id: string;
  label: string;
  nodes: string[];
  ext?: Record<string, unknown>;
}

export interface DiagramModel {
  version: 1;
  title?: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups: DiagramGroup[];
}

export type ParseResult =
  | { ok: true; model: DiagramModel }
  | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asExt(v: unknown): Record<string, unknown> | undefined {
  return isRecord(v) ? v : undefined;
}

/** モデル JSON を検証して正規化する。id の重複と edge の参照切れを弾く。 */
export function parseDiagramModel(json: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return {
      ok: false,
      error: `モデル JSON を解析できません: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!isRecord(raw)) return { ok: false, error: "モデルはオブジェクトである必要があります" };
  if (raw.version !== 1) return { ok: false, error: "version は 1 である必要があります" };

  const seen = new Set<string>();
  const dup = (id: string): string | null => {
    if (seen.has(id)) return id;
    seen.add(id);
    return null;
  };

  const nodes: DiagramNode[] = [];
  for (const n of Array.isArray(raw.nodes) ? raw.nodes : []) {
    if (!isRecord(n) || typeof n.id !== "string" || typeof n.label !== "string") {
      return { ok: false, error: "node には文字列の id と label が必要です" };
    }
    const d = dup(n.id);
    if (d) return { ok: false, error: `id が重複しています: ${d}` };

    const fields: DiagramField[] = [];
    for (const f of Array.isArray(n.fields) ? n.fields : []) {
      if (!isRecord(f) || typeof f.id !== "string" || typeof f.label !== "string") {
        return { ok: false, error: `node ${n.id} の field には文字列の id と label が必要です` };
      }
      const fd = dup(f.id);
      if (fd) return { ok: false, error: `id が重複しています: ${fd}` };
      fields.push({ id: f.id, label: f.label, ext: asExt(f.ext) });
    }

    nodes.push({
      id: n.id,
      label: n.label,
      kind: typeof n.kind === "string" ? n.kind : undefined,
      fields: fields.length > 0 ? fields : undefined,
      ext: asExt(n.ext),
    });
  }

  const nodeIds = new Set(nodes.map(n => n.id));

  const edges: DiagramEdge[] = [];
  for (const e of Array.isArray(raw.edges) ? raw.edges : []) {
    if (!isRecord(e) || typeof e.id !== "string" || typeof e.from !== "string" || typeof e.to !== "string") {
      return { ok: false, error: "edge には文字列の id / from / to が必要です" };
    }
    const d = dup(e.id);
    if (d) return { ok: false, error: `id が重複しています: ${d}` };
    if (!nodeIds.has(e.from)) return { ok: false, error: `edge ${e.id} の from が存在しません: ${e.from}` };
    if (!nodeIds.has(e.to)) return { ok: false, error: `edge ${e.id} の to が存在しません: ${e.to}` };
    edges.push({
      id: e.id,
      from: e.from,
      to: e.to,
      label: typeof e.label === "string" ? e.label : undefined,
      ext: asExt(e.ext),
    });
  }

  const groups: DiagramGroup[] = [];
  for (const g of Array.isArray(raw.groups) ? raw.groups : []) {
    if (!isRecord(g) || typeof g.id !== "string" || typeof g.label !== "string") {
      return { ok: false, error: "group には文字列の id と label が必要です" };
    }
    const d = dup(g.id);
    if (d) return { ok: false, error: `id が重複しています: ${d}` };
    const members = (Array.isArray(g.nodes) ? g.nodes : []).filter(
      (m): m is string => typeof m === "string"
    );
    for (const m of members) {
      if (!nodeIds.has(m)) return { ok: false, error: `group ${g.id} のメンバーが存在しません: ${m}` };
    }
    groups.push({ id: g.id, label: g.label, nodes: members, ext: asExt(g.ext) });
  }

  return {
    ok: true,
    model: {
      version: 1,
      title: typeof raw.title === "string" ? raw.title : undefined,
      nodes,
      edges,
      groups,
    },
  };
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `pnpm --filter @ark/server exec vitest run src/lib/diagram-model.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/lib/diagram-model.ts packages/server/src/lib/diagram-model.test.ts
git commit -m "feat(diagram): コア語彙のモデル型と検証を追加"
```

---

### Task 2: 図ファイルのパースと meta CSP 注入

**Files:**
- Create: `packages/server/src/lib/diagram-file.ts`
- Test: `packages/server/src/lib/diagram-file.test.ts`

**Interfaces:**
- Consumes: Task 1 の `parseDiagramModel`, `DiagramModel`
- Produces: `MODEL_SCRIPT_ID`（`"ark-diagram-model"`）、`extractModel(html: string): ParseResult`、`injectCsp(html: string): string`、`DIAGRAM_CSP`

`injectCsp` は判断4.2.1 の実測にもとづく security 対策。`HtmlViewerPane` と同じ srcDoc 方式ではサーバーの CSP ヘッダが効かないため、本文に meta を差し込む。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// packages/server/src/lib/diagram-file.test.ts
import { describe, expect, it } from "vitest";
import { DIAGRAM_CSP, extractModel, injectCsp } from "./diagram-file.js";

const MODEL = JSON.stringify({
  version: 1,
  title: "T",
  nodes: [{ id: "a", label: "A" }],
});

function page(body: string, head = ""): string {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

describe("extractModel", () => {
  it("script[type=application/json] からモデルを取り出す", () => {
    const html = page(
      `<script type="application/json" id="ark-diagram-model">${MODEL}</script><div>図</div>`
    );

    const result = extractModel(html);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.model.nodes[0]?.label).toBe("A");
  });

  it("モデルブロックが無ければ失敗する", () => {
    const result = extractModel(page("<div>図だけ</div>"));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ark-diagram-model");
  });

  it("属性の順序が逆でも取り出せる", () => {
    const html = page(
      `<script id="ark-diagram-model" type="application/json">${MODEL}</script>`
    );

    expect(extractModel(html).ok).toBe(true);
  });
});

describe("injectCsp", () => {
  it("head の直後に meta CSP を差し込む", () => {
    const out = injectCsp(page("<div>x</div>"));

    expect(out).toContain(DIAGRAM_CSP);
    expect(out.indexOf(DIAGRAM_CSP)).toBeLessThan(out.indexOf("<div>x</div>"));
  });

  it("head が無い文書でも先頭に差し込む", () => {
    const out = injectCsp("<div>x</div>");

    expect(out).toContain(DIAGRAM_CSP);
    expect(out.indexOf(DIAGRAM_CSP)).toBeLessThan(out.indexOf("<div>x</div>"));
  });

  it("生成物が自前で書いた CSP meta は取り除いてから差し込む", () => {
    const html = page(
      "<div>x</div>",
      `<meta http-equiv="Content-Security-Policy" content="default-src *">`
    );

    const out = injectCsp(html);

    expect(out).not.toContain("default-src *");
    expect(out.match(/http-equiv="Content-Security-Policy"/g)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `pnpm --filter @ark/server exec vitest run src/lib/diagram-file.test.ts`
Expected: FAIL — `Failed to resolve import "./diagram-file.js"`

- [ ] **Step 3: 最小の実装を書く**

```ts
// packages/server/src/lib/diagram-file.ts
/**
 * `.diagram.html` の読み書き補助。
 *
 * モデルは `<script type="application/json" id="ark-diagram-model">` に埋め込む。
 * `type="application/json"` なので実行されず、meta CSP の script-src の影響も受けない。
 *
 * CSP について（判断4.2.1 の実測）:
 * クライアントは HtmlViewerPane と同じく fetch → srcDoc で描画するため、
 * サーバーのレスポンスヘッダに付けた CSP は srcDoc 文書に適用されない。
 * 外部送信を止めるには本文に meta を差し込む必要がある。
 */

import { parseDiagramModel, type ParseResult } from "./diagram-model.js";

export const MODEL_SCRIPT_ID = "ark-diagram-model";

/**
 * 実測で遮断を確認した内容。外部 fetch は Failed to fetch になり、
 * インライン script とインライン style は動作を続ける。
 */
export const DIAGRAM_CSP =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
  `script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;">`;

/** モデル埋め込みブロックの中身を取り出して検証する */
export function extractModel(html: string): ParseResult {
  // id と type は順不同で書かれうるので、script タグ全体を拾ってから中身を判定する
  const scripts = html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi);
  for (const m of scripts) {
    const attrs = m[1] ?? "";
    if (!new RegExp(`id\\s*=\\s*["']${MODEL_SCRIPT_ID}["']`, "i").test(attrs)) continue;
    return parseDiagramModel((m[2] ?? "").trim());
  }
  return {
    ok: false,
    error: `モデルブロックが見つかりません（<script type="application/json" id="${MODEL_SCRIPT_ID}">）`,
  };
}

/** 既存の CSP meta を除去したうえで、Ark が管理する meta CSP を先頭に差し込む */
export function injectCsp(html: string): string {
  const stripped = html.replace(
    /<meta\b[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi,
    ""
  );
  const headOpen = stripped.match(/<head\b[^>]*>/i);
  if (headOpen && headOpen.index !== undefined) {
    const at = headOpen.index + headOpen[0].length;
    return stripped.slice(0, at) + DIAGRAM_CSP + stripped.slice(at);
  }
  return DIAGRAM_CSP + stripped;
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `pnpm --filter @ark/server exec vitest run src/lib/diagram-file.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/lib/diagram-file.ts packages/server/src/lib/diagram-file.test.ts
git commit -m "feat(diagram): モデル抽出と meta CSP 注入を追加"
```

---

### Task 3: 図ファイルのパス解決

**Files:**
- Create: `packages/server/src/lib/diagram-path.ts`
- Test: `packages/server/src/lib/diagram-path.test.ts`

**Interfaces:**
- Consumes: なし（`node:path` と `node:fs` のみ）
- Produces: `DIAGRAM_DIR`（`"docs/diagrams"`）、`resolveDiagramPath(worktreeReal: string, relPath: string): { ok: true; absPath: string } | { ok: false; error: string }`

worktree の実パスは呼び出し側が `resolveWorktreeRealPath`（`managed-worktree.ts`）で解決済みのものを渡す。ここは worktree 配下への封じ込めだけを担う。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// packages/server/src/lib/diagram-path.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDiagramPath } from "./diagram-path.js";

let wt: string;

beforeEach(() => {
  wt = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ark-diagram-path-")));
  fs.mkdirSync(path.join(wt, "docs", "diagrams"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(wt, { recursive: true, force: true });
});

describe("resolveDiagramPath", () => {
  it("docs/diagrams 配下の .diagram.html を解決する", () => {
    const result = resolveDiagramPath(wt, "docs/diagrams/a.diagram.html");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.absPath).toBe(path.join(wt, "docs", "diagrams", "a.diagram.html"));
    }
  });

  it("docs/diagrams を省いた指定も補う", () => {
    const result = resolveDiagramPath(wt, "a.diagram.html");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.absPath).toBe(path.join(wt, "docs", "diagrams", "a.diagram.html"));
    }
  });

  it("worktree の外へ出る指定を拒否する", () => {
    const result = resolveDiagramPath(wt, "../../etc/passwd.diagram.html");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("worktree");
  });

  it("絶対パス指定を拒否する", () => {
    const result = resolveDiagramPath(wt, "/etc/x.diagram.html");

    expect(result.ok).toBe(false);
  });

  it(".diagram.html 以外の拡張子を拒否する", () => {
    const result = resolveDiagramPath(wt, "docs/diagrams/a.html");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(".diagram.html");
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `pnpm --filter @ark/server exec vitest run src/lib/diagram-path.test.ts`
Expected: FAIL — `Failed to resolve import "./diagram-path.js"`

- [ ] **Step 3: 最小の実装を書く**

```ts
// packages/server/src/lib/diagram-path.ts
/**
 * 図ファイルのパス解決。worktree 配下の `docs/diagrams/*.diagram.html` に封じ込める。
 *
 * worktree の実パス自体の検証は managed-worktree.ts が担い、ここは
 * 「その配下から出ないこと」と「図ファイルであること」だけを見る。
 */

import path from "node:path";

export const DIAGRAM_DIR = "docs/diagrams";
const DIAGRAM_SUFFIX = ".diagram.html";

export type DiagramPathResult =
  | { ok: true; absPath: string }
  | { ok: false; error: string };

/**
 * @param worktreeReal realpath 済みの worktree 絶対パス
 * @param relPath `docs/diagrams/x.diagram.html` または `x.diagram.html`
 */
export function resolveDiagramPath(
  worktreeReal: string,
  relPath: string
): DiagramPathResult {
  if (typeof relPath !== "string" || relPath.length === 0) {
    return { ok: false, error: "図のパスが空です" };
  }
  if (relPath.length > 1024) {
    return { ok: false, error: "図のパスが長すぎます" };
  }
  if (path.isAbsolute(relPath)) {
    return { ok: false, error: "図のパスは worktree 相対で指定してください" };
  }
  if (!relPath.endsWith(DIAGRAM_SUFFIX)) {
    return { ok: false, error: `図のパスは ${DIAGRAM_SUFFIX} で終わる必要があります` };
  }

  const normalized = path.normalize(relPath);
  const withDir = normalized.startsWith(`${DIAGRAM_DIR}${path.sep}`)
    ? normalized
    : path.join(DIAGRAM_DIR, normalized);

  const base = path.join(worktreeReal, DIAGRAM_DIR);
  const absPath = path.resolve(worktreeReal, withDir);
  if (absPath !== base && !absPath.startsWith(base + path.sep)) {
    return { ok: false, error: "図のパスが worktree の docs/diagrams から出ています" };
  }
  return { ok: true, absPath };
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `pnpm --filter @ark/server exec vitest run src/lib/diagram-path.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/lib/diagram-path.ts packages/server/src/lib/diagram-path.test.ts
git commit -m "feat(diagram): worktree 配下への図パス解決を追加"
```

---

### Task 4: 図ファイルの読み取り

**Files:**
- Create: `packages/server/src/lib/diagram-reader.ts`
- Test: `packages/server/src/lib/diagram-reader.test.ts`

**Interfaces:**
- Consumes: Task 2 の `extractModel` / `injectCsp`、Task 3 の `resolveDiagramPath`
- Produces: `readDiagram(worktreeReal: string, relPath: string): Promise<ReadDiagramResult>`
  型は `{ ok: true; html: string; model: DiagramModel } | { ok: false; status: number; error: string }`

`html` は meta CSP 注入済みで、そのままクライアントへ返せる状態にする。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// packages/server/src/lib/diagram-reader.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DIAGRAM_CSP } from "./diagram-file.js";
import { readDiagram } from "./diagram-reader.js";

let wt: string;
let dir: string;

const MODEL = JSON.stringify({
  version: 1,
  title: "購買フロー",
  nodes: [{ id: "order", label: "Order" }],
});

beforeEach(() => {
  wt = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ark-diagram-read-")));
  dir = path.join(wt, "docs", "diagrams");
  fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(wt, { recursive: true, force: true });
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
    fs.writeFileSync(path.join(dir, "b.diagram.html"), "<html><body>図だけ</body></html>");

    const result = await readDiagram(wt, "b.diagram.html");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(422);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `pnpm --filter @ark/server exec vitest run src/lib/diagram-reader.test.ts`
Expected: FAIL — `Failed to resolve import "./diagram-reader.js"`

- [ ] **Step 3: 最小の実装を書く**

```ts
// packages/server/src/lib/diagram-reader.ts
/** 図ファイルを読み、モデルを取り出し、meta CSP を注入して返す。 */

import fs from "node:fs";
import { extractModel, injectCsp } from "./diagram-file.js";
import type { DiagramModel } from "./diagram-model.js";
import { resolveDiagramPath } from "./diagram-path.js";

export type ReadDiagramResult =
  | { ok: true; absPath: string; html: string; model: DiagramModel }
  | { ok: false; status: number; error: string };

export async function readDiagram(
  worktreeReal: string,
  relPath: string
): Promise<ReadDiagramResult> {
  const resolved = resolveDiagramPath(worktreeReal, relPath);
  if (!resolved.ok) return { ok: false, status: 403, error: resolved.error };

  let raw: string;
  try {
    raw = await fs.promises.readFile(resolved.absPath, "utf-8");
  } catch {
    return { ok: false, status: 404, error: "図ファイルが見つかりません" };
  }

  const model = extractModel(raw);
  if (!model.ok) return { ok: false, status: 422, error: model.error };

  return {
    ok: true,
    absPath: resolved.absPath,
    html: injectCsp(raw),
    model: model.model,
  };
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `pnpm --filter @ark/server exec vitest run src/lib/diagram-reader.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/lib/diagram-reader.ts packages/server/src/lib/diagram-reader.test.ts
git commit -m "feat(diagram): 図ファイルの読み取りを追加"
```

---

### Task 5: board_open MCP ツール

**Files:**
- Modify: `packages/server/src/lib/board-mcp-server.ts`
- Modify: `packages/server/src/lib/board-mcp-server.test.ts`

**Interfaces:**
- Consumes: `BoardMcpDeps`（既存）
- Produces: `BoardMcpDeps.openDiagram(worktreePath: string, relPath: string): { ok: boolean; error?: string }` を追加。`handleBoardOpen(deps, worktreePath, { path })` を export

既存規約を守る。ツールは例外を投げず `textResult` で返し、純ロジックは別関数に切り出す。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/lib/board-mcp-server.test.ts` の末尾に追記する。

```ts
import { handleBoardOpen } from "./board-mcp-server.js";

describe("handleBoardOpen", () => {
  it("deps.openDiagram に worktreePath と相対パスを渡す", () => {
    const openDiagram = vi.fn(() => ({ ok: true }));
    const deps = { openDiagram } as never;

    const res = handleBoardOpen(deps, "/wt", { path: "docs/diagrams/a.diagram.html" });

    expect(openDiagram).toHaveBeenCalledWith("/wt", "docs/diagrams/a.diagram.html");
    expect(res.ok).toBe(true);
  });

  it("deps がエラーを返したらそのまま伝える", () => {
    const deps = { openDiagram: vi.fn(() => ({ ok: false, error: "見つかりません" })) } as never;

    const res = handleBoardOpen(deps, "/wt", { path: "a.diagram.html" });

    expect(res.ok).toBe(false);
    expect(res.error).toBe("見つかりません");
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `pnpm --filter @ark/server exec vitest run src/lib/board-mcp-server.test.ts`
Expected: FAIL — `handleBoardOpen is not exported`

- [ ] **Step 3: 最小の実装を書く**

`packages/server/src/lib/board-mcp-server.ts` の `BoardMcpDeps` にメソッドを足す。

```ts
export interface BoardMcpDeps {
  getBoardScene(worktreePath: string): { elements: unknown[] };
  saveBoardScene(worktreePath: string, scene: { elements: unknown[] }): void;
  notifyUpdated(worktreePath: string): void;
  /** 図ファイルをボードペインで開かせる（B-0a）。失敗理由は呼び出し元に返す */
  openDiagram(worktreePath: string, relPath: string): { ok: boolean; error?: string };
}
```

`handleBoardWrite` の下に純ロジックを足す。

```ts
export interface BoardOpenInput {
  path: string;
}

export interface BoardOpenResult {
  ok: boolean;
  error?: string;
}

/** board_open の純ロジック（HTTP/MCP から分離してテスト可能にする）。 */
export function handleBoardOpen(
  deps: Pick<BoardMcpDeps, "openDiagram">,
  worktreePath: string,
  input: BoardOpenInput
): BoardOpenResult {
  return deps.openDiagram(worktreePath, input.path);
}
```

`createBoardMcpServer` の中、`board_write` の登録の後に追加する。

```ts
  server.registerTool(
    "board_open",
    {
      description:
        "生成した図ファイル (docs/diagrams/*.diagram.html) をこのセッションのボードペインで開かせる。" +
        "図を Write/Edit で書いた直後に呼ぶこと。path は worktree 相対で指定する。",
      inputSchema: {
        path: z
          .string()
          .describe("worktree 相対の図ファイルパス（例: docs/diagrams/purchase-flow.diagram.html）"),
      },
    },
    async args => {
      try {
        const res = handleBoardOpen(deps, worktreePath, { path: args.path });
        return textResult(
          res.ok ? JSON.stringify({ opened: args.path }) : `board_open 失敗: ${res.error ?? "不明なエラー"}`
        );
      } catch (e) {
        return textResult(`board_open 失敗: ${getErrorMessage(e)}`);
      }
    }
  );
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `pnpm --filter @ark/server exec vitest run src/lib/board-mcp-server.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/lib/board-mcp-server.ts packages/server/src/lib/board-mcp-server.test.ts
git commit -m "feat(diagram): board_open MCP ツールを追加"
```

---

### Task 6: 図ファイルの更新監視

**Files:**
- Create: `packages/server/src/lib/diagram-watcher.ts`
- Test: `packages/server/src/lib/diagram-watcher.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `DiagramWatcher` クラスと `diagramWatcher` シングルトン。
  `subscribe(absPath: string, listener: () => void): () => void`、`cleanup(): void`

`jsonl-tail-manager.ts` の方針を踏襲する。`fs.watch` は取りこぼすので 1 秒 polling を併用し、refcount で watcher を解放する。テストは OS 依存を避けて polling 経由を待ち合わせる。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// packages/server/src/lib/diagram-watcher.test.ts
/**
 * fs.watch のイベント発火は OS 依存でテストが不安定なため、
 * jsonl-tail-manager.test.ts と同じく polling 経由で動く部分を待ち合わせる。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiagramWatcher } from "./diagram-watcher.js";

let dir: string;
let watcher: DiagramWatcher;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ark-diagram-watch-")));
  watcher = new DiagramWatcher();
});

afterEach(() => {
  watcher.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("DiagramWatcher", () => {
  it("ファイルが更新されたら listener を呼ぶ", async () => {
    const file = path.join(dir, "a.diagram.html");
    fs.writeFileSync(file, "<html>1</html>");
    let calls = 0;
    watcher.subscribe(file, () => {
      calls += 1;
    });

    await wait(50);
    fs.writeFileSync(file, "<html>2</html>");
    await wait(1600);

    expect(calls).toBeGreaterThan(0);
  });

  it("購読解除したら以後は呼ばれない", async () => {
    const file = path.join(dir, "b.diagram.html");
    fs.writeFileSync(file, "<html>1</html>");
    let calls = 0;
    const off = watcher.subscribe(file, () => {
      calls += 1;
    });
    off();

    fs.writeFileSync(file, "<html>2</html>");
    await wait(1600);

    expect(calls).toBe(0);
  });

  it("同じファイルへの複数購読は最後の解除で停止する", async () => {
    const file = path.join(dir, "c.diagram.html");
    fs.writeFileSync(file, "<html>1</html>");
    let a = 0;
    let b = 0;
    const offA = watcher.subscribe(file, () => {
      a += 1;
    });
    watcher.subscribe(file, () => {
      b += 1;
    });
    offA();

    await wait(50);
    fs.writeFileSync(file, "<html>2</html>");
    await wait(1600);

    expect(a).toBe(0);
    expect(b).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `pnpm --filter @ark/server exec vitest run src/lib/diagram-watcher.test.ts`
Expected: FAIL — `Failed to resolve import "./diagram-watcher.js"`

- [ ] **Step 3: 最小の実装を書く**

```ts
// packages/server/src/lib/diagram-watcher.ts
/**
 * 図ファイルの更新監視。
 *
 * jsonl-tail-manager.ts と同じ方針で、fs.watch だけに頼らず 1 秒 polling を
 * 併用する。fs.watch はプラットフォームによって取りこぼし、エディタの
 * 書き換え方（rename 置換）でも watcher が外れるため。
 * 通知は mtime + size の変化を見て出す（内容の再読込は購読側の責務）。
 */

import fs from "node:fs";

interface Watched {
  listeners: Set<() => void>;
  watcher: fs.FSWatcher | null;
  pollTimer: NodeJS.Timeout | null;
  signature: string;
}

const POLL_INTERVAL_MS = 1000;

function signatureOf(absPath: string): string {
  try {
    const st = fs.statSync(absPath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "";
  }
}

export class DiagramWatcher {
  private watched = new Map<string, Watched>();

  /** 更新通知を購読する。戻り値を呼ぶと解除する。 */
  subscribe(absPath: string, listener: () => void): () => void {
    let entry = this.watched.get(absPath);
    if (!entry) {
      entry = {
        listeners: new Set(),
        watcher: null,
        pollTimer: null,
        signature: signatureOf(absPath),
      };
      this.watched.set(absPath, entry);
      this.startWatcher(absPath, entry);
      entry.pollTimer = setInterval(() => {
        this.check(absPath);
      }, POLL_INTERVAL_MS);
    }
    entry.listeners.add(listener);

    return () => {
      const e = this.watched.get(absPath);
      if (!e) return;
      e.listeners.delete(listener);
      if (e.listeners.size === 0) this.stop(absPath);
    };
  }

  cleanup(): void {
    for (const key of [...this.watched.keys()]) this.stop(key);
  }

  private startWatcher(absPath: string, entry: Watched): void {
    try {
      entry.watcher = fs.watch(absPath, () => {
        this.check(absPath);
      });
    } catch {
      // ファイルが未作成でも polling が後から拾う
      entry.watcher = null;
    }
  }

  /** 署名が変わっていれば通知する（watch と poll の二重発火を冪等にする） */
  private check(absPath: string): void {
    const entry = this.watched.get(absPath);
    if (!entry) return;
    if (!entry.watcher) this.startWatcher(absPath, entry);
    const next = signatureOf(absPath);
    if (next === entry.signature) return;
    entry.signature = next;
    for (const l of [...entry.listeners]) {
      try {
        l();
      } catch {
        // 1 listener の例外を他へ波及させない
      }
    }
  }

  private stop(absPath: string): void {
    const entry = this.watched.get(absPath);
    if (!entry) return;
    entry.watcher?.close();
    entry.watcher = null;
    if (entry.pollTimer) {
      clearInterval(entry.pollTimer);
      entry.pollTimer = null;
    }
    this.watched.delete(absPath);
  }
}

export const diagramWatcher = new DiagramWatcher();
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `pnpm --filter @ark/server exec vitest run src/lib/diagram-watcher.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/lib/diagram-watcher.ts packages/server/src/lib/diagram-watcher.test.ts
git commit -m "feat(diagram): 図ファイルの更新監視を追加"
```

---

### Task 7: socket イベント型とサーバー配線

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/server/src/index.ts`

**Interfaces:**
- Consumes: Task 4 の `readDiagram`、Task 6 の `diagramWatcher`、Task 5 の `openDiagram` deps
- Produces: socket イベント 3 種と `boardDeps.openDiagram` の実体

- [ ] **Step 1: shared に型を足す**

`packages/shared/src/types.ts` の `ServerToClientEvents` に追加する。ServerToClientEvents に callback は作らない（既存規約）。

```ts
  /** Claude が board_open を呼んだ。クライアントは図タブを開く */
  "diagram:open": (data: {
    sessionId: string;
    worktreePath: string;
    relPath: string;
  }) => void;

  /** 監視中の図ファイルが更新された。クライアントは再読込する */
  "diagram:updated": (data: { worktreePath: string; relPath: string }) => void;
```

`ClientToServerEvents` に追加する。

```ts
  /** 図の購読開始（更新通知を受け取る）。1 セッション 1 図を想定 */
  "diagram:subscribe": (data: { worktreePath: string; relPath: string }) => void;

  /** 図の購読解除 */
  "diagram:unsubscribe": (data: { worktreePath: string; relPath: string }) => void;
```

- [ ] **Step 2: 型チェックで未実装を確認**

Run: `pnpm --dir /home/admin/dev/github.com/ignission/claude-code-manager exec tsc -b`
Expected: PASS（型追加のみなので通る。ハンドラ未実装でもエラーにはならない）

- [ ] **Step 3: index.ts に配線する**

import を追加する（`./lib/managed-worktree.js` の import の近く）。

```ts
import { readDiagram } from "./lib/diagram-reader.js";
import { diagramWatcher } from "./lib/diagram-watcher.js";
```

`boardDeps` に `openDiagram` を実装する（`notifyUpdated` の後）。

```ts
    openDiagram(worktreePath, relPath) {
      const resolved = resolveManagedWorktreeDetailed(worktreePath);
      if (!resolved.ok) {
        return { ok: false, error: `worktree を解決できません: ${resolved.reason}` };
      }
      const session = sessionOrchestrator.getSessionByWorktree(resolved.path);
      if (!session) {
        return { ok: false, error: "この worktree のセッションが見つかりません" };
      }
      io.emit("diagram:open", {
        sessionId: session.id,
        worktreePath: resolved.path,
        relPath,
      });
      return { ok: true };
    },
```

配信エンドポイントを `/api/html-file` の定義の後に足す。

```ts
  app.get("/api/diagram", async (req, res) => {
    const worktreePath = req.query.worktreePath;
    const relPath = req.query.path;
    if (typeof worktreePath !== "string" || typeof relPath !== "string") {
      res.status(400).json({ error: "worktreePath と path が必要です" });
      return;
    }
    const resolved = resolveManagedWorktreePath(worktreePath);
    if (!resolved) {
      res.status(403).json({ error: "管理外の worktree です" });
      return;
    }
    const result = await readDiagram(resolved, relPath);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // 本文に meta CSP を注入済み。クライアントは srcDoc で描画するため
    // ヘッダの CSP は当該文書に適用されない（判断4.2.1 の実測）
    res.setHeader("Cache-Control", "no-store");
    res.send(result.html);
  });
```

socket ハンドラを `canvas:load` の近くに足す。

```ts
    const diagramUnsubs = new Map<string, () => void>();

    socket.on("diagram:subscribe", ({ worktreePath, relPath }) => {
      const resolved = resolveManagedWorktreePath(worktreePath);
      if (!resolved) return;
      const key = `${resolved} ${relPath}`;
      if (diagramUnsubs.has(key)) return;
      void readDiagram(resolved, relPath).then(result => {
        if (!result.ok) return;
        const off = diagramWatcher.subscribe(result.absPath, () => {
          socket.emit("diagram:updated", { worktreePath: resolved, relPath });
        });
        diagramUnsubs.set(key, off);
      });
    });

    socket.on("diagram:unsubscribe", ({ worktreePath, relPath }) => {
      const resolved = resolveManagedWorktreePath(worktreePath);
      if (!resolved) return;
      const key = `${resolved} ${relPath}`;
      diagramUnsubs.get(key)?.();
      diagramUnsubs.delete(key);
    });

    socket.on("disconnect", () => {
      for (const off of diagramUnsubs.values()) off();
      diagramUnsubs.clear();
    });
```

- [ ] **Step 4: 型チェックとテストを実行**

Run: `pnpm --dir /home/admin/dev/github.com/ignission/claude-code-manager exec tsc -b && pnpm --filter @ark/server test`
Expected: tsc は無出力、テストは全件 PASS

- [ ] **Step 5: コミット**

```bash
git add packages/shared/src/types.ts packages/server/src/index.ts
git commit -m "feat(diagram): 図の配信エンドポイントと更新通知を配線"
```

---

### Task 8: クライアントのタブ操作（純関数）

**Files:**
- Create: `packages/web/src/lib/diagram-tabs.ts`
- Test: `packages/web/src/lib/diagram-tabs.test.ts`
- Modify: `packages/web/src/components/TerminalPane.tsx:68-94`（`ViewerTab` に diagram バリアント追加）

**Interfaces:**
- Consumes: `ViewerTab`（`TerminalPane.tsx`）
- Produces: `addOrFocusDiagramTab(tabs: ViewerTab[], worktreePath: string, relPath: string, id: string): { tabs: ViewerTab[]; activeIndex: number }`

web 側にコンポーネントテストの基盤が無いため、`canvas-tabs.ts` と同じくロジックを純関数に切り出してテストする。id は引数で受け取り純関数性を保つ。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// packages/web/src/lib/diagram-tabs.test.ts
import { describe, expect, it } from "vitest";
import type { ViewerTab } from "../components/TerminalPane";
import { addOrFocusDiagramTab } from "./diagram-tabs";

const base: ViewerTab[] = [{ type: "terminal", id: "terminal" }];

describe("addOrFocusDiagramTab", () => {
  it("図タブが無ければ追加する", () => {
    const { tabs, activeIndex } = addOrFocusDiagramTab(base, "/wt", "a.diagram.html", "d1");

    expect(tabs).toHaveLength(2);
    expect(tabs[1]).toEqual({
      type: "diagram",
      id: "d1",
      worktreePath: "/wt",
      relPath: "a.diagram.html",
    });
    expect(activeIndex).toBe(1);
  });

  it("同じ図が既に開いていれば追加せずその index を返す", () => {
    const first = addOrFocusDiagramTab(base, "/wt", "a.diagram.html", "d1");

    const second = addOrFocusDiagramTab(first.tabs, "/wt", "a.diagram.html", "d2");

    expect(second.tabs).toHaveLength(2);
    expect(second.activeIndex).toBe(1);
  });

  it("別の図は別タブとして追加する", () => {
    const first = addOrFocusDiagramTab(base, "/wt", "a.diagram.html", "d1");

    const second = addOrFocusDiagramTab(first.tabs, "/wt", "b.diagram.html", "d2");

    expect(second.tabs).toHaveLength(3);
    expect(second.activeIndex).toBe(2);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `pnpm --dir /home/admin/dev/github.com/ignission/claude-code-manager exec vitest run packages/web/src/lib/diagram-tabs.test.ts`
Expected: FAIL — `Failed to resolve import "./diagram-tabs"`

- [ ] **Step 3: 型と実装を書く**

`packages/web/src/components/TerminalPane.tsx` の `ViewerTab` にバリアントを追加する（`{ type: "board"; id: string }` の後）。

```ts
  | {
      type: "diagram";
      id: string;
      worktreePath: string;
      relPath: string;
    };
```

```ts
// packages/web/src/lib/diagram-tabs.ts
/**
 * 図タブの追加・フォーカス（純関数）。
 * id を引数で受け取り、テスト可能な純関数として保つ（canvas-tabs.ts と同じ方針）。
 */
import type { ViewerTab } from "../components/TerminalPane";

export function addOrFocusDiagramTab(
  tabs: ViewerTab[],
  worktreePath: string,
  relPath: string,
  id: string
): { tabs: ViewerTab[]; activeIndex: number } {
  const existing = tabs.findIndex(
    t => t.type === "diagram" && t.worktreePath === worktreePath && t.relPath === relPath
  );
  if (existing >= 0) return { tabs, activeIndex: existing };

  const next: ViewerTab[] = [...tabs, { type: "diagram", id, worktreePath, relPath }];
  return { tabs: next, activeIndex: next.length - 1 };
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `pnpm --dir /home/admin/dev/github.com/ignission/claude-code-manager exec vitest run packages/web/src/lib/diagram-tabs.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: コミット**

```bash
git add packages/web/src/lib/diagram-tabs.ts packages/web/src/lib/diagram-tabs.test.ts packages/web/src/components/TerminalPane.tsx
git commit -m "feat(diagram): 図タブの純関数と ViewerTab バリアントを追加"
```

---

### Task 9: 図ペインの描画と配線

**Files:**
- Create: `packages/web/src/components/DiagramPane.tsx`
- Modify: `packages/web/src/hooks/useViewerTabs.ts`
- Modify: `packages/web/src/components/TerminalPane.tsx`（レンダリング分岐、タブバー除外）

**Interfaces:**
- Consumes: Task 8 の `addOrFocusDiagramTab`、Task 7 の `diagram:open` / `diagram:updated` / `diagram:subscribe`
- Produces: `DiagramPane`（props: `worktreePath: string; relPath: string; socket: Socket`）、`useViewerTabs` の戻り値に `openDiagramTab`

`HtmlViewerPane` と同じく fetch → `srcDoc` + `sandbox="allow-scripts"` で描画する。`allow-same-origin` は付けない（不透明オリジンを保つ）。

- [ ] **Step 1: DiagramPane を作る**

```tsx
// packages/web/src/components/DiagramPane.tsx
/**
 * 図ファイルを表示するペイン。
 *
 * HtmlViewerPane と同じく fetch した本文を srcDoc に流し込む
 * （認証トークンを iframe 内に露出させないため）。
 * sandbox は allow-scripts のみで allow-same-origin を付けない。
 * 外部送信の遮断は本文に注入された meta CSP が担う（サーバー側で注入済み）。
 */
import { useCallback, useEffect, useState } from "react";
import type { Socket } from "socket.io-client";

interface DiagramPaneProps {
  worktreePath: string;
  relPath: string;
  socket: Socket;
}

function buildDiagramUrl(worktreePath: string, relPath: string): string {
  const token = new URLSearchParams(window.location.search).get("token");
  let url =
    `/api/diagram?worktreePath=${encodeURIComponent(worktreePath)}` +
    `&path=${encodeURIComponent(relPath)}`;
  if (token) url += `&token=${encodeURIComponent(token)}`;
  return url;
}

export function DiagramPane({ worktreePath, relPath, socket }: DiagramPaneProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(buildDiagramUrl(worktreePath, relPath));
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `読み込みに失敗しました (${res.status})`);
        setHtml(null);
        return;
      }
      setHtml(await res.text());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setHtml(null);
    }
  }, [worktreePath, relPath]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    socket.emit("diagram:subscribe", { worktreePath, relPath });
    const onUpdated = (data: { worktreePath: string; relPath: string }) => {
      if (data.worktreePath === worktreePath && data.relPath === relPath) void load();
    };
    socket.on("diagram:updated", onUpdated);
    return () => {
      socket.off("diagram:updated", onUpdated);
      socket.emit("diagram:unsubscribe", { worktreePath, relPath });
    };
  }, [socket, worktreePath, relPath, load]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (html === null) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        読み込み中…
      </div>
    );
  }
  return (
    <iframe
      title={relPath}
      srcDoc={html}
      sandbox="allow-scripts"
      className="h-full w-full border-0 bg-white"
    />
  );
}
```

- [ ] **Step 2: useViewerTabs に openDiagramTab を足す**

`packages/web/src/hooks/useViewerTabs.ts` に追加する。**両方の setState を同じ updater 内に閉じ込める**こと（L72-80 のコメントにある回帰を避けるため）。

```ts
  const openDiagramTab = useCallback(
    (sessionId: string, worktreePath: string, relPath: string) => {
      setSessionTabs(prev => {
        const current = prev[sessionId] ?? [{ type: "terminal" as const, id: "terminal" }];
        const { tabs, activeIndex } = addOrFocusDiagramTab(
          current,
          worktreePath,
          relPath,
          `diagram-${Date.now()}`
        );
        setSessionActiveTab(p => ({ ...p, [sessionId]: activeIndex }));
        return { ...prev, [sessionId]: tabs };
      });
    },
    []
  );
```

import を足し、戻り値に `openDiagramTab` を加える。

```ts
import { addOrFocusDiagramTab } from "../lib/diagram-tabs";
```

- [ ] **Step 3: TerminalPane にレンダリング分岐を足す**

先に `TerminalPane` の props に `socket` があるか確認する。無ければ足す。

Run: `rg -n "socket" packages/web/src/components/TerminalPane.tsx | head -5`

- 出力に `socket: Socket` を含む props 定義があれば、そのまま次へ
- 無ければ props インターフェースに `socket: Socket;` を追加し、`TerminalPane` を使っている箇所（`SplitViewPane.tsx` と `MultiPaneLayout.tsx`）から渡す

`packages/web/src/components/TerminalPane.tsx` の canvas 分岐の後に追加する。

```tsx
      {tabs[activeTabIndex]?.type === "diagram" &&
        (() => {
          const tab = tabs[activeTabIndex] as ViewerTab & { type: "diagram" };
          return (
            <div className="flex-1 min-h-0">
              <DiagramPane
                worktreePath={tab.worktreePath}
                relPath={tab.relPath}
                socket={socket}
              />
            </div>
          );
        })()}
```

import を足す。

```tsx
import { DiagramPane } from "./DiagramPane";
```

- [ ] **Step 4: diagram:open を受けてタブを開く**

`Dashboard.tsx`（`useViewerTabs` を呼んでいる箇所）で socket イベントを購読する。

```ts
  useEffect(() => {
    const onOpen = (data: { sessionId: string; worktreePath: string; relPath: string }) => {
      openDiagramTab(data.sessionId, data.worktreePath, data.relPath);
    };
    socket.on("diagram:open", onOpen);
    return () => {
      socket.off("diagram:open", onOpen);
    };
  }, [socket, openDiagramTab]);
```

- [ ] **Step 5: 型チェックとテストを実行**

Run: `pnpm --dir /home/admin/dev/github.com/ignission/claude-code-manager exec tsc -b && pnpm --dir /home/admin/dev/github.com/ignission/claude-code-manager exec vitest run`
Expected: tsc は無出力、テストは全件 PASS

- [ ] **Step 6: コミット**

```bash
git add packages/web/src/components/DiagramPane.tsx packages/web/src/components/TerminalPane.tsx packages/web/src/hooks/useViewerTabs.ts packages/web/src/pages/Dashboard.tsx
git commit -m "feat(diagram): 図ペインの描画と diagram:open の配線を追加"
```

---

### Task 10: 生成規約 skill と受け入れ確認

**Files:**
- Create: `.claude/skills/diagram-authoring/SKILL.md`
- Create: `docs/diagrams/sample.diagram.html`（動作確認用。受け入れ後に削除してよい）

**Interfaces:**
- Consumes: Task 1 のコア語彙、Task 5 の `board_open`
- Produces: Claude 向けの生成規約

- [ ] **Step 1: skill を書く**

```markdown
---
name: diagram-authoring
description: 図解を求められたときに .diagram.html を生成する規約。「図解して」「図で説明して」「ドメインモデリングして」等で使う。
---

# 図の書き方

図は `<worktree>/docs/diagrams/<名前>.diagram.html` に 1 ファイルで書く。
書いたら `board_open` でペインを開かせる。

## ファイルの構造

モデル（意味）と投影（見た目）を 1 ファイルに入れる。

```html
<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><title>購買フロー</title>
<style>/* 投影のスタイル */</style>
</head>
<body>
<script type="application/json" id="ark-diagram-model">
{
  "version": 1,
  "title": "購買フロー",
  "nodes": [
    { "id": "order", "label": "Order", "kind": "entity",
      "fields": [ { "id": "order_id", "label": "id" },
                  { "id": "order_status", "label": "status" } ] }
  ],
  "edges": [],
  "groups": []
}
</script>

<div data-model-id="order" class="entity">…投影…</div>
</body>
</html>
```

## 守ること

- **モデルは必ず `id="ark-diagram-model"` の JSON ブロックに入れる。** 無いとサーバーが 422 を返す
- **語彙は node / edge / field / group と label だけ使う。** 図種固有の意味は `ext` に入れる
- **id はファイル内で一意にする。** 重複するとサーバーが拒否する
- **投影の各要素に `data-model-id` を付ける。** 編集ハーネスがモデルと対応づけるため
- **外部リソースを参照しない。** CSS も画像も自前で書く（外部通信は遮断される）
- **`<meta http-equiv="Content-Security-Policy">` を自分で書かない。** Ark が注入する

## 表現

図種は問わない。エンティティ表、スイムレーン、状態機械など、問題に合うものを HTML と CSS で作る。
ただし一覧的な並びは `<ul>` や `<ol>` のような素直なコンテナで組む（編集ハーネスが並べ替えを扱えるようにするため）。
```

- [ ] **Step 2: 受け入れ確認用の図を書いて動作を見る**

```html
<!-- docs/diagrams/sample.diagram.html -->
<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><title>サンプル</title>
<style>
  body { font-family: system-ui, sans-serif; background:#1a1b26; color:#c0caf5; padding:1.5rem; }
  .entity { border:1px solid #2c2f42; border-radius:4px; margin-bottom:1rem; max-width:22rem; }
  .entity h3 { margin:0; padding:.6rem .9rem; border-bottom:1px solid #2c2f42; font-size:.9rem; }
  .entity ul { list-style:none; margin:0; padding:.4rem 0; }
  .entity li { padding:.25rem .9rem; font-family:ui-monospace,monospace; font-size:.8rem; }
  .rel { color:#7aa2f7; font-size:.8rem; }
</style>
</head>
<body>
<script type="application/json" id="ark-diagram-model">
{
  "version": 1,
  "title": "サンプル",
  "nodes": [
    { "id": "order", "label": "Order", "kind": "entity",
      "fields": [ { "id": "order_id", "label": "id" },
                  { "id": "order_user_id", "label": "user_id" },
                  { "id": "order_status", "label": "status" } ] },
    { "id": "user", "label": "User", "kind": "entity",
      "fields": [ { "id": "user_id", "label": "id" },
                  { "id": "user_email", "label": "email" } ] }
  ],
  "edges": [ { "id": "e_order_user", "from": "order", "to": "user", "label": "belongs to" } ],
  "groups": []
}
</script>

<div class="entity" data-model-id="order">
  <h3>Order</h3>
  <ul>
    <li data-model-id="order_id">id</li>
    <li data-model-id="order_user_id">user_id</li>
    <li data-model-id="order_status">status</li>
  </ul>
</div>
<div class="entity" data-model-id="user">
  <h3>User</h3>
  <ul>
    <li data-model-id="user_id">id</li>
    <li data-model-id="user_email">email</li>
  </ul>
</div>
<p class="rel" data-model-id="e_order_user">Order — belongs to → User</p>
</body>
</html>
```

Run: サーバーを再起動して図を配信させる

```bash
pkill -f '[t]tyd'; pnpm build && pm2 restart claude-code-ark
```

- [ ] **Step 3: 配信を確認**

```bash
node -e '
const http=require("http");
const wt="/home/admin/dev/github.com/ignission/claude-code-manager";
const u="/api/diagram?worktreePath="+encodeURIComponent(wt)+"&path="+encodeURIComponent("sample.diagram.html");
http.get({host:"127.0.0.1",port:4001,path:u},r=>{let b="";r.on("data",c=>b+=c);r.on("end",()=>{
  console.log("HTTP",r.statusCode);
  console.log("meta CSP 注入:", b.includes("Content-Security-Policy")?"あり":"なし");
});});'
```

Expected: `HTTP 200` かつ `meta CSP 注入: あり`

- [ ] **Step 4: board_open で開くことを確認**

Claude のセッションから `board_open` を呼び、Ark の UI に図タブが現れることを目視で確認する。
続けて `docs/diagrams/sample.diagram.html` を編集し、**リロードせずに表示が変わる**ことを確認する（fs.watch → `diagram:updated` → 再取得）。

- [ ] **Step 5: コミット**

```bash
git add .claude/skills/diagram-authoring/SKILL.md docs/diagrams/sample.diagram.html
git commit -m "feat(diagram): 生成規約 skill と受け入れ確認用の図を追加"
```

---

## B-0a の完了条件

1. Claude が規約どおりの `.diagram.html` を書ける
2. `board_open` で Ark にタブが開く
3. ファイルを編集すると再投影される
4. 図の中から外部へ fetch できない（meta CSP が効いている）
5. `pnpm vitest run` が全件通り、`tsc -b` が無出力

## 意図的に単純化した点

**図は右ペインではなく通常のタブとして出す。** spec の受け入れシナリオは「ボードペインに表示」だが、
`SplitViewPane` の `showBoard` は boolean で、右ペインを多態にするには localStorage の読み書き・
自動表示 effect・トグルボタンの 3 箇所が連動変更になる。
B-0a は表示だけが目的で、その改修は編集と会話を並べたい B-0b で初めて意味を持つ。
B-0b で `showBoard: boolean` を `"board" | "diagram" | null` に変える。

## B-0b へ持ち越すもの

- L1 編集ハーネス（インライン編集、行の並べ替え・追加・削除、モデル直編集トグル）
- MessageChannel の橋渡し（不透明オリジンのため origin 検証は使えない。実測済み）
- サーバー側の意味差分生成と `session:send` 還流
- 「変更を送る」の UX
