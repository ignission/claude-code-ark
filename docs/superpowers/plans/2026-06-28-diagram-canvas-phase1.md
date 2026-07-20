# 図解キャンバス Phase 1（チャット内インライン Mermaid 描画）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 注: project 規約により本ファイルは git にコミットしない。

**Goal:** Claude が応答に書いた ` ```mermaid ` ブロックを、実チャット（SplitChatPane）にリッチな図として描画する。

**Architecture:** mermaid を strict で初期化する純関数 `renderMermaidToSvg` を作り、React コンポーネント `MermaidBlock` がデバウンス付きで呼ぶ。`SplitChatPane` の react-markdown `code`/`pre` コンポーネントで言語 `mermaid` を分岐し MermaidBlock に振る。構文エラー時は生コードにフォールバック。

**Tech Stack:** React 19, react-markdown 10, mermaid（新規）, vitest 4（env=node）, Vite, pnpm workspace。

## Global Constraints
- パッケージ追加は `pnpm --filter @ark/web add <pkg>`（pnpm workspace）
- mermaid は `securityLevel: "strict"`、`startOnLoad: false`
- 単体テストは vitest（env=node）。実行: `pnpm vitest run <path>`。DOM 描画を要するものは node 環境で不可 → 純関数のみ単体テスト、描画は build + 実セッションで検証
- 型チェック/リント: `pnpm check`（biome + tsc -b）
- 既存テスト書式に倣う: `import { describe, expect, it } from "vitest";`
- 情報源分離: 描画は transcript の text のみが入力。tmux 画面はパースしない

---

### Task 1: mermaid 言語判定ヘルパー（純関数・TDD）

**Files:**
- Create: `packages/web/src/lib/mermaid-block-utils.ts`
- Test: `packages/web/src/lib/mermaid-block-utils.test.ts`

**Interfaces:**
- Produces: `isMermaidCodeClass(className?: string): boolean`

- [ ] **Step 1: 失敗するテストを書く**

`packages/web/src/lib/mermaid-block-utils.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { isMermaidCodeClass } from "./mermaid-block-utils";

