# ボードからコードへ飛ぶリンクと変更レビュー文書の型 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 図解ボード内の `<a href="src/foo.ts#L10">` を押すと、iframe を遷移させずに右ペインのファイルビューアで該当行が開く。あわせて作図規約に「コードを指す語はリンクにする」と「変更レビュー文書の型」を足す。

**Architecture:** サーバが配信時に注入する新しいリンク層 (`diagram-link-layer.ts`) が `<a>` のクリックを横取りし、他の層と共有する MessagePort で親へ `ark:diagram-open-link` を送る。`DiagramPane` は純関数 `handleDiagramOpenLinkMessage` で href を解釈し、端末リンクと同じ既存の入口 (`ark:open-file` / `ark:open-url` の window message) へ流す。

**Tech Stack:** TypeScript / Express (注入層は文字列のスクリプト、`node:vm` でテスト) / React 19 / vitest

設計文書: `docs/superpowers/specs/2026-09-26-board-code-links-design.md`

## Global Constraints

- リンクの書式は `worktree 相対パス` + 任意の `#L<n>` / `#L<a>-L<b>`。`..` を含む・`/` 始まり・空のパスは親が拒否する
- `#` 始まりの href は文書内アンカーとして触らない。`http:` / `https:` は `ark:open-url`、その他のスキームは遷移を止めて無視
- リンク層は `</body>` 直前に 1 回だけ注入し、`data-ark-link-layer` の marker で二重注入しない。配信版は `createCachedMinifier` で圧縮する (コメント層と同じ)
- `DiagramPane` の新しいロジックは named export の純関数にし、`DiagramPane.test.ts` (node 環境、jsdom 無し) でテストする
- 規約本文に `docs/diagrams` や `.claude/diagrams` のディレクトリ名を書かない。`doc` を表の行にしない (契約テスト)
- 見本ボードは既存の `_examples/order-flow-design.diagram.html` と同じ規則 (`data-ark-id` 一意、`data-ark-author` は `human` / `claude`、model は抜粋のみ) を守る
- コミットメッセージは日本語、`Co-Authored-By` は付けない。各タスクの最後に `pnpm check` と関係するテストを通す

---

## ファイル構成

| 区分 | パス | 責務 |
|---|---|---|
| 作成 | `packages/server/src/lib/diagram-link-layer.ts` | 注入するリンク層と `injectDiagramLinkLayer` |
| 作成 | `packages/server/src/lib/diagram-link-layer.test.ts` | 注入とクリック横取りのテスト (vm) |
| 変更 | `packages/server/src/lib/diagram-reader.ts` | 配信パイプラインにリンク層を足す |
| 変更 | `packages/web/src/components/DiagramPane.tsx` | `parseDiagramLinkHref` / `handleDiagramOpenLinkMessage` と port の配線 |
| 変更 | `packages/web/src/components/DiagramPane.test.ts` | 純関数のテスト |
| 変更 | `.claude/skills/diagram-authoring/SKILL.md` | リンクの規約と「変更レビュー文書」の節 |
| 作成 | `.claude/diagrams/_examples/change-review.diagram.html` | 変更レビュー文書の見本 |
| 変更 | `packages/server/src/lib/diagram-authoring-contract.test.ts` | 新しい節と見本の契約 |
| 変更 | `CLAUDE.md` | セッションボードの説明にリンクを 1 行 |

---

### Task 1: リンク層 (`diagram-link-layer.ts`) と配信への注入

**Files:**
- Create: `packages/server/src/lib/diagram-link-layer.ts`
- Test: `packages/server/src/lib/diagram-link-layer.test.ts`
- Modify: `packages/server/src/lib/diagram-reader.ts` (`readDiagram` の `html:` 組み立て、145〜148 行付近)

**Interfaces:**
- Produces: `DIAGRAM_LINK_LAYER_MARKER = "ark-diagram-link-layer"`, `LINK_LAYER: string`, `injectDiagramLinkLayer(html: string): string`
- iframe → 親のメッセージ: `{ type: "ark:diagram-open-link", href: string }` (href は `<a>` の `href` **属性の生の値**)

- [ ] **Step 1: テストを書く**

