# 双方向ボード MCP — Phase A（board_write + MCP 配線 + 自動オープン）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ユーザーが「図解して」と言ったら、per-worktree の会話セッションの Claude が MCP ツール `board_write` でボード（Excalidraw）に直接図を描けるようにする。

**Architecture:** 新規 HTTP MCP server `BoardMcpServer`（ArkMcpServer と同型: 127.0.0.1 + bearer token + Streamable HTTP）に `board_write` ツールを実装。per-session token→worktree_path の registry でスコープを自動解決。ツールは簡略要素スキーマを受け取り、純ロジックの codec で正規 Excalidraw 要素へ展開し、`canvas_boards` に保存して `canvas:updated` を該当 room に emit（既存の再描画経路を流用）。会話セッション起動時に per-session の `--mcp-config` を注入する。

**Tech Stack:** TypeScript / Node / `@modelcontextprotocol/sdk`（McpServer + StreamableHTTPServerTransport）/ express / zod / better-sqlite3 / Socket.IO / tmux（claude CLI）/ vitest

## Global Constraints

- Node.js >= 22.12.0（`.mise.toml`: node 24 / pnpm 10.33.4）。
- 型チェックは `pnpm check`（各パッケージ `tsc -b`）。esbuild は型チェックしないので必ず `pnpm check` を通す。
- ルート vitest は env=node で `.tsx` を扱えない。**サーバ側ロジックは vitest（`packages/server/src/lib/*.test.ts`）で網羅**。UI は対象外（Phase A はサーバ中心）。
- MCP server は **127.0.0.1 のみ listen + bearer token**（tunnel/リモートから到達不可）。
- 情報源分離の原則: 会話は JSONL、ボードは SQLite。tmux 画面パース禁止。
- superpowers 生成の plan/spec（本ファイル含む `docs/superpowers/` 配下）は **git にコミットしない**。
- コミットメッセージは日本語・Co-Authored-By を付けない。
- 既存パターン踏襲: MCP は `ark-mcp-server.ts`、テストは `ark-mcp-server.test.ts`、DB アクセスは `database.ts` の同期 API。

## ファイル構成

- Create: `packages/server/src/lib/board-element-codec.ts` — 簡略スキーマ ⇔ 正規 Excalidraw 要素の変換（純ロジック）。
- Create: `packages/server/src/lib/board-element-codec.test.ts` — codec のテスト。
- Create: `packages/server/src/lib/board-mcp-server.ts` — `BoardMcpServer` クラス + `createBoardMcpServer(deps)` + `BoardSessionRegistry`。
- Create: `packages/server/src/lib/board-mcp-server.test.ts` — ツールのテスト。
- Modify: `packages/server/src/lib/tmux-manager.ts` — `--mcp-config <path>` 注入（`--settings` と同型）。
- Modify: `packages/server/src/lib/session-orchestrator.ts` — 起動時に token 生成・registry 登録・per-session mcp-config ファイル生成・停止時に登録解除。
- Modify: `packages/server/src/index.ts` — `BoardMcpServer` 起動 + orchestrator へ配線 + `board_write` 由来の `canvas:updated` emit。

---

## Task 1: board-element-codec（簡略スキーマ → 正規 Excalidraw 要素）

**Files:**
- Create: `packages/server/src/lib/board-element-codec.ts`
- Test: `packages/server/src/lib/board-element-codec.test.ts`

**Interfaces:**
- Produces:
  - `type SimpleElement` — `board_write` 入力の1要素。
  - `expandElements(simple: SimpleElement[], opts: { startIndex: number; rng?: () => number }): { elements: ExcalidrawElement[]; skipped: { id?: string; reason: string }[] }`
  - `type ExcalidrawElement = Record<string, unknown>`（scene 内要素。最低限のフィールドを埋めた plain object）

- [ ] **Step 1: 失敗するテストを書く**