describe("isMermaidCodeClass", () => {
  it("language-mermaid を含むと true", () => {
    expect(isMermaidCodeClass("language-mermaid")).toBe(true);
  });
  it("他言語は false", () => {
    expect(isMermaidCodeClass("language-ts")).toBe(false);
  });
  it("className 無しは false", () => {
    expect(isMermaidCodeClass(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run packages/web/src/lib/mermaid-block-utils.test.ts`
Expected: FAIL（`isMermaidCodeClass` が未定義 / モジュール解決エラー）

- [ ] **Step 3: 最小実装**

`packages/web/src/lib/mermaid-block-utils.ts`:
```ts
/** fenced code の className が mermaid 言語かを判定する。 */
export function isMermaidCodeClass(className?: string): boolean {
  if (!className) return false;
  return /\blanguage-mermaid\b/.test(className);
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run packages/web/src/lib/mermaid-block-utils.test.ts`
Expected: PASS（3 件）

- [ ] **Step 5: コミット**

```bash
git add packages/web/src/lib/mermaid-block-utils.ts packages/web/src/lib/mermaid-block-utils.test.ts
git commit -m "feat(chat): mermaid 言語判定ヘルパーを追加"
```

---

### Task 2: mermaid 依存追加 + `renderMermaidToSvg`（mermaid をモックして TDD）

**Files:**
- Modify: `packages/web/package.json`（mermaid 追加）
- Modify: `packages/web/src/lib/mermaid-block-utils.ts`
- Modify: `packages/web/src/lib/mermaid-block-utils.test.ts`

**Interfaces:**
- Produces:
  - `type MermaidRenderResult = { ok: true; svg: string } | { ok: false; error: string }`
  - `renderMermaidToSvg(code: string, id: string): Promise<MermaidRenderResult>`

- [ ] **Step 1: mermaid を追加**

Run: `pnpm --filter @ark/web add mermaid`
Expected: `packages/web/package.json` の dependencies に `mermaid` が入る

- [ ] **Step 2: 失敗するテストを追記**

`packages/web/src/lib/mermaid-block-utils.test.ts` の先頭に hoisted モックを追加し、describe を足す:
```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock は巻き上げられるため、参照する mock は vi.hoisted で先に作る
const { renderMock, initializeMock } = vi.hoisted(() => ({
  renderMock: vi.fn(),
  initializeMock: vi.fn(),
}));
vi.mock("mermaid", () => ({
  default: { render: renderMock, initialize: initializeMock },
}));

import { isMermaidCodeClass, renderMermaidToSvg } from "./mermaid-block-utils";
```
（既存の `import { isMermaidCodeClass } ...` 行は上記の統合 import に置き換える）

ファイル末尾に追加:
```ts
describe("renderMermaidToSvg", () => {
  beforeEach(() => {
    renderMock.mockReset();
    initializeMock.mockReset();
  });

  it("成功時は ok:true と svg を返す", async () => {
    renderMock.mockResolvedValue({ svg: "<svg>ok</svg>" });
    const r = await renderMermaidToSvg("flowchart LR\nA-->B", "m1");
    expect(r).toEqual({ ok: true, svg: "<svg>ok</svg>" });
  });

  it("strict で初期化する", async () => {
    renderMock.mockResolvedValue({ svg: "<svg/>" });
    await renderMermaidToSvg("flowchart LR\nA-->B", "m2");
    expect(initializeMock).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict", startOnLoad: false })
    );
  });

  it("例外時は ok:false とエラー文言を返す（throw しない）", async () => {
    renderMock.mockRejectedValue(new Error("Parse error on line 1"));
    const r = await renderMermaidToSvg("bad", "m3");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Parse error");
  });
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `pnpm vitest run packages/web/src/lib/mermaid-block-utils.test.ts`
Expected: FAIL（`renderMermaidToSvg` が未定義）

- [ ] **Step 4: 実装を追記**

`packages/web/src/lib/mermaid-block-utils.ts` に追記:
```ts
let initialized = false;

export type MermaidRenderResult =
  | { ok: true; svg: string }
  | { ok: false; error: string };

/** mermaid を strict で 1 回だけ初期化し、code を SVG にレンダリングする。
 *  失敗時は throw せず ok:false を返す。 */
export async function renderMermaidToSvg(
  code: string,
  id: string
): Promise<MermaidRenderResult> {
  try {
    const mermaid = (await import("mermaid")).default;
    if (!initialized) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "default",
      });
      initialized = true;
    }
    const { svg } = await mermaid.render(id, code);
    return { ok: true, svg };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `pnpm vitest run packages/web/src/lib/mermaid-block-utils.test.ts`
Expected: PASS（isMermaidCodeClass 3 件 + renderMermaidToSvg 3 件）

- [ ] **Step 6: 型チェック**

Run: `pnpm check`
Expected: エラーなし

- [ ] **Step 7: コミット**

```bash
git add packages/web/package.json pnpm-lock.yaml packages/web/src/lib/mermaid-block-utils.ts packages/web/src/lib/mermaid-block-utils.test.ts
git commit -m "feat(chat): mermaid 依存と renderMermaidToSvg を追加"
```

---

### Task 3: `MermaidBlock` コンポーネント（デバウンス描画 + フォールバック）

**Files:**
- Create: `packages/web/src/components/MermaidBlock.tsx`

**Interfaces:**
- Consumes: `renderMermaidToSvg`（Task 2）
- Produces: `MermaidBlock({ code }: { code: string }): JSX.Element`

> 注: 描画は実 DOM を要し vitest(node) では検証できないため、本タスクは型チェック（`pnpm check`）＋ Task 4 の実セッション描画で検証する。ストリーミング中の未完成 mermaid はデバウンスとエラーフォールバックで吸収する。

- [ ] **Step 1: コンポーネントを実装**

`packages/web/src/components/MermaidBlock.tsx`:
```tsx
import { useEffect, useRef, useState } from "react";
import { renderMermaidToSvg } from "../lib/mermaid-block-utils";

let seq = 0;

/** transcript の ```mermaid ブロックを SVG に描画する。
 *  ストリーミング中の未完成コードは 300ms デバウンス + エラーフォールバックで吸収。 */
export function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`mmd-${(seq += 1)}`);

  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(async () => {
      const result = await renderMermaidToSvg(code, idRef.current);
      if (cancelled) return;
      if (result.ok) {
        setSvg(result.svg);
        setError(null);
      } else {
        setSvg(null);
        setError(result.error);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [code]);

  if (svg === null || error) {
    // 未描画 or 構文エラー: 生コードにフォールバック（pre-in-pre を避け div で表示）
    return (
      <div className="ark-mermaid-fallback my-2 overflow-x-auto rounded bg-muted p-3 font-mono text-sm whitespace-pre">
        {code}
        {error && (
          <span className="mt-1 block font-sans text-xs text-destructive">
            図の描画に失敗しました: {error}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className="ark-mermaid my-2 flex justify-center overflow-x-auto"
      // mermaid strict の出力のため安全
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
```

- [ ] **Step 2: 型チェック**

Run: `pnpm check`
Expected: エラーなし

- [ ] **Step 3: コミット**

```bash
git add packages/web/src/components/MermaidBlock.tsx
git commit -m "feat(chat): MermaidBlock コンポーネントを追加"
```

---

### Task 4: SplitChatPane へ統合し実セッションで検証

**Files:**
- Modify: `packages/web/src/components/SplitChatPane.tsx`（import 追加 + `createMarkdownComponents` の `code`/`pre` 分岐、対象: `:293-328`）

**Interfaces:**
- Consumes: `isMermaidCodeClass`（Task 1）, `MermaidBlock`（Task 3）

- [ ] **Step 1: import を追加**

`SplitChatPane.tsx` の import 群（他の `../lib`/`./` import の近く）に追加:
```tsx
import { isMermaidCodeClass } from "../lib/mermaid-block-utils";
import { MermaidBlock } from "./MermaidBlock";
```

- [ ] **Step 2: `createMarkdownComponents` に `pre` と `code` の分岐を入れる**

`SplitChatPane.tsx:318-326` の `code` を置き換え、同じ返り値オブジェクトに `pre` を追加する:
```tsx
    pre: ({ children, node: _node, ...props }) => {
      // mermaid ブロックは MermaidBlock 自身が描画するので pre を被せない
      const child = Array.isArray(children) ? children[0] : children;
      const cls =
        child && typeof child === "object" && "props" in child
          ? ((child as { props?: { className?: string } }).props?.className ??
            undefined)
          : undefined;
      if (isMermaidCodeClass(cls)) return <>{children}</>;
      return <pre {...props}>{children}</pre>;
    },
    code: ({ className, children, node: _node, ...props }) => {
      if (isMermaidCodeClass(className)) {
        return <MermaidBlock code={reactNodeToText(children)} />;
      }
      return (
        <code className={className} {...props}>
          <FilePathText
            text={reactNodeToText(children)}
            sessionId={sessionId}
            compact
          />
        </code>
      );
    },
```

- [ ] **Step 3: 型チェック / リント**

Run: `pnpm check`
Expected: エラーなし

- [ ] **Step 4: ビルド**

Run: `pnpm --filter @ark/web build`
Expected: ビルド成功（mermaid を含むバンドル生成）

- [ ] **Step 5: 実セッションで描画検証（手動 E2E）**

```bash
# CLAUDE.md のデプロイ手順に従う
pkill -f ttyd
pnpm build
pm2 restart claude-code-ark
```
ブラウザで Ark を開き、任意セッションで Claude に次を出力させる（例: 「次を ```mermaid ブロックで返して: flowchart LR; A[開始]-->B[処理]-->C[完了]」）。
Expected:
- チャット内にフローチャートが図として描画される
- リロードしても transcript から再描画される
- わざと壊れた mermaid を出力させると、生コード + 「図の描画に失敗しました」フォールバックになりペインは落ちない

- [ ] **Step 6: コミット**

```bash
git add packages/web/src/components/SplitChatPane.tsx
git commit -m "feat(chat): チャット内 mermaid ブロックをインライン描画"
```

---

## Self-Review

- **Spec coverage（Phase 1 該当部）**: §4 共有レンダラー(mermaid strict + フォールバック + ストリーミング対策=デバウンス) → Task 2/3。§5 Phase 1(code 分岐, 即価値) → Task 4。§9 構文エラーフォールバック → Task 3/Task4 Step5。§10 単体テスト(成功/エラー) → Task 2。shiki ハイライトは Phase 1 のコア外のため本計画では扱わず、別タスク（後続）に切り出す（YAGNI: mermaid が主価値）。
- **Placeholder scan**: 各ステップに実コード・実コマンド・期待結果あり。TBD/TODO なし。
- **Type consistency**: `isMermaidCodeClass`/`renderMermaidToSvg`/`MermaidRenderResult`/`MermaidBlock({code})` は Task 1→2→3→4 で一貫。

## 補足（Phase 2/3 は別計画）
- 本計画は Phase 1 のみ。Phase 2（キャンバスタブ + transcript 昇格 + MCP canvas_render + 永続化）と Phase 3（注釈 + tmux 還流）は着手時に各々 `docs/superpowers/plans/` へ別計画を書く。`MermaidBlock`/`renderMermaidToSvg` は Phase 2 のキャンバス描画でも再利用する。