```ts
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  DIAGRAM_LINK_LAYER_MARKER,
  injectDiagramLinkLayer,
  LINK_LAYER,
} from "./diagram-link-layer.js";

const minimalDoc =
  '<!doctype html><html><head></head><body><p data-ark-id="s1">本文</p></body></html>';

/** リンク層のスクリプト本体を最小の DOM スタブで走らせ、click ハンドラと init ハンドラを取り出す */
function loadLayer() {
  const body = LINK_LAYER.slice(LINK_LAYER.indexOf(">") + 1, LINK_LAYER.lastIndexOf("</script>"));
  const listeners: Record<string, (event: unknown) => void> = {};
  const sent: unknown[] = [];
  const port = {
    postMessage: (message: unknown) => sent.push(message),
    start: () => {},
    addEventListener: () => {},
  };
  runInNewContext(body, {
    document: {
      addEventListener: (type: string, fn: (event: unknown) => void) => {
        listeners[`document:${type}`] = fn;
      },
    },
    window: {
      addEventListener: (type: string, fn: (event: unknown) => void) => {
        listeners[`window:${type}`] = fn;
      },
    },
  });
  const init = () =>
    listeners["window:message"]?.({
      data: { type: "ark:diagram-init" },
      ports: [port],
    });
  const click = (href: string | null, options: { button?: number } = {}) => {
    let prevented = false;
    const anchor = href === null ? null : { getAttribute: (name: string) => (name === "href" ? href : null) };
    listeners["document:click"]?.({
      button: options.button ?? 0,
      target: { closest: (selector: string) => (selector === "a[href]" ? anchor : null) },
      preventDefault: () => {
        prevented = true;
      },
    });
    return prevented;
  };
  return { init, click, sent };
}

describe("injectDiagramLinkLayer", () => {
  it("</body> 直前へ marker を 1 回だけ注入する", () => {
    const injected = injectDiagramLinkLayer(minimalDoc);
    expect(injected).toContain(DIAGRAM_LINK_LAYER_MARKER);
    expect(injected.indexOf(DIAGRAM_LINK_LAYER_MARKER)).toBe(
      injected.lastIndexOf(DIAGRAM_LINK_LAYER_MARKER)
    );
    expect(injected.indexOf(DIAGRAM_LINK_LAYER_MARKER)).toBeLessThan(
      injected.lastIndexOf("</body>")
    );
    expect(injectDiagramLinkLayer(injected)).toBe(injected);
  });

  it("</body> が無ければ末尾に付ける", () => {
    const injected = injectDiagramLinkLayer("<p>x</p>");
    expect(injected.endsWith("</script>")).toBe(true);
  });
});

describe("リンク層のクリック処理", () => {
  it("相対パスは遷移を止めて親へ href をそのまま送る", () => {
    const layer = loadLayer();
    layer.init();
    expect(layer.click("src/foo.ts#L10-L24")).toBe(true);
    expect(layer.sent).toEqual([
      { type: "ark:diagram-open-link", href: "src/foo.ts#L10-L24" },
    ]);
  });

  it("http(s) も親へ送る (新しいタブで開くかは親が決める)", () => {
    const layer = loadLayer();
    layer.init();
    expect(layer.click("https://example.com/x")).toBe(true);
    expect(layer.sent).toEqual([
      { type: "ark:diagram-open-link", href: "https://example.com/x" },
    ]);
  });

  it("# 始まりは文書内アンカーなので触らない", () => {
    const layer = loadLayer();
    layer.init();
    expect(layer.click("#s6")).toBe(false);
    expect(layer.sent).toEqual([]);
  });

  it("javascript: などのスキームは遷移を止めて無視する", () => {
    const layer = loadLayer();
    layer.init();
    expect(layer.click("javascript:alert(1)")).toBe(true);
    expect(layer.click("data:text/html,x")).toBe(true);
    expect(layer.sent).toEqual([]);
  });

  it("port が届く前でも遷移だけは止める", () => {
    const layer = loadLayer();
    expect(layer.click("src/foo.ts")).toBe(true);
    expect(layer.sent).toEqual([]);
  });

  it("<a> 以外のクリックは何もしない", () => {
    const layer = loadLayer();
    layer.init();
    expect(layer.click(null)).toBe(false);
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm --filter @ark/server exec vitest run src/lib/diagram-link-layer.test.ts`
Expected: FAIL (モジュールが無い)

- [ ] **Step 3: 実装する**

