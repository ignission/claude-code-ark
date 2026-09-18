# doc 型ボードの直接編集 Phase 1 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** doc 型ボードの本文を人間がその場で直接編集でき、直した内容がブロック単位で会話セッションへ還流する。

**Architecture:** doc ボードへ新しい注入レイヤ (`diagram-doc-editor.ts`) を載せ、`data-ark-id` を持つブロックを常時 `contenteditable` にする。人間が触ったブロックには `data-ark-author="human"` を自動で付ける。保存と送信は既存の `diagram:autosave` / `diagram:submit` 経路に相乗りする。還流はサーバー側に `id → ブロック本文` の baseline を置き、保存後の実物と比べて変わったブロックの本文だけを送る。

**Tech Stack:** TypeScript / Node.js / vitest / 注入は素の DOM API (フレームワーク無し)

## Global Constraints

- **`packages/server/src/lib/diagram-harness.ts` を変更しない。** graph ハーネスの 128KiB guard (`diagram-harness.test.ts:187`) は `injectHarness` の出力だけを測る。doc 編集層は独立した注入文字列にして、この guard を1バイトも動かさない
- **注入レイヤから外部リソースを参照しない。** inline CSS / Unicode / inline SVG / data URI のみ。CSP meta を自分で書かない
- **`data-ark-author` の語彙は `human` / `claude` の2値のみ。** `data-ark-id` を持つ要素にだけ付け、1要素に1個 (`diagram-doc-authorship.ts` が422で拒否する)
- **`data-ark-id` と model node は1対1。** node id ごとにちょうど1個 (`diagram-doc-anchors.ts` が422で拒否する)。ブロックを増減したら model node も同時に動かす
- **会話へ送る文字列は必ず無害化する。** HTML タグ除去 → 制御文字と改行の除去 → 1ブロック300文字で切る → 10ブロックで打ち切る。エスケープではなく除去 (`diagram-diff.ts` の `sanitizeLabel` と同じ判断)
- **日本語の表記**: 日本語と半角英数字の間に空白を入れない。コロンは半角コロン + 半角スペース。括弧は半角で前後に半角スペース
- **コミットメッセージは日本語。** `Co-Authored-By` を付けない
- テスト実行: リポジトリルートで `pnpm vitest run <path>`

## File Structure

| ファイル | 責務 |
| --- | --- |
| `packages/server/src/lib/diagram-html-scan.ts` (変更) | 開始タグの走査結果に位置 (`start` / `end`) を足す |
| `packages/server/src/lib/diagram-doc-blocks.ts` (新規) | HTML から `id → ブロック` を取り出す。位置と外側 HTML と本文テキスト |
| `packages/server/src/lib/diagram-doc-notice.ts` (新規) | baseline と保存後を比べ、会話へ送る行を組む。無害化もここ |
| `packages/server/src/lib/diagram-doc-label.ts` (新規) | ブロック本文から model の `label` 抜粋を作り直す |
| `packages/server/src/lib/diagram-doc-editor.ts` (新規) | doc ボードへ注入する編集レイヤ (文字列 + 注入関数) |
| `packages/server/src/lib/diagram-submit-notice.ts` (新規) | submit の文面を doc と graph で分けて組む |
| `packages/server/src/lib/diagram-reader.ts` (変更) | doc に編集層を注入する |
| `packages/server/src/lib/diagram-save.ts` (変更) | 保存時に `label` 抜粋を作り直し、書いた本文を返す |
| `packages/server/src/index.ts` (変更) | doc baseline を持ち、submit の還流を doc と graph で分ける |
| `CLAUDE.md` / `.claude/skills/diagram-authoring/SKILL.md` / `board-session-start-hook.ts` (変更) | `data-ark-author="human"` の読み手規約の言い換え |

---

### Task 1: 開始タグの走査に位置を足す

**Files:**
- Modify: `packages/server/src/lib/diagram-html-scan.ts`
- Test: `packages/server/src/lib/diagram-html-scan.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `DiagramHtmlStartTag` に `start: number` (`<` の位置) と `end: number` (`>` の位置) が増える。既存の `name` / `attributes` は変えない

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/lib/diagram-html-scan.test.ts` に追記する。

```ts
it("開始タグの開始位置と終了位置を返す", () => {
  const html = `<div><p data-ark-id="s1-p1">本文</p></div>`;
  const tags = scanDiagramHtmlStartTags(html);
  const p = tags.find(tag => tag.name === "p");
  expect(p).toBeDefined();
  expect(html.slice(p!.start, p!.end + 1)).toBe(`<p data-ark-id="s1-p1">`);
});
```

- [ ] **Step 2: 落ちることを確認する**

Run: `pnpm vitest run packages/server/src/lib/diagram-html-scan.test.ts`
Expected: FAIL (`p!.start` が `undefined` になり `slice` の結果が一致しない)

- [ ] **Step 3: 位置を載せる**

`DiagramHtmlStartTag` へ2つ足す。

```ts
export interface DiagramHtmlStartTag {
  name: string;
  attributes: DiagramHtmlAttribute[];
  /** `<` の位置 */
  start: number;
  /** `>` の位置 */
  end: number;
}
```

`scanDiagramHtmlStartTags` の中で `tags.push({...})` している箇所すべてへ `start: open, end` を足す (`open` と `end` はループ内の既存のローカル変数)。

- [ ] **Step 4: 通ることを確認する**

Run: `pnpm vitest run packages/server/src/lib/diagram-html-scan.test.ts packages/server/src/lib/diagram-doc-anchors.test.ts packages/server/src/lib/diagram-doc-authorship.test.ts`
Expected: PASS (既存の消費側は新しい field を無視するので壊れない)

- [ ] **Step 5: commit**

```bash
git add packages/server/src/lib/diagram-html-scan.ts packages/server/src/lib/diagram-html-scan.test.ts
git commit -m "feat(server): 開始タグの走査結果に位置を載せる"
```

---

### Task 2: HTML から doc ブロックを取り出す

**Files:**
- Create: `packages/server/src/lib/diagram-doc-blocks.ts`
- Test: `packages/server/src/lib/diagram-doc-blocks.test.ts`

**Interfaces:**
- Consumes: Task 1 の `scanDiagramHtmlStartTags` (`start` / `end` 付き)
- Produces: `extractDocBlocks(html: string): Map<string, DocBlock>` と `interface DocBlock { id: string; html: string; text: string }`。`html` は開始タグから閉じタグまでを含む外側 HTML、`text` はタグを除いて空白を畳んだ本文

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { describe, expect, it } from "vitest";
import { extractDocBlocks } from "./diagram-doc-blocks.js";