```ts
// packages/server/src/lib/board-element-codec.test.ts
import { describe, expect, it } from "vitest";
import { expandElements, type SimpleElement } from "./board-element-codec.js";

// 決定的な rng（seed/versionNonce をテストで固定するため）
const fixedRng = () => 0.5;

describe("expandElements", () => {
  it("rect を正規要素に展開し必須フィールドを埋める", () => {
    const simple: SimpleElement[] = [
      { type: "rect", id: "r1", x: 10, y: 20, w: 100, h: 50 },
    ];
    const { elements, skipped } = expandElements(simple, { startIndex: 0, rng: fixedRng });
    expect(skipped).toEqual([]);
    expect(elements).toHaveLength(1);
    const el = elements[0] as Record<string, unknown>;
    expect(el.id).toBe("r1");
    expect(el.type).toBe("rectangle");
    expect(el).toMatchObject({ x: 10, y: 20, width: 100, height: 50, isDeleted: false, locked: false });
    // Excalidraw 必須フィールドが存在する
    for (const k of ["angle","strokeColor","backgroundColor","fillStyle","strokeWidth","strokeStyle","roughness","opacity","groupIds","frameId","index","roundness","seed","version","versionNonce","boundElements","updated","link"]) {
      expect(el).toHaveProperty(k);
    }
    expect(el.index).toBe("a0");
  });

  it("rect の text はシェイプ + 中央寄せ text 要素の2つに展開する", () => {
    const { elements } = expandElements(
      [{ type: "rect", id: "r1", x: 0, y: 0, w: 100, h: 40, text: "API" }],
      { startIndex: 0, rng: fixedRng }
    );
    expect(elements).toHaveLength(2);
    const text = elements.find(e => (e as Record<string, unknown>).type === "text") as Record<string, unknown>;
    expect(text.text).toBe("API");
    // rect の中央付近に配置
    expect(text.x).toBe(50 + 0 - (String("API").length * 3)); // 実装と一致させる（下の実装参照）
  });

  it("arrow を from/to シェイプの中心で結ぶ（同一バッチ内の id を解決）", () => {
    const simple: SimpleElement[] = [
      { type: "rect", id: "a", x: 0, y: 0, w: 100, h: 40 },
      { type: "rect", id: "b", x: 300, y: 0, w: 100, h: 40 },
      { type: "arrow", id: "ar1", from: "a", to: "b" },
    ];
    const { elements, skipped } = expandElements(simple, { startIndex: 0, rng: fixedRng });
    expect(skipped).toEqual([]);
    const arrow = elements.find(e => (e as Record<string, unknown>).type === "arrow") as Record<string, unknown>;
    expect(arrow).toBeTruthy();
    expect((arrow.startBinding as Record<string, unknown>).elementId).toBe("a");
    expect((arrow.endBinding as Record<string, unknown>).elementId).toBe("b");
    expect(Array.isArray(arrow.points)).toBe(true);
  });

  it("解決できない参照や未知 type は skipped に入れ scene を壊さない", () => {
    const { elements, skipped } = expandElements(
      [
        { type: "arrow", id: "bad", from: "x", to: "y" },
        { type: "star" as unknown as "rect", id: "u1", x: 0, y: 0, w: 1, h: 1 },
      ],
      { startIndex: 0, rng: fixedRng }
    );
    expect(elements).toEqual([]);
    expect(skipped.map(s => s.id)).toEqual(["bad", "u1"]);
  });

  it("startIndex を反映して fractional index を採番する", () => {
    const { elements } = expandElements(
      [{ type: "text", id: "t1", x: 0, y: 0, text: "hi" }],
      { startIndex: 3, rng: fixedRng }
    );
    expect((elements[0] as Record<string, unknown>).index).toBe("a3");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter @ark/server exec vitest run src/lib/board-element-codec.test.ts`
Expected: FAIL（`Cannot find module './board-element-codec.js'`）

- [ ] **Step 3: 最小実装を書く**

