# 会話ビューの作業中端末末尾 (liveTail) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude が考えている・作業している間、会話ビューの「考えています」の真上に tmux 画面の末尾 12 行を加工せずに出す。

**Architecture:** サーバーは既存の 1 秒 polling (`SessionOrchestrator.getAllPreviews`) が取った可視画面から、`bridgeStatus` が THINK / TOOL のときだけ `liveTail` を作って `session:previews` に載せる。整形は AUQ の「直前の画面」と同じ `buildAuqScreenContext` を使う。クライアントは `awaitingText` と同じ経路 (useSocket → Dashboard / MobileLayout → SplitViewPane / MobileSessionView → SplitChatPane) で受け取り、等幅の枠で表示する。

**Tech Stack:** TypeScript, Socket.IO, React 19, TailwindCSS 4, vitest

**Spec:** `docs/superpowers/specs/2026-09-27-chat-live-terminal-tail-design.md`

## Global Constraints

- 画面テキストの内容を解釈・パースしない。加工は ANSI 除去・末尾空行の除去・行数と文字数の上限だけ
- 末尾 12 行、上限 2,000 文字
- `liveTail` は `bridgeStatus` が `THINK` / `TOOL` のときだけ入れる
- 追加の tmux 呼び出しをしない (既に取った raw を使う)
- 表示は `aria-hidden`、`white-space: pre` で折り返さず横スクロール
- コメント・コミットメッセージは日本語。Co-Authored-By を付けない
- 検証: `pnpm check` と `pnpm vitest run <file>`

---

### Task 1: サーバーが作業中の画面末尾を session:previews に載せる

**Files:**
- Modify: `packages/shared/src/types.ts` (`"session:previews"` のペイロード型、`awaitingText?` の直後)
- Modify: `packages/server/src/lib/session-orchestrator.ts` (`getAllPreviews` の戻り値型 2 か所と `previews.push`)
- Test: `packages/server/src/lib/session-orchestrator.test.ts` (`describe("getAllPreviews")` 内)

**Interfaces:**
- Produces: `session:previews` の各要素に `liveTail?: string`

- [ ] **Step 1: 失敗するテストを書く**

`describe("getAllPreviews", ...)` の末尾に追加する:

```ts
    it("作業中は画面の末尾をそのまま liveTail に載せ、入力待ちでは載せない", () => {
      const orchestrator = new SessionOrchestrator();
      const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "ark-wt-"));
      mockedTmux.getAllSessions.mockReturnValue([
        makeTmuxSession({ worktreePath }) as never,
      ]);
      const lines = Array.from({ length: 20 }, (_, i) => `出力${i}`);
      lines.push("✻ Cogitating… (32s · ↓ 1.2k tokens)", "", "");
      mockedTmux.capturePaneVisible.mockReturnValue(okValue(lines.join("\n")));

      const [busy] = orchestrator.getAllPreviews();
      expect(["THINK", "TOOL"]).toContain(busy.bridgeStatus);
      // 末尾空行を落とした最後の 12 行。中身は判定しない
      expect(busy.liveTail).toBe(
        [...lines.slice(9, 20), "✻ Cogitating… (32s · ↓ 1.2k tokens)"].join(
          "\n"
        )
      );

      mockedTmux.capturePaneVisible.mockReturnValue(
        okValue("直前の出力です\n> ")
      );
      const [idle] = orchestrator.getAllPreviews();
      expect(idle.liveTail).toBeUndefined();

      fs.rmSync(worktreePath, { recursive: true, force: true });
    });
```

- [ ] **Step 2: 失敗を確かめる**

Run: `pnpm vitest run packages/server/src/lib/session-orchestrator.test.ts -t "liveTail"`
Expected: FAIL (`busy.liveTail` が undefined)

- [ ] **Step 3: 実装する**

`packages/shared/src/types.ts` の `awaitingText?: string;` の直後に追加:

```ts
      /**
       * THINK / TOOL のときのみ: 画面末尾の生テキスト (ANSI 除去・末尾空行除去済み)。
       * 返事が JSONL に届くまでの間、チャットビューで動きを見せるためにそのまま表示する。
       * 内容は解釈しない
       */
      liveTail?: string;
```

`session-orchestrator.ts`:

1. import に追加: `import { buildAuqScreenContext } from "./auq-screen-context.js";`
2. ファイル上部 (クラス定義の前) に定数:

```ts
/**
 * 作業中にチャットビューへそのまま出す画面末尾の上限。
 * スピナー行 (経過秒・トークン数) と直前のツール出力が入り、入力欄と下部の帯 (約 5 行) も含む
 */
const LIVE_TAIL_LINES = 12;
const LIVE_TAIL_MAX_CHARS = 2000;
```