describe("extractDocBlocks", () => {
  it("data-ark-id を持つ要素を id で引けるようにする", () => {
    const html = `<body><p data-ark-id="s1-p1">ひとつめ</p><p data-ark-id="s1-p2">ふたつめ</p></body>`;
    const blocks = extractDocBlocks(html);
    expect([...blocks.keys()]).toEqual(["s1-p1", "s1-p2"]);
    expect(blocks.get("s1-p1")?.text).toBe("ひとつめ");
    expect(blocks.get("s1-p1")?.html).toBe(`<p data-ark-id="s1-p1">ひとつめ</p>`);
  });

  it("入れ子のブロックを取り違えない", () => {
    const html = `<section data-ark-id="s1"><p data-ark-id="s1-p1">なか</p></section>`;
    const blocks = extractDocBlocks(html);
    expect(blocks.get("s1")?.text).toBe("なか");
    expect(blocks.get("s1-p1")?.html).toBe(`<p data-ark-id="s1-p1">なか</p>`);
  });

  it("同じタグ名の入れ子でも対応する閉じタグを選ぶ", () => {
    const html = `<div data-ark-id="a"><div>なか</div>そと</div>`;
    expect(extractDocBlocks(html).get("a")?.text).toBe("なか そと");
  });

  it("void 要素は内側を持たない", () => {
    const html = `<img data-ark-id="s1-f1" alt="図">`;
    const blocks = extractDocBlocks(html);
    expect(blocks.get("s1-f1")?.text).toBe("");
    expect(blocks.get("s1-f1")?.html).toBe(`<img data-ark-id="s1-f1" alt="図">`);
  });

  it("本文の空白を1つに畳む", () => {
    const html = "<p data-ark-id=\"p\">  あ\n  い  </p>";
    expect(extractDocBlocks(html).get("p")?.text).toBe("あ い");
  });
});
```

- [ ] **Step 2: 落ちることを確認する**

Run: `pnpm vitest run packages/server/src/lib/diagram-doc-blocks.test.ts`
Expected: FAIL (`Cannot find module './diagram-doc-blocks.js'`)

- [ ] **Step 3: 実装する**

```ts
/**
 * doc 本文から `data-ark-id` を持つブロックを取り出す。
 *
 * 還流は「変わったブロックの本文」を送るため、id からブロックの現在の姿を
 * 引けるようにする。同じタグ名の入れ子があるので、閉じタグは深さを数えて選ぶ。
 */

import { scanDiagramHtmlStartTags } from "./diagram-html-scan.js";

export interface DocBlock {
  id: string;
  /** 開始タグから閉じタグまでの外側 HTML */
  html: string;
  /** タグを除き空白を1つに畳んだ本文 */
  text: string;
}

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "source", "track", "wbr",
]);

function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** 開始タグに対応する閉じタグの終端 (`>` の次) を返す。見つからなければ -1 */
function closeTagEnd(html: string, name: string, afterStartTag: number): number {
  const lower = html.toLowerCase();
  const open = `<${name}`;
  const close = `</${name}`;
  let depth = 1;
  let index = afterStartTag;
  while (index < html.length) {
    const nextOpen = lower.indexOf(open, index);
    const nextClose = lower.indexOf(close, index);
    if (nextClose < 0) return -1;
    if (nextOpen >= 0 && nextOpen < nextClose) {
      // `<p` が `<pre` に当たらないよう、直後が名前の続きでないことを見る
      const after = lower[nextOpen + open.length] ?? ">";
      if (!/[a-z0-9-]/u.test(after)) depth += 1;
      index = nextOpen + open.length;
      continue;
    }
    depth -= 1;
    const gt = html.indexOf(">", nextClose);
    if (gt < 0) return -1;
    if (depth === 0) return gt + 1;
    index = gt + 1;
  }
  return -1;
}

export function extractDocBlocks(html: string): Map<string, DocBlock> {
  const blocks = new Map<string, DocBlock>();
  for (const tag of scanDiagramHtmlStartTags(html)) {
    const id = tag.attributes.find(a => a.name === "data-ark-id")?.value;
    if (id === undefined || id === "") continue;
    if (blocks.has(id)) continue;

    const name = tag.name.toLowerCase();
    if (VOID_ELEMENTS.has(name)) {
      blocks.set(id, {
        id,
        html: html.slice(tag.start, tag.end + 1),
        text: "",
      });
      continue;
    }
    const end = closeTagEnd(html, name, tag.end + 1);
    if (end < 0) continue;
    const outer = html.slice(tag.start, end);
    blocks.set(id, { id, html: outer, text: textOf(outer) });
  }
  return blocks;
}
```

- [ ] **Step 4: 通ることを確認する**

Run: `pnpm vitest run packages/server/src/lib/diagram-doc-blocks.test.ts`
Expected: PASS (5件)

- [ ] **Step 5: commit**

```bash
git add packages/server/src/lib/diagram-doc-blocks.ts packages/server/src/lib/diagram-doc-blocks.test.ts
git commit -m "feat(server): doc 本文から data-ark-id のブロックを取り出す"
```

---

### Task 3: 還流する行を組む (無害化込み)

**Files:**
- Create: `packages/server/src/lib/diagram-doc-notice.ts`
- Test: `packages/server/src/lib/diagram-doc-notice.test.ts`

**Interfaces:**
- Consumes: Task 2 の `DocBlock`
- Produces: `describeDocBodyChanges(before: Map<string, DocBlock>, after: Map<string, DocBlock>): string[]`。返る各行は無害化済みで1行に収まる

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { describe, expect, it } from "vitest";
import type { DocBlock } from "./diagram-doc-blocks.js";
import { describeDocBodyChanges } from "./diagram-doc-notice.js";

function block(id: string, text: string): DocBlock {
  return { id, html: `<p data-ark-id="${id}">${text}</p>`, text };
}
function map(...blocks: DocBlock[]): Map<string, DocBlock> {
  return new Map(blocks.map(b => [b.id, b]));
}

describe("describeDocBodyChanges", () => {
  it("変わったブロックだけを本文つきで返す", () => {
    const before = map(block("p1", "むかし"), block("p2", "そのまま"));
    const after = map(block("p1", "いま"), block("p2", "そのまま"));
    expect(describeDocBodyChanges(before, after)).toEqual(["[p1] いま"]);
  });

  it("追加と削除を述べる", () => {
    const before = map(block("p1", "あ"));
    const after = map(block("p1", "あ"), block("p2", "ふえた"));
    expect(describeDocBodyChanges(before, after)).toEqual([
      "[p2] ブロックを追加: ふえた",
    ]);
    expect(describeDocBodyChanges(after, before)).toEqual(["[p2] ブロックを削除"]);
  });

  it("制御文字と改行を落として1行にする", () => {
    const before = map(block("p1", "むかし"));
    const after = new Map<string, DocBlock>([
      [
        "p1",
        {
          id: "p1",
          html: `<p data-ark-id="p1">あ<br>い</p>`,
          text: "あ\nい",
        },
      ],
    ]);
    expect(describeDocBodyChanges(before, after)).toEqual(["[p1] あ い"]);
  });

  it("1ブロック300文字で切る", () => {
    const before = map(block("p1", "みじかい"));
    const after = map(block("p1", "あ".repeat(400)));
    const lines = describeDocBodyChanges(before, after);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`[p1] ${"あ".repeat(299)}…`);
  });

  it("11件以上は10件で打ち切り、残りを id の列挙にする", () => {
    const before = new Map<string, DocBlock>();
    const after = new Map<string, DocBlock>();
    for (let i = 1; i <= 12; i += 1) {
      before.set(`p${i}`, block(`p${i}`, "まえ"));
      after.set(`p${i}`, block(`p${i}`, `あと${i}`));
    }
    const lines = describeDocBodyChanges(before, after);
    expect(lines).toHaveLength(11);
    expect(lines[9]).toBe("[p10] あと10");
    expect(lines[10]).toBe("他に 2 件変更: p11, p12（board_read で引ける）");
  });

  it("変更が無ければ空を返す", () => {
    const same = map(block("p1", "おなじ"));
    expect(describeDocBodyChanges(same, new Map(same))).toEqual([]);
  });
});
```