```ts
// packages/server/src/lib/board-element-codec.ts
/**
 * 簡略スキーマ（board_write の入力）→ 正規 Excalidraw 要素への変換（純ロジック）。
 * Phase A の簡略化:
 *  - シェイプの text ラベルは containerId バインドではなく、中央寄せの独立 text 要素にする。
 *  - arrow の from/to は「同一バッチ内のシェイプ id」を解決する（既存 scene への横断参照は Phase C）。
 */

export type SimpleShape = {
  type: "rect" | "ellipse" | "diamond";
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  color?: string;
};
export type SimpleText = {
  type: "text";
  id: string;
  x: number;
  y: number;
  text: string;
  color?: string;
};
export type SimpleArrow = {
  type: "arrow";
  id: string;
  from: string;
  to: string;
  label?: string;
};
export type SimpleElement = SimpleShape | SimpleText | SimpleArrow;

export type ExcalidrawElement = Record<string, unknown>;

const SHAPE_TYPE_MAP: Record<string, string> = {
  rect: "rectangle",
  ellipse: "ellipse",
  diamond: "diamond",
};

/** fractional index。Phase A は "a" + 連番で十分（厳密な fractional-indexing は不要）。 */
function fractionalIndex(n: number): string {
  return `a${n}`;
}

/** Excalidraw 要素の共通必須フィールドを埋める。 */
function baseElement(
  id: string,
  type: string,
  x: number,
  y: number,
  width: number,
  height: number,
  index: string,
  rng: () => number,
  strokeColor: string
): ExcalidrawElement {
  const seed = Math.floor(rng() * 2 ** 31);
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index,
    roundness: type === "rectangle" ? { type: 3 } : null,
    seed,
    version: 1,
    versionNonce: Math.floor(rng() * 2 ** 31),
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  };
}

/** シェイプ中央に置く独立 text 要素を作る（Phase A: container バインドしない）。 */
function centeredText(
  id: string,
  cx: number,
  cy: number,
  text: string,
  index: string,
  rng: () => number,
  strokeColor: string
): ExcalidrawElement {
  const fontSize = 20;
  // 概算幅（等幅前提の粗い見積り。厳密なメトリクスは不要）
  const width = text.length * 6;
  const height = fontSize * 1.25;
  return {
    ...baseElement(id, "text", cx - width / 2, cy - height / 2, width, height, index, rng, strokeColor),
    text,
    originalText: text,
    fontSize,
    fontFamily: 1,
    textAlign: "center",
    verticalAlign: "middle",
    containerId: null,
    lineHeight: 1.25,
    autoResize: true,
    baseline: fontSize,
    roundness: null,
  };
}

export function expandElements(
  simple: SimpleElement[],
  opts: { startIndex: number; rng?: () => number }
): { elements: ExcalidrawElement[]; skipped: { id?: string; reason: string }[] } {
  const rng = opts.rng ?? Math.random;
  const strokeDefault = "#1e1e1e";
  const elements: ExcalidrawElement[] = [];
  const skipped: { id?: string; reason: string }[] = [];
  // arrow 解決用: バッチ内シェイプの矩形を id で引く
  const shapeBox = new Map<string, { x: number; y: number; w: number; h: number }>();
  let idx = opts.startIndex;

  // 1 パス目: シェイプと text を展開しつつ shapeBox を作る
  for (const el of simple) {
    if (el.type === "rect" || el.type === "ellipse" || el.type === "diamond") {
      const exType = SHAPE_TYPE_MAP[el.type];
      elements.push(
        baseElement(el.id, exType, el.x, el.y, el.w, el.h, fractionalIndex(idx++), rng, el.color ?? strokeDefault)
      );
      shapeBox.set(el.id, { x: el.x, y: el.y, w: el.w, h: el.h });
      if (el.text) {
        elements.push(
          centeredText(`${el.id}__label`, el.x + el.w / 2, el.y + el.h / 2, el.text, fractionalIndex(idx++), rng, el.color ?? strokeDefault)
        );
      }
    } else if (el.type === "text") {
      elements.push(
        baseElement(el.id, "text", el.x, el.y, el.text.length * 6, 25, fractionalIndex(idx++), rng, el.color ?? strokeDefault)
      );
      // text 固有フィールドを付与
      const t = elements[elements.length - 1] as Record<string, unknown>;
      Object.assign(t, {
        text: el.text,
        originalText: el.text,
        fontSize: 20,
        fontFamily: 1,
        textAlign: "left",
        verticalAlign: "top",
        containerId: null,
        lineHeight: 1.25,
        autoResize: true,
        baseline: 20,
        roundness: null,
      });
    } else if (el.type === "arrow") {
      // 2 パス目で解決するため一旦スキップ
    } else {
      skipped.push({ id: (el as { id?: string }).id, reason: `unknown type: ${(el as { type?: string }).type}` });
    }
  }

  // 2 パス目: arrow を shapeBox で解決
  for (const el of simple) {
    if (el.type !== "arrow") continue;
    const from = shapeBox.get(el.from);
    const to = shapeBox.get(el.to);
    if (!from || !to) {
      skipped.push({ id: el.id, reason: `arrow の from/to を解決できません（from=${el.from}, to=${el.to}）` });
      continue;
    }
    const fx = from.x + from.w / 2;
    const fy = from.y + from.h / 2;
    const tx = to.x + to.w / 2;
    const ty = to.y + to.h / 2;
    const arrow: ExcalidrawElement = {
      ...baseElement(el.id, "arrow", fx, fy, tx - fx, ty - fy, fractionalIndex(idx++), rng, strokeDefault),
      points: [
        [0, 0],
        [tx - fx, ty - fy],
      ],
      lastCommittedPoint: null,
      startBinding: { elementId: el.from, focus: 0, gap: 4 },
      endBinding: { elementId: el.to, focus: 0, gap: 4 },
      startArrowhead: null,
      endArrowhead: "arrow",
      roundness: { type: 2 },
    };
    elements.push(arrow);
  }

  return { elements, skipped };
}
```

- [ ] **Step 4: テスト内の text 中央寄せ期待値を実装に合わせて確定**