```ts
import { createCachedMinifier } from "./injected-minify.js";

export const DIAGRAM_LINK_LAYER_MARKER = "ark-diagram-link-layer";

/**
 * ボード内の <a href> を横取りして親へ渡す層。
 *
 * sandbox="allow-scripts" の iframe で <a> をそのまま踏むと iframe ごと遷移し、
 * DiagramPane はそれを「別ページへの遷移」と見てコメント層との接続を切る。
 * ここで遷移を止め、href の生の値だけを親へ送る。解釈 (worktree 相対パスか、
 * 外部 URL か) は親 (DiagramPane) が行う。
 *
 * port は他の層と同じく window の ark:diagram-init で受け取り、共有する。
 */
export const LINK_LAYER = `<script id="${DIAGRAM_LINK_LAYER_MARKER}">
(function(){
  "use strict";
  var port=null;
  function schemeOf(href){
    var m=/^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href);
    return m?m[1].toLowerCase():"";
  }
  document.addEventListener("click",function(event){
    var target=event.target&&event.target.closest?event.target.closest("a[href]"):null;
    if(!target)return;
    var href=target.getAttribute("href");
    if(href==null)return;
    if(href.charAt(0)==="#")return;
    event.preventDefault();
    var scheme=schemeOf(href);
    if(scheme&&scheme!=="http"&&scheme!=="https")return;
    if(!port)return;
    port.postMessage({type:"ark:diagram-open-link",href:href});
  },true);
  window.addEventListener("message",function(event){
    if(port||!event.data||event.data.type!=="ark:diagram-init"||!event.ports||!event.ports[0])return;
    port=event.ports[0];
    port.addEventListener("message",function(){});
    port.start();
  });
})();
</script>`;

const scriptContentStart = LINK_LAYER.indexOf(">") + 1;
const scriptContentEnd = LINK_LAYER.lastIndexOf("</script>");
const minifyLinkLayerJavaScript = createCachedMinifier(
  LINK_LAYER.slice(scriptContentStart, scriptContentEnd),
  "js"
);

let minifiedLinkLayer: string | undefined;

function getMinifiedLinkLayer(): string {
  if (minifiedLinkLayer === undefined) {
    minifiedLinkLayer = `${LINK_LAYER.slice(0, scriptContentStart)}${minifyLinkLayerJavaScript()}${LINK_LAYER.slice(scriptContentEnd)}`;
  }
  return minifiedLinkLayer;
}

/** </body> 直前へ 1 回だけ注入する。注入済みならそのまま返す。 */
export function injectDiagramLinkLayer(html: string): string {
  if (html.includes(DIAGRAM_LINK_LAYER_MARKER)) return html;
  const layer = getMinifiedLinkLayer();
  const bodyClose = html.toLowerCase().lastIndexOf("</body>");
  if (bodyClose < 0) return `${html}${layer}`;
  return `${html.slice(0, bodyClose)}${layer}${html.slice(bodyClose)}`;
}
```

注意: `port.addEventListener("message", ...)` は `port.start()` を呼ぶための形式的な登録。MessagePort は `onmessage` か `start()` が無いとメッセージを配信しないが、この層は受信しないので空のリスナでよい (他の層が同じ port で受信する)。

`diagram-reader.ts` の `readDiagram`:

```ts
  const projected = injectDiagramLinkLayer(
    injectCsp(injectBuiltinProjection(read.raw, model.model))
  );
```