- [ ] **Step 2: 落ちることを確認する**

Run: `pnpm vitest run packages/server/src/lib/diagram-doc-notice.test.ts`
Expected: FAIL (`Cannot find module './diagram-doc-notice.js'`)

- [ ] **Step 3: 実装する**

```ts
/**
 * doc 本文の変更を会話へ送る行にする。
 *
 * 送るのは差分表現ではなく「書き換えた後のブロック本文」。実測でブロック本文は
 * 中央値102文字・平均194文字であり、ファイル全体 (26,504文字) の260分の1に収まる。
 * 差分表現は受け手が元の文を持っていないと復元できないため採らない。
 *
 * ブロック本文は外部入力 (人間のインライン編集、PR で持ち込まれた .diagram.html)
 * なので、tmux へリテラル送出する前に落とす。エスケープではなく除去にする理由は
 * diagram-diff.ts の sanitizeLabel と同じ。
 */

import type { DocBlock } from "./diagram-doc-blocks.js";

const BODY_MAX_LENGTH = 300;
const BODY_ELLIPSIS = "…";
const MAX_DETAILED_BLOCKS = 10;

function isControlCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 31 ||
    (codePoint >= 127 && codePoint <= 159) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029
  );
}

/** 制御文字と改行を落とし、空白を1つに畳み、300文字で切る */
function sanitizeBody(text: string): string {
  const stripped = Array.from(text)
    .filter(ch => !isControlCodePoint(ch.codePointAt(0) ?? 0))
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  const characters = Array.from(stripped);
  if (characters.length <= BODY_MAX_LENGTH) return stripped;
  return characters.slice(0, BODY_MAX_LENGTH - 1).join("") + BODY_ELLIPSIS;
}

export function describeDocBodyChanges(
  before: Map<string, DocBlock>,
  after: Map<string, DocBlock>
): string[] {
  const changed: string[] = [];

  for (const [id, block] of after) {
    const previous = before.get(id);
    if (previous === undefined) {
      changed.push(`[${id}] ブロックを追加: ${sanitizeBody(block.text)}`);
      continue;
    }
    if (previous.text !== block.text) {
      changed.push(`[${id}] ${sanitizeBody(block.text)}`);
    }
  }
  const removed: string[] = [];
  for (const id of before.keys()) {
    if (!after.has(id)) removed.push(`[${id}] ブロックを削除`);
  }
  const lines = [...changed, ...removed];

  if (lines.length <= MAX_DETAILED_BLOCKS) return lines;

  const head = lines.slice(0, MAX_DETAILED_BLOCKS);
  const restIds = lines
    .slice(MAX_DETAILED_BLOCKS)
    .map(line => line.slice(1, line.indexOf("]")));
  head.push(
    `他に ${restIds.length} 件変更: ${restIds.join(", ")}（board_read で引ける）`
  );
  return head;
}
```

- [ ] **Step 4: 通ることを確認する**

Run: `pnpm vitest run packages/server/src/lib/diagram-doc-notice.test.ts`
Expected: PASS (6件)

- [ ] **Step 5: commit**

```bash
git add packages/server/src/lib/diagram-doc-notice.ts packages/server/src/lib/diagram-doc-notice.test.ts
git commit -m "feat(server): doc 本文の変更を会話へ送る行にする"
```

---

### Task 4: label 抜粋を本文から作り直す

**Files:**
- Create: `packages/server/src/lib/diagram-doc-label.ts`
- Modify: `packages/server/src/lib/diagram-save.ts`
- Test: `packages/server/src/lib/diagram-doc-label.test.ts`

**Interfaces:**
- Consumes: Task 2 の `extractDocBlocks`
- Produces: `refreshDocLabels(model: DiagramModel, html: string): DiagramModel`。`model.type !== "doc"` なら同じ参照をそのまま返す

**なぜ要るか:** doc の model `label` は検索と一覧用の60〜80文字の抜粋である。人間が本文を直すと抜粋がずれ、`board_comments` が返す `anchorText` が嘘になる。

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { describe, expect, it } from "vitest";
import { refreshDocLabels } from "./diagram-doc-label.js";
import type { DiagramModel } from "./diagram-model.js";

const docModel = (label: string): DiagramModel =>
  ({
    version: 1,
    type: "doc",
    title: "t",
    nodes: [{ id: "p1", label, kind: "paragraph" }],
    edges: [],
    groups: [],
  }) as DiagramModel;

describe("refreshDocLabels", () => {
  it("本文から抜粋を作り直す", () => {
    const html = `<p data-ark-id="p1">あたらしい本文</p>`;
    expect(refreshDocLabels(docModel("ふるい抜粋"), html).nodes[0]?.label).toBe(
      "あたらしい本文"
    );
  });

  it("80文字で切る", () => {
    const html = `<p data-ark-id="p1">${"あ".repeat(120)}</p>`;
    expect(refreshDocLabels(docModel("x"), html).nodes[0]?.label).toBe(
      `${"あ".repeat(79)}…`
    );
  });

  it("本文が空のブロックは label を変えない", () => {
    const html = `<p data-ark-id="p1"></p>`;
    expect(refreshDocLabels(docModel("のこす"), html).nodes[0]?.label).toBe(
      "のこす"
    );
  });

  it("doc でないモデルは同じ参照を返す", () => {
    const model = { ...docModel("x"), type: "flow" } as DiagramModel;
    expect(refreshDocLabels(model, `<p data-ark-id="p1">かわらない</p>`)).toBe(
      model
    );
  });
});
```

- [ ] **Step 2: 落ちることを確認する**

Run: `pnpm vitest run packages/server/src/lib/diagram-doc-label.test.ts`
Expected: FAIL (`Cannot find module './diagram-doc-label.js'`)

- [ ] **Step 3: 実装する**

```ts
/**
 * doc の model `label` を本文から作り直す。
 *
 * doc は本文 HTML が正準 source で、model の label は検索と一覧表示のための
 * 抜粋にすぎない。人間が本文を直すと抜粋がずれ、board_comments が返す
 * anchorText が嘘になるので、保存経路で1回だけ作り直す。
 */

import { extractDocBlocks } from "./diagram-doc-blocks.js";
import type { DiagramModel } from "./diagram-model.js";

const LABEL_MAX_LENGTH = 80;
const LABEL_ELLIPSIS = "…";

function excerpt(text: string): string {
  const characters = Array.from(text);
  if (characters.length <= LABEL_MAX_LENGTH) return text;
  return characters.slice(0, LABEL_MAX_LENGTH - 1).join("") + LABEL_ELLIPSIS;
}