`centeredText` は `width = text.length * 6`、`x = cx - width/2`。テスト "rect の text は…" の期待式を実装に合わせる:
```ts
// 修正: expect(text.x).toBe(0 + 100/2 - (("API".length * 6) / 2));  // = 50 - 9 = 41
expect(text.x).toBe(41);
```
（Step 1 の暫定式を上記に置き換える。）

- [ ] **Step 5: テストが通ることを確認**

Run: `pnpm --filter @ark/server exec vitest run src/lib/board-element-codec.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 6: 型チェック + コミット**

Run: `pnpm --filter @ark/server check`
Expected: エラーなし
```bash
git add packages/server/src/lib/board-element-codec.ts packages/server/src/lib/board-element-codec.test.ts
git commit -m "feat(board): 簡略スキーマ→Excalidraw要素のcodecを追加"
```

---

## Task 2: BoardMcpServer + board_write ツール + registry

**Files:**
- Create: `packages/server/src/lib/board-mcp-server.ts`
- Test: `packages/server/src/lib/board-mcp-server.test.ts`

**Interfaces:**
- Consumes: `expandElements`, `SimpleElement`（Task 1）
- Produces:
  - `interface BoardMcpDeps { getBoardScene(worktreePath: string): { elements: unknown[] }; saveBoardScene(worktreePath: string, scene: { elements: unknown[] }): void; notifyUpdated(worktreePath: string): void }`
  - `class BoardSessionRegistry { register(token: string, worktreePath: string): void; unregister(token: string): void; resolve(token: string): string | null }`
  - `createBoardMcpServer(deps: BoardMcpDeps, registry: BoardSessionRegistry): McpServer`（stateless factory。request の bearer token を registry で解決）
  - `class BoardMcpServer { start(deps, registry, opts?: { port?: number; token?: never }): Promise<{ url: string }>; getPort(): number | null; stop(): void }`
    - 注: ArkMcpServer と違い token は per-request（registry 解決）なので server 単一 token は持たない。

**設計メモ（実装者向け）:** stateless transport は request 毎に `createBoardMcpServer` で server を生成する。bearer token は `Authorization` ヘッダから取り出し registry で worktree_path に解決する。解決不能なら 401 相当（ツール内で `isError` を返すのではなく、認証ミドルウェアで弾く）。ArkMcpServer（`ark-mcp-server.ts`）の HTTP/transport 構造をそのまま流用し、認証だけ「固定 token 一致」→「registry に存在する token か」に変える。

- [ ] **Step 1: registry と board_write の失敗テストを書く**

```ts
// packages/server/src/lib/board-mcp-server.test.ts
import { describe, expect, it, vi } from "vitest";
import { BoardSessionRegistry, handleBoardWrite } from "./board-mcp-server.js";

describe("BoardSessionRegistry", () => {
  it("register/resolve/unregister が機能する", () => {
    const r = new BoardSessionRegistry();
    r.register("tok1", "/wt/a");
    expect(r.resolve("tok1")).toBe("/wt/a");
    r.unregister("tok1");
    expect(r.resolve("tok1")).toBeNull();
    expect(r.resolve("unknown")).toBeNull();
  });
});