に変え、import に `injectDiagramLinkLayer` を足す (`./diagram-link-layer.js`)。コメントに「リンク層は投影の後・編集層とコメント層の前」と 1 行足す。

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm --filter @ark/server exec vitest run src/lib/diagram-link-layer.test.ts src/lib/diagram-reader.test.ts src/lib/diagram-comment-layer.test.ts`
Expected: PASS (reader のテストがあれば、注入順が変わっても既存の期待を満たすこと。marker の順序を固定しているテストがあれば `ark-diagram-link-layer` を追加して直す)

- [ ] **Step 5: コミット**

```bash
pnpm check
git add packages/server/src/lib/diagram-link-layer.ts packages/server/src/lib/diagram-link-layer.test.ts packages/server/src/lib/diagram-reader.ts
git commit -m "feat(server): 図解ボードの <a> クリックを横取りして親へ渡すリンク層を注入する"
```

---

### Task 2: `DiagramPane` で href を解釈し、既存の入口へ流す

**Files:**
- Modify: `packages/web/src/components/DiagramPane.tsx` (`handleDiagramPinchMessage` の隣に純関数を追加、port の `onmessage` に 1 行)
- Test: `packages/web/src/components/DiagramPane.test.ts`

**Interfaces:**
- Consumes: `{ type: "ark:diagram-open-link", href }` (Task 1)
- Produces:
  - `parseDiagramLinkHref(href: string): DiagramLinkTarget | null` — `{ kind: "url"; url: string } | { kind: "file"; path: string; line: number | null; endLine: number | null }`
  - `handleDiagramOpenLinkMessage(data: unknown, post: (message: DiagramOpenMessage) => void): boolean`
  - `DiagramOpenMessage = { type: "ark:open-file"; path: string; line: number | null } | { type: "ark:open-url"; url: string }`

- [ ] **Step 1: テストを書く**

`DiagramPane.test.ts` の import に `parseDiagramLinkHref, handleDiagramOpenLinkMessage` を足し、末尾に:

```ts
describe("parseDiagramLinkHref", () => {
  it("相対パスと行を読む", () => {
    expect(parseDiagramLinkHref("src/foo.ts#L10")).toEqual({
      kind: "file",
      path: "src/foo.ts",
      line: 10,
      endLine: null,
    });
    expect(parseDiagramLinkHref("src/foo.ts#L10-L24")).toEqual({
      kind: "file",
      path: "src/foo.ts",
      line: 10,
      endLine: 24,
    });
    expect(parseDiagramLinkHref("src/foo.ts")).toEqual({
      kind: "file",
      path: "src/foo.ts",
      line: null,
      endLine: null,
    });
  });

  it("./ を剥がし、行が読めなければ行なしにする", () => {
    expect(parseDiagramLinkHref("./src/foo.ts#L0")).toMatchObject({
      kind: "file",
      path: "src/foo.ts",
      line: null,
    });
    expect(parseDiagramLinkHref("src/foo.ts#section")).toMatchObject({
      path: "src/foo.ts",
      line: null,
    });
  });

  it("http(s) は URL として返す", () => {
    expect(parseDiagramLinkHref("https://example.com/a?b=1")).toEqual({
      kind: "url",
      url: "https://example.com/a?b=1",
    });
  });

  it("危険なパスと不明なスキームは拒否する", () => {
    expect(parseDiagramLinkHref("../etc/passwd")).toBeNull();
    expect(parseDiagramLinkHref("src/../../x")).toBeNull();
    expect(parseDiagramLinkHref("/etc/passwd")).toBeNull();
    expect(parseDiagramLinkHref("")).toBeNull();
    expect(parseDiagramLinkHref("#s6")).toBeNull();
    expect(parseDiagramLinkHref("javascript:alert(1)")).toBeNull();
    expect(parseDiagramLinkHref("mailto:a@example.com")).toBeNull();
  });
});