export function refreshDocLabels(
  model: DiagramModel,
  html: string
): DiagramModel {
  if (model.type !== "doc") return model;
  const blocks = extractDocBlocks(html);
  return {
    ...model,
    nodes: model.nodes.map(node => {
      const text = blocks.get(node.id)?.text ?? "";
      if (text === "") return node;
      return { ...node, label: excerpt(text) };
    }),
  };
}
```

- [ ] **Step 4: 通ることを確認する**

Run: `pnpm vitest run packages/server/src/lib/diagram-doc-label.test.ts`
Expected: PASS (4件)

- [ ] **Step 5: 保存経路へ挿す**

`packages/server/src/lib/diagram-save.ts` で、モデルを検証した直後・`replaceModelBlock` の前へ足す。

```ts
  const parsed = parseDiagramModel(modelJson);
  if (!parsed.ok) return parsed;

  // doc は本文 HTML が正準 source なので、label 抜粋を本文から作り直す。
  // 人間のインライン編集で本文と抜粋がずれると board_comments の anchorText が嘘になる。
  const model = refreshDocLabels(parsed.model, html);

  if (Buffer.byteLength(html, "utf-8") > DIAGRAM_SAVE_MAX_HTML_BYTES) {
    return { ok: false, error: "図のサイズが大きすぎます（上限 2MB）" };
  }

  const replaced = replaceModelBlock(html, model);
```

以降の `parsed.model` の参照 (`savedModel: parsed.model`) を `model` へ置き換える。
import を足す: `import { refreshDocLabels } from "./diagram-doc-label.js";`

- [ ] **Step 6: 既存の保存テストが通ることを確認する**

Run: `pnpm vitest run packages/server/src/lib/diagram-save.test.ts`
Expected: PASS

- [ ] **Step 7: commit**

```bash
git add packages/server/src/lib/diagram-doc-label.ts packages/server/src/lib/diagram-doc-label.test.ts packages/server/src/lib/diagram-save.ts
git commit -m "feat(server): doc の label 抜粋を保存時に本文から作り直す"
```

---

### Task 5: doc 編集層を作って注入する

**Files:**
- Create: `packages/server/src/lib/diagram-doc-editor.ts`
- Modify: `packages/server/src/lib/diagram-reader.ts:130-138`
- Test: `packages/server/src/lib/diagram-doc-editor.test.ts`

**Interfaces:**
- Consumes: `createCachedMinifier` (`injected-minify.ts:33`)、DiagramPane が送る `{ type: "ark:diagram-init" }` と `event.ports[0]` (`DiagramPane.tsx:826`)
- Produces: `injectDiagramDocEditor(html: string): string` と `DIAGRAM_DOC_EDITOR_MARKER` と `DOC_EDITOR_LAYER`

**設計のポイント:**
- モード切替は置かない。本文は常に編集できる。コメント層には既に選択時の浮くボタンがある (`diagram-comment-layer.ts:828` の `updateSelectionAdd`) ので、選択がそのままコメントになるわけではなく `contenteditable` と衝突しない
- port は `ark:diagram-init` を `window` で受けて `event.ports[0]` を取る。コメント層と同じ MessageEvent を見るので、同じ port を両方が持てる
- レイヤの DOM にはすべて `data-ark-harness-ui="1"` を付ける。送信 HTML から除去するため

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { describe, expect, it } from "vitest";
import {
  DIAGRAM_DOC_EDITOR_MARKER,
  injectDiagramDocEditor,
} from "./diagram-doc-editor.js";

const page = `<!doctype html><html><head></head><body><p data-ark-id="p1">本文</p></body></html>`;

describe("injectDiagramDocEditor", () => {
  it("</body> の前に編集層を差し込む", () => {
    const out = injectDiagramDocEditor(page);
    expect(out).toContain(DIAGRAM_DOC_EDITOR_MARKER);
    expect(out.indexOf(DIAGRAM_DOC_EDITOR_MARKER)).toBeLessThan(
      out.indexOf("</body>")
    );
  });

  it("二重に注入しない", () => {
    const once = injectDiagramDocEditor(page);
    expect(injectDiagramDocEditor(once)).toBe(once);
  });

  it("注入する script に data-ark-harness-ui を付ける", () => {
    expect(injectDiagramDocEditor(page)).toMatch(
      new RegExp(
        `<script[^>]*id="${DIAGRAM_DOC_EDITOR_MARKER}"[^>]*data-ark-harness-ui="1"`
      )
    );
  });

  it("外部リソースを参照しない", () => {
    const out = injectDiagramDocEditor(page);
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).not.toMatch(/Content-Security-Policy/i);
  });

  it("注入後のサイズが 48KiB 未満に収まる", () => {
    expect(
      Buffer.byteLength(injectDiagramDocEditor(page), "utf8")
    ).toBeLessThan(48 * 1024);
  });
});
```

- [ ] **Step 2: 落ちることを確認する**

Run: `pnpm vitest run packages/server/src/lib/diagram-doc-editor.test.ts`
Expected: FAIL (`Cannot find module './diagram-doc-editor.js'`)

- [ ] **Step 3: 編集層を実装する**

骨格は `diagram-comment-layer.ts` に合わせる (script 文字列の定数 + キャッシュ付き minify + 注入関数)。