describe("handleBoardWrite", () => {
  const makeDeps = (initial: unknown[] = []) => {
    let scene = { elements: initial };
    return {
      getBoardScene: vi.fn(() => scene),
      saveBoardScene: vi.fn((_wt: string, s: { elements: unknown[] }) => { scene = s; }),
      notifyUpdated: vi.fn(),
      current: () => scene,
    };
  };

  it("append: 既存に要素を追加し canvas を通知する", () => {
    const deps = makeDeps([{ id: "old", type: "rectangle", index: "a0" }]);
    const res = handleBoardWrite(deps, "/wt/a", {
      mode: "append",
      elements: [{ type: "rect", id: "r1", x: 0, y: 0, w: 10, h: 10 }],
    });
    expect(deps.current().elements).toHaveLength(2);
    expect(deps.notifyUpdated).toHaveBeenCalledWith("/wt/a");
    expect(res.added).toBe(1);
    expect(res.total).toBe(2);
  });

  it("replace: 既存を破棄して置換する", () => {
    const deps = makeDeps([{ id: "old", type: "rectangle", index: "a0" }]);
    handleBoardWrite(deps, "/wt/a", {
      mode: "replace",
      elements: [{ type: "text", id: "t1", x: 0, y: 0, text: "hi" }],
    });
    expect(deps.current().elements).toHaveLength(1);
    expect((deps.current().elements[0] as Record<string, unknown>).id).toBe("t1");
  });

  it("無効要素は skip し、返り値に含める（scene は壊さない）", () => {
    const deps = makeDeps([]);
    const res = handleBoardWrite(deps, "/wt/a", {
      mode: "append",
      elements: [{ type: "arrow", id: "bad", from: "x", to: "y" }],
    });
    expect(res.added).toBe(0);
    expect(res.skipped.length).toBe(1);
    // 有効要素ゼロなら保存も通知もしない
    expect(deps.saveBoardScene).not.toHaveBeenCalled();
    expect(deps.notifyUpdated).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter @ark/server exec vitest run src/lib/board-mcp-server.test.ts`
Expected: FAIL（module/export なし）

- [ ] **Step 3: registry と handleBoardWrite を実装**

```ts
// packages/server/src/lib/board-mcp-server.ts（抜粋・純ロジック部）
import { expandElements, type SimpleElement } from "./board-element-codec.js";

export class BoardSessionRegistry {
  private map = new Map<string, string>();
  register(token: string, worktreePath: string): void { this.map.set(token, worktreePath); }
  unregister(token: string): void { this.map.delete(token); }
  resolve(token: string): string | null { return this.map.get(token) ?? null; }
}

export interface BoardMcpDeps {
  getBoardScene(worktreePath: string): { elements: unknown[] };
  saveBoardScene(worktreePath: string, scene: { elements: unknown[] }): void;
  notifyUpdated(worktreePath: string): void;
}

export interface BoardWriteInput { mode: "append" | "replace"; elements: SimpleElement[] }
export interface BoardWriteResult { added: number; total: number; skipped: { id?: string; reason: string }[] }

export function handleBoardWrite(
  deps: Pick<BoardMcpDeps, "getBoardScene" | "saveBoardScene" | "notifyUpdated">,
  worktreePath: string,
  input: BoardWriteInput
): BoardWriteResult {
  const existing = input.mode === "replace" ? [] : (deps.getBoardScene(worktreePath).elements ?? []);
  const { elements, skipped } = expandElements(input.elements, { startIndex: existing.length });
  if (elements.length === 0) {
    return { added: 0, total: existing.length, skipped };
  }
  const merged = [...existing, ...elements];
  deps.saveBoardScene(worktreePath, { elements: merged });
  deps.notifyUpdated(worktreePath);
  return { added: elements.length, total: merged.length, skipped };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm --filter @ark/server exec vitest run src/lib/board-mcp-server.test.ts`
Expected: PASS

- [ ] **Step 5: HTTP server（createBoardMcpServer + BoardMcpServer クラス）を実装**

`ark-mcp-server.ts` の `createArkMcpServer` / `ArkMcpServer` を参考に、以下を追記する（テスト対象は上の純ロジックで担保済みなので、この Step は HTTP 配線）。ツール登録:

```ts
// board-mcp-server.ts（続き）
import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { getErrorMessage } from "./errors.js";

function textResult(text: string) { return { content: [{ type: "text" as const, text }] }; }

// board_write の zod schema（Claude 向け description を丁寧に）
const simpleElementSchema = z.array(z.record(z.any())); // 実装では discriminated union を推奨。Phase A は record で受け codec 側で検証。

export function createBoardMcpServer(deps: BoardMcpDeps, worktreePath: string): McpServer {
  const server = new McpServer({ name: "ark-board", version: "1.0.0" });
  server.registerTool(
    "board_write",
    {
      description:
        "ユーザーがこのセッションのボードへの図解を求めたときに、ボードに図を描く。elements は簡略スキーマ: " +
        '{type:"rect"|"ellipse"|"diamond",id,x,y,w,h,text?,color?} / {type:"text",id,x,y,text,color?} / {type:"arrow",id,from,to,label?}。' +
        "arrow の from/to は同じ呼び出し内のシェイプ id を指す。mode=append(既定,追記) / replace(全置換,ユーザーが明示要求した時のみ)。座標は左上原点・px。",
      inputSchema: {
        mode: z.enum(["append", "replace"]).default("append"),
        elements: simpleElementSchema.describe("描く要素の配列（簡略スキーマ）"),
      },
    },
    async args => {
      try {
        const res = handleBoardWrite(deps, worktreePath, {
          mode: args.mode ?? "append",
          elements: args.elements as unknown as SimpleElement[],
        });
        return textResult(JSON.stringify(res));
      } catch (e) {
        return textResult(`board_write 失敗: ${getErrorMessage(e)}`);
      }
    }
  );
  return server;
}
```

HTTP ライフサイクル（`BoardMcpServer` クラス）は `ArkMcpServer` と同構造にし、**認証ミドルウェアだけ変更**する:
```ts
// 認証: Bearer token を registry で worktree に解決。解決できなければ 401。
const requireSession: express.RequestHandler = (req, res, next) => {
  const auth = req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const worktreePath = registry.resolve(token);
  if (!worktreePath) {
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null });
    return;
  }
  (req as express.Request & { worktreePath: string }).worktreePath = worktreePath;
  next();
};
app.post("/mcp", requireSession, async (req, res) => {
  const worktreePath = (req as express.Request & { worktreePath: string }).worktreePath;
  const server = createBoardMcpServer(deps, worktreePath);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
```
`start(deps, registry, opts)` は `preferredPort`（永続化ポート）を bind、失敗時 ephemeral フォールバック（ArkMcpServer と同じ）。`stop()` で httpServer を close。

- [ ] **Step 6: 型チェック + コミット**

Run: `pnpm --filter @ark/server check`
Expected: エラーなし
```bash
git add packages/server/src/lib/board-mcp-server.ts packages/server/src/lib/board-mcp-server.test.ts
git commit -m "feat(board): board_write を持つ session スコープ BoardMcpServer を追加"
```

---

## Task 3: DB アダプタ + canvas:updated 通知の配線（BoardMcpDeps 実体）

**Files:**
- Modify: `packages/server/src/index.ts`（`BoardMcpServer` 起動 + deps 実装 + registry 保持）
- Test: `packages/server/src/lib/board-mcp-server.test.ts`（deps 実体は index 配線なので、ここでは既存 handleBoardWrite テストで担保。追加テスト不要）

**Interfaces:**
- Consumes: `db.getCanvasBoard(worktreePath) → { scene: string; ... }`、`db.saveCanvasBoardScene(worktreePath, scene, baseRevision?)`、Socket.IO `io`、board room 名ヘルパー（`index.ts:170` の room 関数）。
- Produces: 稼働中の `BoardMcpServer` インスタンス + `BoardSessionRegistry`（Task 4 が使う）。

- [ ] **Step 1: BoardMcpDeps を index.ts で実装して起動する**

`db.getCanvasBoard` は `scene` を **文字列**で返し、`saveCanvasBoardScene` は文字列を受ける。BoardMcpDeps は `{ elements }` オブジェクトを扱うので、境界で JSON パース/文字列化する:
```ts
// index.ts（起動シーケンス内。io と db は既存の変数）
import { BoardMcpServer, BoardSessionRegistry } from "./lib/board-mcp-server.js";

const boardRegistry = new BoardSessionRegistry();
const boardMcp = new BoardMcpServer();
const boardDeps = {
  getBoardScene(worktreePath: string) {
    const row = db.getCanvasBoard(worktreePath);
    if (!row?.scene) return { elements: [] };
    try {
      const parsed = JSON.parse(row.scene) as { elements?: unknown[] };
      return { elements: parsed.elements ?? [] };
    } catch {
      return { elements: [] };
    }
  },
  saveBoardScene(worktreePath: string, scene: { elements: unknown[] }) {
    // Excalidraw scene の最小形。appState/files は既存 scene を尊重したい場合は
    // getCanvasBoard で読み直してマージするが、Phase A は elements のみ更新で十分。
    db.saveCanvasBoardScene(worktreePath, JSON.stringify(scene));
  },
  notifyUpdated(worktreePath: string) {
    io.to(boardRoom(worktreePath)).emit("canvas:updated", { worktreePath });
  },
};
// 永続化ポートがあれば渡す（Task 5 で設定永続化。Phase A 初回は ephemeral 可）
const boardPort = db.getSetting?.("board_mcp_port");
await boardMcp.start(boardDeps, boardRegistry, { port: boardPort ? Number(boardPort) : undefined });
```
`boardRoom` は既存 room ヘルパー（`index.ts:170` 付近）を再利用する（無ければ `canvas:${worktreePath}` 等の既存命名に合わせる）。

- [ ] **Step 2: 型チェック**

Run: `pnpm --filter @ark/server check`
Expected: エラーなし（`db.getSetting` が無ければ Task 5 で追加するまで `undefined` ガードで対応）

- [ ] **Step 3: コミット**

```bash
git add packages/server/src/index.ts
git commit -m "feat(board): BoardMcpServer を起動し canvas_boards/socket に配線"
```

---

## Task 4: セッション起動時の MCP 注入（registry 登録 + mcp-config + --mcp-config）

**Files:**
- Modify: `packages/server/src/lib/tmux-manager.ts`（`--mcp-config` 注入）
- Modify: `packages/server/src/lib/session-orchestrator.ts`（token 生成・registry 登録・mcp-config ファイル生成・停止時解除）
- Test: `packages/server/src/lib/tmux-manager.test.ts`（コマンド組み立てに `--mcp-config` が含まれること）

**Interfaces:**
- Consumes: `BoardMcpServer.getPort()` / `BoardSessionRegistry`（Task 2/3）、`tmuxManager` の起動コマンド組み立て。
- Produces: 会話セッションの claude が `--mcp-config <per-session.json> --strict-mcp-config` で `ark-board` MCP に接続する。

- [ ] **Step 1: tmux-manager の `--mcp-config` 注入テスト（失敗）**

既存の起動コマンド組み立てを検証しているテストに倣い、`mcpConfigPath` 設定時にコマンドへ `--mcp-config <quoted> --strict-mcp-config` が含まれることを検証するテストを追加:
```ts
// tmux-manager.test.ts（既存テストのスタイルに合わせて追記）
it("mcpConfigPath 設定時に --mcp-config を注入する", () => {
  const mgr = new TmuxManager();
  mgr.setClaudeMcpConfigPath("/tmp/sess-mcp.json");
  const cmd = mgr.buildClaudeCommandForTest(/* 既存テストが使うヘルパー/引数に合わせる */);
  expect(cmd).toContain("--mcp-config");
  expect(cmd).toContain("/tmp/sess-mcp.json");
  expect(cmd).toContain("--strict-mcp-config");
});
```
（`buildClaudeCommandForTest` 等の露出が無ければ、既存テストが起動コマンドをどう検証しているかに合わせる。無ければ setter + getter の単体で検証する最小テストにする。）

- [ ] **Step 2: 失敗を確認**

Run: `pnpm --filter @ark/server exec vitest run src/lib/tmux-manager.test.ts`
Expected: FAIL

- [ ] **Step 3: tmux-manager に mcpConfig 注入を実装**

`claudeSettingsPath`（133-157 行）と同型で `claudeMcpConfigPath` を追加:
```ts
// tmux-manager.ts
private claudeMcpConfigPath: string | null = null;
setClaudeMcpConfigPath(value: string | null): void { this.claudeMcpConfigPath = value; }
```
起動コマンド組み立て（`settingsArg` の直後、315-318 付近）に追記:
```ts
const mcpConfigArg = this.claudeMcpConfigPath
  ? ` --mcp-config ${posixShellQuote(this.claudeMcpConfigPath)} --strict-mcp-config`
  : "";
// claude 起動文字列に settingsArg と mcpConfigArg の両方を連結する
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm --filter @ark/server exec vitest run src/lib/tmux-manager.test.ts`
Expected: PASS

- [ ] **Step 5: session-orchestrator で per-session mcp-config を用意して注入**

`startSession`（378 行〜）で、tmux 起動の直前に:
```ts
// session-orchestrator.ts（startSession 内、worktreePath が確定した後）
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// this.boardMcp / this.boardRegistry は index.ts から注入（コンストラクタ or setter）
const boardPort = this.boardMcp?.getPort();
if (boardPort && this.boardRegistry) {
  const token = randomBytes(24).toString("hex");
  this.boardRegistry.register(token, worktreePath);
  const dir = join(tmpdir(), "ark-board-mcp");
  mkdirSync(dir, { recursive: true });
  const cfgPath = join(dir, `${sessionId}.json`);
  writeFileSync(
    cfgPath,
    JSON.stringify({
      mcpServers: {
        "ark-board": {
          type: "http",
          url: `http://127.0.0.1:${boardPort}/mcp`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    })
  );
  this.tmuxManager.setClaudeMcpConfigPath(cfgPath);
  // token を後で unregister するため session メタに保持
  this.sessionBoardTokens.set(sessionId, token);
} else {
  this.tmuxManager.setClaudeMcpConfigPath(null);
}
```
`stopSession` で解除:
```ts
const token = this.sessionBoardTokens.get(sessionId);
if (token && this.boardRegistry) { this.boardRegistry.unregister(token); this.sessionBoardTokens.delete(sessionId); }
```
（`this.sessionBoardTokens = new Map<string,string>()` をフィールド追加。`boardMcp`/`boardRegistry` は `index.ts` が `SessionOrchestrator` 生成時に渡す。）

- [ ] **Step 6: index.ts で orchestrator に board 依存を渡す**

```ts
// index.ts: SessionOrchestrator 生成箇所に boardMcp / boardRegistry を渡す（コンストラクタ引数 or setter を追加）
orchestrator.setBoardMcp(boardMcp, boardRegistry);
```

- [ ] **Step 7: 型チェック + コミット**

Run: `pnpm --filter @ark/server check`
Expected: エラーなし
```bash
git add packages/server/src/lib/tmux-manager.ts packages/server/src/lib/tmux-manager.test.ts packages/server/src/lib/session-orchestrator.ts packages/server/src/index.ts
git commit -m "feat(board): 会話セッション起動時にper-session --mcp-configを注入"
```

---

## Task 5: ポート永続化（再起動後も同一ポート）+ E2E 手動確認

**Files:**
- Modify: `packages/server/src/index.ts`（起動ポートを settings に保存）
- Modify: `packages/server/src/lib/database.ts`（`getSetting`/`setSetting` が無ければ既存の settings 機構を確認して流用）

**Interfaces:**
- Consumes: `BoardMcpServer.getPort()`、既存の settings 永続化（Beacon が `beacon_ark_mcp_port` で使っている機構）。

- [ ] **Step 1: 起動後にポートを保存**

Beacon の `beacon_ark_mcp_port` と同じ settings 機構を使い、`boardMcp.start()` 成功後にポートを保存する:
```ts
const port = boardMcp.getPort();
if (port) db.setSetting("board_mcp_port", String(port));
```
（既存の settings API 名は Beacon 実装で確認して合わせる。無ければ最小の key-value settings を database.ts に追加。）

- [ ] **Step 2: 型チェック + サーバ起動確認**

Run: `pnpm --filter @ark/server check`
Expected: エラーなし

- [ ] **Step 3: 手動 E2E（実機）**

デプロイ手順（CLAUDE.md）に従い反映:
```bash
pkill -f ttyd
pnpm build
pm2 restart claude-code-ark
```
確認:
1. 任意 worktree のセッションを起動 → チャットで「この設計を3ボックスのフローで図解して。rect3つとarrow2本で」等と依頼。
2. Claude が `board_write` を呼び、ボードタブに rect/arrow が現れることを確認（`canvas:updated` で自動再描画）。
3. DB 確認: `sqlite3 data/sessions.db "SELECT length(scene) FROM canvas_boards WHERE worktree_path='<path>';"` が増えている。
4. サーバ再起動後も既存セッションから再度「図解して」で描けること（ポート永続化の確認。※token registry の再起動復元は Phase C。再起動直後の既存セッションは 401 になり得る＝既知制約）。

- [ ] **Step 4: コミット**

```bash
git add packages/server/src/index.ts packages/server/src/lib/database.ts
git commit -m "feat(board): BoardMcpServerのポートを永続化"
```

---

## Self-Review（spec 対応チェック）

- **board_write（Excalidraw 要素を直接）**: Task 1（codec）+ Task 2（tool）で実装。✓
- **session スコープ MCP（token→worktree 自動解決）**: Task 2（registry + 認証）+ Task 4（token 発行/注入/解除）。✓
- **canvas:updated 再描画・自動反映**: Task 3（notifyUpdated → 既存 room emit）。✓
- **--mcp-config 注入（--settings と同型）**: Task 4（tmux-manager + orchestrator）。✓
- **ポート永続化（C-B3 同型）**: Task 5。✓
- **自動オープン（ボードタブ）**: サーバは `canvas:updated` を emit するのみ。**クライアント側の「Claude 由来更新でボードタブを自動フォーカス」は本 Phase A のサーバ範囲外**。→ **ギャップ**: 最小の UI 対応（`canvas:updated` 受信時にボードタブが非表示なら通知/自動切替）は Phase A の締めに小タスクとして追加するか、Phase B のUIまとめに送る。**決定: 自動オープンは Phase B（UI まとめ）へ移す**（Phase A はサーバで「描ける」ことをゴールにする）。spec の Phase 定義に合わせ、本 plan の Goal からは「自動オープン」を Phase B へ移動済みとする。
- **read/通知/ボタン撤去**: Phase B（本 plan 対象外）。
- **プレースホルダ走査**: 具体コード・コマンド・期待値を記載。テスト内の暫定式は Task1 Step4 で確定。✓
- **型整合**: `BoardMcpDeps`/`handleBoardWrite`/`BoardSessionRegistry`/`expandElements`/`SimpleElement` の名称は Task 間で一致。`getCanvasBoard`(返り: `{scene:string,...}`) と boardDeps の JSON 境界も一致。✓

（自動オープンの扱いを Phase B に寄せる調整のみ。他ギャップなし。）

---

## 注意（実装者向けの既知の曖昧点）

- `tmux-manager` の起動コマンド検証テストの露出（`buildClaudeCommandForTest` 等）が無い場合、Task 4 Step1 は setter/getter または起動文字列生成関数の最小テストに置き換える。
- 既存 settings API（`getSetting`/`setSetting`）の実名は Beacon 実装（`beacon_ark_mcp_port` を保存している箇所）で確認して合わせる。無ければ database.ts に最小 key-value を追加。
- `boardRoom` ヘルパーの実名は `index.ts:170` 付近を参照。