describe("handleDiagramOpenLinkMessage", () => {
  it("ファイルは ark:open-file、URL は ark:open-url にして post する", () => {
    const posted: unknown[] = [];
    const post = (message: unknown) => posted.push(message);
    expect(
      handleDiagramOpenLinkMessage(
        { type: "ark:diagram-open-link", href: "src/foo.ts#L10-L24" },
        post
      )
    ).toBe(true);
    expect(
      handleDiagramOpenLinkMessage(
        { type: "ark:diagram-open-link", href: "https://example.com" },
        post
      )
    ).toBe(true);
    expect(posted).toEqual([
      { type: "ark:open-file", path: "src/foo.ts", line: 10 },
      { type: "ark:open-url", url: "https://example.com" },
    ]);
  });

  it("別のメッセージや不正な href は扱わない / 拒否する", () => {
    const posted: unknown[] = [];
    const post = (message: unknown) => posted.push(message);
    expect(handleDiagramOpenLinkMessage({ type: "ark:diagram-pinch" }, post)).toBe(false);
    expect(
      handleDiagramOpenLinkMessage({ type: "ark:diagram-open-link", href: "../x" }, post)
    ).toBe(true);
    expect(posted).toEqual([]);
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec vitest run packages/web/src/components/DiagramPane.test.ts`
Expected: FAIL (export が無い)

- [ ] **Step 3: 実装する**

`DiagramPane.tsx` の `handleDiagramPinchMessage` の直後に:

```ts
export type DiagramLinkTarget =
  | { kind: "url"; url: string }
  | { kind: "file"; path: string; line: number | null; endLine: number | null };

export type DiagramOpenMessage =
  | { type: "ark:open-file"; path: string; line: number | null }
  | { type: "ark:open-url"; url: string };

/**
 * ボード内リンクの href を解釈する。
 * - `http(s)://` は外部 URL
 * - それ以外は worktree 相対のファイルパス。`#L<n>` / `#L<a>-L<b>` で行を指せる
 * - `..` を含む・`/` 始まり・空・不明なスキーム・`#` だけは拒否 (null)
 * 端末リンク (`isAllowedFilePath`) と同じ規則だが、/tmp と HTML 絶対パスの特例は持たない
 */
export function parseDiagramLinkHref(href: string): DiagramLinkTarget | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  if (/^https?:\/\//i.test(trimmed)) return { kind: "url", url: trimmed };
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return null;

  const hashIndex = trimmed.indexOf("#");
  const rawPath = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
  const fragment = hashIndex >= 0 ? trimmed.slice(hashIndex + 1) : "";
  const path = rawPath.replace(/^\.\//, "");
  if (!path || path.startsWith("/") || path.split("/").includes("..")) {
    return null;
  }

  const lines = /^L(\d+)(?:-L(\d+))?$/.exec(fragment);
  const line = lines ? Number.parseInt(lines[1], 10) : Number.NaN;
  const endLine = lines?.[2] ? Number.parseInt(lines[2], 10) : Number.NaN;
  return {
    kind: "file",
    path,
    line: Number.isInteger(line) && line >= 1 ? line : null,
    endLine: Number.isInteger(endLine) && endLine >= 1 ? endLine : null,
  };
}

function isDiagramOpenLinkMessage(
  data: unknown
): data is { type: "ark:diagram-open-link"; href: string } {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "ark:diagram-open-link" &&
    typeof (data as { href?: unknown }).href === "string"
  );
}

/**
 * リンク層からのメッセージを、端末リンクと同じ既存の入口 (`ark:open-file` /
 * `ark:open-url` の window message) に流す。扱ったら true。
 */
export function handleDiagramOpenLinkMessage(
  data: unknown,
  post: (message: DiagramOpenMessage) => void
): boolean {
  if (!isDiagramOpenLinkMessage(data)) return false;
  const target = parseDiagramLinkHref(data.href);
  if (!target) return true;
  if (target.kind === "url") {
    post({ type: "ark:open-url", url: target.url });
  } else {
    post({ type: "ark:open-file", path: target.path, line: target.line });
  }
  return true;
}
```

port の `onmessage` (763 行付近、`handleDiagramPinchMessage` の行の直後) に:

```ts
        if (
          handleDiagramOpenLinkMessage(event.data, message => {
            // ボード iframe は opaque origin なので、親 (同一オリジン) が代わりに
            // 自分の window へ送る。useViewerTabs が端末リンクと同じ経路で受ける
            window.postMessage(message, window.location.origin);
          })
        ) {
          return;
        }
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm exec vitest run packages/web/src/components/DiagramPane.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
pnpm check
git add packages/web/src/components/DiagramPane.tsx packages/web/src/components/DiagramPane.test.ts
git commit -m "feat(web): ボード内リンクをファイルビューア / 新しいタブで開く"
```

---

### Task 3: 規約と見本

**Files:**
- Modify: `.claude/skills/diagram-authoring/SKILL.md` (「守ること」の末尾に 1 項目、「文書型」の節の後ろに新しい節)
- Create: `.claude/diagrams/_examples/change-review.diagram.html`
- Modify: `packages/server/src/lib/diagram-authoring-contract.test.ts`
- Modify: `CLAUDE.md` (「実装済み機能」表のセッションボード行)

**Interfaces:**
- Consumes: Task 1〜2 の挙動 (規約はそれを前提に書く)

- [ ] **Step 1: 契約テストを書く**

`diagram-authoring-contract.test.ts` に:

```ts
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
    expect(skill).not.toMatch(/(?:docs|\.claude)\/diagrams/);
  });

  it("変更レビュー文書の見本が doc contract を満たし、コードへのリンクを含む", () => {
    const html = fs.readFileSync(REVIEW_SAMPLE_PATH, "utf-8");
    const result = extractModel(html);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.model.type).toBe("doc");
    expect(validateDiagramDocAnchors(html, result.model)).toEqual({ ok: true });
    expect(validateDiagramDocAuthorship(html, result.model)).toEqual({ ok: true });
    expect(html).toMatch(/<a href="[^"/#:][^"]*#L\d+(?:-L\d+)?">/);
    expect(html).not.toMatch(/<a href="https?:/);
    const kinds = new Set(result.model.nodes.map(node => node.kind));
    expect(kinds.has("section")).toBe(true);
    expect(kinds.has("figure")).toBe(true);
  });
```

ファイル冒頭の定数の隣に `const REVIEW_SAMPLE_PATH = path.resolve(REPOSITORY_ROOT, ".claude/diagrams/_examples/change-review.diagram.html");` を足す (`DOC_SAMPLE_PATH` の定義に倣う。テストファイル側にディレクトリ名を書くのは既存どおり可)。

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm --filter @ark/server exec vitest run src/lib/diagram-authoring-contract.test.ts`
Expected: 新規 2 件が FAIL

- [ ] **Step 3: 規約を書く**

`SKILL.md` の「守ること」リストの末尾 (`<meta http-equiv=...` の項目の後) に:

```markdown
- **コードを指す語はリンクにする。** 関数名・ファイル名・設定キーなど、リポジトリの実際のコードを指す語は `<a href="src/foo.ts#L10-L24">parse()</a>` の形で書く。パスは worktree 相対 (`./` や `/` で始めない、`..` を使わない)、行は `#L<行>` か `#L<開始>-L<終了>`。押すと Ark のファイルビューアで該当行が開く。外部の URL は `https://` のまま書けば新しいタブで開く。`#` 始まりは文書内アンカーとして扱われる
```

「文書型」の節 (`### 本文の書き手` の後、`## ファイルの構造` の前) に新しい節:

```markdown
## 変更レビュー文書

ブランチや PR の変更をレビューする文書は `type: "doc"` で、節を次の順に書く。読み手は
その変更を初めて見るエンジニアで、上から順に読めば「何が・なぜ・どう」が分かる状態にする。

1. **what / why** — 何を変えたか、なぜ変えたか (分かる範囲で)。3〜5 行
2. **要件** — 利用者が言った言葉のまま、短い箇条書き。無ければ節ごと省く
3. **設計** — 部品・データ・制御の流れの水準で、どう動くか。**図は 1 枚**だけ選ぶ:
   - 時間軸で参加者がやり取りする (誰が誰を呼ぶ、非同期の受け渡し) なら `flow`
   - 分岐・再試行・状態遷移が肝なら `state`
   - データの形と、誰が読み書きするかの変更なら `er`
   - 境界や責務の移動なら `context-map`
   図は `kind: "figure"` で置き、本文にキャプションを書く。主な判断とトレードオフ、
   根拠のある代替案もここに書く。小さな変更で設計が自明なら節ごと省く
4. **実装** — 関数とファイルの水準で、コードがどう設計を実現しているか。
   **エントリポイント** (ボタン、CLI コマンド、イベント) から読む順に並べ、
   関数名・ファイル名はすべてリンクにする。仕組みや不変条件を担う数か所だけ
   `kind: "code"` で抜粋し、残りはリンクで済ませる
5. 書き終えたら通読し、矛盾と裏の取れていない主張を消す

小さな変更ほど短くする。節を省くことをためらわない。
```

- [ ] **Step 4: 見本を書く**

`.claude/diagrams/_examples/change-review.diagram.html`。題材は架空の小さな変更「セッション一覧の並び順を最終更新順にする」。`order-flow-design.diagram.html` と同じ `<style>` の流儀で、次の構造にする (id と kind は model と一致させる):

```html
<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>変更レビュー: セッション一覧を最終更新順にする</title>
<style>
  :root { color-scheme: light; --ink: #223047; --muted: #627086; --line: #d8e0ea; --paper: #f5f7fa; --card: #fff; --accent: #176b87; font-family: "Hiragino Sans", "Yu Gothic UI", sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; color: var(--ink); background: var(--paper); }
  .document { width: min(960px, calc(100% - 48px)); margin: 40px auto 72px; }
  h1 { margin: 0 0 24px; font-size: 28px; }
  section { margin: 0 0 28px; padding: 20px 22px; border: 1px solid var(--line); border-radius: 12px; background: var(--card); }
  h2 { margin: 0 0 12px; font-size: 18px; }
  p, li { line-height: 1.75; }
  a { color: var(--accent); }
  figure { margin: 16px 0; }
  figcaption { color: var(--muted); font-size: 13px; }
  pre { padding: 12px 14px; border-radius: 8px; background: #eef2f6; overflow-x: auto; font-size: 13px; }
  svg { width: 100%; height: auto; }
</style>
</head>
<body>
<script type="application/json" id="ark-diagram-model">
{
  "version": 1,
  "type": "doc",
  "title": "変更レビュー: セッション一覧を最終更新順にする",
  "nodes": [
    { "id": "s1", "label": "what / why: サイドバーのセッション一覧を作成順から最終更新順に変え、いま動いているものを上に出す。", "kind": "section" },
    { "id": "s1-p1", "label": "セッションが 10 を超えると作成順では探しにくい。最後に応答があった順なら、注意を向けるべきものが上に来る。", "kind": "paragraph" },
    { "id": "s2", "label": "要件: 利用者の言葉のままの箇条書き。", "kind": "section" },
    { "id": "s2-l1", "label": "要件の一覧。", "kind": "list" },
    { "id": "s2-l1-i1", "label": "直近に動いたセッションが一番上に来てほしい。", "kind": "list-item" },
    { "id": "s2-l1-i2", "label": "止まっているセッションは下にまとめてほしい。", "kind": "list-item" },
    { "id": "s3", "label": "設計: 並び替えはクライアント側で、session:previews が運ぶ最終更新時刻を鍵にする。", "kind": "section" },
    { "id": "s3-p1", "label": "サーバは既に 1 秒ごとの previews で各セッションの最終更新時刻を配っている。並び替えはその値でクライアントが行い、サーバは変えない。", "kind": "paragraph" },
    { "id": "s3-f1", "label": "図: 最終更新時刻がサーバの polling からサイドバーの並びに届くまでの流れ。", "kind": "figure" },
    { "id": "s4", "label": "実装: サイドバーの並び替え関数と、それを呼ぶ一覧コンポーネント。", "kind": "section" },
    { "id": "s4-l1", "label": "読む順序。", "kind": "list" },
    { "id": "s4-l1-i1", "label": "エントリポイントはサイドバーの一覧描画。並び替えの鍵に最終更新時刻を渡す。", "kind": "list-item" },
    { "id": "s4-l1-i2", "label": "並び替え関数は最終更新時刻の降順、同時刻は作成順で安定させる。", "kind": "list-item" },
    { "id": "s4-c1", "label": "抜粋: 並び替えの比較関数。", "kind": "code" }
  ],
  "edges": [],
  "groups": [
    { "id": "g-s1", "label": "what / why", "nodes": ["s1", "s1-p1"] },
    { "id": "g-s2", "label": "要件", "nodes": ["s2", "s2-l1", "s2-l1-i1", "s2-l1-i2"] },
    { "id": "g-s3", "label": "設計", "nodes": ["s3", "s3-p1", "s3-f1"] },
    { "id": "g-s4", "label": "実装", "nodes": ["s4", "s4-l1", "s4-l1-i1", "s4-l1-i2", "s4-c1"] }
  ]
}
</script>
<main class="document">
<h1>変更レビュー: セッション一覧を最終更新順にする</h1>

<section data-ark-id="s1" data-ark-author="claude">
  <h2>what / why</h2>
  <p data-ark-id="s1-p1" data-ark-author="claude">セッションが 10 を超えると作成順では探しにくい。最後に応答があった順なら、注意を向けるべきものが上に来る。並び替えは <a href="packages/web/src/components/SessionSectionList.tsx#L40-L58">SessionSectionList</a> の中だけで閉じる。</p>
</section>

<section data-ark-id="s2" data-ark-author="human">
  <h2>要件</h2>
  <ul data-ark-id="s2-l1" data-ark-author="human">
    <li data-ark-id="s2-l1-i1" data-ark-author="human">直近に動いたセッションが一番上に来てほしい</li>
    <li data-ark-id="s2-l1-i2" data-ark-author="human">止まっているセッションは下にまとめてほしい</li>
  </ul>
</section>

<section data-ark-id="s3" data-ark-author="claude">
  <h2>設計</h2>
  <p data-ark-id="s3-p1" data-ark-author="claude">サーバは既に 1 秒ごとの <code>session:previews</code> で各セッションの最終更新時刻を配っている (<a href="packages/server/src/index.ts#L1417">接続時の初期送信</a>)。並び替えはその値でクライアントが行い、サーバは変えない。</p>
  <figure data-ark-id="s3-f1" data-ark-author="claude">
    <svg viewBox="0 0 640 120" role="img" aria-label="最終更新時刻の流れ">
      <rect x="10" y="40" width="150" height="40" rx="8" fill="#e8f4f7" stroke="#176b87"/><text x="85" y="65" text-anchor="middle" font-size="13">tmux polling (1s)</text>
      <path d="M160 60 H240" stroke="#176b87" stroke-width="2"/><polygon points="240,55 250,60 240,65" fill="#176b87"/>
      <rect x="250" y="40" width="150" height="40" rx="8" fill="#e8f4f7" stroke="#176b87"/><text x="325" y="65" text-anchor="middle" font-size="13">session:previews</text>
      <path d="M400 60 H480" stroke="#176b87" stroke-width="2"/><polygon points="480,55 490,60 480,65" fill="#176b87"/>
      <rect x="490" y="40" width="140" height="40" rx="8" fill="#e8f4f7" stroke="#176b87"/><text x="560" y="65" text-anchor="middle" font-size="13">サイドバーの並び</text>
    </svg>
    <figcaption>最終更新時刻は polling → previews → 並び替え、の一方向に流れる。サーバ側の変更は無い。</figcaption>
  </figure>
</section>

<section data-ark-id="s4" data-ark-author="claude">
  <h2>実装</h2>
  <ol data-ark-id="s4-l1" data-ark-author="claude">
    <li data-ark-id="s4-l1-i1" data-ark-author="claude">エントリポイントは <a href="packages/web/src/components/SessionSectionList.tsx#L120">一覧の描画</a>。並び替えの鍵に最終更新時刻 (<code>sessionLastUpdatedAt</code>) を渡す</li>
    <li data-ark-id="s4-l1-i2" data-ark-author="claude"><a href="packages/web/src/components/SessionSectionList.tsx#L40-L58">並び替え関数</a>は最終更新時刻の降順。同時刻は作成順で安定させる</li>
  </ol>
  <pre data-ark-id="s4-c1" data-ark-author="claude"><code>function byLastUpdated(a, b) {
  return (b.lastUpdatedAt ?? 0) - (a.lastUpdatedAt ?? 0) || a.createdAt - b.createdAt;
}</code></pre>
</section>
</main>
</body>
</html>
```

リンク先の行番号は架空でよい (見本は書き方を示すもの。実在のファイルを指しておくと押したときに開く)。

`CLAUDE.md` の「セッションボード」行の末尾に「本文の `<a href="src/foo.ts#L10">` はファイルビューアで該当行を開く」を足す。

- [ ] **Step 5: テストが通ることを確認する**

Run: `pnpm --filter @ark/server exec vitest run src/lib/diagram-authoring-contract.test.ts`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
pnpm check
git add .claude/skills/diagram-authoring/SKILL.md .claude/diagrams/_examples/change-review.diagram.html packages/server/src/lib/diagram-authoring-contract.test.ts CLAUDE.md
git commit -m "docs(diagram): コードへのリンクの規約と変更レビュー文書の型を追加"
```

---

### Task 4: 実機確認と PR

- [ ] **Step 1: 実機確認**

worktree をビルドし、隔離インスタンス (`ARK_DATA_DIR` + `PORT=4102`) で:
1. Ark のセッション (このリポジトリの worktree) を開き、右ペインで `_examples/change-review.diagram.html` を `board_open` 相当 (図タブ) で開く
2. 「並び替え関数」のリンクを押す → 右ペインに `SessionSectionList.tsx` が開き、指定行がハイライトされる
3. コメント層が生きている (「図が別のページへ遷移しようとした」のエラーが出ず、本文の選択でコメント UI が出る)
4. `https://` のリンクを一時的に見本へ足して押す → 新しいタブで開く (確認後に戻す)

- [ ] **Step 2: push と PR**

`git push -u origin feat/board-code-links` → `gh pr create` (本文に設計文書・計画のパスと確認結果) → `/codex review` → CI と CodeRabbit を PR 番号で監視。