```ts
/**
 * doc 型ボードの本文を人間がその場で編集できるようにする注入レイヤ。
 *
 * graph の diagram-harness.ts とは別の注入文字列にする。harness の 128KiB guard
 * (diagram-harness.test.ts:187) は injectHarness の出力だけを測っており、
 * doc 編集層をそこへ混ぜると graph の残り枠を食うため。
 *
 * モード切替は置かない。コメント層は選択時に浮くボタンを出す形 (updateSelectionAdd)
 * なので、選択がそのままコメントになるわけではなく contenteditable と衝突しない。
 */

import { createCachedMinifier } from "./injected-minify.js";

export const DIAGRAM_DOC_EDITOR_MARKER = "ark-diagram-doc-editor";

export const DOC_EDITOR_LAYER = `<script id="${DIAGRAM_DOC_EDITOR_MARKER}" data-ark-harness-ui="1">
(function(){
  var port=null;
  var saveTimer=null;
  var bar=null;

  function modelScript(){return document.getElementById("ark-diagram-model");}

  function readModel(){
    var el=modelScript();
    if(!el)return null;
    try{return JSON.parse(el.textContent||"");}catch(e){return null;}
  }

  function writeModel(model){
    var el=modelScript();
    if(el)el.textContent=JSON.stringify(model);
  }

  function blocks(){
    return Array.prototype.slice.call(document.querySelectorAll("[data-ark-id]"))
      .filter(function(el){return !el.closest("[data-ark-harness-ui]");});
  }

  /** 送信用 HTML: 編集層の DOM と contenteditable を落とす */
  function submissionHtml(){
    var clone=document.documentElement.cloneNode(true);
    clone.querySelectorAll("[data-ark-harness-ui]").forEach(function(el){
      if(el.parentNode)el.parentNode.removeChild(el);
    });
    clone.querySelectorAll("[contenteditable]").forEach(function(el){
      el.removeAttribute("contenteditable");
    });
    clone.querySelectorAll("[data-ark-doc-wired]").forEach(function(el){
      el.removeAttribute("data-ark-doc-wired");
    });
    clone.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]').forEach(function(el){
      if(el.parentNode)el.parentNode.removeChild(el);
    });
    return "<!doctype html>"+String.fromCharCode(10)+clone.outerHTML;
  }

  function markDirty(){
    syncModelNodes();
    if(bar)bar.setAttribute("data-visible","true");
    clearTimeout(saveTimer);
    saveTimer=setTimeout(save,800);
  }

  function save(){
    if(!port)return;
    var model=readModel();
    if(!model)return;
    port.postMessage({type:"ark:diagram-autosave",model:model,html:submissionHtml()});
  }

  function submit(){
    if(!port)return;
    var model=readModel();
    if(!model)return;
    clearTimeout(saveTimer);
    port.postMessage({type:"ark:diagram-submit",model:model,html:submissionHtml()});
    if(bar)bar.setAttribute("data-visible","false");
  }

  /** 人間が触ったブロックへ human 印を付ける */
  function stampAuthor(el){
    if(!el||!el.getAttribute("data-ark-id"))return;
    el.setAttribute("data-ark-author","human");
  }

  function wire(){
    blocks().forEach(function(el){
      if(el.getAttribute("data-ark-doc-wired"))return;
      el.setAttribute("data-ark-doc-wired","1");
      el.contentEditable="true";
      el.addEventListener("input",function(){stampAuthor(el);markDirty();});
    });
  }

  function syncModelNodes(){}

  function buildBar(){
    var style=document.createElement("style");
    style.setAttribute("data-ark-harness-ui","1");
    style.textContent='#ark-doc-bar{display:none}#ark-doc-bar[data-visible="true"]{display:block}[data-ark-id][contenteditable="true"]:focus{outline:2px solid #38bdf8;outline-offset:2px}';
    document.head.appendChild(style);

    bar=document.createElement("div");
    bar.id="ark-doc-bar";
    bar.setAttribute("data-ark-harness-ui","1");
    bar.setAttribute("data-visible","false");
    bar.style.cssText="position:fixed;right:12px;bottom:12px;z-index:9";
    var send=document.createElement("button");
    send.textContent="変更を送る";
    send.style.cssText="font:inherit;padding:6px 12px;border-radius:6px;border:1px solid #475569;background:#1e293b;color:#e2e8f0;cursor:pointer";
    send.addEventListener("click",submit);
    bar.appendChild(send);
    document.body.appendChild(bar);
  }

  window.addEventListener("message",function(event){
    if(port||!event.data||event.data.type!=="ark:diagram-init")return;
    if(!event.ports||!event.ports[0])return;
    port=event.ports[0];
    port.start();
  });

  function start(){buildBar();wire();document.addEventListener("ark:doc-sync",syncModelNodes);}
  if(document.readyState==="loading"){
    document.addEventListener("DOMContentLoaded",start);
  }else{
    start();
  }
})();
</script>`;

const scriptContentStart = DOC_EDITOR_LAYER.indexOf(">") + 1;
const scriptContentEnd = DOC_EDITOR_LAYER.lastIndexOf("</script>");
const minify = createCachedMinifier(
  DOC_EDITOR_LAYER.slice(scriptContentStart, scriptContentEnd)
);

function minifiedLayer(): string {
  return (
    DOC_EDITOR_LAYER.slice(0, scriptContentStart) +
    minify() +
    DOC_EDITOR_LAYER.slice(scriptContentEnd)
  );
}

export function injectDiagramDocEditor(html: string): string {
  if (html.includes(DIAGRAM_DOC_EDITOR_MARKER)) return html;
  const layer = minifiedLayer();
  const closing = html.toLowerCase().lastIndexOf("</body>");
  if (closing === -1) return html + layer;
  return html.slice(0, closing) + layer + html.slice(closing);
}
```

`createCachedMinifier` の実際の signature を `packages/server/src/lib/injected-minify.ts:33` で確認し、引数と戻り値の形が違えば合わせる (`diagram-comment-layer.ts:1089` の `getMinifiedCommentLayer` が使い方の見本)。

- [ ] **Step 4: 通ることを確認する**

Run: `pnpm vitest run packages/server/src/lib/diagram-doc-editor.test.ts`
Expected: PASS (5件)

- [ ] **Step 5: doc に注入する**

`packages/server/src/lib/diagram-reader.ts` の `readDiagram` を変える。

```ts
    html:
      model.model.type === "doc"
        ? injectDiagramCommentLayer(injectDiagramDocEditor(projected), "doc")
        : injectDiagramCommentLayer(injectHarness(projected), "graph"),
```

import を足す: `import { injectDiagramDocEditor } from "./diagram-doc-editor.js";`

- [ ] **Step 6: graph の guard が動いていないことを確認する**

Run: `pnpm vitest run packages/server/src/lib/diagram-harness.test.ts packages/server/src/lib/diagram-reader.test.ts`
Expected: PASS。`diagram-harness.test.ts:187` の 128KiB guard の実測値が変わらないこと

- [ ] **Step 7: commit**

```bash
git add packages/server/src/lib/diagram-doc-editor.ts packages/server/src/lib/diagram-doc-editor.test.ts packages/server/src/lib/diagram-reader.ts
git commit -m "feat(server): doc ボードへ本文編集レイヤを注入する"
```

---

### Task 6: ブロックの追加・削除と model node の同期

**Files:**
- Modify: `packages/server/src/lib/diagram-doc-editor.ts` (Task 5 で空にしておいた `syncModelNodes`)
- Test: `packages/server/src/lib/diagram-doc-editor.test.ts`

**Interfaces:**
- Consumes: Task 5 の `DOC_EDITOR_LAYER`
- Produces: 注入 script 内の `syncModelNodes()` と `mintBlockId()`。DOM の `data-ark-id` 集合と model の node 集合を一致させる

**なぜ要るか:** `validateDiagramDocAnchors` は `data-ark-id` と model node の1対1を強制する。人間が段落を足したり消したりして model を動かさないと、保存が422で落ちる。

- [ ] **Step 1: jsdom を入れる**

Run: `pnpm add -Dw jsdom @types/jsdom`
Expected: devDependencies に追加される

- [ ] **Step 2: 失敗するテストを書く**

```ts
import { JSDOM } from "jsdom";
import { DOC_EDITOR_LAYER } from "./diagram-doc-editor.js";

function runLayer(bodyHtml: string): JSDOM {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${bodyHtml}</body></html>`, {
    runScripts: "dangerously",
  });
  const script = dom.window.document.createElement("script");
  script.textContent = DOC_EDITOR_LAYER.slice(
    DOC_EDITOR_LAYER.indexOf(">") + 1,
    DOC_EDITOR_LAYER.lastIndexOf("</script>")
  );
  dom.window.document.body.appendChild(script);
  return dom;
}

const modelBlock = (nodes: string) =>
  `<script type="application/json" id="ark-diagram-model">{"version":1,"type":"doc","title":"t","nodes":[${nodes}],"edges":[],"groups":[]}</script>`;

it("増えた段落に id と human 印が付き model node が増える", () => {
  const dom = runLayer(
    `${modelBlock(`{"id":"p1","label":"あ"}`)}<p data-ark-id="p1" data-ark-author="claude">あ</p>`
  );
  const added = dom.window.document.createElement("p");
  added.textContent = "ふえた";
  dom.window.document.body.appendChild(added);
  dom.window.document.dispatchEvent(new dom.window.Event("ark:doc-sync"));

  const model = JSON.parse(
    dom.window.document.getElementById("ark-diagram-model")!.textContent!
  );
  expect(model.nodes).toHaveLength(2);
  expect(added.getAttribute("data-ark-id")).toBeTruthy();
  expect(added.getAttribute("data-ark-author")).toBe("human");
});