3. `getAllPreviews` の戻り値型と `previews` 配列型の両方に `liveTail?: string;` を `awaitingText?: string;` の直後に追加
4. `previews.push` の直前に:

```ts
      // 作業中だけ、画面末尾を加工せずに添える (AUQ の「直前の画面」と同じ整形。解釈はしない)
      const liveTail =
        bridgeStatus === "THINK" || bridgeStatus === "TOOL"
          ? (buildAuqScreenContext(stripAnsi(raw), {
              maxLines: LIVE_TAIL_LINES,
              maxChars: LIVE_TAIL_MAX_CHARS,
            }) ?? undefined)
          : undefined;
```

5. `previews.push({ ... awaitingText, liveTail, lastUpdatedAt, ... })`

- [ ] **Step 4: 通ることを確かめる**

Run: `pnpm vitest run packages/server/src/lib/session-orchestrator.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/shared/src/types.ts packages/server/src/lib/session-orchestrator.ts packages/server/src/lib/session-orchestrator.test.ts
git commit -m "feat(server): 作業中の画面末尾を session:previews に載せる"
```

---

### Task 2: 会話ビューで作業中の画面末尾を表示する

**Files:**
- Modify: `packages/web/src/hooks/useSocket.ts` (`sessionAwaitingTexts` と並べて `sessionLiveTails` を追加: 型定義 ~240、state ~434、`session:previews` ハンドラ ~897、戻り値 ~1760)
- Modify: `packages/web/src/pages/Dashboard.tsx` (~127 分割代入、~775 MobileLayout へ、~996 SplitViewPane へ)
- Modify: `packages/web/src/components/MobileLayout.tsx` (~189 props 型、~272 分割代入、~502 MobileSessionView へ)
- Modify: `packages/web/src/components/MobileSessionView.tsx` (~131 props 型、~178 分割代入、~693 SplitChatPane へ)
- Modify: `packages/web/src/components/SplitViewPane.tsx` (~156 props 型、~566 SplitChatPane へ)
- Modify: `packages/web/src/components/SplitChatPane.tsx` (props ~110、分割代入 ~1093、新コンポーネント、描画 ~1933)
- Test: `packages/web/src/components/SplitChatPane.test.tsx` (`describe("SplitChatPane: 作業中の表示")` 内)

**Interfaces:**
- Consumes: `session:previews` の `liveTail?: string` (Task 1)
- Produces: `useSocket().sessionLiveTails: Map<string, string>`、各コンポーネントの `liveTail?: string` prop

- [ ] **Step 1: 失敗するテストを書く**

`describe("SplitChatPane: 作業中の表示", ...)` の末尾に追加:

```ts
  it("作業中は画面の末尾をそのまま出し、作業中でなければ出さない", () => {
    const tail = (container: HTMLElement) =>
      container.querySelector('[data-testid="chat-live-tail"]');
    const text = "⏺ Bash(pnpm test)\n✻ Cogitating… (32s · ↓ 1.2k tokens)";

    const busy = renderChat({ bridgeStatus: "THINK", liveTail: text });
    expect(tail(busy.container)?.textContent).toBe(text);
    expect(tail(busy.container)?.getAttribute("aria-hidden")).toBe("true");

    const idle = renderChat({ bridgeStatus: "IDLE", liveTail: text });
    expect(tail(idle.container)).toBeNull();

    const empty = renderChat({ bridgeStatus: "TOOL" });
    expect(tail(empty.container)).toBeNull();
  });
```

- [ ] **Step 2: 失敗を確かめる**

Run: `pnpm vitest run packages/web/src/components/SplitChatPane.test.tsx -t "画面の末尾"`
Expected: FAIL (`liveTail` prop が無い型エラー、または要素が null)

- [ ] **Step 3: SplitChatPane を実装する**

props 型の `awaitingText?: string;` の直後:

```ts
  /**
   * THINK / TOOL 中の画面末尾の生テキスト。返事が JSONL に届くまでの間、
   * 「考えています」の上にそのまま出して動きを見せる。内容は解釈しない
   */
  liveTail?: string;
```

本体の分割代入に `liveTail,` を `awaitingText,` の直後へ追加。

`WorkingIndicator` の直後に新コンポーネント:

```tsx
/**
 * 作業中の端末末尾を、加工せずに等幅で出す。1 秒ごとに差し替わるので読み上げない。
 * 端末の幅は会話欄より広いことがあるため、折り返さずに横スクロールにする (枠線の文字を崩さない)
 */
function LiveTerminalTail({ text }: { text: string }) {
  return (
    <pre
      data-testid="chat-live-tail"
      aria-hidden="true"
      className="mx-4 mt-2 overflow-x-auto whitespace-pre rounded-md border border-border/60 bg-muted/40 px-3 py-2 font-mono text-[11px] leading-[1.45] text-muted-foreground"
    >
      {text}
    </pre>
  );
}
```