it("消えたブロックの model node と group 参照が落ちる", () => {
  const dom = runLayer(
    `<script type="application/json" id="ark-diagram-model">{"version":1,"type":"doc","title":"t","nodes":[{"id":"p1","label":"あ"},{"id":"p2","label":"い"}],"edges":[],"groups":[{"id":"g1","label":"g","nodes":["p1","p2"]}]}</script>` +
      `<p data-ark-id="p1">あ</p><p data-ark-id="p2">い</p>`
  );
  dom.window.document.querySelector('[data-ark-id="p2"]')!.remove();
  dom.window.document.dispatchEvent(new dom.window.Event("ark:doc-sync"));

  const model = JSON.parse(
    dom.window.document.getElementById("ark-diagram-model")!.textContent!
  );
  expect(model.nodes.map((n: { id: string }) => n.id)).toEqual(["p1"]);
  expect(model.groups[0].nodes).toEqual(["p1"]);
});
```

- [ ] **Step 3: 落ちることを確認する**

Run: `pnpm vitest run packages/server/src/lib/diagram-doc-editor.test.ts`
Expected: FAIL (`model.nodes` が1件のまま)

- [ ] **Step 4: 同期を実装する**

Task 5 で空にしておいた `function syncModelNodes(){}` を置き換える。

```js
  var idSequence=0;
  function mintBlockId(){
    idSequence+=1;
    var candidate="h"+Date.now().toString(36)+"-"+idSequence;
    while(document.querySelector('[data-ark-id="'+candidate+'"]')){
      idSequence+=1;
      candidate="h"+Date.now().toString(36)+"-"+idSequence;
    }
    return candidate;
  }

  /** DOM の data-ark-id 集合と model の node 集合を一致させる */
  function syncModelNodes(){
    var model=readModel();
    if(!model||!Array.isArray(model.nodes))return;

    // 編集で増えた無印のブロックへ id と human 印を付ける
    Array.prototype.slice.call(
      document.querySelectorAll("p,li,h1,h2,h3,h4,blockquote,pre,td,th")
    ).filter(function(el){
      return !el.closest("[data-ark-harness-ui]")&&!el.getAttribute("data-ark-id");
    }).forEach(function(el){
      el.setAttribute("data-ark-id",mintBlockId());
      el.setAttribute("data-ark-author","human");
    });

    var present={};
    blocks().forEach(function(el){present[el.getAttribute("data-ark-id")]=el;});

    var kept=model.nodes.filter(function(node){return present[node.id];});
    var known={};
    kept.forEach(function(node){known[node.id]=true;});

    Object.keys(present).forEach(function(id){
      if(known[id])return;
      kept.push({
        id:id,
        label:(present[id].textContent||"").trim().slice(0,80),
        kind:"paragraph"
      });
    });

    // 消えた node を参照する group member も落とす (参照整合性)
    if(Array.isArray(model.groups)){
      model.groups.forEach(function(group){
        if(!group||!Array.isArray(group.nodes))return;
        group.nodes=group.nodes.filter(function(id){return present[id];});
      });
    }
    model.nodes=kept;
    writeModel(model);
    wire();
  }
```

- [ ] **Step 5: 通ることを確認する**

Run: `pnpm vitest run packages/server/src/lib/diagram-doc-editor.test.ts`
Expected: PASS (7件)

- [ ] **Step 6: 注入後サイズを確認する**

Run: `pnpm vitest run packages/server/src/lib/diagram-doc-editor.test.ts -t "48KiB"`
Expected: PASS

- [ ] **Step 7: commit**

```bash
git add packages/server/src/lib/diagram-doc-editor.ts packages/server/src/lib/diagram-doc-editor.test.ts package.json pnpm-lock.yaml
git commit -m "feat(server): doc 編集でのブロック増減を model node へ同期する"
```

---

### Task 7: submit の還流を doc と graph で分ける

**Files:**
- Create: `packages/server/src/lib/diagram-submit-notice.ts`
- Modify: `packages/server/src/lib/diagram-save.ts`
- Modify: `packages/server/src/index.ts:306-312, 1850-1855, 1995-2005, 2050-2080`
- Test: `packages/server/src/lib/diagram-submit-notice.test.ts`

**Interfaces:**
- Consumes: Task 2 の `extractDocBlocks`、Task 3 の `describeDocBodyChanges`、既存の `describeModelDiff`
- Produces:
  ```ts
  export interface SubmitNoticeInput {
    relPath: string;
    baselineModel: DiagramModel;
    savedModel: DiagramModel;
    baselineBodies: Map<string, DocBlock> | undefined;
    savedHtmlRaw: string;
  }
  export interface SubmitNotice {
    lines: string[];
    message: string | null;
    savedBodies: Map<string, DocBlock>;
  }
  export function buildSubmitNotice(input: SubmitNoticeInput): SubmitNotice;
  ```
  あわせて `SaveDiagramEditResult` の成功側へ `previousHtml: string` と `savedHtml: string` が増える

**なぜ分けるか:** Task 4 で `label` 抜粋を本文から作り直すため、本文を1文字直すだけで model の `label` が変わる。そのまま `describeModelDiff` を通すと `[s6-p1] を 「新しい抜粋…」 に改名` の行が本文の還流と二重に出る。

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { describe, expect, it } from "vitest";
import { extractDocBlocks } from "./diagram-doc-blocks.js";
import type { DiagramModel } from "./diagram-model.js";
import { buildSubmitNotice } from "./diagram-submit-notice.js";

const docModel = (label: string): DiagramModel =>
  ({ version: 1, type: "doc", title: "t",
     nodes: [{ id: "p1", label }], edges: [], groups: [] }) as DiagramModel;

const flowModel = (label: string): DiagramModel =>
  ({ version: 1, type: "flow", title: "t",
     nodes: [{ id: "n1", label }], edges: [], groups: [] }) as DiagramModel;

describe("buildSubmitNotice", () => {
  it("doc はブロック本文だけを送り、モデル差分の改名行を混ぜない", () => {
    const out = buildSubmitNotice({
      relPath: "a.diagram.html",
      baselineModel: docModel("むかし"),
      savedModel: docModel("いま"),
      baselineBodies: extractDocBlocks(`<p data-ark-id="p1">むかし</p>`),
      savedHtmlRaw: `<p data-ark-id="p1">いま</p>`,
    });
    expect(out.lines).toEqual(["[p1] いま"]);
    expect(out.message).toContain("図の本文を編集しました（a.diagram.html）:");
    expect(out.message).toContain("（いずれも human として記録済み）");
    expect(out.message).not.toContain("改名");
  });

  it("doc の baseline が無いときは何も送らず baseline だけ返す", () => {
    const out = buildSubmitNotice({
      relPath: "a.diagram.html",
      baselineModel: docModel("あ"),
      savedModel: docModel("あ"),
      baselineBodies: undefined,
      savedHtmlRaw: `<p data-ark-id="p1">あ</p>`,
    });
    expect(out.lines).toEqual([]);
    expect(out.message).toBeNull();
    expect(out.savedBodies.get("p1")?.text).toBe("あ");
  });

  it("graph は従来どおりモデル差分を送る", () => {
    const out = buildSubmitNotice({
      relPath: "b.diagram.html",
      baselineModel: flowModel("むかし"),
      savedModel: flowModel("いま"),
      baselineBodies: undefined,
      savedHtmlRaw: "",
    });
    expect(out.message).toContain("図を編集しました（b.diagram.html）:");
    expect(out.lines.join("")).toContain("改名");
  });

  it("変更が無ければ message は null", () => {
    const out = buildSubmitNotice({
      relPath: "b.diagram.html",
      baselineModel: flowModel("おなじ"),
      savedModel: flowModel("おなじ"),
      baselineBodies: undefined,
      savedHtmlRaw: "",
    });
    expect(out.lines).toEqual([]);
    expect(out.message).toBeNull();
  });
});
```

- [ ] **Step 2: 落ちることを確認する**

Run: `pnpm vitest run packages/server/src/lib/diagram-submit-notice.test.ts`
Expected: FAIL (`Cannot find module './diagram-submit-notice.js'`)

- [ ] **Step 3: 実装する**

```ts
/**
 * 「変更を送る」で会話へ流す文面を組む。
 *
 * doc は本文 HTML が正準 source であり、保存時に label 抜粋を本文から作り直すため
 * (diagram-doc-label.ts)、describeModelDiff を通すと本文の還流と「改名」行が
 * 二重に出る。そのため doc はブロック本文の経路だけを使う。
 */

import { describeModelDiff } from "./diagram-diff.js";
import { type DocBlock, extractDocBlocks } from "./diagram-doc-blocks.js";
import { describeDocBodyChanges } from "./diagram-doc-notice.js";
import type { DiagramModel } from "./diagram-model.js";

export interface SubmitNoticeInput {
  relPath: string;
  baselineModel: DiagramModel;
  savedModel: DiagramModel;
  baselineBodies: Map<string, DocBlock> | undefined;
  savedHtmlRaw: string;
}

export interface SubmitNotice {
  lines: string[];
  message: string | null;
  savedBodies: Map<string, DocBlock>;
}

export function buildSubmitNotice(input: SubmitNoticeInput): SubmitNotice {
  if (input.savedModel.type === "doc") {
    const savedBodies = extractDocBlocks(input.savedHtmlRaw);
    const lines =
      input.baselineBodies === undefined
        ? []
        : describeDocBodyChanges(input.baselineBodies, savedBodies);
    const message =
      lines.length === 0
        ? null
        : `図の本文を編集しました（${input.relPath}）:\n${lines
            .map(line => `- ${line}`)
            .join("\n")}\n（いずれも human として記録済み）`;
    return { lines, message, savedBodies };
  }

  const lines = describeModelDiff(input.baselineModel, input.savedModel);
  const message =
    lines.length === 0
      ? null
      : `図を編集しました（${input.relPath}）:\n${lines
          .map(line => `- ${line}`)
          .join("\n")}`;
  return { lines, message, savedBodies: new Map() };
}
```

- [ ] **Step 4: 通ることを確認する**

Run: `pnpm vitest run packages/server/src/lib/diagram-submit-notice.test.ts`
Expected: PASS (4件)

- [ ] **Step 5: `saveDiagramEdit` が本文を返すようにする**

`packages/server/src/lib/diagram-save.ts` の `SaveDiagramEditResult` の成功側へ2つ足す。

```ts
export type SaveDiagramEditResult =
  | {
      ok: true;
      absPath: string;
      previousModel: DiagramModel;
      /** 保存前のファイル本文。doc baseline の初期値に使う */
      previousHtml: string;
      savedModel: DiagramModel;
      /** 実際に書いた本文。doc の還流で id → ブロックを取り出すのに使う */
      savedHtml: string;
    }
  | { ok: false; error: string };
```

戻り値も合わせる (`current.raw` は `readDiagramModel` が既に返している)。

```ts
  const body = Buffer.from(ensureDoctype(replaced.html), "utf-8");
  // ...書き込みは既存のまま...

  return {
    ok: true,
    absPath: pathResolved.absPath,
    previousModel: current.model,
    previousHtml: current.raw,
    savedModel: model,
    savedHtml: ensureDoctype(replaced.html),
  };
```

- [ ] **Step 6: index.ts へ配線する**

`packages/server/src/index.ts:306` 付近、`lastNotifiedModels` の隣。

```ts
  const lastNotifiedModels = new Map<string, DiagramModel>();
  const lastNotifiedDocBodies = new Map<string, Map<string, DocBlock>>();

  function rememberNotifiedDocBodies(
    key: string,
    bodies: Map<string, DocBlock>
  ): void {
    rememberFifoEntry(lastNotifiedDocBodies, key, bodies, LAST_NOTIFIED_MODELS_MAX);
  }
```

削除処理 (`:1853` 付近) へ1行。

```ts
      lastNotifiedDocBodies.delete(diagramModelKey(resolved, data.relPath));
```

autosave (`:2001` 付近) の baseline 初期化へ。

```ts
        if (!lastNotifiedModels.has(modelKey)) {
          rememberNotifiedModel(modelKey, saved.previousModel);
          if (saved.savedModel.type === "doc") {
            rememberNotifiedDocBodies(
              modelKey,
              extractDocBlocks(saved.previousHtml)
            );
          }
        }
```

submit (`:2052` 付近) の `describeModelDiff` の呼び出しを差し替える。

```ts
        const modelKey = diagramModelKey(resolved, d.relPath);
        const baseline = lastNotifiedModels.get(modelKey) ?? saved.previousModel;

        // doc は本文が正準 source なので、モデル差分ではなくブロック本文を送る
        const notice = buildSubmitNotice({
          relPath: d.relPath,
          baselineModel: baseline,
          savedModel: saved.savedModel,
          baselineBodies: lastNotifiedDocBodies.get(modelKey),
          savedHtmlRaw: saved.savedHtml,
        });
        const sent = notice.lines;
        if (notice.message !== null) {
          try {
            sessionOrchestrator.sendMessage(d.sessionId, notice.message);
          } catch (error) {
            console.error("[Diagram] sendMessage failed:", getErrorMessage(error));
            reply({
              ok: false,
              error: `図は保存しましたが、セッションへの通知に失敗しました: ${getErrorMessage(error)}`,
            });
            return;
          }
        }

        // 通知が成功した（または差分が無かった）時だけ baseline を進める
        rememberNotifiedModel(modelKey, saved.savedModel);
        if (saved.savedModel.type === "doc") {
          rememberNotifiedDocBodies(modelKey, notice.savedBodies);
        }
        reply({ ok: true, sent });
```

import を足す: `import { type DocBlock, extractDocBlocks } from "./lib/diagram-doc-blocks.js";` と `import { buildSubmitNotice } from "./lib/diagram-submit-notice.js";`。`describeModelDiff` の import が未使用になったら外す。

- [ ] **Step 7: 型検査とテストを通す**

Run: `pnpm check && pnpm vitest run packages/server/src/lib/`
Expected: PASS

- [ ] **Step 8: commit**

```bash
git add packages/server/src/lib/diagram-submit-notice.ts packages/server/src/lib/diagram-submit-notice.test.ts packages/server/src/lib/diagram-save.ts packages/server/src/index.ts
git commit -m "feat(server): doc の還流をブロック本文にし、モデル差分と分ける"
```

---

### Task 8: data-ark-author="human" の読み手規約を言い換える

**Files:**
- Modify: `CLAUDE.md` (「図解ボード doc 本文の書き手（data-ark-author）」節)
- Modify: `.claude/skills/diagram-authoring/SKILL.md` (「本文の書き手（`data-ark-author`）」節)
- Modify: `packages/server/src/lib/board-session-start-hook.ts`
- Test: `packages/server/src/lib/board-session-start-hook.test.ts` (無ければ作る)