描画 (~1933) を置き換え:

```tsx
            {workingLabel && liveTail && <LiveTerminalTail text={liveTail} />}
            {workingLabel && (
              <WorkingIndicator label={workingLabel} announce={!isMobile} />
            )}
```

末尾追従スクロールの effect (~1375 の `biome-ignore ... (workingLabel)` の付いた useEffect) の依存配列に `liveTail` を足し、biome-ignore のコメントに `(liveTail)` 用の行を同じ書式で足す: 枠の中身が変わると高さが変わるため。

- [ ] **Step 4: 通ることを確かめる**

Run: `pnpm vitest run packages/web/src/components/SplitChatPane.test.tsx`
Expected: PASS

- [ ] **Step 5: useSocket から SplitChatPane まで配線する**

`useSocket.ts`:
- 型 (`sessionAwaitingTexts` の直後):

```ts
  /**
   * sessionId → THINK / TOOL 中の画面末尾の生テキスト。
   * 会話ビューで返事が届くまでの動きを見せる。作業中でないセッションはエントリ自体が無い
   */
  sessionLiveTails: Map<string, string>;
```

- state (`sessionAwaitingTexts` の直後):

```ts
  // 作業中の画面末尾 (会話ビューで動きを見せる)。作業中でないセッションは undefined になる
  const [sessionLiveTails, setSessionLiveTails] = useState<
    Map<string, string>
  >(new Map());
```

- `session:previews` ハンドラの `setSessionAwaitingTexts(...)` の直後:

```ts
      setSessionLiveTails(prev => {
        const next = new Map(prev);
        for (const p of previews) {
          if (p.liveTail) {
            next.set(p.sessionId, p.liveTail);
          } else {
            next.delete(p.sessionId);
          }
        }
        return next;
      });
```

- 戻り値オブジェクトに `sessionLiveTails,` を `sessionAwaitingTexts,` の直後へ

`Dashboard.tsx`: 分割代入に `sessionLiveTails,`、MobileLayout へ `sessionLiveTails={sessionLiveTails}`、SplitViewPane へ `liveTail={sessionLiveTails.get(session.id)}` (いずれも awaitingText 系の直後)。

`MobileLayout.tsx`: props 型に

```ts
  /** 作業中の画面末尾マップ（会話ビューで動きを見せる） */
  sessionLiveTails: Map<string, string>;
```

分割代入に `sessionLiveTails,`、MobileSessionView へ `liveTail={sessionLiveTails.get(sessionId)}`。

`MobileSessionView.tsx`: props 型 `awaitingText?: string;` の直後に `/** 作業中の画面末尾（会話ビューで動きを見せる） */ liveTail?: string;`、分割代入に `liveTail,`、SplitChatPane へ `liveTail={liveTail}`。

`SplitViewPane.tsx`: props 型 `awaitingText?: string;` の直後に同じコメント付きで `liveTail?: string;`、SplitChatPane へ `liveTail={props.liveTail}`。

MobileLayout を描画している既存テストが `sessionLiveTails` 不足で型エラーになる場合は、そのテストの props に `sessionLiveTails: new Map()` を足す (`grep -rn "sessionAwaitingTexts" packages/web/src --include='*.test.tsx'` で探す)。

- [ ] **Step 6: 型と全テストを確かめる**

Run: `pnpm check && pnpm vitest run packages/web packages/server`
Expected: エラー 0、全 PASS

- [ ] **Step 7: コミット**

```bash
git add packages/web
git commit -m "feat(web): 会話ビューに作業中の画面末尾を出す"
```

---

### Task 3: 実機で確かめる

- [ ] **Step 1:** 検証ビルドを別インスタンスで立てる (メモリ「Ark の実機E2E手順」「Arkサーバ側E2Eの隔離」に従い、本番 dist と本番ポートを上書きしない)
- [ ] **Step 2:** 検証用セッションで会話ビューを開き、考えさせる指示 (例: 「このリポジトリの構成を詳しく説明して」) を送る
- [ ] **Step 3:** Playwright で 2 秒おきに 2 回スクリーンショットを撮り、枠の中のスピナー行の秒数が進んでいること、返事が届くと枠が消えることを確かめる。PC 幅とモバイル幅 (390px) の両方
- [ ] **Step 4:** CLAUDE.md の「情報源分離の原則」の段落に、capture-pane の用途として「作業中の画面末尾の verbatim 表示 (`liveTail`)」を追記してコミット