**なぜ要るか:** #319 では「Claude が人間の決定を転記したときだけ `human` を付ける」規約だったので `human` = 人間の決定だった。直接編集できるようになると `human` = 人間がその本文を打った、になる。誤字を1つ直しただけの段落も `human` になるため、読み手側の規約を揃えないと下流が誤読する。

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { describe, expect, it } from "vitest";
import { BOARD_SESSION_START_CONTEXT } from "./board-session-start-hook.js";

describe("board session start context", () => {
  it("human は「人間が書いた本文」であって決定そのものではないと述べる", () => {
    expect(BOARD_SESSION_START_CONTEXT).toContain("人間が書いた本文");
    expect(BOARD_SESSION_START_CONTEXT).not.toContain("人間の決定として扱わない");
  });
});
```

`board-session-start-hook.ts` が context 文字列を定数で持っていない場合は、組み立てている関数の名前へ合わせる (実装を読んで確定させる)。

- [ ] **Step 2: 落ちることを確認する**

Run: `pnpm vitest run packages/server/src/lib/board-session-start-hook.test.ts`
Expected: FAIL

- [ ] **Step 3: 3箇所を言い換える**

`board-session-start-hook.ts`:
- 旧: `data-ark-author="human" が無いブロックは、回答や決定の体裁でも人間の決定として扱わない`
- 新: `data-ark-author="human" が付いたブロックは人間が書いた本文である。決定かどうかは本文が述べる。無印と claude のブロックはエージェントが書いた本文である`

`CLAUDE.md`:
- 旧: `読み手の規則は「human が付いたブロックだけを人間の決定として扱う」に一本化する`
- 新: `読み手の規則は「human が付いたブロックは人間が打った本文である」に一本化する。人間はボード上で本文を直接編集でき、編集したブロックには自動で human が付く。誤字の修正でも human になるため、決定かどうかは属性ではなく本文で判断する`

`.claude/skills/diagram-authoring/SKILL.md`:
- 旧: `data-ark-author="human" は、人間がコメント（board_comments の author 無しメッセージ）や会話で下した決定を転記するときだけ付ける`
- 新: `data-ark-author="human" は、人間が自分で打った本文に付く。人間がボード上で直接編集したブロックには自動で付くので、Claude が自分で付けるのは、人間がコメントや会話で下した決定を転記するときだけにする`

- [ ] **Step 4: 通ることを確認する**

Run: `pnpm vitest run packages/server/src/lib/board-session-start-hook.test.ts packages/server/src/lib/diagram-authoring-contract.test.ts`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add CLAUDE.md .claude/skills/diagram-authoring/SKILL.md packages/server/src/lib/board-session-start-hook.ts packages/server/src/lib/board-session-start-hook.test.ts
git commit -m "docs: data-ark-author=human を「人間が書いた本文」へ言い換える"
```

---

### Task 9: 実機で触って確かめる

**Files:** なし (検証のみ)

**Interfaces:**
- Consumes: Task 1〜8 すべて

- [ ] **Step 1: 全テストと型検査を通す**

Run: `pnpm check && pnpm test`
Expected: PASS

- [ ] **Step 2: 検証用ビルドを別 outDir で作る**

`pnpm build` は本番 dist を上書きするので使わない。検証用の outDir と `vite preview` で立てる。ダッシュボードは全セッションの ttyd を掴むので、検証用セッションを別に作る。

- [ ] **Step 3: doc ボードを開いて触る**

`.claude/diagrams/_examples/order-flow-design.diagram.html` (doc, 10 node) をコピーして検証用 worktree に置き、ボードで開く。

確かめること:
- 本文をクリックしてその場で打てる
- 打ったブロックに `data-ark-author="human"` が付く (DevTools で確認)
- 範囲選択でコメントの浮くボタンが出る (共存する)
- キャレットだけの選択では浮くボタンが出ない
- 段落を増やすと `data-ark-id` が振られ、保存が422にならない
- 「変更を送る」でセッションに `図の本文を編集しました（…）: - [id] 本文` が届く
- 送信文に「改名」行が混ざらない
- 2回目の送信で、1回目に送ったブロックが再送されない

- [ ] **Step 4: 大きい実物で確かめる**

`orista-app-ios/stripe-native-overview.diagram.html` (doc, 66 node, 26,504文字) のコピーを開き、1ブロックだけ直して送る。送信文が300文字前後に収まることを確認する。

- [ ] **Step 5: PR を作る**

```bash
git push -u origin feat/doc-board-direct-editing
gh pr create --title "feat(server): doc 型ボードの本文を直接編集できるようにする" --body-file docs/superpowers/plans/2026-09-18-doc-board-direct-editing-phase1.md
```

PR 本文は計画そのままではなく、「何を変えたか」「なぜ」「確認したこと」に書き直す。

---

## Self-Review

**Spec coverage:**

| spec の要求 | 対応する Task |
| --- | --- |
| A. doc 編集層 / モード切替なし / 常時 contenteditable | Task 5 |
| A. `data-ark-author="human"` の自動付与 | Task 5 Step 3 (`stampAuthor`) |
| A. ブロック増減と model node の同期 | Task 6 |
| A. 折り畳まれた選択で浮くボタンを出さない | Task 9 Step 3 で確認 (コメント層の既存挙動) |
| A. 保存は既存の autosave / submit に乗せる | Task 5 Step 3 (`save` / `submit`) |
| A. 送信 HTML から `[data-ark-harness-ui]` を除く | Task 5 Step 3 (`submissionHtml`) |
| A. `label` 抜粋の再生成 | Task 4 |
| 還流: アンカー + 書き換え後のブロック本文 | Task 3, Task 7 |
| 還流: 無害化 (タグ除去・1行化・300文字・10件) | Task 3 |
| 還流: サーバー側 doc baseline | Task 7 Step 6 |
| 還流: doc では `describeModelDiff` を使わない | Task 7 |
| 還流: 人間が押したときだけ | Task 7 (submit ハンドラのまま) |
| `human` の意味の言い換え3箇所 | Task 8 |
| graph の 128KiB guard を動かさない | Task 5 Step 6 |

Phase 2 以降 (`board_patch` / `board_read` / `anchorId` / 未知 type の描画 / モデル ops / `board_comments`) はこの計画の対象外。

**Placeholder scan:** 「適切に」「必要に応じて」「後で」の類は無い。実物に合わせる指示は2箇所だけで、どちらも既存コードを読めば確定する — Task 5 Step 3 の `createCachedMinifier` の signature (`injected-minify.ts:33`、見本は `diagram-comment-layer.ts:1089`) と、Task 8 Step 1 の context 文字列の export 名。

**Type consistency:** `DocBlock` は Task 2 で定義し Task 3 / 4 / 7 が同じ形で使う。`extractDocBlocks` / `describeDocBodyChanges` / `refreshDocLabels` / `buildSubmitNotice` の名前は全 Task で一致している。`SaveDiagramEditResult` へ足す `previousHtml` / `savedHtml` は Task 7 Step 5 で型と実装の両方に足し、Task 7 Step 6 の index.ts が両方を使う。Task 5 は `syncModelNodes` を空関数で置き、Task 6 が中身を入れる (Task 5 単独でも `markDirty` が壊れない)。
