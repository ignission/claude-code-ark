# 見た目の刷新 (Paper) 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Arkの見た目を「黒地にネオン緑のターミナル」から、明るい紙の上で「自分の番」が一目で分かる見た目に変える。

**Architecture:** まずトークン (`index.css`) とテーマ追従、状態の表示ロジック (`status-tone.ts`)・並べ方 (`session-sections.ts`)・並び替えの保留 (`useHeldOrder.ts`)・ツール行の折りたたみ (`chat-render-items.ts`) を、画面から独立した純粋な関数として作る。次にPCサイドバー → モバイル一覧 → PC上部バー → 会話 → モバイル会話 → 残りの画面の順で、それらを使って各コンポーネントを組み替える。最後に別出力先のビルドで撮影して確かめる。

**Tech Stack:** React 19, Tailwind CSS 4 (`@theme inline`), shadcn/ui (Radix), lucide-react 1.35, vitest (jsdom は `// @vitest-environment jsdom`), Playwright

**設計書:** `docs/superpowers/specs/2026-09-17-visual-redesign-paper-design.md` (以下「設計書」)。参照モックは `docs/superpowers/specs/2026-09-17-visual-redesign-paper/A-*.html`

## Global Constraints

- 作業ディレクトリ: `/home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper` (ブランチ `feat/visual-redesign-paper`)。コミット前に `git branch --show-current` で確かめる
- 最初に一度だけ `pnpm install --frozen-lockfile` を実行する (worktreeに `node_modules` が無い)
- **`pnpm build` を実行しない**。本番のArk (pm2, port 4001) はmainのチェックアウトの `packages/web/dist` を配信している。worktreeでのビルドは本番を変えないが、取り違えの事故を避けるため、検証ビルドは必ず `--outDir` で別の場所に出す (Task 12)
- テストの実行: リポジトリのルートで `pnpm vitest run <path>`。全体は `pnpm test`、型とlintは `pnpm check`
- 整形: `pnpm check` (= `biome check . && tsc -b`) はBiomeの整形差分もエラーにする。コミット前に `pnpm biome check --write <変更したファイル>` で整形してから `pnpm check` を通す
- **preview は必ず `--host 127.0.0.1` で立てる**。`vite.config.ts` は `host: true` なので、付けないと LAN やDockerのブリッジにも公開される。preview は `/api` と `/socket.io` を localhost から 4001 へ中継するため、外から届くと Ark の認証 (localhost は認証を省く) をすり抜けてしまう
- **稼働中のArk (http://localhost:4001) の画面をブラウザで開くときは、`/ttyd/` への通信を必ず遮断する** (開くだけでユーザーのtmuxペインが検証側の画面サイズに縮む)
- コミットメッセージは日本語。`Co-Authored-By` を付けない
- 日本語の文言・コメントは、日本語と半角英数字の間に空白を入れない (例: 「作業3件」「PCサイドバー」)。括弧は半角で、開き括弧の前と閉じ括弧の後ろに半角スペース
- UIの文言は設計書の表記どおり (例: 「確認待ち」「入力待ち」「作業中」「あなたの番」「休止中」)
- 等幅フォント (`font-mono`) はコードブロック・ツール行の引数・ファイルパスの表示と入力・端末のキーボタン・「直前の画面」だけに使う。セッション名・ブランチ名・リポジトリ名・チップ・ボタンには使わない
- 色は `index.css` のトークン経由だけで指定する。`text-green-500` `bg-red-500` `bg-emerald-*` `bg-[#...]` などの直書きを新たに書かない (ttydの背景色 `#1c1a17` だけは例外で、`TERMINAL_BG` 定数を使う)
- 絵文字をアイコンとして使わない。lucide-react のアイコンを使う
- `/bridge` ページ (`components/bridge/BridgeDashboard.tsx` `bridge.css` `pages/Bridge.tsx`) は変更しない。`SystemStatusBar.tsx` は About に移すための変更だけ許す
- 端末の画面テキストを解釈して表示を作らない (情報源分離の原則)。状態の表示は `BridgeSessionStatus` と質問カードの有無だけから作る

## ファイル構成

### 新規

| ファイル | 責務 |
|---|---|
| `packages/web/src/lib/status-tone.ts` | 状態 (`BridgeSessionStatus` + 未起動 + 未着) → トーン・文言・アイコン・セクション・優先度。モバイルの状態の帯の文言 |
| `packages/web/src/lib/status-tone.test.ts` | 上のテスト |
| `packages/web/src/components/StatusChip.tsx` | 状態チップ (アイコン + 文言) |
| `packages/web/src/components/StatusChip.test.tsx` | 上のテスト |
| `packages/web/src/lib/session-sections.ts` | `RepoGroup` の Map → 行の配列 → 並べ替え → セクション分け |
| `packages/web/src/lib/session-sections.test.ts` | 上のテスト |
| `packages/web/src/hooks/useHeldOrder.ts` | 並び替えの保留 (保留中は前の順を保ち、中身だけ最新にする) と、保留条件の追跡 |
| `packages/web/src/hooks/useHeldOrder.test.tsx` | 上のテスト |
| `packages/web/src/lib/chat-render-items.ts` | `groupSidechain` の移設と、ツール行の折りたたみ (`groupToolCalls`) |
| `packages/web/src/lib/chat-render-items.test.ts` | 上のテスト |
| `packages/web/src/index-css.test.ts` | ライトとダークのトークンの対応・撤去したクラスが残っていないことのテスト |
| `packages/server/src/lib/ttyd-theme.ts` | ttyd の `-t` オプション (フォントと色) の組み立て |
| `packages/server/src/lib/ttyd-theme.test.ts` | 上のテスト |
| `packages/web/src/components/SessionListRow.tsx` | PCサイドバーとモバイル一覧で共有する行の中身 (チップ・主ラベル・2行目) |
| `packages/web/src/components/SessionRowMenu.tsx` | 行のメニューの中身 (右クリックと `…` で共有) |
| `packages/web/src/components/SessionHeaderMenu.tsx` | PC上部バーの `…` メニュー |
| `packages/web/src/components/SegmentedControl.tsx` | 「端末 / 会話」「会話 / 端末 / 図」のセグメントコントロール |
| `packages/web/src/components/SegmentedControl.test.tsx` | 上のテスト |
| `packages/web/src/components/SessionSectionList.tsx` | 並べ方・保留・行メニューの配線・確認ダイアログをまとめた一覧本体。PCサイドバーとモバイル一覧で共有 (Task 5) |
| `packages/web/src/components/SessionSectionList.test.tsx` / `SessionListRow.test.tsx` / `SessionRowMenu.test.tsx` / `SessionSidebar.test.tsx` / `MobileSessionList.test.tsx` | Task 5・6 のテスト |
| `packages/web/src/lib/session-header.ts` (+ `.test.ts`) | 上部バーの主ラベルと `…` メニューの項目・文言を決める純粋な関数 (Radix のメニューは jsdom で開けないため、並びと文言をここで固定する。Task 7) |
| `packages/web/src/components/TerminalPane.test.tsx` | Task 7 のテスト |
| `packages/web/src/lib/floating-composer.ts` (+ `.test.ts`) | モバイルの浮かぶバーの下端距離 `FLOATING_BAR_BOTTOM` と本文の余白 `floatingBarReserve()` (Task 9。Task 10 も使う) |
| `packages/web/src/components/SplitChatPane.test.tsx` / `AskUserQuestionCard.test.tsx` | Task 8・9 のテスト |
| `packages/web/src/components/RepoGridView.test.tsx` | Task 11 のテスト |

### 削除

| ファイル | 理由 |
|---|---|
| `packages/web/src/contexts/ThemeContext.tsx` | テーマはCSSのメディアクエリで切り替える (Task 1) |
| `packages/web/src/components/SessionCard.tsx` | 行は `SessionListRow`、メニューは `SessionRowMenu` に置き換わる (Task 5) |
| `packages/web/src/components/RepoProfileMenu.tsx` | 中身は `SessionRowMenu` に吸収。プロファイル別の5色をやめる (Task 5) |
| `packages/web/src/components/SplitViewLeftModeToggle.tsx` | `SegmentedControl` に置き換わる (Task 7) |

### 主に変更

`packages/shared/src/types.ts` (端末の色の定数を追加) / `index.css` / `App.tsx` / `contexts/ThemeContext.tsx` (削除) / `components/ui/sonner.tsx` / `lib/split-view-left-mode.ts` /
`server/src/lib/ttyd-manager.ts` / `SessionSidebar.tsx` / `SessionCard.tsx` / `SidebarMainLayout.tsx` / `AboutDialog.tsx` /
`MobileSessionList.tsx` / `MobileLayout.tsx` / `pages/Dashboard.tsx` / `SplitViewPane.tsx` / `SplitViewLeftModeToggle.tsx` /
`TerminalPane.tsx` / `SplitChatPane.tsx` / `AskUserQuestionCard.tsx` / `MobileSessionView.tsx` /
`MobileSessionViewModeToggle.tsx` / `RepoGridView.tsx` / ダイアログ類 / `UpdateBanner.tsx` / `FileViewerPane.tsx` / `NotFound.tsx`

## 部品の受け渡し (全タスク共通の名前と型)

後のタスクはここに書いた名前と型をそのまま使う。実装は Task 2〜4 にある。

```ts
// packages/web/src/lib/status-tone.ts
import type { BridgeSessionStatus } from "@ark/shared";
import type { MobileSessionViewMode } from "./mobile-session-view-mode"; // "chat" | "terminal" | "board"

export type StatusKey = BridgeSessionStatus | "NOT_STARTED" | "UNKNOWN";
export type StatusTone = "awaiting" | "error" | "idle" | "busy" | "neutral";
export type StatusIcon = "question" | "alert" | "message" | "dots" | "minus" | "stop" | "play";
export type SessionSection = "your-turn" | "working" | "resting";

export interface StatusPresentation {
  tone: StatusTone;
  label: string;          // UNKNOWN だけ ""
  icon: StatusIcon;
  section: SessionSection;
  priority: number;       // 1 (AWAITING) 〜 8 (UNKNOWN)
  outlined: boolean;      // NOT_STARTED だけ true
}

export function resolveStatusKey(hasSession: boolean, bridgeStatus: BridgeSessionStatus | undefined): StatusKey;
export function presentStatus(key: StatusKey): StatusPresentation;
export const SECTION_ORDER: readonly SessionSection[];               // ["your-turn", "working", "resting"]
export const SECTION_LABELS: Readonly<Record<SessionSection, string>>; // あなたの番 / 作業中 / 休止中
export const TONE_CLASSES: Readonly<Record<StatusTone, { text: string; softBg: string; solidBg: string }>>;

export interface StatusStrip { tone: StatusTone; text: string; offerChat: boolean }
export function resolveStatusStrip(input: {
  bridgeStatus: BridgeSessionStatus | undefined;
  hasActiveAuq: boolean;
  isConnected: boolean;
  viewMode: MobileSessionViewMode;
}): StatusStrip | null;
```

```tsx
// packages/web/src/components/StatusChip.tsx
export function StatusChip(props: { statusKey: StatusKey; className?: string }): JSX.Element;
// 外側の要素に data-status={statusKey} を持ち、文言を textContent に出す。UNKNOWN は文言なしの aria-hidden の小さな印
```

```ts
// packages/web/src/lib/session-sections.ts
import type { BridgeSessionStatus, ManagedSession, Worktree } from "@ark/shared";
import type { RepoGroup } from "@/hooks/useGroupedWorktreeItems";

export interface SessionListEntry {
  key: string;                    // worktree があれば `wt:${worktree.id}`、無ければ `s:${session.id}`
  worktree: Worktree | null;
  session: ManagedSession | null;
  repoPath: string;
  repoName: string;
  disambiguator: string | null;
  statusKey: StatusKey;
}
export interface SessionSectionGroup { section: SessionSection; entries: SessionListEntry[] }

export function buildSessionEntries(
  groupedItems: Map<string, RepoGroup>,
  statuses: Map<string, BridgeSessionStatus>
): SessionListEntry[];
export function sortSessionEntries(entries: SessionListEntry[]): SessionListEntry[];
export function sectionize(entries: SessionListEntry[]): SessionSectionGroup[]; // 空のセクションは含めない

/** 描画用の平らな行。セクション見出しも行として同じ親に並べ、useHeldOrder の対象にする。
 *  コンポーネントの SessionListRow と名前が同じなので、両方を使う側は別名で import する */
export type SessionListRow =
  | { kind: "section"; key: string; section: SessionSection; count: number } // key = `section:${section}`
  | { kind: "entry"; key: string; entry: SessionListEntry };                  // key = entry.key
export function toListRows(groups: SessionSectionGroup[]): SessionListRow[];
```

一覧の組み立ては PC サイドバーもモバイル一覧も次の1通りにし、Task 5 の `SessionSectionList` に集約する:

```ts
const rows = useMemo(
  () => toListRows(sectionize(sortSessionEntries(buildSessionEntries(groupedItems, sessionStatuses)))),
  [groupedItems, sessionStatuses]
);
const { held, bindings, onMenuOpenChange } = useListHold();
const shownRows = useHeldOrder(rows, row => row.key, held);
// shownRows を1つの親要素 ({...bindings} と data-session-list を付ける) の直下に key={row.key} で並べる。
// 行を押せる要素には data-session-key={entry.key}、見出しの要素には data-section={section} を付ける (Task 12 の撮影で使う)。
// 保留中は行の位置が前のまま残り、行の中身 (状態チップ) と見出しの件数だけが最新になる。
// 空になったセクションの見出しは保留中でも消え (行は見出し1つ分ずれる)、初めて出たセクションの見出しは末尾に足される。
// 直後に行が続かない見出しは描かない (Task 5)。
```

```ts
// packages/web/src/hooks/useHeldOrder.ts
export function applyHeldOrder<T>(previousKeys: readonly string[], items: readonly T[], getKey: (item: T) => string): T[];
export function useHeldOrder<T>(items: readonly T[], getKey: (item: T) => string, held: boolean): T[];

export interface ListHoldBindings {
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onFocusCapture: () => void;
  onBlurCapture: (e: React.FocusEvent<HTMLElement>) => void;
  onTouchStart: () => void;
  onTouchEnd: () => void;
  onTouchCancel: () => void;
}
export function useListHold(): {
  held: boolean;
  bindings: ListHoldBindings;
  onMenuOpenChange: (open: boolean) => void; // 行メニューの DropdownMenu / ContextMenu の onOpenChange に渡す
};
```

```ts
// packages/web/src/lib/chat-render-items.ts
import type { JsonlParsedEvent } from "./jsonl-event-parser";

export type { ToolCallEvent } from "./jsonl-event-parser"; // jsonl-event-parser.ts で Extract<JsonlParsedEvent, { kind: "tool-call" }> として定義済み
export type SidechainGroupedItem =
  | { kind: "event"; event: JsonlParsedEvent }
  | { kind: "sidechain"; id: string; events: JsonlParsedEvent[] };
export type ChatRenderItem =
  | SidechainGroupedItem
  | { kind: "tool-group"; id: string; calls: ToolCallEvent[]; latestRunning: ToolCallEvent | null };

export function groupSidechain(events: JsonlParsedEvent[]): SidechainGroupedItem[];
export function groupToolCalls(items: SidechainGroupedItem[]): ChatRenderItem[];
```

```ts
// packages/shared/src/types.ts に追加 (Task 4)。web も server も `import { TERMINAL_BG, TERMINAL_FG } from "@ark/shared"` で使う
export const TERMINAL_BG = "#1c1a17";
export const TERMINAL_FG = "#e6e1da";
```

```tsx
// packages/web/src/components/SegmentedControl.tsx (Task 7 で作り、Task 10 でも使う)
import type { LucideIcon } from "lucide-react";
export interface SegmentOption<V extends string> { value: V; label: string; icon: LucideIcon }
export function SegmentedControl<V extends string>(props: {
  options: readonly SegmentOption<V>[];
  value: V;
  onChange: (value: V) => void;
  label?: string;      // 画面に出ない <legend> (読み上げ用)
  className?: string;  // ルートの <fieldset> に付く。ボタンを幅いっぱいにするときは `[&_button]:flex-1` のように子孫へ効かせる
}): JSX.Element;
// 各ボタンは <button type="button" aria-label={label} aria-pressed={selected}>。選択側は bg-card + shadow-card のカプセル
```

```ts
// packages/web/src/components/TerminalPane.tsx (Task 7 で forwardRef 化する)
export interface TerminalPaneHandle {
  copyBuffer: () => void;     // tmux バッファをクリップボードへ
  pasteImage: () => void;     // クリップボードの画像を添付プレビューへ
  openFilePicker: () => void; // TerminalPane 内に残した <input type="file"> を click()
  reload: () => void;         // ttyd iframe を作り直す
  toggleInputBar: () => void; // 入力バーの表示切替
}
```

```ts
// SplitViewPane (Task 7) と MobileSessionView (Task 10) に足す props。名前と型をそろえる
repoName?: string;                 // 既存 (SplitViewPane)。Task 10 で MobileSessionView にも足す
displayName?: string | null;       // worktree のカスタム表示名。主ラベル = 表示名 ?? リポジトリ名
notificationsSupported?: boolean;
notificationsEnabled?: boolean;
onNotificationsEnabledChange?: (enabled: boolean) => void;

// MobileLayout (Task 6 が足す)
worktreeDisplayNames: Map<string, string>; // worktreePath → 表示名。Task 6 が必須で足すので、Task 10 は直接 `.get()` で読む
```

```ts
// packages/web/src/lib/floating-composer.ts (Task 9。Task 10 も使う)
export const FLOATING_BAR_BOTTOM = "max(12px, env(safe-area-inset-bottom))";
export function floatingBarReserve(stackHeightPx: number): string; // "calc(<ceil>px + FLOATING_BAR_BOTTOM + 12px)"
```

```ts
// packages/web/src/components/SplitChatPane.tsx の props の変更 (Task 9 で行い、Task 10 で使う)
interface SplitChatPaneProps {
  // …既存の props (socket, session, isActive, bridgeStatus, awaitingText, onSendMessage, onSendKey, onUploadFile) はそのまま
  // 削除: showTerminal / onToggleTerminal / onOpenBoard (どの呼び出し元も渡していない)
  /** "pane" = PC (入力欄は通常の配置)、"mobile" = 入力欄を浮かぶガラスバーにし、本文をその下に通す。既定は "pane" */
  layout?: "pane" | "mobile";
  /** layout="mobile" のとき、ガラスバーの上段 (入力欄の上) に置く要素。Task 10 のセグメントコントロール */
  composerAccessory?: React.ReactNode;
  /** 質問カード (AskUserQuestion) の表示有無が変わったときに呼ぶ。Task 10 の状態の帯が使う */
  onActiveAuqChange?: (hasActiveAuq: boolean) => void;
}
// SplitChatPane 自前のヘッダー行 (busy 表示・購読ドット・未使用のボード/ターミナルボタン) は削除する
```

### テーマの切り替え方 (設計書 8.6 節の実装方法)

OSのテーマ追従は、JSで `<html>` に `.dark` を付ける方式ではなく、**CSSのメディアクエリ**で行う (Task 1)。

- `index.css` で `@custom-variant dark (@media (prefers-color-scheme: dark));` とし、ダークのトークンは
  `@media (prefers-color-scheme: dark) { :root { … } }` に書く
- そのため `.dark` クラスはどこにも付かない。**`.dark …` というセレクタを書かない**。Tailwind の `dark:` は使ってよい
- `ThemeProvider` / `ThemeContext.tsx` は削除する (`useTheme` の利用者はいない)。Sonner は `theme="system"`
- 初回表示のちらつきが無く、実行中のOSの切り替えにも追従する。Playwright では `page.emulateMedia({ colorScheme })` で切り替えられる

Tailwind のクラス名 (Task 1 で `@theme inline` に定義):
`text-status-busy` / `bg-status-busy/15` (`busy` `idle` `awaiting` `error` `neutral` の5色)、`shadow-card` (CSS変数は `--elevation-card`)、
角丸は `rounded-xl` (16px, ペイン) / `rounded-lg` (12px, カード) / `rounded-md` (10px) / `rounded-sm` (8px, ボタン)。
ガラスは `.glass-bar` クラス (Task 1)。作業中の3点は `.status-dots` クラス (Task 1)。

## タスクの順序

| # | タスク | 依存 |
|---|---|---|
| 1 | トークン・テーマ追従・不要CSSの撤去 | なし |
| 2 | 状態の表示ロジックと状態チップ | 1 |
| 3 | 並べ方と並び替えの保留 | 2 |
| 4 | 端末の色とPCの既定モード | 1 |
| 5 | PCサイドバー | 2, 3 |
| 6 | モバイル一覧と下部タブ | 5 |
| 7 | PC上部バーの統合と端末の額縁 | 2, 4 |
| 8 | 会話: ツール行の折りたたみ | 1 |
| 9 | 会話: 吹き出し・質問カード・入力欄 | 2, 8 |
| 10 | モバイル会話: ヘッダー・状態の帯・下部バー | 2, 7, 9 |
| 11 | 残りの画面の色とアイコン | 1 |
| 12 | 撮影による確認とプレビュー | すべて |

---

### Task 1: トークン・テーマ追従・不要CSSの撤去

**Files:**
- Create: `packages/web/src/index-css.test.ts`
- Modify: `packages/web/src/index.css` (全体を置き換え)
- Modify: `packages/web/index.html`
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/components/ui/sonner.tsx`
- Delete: `packages/web/src/contexts/ThemeContext.tsx`

**Interfaces:**
- Consumes: なし
- Produces:
  - CSS変数 `--status-busy` `--status-idle` `--status-awaiting` `--status-error` `--status-neutral` `--elevation-card` `--glass` (ライトとダークの両方)
  - Tailwind のクラス `text-status-*` `bg-status-*` `border-status-*` (`*` = `busy` `idle` `awaiting` `error` `neutral`)、`shadow-card`、`font-sans` `font-mono`
  - `@custom-variant dark` はメディアクエリ。`.dark` クラスは使わない
  - コンポーネント用クラス `.glass-bar` (浮かぶガラスバー) と `.status-dots` (作業中の3点)

- [ ] **Step 0: 依存を入れる (初回だけ)**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper && pnpm install --frozen-lockfile`
Expected: 最後に `Done in …` が出て、エラーが無い

- [ ] **Step 1: CSSのテストを書く**

`packages/web/src/index-css.test.ts`:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  path.resolve(import.meta.dirname, "index.css"),
  "utf8"
);

/** `start` の直後の `{` から対応する `}` までの中身を返す */
function blockAfter(source: string, start: string): string {
  const at = source.indexOf(start);
  if (at < 0) throw new Error(`見つからない: ${start}`);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`閉じ括弧が無い: ${start}`);
}

function tokenNames(block: string): string[] {
  return [...block.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)]
    .map(m => m[1])
    .sort();
}

describe("index.css のトークン", () => {
  const light = blockAfter(css, ":root");
  // `@custom-variant dark (@media (prefers-color-scheme: dark));` と取り違えないよう、波括弧まで含めて探す
  const dark = blockAfter(
    blockAfter(css, "@media (prefers-color-scheme: dark) {"),
    ":root"
  );

  it("ダークはOSの設定のメディアクエリで切り替える", () => {
    expect(css).toContain(
      "@custom-variant dark (@media (prefers-color-scheme: dark));"
    );
    expect(css).not.toMatch(/(^|\s)\.dark\s*[{.,]/m);
  });

  it("ライトとダークで同じ名前のトークンを定義している", () => {
    expect(tokenNames(dark)).toEqual(tokenNames(light));
  });

  it("状態色・影・ガラスのトークンがある", () => {
    for (const name of [
      "--status-busy",
      "--status-idle",
      "--status-awaiting",
      "--status-error",
      "--status-neutral",
      "--elevation-card",
      "--glass",
    ]) {
      expect(tokenNames(light)).toContain(name);
    }
    expect(css).toContain("--color-status-awaiting: var(--status-awaiting);");
    expect(css).toContain("--shadow-card: var(--elevation-card);");
  });

  it("ターミナル風の装飾クラスを撤去している", () => {
    for (const removed of [
      "terminal-prompt",
      "--color-terminal-",
      "status-indicator",
      "pulse-glow",
      "glow-green",
      "glow-cyan",
      "pet-bounce",
      "heart-float",
      "level-up-flash",
      "--chart-",
    ]) {
      expect(css).not.toContain(removed);
    }
  });

  it("本文のフォントはトークン経由で指定する", () => {
    expect(css).not.toContain("font-family: Inter");
    expect(css).toContain("-apple-system");
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `pnpm vitest run packages/web/src/index-css.test.ts`
Expected: FAIL (`@custom-variant dark (@media …` が無い、`.dark {` がある、等)

- [ ] **Step 3: `index.css` を置き換える**

`packages/web/src/index.css` の全体を次にする。`.md-prose` の節は、`.dark .md-prose …` を
メディアクエリに書き換えた以外は今のまま (トークン化は Task 9)。

```css
@import "tailwindcss";
@import "tw-animate-css";
@plugin "@tailwindcss/typography";

@custom-variant dark (@media (prefers-color-scheme: dark));

@theme inline {
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);

  /* セッションの状態色 (status-tone.ts の TONE_CLASSES が使う) */
  --color-status-busy: var(--status-busy);
  --color-status-idle: var(--status-idle);
  --color-status-awaiting: var(--status-awaiting);
  --color-status-error: var(--status-error);
  --color-status-neutral: var(--status-neutral);

  --shadow-card: var(--elevation-card);

  --font-sans:
    -apple-system, BlinkMacSystemFont, "Inter", "Hiragino Sans",
    "Hiragino Kaku Gothic ProN", "Noto Sans JP", system-ui, sans-serif;
  --font-mono:
    ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
}

:root {
  color-scheme: light dark;
  --radius: 0.75rem;

  --background: oklch(0.985 0.005 80);
  --foreground: oklch(0.24 0.02 60);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.24 0.02 60);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.24 0.02 60);
  --primary: oklch(0.5 0.16 262);
  --primary-foreground: oklch(0.99 0 0);
  --secondary: oklch(0.955 0.008 80);
  --secondary-foreground: oklch(0.24 0.02 60);
  --muted: oklch(0.955 0.008 80);
  --muted-foreground: oklch(0.48 0.02 60);
  --accent: oklch(0.94 0.01 80);
  --accent-foreground: oklch(0.24 0.02 60);
  --destructive: oklch(0.55 0.2 25);
  --destructive-foreground: oklch(0.99 0 0);
  --border: oklch(0.9 0.01 80);
  --input: oklch(0.9 0.01 80);
  --ring: oklch(0.5 0.16 262);
  --sidebar: oklch(0.985 0.005 80);
  --sidebar-foreground: oklch(0.24 0.02 60);
  --sidebar-primary: oklch(0.5 0.16 262);
  --sidebar-primary-foreground: oklch(0.99 0 0);
  --sidebar-accent: oklch(0.955 0.008 80);
  --sidebar-accent-foreground: oklch(0.24 0.02 60);
  --sidebar-border: oklch(0.9 0.01 80);
  --sidebar-ring: oklch(0.5 0.16 262);

  --status-busy: oklch(0.52 0.14 240);
  --status-idle: oklch(0.55 0.15 150);
  --status-awaiting: oklch(0.56 0.15 70);
  --status-error: oklch(0.55 0.2 25);
  --status-neutral: oklch(0.55 0.015 60);

  --elevation-card:
    0 1px 2px oklch(0 0 0 / 0.06), 0 4px 12px oklch(0 0 0 / 0.05);
  --glass: oklch(1 0 0 / 0.72);
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: light dark;
    --radius: 0.75rem;

    --background: oklch(0.19 0.01 60);
    --foreground: oklch(0.93 0.01 80);
    --card: oklch(0.23 0.01 60);
    --card-foreground: oklch(0.93 0.01 80);
    --popover: oklch(0.23 0.01 60);
    --popover-foreground: oklch(0.93 0.01 80);
    --primary: oklch(0.74 0.13 262);
    --primary-foreground: oklch(0.18 0.03 262);
    --secondary: oklch(0.27 0.01 60);
    --secondary-foreground: oklch(0.93 0.01 80);
    --muted: oklch(0.27 0.01 60);
    --muted-foreground: oklch(0.72 0.015 80);
    --accent: oklch(0.29 0.01 60);
    --accent-foreground: oklch(0.93 0.01 80);
    --destructive: oklch(0.74 0.16 25);
    --destructive-foreground: oklch(0.18 0.03 25);
    --border: oklch(0.3 0.01 60);
    --input: oklch(0.3 0.01 60);
    --ring: oklch(0.74 0.13 262);
    --sidebar: oklch(0.19 0.01 60);
    --sidebar-foreground: oklch(0.93 0.01 80);
    --sidebar-primary: oklch(0.74 0.13 262);
    --sidebar-primary-foreground: oklch(0.18 0.03 262);
    --sidebar-accent: oklch(0.27 0.01 60);
    --sidebar-accent-foreground: oklch(0.93 0.01 80);
    --sidebar-border: oklch(0.3 0.01 60);
    --sidebar-ring: oklch(0.74 0.13 262);

    --status-busy: oklch(0.76 0.12 240);
    --status-idle: oklch(0.78 0.13 150);
    --status-awaiting: oklch(0.82 0.14 75);
    --status-error: oklch(0.74 0.16 25);
    --status-neutral: oklch(0.65 0.015 60);

    --elevation-card: 0 1px 2px oklch(0 0 0 / 0.3);
    --glass: oklch(0.23 0.01 60 / 0.72);
  }
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  html,
  body {
    @apply bg-background text-foreground font-sans antialiased;

    height: 100dvh;
    overflow: hidden;
    overscroll-behavior: none;
  }
  #root {
    height: 100%;
    overflow: hidden;
  }
  button:not(:disabled),
  [role="button"]:not([aria-disabled="true"]),
  [type="button"]:not(:disabled),
  [type="submit"]:not(:disabled),
  [type="reset"]:not(:disabled),
  a[href],
  select:not(:disabled),
  input[type="checkbox"]:not(:disabled),
  input[type="radio"]:not(:disabled) {
    @apply cursor-pointer;
  }

  code,
  pre,
  .font-mono {
    font-family: var(--font-mono);
  }
}

@layer components {
  .flex {
    min-height: 0;
    min-width: 0;
  }

  /* 浮かぶガラスバー。操作とナビゲーションの層だけに使う (設計書 6 節) */
  .glass-bar {
    background: var(--glass);
    -webkit-backdrop-filter: blur(18px) saturate(170%);
    backdrop-filter: blur(18px) saturate(170%);
    border: 1px solid var(--border);
    box-shadow: var(--elevation-card);
  }
  @supports not (
    (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))
  ) {
    .glass-bar {
      background: var(--card);
    }
  }
  @media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
    .glass-bar {
      background: var(--card);
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }
  }

  /* 作業中の3点。opacity だけで呼吸させる */
  .status-dots {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }
  .status-dots > span {
    width: 3px;
    height: 3px;
    border-radius: 9999px;
    background: currentColor;
    animation: status-breathe 1.2s ease-in-out infinite;
  }
  .status-dots > span:nth-child(2) {
    animation-delay: 0.2s;
  }
  .status-dots > span:nth-child(3) {
    animation-delay: 0.4s;
  }
  @keyframes status-breathe {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .status-dots > span {
      animation: none;
      opacity: 1;
    }
  }
}

@layer utilities {
  /* Safe Area utilities */
  .safe-area-top {
    padding-top: env(safe-area-inset-top);
  }
  .safe-area-bottom {
    padding-bottom: max(env(safe-area-inset-bottom), 1rem);
  }
  .safe-area-x {
    padding-left: env(safe-area-inset-left);
    padding-right: env(safe-area-inset-right);
  }
}
```

続けて、今の `index.css` の `/* ===== JSONL assistant text 用 markdown プロース =====` から末尾までを
そのまま貼り、その中の次の2か所だけ書き換える。

変更前:

```css
.dark .md-prose pre {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.08);
}
```

変更後:

```css
@media (prefers-color-scheme: dark) {
  .md-prose pre {
    background: rgba(255, 255, 255, 0.04);
    border-color: rgba(255, 255, 255, 0.08);
  }
}
```

変更前:

```css
.dark .md-prose a {
  color: #60a5fa;
}
```

変更後:

```css
@media (prefers-color-scheme: dark) {
  .md-prose a {
    color: #60a5fa;
  }
}
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `pnpm vitest run packages/web/src/index-css.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: ThemeProvider を外し、Toaster をトークンに従わせる**

`packages/web/src/App.tsx` の `import { ThemeProvider } from "./contexts/ThemeContext";` の行を削除し、
`function App()` を次にする。

```tsx
function App() {
  return (
    <ErrorBoundary>
      <TooltipProvider>
        <Toaster position="bottom-right" />
        <Router />
      </TooltipProvider>
    </ErrorBoundary>
  );
}
```

`packages/web/src/components/ui/sonner.tsx` の全体を次にする (next-themes の Provider はどこにも無く、
既定で `system` になっていた。それを明示する)。

```tsx
import { Toaster as Sonner, type ToasterProps } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="system"
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
```

Run: `git rm packages/web/src/contexts/ThemeContext.tsx`

- [ ] **Step 6: ブラウザのUIの色をテーマに合わせる**

`packages/web/index.html` の `<title>Ark</title>` の直前に次を足す。

```html
    <meta name="color-scheme" content="light dark" />
    <meta
      name="theme-color"
      content="#fcfaf6"
      media="(prefers-color-scheme: light)"
    />
    <meta
      name="theme-color"
      content="#17130f"
      media="(prefers-color-scheme: dark)"
    />
```

- [ ] **Step 7: 整形して型とlintを通す**

Run: `pnpm biome check --write packages/web/src/index.css packages/web/src/index-css.test.ts packages/web/src/App.tsx packages/web/src/components/ui/sonner.tsx && pnpm check && pnpm vitest run packages/web/src/index-css.test.ts`
Expected: エラー無しで終わる。`ThemeContext` を import している箇所が残っていたら `grep -rn "ThemeContext" packages/web/src` で探して消す

- [ ] **Step 8: コミット**

```bash
git branch --show-current   # feat/visual-redesign-paper であること
git add packages/web/src/index.css packages/web/src/index-css.test.ts packages/web/index.html packages/web/src/App.tsx packages/web/src/components/ui/sonner.tsx   # ThemeContext.tsx の削除は Step 5 の git rm でステージ済み
git commit -m "feat(web): 紙のトークンとOSのテーマ追従に切り替える

ダーク固定の :root/.dark をライトとダークのトークンに分け、ダークは
prefers-color-scheme のメディアクエリで切り替える。状態色・影・ガラスの
トークンを足し、使われていないターミナル風の装飾クラスを撤去した。"
```

---

### Task 2: 状態の表示ロジックと状態チップ

**Files:**
- Create: `packages/web/src/lib/status-tone.ts`
- Create: `packages/web/src/lib/status-tone.test.ts`
- Create: `packages/web/src/components/StatusChip.tsx`
- Create: `packages/web/src/components/StatusChip.test.tsx`

**Interfaces:**
- Consumes: Task 1 のクラス `text-status-*` `bg-status-*` `.status-dots`
- Produces: 「部品の受け渡し」の `status-tone.ts` と `StatusChip` のすべて

- [ ] **Step 1: 状態の対応表のテストを書く**

`packages/web/src/lib/status-tone.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  presentStatus,
  resolveStatusKey,
  resolveStatusStrip,
  SECTION_LABELS,
  SECTION_ORDER,
  type StatusKey,
} from "./status-tone";

describe("resolveStatusKey", () => {
  it("セッションが無ければ未起動", () => {
    expect(resolveStatusKey(false, undefined)).toBe("NOT_STARTED");
    expect(resolveStatusKey(false, "IDLE")).toBe("NOT_STARTED");
  });
  it("セッションがあって状態が未着なら UNKNOWN", () => {
    expect(resolveStatusKey(true, undefined)).toBe("UNKNOWN");
  });
  it("セッションがあれば BridgeSessionStatus をそのまま使う", () => {
    expect(resolveStatusKey(true, "AWAITING")).toBe("AWAITING");
  });
});

describe("presentStatus", () => {
  const cases: [StatusKey, string, string, string, number][] = [
    ["AWAITING", "awaiting", "確認待ち", "your-turn", 1],
    ["ERR", "error", "問題", "your-turn", 2],
    ["IDLE", "idle", "入力待ち", "your-turn", 3],
    ["TOOL", "busy", "作業中", "working", 4],
    ["THINK", "busy", "作業中", "working", 4],
    ["READY", "neutral", "待機", "resting", 5],
    ["STOP", "neutral", "停止", "resting", 6],
    ["NOT_STARTED", "neutral", "未起動", "resting", 7],
    ["UNKNOWN", "neutral", "", "resting", 8],
  ];
  it.each(cases)("%s → %s / %s / %s / %i", (key, tone, label, section, priority) => {
    const p = presentStatus(key);
    expect(p.tone).toBe(tone);
    expect(p.label).toBe(label);
    expect(p.section).toBe(section);
    expect(p.priority).toBe(priority);
  });
  it("未起動だけ枠線のチップにする", () => {
    expect(presentStatus("NOT_STARTED").outlined).toBe(true);
    expect(presentStatus("IDLE").outlined).toBe(false);
  });
  it("入力待ちは成功を意味するチェックの形を使わない", () => {
    expect(presentStatus("IDLE").icon).toBe("message");
  });
});

describe("セクション", () => {
  it("あなたの番 → 作業中 → 休止中 の順", () => {
    expect(SECTION_ORDER).toEqual(["your-turn", "working", "resting"]);
    expect(SECTION_ORDER.map(s => SECTION_LABELS[s])).toEqual([
      "あなたの番",
      "作業中",
      "休止中",
    ]);
  });
});

describe("resolveStatusStrip", () => {
  const base = {
    bridgeStatus: undefined,
    hasActiveAuq: false,
    isConnected: true,
    viewMode: "chat" as const,
  };
  it("切断中はほかの状態より優先する", () => {
    expect(
      resolveStatusStrip({ ...base, bridgeStatus: "AWAITING", isConnected: false })
    ).toEqual({ tone: "error", text: "サーバーとつながっていません", offerChat: false });
  });
  it("質問カードがあれば「質問があります」", () => {
    expect(
      resolveStatusStrip({ ...base, bridgeStatus: "AWAITING", hasActiveAuq: true })
    ).toEqual({ tone: "awaiting", text: "質問があります", offerChat: false });
  });
  it("質問カードが無ければ「確認を求めています」", () => {
    expect(resolveStatusStrip({ ...base, bridgeStatus: "AWAITING" })).toEqual({
      tone: "awaiting",
      text: "確認を求めています",
      offerChat: false,
    });
  });
  it("会話以外のモードでは会話へ戻るボタンを出す", () => {
    expect(
      resolveStatusStrip({ ...base, bridgeStatus: "AWAITING", viewMode: "terminal" })
        ?.offerChat
    ).toBe(true);
    expect(
      resolveStatusStrip({ ...base, bridgeStatus: "AWAITING", viewMode: "board" })
        ?.offerChat
    ).toBe(true);
  });
  it("作業中とエラーの文言", () => {
    expect(resolveStatusStrip({ ...base, bridgeStatus: "THINK" })?.text).toBe("考えています");
    expect(resolveStatusStrip({ ...base, bridgeStatus: "TOOL" })?.text).toBe("作業しています");
    expect(resolveStatusStrip({ ...base, bridgeStatus: "ERR" })?.text).toBe("問題が起きています");
  });
  it("入力待ち・待機・停止・未着では出さない", () => {
    for (const bridgeStatus of ["IDLE", "READY", "STOP", undefined] as const) {
      expect(resolveStatusStrip({ ...base, bridgeStatus })).toBeNull();
    }
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `pnpm vitest run packages/web/src/lib/status-tone.test.ts`
Expected: FAIL (`Failed to resolve import "./status-tone"`)

- [ ] **Step 3: `status-tone.ts` を書く**

`packages/web/src/lib/status-tone.ts`:

```ts
/**
 * セッションの状態の表示を 1 か所に集約する (設計書 7 節)。
 *
 * PCサイドバー・モバイル一覧・PC上部バー・モバイルヘッダー・RepoGridView が
 * すべてここを通す。状態は BridgeSessionStatus だけから決め、端末の画面テキストは
 * 解釈しない (情報源分離の原則)。
 */

import type { BridgeSessionStatus } from "@ark/shared";
import type { MobileSessionViewMode } from "./mobile-session-view-mode";

export type StatusKey = BridgeSessionStatus | "NOT_STARTED" | "UNKNOWN";
export type StatusTone = "awaiting" | "error" | "idle" | "busy" | "neutral";
export type StatusIcon =
  | "question"
  | "alert"
  | "message"
  | "dots"
  | "minus"
  | "stop"
  | "play";
export type SessionSection = "your-turn" | "working" | "resting";

export interface StatusPresentation {
  tone: StatusTone;
  label: string;
  icon: StatusIcon;
  section: SessionSection;
  priority: number;
  outlined: boolean;
}

const PRESENTATIONS: Readonly<Record<StatusKey, StatusPresentation>> = {
  // AWAITING は質問カードと許可プロンプトの両方を含むので「質問」ではなく「確認待ち」
  AWAITING: {
    tone: "awaiting",
    label: "確認待ち",
    icon: "question",
    section: "your-turn",
    priority: 1,
    outlined: false,
  },
  ERR: {
    tone: "error",
    label: "問題",
    icon: "alert",
    section: "your-turn",
    priority: 2,
    outlined: false,
  },
  // IDLE は「出力があり入力を待っている」だけで、成功を意味しない
  IDLE: {
    tone: "idle",
    label: "入力待ち",
    icon: "message",
    section: "your-turn",
    priority: 3,
    outlined: false,
  },
  TOOL: {
    tone: "busy",
    label: "作業中",
    icon: "dots",
    section: "working",
    priority: 4,
    outlined: false,
  },
  THINK: {
    tone: "busy",
    label: "作業中",
    icon: "dots",
    section: "working",
    priority: 4,
    outlined: false,
  },
  READY: {
    tone: "neutral",
    label: "待機",
    icon: "minus",
    section: "resting",
    priority: 5,
    outlined: false,
  },
  STOP: {
    tone: "neutral",
    label: "停止",
    icon: "stop",
    section: "resting",
    priority: 6,
    outlined: false,
  },
  NOT_STARTED: {
    tone: "neutral",
    label: "未起動",
    icon: "play",
    section: "resting",
    priority: 7,
    outlined: true,
  },
  UNKNOWN: {
    tone: "neutral",
    label: "",
    icon: "minus",
    section: "resting",
    priority: 8,
    outlined: false,
  },
};

export function resolveStatusKey(
  hasSession: boolean,
  bridgeStatus: BridgeSessionStatus | undefined
): StatusKey {
  if (!hasSession) return "NOT_STARTED";
  return bridgeStatus ?? "UNKNOWN";
}

export function presentStatus(key: StatusKey): StatusPresentation {
  return PRESENTATIONS[key];
}

export const SECTION_ORDER: readonly SessionSection[] = [
  "your-turn",
  "working",
  "resting",
];

export const SECTION_LABELS: Readonly<Record<SessionSection, string>> = {
  "your-turn": "あなたの番",
  working: "作業中",
  resting: "休止中",
};

/**
 * トーンごとの Tailwind クラス。Tailwind がクラス名を静的に拾えるよう、
 * 文字列を組み立てずに全部書く
 */
export const TONE_CLASSES: Readonly<
  Record<StatusTone, { text: string; softBg: string; solidBg: string }>
> = {
  awaiting: {
    text: "text-status-awaiting",
    softBg: "bg-status-awaiting/15",
    solidBg: "bg-status-awaiting",
  },
  error: {
    text: "text-status-error",
    softBg: "bg-status-error/15",
    solidBg: "bg-status-error",
  },
  idle: {
    text: "text-status-idle",
    softBg: "bg-status-idle/15",
    solidBg: "bg-status-idle",
  },
  busy: {
    text: "text-status-busy",
    softBg: "bg-status-busy/15",
    solidBg: "bg-status-busy",
  },
  neutral: {
    text: "text-status-neutral",
    softBg: "bg-status-neutral/15",
    solidBg: "bg-status-neutral",
  },
};

export interface StatusStrip {
  tone: StatusTone;
  text: string;
  /** 会話以外のモードで「会話で答える」ボタンを出すか */
  offerChat: boolean;
}

/** モバイル会話画面のヘッダー直下の帯 (設計書 8.5 節) */
export function resolveStatusStrip(input: {
  bridgeStatus: BridgeSessionStatus | undefined;
  hasActiveAuq: boolean;
  isConnected: boolean;
  viewMode: MobileSessionViewMode;
}): StatusStrip | null {
  if (!input.isConnected) {
    return {
      tone: "error",
      text: "サーバーとつながっていません",
      offerChat: false,
    };
  }
  switch (input.bridgeStatus) {
    case "AWAITING":
      return {
        tone: "awaiting",
        text: input.hasActiveAuq ? "質問があります" : "確認を求めています",
        offerChat: input.viewMode !== "chat",
      };
    case "THINK":
      return { tone: "busy", text: "考えています", offerChat: false };
    case "TOOL":
      return { tone: "busy", text: "作業しています", offerChat: false };
    case "ERR":
      return { tone: "error", text: "問題が起きています", offerChat: false };
    default:
      return null;
  }
}
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `pnpm vitest run packages/web/src/lib/status-tone.test.ts`
Expected: PASS

- [ ] **Step 5: 状態チップのテストを書く**

`packages/web/src/components/StatusChip.test.tsx`:

```tsx
// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StatusKey } from "../lib/status-tone";
import { StatusChip } from "./StatusChip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(statusKey: StatusKey) {
  act(() => root.render(<StatusChip statusKey={statusKey} />));
  return container.querySelector(`[data-status="${statusKey}"]`) as HTMLElement;
}

describe("StatusChip", () => {
  it("文言とアイコンを出す", () => {
    const chip = render("AWAITING");
    expect(chip.textContent).toBe("確認待ち");
    expect(chip.querySelector("svg")).not.toBeNull();
    expect(chip.className).toContain("text-status-awaiting");
    expect(chip.className).toContain("bg-status-awaiting/15");
  });

  it("作業中は呼吸する3点を出す", () => {
    const chip = render("TOOL");
    expect(chip.textContent).toBe("作業中");
    expect(chip.querySelectorAll(".status-dots > span")).toHaveLength(3);
  });

  it("未起動は枠線のチップ", () => {
    const chip = render("NOT_STARTED");
    expect(chip.textContent).toBe("未起動");
    expect(chip.className).toContain("border");
    expect(chip.className).not.toContain("bg-status-neutral/15");
  });

  it("状態が未着なら文言なしの小さな印だけを出し、読み上げない", () => {
    const chip = render("UNKNOWN");
    expect(chip.textContent).toBe("");
    expect(chip.getAttribute("aria-hidden")).toBe("true");
  });
});
```

- [ ] **Step 6: テストが落ちることを確かめる**

Run: `pnpm vitest run packages/web/src/components/StatusChip.test.tsx`
Expected: FAIL (`Failed to resolve import "./StatusChip"`)

- [ ] **Step 7: `StatusChip.tsx` を書く**

`packages/web/src/components/StatusChip.tsx`:

```tsx
import {
  CircleAlert,
  CircleHelp,
  CircleMinus,
  MessageSquare,
  Minus,
  Play,
} from "lucide-react";
import {
  presentStatus,
  type StatusIcon,
  type StatusKey,
  TONE_CLASSES,
} from "@/lib/status-tone";
import { cn } from "@/lib/utils";

interface StatusChipProps {
  statusKey: StatusKey;
  className?: string;
}

/** セッションの状態を「アイコン + 文言」のチップで出す。色だけに頼らない */
export function StatusChip({ statusKey, className }: StatusChipProps) {
  const p = presentStatus(statusKey);

  if (p.label === "") {
    return (
      <span
        data-status={statusKey}
        aria-hidden="true"
        className={cn(
          "inline-block size-2 shrink-0 rounded-full bg-status-neutral/40",
          className
        )}
      />
    );
  }

  const tone = TONE_CLASSES[p.tone];
  return (
    <span
      data-status={statusKey}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-[12px] font-semibold leading-none",
        p.outlined
          ? "border border-border text-muted-foreground"
          : [tone.softBg, tone.text],
        className
      )}
    >
      <StatusGlyph icon={p.icon} />
      <span>{p.label}</span>
    </span>
  );
}

function StatusGlyph({ icon }: { icon: StatusIcon }) {
  const svg = "size-3 shrink-0";
  switch (icon) {
    case "dots":
      return (
        <span className="status-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      );
    case "question":
      return <CircleHelp className={svg} aria-hidden="true" />;
    case "alert":
      return <CircleAlert className={svg} aria-hidden="true" />;
    case "message":
      return <MessageSquare className={svg} aria-hidden="true" />;
    case "minus":
      return <Minus className={svg} aria-hidden="true" />;
    case "stop":
      return <CircleMinus className={svg} aria-hidden="true" />;
    case "play":
      return <Play className={svg} aria-hidden="true" />;
  }
}
```

- [ ] **Step 8: テストが通ることを確かめる**

Run: `pnpm vitest run packages/web/src/components/StatusChip.test.tsx packages/web/src/lib/status-tone.test.ts`
Expected: PASS

- [ ] **Step 9: 整形して型とlintを通し、コミット**

Run: `pnpm biome check --write packages/web/src/lib/status-tone.ts packages/web/src/lib/status-tone.test.ts packages/web/src/components/StatusChip.tsx packages/web/src/components/StatusChip.test.tsx && pnpm check`
Expected: エラー無し

```bash
git branch --show-current
git add packages/web/src/lib/status-tone.ts packages/web/src/lib/status-tone.test.ts packages/web/src/components/StatusChip.tsx packages/web/src/components/StatusChip.test.tsx
git commit -m "feat(web): セッションの状態の表示を1か所に集約する

BridgeSessionStatus と未起動・未着を、トーン・文言・アイコン・セクション・
優先度に対応づける status-tone と、アイコン + 文言の StatusChip を足す。
IDLE は成功を意味しないので「入力待ち」、AWAITING は「確認待ち」とした。"
```

---

### Task 3: 並べ方と並び替えの保留

**Files:**
- Create: `packages/web/src/lib/session-sections.ts`
- Create: `packages/web/src/lib/session-sections.test.ts`
- Create: `packages/web/src/hooks/useHeldOrder.ts`
- Create: `packages/web/src/hooks/useHeldOrder.test.tsx`

**Interfaces:**
- Consumes: Task 2 の `StatusKey` `resolveStatusKey` `presentStatus` `SECTION_ORDER` `SessionSection`、
  既存の `RepoGroup` (`packages/web/src/hooks/useGroupedWorktreeItems.ts`)
- Produces: 「部品の受け渡し」の `session-sections.ts` (`toListRows` と型 `SessionListRow` を含む) と `useHeldOrder.ts` のすべて

- [ ] **Step 1: 並べ方のテストを書く**

`packages/web/src/lib/session-sections.test.ts`:

```ts
import type { BridgeSessionStatus, ManagedSession, Worktree } from "@ark/shared";
import { describe, expect, it } from "vitest";
import type { RepoGroup } from "@/hooks/useGroupedWorktreeItems";
import {
  buildSessionEntries,
  sectionize,
  sortSessionEntries,
  toListRows,
} from "./session-sections";

function worktree(id: string, path: string): Worktree {
  return { id, path, branch: "main", isMain: false } as Worktree;
}

function session(id: string, worktreeId: string, worktreePath: string): ManagedSession {
  return { id, worktreeId, worktreePath } as ManagedSession;
}

function group(repoName: string, items: RepoGroup["items"], disambiguator: string | null = null): RepoGroup {
  return { repoName, disambiguator, items };
}

describe("buildSessionEntries", () => {
  it("行ごとに key・リポジトリ・状態を持たせる", () => {
    const groups = new Map<string, RepoGroup>([
      [
        "/r/app",
        group("app", [
          { worktree: worktree("w1", "/r/app"), session: session("s1", "w1", "/r/app") },
          { worktree: worktree("w2", "/r/app-x"), session: null },
          { worktree: null, session: session("s3", "gone", "/r/app-old") },
        ], "r"),
      ],
    ]);
    const statuses = new Map<string, BridgeSessionStatus>([["s1", "IDLE"]]);
    const entries = buildSessionEntries(groups, statuses);
    expect(entries.map(e => [e.key, e.repoPath, e.repoName, e.disambiguator, e.statusKey])).toEqual([
      ["wt:w1", "/r/app", "app", "r", "IDLE"],
      ["wt:w2", "/r/app", "app", "r", "NOT_STARTED"],
      ["s:s3", "/r/app", "app", "r", "UNKNOWN"],
    ]);
  });
});

describe("sortSessionEntries", () => {
  const groups = new Map<string, RepoGroup>([
    [
      "/b/zeta",
      group("zeta", [
        { worktree: worktree("z1", "/b/zeta"), session: session("sz1", "z1", "/b/zeta") },
      ]),
    ],
    [
      "/a/alpha",
      group("alpha", [
        { worktree: worktree("a2", "/a/alpha-2"), session: session("sa2", "a2", "/a/alpha-2") },
        { worktree: worktree("a1", "/a/alpha"), session: session("sa1", "a1", "/a/alpha") },
        { worktree: null, session: session("sa9", "x", "/a/alpha-0") },
      ]),
    ],
  ]);

  it("セクション → 状態の優先度 → リポジトリ名 → パスの順に並べる", () => {
    const statuses = new Map<string, BridgeSessionStatus>([
      ["sz1", "AWAITING"],
      ["sa1", "IDLE"],
      ["sa2", "IDLE"],
      ["sa9", "IDLE"],
    ]);
    const sorted = sortSessionEntries(buildSessionEntries(groups, statuses));
    expect(sorted.map(e => e.key)).toEqual([
      "wt:z1", // 確認待ちが入力待ちより先 (リポジトリ名より優先度が先)
      "wt:a1", // 同じ優先度ならリポジトリ名 → worktreeのパス
      "wt:a2",
      "s:sa9", // worktreeの無いセッションは後ろ
    ]);
  });

  it("作業中と休止中は、あなたの番の後ろ", () => {
    const statuses = new Map<string, BridgeSessionStatus>([
      ["sz1", "STOP"],
      ["sa1", "TOOL"],
      ["sa2", "ERR"],
    ]);
    const sorted = sortSessionEntries(buildSessionEntries(groups, statuses));
    expect(sorted.map(e => [e.key, e.statusKey])).toEqual([
      ["wt:a2", "ERR"],
      ["wt:a1", "TOOL"],
      ["wt:z1", "STOP"],
      ["s:sa9", "UNKNOWN"],
    ]);
  });

  it("元の配列を書き換えない", () => {
    const entries = buildSessionEntries(groups, new Map());
    const before = entries.map(e => e.key);
    sortSessionEntries(entries);
    expect(entries.map(e => e.key)).toEqual(before);
  });
});

describe("sectionize と toListRows", () => {
  it("空のセクションは出さず、見出しの行に件数を持たせる", () => {
    const groups = new Map<string, RepoGroup>([
      [
        "/a/alpha",
        group("alpha", [
          { worktree: worktree("a1", "/a/alpha"), session: session("sa1", "a1", "/a/alpha") },
          { worktree: worktree("a2", "/a/alpha-2"), session: session("sa2", "a2", "/a/alpha-2") },
        ]),
      ],
    ]);
    const statuses = new Map<string, BridgeSessionStatus>([
      ["sa1", "IDLE"],
      ["sa2", "AWAITING"],
    ]);
    const sections = sectionize(sortSessionEntries(buildSessionEntries(groups, statuses)));
    expect(sections.map(s => [s.section, s.entries.length])).toEqual([["your-turn", 2]]);

    const rows = toListRows(sections);
    expect(rows.map(r => r.key)).toEqual(["section:your-turn", "wt:a2", "wt:a1"]);
    expect(rows[0]).toEqual({ kind: "section", key: "section:your-turn", section: "your-turn", count: 2 });
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `pnpm vitest run packages/web/src/lib/session-sections.test.ts`
Expected: FAIL (`Failed to resolve import "./session-sections"`)

- [ ] **Step 3: `session-sections.ts` を書く**

`packages/web/src/lib/session-sections.ts`:

```ts
/**
 * PCサイドバーとモバイル一覧の並べ方 (設計書 7 節)。
 *
 * リポジトリ順ではなく注意の順に並べる。比較キーは
 * セクション → 状態の優先度 → リポジトリ名 → リポジトリの絶対パス → worktreeのパス
 * (worktreeの無いセッションは後ろ)。
 */

import type { BridgeSessionStatus, ManagedSession, Worktree } from "@ark/shared";
import type { RepoGroup } from "@/hooks/useGroupedWorktreeItems";
import {
  presentStatus,
  resolveStatusKey,
  SECTION_ORDER,
  type SessionSection,
  type StatusKey,
} from "./status-tone";

export interface SessionListEntry {
  key: string;
  worktree: Worktree | null;
  session: ManagedSession | null;
  repoPath: string;
  repoName: string;
  disambiguator: string | null;
  statusKey: StatusKey;
}

export interface SessionSectionGroup {
  section: SessionSection;
  entries: SessionListEntry[];
}

/**
 * 描画用の平らな行。セクション見出しも行として同じ親に並べ、useHeldOrder の対象にする。
 * コンポーネントの SessionListRow (SessionListRow.tsx) と名前が同じなので、両方を使う側は
 * `type SessionListRow as ListRow` のように別名で import する
 */
export type SessionListRow =
  | { kind: "section"; key: string; section: SessionSection; count: number }
  | { kind: "entry"; key: string; entry: SessionListEntry };

export function buildSessionEntries(
  groupedItems: Map<string, RepoGroup>,
  statuses: Map<string, BridgeSessionStatus>
): SessionListEntry[] {
  const entries: SessionListEntry[] = [];
  for (const [repoPath, group] of groupedItems) {
    for (const { worktree, session } of group.items) {
      const key = worktree ? `wt:${worktree.id}` : `s:${session?.id ?? ""}`;
      entries.push({
        key,
        worktree,
        session,
        repoPath,
        repoName: group.repoName,
        disambiguator: group.disambiguator,
        statusKey: resolveStatusKey(
          session !== null,
          session ? statuses.get(session.id) : undefined
        ),
      });
    }
  }
  return entries;
}

const SECTION_RANK: Readonly<Record<SessionSection, number>> = {
  "your-turn": 0,
  working: 1,
  resting: 2,
};

function itemPath(entry: SessionListEntry): string {
  return entry.worktree?.path ?? entry.session?.worktreePath ?? "";
}

function compareEntries(a: SessionListEntry, b: SessionListEntry): number {
  const pa = presentStatus(a.statusKey);
  const pb = presentStatus(b.statusKey);
  return (
    SECTION_RANK[pa.section] - SECTION_RANK[pb.section] ||
    pa.priority - pb.priority ||
    a.repoName.localeCompare(b.repoName) ||
    a.repoPath.localeCompare(b.repoPath) ||
    Number(a.worktree === null) - Number(b.worktree === null) ||
    itemPath(a).localeCompare(itemPath(b))
  );
}

export function sortSessionEntries(
  entries: SessionListEntry[]
): SessionListEntry[] {
  return [...entries].sort(compareEntries);
}

export function sectionize(entries: SessionListEntry[]): SessionSectionGroup[] {
  return SECTION_ORDER.map(section => ({
    section,
    entries: entries.filter(
      e => presentStatus(e.statusKey).section === section
    ),
  })).filter(g => g.entries.length > 0);
}

export function toListRows(groups: SessionSectionGroup[]): SessionListRow[] {
  const rows: SessionListRow[] = [];
  for (const g of groups) {
    rows.push({
      kind: "section",
      key: `section:${g.section}`,
      section: g.section,
      count: g.entries.length,
    });
    for (const entry of g.entries) {
      rows.push({ kind: "entry", key: entry.key, entry });
    }
  }
  return rows;
}
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `pnpm vitest run packages/web/src/lib/session-sections.test.ts`
Expected: PASS

- [ ] **Step 5: 並び替えの保留のテストを書く**

`packages/web/src/hooks/useHeldOrder.test.tsx`:

```tsx
// @vitest-environment jsdom

import { act, type FocusEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyHeldOrder, useHeldOrder, useListHold } from "./useHeldOrder";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Item {
  key: string;
  label: string;
}
const keyOf = (i: Item) => i.key;

describe("applyHeldOrder", () => {
  it("前の順を保ち、中身は新しい値を使う", () => {
    const next = [
      { key: "b", label: "B2" },
      { key: "a", label: "A2" },
    ];
    expect(applyHeldOrder(["a", "b"], next, keyOf)).toEqual([
      { key: "a", label: "A2" },
      { key: "b", label: "B2" },
    ]);
  });
  it("新しい要素は末尾に足し、消えた要素は落とす", () => {
    const next = [
      { key: "c", label: "C" },
      { key: "a", label: "A" },
    ];
    expect(applyHeldOrder(["a", "b"], next, keyOf).map(keyOf)).toEqual(["a", "c"]);
  });
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Probe({ items, held }: { items: Item[]; held: boolean }) {
  const shown = useHeldOrder(items, keyOf, held);
  return <ul>{shown.map(i => <li key={i.key}>{i.label}</li>)}</ul>;
}

function labels() {
  return [...container.querySelectorAll("li")].map(li => li.textContent);
}

describe("useHeldOrder", () => {
  it("保留中は位置を保ち、解除したら新しい順にする", () => {
    act(() => root.render(<Probe held={false} items={[{ key: "a", label: "A" }, { key: "b", label: "B" }]} />));
    expect(labels()).toEqual(["A", "B"]);

    act(() => root.render(<Probe held items={[{ key: "b", label: "B*" }, { key: "a", label: "A" }]} />));
    expect(labels()).toEqual(["A", "B*"]);

    act(() => root.render(<Probe held={false} items={[{ key: "b", label: "B*" }, { key: "a", label: "A" }]} />));
    expect(labels()).toEqual(["B*", "A"]);
  });
});

type Hold = ReturnType<typeof useListHold>;

function HoldProbe({ onHold }: { onHold: (h: Hold) => void }) {
  const hold = useListHold();
  onHold(hold);
  return <div data-held={String(hold.held)} />;
}

describe("useListHold", () => {
  function setup() {
    let latest: Hold | null = null;
    act(() => root.render(<HoldProbe onHold={h => { latest = h; }} />));
    const current = () => latest as unknown as Hold;
    const held = () => container.querySelector("div")?.getAttribute("data-held");
    return { current, held };
  }

  it("ポインタが上にある間は保留する", () => {
    const { current, held } = setup();
    expect(held()).toBe("false");
    act(() => current().bindings.onPointerEnter());
    expect(held()).toBe("true");
    act(() => current().bindings.onPointerLeave());
    expect(held()).toBe("false");
  });

  it("フォーカスが一覧の外へ出たら解除する", () => {
    const { current, held } = setup();
    act(() => current().bindings.onFocusCapture());
    expect(held()).toBe("true");
    const list = document.createElement("div");
    const inside = document.createElement("button");
    list.appendChild(inside);
    act(() =>
      current().bindings.onBlurCapture({ currentTarget: list, relatedTarget: inside } as unknown as FocusEvent<HTMLElement>)
    );
    expect(held()).toBe("true");
    act(() =>
      current().bindings.onBlurCapture({ currentTarget: list, relatedTarget: null } as unknown as FocusEvent<HTMLElement>)
    );
    expect(held()).toBe("false");
  });

  it("メニューが開いている間とタッチ中は保留する", () => {
    const { current, held } = setup();
    act(() => current().onMenuOpenChange(true));
    expect(held()).toBe("true");
    act(() => current().onMenuOpenChange(false));
    expect(held()).toBe("false");
    act(() => current().bindings.onTouchStart());
    expect(held()).toBe("true");
    act(() => current().bindings.onTouchCancel());
    expect(held()).toBe("false");
  });
});
```

- [ ] **Step 6: テストが落ちることを確かめる**

Run: `pnpm vitest run packages/web/src/hooks/useHeldOrder.test.tsx`
Expected: FAIL (`Failed to resolve import "./useHeldOrder"`)

- [ ] **Step 7: `useHeldOrder.ts` を書く**

`packages/web/src/hooks/useHeldOrder.ts`:

```ts
/**
 * 一覧の並び替えの保留 (設計書 7 節)。
 *
 * 状態が変わると行がセクションをまたいで動く。クリックしようとした行が動いて
 * 別のセッションを開く事故を防ぐため、ポインタが上にある・フォーカスがある・
 * メニューが開いている・タッチ中の間は、行の位置を前の並びのまま保つ。
 * 行の中身 (状態チップ) は保留中も最新にする。
 */

import {
  type FocusEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export function applyHeldOrder<T>(
  previousKeys: readonly string[],
  items: readonly T[],
  getKey: (item: T) => string
): T[] {
  const byKey = new Map(items.map(item => [getKey(item), item] as const));
  const result: T[] = [];
  const placed = new Set<string>();
  for (const key of previousKeys) {
    const item = byKey.get(key);
    if (item !== undefined) {
      result.push(item);
      placed.add(key);
    }
  }
  for (const item of items) {
    if (!placed.has(getKey(item))) result.push(item);
  }
  return result;
}

export function useHeldOrder<T>(
  items: readonly T[],
  getKey: (item: T) => string,
  held: boolean
): T[] {
  const shownKeysRef = useRef<string[]>([]);
  const shown = held
    ? applyHeldOrder(shownKeysRef.current, items, getKey)
    : [...items];

  useEffect(() => {
    shownKeysRef.current = shown.map(getKey);
  });

  return shown;
}

export interface ListHoldBindings {
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onFocusCapture: () => void;
  onBlurCapture: (e: FocusEvent<HTMLElement>) => void;
  onTouchStart: () => void;
  onTouchEnd: () => void;
  onTouchCancel: () => void;
}

export function useListHold(): {
  held: boolean;
  bindings: ListHoldBindings;
  onMenuOpenChange: (open: boolean) => void;
} {
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const [touching, setTouching] = useState(false);
  const [openMenus, setOpenMenus] = useState(0);

  const bindings = useMemo<ListHoldBindings>(
    () => ({
      onPointerEnter: () => setPointerInside(true),
      onPointerLeave: () => setPointerInside(false),
      onFocusCapture: () => setFocusInside(true),
      onBlurCapture: e => {
        const next = e.relatedTarget as Node | null;
        if (!next || !e.currentTarget.contains(next)) setFocusInside(false);
      },
      onTouchStart: () => setTouching(true),
      onTouchEnd: () => setTouching(false),
      onTouchCancel: () => setTouching(false),
    }),
    []
  );

  // メニューは Portal に描かれ、ポインタ判定では拾えないので開閉で数える
  const onMenuOpenChange = useCallback((open: boolean) => {
    setOpenMenus(n => Math.max(0, n + (open ? 1 : -1)));
  }, []);

  return {
    held: pointerInside || focusInside || touching || openMenus > 0,
    bindings,
    onMenuOpenChange,
  };
}
```

- [ ] **Step 8: テストが通ることを確かめる**

Run: `pnpm vitest run packages/web/src/hooks/useHeldOrder.test.tsx packages/web/src/lib/session-sections.test.ts`
Expected: PASS

- [ ] **Step 9: 整形して型とlintを通し、コミット**

Run: `pnpm biome check --write packages/web/src/lib/session-sections.ts packages/web/src/lib/session-sections.test.ts packages/web/src/hooks/useHeldOrder.ts packages/web/src/hooks/useHeldOrder.test.tsx && pnpm check`
Expected: エラー無し

```bash
git branch --show-current
git add packages/web/src/lib/session-sections.ts packages/web/src/lib/session-sections.test.ts packages/web/src/hooks/useHeldOrder.ts packages/web/src/hooks/useHeldOrder.test.tsx
git commit -m "feat(web): 一覧を注意の順に並べ、操作中は並び替えを保留する

セクション → 状態の優先度 → リポジトリ名 → パスの順に並べる関数と、
ポインタ・フォーカス・メニュー・タッチの間は前の並びを保つフックを足す。
見出しも行として並べ、保留中にセクションをまたいで行が動かないようにする。"
```

---

### Task 4: 端末の色とPCの既定モード

**Files:**
- Modify: `packages/shared/src/types.ts` (末尾に定数を追加)
- Create: `packages/server/src/lib/ttyd-theme.ts`
- Create: `packages/server/src/lib/ttyd-theme.test.ts`
- Modify: `packages/server/src/lib/ttyd-manager.ts:241-246` (`-t` の3組)
- Modify: `packages/web/src/lib/split-view-left-mode.ts` (既定値)
- Modify: `packages/web/src/components/SplitViewPane.test.tsx:211-235` (既定値のテスト)

**Interfaces:**
- Consumes: なし
- Produces: `TERMINAL_BG` / `TERMINAL_FG` (`@ark/shared`)、`buildTtydTerminalOptions(): string[]` (server)、PCの左ペインの既定 `"chat"`

- [ ] **Step 1: ttyd のオプションのテストを書く**

`packages/server/src/lib/ttyd-theme.test.ts`:

```ts
import { TERMINAL_BG, TERMINAL_FG } from "@ark/shared";
import { describe, expect, it } from "vitest";
import { buildTtydTerminalOptions } from "./ttyd-theme.js";

describe("buildTtydTerminalOptions", () => {
  it("暖色の暗い背景と文字色を ttyd に渡す", () => {
    const args = buildTtydTerminalOptions();
    expect(TERMINAL_BG).toBe("#1c1a17");
    expect(TERMINAL_FG).toBe("#e6e1da");
    const themeIndex = args.findIndex(a => a.startsWith("theme="));
    expect(args[themeIndex - 1]).toBe("-t");
    expect(JSON.parse(args[themeIndex].slice("theme=".length))).toEqual({
      background: TERMINAL_BG,
      foreground: TERMINAL_FG,
    });
  });

  it("フォントの指定は今のまま", () => {
    expect(buildTtydTerminalOptions()).toEqual([
      "-t",
      "fontSize=14",
      "-t",
      "fontFamily=JetBrains Mono, Menlo, Monaco, monospace",
      "-t",
      `theme={"background":"${TERMINAL_BG}","foreground":"${TERMINAL_FG}"}`,
    ]);
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `pnpm vitest run packages/server/src/lib/ttyd-theme.test.ts`
Expected: FAIL (`TERMINAL_BG` が `@ark/shared` に無い、または `./ttyd-theme.js` が解決できない)

- [ ] **Step 3: 定数と組み立て関数を書き、ttyd-manager から使う**

`packages/shared/src/types.ts` の末尾に足す:

```ts
// ============================================================
// 端末 (ttyd) の色
// ============================================================

/**
 * ttyd の背景色と文字色。web の端末の額縁 (TerminalPane / MobileSessionView) も
 * 同じ値を使い、iframe の中と外で段差が出ないようにする (設計書 8.6 節)
 */
export const TERMINAL_BG = "#1c1a17";
export const TERMINAL_FG = "#e6e1da";
```

`packages/server/src/lib/ttyd-theme.ts`:

```ts
import { TERMINAL_BG, TERMINAL_FG } from "@ark/shared";

/** ttyd の `-t` オプション (フォントと色)。ttyd の起動時に確定する */
export function buildTtydTerminalOptions(): string[] {
  return [
    "-t",
    "fontSize=14",
    "-t",
    "fontFamily=JetBrains Mono, Menlo, Monaco, monospace",
    "-t",
    `theme=${JSON.stringify({ background: TERMINAL_BG, foreground: TERMINAL_FG })}`,
  ];
}
```

`packages/server/src/lib/ttyd-manager.ts` の import に `import { buildTtydTerminalOptions } from "./ttyd-theme.js";` を足し、
spawn の引数の次の部分を置き換える。

変更前:

```ts
        "--base-path",
        basePath, // プロキシ経由でのWebSocket接続に必要
        "-t",
        "fontSize=14",
        "-t",
        "fontFamily=JetBrains Mono, Menlo, Monaco, monospace",
        "-t",
        'theme={"background":"#1a1b26","foreground":"#a9b1d6"}',
        "tmux",
```

変更後:

```ts
        "--base-path",
        basePath, // プロキシ経由でのWebSocket接続に必要
        ...buildTtydTerminalOptions(),
        "tmux",
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `pnpm vitest run packages/server/src/lib/ttyd-theme.test.ts`
Expected: PASS

- [ ] **Step 5: PCの既定モードのテストを書き換える**

`packages/web/src/components/SplitViewPane.test.tsx` の `it("保存値を正規化し、localStorage が使えなくても既定へ戻る", …)` を次に置き換える。

```tsx
  it("保存値を正規化し、保存なし・不正値・localStorage の例外では会話を既定にする", () => {
    expect(normalizeSplitViewLeftMode("terminal")).toBe("terminal");
    expect(normalizeSplitViewLeftMode("chat")).toBe("chat");
    expect(normalizeSplitViewLeftMode("board")).toBe("chat");
    expect(normalizeSplitViewLeftMode(null)).toBe("chat");
    expect(readSavedSplitViewLeftMode({ getItem: () => null })).toBe("chat");
    expect(readSavedSplitViewLeftMode({ getItem: () => "terminal" })).toBe(
      "terminal"
    );
    expect(
      readSavedSplitViewLeftMode({
        getItem: () => {
          throw new Error("storage disabled");
        },
      })
    ).toBe("chat");
    expect(() =>
      writeSavedSplitViewLeftMode("chat", {
        setItem: () => {
          throw new Error("storage disabled");
        },
      })
    ).not.toThrow();
  });
```

- [ ] **Step 6: テストが落ちることを確かめる**

Run: `pnpm vitest run packages/web/src/components/SplitViewPane.test.tsx -t "会話を既定にする"`
Expected: FAIL (`expected 'terminal' to be 'chat'`)

- [ ] **Step 7: 既定値を chat にする**

`packages/web/src/lib/split-view-left-mode.ts` を次のように変える。

冒頭のコメントの

```ts
 * 既定は "terminal"。従来の PC は常にターミナルだったため、未保存の
 * ユーザーには従来どおりの見え方を返す。
```

を

```ts
 * 既定は "chat" (見た目の刷新で PC も会話を主画面にした。設計書 3 節)。
 * 保存済みの選択は尊重する。
```

にし、`normalizeSplitViewLeftMode` の `: "terminal";` を `: "chat";` に、`readSavedSplitViewLeftMode` の
`catch { return "terminal"; }` を `catch { return "chat"; }` にする。

- [ ] **Step 8: テストを実行する**

Run: `pnpm vitest run packages/web/src/components/SplitViewPane.test.tsx`
Expected: 「会話を既定にする」は PASS。**端末が初期状態であることを前提にした既存のテスト (購読・D&D) が落ちる場合は、Task 7 で `terminal` を明示的に保存してから始める形に直す**。このステップでは落ちたテスト名を控えておき、Task 7 の Step で直す (Task 4 のコミットには、落ちたテストの `beforeEach` に `localStorage.setItem(STORAGE_KEY_SPLIT_LEFT_MODE, "terminal")` を足す最小の修正を含めてよい)

- [ ] **Step 9: 整形して型とlintを通し、コミット**

Run: `pnpm biome check --write packages/shared/src/types.ts packages/server/src/lib/ttyd-theme.ts packages/server/src/lib/ttyd-theme.test.ts packages/server/src/lib/ttyd-manager.ts packages/web/src/lib/split-view-left-mode.ts packages/web/src/components/SplitViewPane.test.tsx && pnpm check && pnpm vitest run packages/server/src/lib/ttyd-theme.test.ts packages/web/src/components/SplitViewPane.test.tsx`
Expected: すべて PASS

```bash
git branch --show-current
git add packages/shared/src/types.ts packages/server/src/lib/ttyd-theme.ts packages/server/src/lib/ttyd-theme.test.ts packages/server/src/lib/ttyd-manager.ts packages/web/src/lib/split-view-left-mode.ts packages/web/src/components/SplitViewPane.test.tsx
git commit -m "feat: 端末を暖色の暗い窓にし、PCの既定を会話にする

ttyd の背景と文字色を共有定数にし、web の額縁と同じ値にそろえる。
PC の左ペインは保存が無い・不正値・localStorage の例外のとき会話を既定にする。"
```

---

---

### Task 5: PCサイドバー

**Files:**
行番号は変更前のファイルでの目安。置き換えは、各ステップで引用した既存の行を目印にする。

- Create: `packages/web/src/components/SessionRowMenu.tsx` (行メニューの中身。右クリックと `…` で共有)
- Create: `packages/web/src/components/SessionRowMenu.test.tsx`
- Create: `packages/web/src/components/SessionListRow.tsx` (1行。PCの行とモバイルのカード)
- Create: `packages/web/src/components/SessionListRow.test.tsx`
- Create: `packages/web/src/components/SessionSectionList.tsx` (並べ方・保留・行メニューの配線・確認ダイアログ。PCとモバイルで共有)
- Create: `packages/web/src/components/SessionSectionList.test.tsx`
- Create: `packages/web/src/components/SessionSidebar.test.tsx`
- Modify: `packages/web/src/components/SessionSidebar.tsx` (全体を書き換え。1〜727行)
- Modify: `packages/web/src/components/SidebarMainLayout.tsx` (8行・16行のimport、27〜29行・41〜42行のprops、113〜122行のAboutとCPU/MEM/DISK)
- Modify: `packages/web/src/components/AboutDialog.tsx` (15〜23行のimport、37〜42行のprops、79行の後ろに「このマシン」)
- Modify: `packages/web/src/components/bridge/SystemStatusBar.tsx` (26〜56行の色と等幅だけ。Aboutに移すための変更)
- Modify: `packages/web/src/pages/Dashboard.tsx` (120行・159〜160行・459行・725〜762行・895〜896行・1077行)
- Modify: `packages/web/src/pages/Dashboard.test.tsx` (9〜14行・33〜35行・76〜80行・95〜97行・227〜238行、末尾にdescribeを追加)
- Delete: `packages/web/src/components/SessionCard.tsx` (行は `SessionListRow`、メニューは `SessionRowMenu` に置き換わる)
- Delete: `packages/web/src/components/RepoProfileMenu.tsx` (中身は `SessionRowMenu` に吸収。プロファイル別の5色 `PROFILE_COLORS` / `colorFor` を捨てる)

**Interfaces:**
- Consumes:
  - Task 1: `text-status-awaiting` / `bg-status-awaiting/15` / `shadow-card` / `rounded-lg` / `rounded-sm`
  - Task 2: `StatusChip({ statusKey })`、`presentStatus(key).label`、`SECTION_ORDER`、`SECTION_LABELS`、`TONE_CLASSES.awaiting.solidBg`、型 `StatusKey` / `SessionSection`
  - Task 3: `buildSessionEntries` / `sortSessionEntries` / `sectionize` / `toListRows`、型 `SessionListEntry` / `SessionSectionGroup` / `SessionListRow` (描画用の平らな行。`kind: "section" | "entry"`)、`useHeldOrder`、`useListHold`
  - 型 `SessionListRow` はコンポーネント `SessionListRow` (このタスクで作る) と名前が同じなので、両方を使う `SessionSectionList.tsx` では `type SessionListRow as ListRow` と別名でimportする
- Produces:

```ts
// packages/web/src/components/SessionRowMenu.tsx
export interface ProfileChoice {
  profiles: Profile[];
  currentProfileId: string | null;
  onSelect: (profileId: string | null) => void;
}
export interface SessionRowMenuProps {
  variant: "context" | "dropdown";
  entry: SessionListEntry;
  onOpen: () => void;
  onStartRename?: () => void;
  notifications?: { enabled: boolean; onChange: (enabled: boolean) => void };
  onRestart?: () => void;
  worktreeProfile?: ProfileChoice & { inheritedProfileName: string | null };
  onCreateWorktree?: () => void;
  onOpenRepoGrid?: () => void;
  repoProfile?: ProfileChoice;
  onOpenProfileManager?: () => void;
  onRemoveRepo?: () => void;
  onDelete?: () => void;
}
export function SessionRowMenu(props: SessionRowMenuProps): JSX.Element;
```

```ts
// packages/web/src/components/SessionListRow.tsx
export interface SessionRowProfile { name: string; individual: boolean }
export function resolveSessionRowProfile(input: {
  enabled: boolean;
  worktreePath: string | null;
  repoPath: string;
  profileById: ReadonlyMap<string, Profile>;
  repoProfileLinks?: ReadonlyMap<string, string>;
  worktreeProfileLinks?: ReadonlyMap<string, string>;
}): SessionRowProfile | null;
export interface SessionListRowProps {
  variant: "sidebar" | "card";
  entry: SessionListEntry;
  displayName: string | null;
  previewText: string;
  profile: SessionRowProfile | null;
  staleProfile: boolean;
  selected: boolean;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onSaveDisplayName?: (displayName: string | null) => void;
  menu: Omit<SessionRowMenuProps, "variant" | "entry">;
  onMenuOpenChange: (open: boolean) => void;
}
export function SessionListRow(props: SessionListRowProps): JSX.Element;
// DOM: 行を押せる要素 (role="button") にdata-session-key={entry.key}とtitle={entry.repoPath}。
// 主ラベルはdata-testid="session-row-label"
```

```ts
// packages/web/src/components/SessionSectionList.tsx (Task 6 がモバイル一覧で使う)
export interface SessionSectionListProps {
  variant: "sidebar" | "card";
  sessions: Map<string, ManagedSession>;
  worktrees: Worktree[];
  repoList: string[];
  sessionStatuses: Map<string, BridgeSessionStatus>;
  sessionPreviews: Map<string, string>;
  selectedSessionId: string | null;
  worktreeDisplayNames?: Map<string, string>;
  capabilities?: SystemCapabilities;
  profiles?: Profile[];
  repoProfileLinks?: Map<string, string>;
  worktreeProfileLinks?: Map<string, string>;
  notificationsSupported?: boolean;
  isSessionNotificationEnabled?: (sessionId: string) => boolean;
  onOpenSession: (sessionId: string) => void;
  onStartSession: (worktree: Worktree) => void;
  onDeleteSession: (sessionId: string, worktree: Worktree | undefined) => void;
  onDeleteWorktree?: (worktree: Worktree) => void;
  onRestartSession?: (sessionId: string) => void;
  onSetWorktreeDisplayName?: (worktreePath: string, displayName: string | null) => void;
  onSessionNotificationEnabledChange?: (sessionId: string, enabled: boolean) => void;
  onCreateWorktreeForRepo?: (repoPath: string) => void;
  onSelectRepoGrid?: (repoPath: string) => void;
  onRemoveRepo?: (repoPath: string) => void;
  onSetRepoProfile?: (repoPath: string, profileId: string | null) => void;
  onSetWorktreeProfile?: (worktreePath: string, profileId: string | null) => void;
  onOpenProfileManager?: () => void;
}
export function SessionSectionList(props: SessionSectionListProps): JSX.Element;
// DOM: 一覧の親要素にdata-session-list、セクション見出しの要素 (<h2>) にdata-section={section}
```

```ts
// 既存コンポーネントのpropsの変更
// SessionSidebar: Omit<SessionSectionListProps, "variant"> & { onNewSession; onOpenAbout: () => void; onSelectBrowser?; isBrowserSelected?; isRemote?; notificationControl? }
//   削除: sessionActivityTexts / gridRepoPath。改名: gridStatuses → sessionStatuses
// SidebarMainLayout: onOpenAboutDialog / hostMetricsを削除
// AboutDialog: metrics: HostMetrics | nullを追加
```

**設計メモ (このタスクで決めたこと):**
- 一覧の組み立ては骨格のとおり `toListRows(sectionize(sortSessionEntries(buildSessionEntries(…))))` → `useHeldOrder(rows, row => row.key, held)` とし、見出しと行を同じ親の直下に `key={row.key}` で並べる。`toListRows` は空のセクションを出さないので、保留中に初めて出たセクションの見出しは並びの末尾に足される。画面に出すときは「直後に行が続かない見出し」を描かない (末尾に見出しだけが浮かないように)
- 並べ方・保留・行メニューの配線・確認ダイアログは `SessionSectionList` に集め、PCサイドバー (`variant="sidebar"`) とモバイル一覧 (`variant="card"`, Task 6) の両方が使う。2か所に書くと「同じ中身」がずれるため
- プレビュー文は `sessionPreviews` だけを使う。`sessionActivityTexts` と、10秒変化が無ければアイドルとみなす判定、`fallbackDotColor` の画面テキスト解釈は捨てる (状態は `statusKey` が「未着」まで扱う)
- 主ラベルは「表示名、無ければリポジトリ名」。表示名の「解除」は、空文字かリポジトリ名と同じ値を保存したとき
- 同名リポジトリの `disambiguator` はリポジトリ名に付ける。表示名が無ければ主ラベルの後ろ、表示名があれば2行目の先頭のリポジトリ名の後ろに出す
- 行の開く領域はマウスで押してもフォーカスを受け取らない (`onMouseDown` で `preventDefault`)。押しただけで一覧にフォーカスが残ると、並び替えの保留が解けなくなるため。キーボードのフォーカスは残す。`…` のメニューを閉じるとRadixがフォーカスをボタンへ戻すので、行を押したときに一覧の中 (`data-session-list`) に残っているフォーカスは `blur()` で外す
- 表示名の保存と取り消しは入力欄の `blur` に一本化する。Enter / Escapeは `blur()` を呼ぶだけにし、入力欄が消えても一覧から確実にフォーカスが抜けるようにする。日本語入力の変換中のEnterでは保存しない
- 未起動のworktreeの削除 (`onDeleteWorktree`) は、今と同じくモバイルだけに渡す。`useSocket` の `deleteWorktree` は選択中のリポジトリの `repoPath` で送るため、PCに広げない

- [ ] **Step 1: ブランチを確かめる**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper && git branch --show-current`
Expected: `feat/visual-redesign-paper`

- [ ] **Step 2: 行メニューの失敗するテストを書く**

`packages/web/src/components/SessionRowMenu.test.tsx` を作る。Radixのメニューはjsdomでは開けない (Popperが `ResizeObserver` を要る) ので、部品を素の要素に置き換えて、中身と `onSelect` の配線だけを確かめる。

```tsx
// @vitest-environment jsdom

import type { ManagedSession, Profile, Worktree } from "@ark/shared";
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionListEntry } from "@/lib/session-sections";
import { SessionRowMenu, type SessionRowMenuProps } from "./SessionRowMenu";

// Radixのメニューはjsdomで開けないため、部品を素の要素に置き換える
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenuGroup: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSub: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSubContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSubTrigger: ({ children }: { children?: ReactNode }) => (
    <div data-menu-sub-trigger="">{children}</div>
  ),
  DropdownMenuLabel: ({ children }: { children?: ReactNode }) => (
    <div data-menu-label="">{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    onSelect,
    variant,
    ...rest
  }: {
    children?: ReactNode;
    onSelect?: (event: Event) => void;
    variant?: string;
  }) => (
    <button
      type="button"
      data-menu-item=""
      data-variant={variant}
      {...rest}
      onClick={() => onSelect?.(new Event("select"))}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenuGroup: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  ContextMenuSub: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  ContextMenuSubContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  ContextMenuSubTrigger: ({ children }: { children?: ReactNode }) => (
    <div data-menu-sub-trigger="">{children}</div>
  ),
  ContextMenuLabel: ({ children }: { children?: ReactNode }) => (
    <div data-menu-label="">{children}</div>
  ),
  ContextMenuSeparator: () => <hr />,
  ContextMenuItem: ({
    children,
    onSelect,
    variant,
    ...rest
  }: {
    children?: ReactNode;
    onSelect?: (event: Event) => void;
    variant?: string;
  }) => (
    <button
      type="button"
      data-menu-item=""
      data-variant={variant}
      {...rest}
      onClick={() => onSelect?.(new Event("select"))}
    >
      {children}
    </button>
  ),
}));

const repoPath = "/work/app";
const worktree: Worktree = {
  id: "wt-1",
  path: `${repoPath}/.worktrees/login`,
  branch: "feature/login",
  commit: "abc1234",
  isMain: false,
  isBare: false,
};
const session: ManagedSession = {
  id: "session-1",
  worktreeId: worktree.id,
  worktreePath: worktree.path,
  repoPath,
  status: "active",
  createdAt: new Date("2026-09-17T00:00:00Z"),
  tmuxSessionName: "ark-session-1",
  ttydPort: 7680,
  ttydUrl: "/ttyd/session-1/",
};
const profiles: Profile[] = [
  {
    id: "p-work",
    name: "仕事",
    configDir: "/home/me/.claude-work",
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "p-home",
    name: "個人",
    configDir: "/home/me/.claude-home",
    createdAt: 0,
    updatedAt: 0,
  },
];

function entryOf(overrides: Partial<SessionListEntry> = {}): SessionListEntry {
  return {
    key: `wt:${worktree.id}`,
    worktree,
    session,
    repoPath,
    repoName: "app",
    disambiguator: null,
    statusKey: "IDLE",
    ...overrides,
  };
}

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function mount(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mountedRoots.push({ root, container });
  return container;
}

function itemLabels(scope: ParentNode): string[] {
  return Array.from(scope.querySelectorAll("[data-menu-item]")).map(
    element => element.textContent ?? ""
  );
}

function clickItem(scope: ParentNode, label: string): void {
  const item = Array.from(
    scope.querySelectorAll<HTMLButtonElement>("[data-menu-item]")
  ).find(element => element.textContent === label);
  expect(item).toBeDefined();
  act(() => item?.click());
}

function fullMenuProps(): Omit<SessionRowMenuProps, "variant"> {
  return {
    entry: entryOf(),
    onOpen: vi.fn(),
    onStartRename: vi.fn(),
    notifications: { enabled: true, onChange: vi.fn() },
    onRestart: vi.fn(),
    onCreateWorktree: vi.fn(),
    onOpenRepoGrid: vi.fn(),
    onRemoveRepo: vi.fn(),
    onDelete: vi.fn(),
  };
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("SessionRowMenu", () => {
  it("セッションのある行: 開く・表示名・通知・再起動、リポジトリの操作、最下段に赤い削除を並べる", () => {
    const container = mount(
      <SessionRowMenu variant="dropdown" {...fullMenuProps()} />
    );

    expect(itemLabels(container)).toEqual([
      "開く",
      "表示名を変更",
      "通知をオフにする",
      "再起動",
      "新規worktreeを作成",
      "このリポジトリの全セッションを並べて見る",
      "サイドバーから除外",
      "セッションを削除",
    ]);
    expect(container.querySelector("[data-menu-label]")?.textContent).toBe(
      "リポジトリ"
    );
    expect(
      container.querySelector('[data-menu-item][data-variant="destructive"]')
        ?.textContent
    ).toBe("セッションを削除");
  });

  it("右クリックのメニューにも同じ中身を出す", () => {
    const container = mount(
      <SessionRowMenu variant="context" {...fullMenuProps()} />
    );

    expect(itemLabels(container)).toEqual([
      "開く",
      "表示名を変更",
      "通知をオフにする",
      "再起動",
      "新規worktreeを作成",
      "このリポジトリの全セッションを並べて見る",
      "サイドバーから除外",
      "セッションを削除",
    ]);
  });

  it("操作が渡されなかった項目とリポジトリの見出しは出さない", () => {
    const container = mount(
      <SessionRowMenu variant="dropdown" entry={entryOf()} onOpen={vi.fn()} />
    );

    expect(itemLabels(container)).toEqual(["開く"]);
    expect(container.querySelector("[data-menu-label]")).toBeNull();
    expect(container.querySelector("hr")).toBeNull();
  });

  it("未起動のworktreeの行: 「セッションを起動」と「Worktreeを削除」にする", () => {
    const onOpen = vi.fn();
    const container = mount(
      <SessionRowMenu
        variant="dropdown"
        entry={entryOf({ session: null, statusKey: "NOT_STARTED" })}
        onOpen={onOpen}
        onDelete={vi.fn()}
      />
    );

    expect(itemLabels(container)).toEqual(["セッションを起動", "Worktreeを削除"]);
    clickItem(container, "セッションを起動");
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("項目を選ぶと対応する操作を呼ぶ", () => {
    const props = fullMenuProps();
    const container = mount(<SessionRowMenu variant="dropdown" {...props} />);

    clickItem(container, "表示名を変更");
    clickItem(container, "通知をオフにする");
    clickItem(container, "再起動");
    clickItem(container, "新規worktreeを作成");
    clickItem(container, "このリポジトリの全セッションを並べて見る");
    clickItem(container, "サイドバーから除外");
    clickItem(container, "セッションを削除");

    expect(props.onStartRename).toHaveBeenCalledTimes(1);
    expect(props.notifications?.onChange).toHaveBeenCalledWith(false);
    expect(props.onRestart).toHaveBeenCalledTimes(1);
    expect(props.onCreateWorktree).toHaveBeenCalledTimes(1);
    expect(props.onOpenRepoGrid).toHaveBeenCalledTimes(1);
    expect(props.onRemoveRepo).toHaveBeenCalledTimes(1);
    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

  it("このworktreeのプロファイル: 個別の選択と「リポジトリの設定を継承」を出す", () => {
    const onSelect = vi.fn();
    const onOpenProfileManager = vi.fn();
    const container = mount(
      <SessionRowMenu
        variant="dropdown"
        entry={entryOf()}
        onOpen={vi.fn()}
        worktreeProfile={{
          profiles,
          currentProfileId: "p-home",
          inheritedProfileName: "仕事",
          onSelect,
        }}
        onOpenProfileManager={onOpenProfileManager}
      />
    );

    expect(
      container.querySelector("[data-menu-sub-trigger]")?.textContent
    ).toBe("このworktreeのプロファイル");
    expect(itemLabels(container)).toEqual([
      "開く",
      "仕事",
      "個人",
      "リポジトリの設定を継承 (仕事)",
      "プロファイル管理を開く...",
    ]);
    expect(
      container.querySelector('[data-menu-item][data-current="true"]')
        ?.textContent
    ).toBe("個人");

    clickItem(container, "リポジトリの設定を継承 (仕事)");
    clickItem(container, "仕事");
    clickItem(container, "プロファイル管理を開く...");

    expect(onSelect).toHaveBeenNthCalledWith(1, null);
    expect(onSelect).toHaveBeenNthCalledWith(2, "p-work");
    expect(onOpenProfileManager).toHaveBeenCalledTimes(1);
  });

  it("リポジトリの既定プロファイル: 「既定 (~/.claude)」で解除できる", () => {
    const onSelect = vi.fn();
    const container = mount(
      <SessionRowMenu
        variant="dropdown"
        entry={entryOf()}
        onOpen={vi.fn()}
        repoProfile={{ profiles, currentProfileId: null, onSelect }}
      />
    );

    expect(
      container.querySelector("[data-menu-sub-trigger]")?.textContent
    ).toBe("リポジトリの既定プロファイル");
    expect(
      container.querySelector('[data-menu-item][data-current="true"]')
        ?.textContent
    ).toBe("既定 (~/.claude)");

    clickItem(container, "個人");
    clickItem(container, "既定 (~/.claude)");

    expect(onSelect).toHaveBeenNthCalledWith(1, "p-home");
    expect(onSelect).toHaveBeenNthCalledWith(2, null);
  });
});
```

- [ ] **Step 3: 実行して失敗を確認する**

Run: `pnpm vitest run packages/web/src/components/SessionRowMenu.test.tsx`
Expected: FAIL。`Error: Failed to resolve import "./SessionRowMenu" from "packages/web/src/components/SessionRowMenu.test.tsx". Does the file exist?`

- [ ] **Step 4: 行メニューを実装する**

`packages/web/src/components/SessionRowMenu.tsx` を作る。中身は今の `SessionCard` のコンテキストメニュー、`SessionSidebar` のリポジトリ見出しのメニューと `renderProfileBadgeSlot`、`RepoProfileMenu` を1つにまとめたもの。プロファイル別の5色のバッジと `text-emerald-400` のチェックは使わない。

```tsx
/**
 * SessionRowMenu - セッション一覧の行メニューの中身
 *
 * PCの右クリック (ContextMenu) と `…`、モバイルの `⋮` (DropdownMenu) で同じ中身を出す。
 * Radixはメニューの種類ごとに内部の文脈が分かれ、ContextMenuItemをDropdownMenuの中では
 * 使えないため、Itemなどの部品をvariantで差し替える。
 * 操作のpropsを渡さなかった項目は出さない。
 */

import type { Profile } from "@ark/shared";
import {
  Bell,
  BellOff,
  Check,
  EyeOff,
  LayoutGrid,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Settings,
  Trash2,
  UserRound,
} from "lucide-react";
import type { ComponentProps, ComponentType } from "react";
import {
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import type { SessionListEntry } from "@/lib/session-sections";

export interface ProfileChoice {
  profiles: Profile[];
  /** いま選ばれているプロファイル。未設定はnull */
  currentProfileId: string | null;
  onSelect: (profileId: string | null) => void;
}

export interface SessionRowMenuProps {
  variant: "context" | "dropdown";
  entry: SessionListEntry;
  /** セッションがあれば開き、未起動のworktreeなら起動する */
  onOpen: () => void;
  /** 表示名の編集を始める */
  onStartRename?: () => void;
  /** このセッションの通知。ブラウザが通知に対応していなければundefined */
  notifications?: { enabled: boolean; onChange: (enabled: boolean) => void };
  /** 再起動の確認を開く */
  onRestart?: () => void;
  /** このworktreeの個別プロファイル。inheritedProfileNameはリポジトリの既定 (未設定はnull) */
  worktreeProfile?: ProfileChoice & { inheritedProfileName: string | null };
  onCreateWorktree?: () => void;
  /** このリポジトリの全セッションを並べて見る (RepoGridView。PCだけ) */
  onOpenRepoGrid?: () => void;
  repoProfile?: ProfileChoice;
  onOpenProfileManager?: () => void;
  /** サイドバーからの除外の確認を開く */
  onRemoveRepo?: () => void;
  /** 削除の確認を開く。セッションがあればセッション、無ければworktreeの削除 */
  onDelete?: () => void;
}

type MenuParts = {
  Group: ComponentType<ComponentProps<typeof ContextMenuGroup>>;
  Item: ComponentType<ComponentProps<typeof ContextMenuItem>>;
  Label: ComponentType<ComponentProps<typeof ContextMenuLabel>>;
  Separator: ComponentType<ComponentProps<typeof ContextMenuSeparator>>;
  Sub: ComponentType<ComponentProps<typeof ContextMenuSub>>;
  SubContent: ComponentType<ComponentProps<typeof ContextMenuSubContent>>;
  SubTrigger: ComponentType<ComponentProps<typeof ContextMenuSubTrigger>>;
};

const PARTS_BY_VARIANT: Record<SessionRowMenuProps["variant"], MenuParts> = {
  context: {
    Group: ContextMenuGroup,
    Item: ContextMenuItem,
    Label: ContextMenuLabel,
    Separator: ContextMenuSeparator,
    Sub: ContextMenuSub,
    SubContent: ContextMenuSubContent,
    SubTrigger: ContextMenuSubTrigger,
  },
  dropdown: {
    Group: DropdownMenuGroup as MenuParts["Group"],
    Item: DropdownMenuItem as MenuParts["Item"],
    Label: DropdownMenuLabel as MenuParts["Label"],
    Separator: DropdownMenuSeparator as MenuParts["Separator"],
    Sub: DropdownMenuSub as MenuParts["Sub"],
    SubContent: DropdownMenuSubContent as MenuParts["SubContent"],
    SubTrigger: DropdownMenuSubTrigger as MenuParts["SubTrigger"],
  },
};

export function SessionRowMenu({
  variant,
  entry,
  onOpen,
  onStartRename,
  notifications,
  onRestart,
  worktreeProfile,
  onCreateWorktree,
  onOpenRepoGrid,
  repoProfile,
  onOpenProfileManager,
  onRemoveRepo,
  onDelete,
}: SessionRowMenuProps) {
  const Menu = PARTS_BY_VARIANT[variant];
  const hasRepoItems =
    onCreateWorktree !== undefined ||
    onOpenRepoGrid !== undefined ||
    repoProfile !== undefined ||
    onRemoveRepo !== undefined;

  return (
    <>
      <Menu.Group>
        <Menu.Item onSelect={onOpen}>
          {entry.session ? <MessageSquare /> : <Play />}
          {entry.session ? "開く" : "セッションを起動"}
        </Menu.Item>
        {onStartRename && (
          <Menu.Item onSelect={onStartRename}>
            <Pencil />
            表示名を変更
          </Menu.Item>
        )}
        {notifications && (
          <Menu.Item
            onSelect={() => notifications.onChange(!notifications.enabled)}
          >
            {notifications.enabled ? <BellOff /> : <Bell />}
            {notifications.enabled ? "通知をオフにする" : "通知をオンにする"}
          </Menu.Item>
        )}
        {onRestart && (
          <Menu.Item onSelect={onRestart}>
            <RotateCw />
            再起動
          </Menu.Item>
        )}
        {worktreeProfile && (
          <Menu.Sub>
            <Menu.SubTrigger>
              <UserRound />
              このworktreeのプロファイル
            </Menu.SubTrigger>
            <Menu.SubContent className="w-60">
              <ProfileChoiceItems
                Menu={Menu}
                choice={worktreeProfile}
                unsetLabel={`リポジトリの設定を継承 (${worktreeProfile.inheritedProfileName ?? "既定"})`}
                onOpenProfileManager={onOpenProfileManager}
              />
            </Menu.SubContent>
          </Menu.Sub>
        )}
      </Menu.Group>
      {hasRepoItems && (
        <>
          <Menu.Separator />
          <Menu.Group>
            <Menu.Label className="text-xs font-semibold text-muted-foreground">
              リポジトリ
            </Menu.Label>
            {onCreateWorktree && (
              <Menu.Item onSelect={onCreateWorktree}>
                <Plus />
                新規worktreeを作成
              </Menu.Item>
            )}
            {onOpenRepoGrid && (
              <Menu.Item onSelect={onOpenRepoGrid}>
                <LayoutGrid />
                このリポジトリの全セッションを並べて見る
              </Menu.Item>
            )}
            {repoProfile && (
              <Menu.Sub>
                <Menu.SubTrigger>
                  <UserRound />
                  リポジトリの既定プロファイル
                </Menu.SubTrigger>
                <Menu.SubContent className="w-60">
                  <ProfileChoiceItems
                    Menu={Menu}
                    choice={repoProfile}
                    unsetLabel="既定 (~/.claude)"
                    onOpenProfileManager={onOpenProfileManager}
                  />
                </Menu.SubContent>
              </Menu.Sub>
            )}
            {onRemoveRepo && (
              <Menu.Item onSelect={onRemoveRepo}>
                <EyeOff />
                サイドバーから除外
              </Menu.Item>
            )}
          </Menu.Group>
        </>
      )}
      {onDelete && (
        <>
          <Menu.Separator />
          <Menu.Item variant="destructive" onSelect={onDelete}>
            <Trash2 />
            {entry.session ? "セッションを削除" : "Worktreeを削除"}
          </Menu.Item>
        </>
      )}
    </>
  );
}

function ProfileChoiceItems({
  Menu,
  choice,
  unsetLabel,
  onOpenProfileManager,
}: {
  Menu: MenuParts;
  choice: ProfileChoice;
  unsetLabel: string;
  onOpenProfileManager?: () => void;
}) {
  return (
    <>
      {choice.profiles.map(profile => {
        const current = choice.currentProfileId === profile.id;
        return (
          <Menu.Item
            key={profile.id}
            data-current={current ? "true" : undefined}
            onSelect={() => choice.onSelect(profile.id)}
          >
            <CheckMark checked={current} />
            <span className="truncate">{profile.name}</span>
          </Menu.Item>
        );
      })}
      {choice.profiles.length > 0 && <Menu.Separator />}
      <Menu.Item
        data-current={choice.currentProfileId === null ? "true" : undefined}
        onSelect={() => choice.onSelect(null)}
      >
        <CheckMark checked={choice.currentProfileId === null} />
        <span className="truncate">{unsetLabel}</span>
      </Menu.Item>
      {onOpenProfileManager && (
        <>
          <Menu.Separator />
          <Menu.Item onSelect={onOpenProfileManager}>
            <Settings />
            プロファイル管理を開く...
          </Menu.Item>
        </>
      )}
    </>
  );
}

function CheckMark({ checked }: { checked: boolean }) {
  return checked ? (
    <Check className="text-primary" />
  ) : (
    <span className="size-4 shrink-0" aria-hidden="true" />
  );
}
```

- [ ] **Step 5: 実行して通過を確認する**

Run: `pnpm vitest run packages/web/src/components/SessionRowMenu.test.tsx`
Expected: PASS (`Tests  7 passed (7)`)

- [ ] **Step 6: コミットする**

```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper
git branch --show-current
pnpm biome check --write packages/web/src/components/SessionRowMenu.tsx packages/web/src/components/SessionRowMenu.test.tsx
git add packages/web/src/components/SessionRowMenu.tsx packages/web/src/components/SessionRowMenu.test.tsx
git commit -m "feat(web): 右クリックと…で共有するセッション行メニューを追加"
```

- [ ] **Step 7: 行の失敗するテストを書く**

`packages/web/src/components/SessionListRow.test.tsx` を作る。メニューの部品は素通しにし、`SessionRowMenu` はどの形で置かれたかだけを記録する。

```tsx
// @vitest-environment jsdom

import type { ManagedSession, Profile, Worktree } from "@ark/shared";
import {
  act,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionListEntry } from "@/lib/session-sections";
import { presentStatus } from "@/lib/status-tone";
import { resolveSessionRowProfile, SessionListRow } from "./SessionListRow";

const testDoubles = vi.hoisted(() => ({
  rowMenuVariants: vi.fn(),
}));

vi.mock("./SessionRowMenu", () => ({
  SessionRowMenu: ({ variant }: { variant: string }) => {
    testDoubles.rowMenuVariants(variant);
    return null;
  },
}));

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children?: ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
  ContextMenuContent: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
}));

const worktree: Worktree = {
  id: "wt-1",
  path: "/work/app/.worktrees/login",
  branch: "feature/login",
  commit: "abc1234",
  isMain: false,
  isBare: false,
};
const session: ManagedSession = {
  id: "session-1",
  worktreeId: worktree.id,
  worktreePath: worktree.path,
  repoPath: "/work/app",
  status: "active",
  createdAt: new Date("2026-09-17T00:00:00Z"),
  tmuxSessionName: "ark-session-1",
  ttydPort: 7680,
  ttydUrl: "/ttyd/session-1/",
};
const profiles: Profile[] = [
  {
    id: "p-work",
    name: "仕事",
    configDir: "/home/me/.claude-work",
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "p-home",
    name: "個人",
    configDir: "/home/me/.claude-home",
    createdAt: 0,
    updatedAt: 0,
  },
];

function entryOf(overrides: Partial<SessionListEntry> = {}): SessionListEntry {
  return {
    key: "wt:wt-1",
    worktree,
    session,
    repoPath: "/work/app",
    repoName: "app",
    disambiguator: "work",
    statusKey: "IDLE",
    ...overrides,
  };
}

function rowProps(
  overrides: Partial<ComponentProps<typeof SessionListRow>> = {}
): ComponentProps<typeof SessionListRow> {
  return {
    variant: "sidebar",
    entry: entryOf(),
    displayName: null,
    previewText: "テストを実行しています",
    profile: null,
    staleProfile: false,
    selected: false,
    editing: false,
    onEditingChange: vi.fn(),
    onSaveDisplayName: vi.fn(),
    menu: { onOpen: vi.fn() },
    onMenuOpenChange: vi.fn(),
    ...overrides,
  };
}

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function mount(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mountedRoots.push({ root, container });
  return container;
}

/** 行を押せる要素 (data-session-key)。主ラベル・2行目・チップはこの中にある */
function openAreaOf(container: ParentNode): HTMLElement {
  const openArea = container.querySelector<HTMLElement>(
    '[data-session-key="wt:wt-1"]'
  );
  expect(openArea).not.toBeNull();
  return openArea as HTMLElement;
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  act(() => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressKey(
  target: HTMLElement,
  key: string,
  init: KeyboardEventInit = {}
): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, ...init })
    );
  });
}

function editingInput(container: ParentNode): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="表示名を編集"]'
  );
  expect(input).not.toBeNull();
  return input as HTMLInputElement;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  testDoubles.rowMenuVariants.mockClear();
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("SessionListRowの中身", () => {
  it("表示名が無ければリポジトリ名を主ラベルにし、見分け用の親ディレクトリ名を後ろに添える", () => {
    const openArea = openAreaOf(mount(<SessionListRow {...rowProps()} />));

    expect(openArea.getAttribute("role")).toBe("button");
    expect(openArea.getAttribute("title")).toBe("/work/app");
    const label = openArea.querySelector('[data-testid="session-row-label"]');
    expect(label?.childNodes[0]?.textContent).toBe("app");
    expect(
      label?.querySelector('[data-testid="session-row-disambiguator"]')
        ?.textContent
    ).toBe("work");
    expect(
      openArea.querySelector('[data-testid="session-row-detail"]')?.textContent
    ).toBe("feature/login·テストを実行しています");
    expect(openArea.textContent).toContain(presentStatus("IDLE").label);
  });

  it("表示名があれば主ラベルにし、2行目の先頭にリポジトリ名を足す", () => {
    const openArea = openAreaOf(
      mount(<SessionListRow {...rowProps({ displayName: "ログイン画面" })} />)
    );

    expect(
      openArea.querySelector('[data-testid="session-row-label"]')?.textContent
    ).toBe("ログイン画面");
    expect(
      openArea.querySelector('[data-testid="session-row-detail"]')?.textContent
    ).toBe("appwork·feature/login·テストを実行しています");
  });

  it("プロファイルは未割り当てならチップを出さず、割り当てがあれば名前を、個別の上書きには「個別」を添える", () => {
    const none = openAreaOf(mount(<SessionListRow {...rowProps()} />));
    expect(none.querySelector('[data-testid="session-row-profile"]')).toBeNull();

    const inherited = openAreaOf(
      mount(
        <SessionListRow
          {...rowProps({ profile: { name: "仕事", individual: false } })}
        />
      )
    );
    expect(
      inherited.querySelector('[data-testid="session-row-profile"]')
        ?.textContent
    ).toBe("仕事");

    mountedRoots.splice(0).forEach(({ root, container }) => {
      act(() => root.unmount());
      container.remove();
    });
    const individual = openAreaOf(
      mount(
        <SessionListRow
          {...rowProps({ profile: { name: "仕事", individual: true } })}
        />
      )
    );
    expect(
      individual.querySelector('[data-testid="session-row-profile"]')
        ?.textContent
    ).toBe("仕事個別");
  });

  it("古い設定の警告と再起動を出し、再起動は行メニューと同じ操作を呼ぶ", () => {
    const menu = { onOpen: vi.fn(), onRestart: vi.fn() };
    const container = mount(
      <SessionListRow {...rowProps({ staleProfile: true, menu })} />
    );

    expect(container.textContent).toContain("古い設定");
    const restart = Array.from(container.querySelectorAll("button")).find(
      button => button.textContent === "再起動"
    );
    act(() => restart?.click());

    expect(menu.onRestart).toHaveBeenCalledTimes(1);
    expect(menu.onOpen).not.toHaveBeenCalled();
  });

  it("行を押すかEnterで開く操作を呼ぶ", () => {
    const menu = { onOpen: vi.fn() };
    const openArea = openAreaOf(
      mount(<SessionListRow {...rowProps({ menu })} />)
    );

    act(() => openArea.click());
    pressKey(openArea, "Enter");

    expect(menu.onOpen).toHaveBeenCalledTimes(2);
  });

  it("行を押してもフォーカスを受け取らず、一覧の中に残っていたフォーカスは外す", () => {
    const container = mount(
      <div data-session-list="">
        <SessionListRow {...rowProps()} />
      </div>
    );
    const menuButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="appのメニュー"]'
    );
    const openArea = openAreaOf(container);
    act(() => menuButton?.focus());
    expect(document.activeElement).toBe(menuButton);

    const mouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      openArea.dispatchEvent(mouseDown);
    });

    expect(mouseDown.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.body);
  });

  it("sidebarは右クリックと…の2か所、cardは⋮の1か所に行メニューを置く", () => {
    const sidebar = mount(<SessionListRow {...rowProps()} />);
    expect(
      sidebar.querySelector('button[aria-label="appのメニュー"]')
    ).not.toBeNull();
    expect(
      new Set(testDoubles.rowMenuVariants.mock.calls.map(([variant]) => variant))
    ).toEqual(new Set(["context", "dropdown"]));

    testDoubles.rowMenuVariants.mockClear();
    mount(<SessionListRow {...rowProps({ variant: "card" })} />);
    expect(
      new Set(testDoubles.rowMenuVariants.mock.calls.map(([variant]) => variant))
    ).toEqual(new Set(["dropdown"]));
  });
});

describe("SessionListRowの表示名の編集", () => {
  it("編集を始めると今の主ラベルを入れた入力欄にフォーカスし、Enterで前後の空白を除いて保存する", () => {
    const props = rowProps({ editing: true, displayName: "旧名" });
    const container = mount(<SessionListRow {...props} />);
    const input = editingInput(container);

    expect(input.value).toBe("旧名");
    expect(document.activeElement).toBe(input);

    typeInto(input, "  新しい名前 ");
    pressKey(input, "Enter");

    expect(props.onSaveDisplayName).toHaveBeenCalledWith("新しい名前");
    expect(props.onEditingChange).toHaveBeenCalledWith(false);
  });

  it("空、またはリポジトリ名と同じ値を保存すると表示名を解除する", () => {
    const emptied = rowProps({ editing: true, displayName: "旧名" });
    const emptyInput = editingInput(mount(<SessionListRow {...emptied} />));
    typeInto(emptyInput, "   ");
    pressKey(emptyInput, "Enter");
    expect(emptied.onSaveDisplayName).toHaveBeenCalledWith(null);

    mountedRoots.splice(0).forEach(({ root, container }) => {
      act(() => root.unmount());
      container.remove();
    });
    const sameAsRepo = rowProps({ editing: true, displayName: "旧名" });
    const repoInput = editingInput(mount(<SessionListRow {...sameAsRepo} />));
    typeInto(repoInput, "app");
    pressKey(repoInput, "Enter");
    expect(sameAsRepo.onSaveDisplayName).toHaveBeenCalledWith(null);
  });

  it("Escapeでは保存せずに編集を終え、値が変わっていなければ保存を呼ばない", () => {
    const canceled = rowProps({ editing: true, displayName: "旧名" });
    const input = editingInput(mount(<SessionListRow {...canceled} />));
    typeInto(input, "取り消す名前");
    pressKey(input, "Escape");
    expect(canceled.onSaveDisplayName).not.toHaveBeenCalled();
    expect(canceled.onEditingChange).toHaveBeenCalledWith(false);

    mountedRoots.splice(0).forEach(({ root, container }) => {
      act(() => root.unmount());
      container.remove();
    });
    const unchanged = rowProps({ editing: true, displayName: "旧名" });
    const sameInput = editingInput(mount(<SessionListRow {...unchanged} />));
    pressKey(sameInput, "Enter");
    expect(unchanged.onSaveDisplayName).not.toHaveBeenCalled();
    expect(unchanged.onEditingChange).toHaveBeenCalledWith(false);
  });

  it("日本語入力の変換中のEnterでは保存せず、入力欄の外に出たら保存する", () => {
    const props = rowProps({ editing: true, displayName: null });
    const input = editingInput(mount(<SessionListRow {...props} />));
    typeInto(input, "ろぐいん");
    pressKey(input, "Enter", { isComposing: true });
    expect(props.onSaveDisplayName).not.toHaveBeenCalled();

    act(() => input.blur());
    expect(props.onSaveDisplayName).toHaveBeenCalledWith("ろぐいん");
  });
});

describe("resolveSessionRowProfile", () => {
  const profileById = new Map(profiles.map(profile => [profile.id, profile]));
  const worktreePath = worktree.path;

  it("プロファイル機能が無効ならnull", () => {
    expect(
      resolveSessionRowProfile({
        enabled: false,
        worktreePath,
        repoPath: "/work/app",
        profileById,
        repoProfileLinks: new Map([["/work/app", "p-work"]]),
      })
    ).toBeNull();
  });

  it("worktree個別の上書きを優先し、個別であることを返す", () => {
    expect(
      resolveSessionRowProfile({
        enabled: true,
        worktreePath,
        repoPath: "/work/app",
        profileById,
        repoProfileLinks: new Map([["/work/app", "p-work"]]),
        worktreeProfileLinks: new Map([[worktreePath, "p-home"]]),
      })
    ).toEqual({ name: "個人", individual: true });
  });

  it("個別が無ければリポジトリの既定を継承する", () => {
    expect(
      resolveSessionRowProfile({
        enabled: true,
        worktreePath,
        repoPath: "/work/app",
        profileById,
        repoProfileLinks: new Map([["/work/app", "p-work"]]),
        worktreeProfileLinks: new Map(),
      })
    ).toEqual({ name: "仕事", individual: false });
  });

  it("どちらも未割り当て、または削除済みのプロファイルならnull", () => {
    expect(
      resolveSessionRowProfile({
        enabled: true,
        worktreePath,
        repoPath: "/work/app",
        profileById,
      })
    ).toBeNull();
    expect(
      resolveSessionRowProfile({
        enabled: true,
        worktreePath,
        repoPath: "/work/app",
        profileById,
        repoProfileLinks: new Map([["/work/app", "p-deleted"]]),
      })
    ).toBeNull();
  });
});
```

- [ ] **Step 8: 実行して失敗を確認する**

Run: `pnpm vitest run packages/web/src/components/SessionListRow.test.tsx`
Expected: FAIL。`Error: Failed to resolve import "./SessionListRow" from "packages/web/src/components/SessionListRow.test.tsx". Does the file exist?`

- [ ] **Step 9: 行を実装する**

`packages/web/src/components/SessionListRow.tsx` を作る。寸法は参照モック `A-pc.html` の `.row` (縦10px・横12px・12px角丸・選択中は白いカード + 罫線 + 影) と `A-mobile-list.html` の `.card` (縦12px・横14px) に合わせる。

```tsx
/**
 * SessionListRow - セッション一覧の1行 (PCサイドバーの行 / モバイル一覧のカード)
 *
 * 1行目は「状態チップ + 主ラベル」、2行目は「プロファイル + ブランチ · プレビュー文」。
 * 主ラベルは表示名があれば表示名、無ければリポジトリ名。行のtitleはリポジトリの絶対パス。
 * 行メニューはsidebarでは右クリックと `…`、cardでは `⋮` で開き、中身は同じ。
 */

import type { Profile } from "@ark/shared";
import { Ellipsis, MoreVertical, RotateCw, TriangleAlert } from "lucide-react";
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SessionListEntry } from "@/lib/session-sections";
import { cn } from "@/lib/utils";
import { getBaseName } from "@/utils/pathUtils";
import { SessionRowMenu, type SessionRowMenuProps } from "./SessionRowMenu";
import { StatusChip } from "./StatusChip";

export interface SessionRowProfile {
  name: string;
  /** worktree個別の上書きならtrue (リポジトリの既定を継承していればfalse) */
  individual: boolean;
}

/** 行に出すプロファイル。未割り当て (~/.claude) や機能が無効なときはnull */
export function resolveSessionRowProfile(input: {
  enabled: boolean;
  worktreePath: string | null;
  repoPath: string;
  profileById: ReadonlyMap<string, Profile>;
  repoProfileLinks?: ReadonlyMap<string, string>;
  worktreeProfileLinks?: ReadonlyMap<string, string>;
}): SessionRowProfile | null {
  if (!input.enabled) return null;
  const worktreeProfileId = input.worktreePath
    ? (input.worktreeProfileLinks?.get(input.worktreePath) ?? null)
    : null;
  const profileId =
    worktreeProfileId ?? input.repoProfileLinks?.get(input.repoPath) ?? null;
  const profile = profileId ? input.profileById.get(profileId) : undefined;
  if (!profile) return null;
  return { name: profile.name, individual: worktreeProfileId !== null };
}

export interface SessionListRowProps {
  /** "sidebar" = PCサイドバーの行、"card" = モバイル一覧のカード */
  variant: "sidebar" | "card";
  entry: SessionListEntry;
  /** 表示名 (前後の空白を除いた値。未設定ならnull) */
  displayName: string | null;
  /** 端末の最後の内容行。空なら2行目に出さない */
  previewText: string;
  /** プロファイルのチップ。未割り当てならnull */
  profile: SessionRowProfile | null;
  /** 起動後にプロファイルの割り当てが変わった (再起動が要る) */
  staleProfile: boolean;
  selected: boolean;
  /** 表示名を編集中か。どの行を編集するかは一覧が持つ */
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  /** 表示名を保存する。nullで解除 (主ラベルはリポジトリ名に戻る) */
  onSaveDisplayName?: (displayName: string | null) => void;
  menu: Omit<SessionRowMenuProps, "variant" | "entry">;
  /** 行メニューの開閉。一覧の並び替えの保留に使う */
  onMenuOpenChange: (open: boolean) => void;
}

export function SessionListRow({
  variant,
  entry,
  displayName,
  previewText,
  profile,
  staleProfile,
  selected,
  editing,
  onEditingChange,
  onSaveDisplayName,
  menu,
  onMenuOpenChange,
}: SessionListRowProps) {
  const primaryLabel = displayName ?? entry.repoName;
  const branch =
    entry.worktree?.branch ?? getBaseName(entry.session?.worktreePath ?? "");
  const quiet = entry.statusKey === "NOT_STARTED" || entry.statusKey === "STOP";

  // 入力途中の表示名。編集の開始と終了に合わせて、レンダー中に用意・破棄する
  const [draft, setDraft] = useState<string | null>(null);
  if (editing && draft === null) setDraft(primaryLabel);
  if (!editing && draft !== null) setDraft(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const cancelEditRef = useRef(false);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  // 保存と取り消しはblurに一本化する。Enter / Escapeはblurを起こすだけにし、
  // 入力欄が消えるときにblurを出さないブラウザでも、一覧からフォーカスが確実に抜けるようにする
  const finishEditing = () => {
    const canceled = cancelEditRef.current;
    cancelEditRef.current = false;
    if (!canceled && draft !== null) {
      const trimmed = draft.trim();
      const next =
        trimmed === "" || trimmed === entry.repoName ? null : trimmed;
      if (next !== displayName) onSaveDisplayName?.(next);
    }
    onEditingChange(false);
  };

  const handleEditKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    // 日本語入力の変換を確定するEnterでは保存しない
    if (event.nativeEvent.isComposing) return;
    if (event.key !== "Enter" && event.key !== "Escape") return;
    event.preventDefault();
    cancelEditRef.current = event.key === "Escape";
    event.currentTarget.blur();
  };

  const handleRowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    menu.onOpen();
  };

  // メニューが閉じるとき、Radixは直前のフォーカス先 (行や `…`) へフォーカスを戻す。
  // 「表示名を変更」を選んだ直後は、入力欄のフォーカスを奪わせない
  const keepFocusWhileEditing = (event: Event) => {
    if (editing) event.preventDefault();
  };

  const detailSegments: { key: string; node: ReactNode }[] = [];
  if (displayName !== null) {
    detailSegments.push({
      key: "repo",
      node: (
        <>
          {entry.repoName}
          {entry.disambiguator && (
            <span className="ml-1">{entry.disambiguator}</span>
          )}
        </>
      ),
    });
  }
  if (branch) {
    detailSegments.push({
      key: "branch",
      node: <span className="text-foreground/80">{branch}</span>,
    });
  }
  if (previewText) {
    detailSegments.push({ key: "preview", node: previewText });
  }

  const row = (
    <div
      className={cn(
        "group rounded-lg border transition-colors",
        variant === "sidebar"
          ? cn(
              "px-3 py-2.5",
              selected
                ? "border-border bg-card shadow-card"
                : "border-transparent hover:bg-sidebar-accent"
            )
          : cn(
              "border-border px-3.5 py-3 active:bg-accent",
              quiet ? "bg-transparent" : "bg-card shadow-card"
            )
      )}
    >
      <div className="flex items-start gap-1">
        <div
          role="button"
          tabIndex={0}
          data-session-key={entry.key}
          title={entry.repoPath}
          aria-current={selected ? "true" : undefined}
          className="min-w-0 flex-1 cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={menu.onOpen}
          onKeyDown={handleRowKeyDown}
          // マウスで押しただけで一覧にフォーカスが残ると、並び替えの保留が解けなくなる。
          // キーボードのフォーカスは残す。編集中は入力欄のカーソル操作を妨げない
          onMouseDown={event => {
            if (editing) return;
            event.preventDefault();
            // 直前に `…` のメニューを使うと、閉じたときにフォーカスがそのボタンへ戻って残る。
            // 一覧の中にフォーカスがあるときだけ外す (メインペインの入力欄のフォーカスは奪わない)
            const active = document.activeElement;
            if (
              active instanceof HTMLElement &&
              event.currentTarget
                .closest("[data-session-list]")
                ?.contains(active)
            ) {
              active.blur();
            }
          }}
        >
          <div className="flex min-w-0 items-center gap-2">
            <StatusChip statusKey={entry.statusKey} />
            {editing ? (
              <input
                ref={inputRef}
                type="text"
                // size=1でinputの既定の最小幅 (20文字分) を外し、狭いサイドバーでも親を押し広げない
                size={1}
                value={draft ?? ""}
                onChange={event => setDraft(event.target.value)}
                onClick={event => event.stopPropagation()}
                onKeyDown={handleEditKeyDown}
                onBlur={finishEditing}
                maxLength={200}
                aria-label="表示名を編集"
                className="h-7 w-0 min-w-0 flex-1 rounded-sm border border-input bg-background px-1.5 text-[15px] font-semibold text-foreground outline-none focus:border-ring"
              />
            ) : (
              <span
                data-testid="session-row-label"
                className={cn(
                  "min-w-0 flex-1 truncate text-[15px] font-semibold",
                  quiet ? "text-muted-foreground" : "text-foreground"
                )}
              >
                {primaryLabel}
                {displayName === null && entry.disambiguator && (
                  <span
                    data-testid="session-row-disambiguator"
                    className="ml-1.5 font-normal text-muted-foreground"
                  >
                    {entry.disambiguator}
                  </span>
                )}
              </span>
            )}
          </div>
          {(profile || detailSegments.length > 0) && (
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
              {profile && (
                <span
                  data-testid="session-row-profile"
                  className="inline-flex h-5 max-w-[9rem] shrink-0 items-center gap-1 rounded-full bg-muted px-2 text-xs font-medium text-muted-foreground"
                >
                  <span className="truncate">{profile.name}</span>
                  {profile.individual && (
                    <span className="shrink-0">個別</span>
                  )}
                </span>
              )}
              <span
                data-testid="session-row-detail"
                className="min-w-0 truncate"
              >
                {detailSegments.map((segment, index) => (
                  <Fragment key={segment.key}>
                    {index > 0 && (
                      <span aria-hidden="true" className="mx-1.5">
                        ·
                      </span>
                    )}
                    {segment.node}
                  </Fragment>
                ))}
              </span>
            </div>
          )}
        </div>
        <DropdownMenu onOpenChange={onMenuOpenChange}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`${primaryLabel}のメニュー`}
              className={cn(
                "inline-flex shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground",
                variant === "sidebar"
                  ? "h-7 w-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                  : "-mr-2 -mt-1 h-10 w-10"
              )}
            >
              {variant === "sidebar" ? (
                <Ellipsis className="size-4" />
              ) : (
                <MoreVertical className="size-5" />
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-64"
            onCloseAutoFocus={keepFocusWhileEditing}
          >
            <SessionRowMenu variant="dropdown" entry={entry} {...menu} />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {staleProfile && (
        <div className="mt-2 flex items-center gap-1.5">
          <span
            className="inline-flex h-6 items-center gap-1 rounded-full bg-status-awaiting/15 px-2 text-xs font-semibold text-status-awaiting"
            title="プロファイルの割り当てが変わりました。このセッションは元の設定で動いています"
          >
            <TriangleAlert className="size-3.5" aria-hidden="true" />
            古い設定
          </span>
          {menu.onRestart && (
            <button
              type="button"
              onClick={menu.onRestart}
              className="inline-flex h-6 items-center gap-1 rounded-full bg-status-awaiting/15 px-2 text-xs font-semibold text-status-awaiting transition-colors hover:bg-status-awaiting/25"
            >
              <RotateCw className="size-3.5" aria-hidden="true" />
              再起動
            </button>
          )}
        </div>
      )}
    </div>
  );

  if (variant === "card") return row;

  return (
    <ContextMenu onOpenChange={onMenuOpenChange}>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent
        className="w-64"
        onCloseAutoFocus={keepFocusWhileEditing}
      >
        <SessionRowMenu variant="context" entry={entry} {...menu} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
```

- [ ] **Step 10: 実行して通過を確認する**

Run: `pnpm vitest run packages/web/src/components/SessionListRow.test.tsx`
Expected: PASS (`Tests  15 passed (15)`)

- [ ] **Step 11: コミットする**

```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper
git branch --show-current
pnpm biome check --write packages/web/src/components/SessionListRow.tsx packages/web/src/components/SessionListRow.test.tsx
git add packages/web/src/components/SessionListRow.tsx packages/web/src/components/SessionListRow.test.tsx
git commit -m "feat(web): 状態チップと主ラベルを出すセッション一覧の行を追加"
```

- [ ] **Step 12: 一覧の失敗するテストを書く**

`packages/web/src/components/SessionSectionList.test.tsx` を作る。行メニューは渡されたpropsを行のkeyごとに記録するだけにし、確認ダイアログ (`AlertDialog`) は本物を使う。

```tsx
// @vitest-environment jsdom

import type {
  BridgeSessionStatus,
  ManagedSession,
  Profile,
  Worktree,
} from "@ark/shared";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { presentStatus } from "@/lib/status-tone";
import {
  SessionSectionList,
  type SessionSectionListProps,
} from "./SessionSectionList";
import type { SessionRowMenuProps } from "./SessionRowMenu";

const testDoubles = vi.hoisted(() => ({
  menuProps: new Map<string, unknown>(),
}));

vi.mock("./SessionRowMenu", () => ({
  SessionRowMenu: (props: { entry: { key: string } }) => {
    testDoubles.menuProps.set(props.entry.key, props);
    return null;
  },
}));

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children?: ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
  ContextMenuContent: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
}));

const repoPath = "/work/app";

function makeWorktree(id: string): Worktree {
  return {
    id,
    path: `${repoPath}/.worktrees/${id}`,
    branch: `feature/${id}`,
    commit: "abc1234",
    isMain: false,
    isBare: false,
  };
}

function makeSession(worktree: Worktree): ManagedSession {
  return {
    id: `session-${worktree.id}`,
    worktreeId: worktree.id,
    worktreePath: worktree.path,
    repoPath,
    status: "active",
    createdAt: new Date("2026-09-17T00:00:00Z"),
    tmuxSessionName: `ark-${worktree.id}`,
    ttydPort: 7680,
    ttydUrl: `/ttyd/${worktree.id}/`,
  };
}

const worktrees = ["a", "b", "c"].map(makeWorktree);
const sessions = new Map(
  worktrees.map(worktree => {
    const session = makeSession(worktree);
    return [session.id, session] as const;
  })
);
const profiles: Profile[] = [
  {
    id: "p-work",
    name: "仕事",
    configDir: "/home/me/.claude-work",
    createdAt: 0,
    updatedAt: 0,
  },
];

function statusesOf(
  a: BridgeSessionStatus,
  b: BridgeSessionStatus,
  c: BridgeSessionStatus
): Map<string, BridgeSessionStatus> {
  return new Map([
    ["session-a", a],
    ["session-b", b],
    ["session-c", c],
  ]);
}

function listProps(
  overrides: Partial<SessionSectionListProps> = {}
): SessionSectionListProps {
  return {
    variant: "sidebar",
    sessions,
    worktrees,
    repoList: [repoPath],
    sessionStatuses: statusesOf("IDLE", "TOOL", "READY"),
    sessionPreviews: new Map([["session-a", "どちらにしますか"]]),
    selectedSessionId: null,
    onOpenSession: vi.fn(),
    onStartSession: vi.fn(),
    onDeleteSession: vi.fn(),
    ...overrides,
  };
}

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function mountList(props: SessionSectionListProps) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<SessionSectionList {...props} />));
  mountedRoots.push({ root, container });
  return {
    container,
    rerender: (next: SessionSectionListProps) =>
      act(() => root.render(<SessionSectionList {...next} />)),
  };
}

/** 一覧の直下の並び。見出し (data-section) は"# 見出しの文言"、行はdata-session-keyの値 */
function sequence(container: HTMLElement): string[] {
  const list = container.querySelector("[data-session-list]");
  return Array.from(list?.children ?? []).map(element =>
    element.hasAttribute("data-section")
      ? `# ${element.firstElementChild?.textContent ?? ""}`
      : (element
          .querySelector("[data-session-key]")
          ?.getAttribute("data-session-key") ?? "?")
  );
}

/** 行を押せる要素 (data-session-key) を含む、一覧の直下の要素 */
function rowElementOf(container: HTMLElement, key: string): HTMLElement {
  let element = container.querySelector<HTMLElement>(
    `[data-session-key="${key}"]`
  );
  while (
    element &&
    !element.parentElement?.hasAttribute("data-session-list")
  ) {
    element = element.parentElement;
  }
  expect(element).not.toBeNull();
  return element as HTMLElement;
}

function pressableOf(container: HTMLElement, key: string): HTMLElement {
  const pressable = container.querySelector<HTMLElement>(
    `[data-session-key="${key}"]`
  );
  expect(pressable).not.toBeNull();
  return pressable as HTMLElement;
}

function menuOf(key: string): SessionRowMenuProps {
  const props = testDoubles.menuProps.get(key);
  expect(props).toBeDefined();
  return props as SessionRowMenuProps;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  testDoubles.menuProps.clear();
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("SessionSectionListの並べ方", () => {
  it("注意の順に3セクションで並べ、「あなたの番」に件数を出し、空のセクションは出さない", () => {
    const { container } = mountList(
      listProps({ sessionStatuses: statusesOf("IDLE", "TOOL", "AWAITING") })
    );

    expect(sequence(container)).toEqual([
      "# あなたの番",
      "wt:c",
      "wt:a",
      "# 作業中",
      "wt:b",
    ]);
    expect(
      container.querySelector('[data-section="your-turn"] [data-testid="section-count"]')
        ?.textContent
    ).toBe("2");
    expect(container.querySelector('[data-section="resting"]')).toBeNull();
  });

  it("セクションをまたいで移っても、行は同じ親の同じDOM要素のまま", () => {
    const props = listProps();
    const { container, rerender } = mountList(props);
    expect(sequence(container)).toEqual([
      "# あなたの番",
      "wt:a",
      "# 作業中",
      "wt:b",
      "# 休止中",
      "wt:c",
    ]);
    const list = container.querySelector("[data-session-list]");
    const rowB = rowElementOf(container, "wt:b");
    const pressableB = pressableOf(container, "wt:b");

    rerender({
      ...props,
      sessionStatuses: statusesOf("IDLE", "AWAITING", "READY"),
    });

    expect(sequence(container)).toEqual([
      "# あなたの番",
      "wt:b",
      "wt:a",
      "# 休止中",
      "wt:c",
    ]);
    expect(rowElementOf(container, "wt:b")).toBe(rowB);
    expect(pressableOf(container, "wt:b")).toBe(pressableB);
    expect(rowB.parentElement).toBe(list);
  });

  it("一覧の中にフォーカスがある間は、行がセクションをまたいでも位置を保ってチップと件数だけ更新し、フォーカスが外れたら並べ直す", () => {
    const props = listProps({
      sessionStatuses: statusesOf("IDLE", "TOOL", "THINK"),
    });
    const { container, rerender } = mountList(props);
    expect(sequence(container)).toEqual([
      "# あなたの番",
      "wt:a",
      "# 作業中",
      "wt:b",
      "wt:c",
    ]);
    const openA = pressableOf(container, "wt:a");
    act(() => openA.focus());

    rerender({
      ...props,
      sessionStatuses: statusesOf("IDLE", "AWAITING", "THINK"),
    });

    expect(sequence(container)).toEqual([
      "# あなたの番",
      "wt:a",
      "# 作業中",
      "wt:b",
      "wt:c",
    ]);
    expect(pressableOf(container, "wt:b").textContent).toContain(
      presentStatus("AWAITING").label
    );
    expect(
      container.querySelector('[data-testid="section-count"]')?.textContent
    ).toBe("2");

    act(() => openA.blur());

    expect(sequence(container)).toEqual([
      "# あなたの番",
      "wt:b",
      "wt:a",
      "# 作業中",
      "wt:c",
    ]);
  });

  it("保留中にセクションが空になると、その見出しは消えるが行の順は保つ", () => {
    const props = listProps();
    const { container, rerender } = mountList(props);
    act(() => pressableOf(container, "wt:a").focus());

    rerender({
      ...props,
      sessionStatuses: statusesOf("IDLE", "AWAITING", "READY"),
    });

    expect(sequence(container)).toEqual([
      "# あなたの番",
      "wt:a",
      "wt:b",
      "# 休止中",
      "wt:c",
    ]);
  });

  it("保留中に初めて出たセクションの見出しは、直後に行が無ければ描かない", () => {
    const props = listProps({
      sessionStatuses: statusesOf("TOOL", "TOOL", "TOOL"),
    });
    const { container, rerender } = mountList(props);
    act(() => pressableOf(container, "wt:a").focus());

    rerender({
      ...props,
      sessionStatuses: statusesOf("IDLE", "TOOL", "TOOL"),
    });

    expect(sequence(container)).toEqual(["# 作業中", "wt:a", "wt:b", "wt:c"]);
    expect(container.querySelector('[data-section="your-turn"]')).toBeNull();
  });

  it("…のメニューを閉じてフォーカスがボタンに残っても、行を押せば保留が解けて並べ直す", () => {
    const props = listProps({
      sessionStatuses: statusesOf("IDLE", "TOOL", "THINK"),
    });
    const { container, rerender } = mountList(props);
    const menuButtonA = rowElementOf(container, "wt:a").querySelector<HTMLButtonElement>(
      'button[aria-label="appのメニュー"]'
    );
    act(() => menuButtonA?.focus());

    rerender({
      ...props,
      sessionStatuses: statusesOf("IDLE", "AWAITING", "THINK"),
    });
    expect(sequence(container)).toEqual([
      "# あなたの番",
      "wt:a",
      "# 作業中",
      "wt:b",
      "wt:c",
    ]);

    act(() => {
      pressableOf(container, "wt:b").dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      );
    });

    expect(sequence(container)).toEqual([
      "# あなたの番",
      "wt:b",
      "wt:a",
      "# 作業中",
      "wt:c",
    ]);
  });

  it("行が1件も無ければ新規作成の案内を出す", () => {
    const { container } = mountList(listProps({ repoList: [] }));

    expect(container.textContent).toContain("セッションがありません");
  });
});

describe("SessionSectionListの行メニューの配線", () => {
  it("「表示名を変更」でその行を編集にし、Enterでworktreeのパスと名前を保存する", () => {
    const onSetWorktreeDisplayName = vi.fn();
    const { container } = mountList(listProps({ onSetWorktreeDisplayName }));

    act(() => menuOf("wt:a").onStartRename?.());
    const input = container.querySelector<HTMLInputElement>(
      '[data-session-key="wt:a"] input[aria-label="表示名を編集"]'
    );
    expect(document.activeElement).toBe(input);

    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    act(() => {
      setValue?.call(input, "ログイン");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      input?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });

    expect(onSetWorktreeDisplayName).toHaveBeenCalledWith(
      worktrees[0].path,
      "ログイン"
    );
    expect(
      container.querySelector('input[aria-label="表示名を編集"]')
    ).toBeNull();
  });

  it("「削除」で確認ダイアログを出し、確定するとセッションとworktreeを渡す", () => {
    const onDeleteSession = vi.fn();
    mountList(listProps({ onDeleteSession }));

    act(() => menuOf("wt:b").onDelete?.());
    expect(document.body.textContent).toContain(
      "このセッションとWorktreeを削除しますか？関連するブランチも削除されます。"
    );
    const confirm = Array.from(document.body.querySelectorAll("button")).find(
      button => button.textContent === "削除"
    );
    act(() => confirm?.click());

    expect(onDeleteSession).toHaveBeenCalledWith("session-b", worktrees[1]);
  });

  it("RepoGridViewへの導線は、渡したときだけ行メニューに出す", () => {
    const onSelectRepoGrid = vi.fn();
    mountList(listProps({ onSelectRepoGrid }));

    act(() => menuOf("wt:a").onOpenRepoGrid?.());
    expect(onSelectRepoGrid).toHaveBeenCalledWith(repoPath);

    testDoubles.menuProps.clear();
    mountList(listProps());
    expect(menuOf("wt:a").onOpenRepoGrid).toBeUndefined();
  });

  it("プロファイルの項目とチップは、プロファイル機能が有効なときだけ出す", () => {
    const { container } = mountList(
      listProps({
        capabilities: { multiProfileSupported: true },
        profiles,
        repoProfileLinks: new Map([[repoPath, "p-work"]]),
        worktreeProfileLinks: new Map(),
        onSetWorktreeProfile: vi.fn(),
        onSetRepoProfile: vi.fn(),
        onOpenProfileManager: vi.fn(),
      })
    );

    expect(menuOf("wt:a").worktreeProfile).toMatchObject({
      currentProfileId: null,
      inheritedProfileName: "仕事",
    });
    expect(menuOf("wt:a").repoProfile).toMatchObject({
      currentProfileId: "p-work",
    });
    expect(
      container.querySelector(
        '[data-session-key="wt:a"] [data-testid="session-row-profile"]'
      )?.textContent
    ).toBe("仕事");

    testDoubles.menuProps.clear();
    const disabled = mountList(
      listProps({
        capabilities: { multiProfileSupported: false },
        profiles,
        repoProfileLinks: new Map([[repoPath, "p-work"]]),
        onSetWorktreeProfile: vi.fn(),
        onSetRepoProfile: vi.fn(),
        onOpenProfileManager: vi.fn(),
      })
    );
    expect(menuOf("wt:a").worktreeProfile).toBeUndefined();
    expect(menuOf("wt:a").repoProfile).toBeUndefined();
    expect(
      disabled.container.querySelector('[data-testid="session-row-profile"]')
    ).toBeNull();
  });
});
```

- [ ] **Step 13: 実行して失敗を確認する**

Run: `pnpm vitest run packages/web/src/components/SessionSectionList.test.tsx`
Expected: FAIL。`Error: Failed to resolve import "./SessionSectionList" from "packages/web/src/components/SessionSectionList.test.tsx". Does the file exist?`

- [ ] **Step 14: 一覧を実装する**

`packages/web/src/components/SessionSectionList.tsx` を作る。確認ダイアログの文言は今の `SessionCard` / `MobileSessionList` / `SessionSidebar` のものをそのまま使う。

```tsx
/**
 * SessionSectionList - PCサイドバーとモバイル一覧で共有するセッション一覧
 *
 * 行を「あなたの番 → 作業中 → 休止中」の注意の順に並べる。セクション見出しと行は
 * 同じ親の直下に安定したkeyで置き、セクションをまたいでも行を再マウントしない
 * (表示名の編集中の値やフォーカスを失わないため)。
 * ポインタ・フォーカス・メニュー・タッチの間は並びを保留し、チップと件数の表示だけ最新にする。
 * 行を押せる要素にdata-session-key、見出しにdata-sectionを付ける (撮影のスクリプトが使う)。
 * 行メニューから開く確認ダイアログ (削除・再起動・リポジトリの除外) もここで持つ。
 */

import type {
  BridgeSessionStatus,
  ManagedSession,
  Profile,
  SystemCapabilities,
  Worktree,
} from "@ark/shared";
import { useMemo, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useGroupedWorktreeItems } from "@/hooks/useGroupedWorktreeItems";
import { useHeldOrder, useListHold } from "@/hooks/useHeldOrder";
import {
  buildSessionEntries,
  type SessionListRow as ListRow,
  type SessionListEntry,
  sectionize,
  sortSessionEntries,
  toListRows,
} from "@/lib/session-sections";
import { SECTION_LABELS, TONE_CLASSES } from "@/lib/status-tone";
import { cn } from "@/lib/utils";
import { getBaseName } from "@/utils/pathUtils";
import { resolveSessionRowProfile, SessionListRow } from "./SessionListRow";
import type { SessionRowMenuProps } from "./SessionRowMenu";

export interface SessionSectionListProps {
  /** "sidebar" = PCサイドバーの行、"card" = モバイル一覧のカード */
  variant: "sidebar" | "card";
  sessions: Map<string, ManagedSession>;
  worktrees: Worktree[];
  repoList: string[];
  /** sessionId → BridgeSessionStatus (session:previews由来) */
  sessionStatuses: Map<string, BridgeSessionStatus>;
  /** sessionId → 端末の最後の内容行。2行目にそのまま出す */
  sessionPreviews: Map<string, string>;
  selectedSessionId: string | null;
  /** worktreePath → 表示名 */
  worktreeDisplayNames?: Map<string, string>;
  capabilities?: SystemCapabilities;
  profiles?: Profile[];
  repoProfileLinks?: Map<string, string>;
  /** worktreePath → profileIdの個別の上書き */
  worktreeProfileLinks?: Map<string, string>;
  notificationsSupported?: boolean;
  isSessionNotificationEnabled?: (sessionId: string) => boolean;
  onOpenSession: (sessionId: string) => void;
  onStartSession: (worktree: Worktree) => void;
  /** セッション削除 (停止 + メイン以外のWorktree削除) */
  onDeleteSession: (sessionId: string, worktree: Worktree | undefined) => void;
  /** 未起動のworktreeの削除。モバイルだけ渡す */
  onDeleteWorktree?: (worktree: Worktree) => void;
  /** 再起動 (tmux kill → 新セッション。会話履歴は失われる) */
  onRestartSession?: (sessionId: string) => void;
  onSetWorktreeDisplayName?: (
    worktreePath: string,
    displayName: string | null
  ) => void;
  onSessionNotificationEnabledChange?: (
    sessionId: string,
    enabled: boolean
  ) => void;
  onCreateWorktreeForRepo?: (repoPath: string) => void;
  /** リポジトリの全セッションを並べて見る (RepoGridView)。PCだけ渡す */
  onSelectRepoGrid?: (repoPath: string) => void;
  onRemoveRepo?: (repoPath: string) => void;
  onSetRepoProfile?: (repoPath: string, profileId: string | null) => void;
  onSetWorktreeProfile?: (
    worktreePath: string,
    profileId: string | null
  ) => void;
  onOpenProfileManager?: () => void;
}

type DeleteTarget =
  | { kind: "session"; sessionId: string; worktree: Worktree | undefined }
  | { kind: "worktree"; worktree: Worktree };

const NO_PROFILES: Profile[] = [];
const rowKey = (row: ListRow) => row.key;

function worktreePathOf(entry: SessionListEntry): string | null {
  return entry.worktree?.path ?? entry.session?.worktreePath ?? null;
}

function deleteDescription(target: DeleteTarget): string {
  if (target.kind === "worktree") {
    return "このWorktreeを削除しますか？関連するブランチも削除されます。";
  }
  if (target.worktree === undefined) return "このセッションを削除しますか？";
  return target.worktree.isMain
    ? "このセッションを削除しますか？メインWorktreeは削除されません。"
    : "このセッションとWorktreeを削除しますか？関連するブランチも削除されます。";
}

export function SessionSectionList({
  variant,
  sessions,
  worktrees,
  repoList,
  sessionStatuses,
  sessionPreviews,
  selectedSessionId,
  worktreeDisplayNames,
  capabilities,
  profiles,
  repoProfileLinks,
  worktreeProfileLinks,
  notificationsSupported = false,
  isSessionNotificationEnabled,
  onOpenSession,
  onStartSession,
  onDeleteSession,
  onDeleteWorktree,
  onRestartSession,
  onSetWorktreeDisplayName,
  onSessionNotificationEnabledChange,
  onCreateWorktreeForRepo,
  onSelectRepoGrid,
  onRemoveRepo,
  onSetRepoProfile,
  onSetWorktreeProfile,
  onOpenProfileManager,
}: SessionSectionListProps) {
  const { groupedItems } = useGroupedWorktreeItems(
    worktrees,
    sessions,
    repoList
  );
  const { held, bindings, onMenuOpenChange } = useListHold();
  const rows = useMemo(
    () =>
      toListRows(
        sectionize(
          sortSessionEntries(buildSessionEntries(groupedItems, sessionStatuses))
        )
      ),
    [groupedItems, sessionStatuses]
  );
  const shownRows = useHeldOrder(rows, rowKey, held);
  // 保留中に初めて出たセクションの見出しは並びの末尾に足される。直後に行が続かない見出しは描かない
  const visibleRows = shownRows.filter(
    (row, index) => row.kind === "entry" || shownRows[index + 1]?.kind === "entry"
  );

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [restartSessionId, setRestartSessionId] = useState<string | null>(
    null
  );
  const [removeRepoPath, setRemoveRepoPath] = useState<string | null>(null);

  const profileList = profiles ?? NO_PROFILES;
  const profileById = useMemo(
    () => new Map(profileList.map(profile => [profile.id, profile])),
    [profileList]
  );
  const multiProfileEnabled = capabilities?.multiProfileSupported === true;
  // プロファイルの項目は今と同じく、Linuxで管理ダイアログを開けるときだけ出す
  const canManageProfiles =
    multiProfileEnabled && onOpenProfileManager !== undefined;

  const buildMenu = (
    entry: SessionListEntry
  ): Omit<SessionRowMenuProps, "variant" | "entry"> => {
    const { session, worktree, repoPath } = entry;
    const worktreePath = worktreePathOf(entry);
    const worktreeProfileId = worktreePath
      ? (worktreeProfileLinks?.get(worktreePath) ?? null)
      : null;
    const repoProfileId = repoProfileLinks?.get(repoPath) ?? null;

    let onDelete: (() => void) | undefined;
    if (session) {
      onDelete = () =>
        setDeleteTarget({
          kind: "session",
          sessionId: session.id,
          worktree: worktree ?? undefined,
        });
    } else if (worktree && !worktree.isMain && onDeleteWorktree) {
      onDelete = () => setDeleteTarget({ kind: "worktree", worktree });
    }

    return {
      onOpen: () => {
        if (session) onOpenSession(session.id);
        else if (worktree) onStartSession(worktree);
      },
      onStartRename:
        onSetWorktreeDisplayName && worktreePath
          ? () => setEditingKey(entry.key)
          : undefined,
      notifications:
        session && notificationsSupported && onSessionNotificationEnabledChange
          ? {
              enabled: isSessionNotificationEnabled?.(session.id) ?? true,
              onChange: enabled =>
                onSessionNotificationEnabledChange(session.id, enabled),
            }
          : undefined,
      onRestart:
        session && onRestartSession
          ? () => setRestartSessionId(session.id)
          : undefined,
      worktreeProfile:
        canManageProfiles && onSetWorktreeProfile && worktreePath
          ? {
              profiles: profileList,
              currentProfileId: worktreeProfileId,
              inheritedProfileName: repoProfileId
                ? (profileById.get(repoProfileId)?.name ?? null)
                : null,
              onSelect: profileId =>
                onSetWorktreeProfile(worktreePath, profileId),
            }
          : undefined,
      onCreateWorktree: onCreateWorktreeForRepo
        ? () => onCreateWorktreeForRepo(repoPath)
        : undefined,
      onOpenRepoGrid: onSelectRepoGrid
        ? () => onSelectRepoGrid(repoPath)
        : undefined,
      repoProfile:
        canManageProfiles && onSetRepoProfile
          ? {
              profiles: profileList,
              currentProfileId: repoProfileId,
              onSelect: profileId => onSetRepoProfile(repoPath, profileId),
            }
          : undefined,
      onOpenProfileManager: canManageProfiles
        ? onOpenProfileManager
        : undefined,
      onRemoveRepo: onRemoveRepo
        ? () => setRemoveRepoPath(repoPath)
        : undefined,
      onDelete,
    };
  };

  const renderSection = (row: Extract<ListRow, { kind: "section" }>) => (
    <h2
      key={row.key}
      data-section={row.section}
      className={cn(
        "mt-4 flex h-7 items-center gap-2 text-[13px] font-semibold text-muted-foreground first:mt-0",
        variant === "sidebar" ? "px-3" : "px-1"
      )}
    >
      <span>{SECTION_LABELS[row.section]}</span>
      {row.section === "your-turn" && (
        <span
          data-testid="section-count"
          className={cn(
            "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-bold text-background",
            TONE_CLASSES.awaiting.solidBg
          )}
        >
          {row.count}
        </span>
      )}
    </h2>
  );

  const renderRow = (entry: SessionListEntry) => {
    const worktreePath = worktreePathOf(entry);
    const displayName = worktreePath
      ? worktreeDisplayNames?.get(worktreePath)?.trim() || null
      : null;
    return (
      <SessionListRow
        key={entry.key}
        variant={variant}
        entry={entry}
        displayName={displayName}
        previewText={
          entry.session ? (sessionPreviews.get(entry.session.id) ?? "") : ""
        }
        profile={resolveSessionRowProfile({
          enabled: multiProfileEnabled,
          worktreePath,
          repoPath: entry.repoPath,
          profileById,
          repoProfileLinks,
          worktreeProfileLinks,
        })}
        staleProfile={
          multiProfileEnabled && entry.session?.staleProfile === true
        }
        selected={
          entry.session !== null && entry.session.id === selectedSessionId
        }
        editing={editingKey === entry.key}
        onEditingChange={editing =>
          setEditingKey(current => {
            if (editing) return entry.key;
            return current === entry.key ? null : current;
          })
        }
        onSaveDisplayName={
          onSetWorktreeDisplayName && worktreePath
            ? name => onSetWorktreeDisplayName(worktreePath, name)
            : undefined
        }
        menu={buildMenu(entry)}
        onMenuOpenChange={onMenuOpenChange}
      />
    );
  };

  return (
    <>
      {visibleRows.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-muted-foreground">
          <p>セッションがありません</p>
          <p className="mt-1 text-xs">「+」から新規作成</p>
        </div>
      ) : (
        <div
          data-session-list=""
          className={cn(
            "flex flex-col",
            variant === "sidebar" ? "gap-1" : "gap-2"
          )}
          {...bindings}
        >
          {visibleRows.map(row =>
            row.kind === "section" ? renderSection(row) : renderRow(row.entry)
          )}
        </div>
      )}

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={open => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent className="w-[calc(100%-2rem)] max-w-md mx-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget?.kind === "worktree"
                ? "Worktreeを削除"
                : "セッションを削除"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? deleteDescription(deleteTarget) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="h-12 md:h-10">
              キャンセル
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 h-12 md:h-10"
              onClick={() => {
                if (deleteTarget?.kind === "session") {
                  onDeleteSession(deleteTarget.sessionId, deleteTarget.worktree);
                } else if (deleteTarget?.kind === "worktree") {
                  onDeleteWorktree?.(deleteTarget.worktree);
                }
                setDeleteTarget(null);
              }}
            >
              削除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={restartSessionId !== null}
        onOpenChange={open => {
          if (!open) setRestartSessionId(null);
        }}
      >
        <AlertDialogContent className="w-[calc(100%-2rem)] max-w-md mx-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>セッションを再起動しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              このセッションを再起動するとClaude会話履歴・実行中コマンド・ターミナル内容がすべて失われます。続行しますか？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="h-12 md:h-10">
              キャンセル
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-12 md:h-10"
              onClick={() => {
                if (restartSessionId) onRestartSession?.(restartSessionId);
                setRestartSessionId(null);
              }}
            >
              再起動
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={removeRepoPath !== null}
        onOpenChange={open => {
          if (!open) setRemoveRepoPath(null);
        }}
      >
        <AlertDialogContent className="w-[calc(100%-2rem)] max-w-md mx-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>リポジトリをサイドバーから除外</AlertDialogTitle>
            <AlertDialogDescription>
              {removeRepoPath
                ? `「${getBaseName(removeRepoPath)}」をサイドバー一覧から非表示にします。Worktreeやセッション、リポジトリ自体は削除されません。再度リポジトリを選択すれば復元できます。`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="h-12 md:h-10">
              キャンセル
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-12 md:h-10"
              onClick={() => {
                if (removeRepoPath) onRemoveRepo?.(removeRepoPath);
                setRemoveRepoPath(null);
              }}
            >
              除外
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
```

- [ ] **Step 15: 実行して通過を確認する**

Run: `pnpm vitest run packages/web/src/components/SessionSectionList.test.tsx`
Expected: PASS (`Tests  11 passed (11)`)

フォーカスの保留のテストだけが落ちる場合は、Task 3 の `useListHold` の `onFocusCapture` / `onBlurCapture` が `bindings` に入っているか、`useHeldOrder` が保留中に「前回自分が返した並び」を基準にしているかを確かめる (このテストは Task 3 の実装を通しで使う)。

削除のテストが `AlertDialog` の描画 (jsdom) で落ちる場合は、このテストファイルで `@/components/ui/alert-dialog` を「`AlertDialog` は `open` がtrueのときだけchildrenを描き、`AlertDialogAction` / `AlertDialogCancel` は `onClick` を持つ `<button>`、ほかはchildrenをそのまま描く」モックに置き換える。

- [ ] **Step 16: コミットする**

```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper
git branch --show-current
pnpm biome check --write packages/web/src/components/SessionSectionList.tsx packages/web/src/components/SessionSectionList.test.tsx
git add packages/web/src/components/SessionSectionList.tsx packages/web/src/components/SessionSectionList.test.tsx
git commit -m "feat(web): 注意の順に並べて保留するセッション一覧を追加"
```

- [ ] **Step 17: サイドバーの失敗するテストを書く**

`packages/web/src/components/SessionSidebar.test.tsx` を作る。

```tsx
// @vitest-environment jsdom

import { act, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSidebar } from "./SessionSidebar";

const testDoubles = vi.hoisted(() => ({
  sectionList: vi.fn(),
}));

vi.mock("./SessionSectionList", () => ({
  SessionSectionList: (props: Record<string, unknown>) => {
    testDoubles.sectionList(props);
    return <div data-testid="section-list" />;
  },
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children?: ReactNode;
    onSelect?: (event: Event) => void;
  }) => (
    <button
      type="button"
      data-menu-item=""
      onClick={() => onSelect?.(new Event("select"))}
    >
      {children}
    </button>
  ),
}));

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function mount(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mountedRoots.push({ root, container });
  return container;
}

function sidebarProps(): ComponentProps<typeof SessionSidebar> {
  return {
    sessions: new Map(),
    worktrees: [],
    repoList: ["/work/app"],
    sessionStatuses: new Map([["session-1", "IDLE"]]),
    sessionPreviews: new Map([["session-1", "どちらにしますか"]]),
    selectedSessionId: "session-1",
    onOpenSession: vi.fn(),
    onStartSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onSelectRepoGrid: vi.fn(),
    onNewSession: vi.fn(),
    onOpenAbout: vi.fn(),
  };
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  testDoubles.sectionList.mockClear();
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("SessionSidebar", () => {
  it("ワードマーク「Ark」のメニューからAboutを開く", () => {
    const props = sidebarProps();
    const container = mount(<SessionSidebar {...props} />);

    expect(
      container.querySelector('button[aria-label="Arkのメニュー"]')?.textContent
    ).toBe("Ark");
    const about = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-menu-item]")
    ).find(item => item.textContent === "About Ark");
    act(() => about?.click());

    expect(props.onOpenAbout).toHaveBeenCalledTimes(1);
  });

  it("一覧をサイドバーの形で描き、一覧のpropsをそのまま渡す", () => {
    const props = sidebarProps();
    mount(<SessionSidebar {...props} />);

    const listProps = testDoubles.sectionList.mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    expect(listProps).toMatchObject({
      variant: "sidebar",
      selectedSessionId: "session-1",
      repoList: ["/work/app"],
    });
    expect(listProps.sessionStatuses).toBe(props.sessionStatuses);
    expect(listProps.sessionPreviews).toBe(props.sessionPreviews);
    expect(listProps.onSelectRepoGrid).toBe(props.onSelectRepoGrid);
    expect(listProps).not.toHaveProperty("onNewSession");
    expect(listProps).not.toHaveProperty("onOpenAbout");
  });
});
```

- [ ] **Step 18: 実行して失敗を確認する**

Run: `pnpm vitest run packages/web/src/components/SessionSidebar.test.tsx`
Expected: FAIL。今の `SessionSidebar` は `DropdownMenuLabel` などモックに無い部品を読むので `[vitest] No "DropdownMenuLabel" export is defined on the "@/components/ui/dropdown-menu" mock` で落ちるか、「About Ark」の項目と `SessionSectionList` へのpropsが見つからずに落ちる

- [ ] **Step 19: サイドバーを書き換える**

`packages/web/src/components/SessionSidebar.tsx` の中身 (1〜727行) を全部、次に置き換える。ヘッダーは参照モック `A-pc.html` の `.sb-head` (高さ44px・ワードマーク17px/600) に合わせる。`Terminal` アイコンとリポジトリ見出しの行は無くなる。

```tsx
/**
 * SessionSidebar - PCのセッション一覧サイドバー
 *
 * ヘッダー (ワードマークのメニュー・新規作成・通知許可・ブラウザ) と、
 * 注意の順に並べたセッション一覧 (SessionSectionList) を出す。
 * About (CPU/MEM/DISKとBridgeへのリンクを含む) はワードマークのメニューから開く。
 */

import { ChevronDown, Globe, Info, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SessionSectionList,
  type SessionSectionListProps,
} from "./SessionSectionList";

type SessionSidebarProps = Omit<SessionSectionListProps, "variant"> & {
  onNewSession: () => void;
  /** Aboutダイアログを開く */
  onOpenAbout: () => void;
  /** ブラウザ選択コールバック (リモートアクセス時のみ使用) */
  onSelectBrowser?: () => void;
  isBrowserSelected?: boolean;
  isRemote?: boolean;
  notificationControl?: ReactNode;
};

export function SessionSidebar({
  onNewSession,
  onOpenAbout,
  onSelectBrowser,
  isBrowserSelected = false,
  isRemote = false,
  notificationControl,
  ...listProps
}: SessionSidebarProps) {
  return (
    <div className="h-full flex flex-col bg-sidebar">
      <div className="flex h-14 shrink-0 items-center gap-1 pl-3 pr-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Arkのメニュー"
              className="inline-flex h-9 items-center gap-1 rounded-sm px-2 text-[17px] font-semibold tracking-[-0.01em] text-sidebar-foreground transition-colors hover:bg-sidebar-accent"
            >
              Ark
              <ChevronDown
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuItem onSelect={onOpenAbout}>
              <Info />
              About Ark
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={onNewSession}
          aria-label="新規セッション"
          title="新規セッション"
        >
          <Plus className="size-5" />
        </Button>
        {notificationControl}
        {isRemote && onSelectBrowser && (
          <Button
            variant={isBrowserSelected ? "default" : "ghost"}
            size="icon"
            className="h-8 w-8"
            onClick={onSelectBrowser}
            aria-label={
              isBrowserSelected ? "ブラウザを選択中" : "ブラウザを開く"
            }
            aria-pressed={isBrowserSelected}
            title="ブラウザ"
          >
            <Globe className="size-5" />
          </Button>
        )}
      </div>

      {/* セッション一覧。
          Radix ScrollAreaを使うとViewportの中にdisplay: tableの無classラッパーが挟まり、
          子要素 (表示名の入力欄など) が想定外に広がるとラッパーが膨らんで水平スクロール状態になる
          (overflow-x: hiddenはViewportに効いてもscrollLeftが焼き付き、確定後に左端を戻せない)。
          素直なdivの縦スクロール + overflow-x: hiddenで水平方向の広がりを抑える。 */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2 pb-3">
        <SessionSectionList variant="sidebar" {...listProps} />
      </div>
    </div>
  );
}
```

- [ ] **Step 20: 置き換わった `SessionCard` と `RepoProfileMenu` を消す**

Run:
```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper
grep -rn "SessionCard\|RepoProfileMenu\|colorFor\|badgeLabel" packages/web/src
```
Expected: `SessionCard.tsx` と `RepoProfileMenu.tsx` 自身の中の行だけが出る (ほかのファイルからのimportが無い)

Run: `git rm packages/web/src/components/SessionCard.tsx packages/web/src/components/RepoProfileMenu.tsx`

- [ ] **Step 21: 実行して通過を確認する**

Run: `pnpm vitest run packages/web/src/components/SessionSidebar.test.tsx packages/web/src/components/SessionSectionList.test.tsx`
Expected: PASS (`Test Files  2 passed (2)`)

- [ ] **Step 22: コミットする**

```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper
git branch --show-current
pnpm biome check --write packages/web/src/components/SessionSidebar.tsx packages/web/src/components/SessionSidebar.test.tsx
git add packages/web/src/components/SessionSidebar.tsx packages/web/src/components/SessionSidebar.test.tsx
git commit -m "feat(web): PCサイドバーを注意の順の一覧とワードマークのメニューに置き換える"
```

- [ ] **Step 23: Dashboardの配線の失敗するテストを書く**

`packages/web/src/pages/Dashboard.test.tsx` を変える。

9〜14行の `testDoubles` を置き換える:

```tsx
const testDoubles = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  splitChatPane: vi.fn(),
  sessionSidebar: vi.fn(),
  aboutDialog: vi.fn(),
  bridgeSnapshotEnabled: vi.fn(),
  socketState: {} as Record<string, unknown>,
}));
```

33〜35行の `useBridgeSnapshot` のモックを置き換える:

```tsx
vi.mock("@/hooks/useBridgeSnapshot", () => ({
  useBridgeSnapshot: (_socket: unknown, enabled: boolean) => {
    testDoubles.bridgeSnapshotEnabled(enabled);
    return null;
  },
}));
```

76〜80行の `SidebarMainLayout` と `AboutDialog` のモックを置き換える (サイドバーも描いて `SessionSidebar` のpropsを拾えるようにする):

```tsx
vi.mock("@/components/SidebarMainLayout", () => ({
  SidebarMainLayout: ({
    sidebar,
    main,
  }: {
    sidebar: ReactNode;
    main: ReactNode;
  }) => (
    <>
      {sidebar}
      {main}
    </>
  ),
}));

vi.mock("@/components/AboutDialog", () => ({
  AboutDialog: (props: Record<string, unknown>) => {
    testDoubles.aboutDialog(props);
    return null;
  },
}));
```

95〜97行の `SessionSidebar` のモックを置き換える:

```tsx
vi.mock("@/components/SessionSidebar", () => ({
  SessionSidebar: (props: Record<string, unknown>) => {
    testDoubles.sessionSidebar(props);
    return null;
  },
}));
```

`mount` 関数の後ろに次を足す:

```tsx
function latestProps(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const props = mock.mock.calls.at(-1)?.[0];
  expect(props).toBeDefined();
  return props as Record<string, unknown>;
}
```

`beforeEach` の `testDoubles.setSetting.mockClear();` の次の行に足す:

```tsx
  testDoubles.sessionSidebar.mockClear();
  testDoubles.aboutDialog.mockClear();
  testDoubles.bridgeSnapshotEnabled.mockClear();
```

ファイルの末尾に足す:

```tsx
describe("Dashboardのサイドバー配線", () => {
  it("状態とプレビューをサイドバーへ渡し、Aboutを開いている間だけホストの状態を購読する", () => {
    mount(<Dashboard />);

    const state = testDoubles.socketState;
    const sidebar = latestProps(testDoubles.sessionSidebar);
    expect(sidebar.sessionStatuses).toBe(state.sessionStatuses);
    expect(sidebar.sessionPreviews).toBe(state.sessionPreviews);
    expect(sidebar.selectedSessionId).toBe("dashboard-session");
    expect(sidebar).not.toHaveProperty("sessionActivityTexts");
    expect(latestProps(testDoubles.aboutDialog)).toMatchObject({
      open: false,
      metrics: null,
    });
    expect(testDoubles.bridgeSnapshotEnabled).toHaveBeenLastCalledWith(false);

    act(() => (sidebar.onOpenAbout as () => void)());

    expect(latestProps(testDoubles.aboutDialog)).toMatchObject({ open: true });
    expect(testDoubles.bridgeSnapshotEnabled).toHaveBeenLastCalledWith(true);
  });
});
```

- [ ] **Step 24: 実行して失敗を確認する**

Run: `pnpm vitest run packages/web/src/pages/Dashboard.test.tsx`
Expected: FAIL。`Dashboardのサイドバー配線` が `expected undefined to be Map{…}` (`sessionStatuses` がまだ `gridStatuses` の名前で渡っている) で落ちる。既存の `Dashboard の会話ビュー配線` は通る

- [ ] **Step 25: `SystemStatusBar` をトークンの色にする (Aboutに移すための変更だけ)**

`packages/web/src/components/bridge/SystemStatusBar.tsx` の1行目のimportに `ExternalLink` を足す:

```tsx
import type { HostMetrics } from "@ark/shared";
import { ExternalLink } from "lucide-react";
import { clamp } from "./utils";
```

26〜56行 (`return (` から `Metric` 関数の終わりまで) を置き換える。黒地・灰色の直書きと `font-mono` を外し、別タブで開くことをアイコンで示す:

```tsx
  return (
    <a
      href={bridgeHref}
      target="_blank"
      rel="noopener noreferrer"
      title="Bridgeを別タブで開く"
      className="flex items-center gap-5 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground select-none transition-colors hover:bg-accent cursor-pointer"
    >
      <span className="flex items-center gap-2 flex-1 min-w-0">
        <span className="text-muted-foreground shrink-0">CPU</span>
        <Sparkline values={cpuHistory} />
        <span className="tabular-nums shrink-0">
          {cpu !== null ? `${cpu}%` : "--"}
        </span>
      </span>
      <Metric label="MEM" percent={mem} />
      <Metric label="DISK" percent={disk} />
      <ExternalLink
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
    </a>
  );
}

function Metric({ label, percent }: { label: string; percent: number | null }) {
  return (
    <span className="flex items-center gap-1.5 shrink-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">
        {percent !== null ? `${percent}%` : "--"}
      </span>
    </span>
  );
}
```

`Sparkline` の `<svg>` のclassName (82行) を置き換える:

```tsx
      className="flex-1 min-w-0 h-4 text-muted-foreground"
```

- [ ] **Step 26: Aboutに「このマシン」を足す**

`packages/web/src/components/AboutDialog.tsx` の15行目のimportを置き換える:

```tsx
import type { HostMetrics } from "@ark/shared";
import { useEffect, useState } from "react";
import { SystemStatusBar } from "@/components/bridge/SystemStatusBar";
```

37〜42行のpropsと関数の宣言を置き換える:

```tsx
interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** CPU/MEM/DISK。Aboutを開いている間だけ購読した値 (未着はnull) */
  metrics: HostMetrics | null;
}

export function AboutDialog({ open, onOpenChange, metrics }: AboutDialogProps) {
```

79行の `</DialogHeader>` の直後 (80行の `<section className="space-y-2">` の前) に足す:

```tsx
        <section className="space-y-2">
          <h3 className="font-semibold text-sm">このマシン</h3>
          <SystemStatusBar metrics={metrics} />
        </section>
```

- [ ] **Step 27: `SidebarMainLayout` からAboutとCPU/MEM/DISKを外す**

`packages/web/src/components/SidebarMainLayout.tsx` を次のように変える。

8行 `import type { HostMetrics } from "@ark/shared";` と16行 `import { SystemStatusBar } from "./bridge/SystemStatusBar";` を消す。

22〜30行の `SidebarMainLayoutProps` を置き換える:

```tsx
interface SidebarMainLayoutProps {
  sidebar: ReactNode;
  main: ReactNode;
  initialSidebarWidth?: number;
  onSidebarWidthChange?: (width: number) => void;
}
```

36〜43行の関数の宣言を置き換える:

```tsx
export function SidebarMainLayout({
  sidebar,
  main,
  initialSidebarWidth = SIDEBAR_DEFAULT_WIDTH,
  onSidebarWidthChange,
}: SidebarMainLayoutProps) {
```

112〜122行の次のブロックを置き換える:

```tsx
        <div className="flex-1 min-h-0 overflow-hidden">{sidebar}</div>
        {onOpenAboutDialog && (
          <button
            type="button"
            onClick={onOpenAboutDialog}
            className="w-full py-2 text-sm text-muted-foreground hover:text-foreground border-t border-border transition-colors block text-center"
          >
            ℹ About Ark
          </button>
        )}
        <SystemStatusBar metrics={hostMetrics} />
```

置き換え後:

```tsx
        <div className="flex-1 min-h-0 overflow-hidden">{sidebar}</div>
```

- [ ] **Step 28: Dashboardを配線する**

`packages/web/src/pages/Dashboard.tsx` を次のように変える。

120行 `    sessionActivityTexts,` を消す。

159〜160行の次の2行を消す:

```tsx
  // PCサイドバー下部のシステムステータスバー用に bridge:snapshot を購読
  const bridgeSnapshot = useBridgeSnapshot(socket, !isMobile);
```

459行 `  const [showAboutDialog, setShowAboutDialog] = useState(false);` の直後に足す:

```tsx
  // AboutダイアログのCPU/MEM/DISK用。開いている間だけbridge:snapshotを購読する
  const bridgeSnapshot = useBridgeSnapshot(socket, showAboutDialog);
```

727〜762行の `<SessionSidebar … />` を置き換える (`gridStatuses` は `sessionStatuses` に、`sessionActivityTexts` と `gridRepoPath` は削除、`sessionPreviews` と `onOpenAbout` を追加。未起動のworktreeの削除はPCには渡さない):

```tsx
            <SessionSidebar
              sessions={sessions}
              worktrees={worktrees}
              repoList={repoList}
              sessionStatuses={sessionStatuses}
              sessionPreviews={sessionPreviews}
              selectedSessionId={selectedSessionId}
              worktreeDisplayNames={worktreeDisplayNames}
              capabilities={capabilities}
              profiles={profiles}
              repoProfileLinks={repoProfileLinks}
              worktreeProfileLinks={worktreeProfileLinks}
              notificationsSupported={sessionNotifications.supported}
              isSessionNotificationEnabled={isSessionNotificationEnabled}
              onOpenSession={handleSelectSession}
              onStartSession={handleStartSession}
              onDeleteSession={handleDeleteSession}
              onRestartSession={handleRestartSession}
              onSetWorktreeDisplayName={setWorktreeDisplayName}
              onSessionNotificationEnabledChange={
                handleSessionNotificationEnabledChange
              }
              onCreateWorktreeForRepo={handleCreateWorktreeForRepo}
              onSelectRepoGrid={handleSelectRepoGrid}
              onRemoveRepo={handleRemoveRepo}
              onSetRepoProfile={setRepoProfile}
              onSetWorktreeProfile={setWorktreeProfile}
              onOpenProfileManager={() => setShowProfileManager(true)}
              onNewSession={handleNewSession}
              onOpenAbout={() => setShowAboutDialog(true)}
              onSelectBrowser={handleSelectBrowser}
              isBrowserSelected={selectedSessionId === "browser"}
              isRemote={isRemote}
              notificationControl={notificationControl}
            />
```

895〜896行の次の2行を消す:

```tsx
          onOpenAboutDialog={() => setShowAboutDialog(true)}
          hostMetrics={bridgeSnapshot?.metrics ?? null}
```

1077行の `<AboutDialog … />` を置き換える:

```tsx
      <AboutDialog
        open={showAboutDialog}
        onOpenChange={setShowAboutDialog}
        metrics={bridgeSnapshot?.metrics ?? null}
      />
```

- [ ] **Step 29: 実行して通過を確認する**

Run: `pnpm vitest run packages/web/src/pages/Dashboard.test.tsx`
Expected: PASS (`Tests  2 passed (2)`)

- [ ] **Step 30: 型・lintと関連テストを通す**

Run:
```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper
pnpm biome check --write packages/web/src/components/bridge/SystemStatusBar.tsx packages/web/src/components/AboutDialog.tsx packages/web/src/components/SidebarMainLayout.tsx packages/web/src/pages/Dashboard.tsx packages/web/src/pages/Dashboard.test.tsx
pnpm check
```
Expected: `biome check` がエラー0で終わり、`tsc -b` が何も出さずに終わる。

型エラーが `PARTS_BY_VARIANT` の `as MenuParts[…]` で出た場合は、そのキーだけ `as unknown as MenuParts["Sub"]` のように `unknown` を挟む。

Run:
```bash
pnpm vitest run packages/web/src/lib/session-sections.test.ts packages/web/src/hooks/useHeldOrder.test.tsx packages/web/src/components/SessionRowMenu.test.tsx packages/web/src/components/SessionListRow.test.tsx packages/web/src/components/SessionSectionList.test.tsx packages/web/src/components/SessionSidebar.test.tsx packages/web/src/pages/Dashboard.test.tsx
```
Expected: PASS (`Test Files  7 passed (7)`)

- [ ] **Step 31: コミットする**

```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper
git branch --show-current
git add packages/web/src/components/bridge/SystemStatusBar.tsx packages/web/src/components/AboutDialog.tsx packages/web/src/components/SidebarMainLayout.tsx packages/web/src/pages/Dashboard.tsx packages/web/src/pages/Dashboard.test.tsx
git commit -m "feat(web): CPU/MEM/DISKとBridgeへのリンクをAboutに移し、サイドバーに状態とプレビューを渡す"
```

---

### Task 6: モバイル一覧と下部タブ

**Files:**
行番号はTask 5を終えた後のファイルでの目安。置き換えは、各ステップで引用した既存の行を目印にする。

- Create: `packages/web/src/components/MobileSessionList.test.tsx`
- Modify: `packages/web/src/components/MobileSessionList.tsx` (全体を書き換え。1〜416行)
- Modify: `packages/web/src/components/MobileLayout.tsx` (9〜22行のimport、166〜179行のprops、225〜232行の分割代入、310〜338行の一覧、355行の詳細、417行のブラウザ、443〜471行の下部タブ)
- Modify: `packages/web/src/components/MobileLayout.test.tsx` (32〜78行の `createProps`、末尾にdescribeを追加)
- Modify: `packages/web/src/pages/Dashboard.tsx` (713〜715行の `MobileLayout` のprops)
- Modify: `packages/web/src/pages/Dashboard.test.tsx` (`testDoubles`、`useIsMobile` と `MobileLayout` のモック、`beforeEach`、末尾にdescribeを追加)
- Modify: `e2e/mobile-session-state.spec.ts` (全体。実行は Task 12)

**Interfaces:**
- Consumes:
  - Task 5: `SessionSectionList` と `SessionSectionListProps` (`variant="card"` で使う。中で `SessionListRow` を `variant="card"` にする)
  - Task 2: `presentStatus` (テストのみ)
- Produces:

```ts
// packages/web/src/components/MobileSessionList.tsx
type MobileSessionListProps =
  Omit<SessionSectionListProps, "variant" | "selectedSessionId" | "onSelectRepoGrid"> & {
    onNewSession: () => void;
    notificationControl?: ReactNode;
  };
// 見出しは<h1>Ark</h1> (22px/700)

// packages/web/src/components/MobileLayout.tsxのpropsに追加
interface MobileLayoutProps {
  // …既存のpropsはそのまま
  sessionPreviews: Map<string, string>;
  worktreeDisplayNames: Map<string, string>; // Task 10のヘッダーの主ラベルも使う (Task 10と同じ名前と型)
  onSetWorktreeDisplayName?: (worktreePath: string, displayName: string | null) => void;
  capabilities?: SystemCapabilities;
  profiles?: Profile[];
  repoProfileLinks?: Map<string, string>;
  worktreeProfileLinks?: Map<string, string>;
  onSetRepoProfile?: (repoPath: string, profileId: string | null) => void;
  onSetWorktreeProfile?: (worktreePath: string, profileId: string | null) => void;
  onOpenProfileManager?: () => void;
  onCreateWorktreeForRepo?: (repoPath: string) => void;
  onRemoveRepo?: (repoPath: string) => void;
}
// 下部タブ<nav>は、リモート時の一覧とブラウザの画面だけに出す (会話の詳細画面には出さない)。
// 選択中のタブはaria-current="page"。一覧とブラウザのラッパーのpb-14もリモート時だけ付く。
// 詳細画面のラッパーは常にpb-14なし。Task 10は詳細画面のラッパーに触らず、下部バーを画面の下端に置ける
```

**設計メモ:**
- 行の中身・並べ方・行メニュー・確認ダイアログは Task 5 の `SessionSectionList` をそのまま使う。「このリポジトリの全セッションを並べて見る」はPCの `RepoGridView` にしか無いので、モバイルには `onSelectRepoGrid` を渡さない (型で除外する)
- 未起動のworktreeの削除 (`onDeleteWorktree`) は、今のモバイル一覧と同じく渡す
- 下部タブは、ブラウザタブがあるリモート時の一覧とブラウザの画面だけに出す。会話の詳細画面は Task 10 で自前の下部バーを画面の下端に置くので、タブを重ねない。詳細画面のラッパーの `pb-14` はこのタスクで外す (Task 10 はラッパーに触らない。Task 10の担当と合意済み)
- `worktreeDisplayNames` は Task 10 のヘッダーも使うので、必須のpropとして足す
- e2eのspecは編集だけにする。`playwright.config.ts` の `baseURL` は稼働中の本番 (port 4001、mainの配信物) を向き、一覧の表示でも自動選択されたセッションの `MobileSessionView` がマウントされてttydに触れる。実行は Task 12 のプレビュー配信 (`/ttyd/` を遮断) で行う

- [ ] **Step 1: ブランチを確かめる**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper && git branch --show-current`
Expected: `feat/visual-redesign-paper`

- [ ] **Step 2: モバイル一覧の失敗するテストを書く**

`packages/web/src/components/MobileSessionList.test.tsx` を作る。

```tsx
// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileSessionList } from "./MobileSessionList";

const testDoubles = vi.hoisted(() => ({
  sectionList: vi.fn(),
}));

vi.mock("./SessionSectionList", () => ({
  SessionSectionList: (props: Record<string, unknown>) => {
    testDoubles.sectionList(props);
    return <div data-testid="section-list" />;
  },
}));

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function mount(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mountedRoots.push({ root, container });
  return container;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  testDoubles.sectionList.mockClear();
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("MobileSessionList", () => {
  it("見出し「Ark」と新規作成を出し、一覧をPCと同じ並べ方のカードで描く", () => {
    const onNewSession = vi.fn();
    const sessionStatuses = new Map([["session-1", "IDLE" as const]]);
    const sessionPreviews = new Map([["session-1", "テストを実行しています"]]);
    const worktreeDisplayNames = new Map([["/repo/worktree", "ログイン画面"]]);
    const container = mount(
      <MobileSessionList
        sessions={new Map()}
        worktrees={[]}
        repoList={["/repo"]}
        sessionStatuses={sessionStatuses}
        sessionPreviews={sessionPreviews}
        worktreeDisplayNames={worktreeDisplayNames}
        onOpenSession={vi.fn()}
        onStartSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onDeleteWorktree={vi.fn()}
        onNewSession={onNewSession}
      />
    );

    expect(container.querySelector("h1")?.textContent).toBe("Ark");
    const newButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="新規セッション"]'
    );
    act(() => newButton?.click());
    expect(onNewSession).toHaveBeenCalledTimes(1);

    const listProps = testDoubles.sectionList.mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    expect(listProps).toMatchObject({
      variant: "card",
      selectedSessionId: null,
      repoList: ["/repo"],
    });
    expect(listProps.sessionStatuses).toBe(sessionStatuses);
    expect(listProps.sessionPreviews).toBe(sessionPreviews);
    expect(listProps.worktreeDisplayNames).toBe(worktreeDisplayNames);
    expect(listProps).not.toHaveProperty("onSelectRepoGrid");
    expect(listProps).not.toHaveProperty("onNewSession");
  });
});
```

- [ ] **Step 3: 実行して失敗を確認する**

Run: `pnpm vitest run packages/web/src/components/MobileSessionList.test.tsx`
Expected: FAIL。今の一覧は見出しが `<span>` なので `expected undefined to be 'Ark'` で落ちる

- [ ] **Step 4: モバイル一覧を書き換える**

`packages/web/src/components/MobileSessionList.tsx` の中身 (1〜416行) を全部、次に置き換える。見出しは参照モック `A-mobile-list.html` の `.header` (高さ56px・左20px) に、文字は設計書8.4節の22px/700に合わせる。一覧の外周は `.list` (上4px・左右16px・下16px)。

```tsx
/**
 * MobileSessionList - モバイルのセッション一覧画面
 *
 * PCサイドバーと同じ並べ方・行の中身・行メニュー (SessionSectionList) を、カードの形で出す。
 * RepoGridViewはPCだけなので、「このリポジトリの全セッションを並べて見る」は渡さない。
 */

import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  SessionSectionList,
  type SessionSectionListProps,
} from "./SessionSectionList";

type MobileSessionListProps = Omit<
  SessionSectionListProps,
  "variant" | "selectedSessionId" | "onSelectRepoGrid"
> & {
  onNewSession: () => void;
  notificationControl?: ReactNode;
};

export function MobileSessionList({
  onNewSession,
  notificationControl,
  ...listProps
}: MobileSessionListProps) {
  return (
    <div className="flex-1 flex flex-col min-h-0 safe-area-x">
      <header className="flex h-14 shrink-0 items-center gap-1 pl-5 pr-2">
        <h1 className="flex-1 text-[22px] font-bold tracking-[-0.01em] text-foreground">
          Ark
        </h1>
        {notificationControl}
        <Button
          variant="ghost"
          size="icon"
          className="h-12 w-12"
          onClick={onNewSession}
          aria-label="新規セッション"
          title="新規セッション"
        >
          <Plus className="size-6" />
        </Button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 pt-1 pb-4">
        <SessionSectionList
          variant="card"
          selectedSessionId={null}
          {...listProps}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 実行して通過を確認する**

Run: `pnpm vitest run packages/web/src/components/MobileSessionList.test.tsx`
Expected: PASS (`Tests  1 passed (1)`)

- [ ] **Step 6: コミットする**

```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper
git branch --show-current
pnpm biome check --write packages/web/src/components/MobileSessionList.tsx packages/web/src/components/MobileSessionList.test.tsx
git add packages/web/src/components/MobileSessionList.tsx packages/web/src/components/MobileSessionList.test.tsx
git commit -m "feat(web): モバイル一覧をPCと同じ並べ方と行の中身のカードにする"
```

- [ ] **Step 7: MobileLayoutの失敗するテストを書く**

`packages/web/src/components/MobileLayout.test.tsx` を変える。

1行目のimportを置き換える:

```tsx
import type { ManagedSession, Worktree } from "@ark/shared";
```

`createProps()` の中の `sessionAwaitingTexts: new Map(),` の次の行に足す (`as ComponentProps<…>` で型の検査が効かないため、必須のMapを入れ忘れると実行時に落ちる):

```tsx
    sessionPreviews: new Map(),
    worktreeDisplayNames: new Map(),
```

ファイルの末尾に足す:

```tsx
describe("MobileLayoutの下部タブ", () => {
  it("ローカルでは下部タブを出さず、画面の下端に余白も足さない", () => {
    const markup = renderToStaticMarkup(
      createElement(MobileLayout, {
        ...createProps(),
        sessionSubView: "list",
        isRemote: false,
      })
    );

    expect(markup).not.toContain("<nav");
    expect(markup).not.toContain("pb-14");
  });

  it("リモートでは下部タブを出し、選択中のタブをaria-currentで示す", () => {
    const markup = renderToStaticMarkup(
      createElement(MobileLayout, {
        ...createProps(),
        sessionSubView: "list",
        isRemote: true,
      })
    );

    expect(markup).toContain("<nav");
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain("ブラウザ");
    expect(markup).toContain("pb-14");
    expect(markup).not.toContain("border-t-2");
  });

  it("リモートでも会話の詳細画面では下部タブを出さず、余白も付けない", () => {
    const markup = renderToStaticMarkup(
      createElement(MobileLayout, { ...createProps(), isRemote: true })
    );

    expect(markup).toContain('aria-label="表示する図"');
    expect(markup).not.toContain("<nav");
    expect(markup).not.toContain("pb-14");
  });
});

describe("MobileLayoutの一覧の配線", () => {
  it("一覧の行にプレビュー文と表示名を出す", () => {
    const worktree: Worktree = {
      id: session.worktreeId,
      path: session.worktreePath,
      branch: "feature/list",
      commit: "abc1234",
      isMain: false,
      isBare: false,
    };
    const markup = renderToStaticMarkup(
      createElement(MobileLayout, {
        ...createProps(),
        sessionSubView: "list",
        repoList: ["/repo"],
        worktrees: [worktree],
        sessionStatuses: new Map([[session.id, "TOOL"]]),
        sessionPreviews: new Map([[session.id, "テストを実行しています"]]),
        worktreeDisplayNames: new Map([[worktree.path, "一覧の表示名"]]),
      })
    );

    expect(markup).toContain("テストを実行しています");
    expect(markup).toContain("一覧の表示名");
  });
});
```

- [ ] **Step 8: Dashboardのモバイルの配線の失敗するテストを書く**

`packages/web/src/pages/Dashboard.test.tsx` を変える (Task 5 の変更の上に足す)。

`testDoubles` に2つ足す:

```tsx
const testDoubles = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  splitChatPane: vi.fn(),
  sessionSidebar: vi.fn(),
  aboutDialog: vi.fn(),
  bridgeSnapshotEnabled: vi.fn(),
  mobileLayout: vi.fn(),
  isMobile: false,
  socketState: {} as Record<string, unknown>,
}));
```

29〜31行の `useIsMobile` のモックを置き換える:

```tsx
vi.mock("@/hooks/useMobile", () => ({
  useIsMobile: () => testDoubles.isMobile,
}));
```

`MobileLayout` のモックを置き換える:

```tsx
vi.mock("@/components/MobileLayout", () => ({
  MobileLayout: (props: Record<string, unknown>) => {
    testDoubles.mobileLayout(props);
    return null;
  },
  normalizeMobileTab: (value: unknown) => value,
  normalizeSessionId: (value: unknown) => value,
  normalizeSessionSubView: (value: unknown) => value,
}));
```

`beforeEach` の `globalThis.IS_REACT_ACT_ENVIRONMENT = true;` の次の行に足す:

```tsx
  testDoubles.isMobile = false;
  testDoubles.mobileLayout.mockClear();
```

ファイルの末尾に足す:

```tsx
describe("Dashboardのモバイル一覧の配線", () => {
  it("状態・プレビュー・表示名・プロファイルと、リポジトリの操作をMobileLayoutへ渡す", () => {
    testDoubles.isMobile = true;
    mount(<Dashboard />);

    const state = testDoubles.socketState;
    const layout = latestProps(testDoubles.mobileLayout);
    expect(layout.sessionStatuses).toBe(state.sessionStatuses);
    expect(layout.sessionPreviews).toBe(state.sessionPreviews);
    expect(layout.worktreeDisplayNames).toBe(state.worktreeDisplayNames);
    expect(layout.onSetWorktreeDisplayName).toBe(state.setWorktreeDisplayName);
    expect(layout.capabilities).toBe(state.capabilities);
    expect(layout.profiles).toBe(state.profiles);
    expect(layout.repoProfileLinks).toBe(state.repoProfileLinks);
    expect(layout.worktreeProfileLinks).toBe(state.worktreeProfileLinks);
    expect(layout.onSetRepoProfile).toBe(state.setRepoProfile);
    expect(layout.onSetWorktreeProfile).toBe(state.setWorktreeProfile);
    expect(layout.onOpenProfileManager).toBeTypeOf("function");
    expect(layout.onCreateWorktreeForRepo).toBeTypeOf("function");
    expect(layout.onRemoveRepo).toBeTypeOf("function");
  });
});
```

- [ ] **Step 9: 実行して失敗を確認する**

Run: `pnpm vitest run packages/web/src/components/MobileLayout.test.tsx packages/web/src/pages/Dashboard.test.tsx`
Expected: FAIL。`MobileLayoutの下部タブ` はローカルや詳細画面でも `<nav` と `pb-14` が出て落ち、`MobileLayoutの一覧の配線` はプレビュー文が届かずに落ち、`Dashboardのモバイル一覧の配線` は `expected undefined to be Map{…}` で落ちる。既存の `MobileLayout diagram wiring` とDashboardの2件は通る

- [ ] **Step 10: MobileLayoutのpropsを足す**

`packages/web/src/components/MobileLayout.tsx` を次のように変える。

9〜21行の型のimportを置き換える:

```tsx
import type {
  BridgeSessionStatus,
  BrowserSession,
  ClientToServerEvents,
  DiagramCommentsResponse,
  DiagramDeleteResponse,
  DiagramListItem,
  ManagedSession,
  MessageShortcut,
  Profile,
  ServerToClientEvents,
  SpecialKey,
  SystemCapabilities,
  Worktree,
} from "@ark/shared";
```

171行 `  sessionAwaitingTexts: Map<string, string>;` の直後に足す:

```tsx
  /** session:previews由来の端末の最後の内容行 (一覧の2行目) */
  sessionPreviews: Map<string, string>;
  /** worktreePath → 表示名 (一覧の行とTask 10のヘッダーの主ラベル) */
  worktreeDisplayNames: Map<string, string>;
  onSetWorktreeDisplayName?: (
    worktreePath: string,
    displayName: string | null
  ) => void;
  /** プロファイル切替 (Linux限定) */
  capabilities?: SystemCapabilities;
  profiles?: Profile[];
  repoProfileLinks?: Map<string, string>;
  worktreeProfileLinks?: Map<string, string>;
  onSetRepoProfile?: (repoPath: string, profileId: string | null) => void;
  onSetWorktreeProfile?: (
    worktreePath: string,
    profileId: string | null
  ) => void;
  onOpenProfileManager?: () => void;
  /** 行メニューの「リポジトリ」の操作 */
  onCreateWorktreeForRepo?: (repoPath: string) => void;
  onRemoveRepo?: (repoPath: string) => void;
```

227行 `  sessionAwaitingTexts,` の直後 (分割代入) に足す:

```tsx
  sessionPreviews,
  worktreeDisplayNames,
  onSetWorktreeDisplayName,
  capabilities,
  profiles,
  repoProfileLinks,
  worktreeProfileLinks,
  onSetRepoProfile,
  onSetWorktreeProfile,
  onOpenProfileManager,
  onCreateWorktreeForRepo,
  onRemoveRepo,
```

- [ ] **Step 11: 下部タブをリモート時の一覧とブラウザだけにし、一覧にデータを通す**

`packages/web/src/components/MobileLayout.tsx` の310〜338行 (`const showBottomNav = true;` から一覧の `</div>` まで) を置き換える:

```tsx
  // 下部タブはブラウザタブがあるリモート時だけ、一覧とブラウザの画面に出す。
  // 会話の詳細画面は自前の下部バーを画面の下端に置くので、タブを重ねない
  const isDetailShown =
    activeTab === "session" && effectiveSessionSubView === "detail";
  const showBottomNav = isRemote && !isDetailShown;
  // 一覧とブラウザのラッパーだけが、下部タブの高さぶんの余白を持つ
  const paneClassName = isRemote
    ? "flex-1 flex flex-col min-h-0 pb-14"
    : "flex-1 flex flex-col min-h-0";
  const tabClassName = (selected: boolean) =>
    `flex-1 py-3 text-center text-sm ${
      selected ? "font-semibold text-foreground" : "font-medium text-muted-foreground"
    }`;

  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden">
      {/* 一覧画面 */}
      <div
        className={
          activeTab === "session" && effectiveSessionSubView === "list"
            ? paneClassName
            : "hidden"
        }
      >
        <MobileSessionList
          sessions={sessions}
          worktrees={worktrees}
          repoList={repoList}
          sessionStatuses={sessionStatuses}
          sessionPreviews={sessionPreviews}
          worktreeDisplayNames={worktreeDisplayNames}
          capabilities={capabilities}
          profiles={profiles}
          repoProfileLinks={repoProfileLinks}
          worktreeProfileLinks={worktreeProfileLinks}
          notificationsSupported={notificationsSupported}
          isSessionNotificationEnabled={isSessionNotificationEnabled}
          onOpenSession={handleOpenSession}
          onStartSession={onStartSession}
          onDeleteSession={onDeleteSession}
          onDeleteWorktree={onDeleteWorktree}
          onRestartSession={onRestartSession}
          onSetWorktreeDisplayName={onSetWorktreeDisplayName}
          onSessionNotificationEnabledChange={
            onSessionNotificationEnabledChange
          }
          onCreateWorktreeForRepo={onCreateWorktreeForRepo}
          onRemoveRepo={onRemoveRepo}
          onSetRepoProfile={onSetRepoProfile}
          onSetWorktreeProfile={onSetWorktreeProfile}
          onOpenProfileManager={onOpenProfileManager}
          onNewSession={onNewSession}
          notificationControl={notificationControl}
        />
      </div>
```

354〜356行の詳細画面のラッパーのclassNameを置き換える (下部タブを出さないので、余白は常に付けない):

```tsx
              className={isActive ? "flex-1 flex flex-col min-h-0" : "hidden"}
```

415〜419行のブラウザビューのラッパーのclassNameを置き換える:

```tsx
          className={activeTab === "browser" ? paneClassName : "hidden"}
```

443〜471行の下部タブを置き換える:

```tsx
      {/* 下部タブ。選択中は緑の線ではなく、文字色とウェイトで示す */}
      {showBottomNav && (
        <nav className="fixed bottom-0 left-0 right-0 z-50 flex border-t border-border bg-background">
          <button
            type="button"
            aria-current={activeTab === "session" ? "page" : undefined}
            className={tabClassName(activeTab === "session")}
            onClick={() => onChangeActiveTab("session")}
          >
            セッション
          </button>
          <button
            type="button"
            aria-current={activeTab === "browser" ? "page" : undefined}
            className={tabClassName(activeTab === "browser")}
            onClick={handleOpenBrowser}
          >
            ブラウザ
          </button>
        </nav>
      )}
```

- [ ] **Step 12: DashboardからMobileLayoutへ渡す**

`packages/web/src/pages/Dashboard.tsx` の `<MobileLayout … />` の中の `sessionAwaitingTexts={sessionAwaitingTexts}` (715行) の直後に足す:

```tsx
          sessionPreviews={sessionPreviews}
          worktreeDisplayNames={worktreeDisplayNames}
          onSetWorktreeDisplayName={setWorktreeDisplayName}
          capabilities={capabilities}
          profiles={profiles}
          repoProfileLinks={repoProfileLinks}
          worktreeProfileLinks={worktreeProfileLinks}
          onSetRepoProfile={setRepoProfile}
          onSetWorktreeProfile={setWorktreeProfile}
          onOpenProfileManager={() => setShowProfileManager(true)}
          onCreateWorktreeForRepo={handleCreateWorktreeForRepo}
          onRemoveRepo={handleRemoveRepo}
```

- [ ] **Step 13: 実行して通過を確認する**

Run: `pnpm vitest run packages/web/src/components/MobileLayout.test.tsx packages/web/src/pages/Dashboard.test.tsx packages/web/src/components/MobileSessionList.test.tsx`
Expected: PASS (`Test Files  3 passed (3)`)

- [ ] **Step 14: コミットする**

```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper
git branch --show-current
pnpm biome check --write packages/web/src/components/MobileLayout.tsx packages/web/src/components/MobileLayout.test.tsx packages/web/src/pages/Dashboard.tsx packages/web/src/pages/Dashboard.test.tsx
git add packages/web/src/components/MobileLayout.tsx packages/web/src/components/MobileLayout.test.tsx packages/web/src/pages/Dashboard.tsx packages/web/src/pages/Dashboard.test.tsx
git commit -m "feat(web): モバイル一覧に状態・プレビュー・表示名・プロファイルを通し、下部タブをリモート時だけにする"
```

- [ ] **Step 15: e2eのspecを一覧の表示で確かめる形に直す**

`e2e/mobile-session-state.spec.ts` の中身を全部、次に置き換える。下部タブの `text-primary` はもう無く、ローカル (`localhost`) では下部タブ自体を出さないため、一覧の見出しが見えることでフォールバックを確かめる。

```ts
import { expect, test } from "@playwright/test";

/**
 * モバイル: セッション状態の永続化値の検証
 *
 * 実セッション起動にはClaude CLIの起動が必要なので、
 * ここでは永続化値のフォールバックを一覧の表示で確かめる。
 */

const MOBILE_VIEWPORT = { width: 375, height: 812 };

// 各テスト前にモバイルUI設定を初期化 (前テストの永続化値を持ち越さない)。
// selectedSessionIdもopenedSessionsの初期値やdetail表示可否に影響するので必ずnullに戻す
test.beforeEach(async ({ request }) => {
  await request.put("/api/settings", {
    data: {
      selectedSessionId: null,
      "mobile.activeTab": "session",
      "mobile.sessionSubView": "list",
    },
  });
});

test("モバイル: 不正な永続化値を受信しても安全な値にフォールバックする", async ({
  page,
  request,
}) => {
  // 壊れた値がsettingsに入ってもクラッシュせずdefaultにフォールバック
  await request.put("/api/settings", {
    data: {
      "mobile.activeTab": "garbage",
      "mobile.sessionSubView": 42,
    },
  });

  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto("/");

  // activeTab="session" / sessionSubView="list" にフォールバックすれば一覧の見出しが見える
  await expect(
    page.getByRole("heading", { level: 1, name: "Ark" })
  ).toBeVisible({ timeout: 15_000 });
  // localhostではブラウザのタブが無いので、下部タブも出さない
  await expect(page.locator("nav")).toHaveCount(0);
});
```

このspecはここでは実行しない。`playwright.config.ts` の `baseURL` は稼働中の本番 (http://localhost:4001、mainの配信物) を向いており、直したspecは古い画面では通らない。さらに一覧の表示でも自動選択されたセッションの `MobileSessionView` がマウントされ、ttydに触れる。Task 12 のプレビュー配信 (`/ttyd/` を遮断) で実行する。

- [ ] **Step 16: 型・lintと関連テストを通す**

Run:
```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper
pnpm biome check --write e2e/mobile-session-state.spec.ts
pnpm check
```
Expected: `biome check` がエラー0で終わり、`tsc -b` が何も出さずに終わる

Run:
```bash
pnpm vitest run packages/web/src/components/MobileSessionList.test.tsx packages/web/src/components/MobileLayout.test.tsx packages/web/src/components/MobileSessionView.test.tsx packages/web/src/components/SessionSectionList.test.tsx packages/web/src/components/SessionListRow.test.tsx packages/web/src/components/SessionSidebar.test.tsx packages/web/src/pages/Dashboard.test.tsx
```
Expected: PASS (`Test Files  7 passed (7)`)

- [ ] **Step 17: コミットする**

```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper
git branch --show-current
git add e2e/mobile-session-state.spec.ts
git commit -m "test(e2e): モバイルのフォールバックを下部タブの色ではなく一覧の見出しで確かめる"
```

---

### Task 7: PC上部バーの統合と端末の額縁

今は上部バー (端末/会話のトグルと図) と、`TerminalPane` の中のヘッダー (セッション名・ブランチ・8個のアイコン) に分かれていて、会話モードではセッション名と操作が消える。これを1本の上部バーにまとめ、端末専用の操作は `…` メニューから `TerminalPaneHandle` 経由で呼ぶ。端末は暗い額縁で囲む (設計書6節・8.2節・9節、参照モック `A-pc.html` の `.topbar` `.segment` `.ghost-btn` `.icon-btn`)。

**Files:**
- Create: `packages/web/src/components/SegmentedControl.tsx`
- Create: `packages/web/src/components/SegmentedControl.test.tsx`
- Create: `packages/web/src/lib/session-header.ts` (骨格のファイル構成に無い。上部バーの主ラベルと `…` メニューの項目を決める純粋な関数)
- Create: `packages/web/src/lib/session-header.test.ts`
- Create: `packages/web/src/components/SessionHeaderMenu.tsx`
- Create: `packages/web/src/components/TerminalPane.test.tsx`
- Modify: `packages/web/src/components/MessageShortcutMenu.tsx:28` (`previewOf` をexportする)
- Modify: `packages/web/src/components/TerminalPane.tsx` (1-56行目のコメントとimport、99-163行目のpropsと関数の頭、171-198行目のrefとコピー、465-468行目の直後にハンドル、470-614行目のヘッダーと額縁、852行目の送信ボタン、862-904行目のダイアログと末尾)
- Modify: `packages/web/src/components/SplitViewPane.tsx` (1-50行目のコメントとimport、57行目の直後に定数、122-123行目と141-142行目のprops、208-211行目の直後に状態、310-332行目の上部バー、348-366行目の端末)
- Delete: `packages/web/src/components/SplitViewLeftModeToggle.tsx` (使っているのは `SplitViewPane.tsx` だけ。e2eからも参照なし)
- Modify: `packages/web/src/components/SplitViewPane.test.tsx` (3行目のimport、`afterEach`、トグルの2件、D&Dの1件、末尾にdescribeを追加。Task 4の変更で行番号がずれるので、`it` の名前で探す)
- Modify: `packages/web/src/pages/Dashboard.tsx` (2行目のimport、766-771行目の切断の帯、819-857行目の配線)
- Modify: `packages/web/src/pages/Dashboard.test.tsx` (末尾にdescribeを追加)

**Interfaces:**
- Consumes:
  - Task 1: `rounded-xl` (16px) / `rounded-lg` (12px) / `rounded-md` (10px) / `rounded-sm` (8px)、`shadow-card`、`text-status-error` / `bg-status-error/15`
  - Task 2: `resolveStatusKey(hasSession: boolean, bridgeStatus: BridgeSessionStatus | undefined): StatusKey`、`StatusChip(props: { statusKey: StatusKey; className?: string })`
  - Task 4: `TERMINAL_BG` / `TERMINAL_FG` (`@ark/shared`。定義は `packages/shared/src/types.ts`)、`split-view-left-mode.ts` の既定値が `"chat"`、`SplitViewPane.test.tsx` の既定値のテストの書き換え
- Produces:
  - `SegmentedControl` / `SegmentOption` (骨格のとおり。任意の `label?: string` を足す。`<fieldset>` の `<legend class="sr-only">` になる)
  - `TerminalPaneHandle` (骨格のとおり)。`TerminalPane` のpropsは `repoName` / `onDeleteSession` / `messageShortcuts` / `onCreateShortcut` / `onUpdateShortcut` / `onDeleteShortcut` を削除し、`ref?: Ref<TerminalPaneHandle>` と `onInputBarVisibleChange?: (visible: boolean) => void` を足す。React 19のrefをpropsで受ける形にする (`forwardRef` で包むと本体700行の字下げが1段ずれ、差分が読めなくなるため。呼び出し側の書き方 `<TerminalPane ref={terminalRef} />` は同じ)
  - `lib/session-header.ts`:
    ```ts
    export interface SessionHeaderLabels { primary: string; branch: string }
    export function resolveSessionHeaderLabels(input: {
      displayName: string | null | undefined;
      repoName: string | undefined;
      branch: string | undefined;
      worktreePath: string;
    }): SessionHeaderLabels;
    export type TerminalMenuAction = "copy-buffer" | "paste-image" | "attach-file" | "reload" | "toggle-input-bar";
    export function terminalMenuActions(input: {
      leftMode: SplitViewLeftMode;
      canCopyBuffer: boolean;
      canUploadFile: boolean;
    }): TerminalMenuAction[];
    export function notificationMenuLabel(enabled: boolean): string;
    export function deleteSessionDescription(worktree: { isMain: boolean } | undefined): string;
    ```
  - `SessionHeaderMenu(props: SessionHeaderMenuProps)` (propsはStep 13のコード)
  - `SplitViewPane` のpropsに `displayName?: string | null` / `notificationsSupported?: boolean` / `notificationsEnabled?: boolean` / `onNotificationsEnabledChange?: (enabled: boolean) => void` を足す
  - `MessageShortcutMenu.tsx` の `export function previewOf(message: string): string`

---

- [ ] **Step 1: 前提を確かめる**

```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper
git branch --show-current
ls packages/web/src/components/StatusChip.tsx packages/web/src/lib/status-tone.ts
grep -n "TERMINAL_BG\|TERMINAL_FG" packages/shared/src/types.ts
grep -n '"chat"' packages/web/src/lib/split-view-left-mode.ts
grep -rn "SplitViewLeftModeToggle\|SPLIT_VIEW_LEFT_MODES" packages e2e --include='*.ts' --include='*.tsx'
```

期待: ブランチは `feat/visual-redesign-paper`。2ファイルが存在し、`packages/shared/src/types.ts` に `TERMINAL_BG` と `TERMINAL_FG` がある。`split-view-left-mode.ts` で `normalizeSplitViewLeftMode` と `readSavedSplitViewLeftMode` の既定が `"chat"` になっている。`SplitViewLeftModeToggle` を参照しているのは `SplitViewPane.tsx` と、トグル自身だけ。

- [ ] **Step 2: `SegmentedControl` の失敗するテストを書く**

`packages/web/src/components/SegmentedControl.test.tsx` を作る。

```tsx
// @vitest-environment jsdom

import { MessagesSquare, SquareTerminal } from "lucide-react";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type SegmentOption, SegmentedControl } from "./SegmentedControl";

type Mode = "terminal" | "chat";

const OPTIONS: readonly SegmentOption<Mode>[] = [
  { value: "terminal", label: "端末", icon: SquareTerminal },
  { value: "chat", label: "会話", icon: MessagesSquare },
];

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function mount(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mountedRoots.push({ root, container });
  return container;
}

function findButton(scope: ParentNode, label: string): HTMLButtonElement {
  const button = scope.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`
  );
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("SegmentedControl", () => {
  it("選択中の項目だけaria-pressed=trueにする", () => {
    const container = mount(
      <SegmentedControl options={OPTIONS} value="chat" onChange={vi.fn()} />
    );

    expect(findButton(container, "会話").getAttribute("aria-pressed")).toBe(
      "true"
    );
    expect(findButton(container, "端末").getAttribute("aria-pressed")).toBe(
      "false"
    );
  });

  it("押した項目の値をonChangeに渡す", () => {
    const onChange = vi.fn();
    const container = mount(
      <SegmentedControl options={OPTIONS} value="chat" onChange={onChange} />
    );

    act(() => findButton(container, "端末").click());

    expect(onChange).toHaveBeenCalledWith("terminal");
  });

  it("文言を表示し、アイコンは読み上げから外す", () => {
    const container = mount(
      <SegmentedControl options={OPTIONS} value="terminal" onChange={vi.fn()} />
    );

    expect(findButton(container, "端末").textContent).toBe("端末");
    expect(container.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(
      2
    );
  });

  it("labelを渡すと、まとまりの読み上げ名にする", () => {
    const container = mount(
      <SegmentedControl
        label="左ペインの表示"
        options={OPTIONS}
        value="terminal"
        onChange={vi.fn()}
      />
    );

    expect(container.querySelector("fieldset > legend")?.textContent).toBe(
      "左ペインの表示"
    );
  });
});
```

- [ ] **Step 3: テストが失敗することを確かめる**

```bash
pnpm vitest run packages/web/src/components/SegmentedControl.test.tsx
```

期待: `FAIL` と `Failed to resolve import "./SegmentedControl"`。

- [ ] **Step 4: `SegmentedControl` を実装する**

`packages/web/src/components/SegmentedControl.tsx` を作る。寸法は参照モックの `.segment` (背景muted・角丸10px・内側2px) と `.segment button` (高さ28px・左右14px・角丸8px・13px/600)。

```tsx
/**
 * SegmentedControl - 表示の切り替え
 *
 * PC上部バーの「端末 / 会話」と、モバイル下部バーの「会話 / 端末 / 図」で使う。
 * 選択中の項目を白いカプセル (bg-card + shadow-card) で持ち上げる。
 * 各項目はaria-pressedを持つトグルボタンで、選択の状態は親が持つ。
 */

import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SegmentOption<V extends string> {
  value: V;
  label: string;
  icon: LucideIcon;
}

interface SegmentedControlProps<V extends string> {
  options: readonly SegmentOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /** まとまりの読み上げ名 (例: 「左ペインの表示」)。画面には出さない */
  label?: string;
  className?: string;
}

export function SegmentedControl<V extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: SegmentedControlProps<V>) {
  return (
    <fieldset
      className={cn(
        "m-0 inline-flex min-w-0 shrink-0 items-center gap-0.5 rounded-md border-0 bg-muted p-0.5",
        className
      )}
    >
      {label && <legend className="sr-only">{label}</legend>}
      {options.map(option => {
        const selected = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            aria-label={option.label}
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-sm px-3.5 text-[13px] font-semibold transition-colors",
              selected
                ? "bg-card text-foreground shadow-card"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            <span>{option.label}</span>
          </button>
        );
      })}
    </fieldset>
  );
}
```

- [ ] **Step 5: テストが通ることを確かめる**

```bash
pnpm vitest run packages/web/src/components/SegmentedControl.test.tsx
```

期待: `Tests  4 passed (4)`。

- [ ] **Step 6: コミットする**

```bash
git branch --show-current  # feat/visual-redesign-paper であること
pnpm biome check --write packages/web/src/components/SegmentedControl.tsx packages/web/src/components/SegmentedControl.test.tsx
pnpm check
git add packages/web/src/components/SegmentedControl.tsx packages/web/src/components/SegmentedControl.test.tsx
git commit -m "feat(web): 表示を切り替えるセグメントコントロールを追加"
```

- [ ] **Step 7: 上部バーの表示とメニュー項目の失敗するテストを書く**

`…` メニューはRadixのPortalに描かれ、開くとPopperが `ResizeObserver` を使うので、jsdomで開いた状態を検証しにくい (このリポジトリにRadixのメニューを開くテストは1件も無い)。どの項目をどの順に出すかと文言を純粋な関数に寄せ、ここで固定する。

`packages/web/src/lib/session-header.test.ts` を作る。

```ts
import { describe, expect, it } from "vitest";
import {
  deleteSessionDescription,
  notificationMenuLabel,
  resolveSessionHeaderLabels,
  terminalMenuActions,
} from "./session-header";

describe("resolveSessionHeaderLabels", () => {
  const base = {
    displayName: null,
    repoName: "recipe-app",
    branch: "feature/login",
    worktreePath: "/work/recipe-app-login",
  };

  it("表示名があれば、前後の空白を落として主ラベルにする", () => {
    expect(
      resolveSessionHeaderLabels({ ...base, displayName: " ログイン画面 " })
    ).toEqual({ primary: "ログイン画面", branch: "feature/login" });
  });

  it("表示名が未設定か空白だけなら、リポジトリ名を主ラベルにする", () => {
    expect(resolveSessionHeaderLabels(base).primary).toBe("recipe-app");
    expect(
      resolveSessionHeaderLabels({ ...base, displayName: "  " }).primary
    ).toBe("recipe-app");
  });

  it("リポジトリ名もブランチも無ければ、worktreeのフォルダ名を使う", () => {
    expect(
      resolveSessionHeaderLabels({
        displayName: undefined,
        repoName: undefined,
        branch: undefined,
        worktreePath: "/work/recipe-app-login",
      })
    ).toEqual({ primary: "recipe-app-login", branch: "recipe-app-login" });
  });
});

describe("terminalMenuActions", () => {
  it("会話モードでは端末の操作を出さない", () => {
    expect(
      terminalMenuActions({
        leftMode: "chat",
        canCopyBuffer: true,
        canUploadFile: true,
      })
    ).toEqual([]);
  });

  it("端末モードでは、コピー・貼り付け・添付・再読み込み・入力バーの順に出す", () => {
    expect(
      terminalMenuActions({
        leftMode: "terminal",
        canCopyBuffer: true,
        canUploadFile: true,
      })
    ).toEqual([
      "copy-buffer",
      "paste-image",
      "attach-file",
      "reload",
      "toggle-input-bar",
    ]);
  });

  it("コピーとアップロードができないときは、その項目を外す", () => {
    expect(
      terminalMenuActions({
        leftMode: "terminal",
        canCopyBuffer: false,
        canUploadFile: false,
      })
    ).toEqual(["reload", "toggle-input-bar"]);
  });
});

describe("notificationMenuLabel", () => {
  it("今の設定を反転する操作として書く", () => {
    expect(notificationMenuLabel(true)).toBe("このセッションの通知をオフにする");
    expect(notificationMenuLabel(false)).toBe("このセッションの通知をオンにする");
  });
});

describe("deleteSessionDescription", () => {
  it("worktreeの有無とmainかどうかで本文を変える", () => {
    expect(deleteSessionDescription(undefined)).toBe(
      "このセッションを削除しますか？"
    );
    expect(deleteSessionDescription({ isMain: true })).toBe(
      "このセッションを削除しますか？メインWorktreeは削除されません。"
    );
    expect(deleteSessionDescription({ isMain: false })).toBe(
      "このセッションとWorktreeを削除しますか？関連するブランチも削除されます。"
    );
  });
});
```

- [ ] **Step 8: テストが失敗することを確かめる**

```bash
pnpm vitest run packages/web/src/lib/session-header.test.ts
```

期待: `FAIL` と `Failed to resolve import "./session-header"`。

- [ ] **Step 9: `lib/session-header.ts` を実装する**

削除確認の文言は、今の `TerminalPane.tsx:877-881` の3通りをそのまま移す。

```ts
/**
 * PC上部バー (SplitViewPane) の表示と、`…` メニュー (SessionHeaderMenu) の中身を決める。
 *
 * メニューはRadixのPortalに描かれ、jsdomでは開いた状態を検証しにくい。
 * どの項目をどの順に出すかと文言をここに寄せ、テストで固定する。
 */

import { getBaseName } from "@/utils/pathUtils";
import type { SplitViewLeftMode } from "./split-view-left-mode";

export interface SessionHeaderLabels {
  /** 主ラベル。表示名 → リポジトリ名 → worktreeのフォルダ名の順に決める */
  primary: string;
  /** ブランチ。worktreeが無ければworktreeのフォルダ名 */
  branch: string;
}

export function resolveSessionHeaderLabels(input: {
  displayName: string | null | undefined;
  repoName: string | undefined;
  branch: string | undefined;
  worktreePath: string;
}): SessionHeaderLabels {
  const folderName = getBaseName(input.worktreePath);
  return {
    primary: input.displayName?.trim() || input.repoName || folderName,
    branch: input.branch || folderName,
  };
}

/** 端末モードのときだけ `…` メニューに出す操作。配列の順がメニューの表示順 */
export type TerminalMenuAction =
  | "copy-buffer"
  | "paste-image"
  | "attach-file"
  | "reload"
  | "toggle-input-bar";

export function terminalMenuActions(input: {
  leftMode: SplitViewLeftMode;
  canCopyBuffer: boolean;
  canUploadFile: boolean;
}): TerminalMenuAction[] {
  // 会話モードの添付と貼り付けは会話の入力欄が担う。端末側の添付確認画面は
  // 端末ペインの中にあり、会話モードでは親ごと隠れているので呼ばない
  if (input.leftMode !== "terminal") return [];
  const actions: TerminalMenuAction[] = [];
  if (input.canCopyBuffer) actions.push("copy-buffer");
  if (input.canUploadFile) actions.push("paste-image", "attach-file");
  actions.push("reload", "toggle-input-bar");
  return actions;
}

export function notificationMenuLabel(enabled: boolean): string {
  return enabled
    ? "このセッションの通知をオフにする"
    : "このセッションの通知をオンにする";
}

export function deleteSessionDescription(
  worktree: { isMain: boolean } | undefined
): string {
  if (worktree === undefined) return "このセッションを削除しますか？";
  return worktree.isMain
    ? "このセッションを削除しますか？メインWorktreeは削除されません。"
    : "このセッションとWorktreeを削除しますか？関連するブランチも削除されます。";
}
```

- [ ] **Step 10: テストが通ることを確かめる**

```bash
pnpm vitest run packages/web/src/lib/session-header.test.ts
```

期待: `Tests  8 passed (8)`。

- [ ] **Step 11: コミットする**

```bash
git branch --show-current  # feat/visual-redesign-paper であること
pnpm biome check --write packages/web/src/lib/session-header.ts packages/web/src/lib/session-header.test.ts
pnpm check
git add packages/web/src/lib/session-header.ts packages/web/src/lib/session-header.test.ts
git commit -m "feat(web): PC上部バーの主ラベルとメニュー項目を決める関数を追加"
```

- [ ] **Step 12: `previewOf` をexportする**

`packages/web/src/components/MessageShortcutMenu.tsx:28` の

```tsx
function previewOf(message: string): string {
```

を次に置き換える。`MessageShortcutMenu` コンポーネント自体はここでは消さない (Task 7の時点ではモバイルが使っている。Task 10のあとの扱いはteam-leadが決める)。

```tsx
export function previewOf(message: string): string {
```

- [ ] **Step 13: `SessionHeaderMenu` を作る**

`packages/web/src/components/SessionHeaderMenu.tsx` を作る。確認ダイアログとショートカット管理ダイアログはメニュー (Portal) の外に兄弟として置く (`MobileSessionView.tsx` の操作メニューと同じ形)。トリガーは `Button` ではなく素の `<button>` にする (`Dashboard.test.tsx` が `@/components/ui/button` を `null` に差し替えているため)。

```tsx
/**
 * SessionHeaderMenu - PC上部バー右端の `…` メニュー
 *
 * 両モード共通: メッセージショートカット (送信と管理) / このセッションの通知 / 削除 (最下段)
 * 端末モードだけ: バッファのコピー / 画像の貼り付け / ファイルの添付 / 端末の再読み込み /
 * 入力バーの表示。端末の操作の実体はTerminalPaneが持ち (TerminalPaneHandle)、
 * ここは呼ぶだけ。どの項目を出すかはlib/session-header.tsが決める。
 * 確認ダイアログとショートカット管理ダイアログはメニューの外に置き、
 * メニューが閉じても開いたままにする。
 */

import type { MessageShortcut, Worktree } from "@ark/shared";
import {
  Bell,
  BellOff,
  Copy,
  Ellipsis,
  ImagePlus,
  MessageSquareQuote,
  Paperclip,
  RefreshCw,
  Settings,
  Trash2,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  deleteSessionDescription,
  notificationMenuLabel,
  type TerminalMenuAction,
  terminalMenuActions,
} from "@/lib/session-header";
import type { SplitViewLeftMode } from "@/lib/split-view-left-mode";
import { MessageShortcutManagerDialog } from "./MessageShortcutManagerDialog";
import { previewOf } from "./MessageShortcutMenu";

export interface SessionHeaderMenuProps {
  leftMode: SplitViewLeftMode;
  worktree: Worktree | undefined;
  messageShortcuts: MessageShortcut[];
  onSendMessage: (message: string) => void;
  onCreateShortcut: (message: string) => void;
  onUpdateShortcut: (id: string, patch: { message?: string }) => void;
  onDeleteShortcut: (id: string) => void;
  notificationsSupported: boolean;
  notificationsEnabled: boolean;
  onNotificationsEnabledChange?: (enabled: boolean) => void;
  /** セッション削除 (停止 + メイン以外のWorktree削除)。確認ダイアログはこのメニューが出す */
  onDeleteSession: () => void;
  /** 以下は端末モードだけの操作。未指定の操作は出さない */
  onCopyBuffer?: () => void;
  onPasteImage?: () => void;
  onAttachFile?: () => void;
  onReloadTerminal: () => void;
  inputBarVisible: boolean;
  onToggleInputBar: () => void;
}

export function SessionHeaderMenu({
  leftMode,
  worktree,
  messageShortcuts,
  onSendMessage,
  onCreateShortcut,
  onUpdateShortcut,
  onDeleteShortcut,
  notificationsSupported,
  notificationsEnabled,
  onNotificationsEnabledChange,
  onDeleteSession,
  onCopyBuffer,
  onPasteImage,
  onAttachFile,
  onReloadTerminal,
  inputBarVisible,
  onToggleInputBar,
}: SessionHeaderMenuProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showShortcutManager, setShowShortcutManager] = useState(false);

  const terminalActions = terminalMenuActions({
    leftMode,
    canCopyBuffer: onCopyBuffer !== undefined,
    canUploadFile: onPasteImage !== undefined && onAttachFile !== undefined,
  });
  const canChangeNotifications =
    notificationsSupported && onNotificationsEnabledChange !== undefined;
  // Recordにして、TerminalMenuActionを足したときの描き忘れを型で拾う
  const terminalItems: Record<TerminalMenuAction, ReactNode> = {
    "copy-buffer": (
      <DropdownMenuItem key="copy-buffer" onSelect={onCopyBuffer}>
        <Copy />
        端末のバッファをコピー
      </DropdownMenuItem>
    ),
    "paste-image": (
      <DropdownMenuItem key="paste-image" onSelect={onPasteImage}>
        <ImagePlus />
        画像を貼り付け
      </DropdownMenuItem>
    ),
    "attach-file": (
      <DropdownMenuItem key="attach-file" onSelect={onAttachFile}>
        <Paperclip />
        ファイルを添付
      </DropdownMenuItem>
    ),
    reload: (
      <DropdownMenuItem key="reload" onSelect={onReloadTerminal}>
        <RefreshCw />
        端末を再読み込み
      </DropdownMenuItem>
    ),
    "toggle-input-bar": (
      <DropdownMenuCheckboxItem
        key="toggle-input-bar"
        checked={inputBarVisible}
        onCheckedChange={() => onToggleInputBar()}
      >
        入力バーを表示
      </DropdownMenuCheckboxItem>
    ),
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="その他の操作"
            title="その他の操作"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
          >
            <Ellipsis className="size-5" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <MessageSquareQuote />
              メッセージショートカット
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-64">
              {messageShortcuts.length === 0 ? (
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  ショートカットがありません
                </DropdownMenuLabel>
              ) : (
                messageShortcuts.map(shortcut => (
                  <DropdownMenuItem
                    key={shortcut.id}
                    title={shortcut.message.slice(0, 200)}
                    onSelect={() => onSendMessage(shortcut.message)}
                  >
                    <span className="truncate">
                      {previewOf(shortcut.message)}
                    </span>
                  </DropdownMenuItem>
                ))
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setShowShortcutManager(true)}>
                <Settings />
                ショートカットを管理
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {canChangeNotifications && (
            <DropdownMenuItem
              onSelect={() =>
                onNotificationsEnabledChange?.(!notificationsEnabled)
              }
            >
              {notificationsEnabled ? <BellOff /> : <Bell />}
              {notificationMenuLabel(notificationsEnabled)}
            </DropdownMenuItem>
          )}
          {terminalActions.length > 0 && <DropdownMenuSeparator />}
          {terminalActions.map(action => terminalItems[action])}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setShowDeleteDialog(true)}
          >
            <Trash2 />
            セッションを削除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <MessageShortcutManagerDialog
        open={showShortcutManager}
        onOpenChange={setShowShortcutManager}
        shortcuts={messageShortcuts}
        onCreate={onCreateShortcut}
        onUpdate={onUpdateShortcut}
        onDelete={onDeleteShortcut}
      />

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent className="bg-card border-border w-[calc(100%-2rem)] max-w-md mx-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>セッションを削除</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteSessionDescription(worktree)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="h-10">キャンセル</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 h-10"
              onClick={() => {
                onDeleteSession();
                setShowDeleteDialog(false);
              }}
            >
              削除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
```

`DropdownMenuItem` の既定クラスが `gap-2` と `[&_svg:not([class*='size-'])]:size-4` を持つので、アイコンに `mr-2` や大きさを付けない。

- [ ] **Step 14: 型とlintを確かめてコミットする**

```bash
pnpm biome check --write packages/web/src/components/SessionHeaderMenu.tsx packages/web/src/components/MessageShortcutMenu.tsx
pnpm check
```

期待: `pnpm check` がエラーなしで終わる (`SessionHeaderMenu` はまだどこからも使われないが、未使用のexportはbiomeもtscも咎めない)。

```bash
git branch --show-current  # feat/visual-redesign-paper であること
git add packages/web/src/components/SessionHeaderMenu.tsx packages/web/src/components/MessageShortcutMenu.tsx
git commit -m "feat(web): PC上部バーの … メニューを追加"
```

- [ ] **Step 15: `TerminalPane` の失敗するテストを書く**

`packages/web/src/components/TerminalPane.test.tsx` を作る。モックは `SplitViewPane.test.tsx` と同じ2つに、トーストを確かめるための `sonner` を足す。

```tsx
// @vitest-environment jsdom

import type { ManagedSession } from "@ark/shared";
import { act, type ComponentProps, createRef, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";

const toastDoubles = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: toastDoubles }));

vi.mock("../hooks/useMobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("../hooks/useTerminalLinkInjection", () => ({
  useTerminalLinkInjection: () => undefined,
}));

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function makeSession(): ManagedSession {
  return {
    id: "terminal-handle",
    worktreeId: "worktree-terminal-handle",
    worktreePath: "/worktrees/terminal-handle",
    status: "active",
    createdAt: new Date("2026-09-17T00:00:00Z"),
    tmuxSessionName: "tmux-terminal-handle",
    ttydPort: 4100,
    ttydUrl: "/ttyd/terminal-handle/",
  };
}

function mountTerminal(
  overrides: Partial<ComponentProps<typeof TerminalPane>> = {}
): {
  ref: RefObject<TerminalPaneHandle | null>;
  container: HTMLDivElement;
} {
  const ref = createRef<TerminalPaneHandle>();
  const session = makeSession();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <TerminalPane
        ref={ref}
        session={session}
        worktree={undefined}
        tabs={[{ type: "terminal", id: `terminal-${session.id}` }]}
        activeTabIndex={0}
        onTabSelect={vi.fn()}
        onTabClose={vi.fn()}
        onSendMessage={vi.fn()}
        onSendKey={vi.fn()}
        onUploadFile={vi.fn(async () => ({
          path: "/uploads/a.txt",
          filename: "a.txt",
        }))}
        {...overrides}
      />
    )
  );
  mountedRoots.push({ root, container });
  return { ref, container };
}

function handleOf(
  ref: RefObject<TerminalPaneHandle | null>
): TerminalPaneHandle {
  expect(ref.current).not.toBeNull();
  return ref.current as TerminalPaneHandle;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  toastDoubles.success.mockClear();
  toastDoubles.info.mockClear();
  toastDoubles.error.mockClear();
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  Reflect.deleteProperty(navigator, "clipboard");
  vi.restoreAllMocks();
});

describe("TerminalPane (PC上部バーから呼ぶ操作)", () => {
  it("自前のヘッダーを持たない", () => {
    const { container } = mountTerminal();

    expect(container.querySelector("header")).toBeNull();
    expect(container.querySelector('[title="セッションを削除"]')).toBeNull();
  });

  it("ttydのiframeを暗い額縁の中に置く", () => {
    const { container } = mountTerminal();

    const frame = container.querySelector<HTMLElement>(
      '[data-testid="terminal-frame"]'
    );
    expect(frame).not.toBeNull();
    // TERMINAL_BG (#1c1a17)。jsdomはrgbに正規化することがある
    expect(frame?.style.backgroundColor).toMatch(
      /^(#1c1a17|rgb\(28, 26, 23\))$/
    );
    expect(frame?.querySelector("iframe")).not.toBeNull();
  });

  it("openFilePickerはTerminalPaneに残したfile inputを開く", () => {
    const clickSpy = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => undefined);
    const { ref, container } = mountTerminal();
    expect(container.querySelector('input[type="file"]')).not.toBeNull();

    act(() => handleOf(ref).openFilePicker());

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("toggleInputBarで入力バーを出し入れし、表示の変化を知らせる", () => {
    const onInputBarVisibleChange = vi.fn();
    const { ref, container } = mountTerminal({ onInputBarVisibleChange });
    expect(container.querySelector("textarea")).toBeNull();
    expect(onInputBarVisibleChange).toHaveBeenLastCalledWith(false);

    act(() => handleOf(ref).toggleInputBar());

    expect(container.querySelector("textarea")).not.toBeNull();
    expect(onInputBarVisibleChange).toHaveBeenLastCalledWith(true);
  });

  it("reloadでttydのiframeを作り直す", () => {
    const { ref, container } = mountTerminal();
    const before = container.querySelector("iframe");
    expect(before).not.toBeNull();

    act(() => handleOf(ref).reload());

    const after = container.querySelector("iframe");
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it("copyBufferはバッファをクリップボードへ書き、トーストで知らせる", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const onCopyBuffer = vi.fn(async () => "tmux buffer");
    const { ref } = mountTerminal({ onCopyBuffer });

    act(() => handleOf(ref).copyBuffer());

    await vi.waitFor(() => {
      expect(toastDoubles.success).toHaveBeenCalledWith(
        "端末のバッファをコピーしました"
      );
    });
    expect(writeText).toHaveBeenCalledWith("tmux buffer");
  });
});
```

- [ ] **Step 16: テストが失敗することを確かめる**

```bash
pnpm vitest run packages/web/src/components/TerminalPane.test.tsx
```

期待: `Tests  6 failed (6)`。理由は `header` が存在する、`terminal-frame` が `null`、`ref.current` が `null` (ハンドルが無い)。

- [ ] **Step 17: `TerminalPane.tsx` のコメントとimportを置き換える**

ファイル先頭の `/**` から `import { ViewerTabBar } from "./ViewerTabBar";` までを次に置き換える (Task 4で足したimportがあっても、この塊ごと置き換える)。

```tsx
/**
 * TerminalPane Component - ttyd iframe with mobile-friendly input
 *
 * PCの左ペインの端末表示。操作は上部バー (SplitViewPane) が持ち、
 * 端末専用の操作はTerminalPaneHandleとして公開する。
 * - ttyd iframeを暗い額縁 (TERMINAL_BG) で囲む
 * - 入力バー (Quick Keysと入力欄) は `…` メニューから出し入れする
 * - ファイルのD&D・貼り付け・添付は、このペインの中の確認画面を経て送る
 */

import {
  type ManagedSession,
  type SpecialKey,
  TERMINAL_BG,
  TERMINAL_FG,
  type Worktree,
} from "@ark/shared";
import {
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  File as FileIcon,
  Send,
  StopCircle,
  X,
  XCircle,
} from "lucide-react";
import {
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { fileToBase64, validateFile } from "../hooks/useFileUpload";
import { useIsMobile } from "../hooks/useMobile";
import { useTerminalLinkInjection } from "../hooks/useTerminalLinkInjection";
import { useTtydReconnect } from "../hooks/useTtydReconnect";
import { FileViewerPane } from "./FileViewerPane";
import { HtmlViewerPane } from "./HtmlViewerPane";
import { ViewerTabBar } from "./ViewerTabBar";
```

- [ ] **Step 18: propsと関数の頭を置き換える**

`interface TerminalPaneProps {` から `  const [showShortcutManager, setShowShortcutManager] = useState(false);` まで (99-163行目) を次に置き換える。`repoName` / `onDeleteSession` / ショートカット4つのpropsと、`showDeleteDialog` / `showShortcutManager` の状態を消す。

```tsx
/** PC上部バーの `…` メニューから呼ぶ、端末専用の操作 */
export interface TerminalPaneHandle {
  /** tmuxバッファをクリップボードへ */
  copyBuffer: () => void;
  /** クリップボードの画像を添付プレビューへ */
  pasteImage: () => void;
  /** TerminalPane内に残した <input type="file"> をclick() */
  openFilePicker: () => void;
  /** ttyd iframeを作り直す */
  reload: () => void;
  /** 入力バーの表示切替 */
  toggleInputBar: () => void;
}

interface TerminalPaneProps {
  ref?: Ref<TerminalPaneHandle>;
  session: ManagedSession;
  worktree: Worktree | undefined;
  /**
   * このペインが実際に画面へ出ているか（既定 true）。
   *
   * ファイル D&D は ttyd iframe がドラッグイベントを親に届けないため
   * window レベルで受けている。TerminalPane は全セッションぶんが常時
   * マウントされ、さらに左ペインが会話モードのときも `display:none` で
   * 残置されるので、無条件に window で受けると「見えていないペイン」にも
   * ドロップが入り、あとで開いたときに身に覚えのない送信プレビューが出る。
   * 表示中の 1 枚だけが受け取るようにこれで絞る。
   */
  isVisible?: boolean;
  onSendMessage: (message: string) => void;
  onSendKey: (key: SpecialKey) => void;
  onUploadFile?: (data: {
    base64Data: string;
    mimeType: string;
    originalFilename?: string;
  }) => Promise<{
    path: string;
    filename: string;
    originalFilename?: string;
  }>;
  onCopyBuffer?: () => Promise<string | null>;
  tabs: ViewerTab[];
  activeTabIndex: number;
  onTabSelect: (index: number) => void;
  onTabClose: (index: number) => void;
  /** 入力バーの表示が変わったとき。`…` メニューのチェック表示に使う */
  onInputBarVisibleChange?: (visible: boolean) => void;
}

export function TerminalPane({
  ref,
  session,
  worktree,
  isVisible = true,
  onSendMessage,
  onSendKey,
  onUploadFile,
  onCopyBuffer,
  tabs,
  activeTabIndex,
  onTabSelect,
  onTabClose,
  onInputBarVisibleChange,
}: TerminalPaneProps) {
  const isMobile = useIsMobile();
  const [inputValue, setInputValue] = useState("");
  const [showInput, setShowInput] = useState(true);
  const [showQuickCommands, setShowQuickCommands] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
```

- [ ] **Step 19: refとバッファのコピーを置き換える**

`  const textareaRef = useRef<HTMLTextAreaElement>(null);` から `handleCopyBuffer` の閉じ `  };` まで (171-198行目) を次に置き換える。`copySuccess` の状態 (成功時にアイコンを緑のチェックに替えていた) は、メニューが選んだ時点で閉じるので使えない。トーストに替える。

```tsx
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // ファイル選択のinput。上部バーの `…` メニュー (Radix Portal) の中に置くと、
  // メニューが閉じた瞬間に消えて、OSのファイル選択画面から戻ってもonChangeが
  // 届かない。このペインに残し、openFilePicker()でclick()だけを呼ばせる
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [iframeKey, setIframeKey] = useState(0);

  // ttyd iframe内のxterm.jsにリンク検出をインジェクト（共通フック）
  useTerminalLinkInjection(iframeRef, iframeKey);

  // 全ての添付ファイル（画像/非画像）を共通でプレビューダイアログに集約する
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [uploadMessage, setUploadMessage] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // tmuxバッファの内容をクリップボードにコピーする。`…` メニューは選んだ
  // 時点で閉じるので、結果はトーストで知らせる
  const handleCopyBuffer = async () => {
    if (!onCopyBuffer) return;
    try {
      const text = await onCopyBuffer();
      if (text) {
        await navigator.clipboard.writeText(text);
        toast.success("端末のバッファをコピーしました");
      } else {
        toast.info("コピーできる内容がありません");
      }
    } catch (err) {
      console.error("Failed to copy:", err);
      toast.error("バッファをコピーできませんでした");
    }
  };
```

- [ ] **Step 20: ハンドルを公開する**

次の既存の呼び出し (465-468行目) の直後に、ハンドルと入力バーの通知を足す。

```tsx
  useTtydReconnect(iframeRef, iframeKey, {
    isVisible: isVisible && tabs[effectiveActiveTabIndex]?.type === "terminal",
    onReload: handleReloadIframe,
  });
```

足すコード:

```tsx

  // 上部バー (SplitViewPane) の `…` メニューから端末専用の操作を呼べるようにする
  useImperativeHandle(ref, () => ({
    copyBuffer: () => {
      handleCopyBuffer();
    },
    pasteImage: () => {
      handlePasteButtonClick();
    },
    openFilePicker: () => {
      fileInputRef.current?.click();
    },
    reload: handleReloadIframe,
    toggleInputBar: () => setShowInput(prev => !prev),
  }));

  useEffect(() => {
    onInputBarVisibleChange?.(showInput);
  }, [showInput, onInputBarVisibleChange]);
```

- [ ] **Step 21: ヘッダーを消し、端末を額縁で囲む**

`  return (` (Step 20で足したコードの直後) から、`{/* ファイルビューワー / ブラウザ */}` の直前までを次に置き換える。消すもの: `<header>` 全体 (状態の点・リポジトリ名・ブランチ・8個のアイコン)。D&Dの重ね表示の青の直書きはトークンに替える。額縁の外側4pxは、ペインの16pxの角丸と同心にするための余白 (設計書6節)。

```tsx
  return (
    <div className="relative h-full flex flex-col overflow-hidden">
      {/* ウィンドウ全体のD&Dオーバーレイ（ドラッグ中のみ表示） */}
      {isDragging && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-primary/15 border-4 border-dashed border-primary pointer-events-none">
          <div className="text-2xl font-semibold text-primary bg-card/90 px-6 py-4 rounded-lg shadow-card">
            ファイルをドロップして送信
          </div>
        </div>
      )}

      {/* タブバー（共通コンポーネント）。diagram は右ペイン専属になったのでタブ一覧からは除外し、
          表示用インデックスと元の tabs 配列インデックスを相互変換する */}
      <ViewerTabBar
        tabs={visibleTabs}
        activeTabIndex={safeVisibleActiveTabIndex}
        onTabSelect={idx => onTabSelect(visibleTabIndexMap[idx])}
        onTabClose={idx => onTabClose(visibleTabIndexMap[idx])}
      />

      {/* ttyd iframe。明るい画面の中の「暗い窓」として額縁で囲む。
          背景色はttydと同じTERMINAL_BG (Tailwindのbg-[#...]は使わない) */}
      <div
        className="flex-1 min-h-0 p-1"
        style={{
          display:
            tabs[effectiveActiveTabIndex]?.type === "terminal"
              ? undefined
              : "none",
        }}
      >
        <div
          data-testid="terminal-frame"
          className="h-full rounded-lg p-2 overflow-hidden"
          style={{ backgroundColor: TERMINAL_BG }}
        >
          {session.ttydUrl || session.ttydPort ? (
            <iframe
              key={iframeKey}
              ref={iframeRef}
              src={ttydIframeSrc}
              className="block w-full h-full border-0"
              title={`Terminal - ${worktree?.branch || session.id}`}
              allow="clipboard-read; clipboard-write; keyboard-map"
            />
          ) : (
            <div
              className="flex items-center justify-center h-full"
              style={{ color: TERMINAL_FG }}
            >
              <div className="text-center">
                <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full mx-auto mb-4" />
                <p>端末を起動しています</p>
              </div>
            </div>
          )}
        </div>
      </div>

```

- [ ] **Step 22: 送信ボタンの `glow-green` を外す**

Task 1で `.glow-green` のCSSは撤去済み。852行目付近の

```tsx
                className="h-11 w-11 md:h-9 md:w-9 glow-green shrink-0"
```

を次に置き換える。

```tsx
                className="h-11 w-11 md:h-9 md:w-9 shrink-0"
```

- [ ] **Step 23: ダイアログを外し、ファイル選択のinputを残す**

`      <MessageShortcutManagerDialog` からファイル末尾の `export default TerminalPane;` までを次に置き換える。ショートカット管理と削除確認は `SessionHeaderMenu` に移した。

```tsx
      {/* 添付ファイル選択用の隠しinput (fileInputRefの説明を参照) */}
      {onUploadFile && (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={e => {
            const files = Array.from(e.target.files ?? []);
            if (files.length > 0) handleFilesSelected(files);
            e.target.value = "";
          }}
        />
      )}
    </div>
  );
}

export default TerminalPane;
```

- [ ] **Step 24: `TerminalPane` のテストが通ることを確かめる**

```bash
pnpm vitest run packages/web/src/components/TerminalPane.test.tsx
```

期待: `Tests  6 passed (6)`。この時点で `SplitViewPane.tsx` は消したpropsを渡しているので `pnpm check` はまだ通らない (Step 30で直す)。

- [ ] **Step 25: `SplitViewPane.test.tsx` を直し、上部バーの失敗するテストを足す**

(a) 3行目のimportを置き換える。

```tsx
import type { BridgeSessionStatus, ManagedSession } from "@ark/shared";
```

を

```tsx
import type {
  BridgeSessionStatus,
  ManagedSession,
  Worktree,
} from "@ark/shared";
```

に。

(b) ファイル直下の `afterEach` を次に置き換える (図を開くテストで `ResizeObserver` を差し替えるため)。

```tsx
afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
```

(c) 既定値のテスト (`it("保存値を正規化し、…")`) はTask 4が会話を既定とする形に書き換え済みなので触らない。

(d) `it("トグル操作で状態と localStorage が変わり、全セッションで共有される", …)` を丸ごと次に置き換える。PCの既定が会話になったので、端末を保存してから会話へ切り替える。会話ラッパのclassNameの完全一致 (`toBe("h-full")`) をやめ、表示・非表示で確かめる。

```tsx
  it("トグル操作で状態と localStorage が変わり、全セッションで共有される", () => {
    localStorage.setItem(STORAGE_KEY_SPLIT_LEFT_MODE, "terminal");
    const sessions = [makeSession("a"), makeSession("b")];
    const container = mount(renderSessions("a", sessions));
    const paneA = container.querySelector('[data-testid="pane-a"]');
    const paneB = container.querySelector('[data-testid="pane-b"]');
    expect(paneA).not.toBeNull();
    expect(paneB).not.toBeNull();

    clickButton(paneA as ParentNode, "会話");

    expect(localStorage.getItem(STORAGE_KEY_SPLIT_LEFT_MODE)).toBe("chat");
    for (const [pane, id] of [
      [paneA, "a"],
      [paneB, "b"],
    ] as const) {
      expect(
        pane
          ?.querySelector('button[aria-label="会話"]')
          ?.getAttribute("aria-pressed")
      ).toBe("true");
      // 会話を表示し、端末は隠したまま残す (ttydのiframeを作り直さない)
      expect(
        pane?.querySelector(`[data-testid="chat-${id}"]`)?.closest(".hidden")
      ).toBeNull();
      expect(pane?.querySelector("iframe")?.closest(".hidden")).not.toBeNull();
    }
  });
```

(e) `it("localStorage 書き込み失敗時も全セッションへ選択モードを通知する", …)` を、タイトルの行から閉じの `});` まで丸ごと次に置き換える。Task 4が `beforeEach` で端末を保存していてもいなくても同じ結果になるよう、始めの状態をテストの中で決める。

```tsx
  it("localStorage 書き込み失敗時も全セッションへ選択モードを通知する", () => {
    localStorage.setItem(STORAGE_KEY_SPLIT_LEFT_MODE, "terminal");
    const sessions = [makeSession("storage-a"), makeSession("storage-b")];
    const container = mount(renderSessions("storage-a", sessions));
    const paneA = container.querySelector('[data-testid="pane-storage-a"]');
    const paneB = container.querySelector('[data-testid="pane-storage-b"]');
    expect(paneA).not.toBeNull();
    expect(paneB).not.toBeNull();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });

    clickButton(paneA as ParentNode, "会話");

    // 書き込みは失敗し、保存値は切り替え前のまま
    expect(localStorage.getItem(STORAGE_KEY_SPLIT_LEFT_MODE)).toBe("terminal");
    for (const pane of [paneA, paneB]) {
      expect(
        pane
          ?.querySelector('button[aria-label="会話"]')
          ?.getAttribute("aria-pressed")
      ).toBe("true");
    }
  });
```

(f) `it("active session と left mode に応じて会話購読と端末 D&D を一枚だけ有効にする", async () => {` の直後の行に、端末を保存する1行を足す (Task 4が同じ行をこのテストの先頭に足していれば、そのままにする)。

```tsx
    localStorage.setItem(STORAGE_KEY_SPLIT_LEFT_MODE, "terminal");
```

(g) ファイル末尾 (最後の `});` の後) に次を足す。

```tsx

function makeWorktree(branch: string): Worktree {
  return {
    id: "worktree-header",
    path: "/worktrees/header",
    branch,
    commit: "0000000",
    isMain: false,
    isBare: false,
  };
}

describe("PC上部バー", () => {
  it("主ラベルは表示名、無ければリポジトリ名。ブランチと状態チップを並べる", () => {
    const session = makeSession("header");
    const container = mount(
      paneSection(session, true, {
        displayName: "ログイン画面",
        repoName: "recipe-app",
        worktree: makeWorktree("feature/login"),
        bridgeStatus: "AWAITING",
      })
    );

    const header = container.querySelector("header");
    expect(header?.textContent).toContain("ログイン画面");
    expect(header?.textContent).not.toContain("recipe-app");
    expect(header?.textContent).toContain("feature/login");
    expect(header?.textContent).toContain("確認待ち");

    const root = mountedRoots.at(-1)?.root;
    act(() =>
      root?.render(
        paneSection(session, true, {
          displayName: null,
          repoName: "recipe-app",
          worktree: makeWorktree("feature/login"),
          bridgeStatus: "AWAITING",
        })
      )
    );
    expect(container.querySelector("header")?.textContent).toContain(
      "recipe-app"
    );
  });

  it("端末 / 会話の切り替え・図の開閉・その他の操作を上部バーに置く", () => {
    // 図を開くとSplitViewPaneが幅の追従にResizeObserverを使う (jsdomに無い)
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      }
    );
    const container = mount(paneSection(makeSession("header-actions"), true));
    const header = container.querySelector("header");
    expect(header).not.toBeNull();
    const scope = header as ParentNode;
    expect(scope.querySelector('button[aria-label="端末"]')).not.toBeNull();
    expect(scope.querySelector('button[aria-label="会話"]')).not.toBeNull();
    expect(
      scope.querySelector('button[aria-label="その他の操作"]')
    ).not.toBeNull();
    expect(
      scope.querySelector('button[aria-label="図"]')?.getAttribute("aria-pressed")
    ).toBe("false");

    clickButton(scope, "図");

    expect(
      scope.querySelector('button[aria-label="図"]')?.getAttribute("aria-pressed")
    ).toBe("true");
    expect(container.querySelector('[data-testid="diagram-pane"]')).not.toBeNull();
  });
});
```

- [ ] **Step 26: 上部バーのテストが失敗することを確かめる**

```bash
pnpm vitest run packages/web/src/components/SplitViewPane.test.tsx
```

期待: `describe("PC上部バー")` の2件がFAIL (今の上部バーは `<div>` なので `header` が `null`)。ほかはPASS。

- [ ] **Step 27: `SplitViewPane.tsx` のコメントとimportを置き換える**

ファイル先頭の `/**` から `import { TerminalPane, type ViewerTab } from "./TerminalPane";` までを次に置き換える。

```tsx
/**
 * SplitViewPane - PC用セッションビュー (上部バー + 左ペイン + 右ペインの左右2ペイン)
 *
 * 上部バーは1本にまとめる。左にセッションの主ラベル・ブランチ・状態チップ、
 * 中央に「端末 / 会話」の切り替え、右に図の開閉と `…` メニュー (SessionHeaderMenu)。
 * 端末専用の操作 (バッファのコピー等) はTerminalPaneHandle経由でTerminalPaneに頼む。
 * 右ペインは図が未選択でも上部バーのトグルで開閉できる。
 * 中身は DiagramPane（B-0a の図ペイン）。
 *
 * - diagram は TerminalPane のタブ機構から外れ、右ペイン専属になった
 *   （タブ自体は sessionTabs 上には残るが、非表示のまま「開いている印」として使う）
 * - 図（openDiagramTab）の activation id が変わると showBoard を自動 true にする
 * - 左ペインのモード / 右ペイン幅 / 右ペイン開閉状態は localStorage に永続化
 * - 左ペインは端末・会話の両方をマウントしたまま display 切替する。ttyd は
 *   iframe（別ブラウジングコンテキスト）なので、アンマウントすると再接続に
 *   なってしまう（.claude/rules/frontend-codegen.md）
 * - 会話ビューには端末への切り替えを持たせない。切り替えは上部バーだけが担う
 */

import type {
  BridgeSessionStatus,
  ClientToServerEvents,
  DiagramCommentsResponse,
  DiagramDeleteResponse,
  DiagramListItem,
  ManagedSession,
  MessageShortcut,
  ServerToClientEvents,
  SpecialKey,
  Worktree,
} from "@ark/shared";
import { MessagesSquare, SquareTerminal, Workflow } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { resolveSessionHeaderLabels } from "../lib/session-header";
import {
  normalizeSplitViewLeftMode,
  readSavedSplitViewLeftMode,
  SPLIT_VIEW_LEFT_MODE_CHANGE_EVENT,
  type SplitViewLeftMode,
  type SplitViewLeftModeChangeDetail,
  STORAGE_KEY_SPLIT_LEFT_MODE,
  shouldAcceptTerminalFileDrop,
  shouldSubscribeChat,
  writeSavedSplitViewLeftMode,
} from "../lib/split-view-left-mode";
import { resolveStatusKey } from "../lib/status-tone";
import { DiagramPane } from "./DiagramPane";
import { type SegmentOption, SegmentedControl } from "./SegmentedControl";
import { SessionHeaderMenu } from "./SessionHeaderMenu";
import { SplitChatPane } from "./SplitChatPane";
import { StatusChip } from "./StatusChip";
import {
  TerminalPane,
  type TerminalPaneHandle,
  type ViewerTab,
} from "./TerminalPane";
```

- [ ] **Step 28: 定数とpropsを足す**

(a) `const STORAGE_KEY_SHOW_BOARD = "ark-split-show-board";` の直後に足す。

```tsx

const LEFT_MODE_OPTIONS: readonly SegmentOption<SplitViewLeftMode>[] = [
  { value: "terminal", label: "端末", icon: SquareTerminal },
  { value: "chat", label: "会話", icon: MessagesSquare },
];
```

(b) propsの

```tsx
  worktree: Worktree | undefined;
  repoName?: string;
```

を次に置き換える。

```tsx
  worktree: Worktree | undefined;
  /** 所属リポジトリの名前。表示名が無いときの主ラベル */
  repoName?: string;
  /** サイドバーで設定したworktreeの表示名。未設定はnull */
  displayName?: string | null;
```

(c) propsの末尾

```tsx
  onDeleteShortcut: (id: string) => void;
}
```

を次に置き換える。

```tsx
  onDeleteShortcut: (id: string) => void;
  /** Notification APIが使える環境か。falseなら `…` メニューに通知の項目を出さない */
  notificationsSupported?: boolean;
  /** このセッションの通知が有効か (未設定は有効) */
  notificationsEnabled?: boolean;
  onNotificationsEnabledChange?: (enabled: boolean) => void;
}
```

- [ ] **Step 29: 端末への参照と上部バーの表示を用意する**

次の既存のブロック (208-211行目) の直後に足す。

```tsx
  const handleLeftModeChange = useCallback((next: SplitViewLeftMode) => {
    writeSavedSplitViewLeftMode(next);
    setLeftMode(next);
  }, []);
```

足すコード:

```tsx

  // 端末専用の操作は `…` メニューからTerminalPaneに頼む。入力バーの表示は、
  // メニューのチェック表示のためにTerminalPaneから知らせてもらう
  const terminalRef = useRef<TerminalPaneHandle>(null);
  const [terminalInputBarVisible, setTerminalInputBarVisible] = useState(false);

  const labels = resolveSessionHeaderLabels({
    displayName: props.displayName,
    repoName: props.repoName,
    branch: props.worktree?.branch,
    worktreePath: props.session.worktreePath,
  });
```

- [ ] **Step 30: 上部バーと端末の配線を置き換え、トグルを削除する**

(a) `  return (` から、`<div ref={containerRef} className="flex-1 min-h-0 flex relative">` の直前まで (310-332行目) を次に置き換える。寸法は参照モックの `.pane` (角丸16px・罫線・影)、`.topbar` (高さ52px・左20px・右12px・間隔12px)、`.topbar-title` (17px/600、ブランチ13px)、`.ghost-btn` (高さ32px・13px/600・アイコン18px)。左右を `flex-1 basis-0` にしてセグメントを真ん中に置く。

```tsx
  return (
    <div className="h-full flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-card">
      {/* 上部バー: 左 = 主ラベル・ブランチ・状態チップ、中央 = 端末 / 会話、
          右 = 図の開閉と `…` メニュー */}
      <header className="h-13 shrink-0 border-b border-border flex items-center gap-3 pl-5 pr-3">
        <div className="flex flex-1 basis-0 min-w-0 items-center gap-2.5">
          <span
            className="min-w-0 truncate text-[17px] font-semibold tracking-[-0.01em]"
            title={labels.primary}
          >
            {labels.primary}
          </span>
          <span
            className="min-w-0 truncate text-[13px] text-muted-foreground"
            title={labels.branch}
          >
            {labels.branch}
          </span>
          <StatusChip
            statusKey={resolveStatusKey(true, props.bridgeStatus)}
            className="shrink-0"
          />
        </div>
        <SegmentedControl
          label="左ペインの表示"
          options={LEFT_MODE_OPTIONS}
          value={leftMode}
          onChange={handleLeftModeChange}
        />
        <div className="flex flex-1 basis-0 min-w-0 items-center justify-end gap-1">
          <button
            type="button"
            onClick={handleToggleBoard}
            aria-label="図"
            aria-pressed={showBoard}
            title={showBoard ? "図を閉じる" : "図を開く"}
            className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sm px-2.5 text-[13px] font-semibold transition-colors ${
              showBoard
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            <Workflow className="size-4.5" aria-hidden="true" />
            <span>図</span>
          </button>
          <SessionHeaderMenu
            leftMode={leftMode}
            worktree={props.worktree}
            messageShortcuts={props.messageShortcuts}
            onSendMessage={props.onSendMessage}
            onCreateShortcut={props.onCreateShortcut}
            onUpdateShortcut={props.onUpdateShortcut}
            onDeleteShortcut={props.onDeleteShortcut}
            notificationsSupported={props.notificationsSupported ?? false}
            notificationsEnabled={props.notificationsEnabled ?? true}
            onNotificationsEnabledChange={props.onNotificationsEnabledChange}
            onDeleteSession={props.onDeleteSession}
            onCopyBuffer={
              props.onCopyBuffer
                ? () => terminalRef.current?.copyBuffer()
                : undefined
            }
            onPasteImage={
              props.onUploadFile
                ? () => terminalRef.current?.pasteImage()
                : undefined
            }
            onAttachFile={
              props.onUploadFile
                ? () => terminalRef.current?.openFilePicker()
                : undefined
            }
            onReloadTerminal={() => terminalRef.current?.reload()}
            inputBarVisible={terminalInputBarVisible}
            onToggleInputBar={() => terminalRef.current?.toggleInputBar()}
          />
        </div>
      </header>

```

(b) 端末のラッパの中の `<TerminalPane … />` (348-366行目) を次に置き換える。`repoName` / `onDeleteSession` / ショートカット4つは渡さない。

```tsx
            <TerminalPane
              ref={terminalRef}
              session={props.session}
              worktree={props.worktree}
              isVisible={shouldAcceptTerminalFileDrop(props.isActive, leftMode)}
              tabs={props.tabs}
              activeTabIndex={props.activeTabIndex}
              onTabSelect={props.onTabSelect}
              onTabClose={props.onTabClose}
              onSendMessage={props.onSendMessage}
              onSendKey={props.onSendKey}
              onUploadFile={props.onUploadFile}
              onCopyBuffer={props.onCopyBuffer}
              onInputBarVisibleChange={setTerminalInputBarVisible}
            />
```

(c) 旧トグルを削除する。

```bash
git rm packages/web/src/components/SplitViewLeftModeToggle.tsx
```

- [ ] **Step 31: 関連テストと型を確かめる**

```bash
pnpm biome check --write packages/web/src/components/SplitViewPane.tsx packages/web/src/components/SplitViewPane.test.tsx packages/web/src/components/TerminalPane.tsx packages/web/src/components/TerminalPane.test.tsx
pnpm check
pnpm vitest run packages/web/src/components/SplitViewPane.test.tsx packages/web/src/components/TerminalPane.test.tsx packages/web/src/components/SegmentedControl.test.tsx packages/web/src/lib/session-header.test.ts packages/web/src/pages/Dashboard.test.tsx
```

期待: `pnpm check` がエラーなしで終わる。テストはすべてPASS (`SplitViewPane.test.tsx` はStep 25で足した2件を含む)。

`pnpm check` が `lucide-react` の未使用importや `noUnusedVariables` で落ちたら、消し漏れ (`Check` `Copy` `GitBranch` `ImageIcon` `Keyboard` `Paperclip` `RefreshCw` `Trash2` `MessageShortcutMenu` `MessageShortcutManagerDialog` `AlertDialog*` `copySuccess`) が残っている。

- [ ] **Step 32: コミットする**

```bash
git branch --show-current  # feat/visual-redesign-paper であること
git add packages/web/src/components/SplitViewPane.tsx packages/web/src/components/SplitViewPane.test.tsx packages/web/src/components/TerminalPane.tsx packages/web/src/components/TerminalPane.test.tsx
git commit -m "feat(web): PC上部バーを1本にまとめ、端末を額縁で囲む"
```

(`SplitViewLeftModeToggle.tsx` の削除はStep 30の `git rm` でステージ済み)

- [ ] **Step 33: Dashboardの配線の失敗するテストを書く**

`packages/web/src/pages/Dashboard.test.tsx` の末尾に足す。表示名は `SessionSidebar` / `sessionNotificationLabels` と同じく `worktreeDisplayNames.get(worktree?.path ?? session.worktreePath)` から取る。

```tsx

describe("Dashboardの上部バー配線", () => {
  it("上部バーに表示名と状態チップを出す", () => {
    const session = makeSession();
    testDoubles.socketState = {
      ...socketState(session),
      worktreeDisplayNames: new Map([[session.worktreePath, "ログイン画面"]]),
    };

    mount(<Dashboard />);

    const header = mountedRoot?.container.querySelector("header");
    expect(header?.textContent).toContain("ログイン画面");
    expect(header?.textContent).toContain("確認待ち");
  });

  it("サーバーとの切断を日本語の帯で知らせる", () => {
    const session = makeSession();
    testDoubles.socketState = { ...socketState(session), isConnected: false };

    mount(<Dashboard />);

    const text = mountedRoot?.container.textContent ?? "";
    expect(text).toContain("サーバーとつながっていません");
    expect(text).not.toContain("Not connected to server");
  });
});
```

- [ ] **Step 34: テストが失敗することを確かめる**

```bash
pnpm vitest run packages/web/src/pages/Dashboard.test.tsx
```

期待: 追加した2件がFAIL (主ラベルが `dashboard` のまま / 帯が `Not connected to server`)。既存の1件はPASS。

- [ ] **Step 35: 切断の帯を直す**

(a) 2行目のimport

```tsx
import { AlertCircle, Copy, Loader2, Terminal } from "lucide-react";
```

を次に置き換える (`AlertCircle` はこの帯だけで使っていた)。

```tsx
import { Copy, Loader2, Terminal, WifiOff } from "lucide-react";
```

(b) 766-771行目の帯

```tsx
              {!isConnected && (
                <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 flex items-center gap-2 text-destructive text-sm shrink-0">
                  <AlertCircle className="w-4 h-4" />
                  <span>Not connected to server</span>
                </div>
              )}
```

を次に置き換える。

```tsx
              {!isConnected && (
                <div
                  role="status"
                  className="border-b border-status-error/30 bg-status-error/15 px-4 py-2 flex items-center gap-2 text-status-error text-sm font-medium shrink-0"
                >
                  <WifiOff className="w-4 h-4" aria-hidden="true" />
                  <span>サーバーとつながっていません</span>
                </div>
              )}
```

- [ ] **Step 36: 表示名・リポジトリ名・通知設定をSplitViewPaneへ渡す**

(a) 819-823行目の

```tsx
                  const rn = (() => {
                    if (repoList.length === 0) return undefined;
                    const repo = findRepoForSession(session, repoList);
                    return repo ? getBaseName(repo) : undefined;
                  })();
```

を次に置き換える。今の `findRepoForSession` は兄弟ディレクトリ (`<repo>-xxx`) の推定しかせず、`<repo>/.worktrees/…` 配下のworktreeではリポジトリ名が出ない。サイドバー (`useGroupedWorktreeItems`) と同じ順で所属を決め、上部バーとサイドバーの主ラベルを食い違わせない。

```tsx
                  // 主ラベルに使うリポジトリ名。サイドバー (useGroupedWorktreeItems) と
                  // 同じ順 (session.repoPath → worktreeのパス → 兄弟ディレクトリの推定) で決める
                  const repoPathOfSession =
                    session.repoPath ??
                    (wt
                      ? repoList.find(repo => wt.path.startsWith(repo))
                      : undefined) ??
                    findRepoForSession(session, repoList);
                  const rn = repoPathOfSession
                    ? getBaseName(repoPathOfSession)
                    : undefined;
                  // サイドバー (SessionSectionList) と通知の文言と同じ出所
                  const displayName =
                    worktreeDisplayNames.get(wt?.path ?? session.worktreePath) ??
                    null;
```

(b) `paneProps` の

```tsx
                    repoName: rn,
```

を次に置き換える。

```tsx
                    repoName: rn,
                    displayName,
```

(c) `paneProps` の末尾

```tsx
                    onDeleteShortcut: deleteShortcut,
                  };
```

を次に置き換える。通知の出所はサイドバー (`SessionSidebar` に渡している `notificationsSupported` / `isSessionNotificationEnabled` / `onSessionNotificationEnabledChange`) と同じ。

```tsx
                    onDeleteShortcut: deleteShortcut,
                    notificationsSupported: sessionNotifications.supported,
                    notificationsEnabled: isSessionNotificationEnabled(
                      session.id
                    ),
                    onNotificationsEnabledChange: (enabled: boolean) =>
                      handleSessionNotificationEnabledChange(
                        session.id,
                        enabled
                      ),
                  };
```

(d) セッションごとのラッパ

```tsx
                      className={isActive ? "h-full flex flex-col" : "hidden"}
```

を次に置き換える。ペインの外周12px (設計書6節)。左だけ4pxにするのは、参照モックでサイドバー側が右に8pxの余白を持つため (`.sidebar` の `padding: 12px 8px 12px 12px` と `.main` の `padding: 12px 12px 12px 4px`)。

```tsx
                      className={
                        isActive ? "h-full flex flex-col p-3 pl-1" : "hidden"
                      }
```

(e) サイドバーとメインの境界線をやめる。参照モックはサイドバーに区切り線を持たず、メインのペインが紙の上のカードとして浮く。
`packages/web/src/components/SidebarMainLayout.tsx` の

```tsx
        className="shrink-0 border-r border-border relative flex flex-col"
```

を次に置き換える。

```tsx
        className="shrink-0 relative flex flex-col"
```

- [ ] **Step 37: テストと型を確かめる**

```bash
pnpm biome check --write packages/web/src/pages/Dashboard.tsx packages/web/src/pages/Dashboard.test.tsx packages/web/src/components/SidebarMainLayout.tsx
pnpm check
pnpm vitest run packages/web/src
```

期待: `pnpm check` がエラーなしで終わる。`packages/web/src` のテストがすべてPASS (`Dashboard.test.tsx` はStep 33で足した2件を含む3件)。

- [ ] **Step 38: コミットする**

```bash
git branch --show-current  # feat/visual-redesign-paper であること
git add packages/web/src/pages/Dashboard.tsx packages/web/src/pages/Dashboard.test.tsx packages/web/src/components/SidebarMainLayout.tsx
git commit -m "feat(web): 上部バーへ表示名と通知設定を配線し、切断の帯を日本語にする"
```

---

### Task 8: 会話: ツール行の折りたたみ

設計書8.3節の「ツール行を折りたたむ」を実装する。`groupSidechain` を `SplitChatPane.tsx` から純粋関数のモジュールへ移し、その後段に `groupToolCalls` を足す。描画は「作業N件」の1行で、押すと今のツール行が開く。

決めたこと:

- **まとまりのid** は `tg:${calls[0].id}` (先頭のtool-callのid = toolUseId)。tool_resultが届いて `done` になっても変わらない。過去履歴の読み込みで先頭側にツール呼び出しが増えて先頭が変わった場合は、そのまとまりの展開が閉じる (許容する)
- **展開状態は `SplitChatPane` 本体に `ReadonlySet<string>` (まとまりのidの集合) で持つ**。カード内の `useState` にしない理由: `useSessionJsonl` は非表示 (`isActive=false`) の間 `events` を空にするので、カードがアンマウントされて開いた状態が消える。本体に持てば端末と会話を切り替えても開いたまま残る。セッションが変わったら空にする
- **thinking**: まとまりが開いている間の `thinking` は出力に含めない (`EventCard` は元から `null` を返すので見た目は変わらない)。まとまりの外の `thinking` はそのまま出す
- **「最新のrunning」** = `calls` の配列順で最後の `running`。並列の `tool_use` は同じtimestampを持つのでtimestampでは決めない
- **表示は「作業N件」だけ**。参照モックの「— ファイルを4つ編集、テストを2回実行」は設計書に無いので入れない。閉じているときだけ `latestRunning` を下に1行出し、開いているときは全件を出す (実行中の行を二重に出さない)
- ツール行の `⚙` はこのタスクでlucideの `Wrench` に置き換える (ツール行を作り直すため)。残りの絵文字はTask 9で置き換える

**Files:**
- Create: `packages/web/src/lib/chat-render-items.ts`
- Test: `packages/web/src/lib/chat-render-items.test.ts`
- Modify: `packages/web/src/components/SplitChatPane.tsx`
  - import (22-29行目のlucide、49-59行目の `@/lib/*`)
  - `ToolCallCard` (508-567行目) を `summarizeToolInput` / `ToolCallRow` / `ToolCallCard` / `ToolGroupCard` に置き換え
  - ローカルの `groupSidechain` (710-733行目) を削除
  - `groupedEvents` (943-944行目) を `renderItems` と展開状態に置き換え
  - 描画の `groupedEvents.map` (1301-1315行目) を置き換え
- Modify: `packages/web/src/lib/jsonl-event-parser.ts` (24-25行目のコメントだけ)
- Test: `packages/web/src/components/SplitChatPane.test.tsx` (新規。Task 9で追記する)

**Interfaces:**
- Consumes:
  - `JsonlParsedEvent` / `ToolCallEvent` (`packages/web/src/lib/jsonl-event-parser.ts`。`ToolCallEvent` は64行目で既にexportされている)
  - Task 1の `text-status-busy` と、`--radius: 0.75rem` による `rounded-sm` = 8px
- Produces (00-head.mdのとおり):
  ```ts
  // packages/web/src/lib/chat-render-items.ts
  export type { ToolCallEvent } from "./jsonl-event-parser"; // Extractを再定義せず再輸出する
  export type SidechainGroupedItem =
    | { kind: "event"; event: JsonlParsedEvent }
    | { kind: "sidechain"; id: string; events: JsonlParsedEvent[] };
  export type ChatRenderItem =
    | SidechainGroupedItem
    | { kind: "tool-group"; id: string; calls: ToolCallEvent[]; latestRunning: ToolCallEvent | null };
  export function groupSidechain(events: JsonlParsedEvent[]): SidechainGroupedItem[];
  export function groupToolCalls(items: SidechainGroupedItem[]): ChatRenderItem[];
  ```
  - `SplitChatPane.tsx` 内部: `ToolGroupCard` (props `calls` / `latestRunning` / `expanded` / `onToggle` / `surfaceClassName`)。Task 9で `surfaceClassName` をlayoutによって切り替える

- [ ] **Step 1: 純粋関数の失敗するテストを書く**

`packages/web/src/lib/chat-render-items.test.ts` を作る。

```ts
import { describe, expect, it } from "vitest";
import {
  type ChatRenderItem,
  groupSidechain,
  groupToolCalls,
  type ToolCallEvent,
} from "./chat-render-items";
import type { JsonlParsedEvent } from "./jsonl-event-parser";

function tool(
  id: string,
  status: "running" | "done" = "done",
  extra: Partial<ToolCallEvent> = {}
): ToolCallEvent {
  return {
    id,
    kind: "tool-call",
    tool: "Bash",
    input: { command: `echo ${id}` },
    status,
    toolUseId: id,
    ...extra,
  };
}

function askUserQuestion(
  id: string,
  status: "running" | "done" = "done"
): ToolCallEvent {
  return tool(id, status, {
    tool: "AskUserQuestion",
    input: { questions: [] },
  });
}

const userInput = (id: string): JsonlParsedEvent => ({
  id,
  kind: "user-input",
  text: "依頼",
});
const assistantText = (id: string): JsonlParsedEvent => ({
  id,
  kind: "assistant-text",
  text: "返答",
});
const thinking = (id: string): JsonlParsedEvent => ({
  id,
  kind: "thinking",
  text: "考え中",
});

/** groupSidechain → groupToolCallsを通した結果を、比較しやすい文字列の列に写す */
function shape(events: JsonlParsedEvent[]): string[] {
  return groupToolCalls(groupSidechain(events)).map(item => {
    if (item.kind === "sidechain") {
      return `sidechain:${item.events.map(e => e.id).join(",")}`;
    }
    if (item.kind === "tool-group") {
      return `tools:${item.calls.map(c => c.id).join(",")}`;
    }
    return `${item.event.kind}:${item.event.id}`;
  });
}

type ToolGroup = Extract<ChatRenderItem, { kind: "tool-group" }>;

/** まとまりが1つだけできる入力から、そのまとまりを取り出す */
function onlyToolGroup(events: JsonlParsedEvent[]): ToolGroup {
  const groups = groupToolCalls(groupSidechain(events)).filter(
    (item): item is ToolGroup => item.kind === "tool-group"
  );
  expect(groups).toHaveLength(1);
  return groups[0];
}

describe("groupSidechain", () => {
  it("連続するsidechainイベントを1つのまとまりにし、idは先頭のイベントから作る", () => {
    const items = groupSidechain([
      userInput("u1"),
      tool("s1", "done", { isSidechain: true }),
      { id: "s2", kind: "assistant-text", text: "調査結果", isSidechain: true },
      assistantText("a1"),
    ]);

    expect(items.map(item => item.kind)).toEqual([
      "event",
      "sidechain",
      "event",
    ]);
    const group = items[1];
    expect(group.kind === "sidechain" && group.id).toBe("sc:s1");
    expect(
      group.kind === "sidechain" && group.events.map(e => e.id)
    ).toEqual(["s1", "s2"]);
  });

  it("本流のイベントを挟んだsidechainは別のまとまりになる", () => {
    expect(
      shape([
        tool("s1", "done", { isSidechain: true }),
        userInput("u1"),
        tool("s2", "done", { isSidechain: true }),
      ])
    ).toEqual(["sidechain:s1", "user-input:u1", "sidechain:s2"]);
  });
});

describe("groupToolCalls", () => {
  it("連続するtool-callを1つのまとまりにし、idは先頭のtool-callから作る", () => {
    expect(
      shape([userInput("u1"), tool("t1"), tool("t2"), assistantText("a1")])
    ).toEqual(["user-input:u1", "tools:t1,t2", "assistant-text:a1"]);
    expect(onlyToolGroup([tool("t1"), tool("t2")]).id).toBe("tg:t1");
  });

  it("1件だけのまとまりも折りたたむ", () => {
    expect(shape([userInput("u1"), tool("t1"), assistantText("a1")])).toEqual(
      ["user-input:u1", "tools:t1", "assistant-text:a1"]
    );
  });

  const boundaries: Array<[string, JsonlParsedEvent]> = [
    ["user-input", userInput("b")],
    ["assistant-text", assistantText("b")],
    ["slash-command", { id: "b", kind: "slash-command", name: "/compact" }],
    ["compact-marker", { id: "b", kind: "compact-marker" }],
  ];

  it.each(boundaries)("%sでまとまりを閉じる", (kind, boundary) => {
    expect(shape([tool("t1"), boundary, tool("t2")])).toEqual([
      "tools:t1",
      `${kind}:b`,
      "tools:t2",
    ]);
  });

  it("sidechainのまとまりでまとまりを閉じる", () => {
    expect(
      shape([tool("t1"), tool("s1", "done", { isSidechain: true }), tool("t2")])
    ).toEqual(["tools:t1", "sidechain:s1", "tools:t2"]);
  });

  it("sidechainの中のtool-callは折りたたみの対象にしない", () => {
    expect(
      shape([
        tool("s1", "done", { isSidechain: true }),
        tool("s2", "running", { isSidechain: true }),
      ])
    ).toEqual(["sidechain:s1,s2"]);
  });

  it.each(["done", "running"] as const)(
    "AskUserQuestion (%s) は折りたたまずに独立して出し、まとまりを閉じる",
    status => {
      expect(
        shape([tool("t1"), askUserQuestion("q1", status), tool("t2")])
      ).toEqual(["tools:t1", "tool-call:q1", "tools:t2"]);
    }
  );

  it("thinkingはまとまりを閉じず、まとまりの途中にあれば出力に含めない", () => {
    expect(shape([tool("t1"), thinking("th1"), tool("t2")])).toEqual([
      "tools:t1,t2",
    ]);
  });

  it("まとまりの外のthinkingはそのまま出す", () => {
    expect(shape([userInput("u1"), thinking("th1"), tool("t1")])).toEqual([
      "user-input:u1",
      "thinking:th1",
      "tools:t1",
    ]);
  });

  it("全件doneのまとまりはlatestRunningがnull", () => {
    expect(onlyToolGroup([tool("t1"), tool("t2")]).latestRunning).toBeNull();
  });

  it("latestRunningはrunningのうち配列順で最後の1件", () => {
    const group = onlyToolGroup([
      tool("a", "running"),
      tool("b", "done"),
      tool("c", "running"),
    ]);
    expect(group.latestRunning?.id).toBe("c");
  });

  it("最後の1件がdoneでも、それより前にrunningがあれば実行中として扱う (並列の呼び出し)", () => {
    const group = onlyToolGroup([
      tool("a", "running"),
      tool("b", "running"),
      tool("c", "done"),
    ]);
    expect(group.latestRunning?.id).toBe("b");
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `pnpm vitest run packages/web/src/lib/chat-render-items.test.ts`
Expected: FAIL。`./chat-render-items` が存在しないため、importの解決に失敗する (`Failed to load url ./chat-render-items` などのエラー)

- [ ] **Step 3: `chat-render-items.ts` を実装する**

`packages/web/src/lib/chat-render-items.ts` を作る。`groupSidechain` の中身は `SplitChatPane.tsx` 710-733行目からそのまま移す。

```ts
/**
 * chat-render-items - 会話ビューの描画単位をJSONLイベント列から組み立てる純粋関数。
 *
 * 1. groupSidechain: 連続するsubagent (isSidechain) イベントを1つのまとまりに畳む
 * 2. groupToolCalls: sidechainの外で連続するツール呼び出しを「作業N件」の
 *    1つのまとまりに畳む
 *
 * ツール呼び出しのまとまりを閉じるもの (境界):
 *   user-input / assistant-text / slash-command / compact-marker /
 *   sidechainのまとまり / AskUserQuestionのtool-call
 * 表示されないthinkingは境界にしない (まとまりの途中にあれば出力から落とす)。
 */

import type { JsonlParsedEvent, ToolCallEvent } from "./jsonl-event-parser";

export type { ToolCallEvent } from "./jsonl-event-parser";

export type SidechainGroupedItem =
  | { kind: "event"; event: JsonlParsedEvent }
  | { kind: "sidechain"; id: string; events: JsonlParsedEvent[] };

export type ChatRenderItem =
  | SidechainGroupedItem
  | {
      kind: "tool-group";
      /** 先頭のtool-callのidから作る。tool_resultが届いても変わらない */
      id: string;
      calls: ToolCallEvent[];
      /** statusがrunningのうち配列順で最後の1件。無ければnull */
      latestRunning: ToolCallEvent | null;
    };

/** 連続するsidechainイベントを1グループに畳む */
export function groupSidechain(
  events: JsonlParsedEvent[]
): SidechainGroupedItem[] {
  const out: SidechainGroupedItem[] = [];
  for (const ev of events) {
    if (ev.isSidechain === true) {
      const last = out[out.length - 1];
      if (last && last.kind === "sidechain") {
        last.events.push(ev);
      } else {
        out.push({ kind: "sidechain", id: `sc:${ev.id}`, events: [ev] });
      }
    } else {
      out.push({ kind: "event", event: ev });
    }
  }
  return out;
}

/** 折りたたみの対象か。AskUserQuestionは回答済みカードとして独立して出す */
function isCollapsibleToolCall(
  event: JsonlParsedEvent
): event is ToolCallEvent {
  return event.kind === "tool-call" && event.tool !== "AskUserQuestion";
}

/**
 * runningのうち配列順で最後の1件。並列の呼び出しは結果の届いたものから
 * doneになるので、最後の1件のstatusだけでは実行中かを判定しない
 */
function findLatestRunning(calls: ToolCallEvent[]): ToolCallEvent | null {
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i].status === "running") return calls[i];
  }
  return null;
}

function flushToolGroup(out: ChatRenderItem[], calls: ToolCallEvent[]): void {
  if (calls.length === 0) return;
  out.push({
    kind: "tool-group",
    id: `tg:${calls[0].id}`,
    calls,
    latestRunning: findLatestRunning(calls),
  });
}

/** sidechainの外で連続するtool-callを「作業N件」のまとまりに畳む */
export function groupToolCalls(
  items: SidechainGroupedItem[]
): ChatRenderItem[] {
  const out: ChatRenderItem[] = [];
  let calls: ToolCallEvent[] = [];
  for (const item of items) {
    if (item.kind === "event") {
      const ev = item.event;
      if (isCollapsibleToolCall(ev)) {
        calls.push(ev);
        continue;
      }
      // 表示されないthinkingはまとまりを閉じない
      if (ev.kind === "thinking" && calls.length > 0) continue;
    }
    flushToolGroup(out, calls);
    calls = [];
    out.push(item);
  }
  flushToolGroup(out, calls);
  return out;
}
```

- [ ] **Step 4: テストを実行して通過を確認する**

Run: `pnpm vitest run packages/web/src/lib/chat-render-items.test.ts`
Expected: PASS (`Test Files  1 passed`、全ケース通過)

- [ ] **Step 5: 整形・型とlintを通してコミットする**

Run: `pnpm biome check --write packages/web/src/lib/chat-render-items.ts packages/web/src/lib/chat-render-items.test.ts && pnpm check`
Expected: `biome check` と `tsc -b` がエラーなしで終わる

```bash
git branch --show-current   # feat/visual-redesign-paperであること
git add packages/web/src/lib/chat-render-items.ts packages/web/src/lib/chat-render-items.test.ts
git commit -m "会話のツール行をまとめる純粋関数を追加"
```

- [ ] **Step 6: 描画の失敗するテストを書く**

`packages/web/src/components/SplitChatPane.test.tsx` を作る。偽のsocketで `session:jsonl-snapshot` を流し、実際の `useSessionJsonl` を通して描画させる。この土台はTask 9でも使う。

```tsx
// @vitest-environment jsdom

import type { ManagedSession } from "@ark/shared";
import { act, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SplitChatPane } from "./SplitChatPane";

type ChatSocket = NonNullable<ComponentProps<typeof SplitChatPane>["socket"]>;

/** on / off / emitだけを持つsocketの偽物。サーバーからのpushはemitServerで起こす */
function createFakeSocket() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const fake = {
    on(event: string, handler: (data: unknown) => void) {
      const set = handlers.get(event) ?? new Set<(data: unknown) => void>();
      set.add(handler);
      handlers.set(event, set);
      return fake;
    },
    off(event: string, handler: (data: unknown) => void) {
      handlers.get(event)?.delete(handler);
      return fake;
    },
    emit: vi.fn(),
  };
  const emitServer = (event: string, data: unknown) => {
    act(() => {
      for (const handler of handlers.get(event) ?? []) handler(data);
    });
  };
  return { socket: fake as unknown as ChatSocket, emitServer };
}

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function mount(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mountedRoots.push({ root, container });
  return container;
}

function makeSession(id: string): ManagedSession {
  return {
    id,
    worktreeId: `worktree-${id}`,
    worktreePath: `/worktrees/${id}`,
    status: "active",
    createdAt: new Date("2026-09-17T00:00:00Z"),
    tmuxSessionName: `tmux-${id}`,
    ttydPort: 4100,
    ttydUrl: `/ttyd/${id}/`,
  };
}

function renderChat(
  overrides: Partial<ComponentProps<typeof SplitChatPane>> = {}
) {
  const { socket, emitServer } = createFakeSocket();
  const onSendMessage = vi.fn();
  const onSendKey = vi.fn();
  const container = mount(
    <SplitChatPane
      socket={socket}
      session={makeSession("s1")}
      isActive
      onSendMessage={onSendMessage}
      onSendKey={onSendKey}
      {...overrides}
    />
  );
  return { container, emitServer, onSendMessage, onSendKey };
}

const line = (record: unknown) => JSON.stringify(record);

/** 依頼 → Read (完了) とBash (実行中) の2件のツール呼び出し */
const TOOL_SNAPSHOT = [
  line({
    type: "user",
    uuid: "u1",
    message: { role: "user", content: "テストを直して" },
  }),
  line({
    type: "assistant",
    uuid: "a1",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "Read",
          input: { file_path: "src/app.ts" },
        },
        {
          type: "tool_use",
          id: "t2",
          name: "Bash",
          input: { command: "pnpm test" },
        },
      ],
    },
  }),
  line({
    type: "user",
    uuid: "r1",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
    },
  }),
];

function findButtonByText(scope: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(scope.querySelectorAll("button")).find(b =>
    b.textContent?.includes(text)
  );
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("SplitChatPane: ツール行の折りたたみ", () => {
  it("連続するツール呼び出しを「作業N件」の1行に畳み、実行中の最新の1件だけを下に出す", () => {
    const { container, emitServer } = renderChat();
    emitServer("session:jsonl-snapshot", {
      sessionId: "s1",
      lines: TOOL_SNAPSHOT,
    });

    const summary = findButtonByText(container, "作業2件");
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("pnpm test");
    expect(container.textContent).not.toContain("src/app.ts");
  });

  it("押すと既存のツール行が開き、実行中の行を二重に出さない", () => {
    const { container, emitServer } = renderChat();
    emitServer("session:jsonl-snapshot", {
      sessionId: "s1",
      lines: TOOL_SNAPSHOT,
    });

    const summary = findButtonByText(container, "作業2件");
    act(() => summary.click());

    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("src/app.ts");
    expect(container.textContent?.split("pnpm test")).toHaveLength(2);
  });
});
```

- [ ] **Step 7: テストを実行して失敗を確認する**

Run: `pnpm vitest run packages/web/src/components/SplitChatPane.test.tsx`
Expected: FAIL。2件とも `findButtonByText` の `expect(button).toBeDefined()` で落ちる (「作業2件」のボタンがまだ無い)

- [ ] **Step 8: `SplitChatPane.tsx` のimportを足す**

22-29行目のlucideのimportを次にする。

```tsx
import {
  ArrowDown,
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  Paperclip,
  Send,
  Workflow,
  Wrench,
} from "lucide-react";
```

49-54行目の `@/lib/ask-user-question-state` のimportの直後に次を足す。

```tsx
import {
  groupSidechain,
  groupToolCalls,
  type ToolCallEvent,
} from "@/lib/chat-render-items";
```

- [ ] **Step 9: ツール行を作り直し、「作業N件」のカードを足す**

`function ToolCallCard({` (508行目) から、その関数の閉じ括弧 (567行目、直後に `/**\n * AWAITING フォールバックのミニ操作パッド。` が続く) までを次で置き換える。

```tsx
/** 入力引数から1行サマリを取る: file_path / command / pattern / urlなど、最初に見つかった "らしい" 値 */
function summarizeToolInput(input: Record<string, unknown>): string {
  const keys = [
    "file_path",
    "command",
    "pattern",
    "query",
    "url",
    "path",
    "description",
    "prompt",
  ];
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string" && v.length > 0) {
      return v.length > 100 ? `${v.slice(0, 100)}…` : v;
    }
  }
  return "";
}

/** ツール呼び出し1件の1行表示 (ツール名 + 引数の要約) */
function ToolCallRow({
  tool,
  input,
  running = false,
}: {
  tool: string;
  input: Record<string, unknown>;
  /** 折りたたんだまとまりの下に出す「実行中の最新の1件」か */
  running?: boolean;
}) {
  const summary = useMemo(() => summarizeToolInput(input), [input]);
  return (
    <div className="inline-flex max-w-full items-center gap-2 text-xs text-muted-foreground">
      <Wrench
        aria-hidden="true"
        className={`size-3.5 shrink-0 ${running ? "text-status-busy" : "opacity-60"}`}
      />
      {running && <span className="sr-only">実行中:</span>}
      <span className="shrink-0 font-medium text-foreground">{tool}</span>
      {summary && (
        <span className="min-w-0 truncate font-mono opacity-70">
          {summary}
        </span>
      )}
    </div>
  );
}

function ToolCallCard({
  tool,
  input,
  result,
  structuredResult,
  isError,
}: {
  tool: string;
  input: Record<string, unknown>;
  result: string | undefined;
  structuredResult?: unknown;
  isError?: boolean;
}) {
  // AskUserQuestion は専用レンダリング
  if (tool === "AskUserQuestion") {
    return (
      <AskUserQuestionResultCard
        input={input}
        result={result}
        structuredResult={structuredResult}
        isError={isError}
      />
    );
  }

  return (
    <div className="px-4 py-1">
      <ToolCallRow tool={tool} input={input} />
    </div>
  );
}

/**
 * sidechainの外で連続するツール呼び出しの折りたたみ表示 (「作業N件」)。
 * 閉じているときは、実行中のまとまりに限りrunningのうち最新の1件を下に出す
 */
function ToolGroupCard({
  calls,
  latestRunning,
  expanded,
  onToggle,
  surfaceClassName,
}: {
  calls: ToolCallEvent[];
  latestRunning: ToolCallEvent | null;
  expanded: boolean;
  onToggle: () => void;
  /** 要約ボタンの背景。周りの面から1段ずらす */
  surfaceClassName: string;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div className="px-4 py-1.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={`inline-flex h-9 max-w-full items-center gap-2 rounded-sm border border-border pr-3 pl-2.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground ${surfaceClassName}`}
      >
        <Chevron aria-hidden="true" className="size-4 shrink-0" />
        <span className="font-semibold text-foreground">
          作業{calls.length}件
        </span>
      </button>
      {expanded ? (
        <div className="mt-1 border-l-2 border-border pl-3">
          {calls.map(call => (
            <div key={call.id} className="py-0.5">
              <ToolCallRow tool={call.tool} input={call.input} />
            </div>
          ))}
        </div>
      ) : (
        latestRunning && (
          <div className="mt-1 pl-1">
            <ToolCallRow
              tool={latestRunning.tool}
              input={latestRunning.input}
              running
            />
          </div>
        )
      )}
    </div>
  );
}
```

- [ ] **Step 10: ローカルの `groupSidechain` を消す**

`/** 連続する sidechain イベントを 1 グループに畳む */` (710行目) から `function groupSidechain(...)` の閉じ括弧 (733行目、直後に `function EventCard({` が続く) までを削除する。

- [ ] **Step 11: 本体でまとまりと展開状態を使う**

943-944行目の次の2行を、

```tsx
  // 連続する subagent イベントを折りたたみグループへ
  const groupedEvents = useMemo(() => groupSidechain(events), [events]);
```

次で置き換える。

```tsx
  // 連続するsubagentイベントと、sidechainの外で連続するツール呼び出しを
  // それぞれ折りたたみのまとまりへ
  const renderItems = useMemo(
    () => groupToolCalls(groupSidechain(events)),
    [events]
  );

  // 「作業N件」の展開状態 (まとまりのidの集合)。カード内のstateにしないのは、
  // 非表示 (isActive=false) の間はuseSessionJsonlがeventsを空にしてカードが
  // アンマウントされるため。本体に持てば端末と会話を切り替えても開いたまま残る
  const [expandedToolGroups, setExpandedToolGroups] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const toggleToolGroup = useCallback((id: string) => {
    setExpandedToolGroups(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies(session.id): セッション切替を検知して展開状態を破棄するための意図的な依存
  useEffect(() => {
    setExpandedToolGroups(new Set());
  }, [session.id]);
```

1301-1315行目の次のブロックを、

```tsx
              {groupedEvents.map(g =>
                g.kind === "sidechain" ? (
                  <SidechainGroupCard
                    key={g.id}
                    events={g.events}
                    sessionId={session.id}
                  />
                ) : (
                  <EventCard
                    key={g.event.id}
                    event={g.event}
                    sessionId={session.id}
                  />
                )
              )}
```

次で置き換える。

```tsx
              {renderItems.map(item => {
                if (item.kind === "sidechain") {
                  return (
                    <SidechainGroupCard
                      key={item.id}
                      events={item.events}
                      sessionId={session.id}
                    />
                  );
                }
                if (item.kind === "tool-group") {
                  return (
                    <ToolGroupCard
                      key={item.id}
                      calls={item.calls}
                      latestRunning={item.latestRunning}
                      expanded={expandedToolGroups.has(item.id)}
                      onToggle={() => toggleToolGroup(item.id)}
                      surfaceClassName="bg-background"
                    />
                  );
                }
                return (
                  <EventCard
                    key={item.event.id}
                    event={item.event}
                    sessionId={session.id}
                  />
                );
              })}
```

- [ ] **Step 12: パーサーのコメントを実態に合わせる**

`packages/web/src/lib/jsonl-event-parser.ts` 24-25行目を次にする。

```ts
 *  - `isSidechain`: subagentの対話にtrue。連続するtrueはchat-render-items.tsの
 *    groupSidechainで1ブロックに集約される。
```

- [ ] **Step 13: テストを実行して通過を確認する**

Run: `pnpm vitest run packages/web/src/lib/chat-render-items.test.ts packages/web/src/components/SplitChatPane.test.tsx`
Expected: PASS (`Test Files  2 passed`)

- [ ] **Step 14: 整形・型とlintを通す**

Run: `pnpm biome check --write packages/web/src/lib/chat-render-items.ts packages/web/src/lib/chat-render-items.test.ts packages/web/src/lib/jsonl-event-parser.ts packages/web/src/components/SplitChatPane.tsx packages/web/src/components/SplitChatPane.test.tsx && pnpm check`
Expected: `biome check` と `tsc -b` がエラーなしで終わる (importの並びは `biome check --write` が直す)

- [ ] **Step 15: コミットする**

```bash
git branch --show-current   # feat/visual-redesign-paperであること
git add packages/web/src/components/SplitChatPane.tsx packages/web/src/components/SplitChatPane.test.tsx packages/web/src/lib/jsonl-event-parser.ts
git commit -m "会話の連続するツール行を「作業N件」に折りたたむ"
```

---

### Task 9: 会話: 吹き出し・質問カード・入力欄

設計書8.3節 (会話) と8.5節の「下部のバー」「会話モード」を `SplitChatPane` と `AskUserQuestionCard` に実装する。1度に書き換えると壊れるので、次の5つのコミットに分ける。

| 区切り | 内容 |
|---|---|
| 9a | propsの変更、自前のヘッダー行の削除、`onActiveAuqChange` |
| 9b | `.md-prose` とリンクの色をトークンへ、絵文字のアイコンをlucideへ |
| 9c | 吹き出し・本文・入力欄 (PCの配置) |
| 9d | 質問カードと `AwaitingPad` のカード化 |
| 9e | `layout="mobile"` (浮かぶガラスバーと本文の下端の余白) |

決めたこと:

- `showTerminal` / `onToggleTerminal` / `onOpenBoard` はどの呼び出し元も渡していないので、`AskUserQuestionCard` と `AwaitingPad` に渡している `onOpenTerminal` は**今も常にundefined** (死んでいる)。propsごと、「ターミナルで確認」ボタンごと両方から外す。端末への誘導はTask 10の状態の帯が担う
- **ルートは背景を塗らない** (今の `bg-background` を外す)。PCではTask 7の額縁 (`bg-card`)、モバイルでは `MobileSessionView` の紙 (`bg-background`) が塗る。「作業N件」の要約ボタンだけは面から1段ずらすため、PCは `bg-background`、モバイルは `bg-card` にする (参照モックどおり)
- **琥珀 (`--status-awaiting`) を文字色に使わない**。確認待ちの表示はTask 2の `<StatusChip statusKey="AWAITING" />` に任せ、見出しの文言は `text-foreground`。desyncの帯は `bg-status-awaiting/15` までにする (設計書4節「ライトの琥珀の扱い」)
- **等幅に残すもの**: ツール行の引数、`AwaitingPad` のキーボタンと「直前の画面」の `<pre>`、`AskUserQuestionCard` の「直前の画面」、画像ファイルのパス表示。ツール名・スラッシュコマンド名・補完候補名・選択肢の番号はsansにする
- **補完候補の種類のバッジ** (今はemerald / blue / violet) は3つとも `bg-muted text-muted-foreground` にし、文言で見分ける。状態の色をカテゴリの色に転用しない
- **「その他 (自由入力)」**: 押すと入力欄が現れる、のような新しい操作は足さない。既存の `FreeTextRow` (入力欄そのもの) を点線の行にするだけにして、回答の送り方を変えない
- **モバイルの下部**: 質問カード / `AwaitingPad` と、ガラスバー (`composerAccessory` + 入力行) を、1つの絶対配置のスタックに縦に積む。カードはガラスの外に置く (ガラスは操作の層だけ)。スタックの下端は `max(12px, env(safe-area-inset-bottom))`。本文の下端の余白は `calc(<スタックの実測の高さ>px + max(12px, env(safe-area-inset-bottom)) + 12px)` の文字列で `style` に入れ、env() の解決はブラウザに任せる (ResizeObserverで測るのはスタックの高さだけ)。この計算は `lib/floating-composer.ts` に純粋関数として置き、Task 10も `FLOATING_BAR_BOTTOM` を使う
- `.glass-bar` (Task 1) は素材 (背景・ぼかし・罫線・影・不透明への切り替え) だけを持つ前提で、角丸 `rounded-[28px]` と余白 `p-2` はこちらで付ける。ガラスバーの要素 (スタックではなくバーそのもの) には `data-mobile-bottom-bar` を付ける (Task 12の検証スクリプトが位置を測る)。補完候補はガラスバーではなくスタック (絶対配置) を基準に出すので、`.glass-bar` が `overflow: hidden` を持っていても切れない

**Files:**
- Modify: `packages/web/src/components/SplitChatPane.tsx` (Task 8の変更の後の状態。変更箇所は既存の行を引用して示す)
- Modify: `packages/web/src/components/AskUserQuestionCard.tsx` (13行目のコメント、21行目のimport、34-47行目のprops、59-66行目の引数、181行目以降のJSXと `ScreenContextBlock` / `FreeTextRow`)
- Modify: `packages/web/src/index.css` (`/* ===== JSONL assistant text 用 markdown プロース =====` から末尾までの `.md-prose` の節。Task 1の変更で行番号は前後する)
- Create: `packages/web/src/lib/floating-composer.ts`
- Test: `packages/web/src/lib/floating-composer.test.ts`
- Test: `packages/web/src/components/AskUserQuestionCard.test.tsx` (新規、node環境)
- Test: `packages/web/src/components/SplitChatPane.test.tsx` (Task 8で作ったものに追記)

**Interfaces:**
- Consumes:
  - Task 1: `.glass-bar`、`shadow-card`、`bg-status-awaiting/15`、`rounded-lg` (12px) / `rounded-sm` (8px)
  - Task 2: `StatusChip` (`packages/web/src/components/StatusChip.tsx`、`{ statusKey: StatusKey; className?: string }`)
  - Task 8: `groupSidechain` / `groupToolCalls` / `ToolGroupCard`
- Produces:
  ```ts
  // packages/web/src/components/SplitChatPane.tsx (00-head.mdのとおり)
  interface SplitChatPaneProps {
    socket: TypedSocket | null;
    session: ManagedSession;
    isActive: boolean;
    bridgeStatus?: BridgeSessionStatus;
    awaitingText?: string;
    onSendMessage: (message: string) => void;
    onSendKey: (key: SpecialKey) => void;
    onUploadFile?: (data: { base64Data: string; mimeType: string; originalFilename?: string }) =>
      Promise<{ path: string; filename: string; originalFilename?: string }>;
    layout?: "pane" | "mobile";          // 既定 "pane"
    composerAccessory?: React.ReactNode; // layout="mobile" のときだけ、ガラスバーの上段に出す
    onActiveAuqChange?: (hasActiveAuq: boolean) => void; // マウント時にfalseで1回呼ぶ
  }
  // 削除: showTerminal / onToggleTerminal / onOpenBoard

  // packages/web/src/lib/floating-composer.ts
  export const FLOATING_BAR_BOTTOM = "max(12px, env(safe-area-inset-bottom))";
  export function floatingBarReserve(stackHeightPx: number): string;
  // → "calc(<ceil(max(0, h))>px + max(12px, env(safe-area-inset-bottom)) + 12px)"

  // packages/web/src/components/AskUserQuestionCard.tsx
  // propsからonOpenTerminalを削除。ルートは <div role="group" aria-label="質問"> のカード (枠・影込み)
  ```
  - DOMの目印 (Task 10 / Task 12が使う): 入力欄 `textarea[aria-label="メッセージ"]`、送信 `button[aria-label="送信"]`、本文 `[data-testid="chat-scroll-content"]`、モバイルの下部スタック `[data-testid="floating-composer"]` (カードとガラスバーを積む)、その中のガラスバー `[data-mobile-bottom-bar]` (`.glass-bar`。`composerAccessory` と入力欄を包むいちばん外側の要素)
  - ルートは背景を塗らない

#### 9a: propsの変更とヘッダー行の削除

- [ ] **Step 1: 失敗するテストを書く**

`packages/web/src/components/SplitChatPane.test.tsx` の末尾に追記する。

```tsx
describe("SplitChatPane: ヘッダー行と質問カードの通知", () => {
  it("自前のヘッダー行 (busy表示・購読ドット) を出さない", () => {
    const { container } = renderChat({ bridgeStatus: "TOOL" });

    expect(container.querySelector("header")).toBeNull();
    expect(container.textContent).not.toContain("ツール実行中");
    expect(container.querySelector('[title="JSONL 購読中"]')).toBeNull();
  });

  it("質問カードの表示有無が変わるたびにonActiveAuqChangeを呼ぶ", () => {
    const at = Date.parse("2026-09-17T00:00:00Z");
    const questions = [
      {
        question: "どちらにしますか？",
        options: [{ label: "A" }, { label: "B" }],
      },
    ];
    const onActiveAuqChange = vi.fn();
    const { emitServer } = renderChat({ onActiveAuqChange });
    expect(onActiveAuqChange).toHaveBeenLastCalledWith(false);

    emitServer("session:auq", {
      sessionId: "s1",
      at,
      questions,
      screen: null,
    });
    expect(onActiveAuqChange).toHaveBeenLastCalledWith(true);

    // 回答がJSONLに書かれるとカードが閉じる
    emitServer("session:jsonl-snapshot", {
      sessionId: "s1",
      lines: [
        line({
          type: "assistant",
          uuid: "q1",
          timestamp: new Date(at + 1000).toISOString(),
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "auq1",
                name: "AskUserQuestion",
                input: { questions },
              },
            ],
          },
        }),
        line({
          type: "user",
          uuid: "q1r",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "auq1",
                content: '"どちらにしますか？"="A"',
              },
            ],
          },
        }),
      ],
    });
    expect(onActiveAuqChange).toHaveBeenLastCalledWith(false);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `pnpm vitest run packages/web/src/components/SplitChatPane.test.tsx`
Expected: FAIL。「自前のヘッダー行」は `header` 要素と「ツール実行中」があるため、「onActiveAuqChange」は一度も呼ばれないため (`toHaveBeenLastCalledWith` が失敗)。Task 8の2件はPASSのまま

- [ ] **Step 3: propsを変える**

`SplitChatPane.tsx` の `interface SplitChatPaneProps` のうち、次の6行を、

```tsx
  /** 右側 ttyd の表示状態 (ヘッダのトグルボタンを ON/OFF 表示するために使う) */
  showTerminal?: boolean;
  /** ターミナルの表示切替 (undefined のとき トグルボタンを描画しない) */
  onToggleTerminal?: () => void;
  /** 空のホワイトボードを直接開く (undefined のとき ボタンを描画しない) */
  onOpenBoard?: () => void;
```

次で置き換える (`layout` と `composerAccessory` は9eで足す)。

```tsx
  /**
   * 質問カード (AskUserQuestion) の表示有無が変わったときに呼ぶ。
   * マウント時にも現在の値 (false) で1回呼ぶ。モバイルの状態の帯が文言の切り替えに使う
   */
  onActiveAuqChange?: (hasActiveAuq: boolean) => void;
```

`export function SplitChatPane({` の引数のうち、

```tsx
  onUploadFile,
  showTerminal,
  onToggleTerminal,
  onOpenBoard,
}: SplitChatPaneProps) {
```

を次にする。

```tsx
  onUploadFile,
  onActiveAuqChange,
}: SplitChatPaneProps) {
```

`useSessionJsonl` の分割代入から購読フラグを外す。

```tsx
  const {
    events,
    isSubscribed: jsonlSubscribed,
    loadMore,
    hasMore,
  } = useSessionJsonl(socket, isActive ? session.id : null);
```

を次にする。

```tsx
  const { events, loadMore, hasMore } = useSessionJsonl(
    socket,
    isActive ? session.id : null
  );
```

- [ ] **Step 4: 質問カードの有無を親へ知らせる**

`const activeAuq = hookAuq?.auq ?? null;` の直後に足す。

```tsx
  // 質問カードの有無を親へ知らせる (モバイルの状態の帯が文言の切り替えに使う)
  const hasActiveAuq = activeAuq !== null;
  useEffect(() => {
    onActiveAuqChange?.(hasActiveAuq);
  }, [hasActiveAuq, onActiveAuqChange]);
```

- [ ] **Step 5: ヘッダー行を消し、`onOpenTerminal` を外す**

`return (` の直後の `<header className="border-b border-border px-4 py-1.5 flex items-center justify-end shrink-0">` から `</header>` までを削除する。

`<AskUserQuestionCard` のpropsから次の3行を削除する。

```tsx
          onOpenTerminal={
            onToggleTerminal && !showTerminal ? onToggleTerminal : undefined
          }
```

`<AwaitingPad` のpropsからも同じ3行を削除する。

`function AwaitingPad({` の引数と型から `onOpenTerminal` を外し、本体の次のブロックを削除する。

```tsx
        {onOpenTerminal && (
          <button
            type="button"
            onClick={onOpenTerminal}
            className="text-[12px] underline text-amber-700 dark:text-amber-300 px-1 shrink-0"
          >
            ターミナルで確認
          </button>
        )}
```

- [ ] **Step 6: `AskUserQuestionCard` から `onOpenTerminal` を外す**

`packages/web/src/components/AskUserQuestionCard.tsx` のpropsから次の2行を削除する。

```tsx
  /** desync 時の「ターミナルで確認」(ttyd を開く)。未指定なら文言のみ */
  onOpenTerminal?: () => void;
```

関数の引数の `onOpenTerminal,` を削除し、desyncの帯の中の次のブロックを削除する。

```tsx
          {onOpenTerminal && (
            <button
              type="button"
              onClick={onOpenTerminal}
              className="shrink-0 underline font-medium"
            >
              ターミナルで確認
            </button>
          )}
```

13行目のコメントを次にする。

```tsx
 * - 送出完了から10秒tool_resultが来なければdesync警告 (端末側の確認を促す)
```

- [ ] **Step 7: テストを実行して通過を確認する**

Run: `pnpm vitest run packages/web/src/components/SplitChatPane.test.tsx`
Expected: PASS (4件)

- [ ] **Step 8: 型とlintを通してコミットする**

Run: `pnpm biome check --write packages/web/src/components/SplitChatPane.tsx packages/web/src/components/SplitChatPane.test.tsx packages/web/src/components/AskUserQuestionCard.tsx && pnpm check`
Expected: エラーなし (`SplitViewPane.tsx` と `MobileSessionView.tsx` は削除したpropsを渡していないので型エラーは出ない)

```bash
git branch --show-current   # feat/visual-redesign-paperであること
git add packages/web/src/components/SplitChatPane.tsx packages/web/src/components/SplitChatPane.test.tsx packages/web/src/components/AskUserQuestionCard.tsx
git commit -m "会話ペインの自前ヘッダーと未使用のpropsを削除し、質問カードの有無を親へ知らせる"
```

#### 9b: 色のトークン化と絵文字のアイコンの置き換え

- [ ] **Step 9: 失敗するテストを書く**

`SplitChatPane.test.tsx` の末尾に追記する。

```tsx
/** 要約・外部画像・サブエージェント・回答済みの質問を含む履歴 */
const DECORATED_SNAPSHOT = [
  line({
    type: "user",
    uuid: "c1",
    isCompactSummary: true,
    message: { role: "user", content: "これまでの要約" },
  }),
  line({
    type: "assistant",
    uuid: "a1",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "図です ![構成図](https://example.com/a.png)" },
      ],
    },
  }),
  line({
    type: "assistant",
    uuid: "sc1",
    isSidechain: true,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "調べた結果" }],
    },
  }),
  line({
    type: "assistant",
    uuid: "q1",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "auq1",
          name: "AskUserQuestion",
          input: {
            questions: [
              {
                question: "どちらにしますか？",
                options: [{ label: "A" }, { label: "B" }],
              },
            ],
          },
        },
      ],
    },
  }),
  line({
    type: "user",
    uuid: "q1r",
    toolUseResult: { answers: { "どちらにしますか？": "A" } },
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "auq1",
          content: '"どちらにしますか？"="A"',
        },
      ],
    },
  }),
];

describe("SplitChatPane: アイコン", () => {
  it("絵文字をアイコンに使わない", () => {
    const { container, emitServer } = renderChat();
    emitServer("session:jsonl-snapshot", {
      sessionId: "s1",
      lines: DECORATED_SNAPSHOT,
    });

    const text = container.textContent ?? "";
    expect(text).toContain("会話を要約しました");
    expect(text).toContain("構成図");
    expect(text).toContain("サブエージェント");
    expect(text).toContain("質問への回答");
    expect(text).not.toMatch(/⚙|❓|⏳|🧵|🖼|✂|🎨|🖥|▸|▾/u);
  });
});
```

- [ ] **Step 10: テストを実行して失敗を確認する**

Run: `pnpm vitest run packages/web/src/components/SplitChatPane.test.tsx -t "絵文字をアイコンに使わない"`
Expected: FAIL。`not.toMatch` が `✂` (要約の区切り) などに当たる

- [ ] **Step 11: lucideのimportを足す**

Task 8で整えたlucideのimportに `Bot` `CircleQuestionMark` `ImageOff` `Scissors` を足す (並びはコミット前の `biome check --write` が直す)。

```tsx
import {
  ArrowDown,
  Bot,
  ChevronDown,
  ChevronRight,
  CircleQuestionMark,
  Download,
  ImageOff,
  Loader2,
  Paperclip,
  Scissors,
  Send,
  Workflow,
  Wrench,
} from "lucide-react";
```

- [ ] **Step 12: スラッシュコマンドのカード・リンク・外部画像を直す**

`function SlashCommandCard(` の関数全体を次で置き換える (等幅とemeraldを外す)。

```tsx
function SlashCommandCard({ name, args }: { name: string; args?: string }) {
  return (
    <div className="flex justify-end px-4 pt-4 pb-2">
      <div className="rounded-full bg-muted px-3 py-1 text-sm font-medium text-muted-foreground">
        {name}
        {args ? ` ${args}` : ""}
      </div>
    </div>
  );
}
```

`FileLink` の画像でないときのリンクと、`Linkify` のリンクの2か所にある次のclassNameを、

```tsx
        className="text-blue-600 dark:text-blue-400 underline break-all"
```

次にする。

```tsx
        className="break-all text-primary underline underline-offset-2"
```

`createMarkdownComponents` の `img:` を次で置き換える。

```tsx
    img: ({ alt }) => (
      <span
        className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
        title="モデル出力由来の外部画像は自動表示しません"
      >
        <ImageOff aria-hidden="true" className="size-3.5 shrink-0" />
        {alt || "画像"}
      </span>
    ),
```

- [ ] **Step 13: 要約の区切り・回答済みの質問・サブエージェントのアイコンを直す**

`CompactMarkerCard` の次の `<span>` を、

```tsx
      <span className="text-[11px] text-muted-foreground shrink-0">
        ✂ 会話を要約しました (/compact)
      </span>
```

次にする。

```tsx
      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
        <Scissors aria-hidden="true" className="size-3" />
        会話を要約しました (/compact)
      </span>
```

`AskUserQuestionResultCard` の見出しを、

```tsx
      <div className="text-sm text-muted-foreground mb-1.5 flex items-center gap-1.5">
        <span>❓</span>
        <span className="font-medium">
          {result
            ? isDecline
              ? "質問はキャンセルされました"
              : "質問への回答:"
            : "AskUserQuestion"}
        </span>
      </div>
      <div className="text-base space-y-1">
```

次にする。

```tsx
      <div className="mb-1.5 flex items-center gap-1.5 text-sm text-muted-foreground">
        <CircleQuestionMark aria-hidden="true" className="size-4 shrink-0" />
        <span className="font-medium">
          {result
            ? isDecline
              ? "質問はキャンセルされました"
              : "質問への回答"
            : "AskUserQuestion"}
        </span>
      </div>
      <div className="space-y-1 text-[15px]">
```

`SidechainGroupCard` の関数全体を次で置き換える。

```tsx
function SidechainGroupCard({
  events,
  sessionId,
}: {
  events: JsonlParsedEvent[];
  sessionId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div className="px-4 py-1">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <Chevron aria-hidden="true" className="size-3.5 shrink-0" />
        <Bot aria-hidden="true" className="size-3.5 shrink-0" />
        <span>サブエージェント ({events.length}件)</span>
      </button>
      {expanded && (
        <div className="mt-1 border-l-2 border-border pl-2 opacity-80">
          {events.map(ev => (
            <EventCard key={ev.id} event={ev} sessionId={sessionId} />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 14: `.md-prose` の色をトークンにする**

`packages/web/src/index.css` の `/* ===== JSONL assistant text 用 markdown プロース =====` から `.md-prose td { … }` の閉じ括弧 (ファイル末尾) までを次で置き換える。Task 1で `@media (prefers-color-scheme: dark)` に書き換えた `.md-prose pre` と `.md-prose a` の上書きも、この範囲に入っているので一緒に消す (トークンがダークで切り替わるので要らない)。

```css
/* ===== JSONL assistant text 用 markdown プロース =====
 * react-markdown が出力する要素にチャットらしい spacing と code/blockquote 装飾を当てる。
 * 色はトークンだけで指定し、ライト/ダークの切り替えはトークンの定義側に任せる */
.md-prose {
  line-height: 1.6;
}
.md-prose > * + * {
  margin-top: 0.75em;
}
.md-prose > h1 + *,
.md-prose > h2 + *,
.md-prose > h3 + * {
  margin-top: 0.35em;
}
.md-prose h1 {
  font-size: 1.4em;
  font-weight: 700;
  margin-top: 1em;
  letter-spacing: -0.01em;
}
.md-prose h2 {
  font-size: 1.2em;
  font-weight: 700;
  margin-top: 0.9em;
  letter-spacing: -0.01em;
}
.md-prose h3 {
  font-size: 1.05em;
  font-weight: 700;
  margin-top: 0.8em;
}
.md-prose ul {
  list-style: disc;
  padding-left: 1.4em;
}
.md-prose ol {
  list-style: decimal;
  padding-left: 1.6em;
}
.md-prose li {
  margin: 0.25em 0;
}
.md-prose li > p {
  margin: 0;
}
.md-prose code {
  font-family: var(--font-mono);
  background: var(--muted);
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 0.9em;
}
.md-prose pre {
  background: var(--muted);
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) - 4px);
  padding: 10px 12px;
  overflow-x: auto;
}
.md-prose pre code {
  background: transparent;
  padding: 0;
  font-size: 13px;
}
.md-prose blockquote {
  border-left: 3px solid var(--border);
  padding-left: 0.8em;
  color: var(--muted-foreground);
}
.md-prose a {
  color: var(--primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.md-prose table {
  border-collapse: collapse;
}
.md-prose th,
.md-prose td {
  border: 1px solid var(--border);
  padding: 4px 8px;
}
```

- [ ] **Step 15: テストと直書き色の残りを確かめる**

Run: `pnpm vitest run packages/web/src/components/SplitChatPane.test.tsx`
Expected: PASS (5件)

Run: `sed -n '/JSONL assistant text 用 markdown プロース/,$p' packages/web/src/index.css | grep -nE "rgba|#[0-9a-fA-F]{3,6}\b|\.dark|prefers-color-scheme"`
Expected: 何も出力されない

- [ ] **Step 16: 型とlintを通してコミットする**

Run: `pnpm biome check --write packages/web/src/components/SplitChatPane.tsx packages/web/src/components/SplitChatPane.test.tsx packages/web/src/index.css && pnpm check`
Expected: エラーなし

```bash
git branch --show-current   # feat/visual-redesign-paperであること
git add packages/web/src/components/SplitChatPane.tsx packages/web/src/components/SplitChatPane.test.tsx packages/web/src/index.css
git commit -m "会話の色をトークンに置き換え、絵文字のアイコンをlucideにする"
```

#### 9c: 吹き出し・本文・入力欄

- [ ] **Step 17: 失敗するテストを書く**

`SplitChatPane.test.tsx` の `findButtonByText` の直後にヘルパーを足す。

```tsx
/** 制御されたtextareaに値を入れてReactのonChangeを起こす */
function typeInto(el: HTMLTextAreaElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value"
  )?.set;
  act(() => {
    setValue?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
```

末尾に追記する。

```tsx
describe("SplitChatPane: 入力欄", () => {
  it("送信ボタンは空のあいだ押せず、入力して押すと送信し、送信中の吹き出しを出す", () => {
    const { container, onSendMessage } = renderChat();
    const textarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="メッセージ"]'
    );
    const send = container.querySelector<HTMLButtonElement>(
      'button[aria-label="送信"]'
    );
    expect(textarea).not.toBeNull();
    expect(send?.disabled).toBe(true);

    typeInto(textarea as HTMLTextAreaElement, "ログイン画面を作って");
    expect(send?.disabled).toBe(false);

    act(() => send?.click());
    expect(onSendMessage).toHaveBeenCalledWith("ログイン画面を作って");
    expect(container.querySelector('svg[aria-label="送信中"]')).not.toBeNull();
    expect(container.textContent).toContain("ログイン画面を作って");
  });
});
```

- [ ] **Step 18: テストを実行して失敗を確認する**

Run: `pnpm vitest run packages/web/src/components/SplitChatPane.test.tsx -t "送信ボタンは空のあいだ押せず"`
Expected: FAIL。`textarea[aria-label="メッセージ"]` が見つからず `expect(textarea).not.toBeNull()` で落ちる

- [ ] **Step 19: 吹き出しと本文を直す**

`function UserInputCard(` と `function PendingMessageCard(` の2つの関数全体を次で置き換える。

```tsx
function UserInputCard({ text }: { text: string }) {
  return (
    <div className="flex justify-end px-4 pt-4 pb-2">
      <div className="max-w-[78%] whitespace-pre-wrap break-words rounded-xl rounded-br-[4px] bg-primary/14 px-3.5 py-2.5 text-[15px] leading-[1.6] text-foreground">
        {text}
      </div>
    </div>
  );
}

function PendingMessageCard({ text }: { text: string }) {
  return (
    <div className="flex justify-end px-4 pt-4 pb-2">
      <div className="flex max-w-[78%] items-start gap-2 whitespace-pre-wrap break-words rounded-xl rounded-br-[4px] bg-primary/14 px-3.5 py-2.5 text-[15px] leading-[1.6] text-foreground opacity-60">
        <Loader2
          aria-label="送信中"
          className="mt-1 size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
        />
        <span className="min-w-0">{text}</span>
      </div>
    </div>
  );
}
```

`AssistantTextCard` の次の行を、

```tsx
      <div className="md-prose text-[16px] text-foreground leading-[1.65]">
```

次にする (行間は `.md-prose` の1.6)。

```tsx
      <div className="md-prose text-[15px] text-foreground">
```

- [ ] **Step 20: 入力欄まわりの定数を足す**

`// ===== JSONL イベントカード =====` の直前に足す。

```tsx
/** 入力欄の横の丸いアイコンボタン (添付・図解)。大きさはCOMPOSER_SIZEで足す */
const ROUND_ICON_BUTTON =
  "inline-flex shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50";

/**
 * 入力欄まわりの寸法と入力欄の地の色 (参照モック)。
 * PCは36pxで紙 (カードの上に一段沈める)、モバイルは指で押しやすい40pxで白
 */
const COMPOSER_SIZE = {
  pane: { button: "size-9", input: "min-h-9 py-[7px] bg-background" },
  mobile: { button: "size-10", input: "min-h-10 py-[9px] bg-card" },
} as const;
```

- [ ] **Step 21: 入力欄と下部を組み替える**

本体の `return (` (`<div className="h-full flex flex-col bg-background">` で始まる) から関数末尾の `}` の直前までを、次の「描画の直前に置く変数」と `return` で置き換える。`// permission prompt 等のユーザー判断待ちフォールバック。` のコメントは `dockedCard` の上に移す。`onDragEnter` などのハンドラと `<input type="file">` の中身は今のまま。

```tsx
  // 補完候補。PCは入力欄の枠の上端に合わせて出す
  const slashMenu = slashOpen && filteredSlashCommands.length > 0 && (
    <div className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-lg border border-border bg-popover shadow-card">
      {filteredSlashCommands.map((cmd, i) => (
        <button
          type="button"
          key={cmd.name}
          onMouseDown={e => {
            e.preventDefault();
            applySlashCommand(cmd);
          }}
          onMouseEnter={() => setSlashIndex(i)}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
            i === slashIndex
              ? "bg-accent text-accent-foreground"
              : "hover:bg-muted/50"
          }`}
        >
          <span className="shrink-0 font-medium text-foreground">
            {cmd.name}
          </span>
          {cmd.description && (
            <span className="flex-1 truncate text-xs text-muted-foreground">
              {cmd.description}
            </span>
          )}
          {/* 種類は文言で見分ける。状態の色をカテゴリの色に転用しない */}
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {cmd.source}
          </span>
        </button>
      ))}
    </div>
  );

  const composerSize = COMPOSER_SIZE.pane;

  const composerForm = (
    <form
      onSubmit={handleSubmit}
      onDragEnter={e => {
        if (!onUploadFile) return;
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragOver={e => {
        if (!onUploadFile) return;
        e.preventDefault();
      }}
      onDragLeave={e => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setIsDragging(false);
      }}
      onDrop={handleDrop}
      className={`relative flex items-end gap-1.5 rounded-[20px] ${
        isDragging ? "ring-2 ring-primary/50" : ""
      }`}
    >
      {onUploadFile && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,application/pdf,text/*,.md,.json,.csv"
            className="hidden"
            onChange={e => {
              const files = Array.from(e.target.files ?? []);
              if (files.length > 0) uploadAndAppend(files);
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className={`${ROUND_ICON_BUTTON} ${composerSize.button}`}
            aria-label="ファイルを添付"
            title="ファイルを添付 (D&D・貼り付けも可)"
            disabled={uploadingCount > 0}
          >
            {uploadingCount > 0 ? (
              <Loader2 className="size-5 animate-spin motion-reduce:animate-none" />
            ) : (
              <Paperclip className="size-5" />
            )}
          </button>
        </>
      )}
      <button
        type="button"
        onClick={handleVisualizeConversation}
        className={`${ROUND_ICON_BUTTON} ${composerSize.button}`}
        aria-label="会話を図解"
        title="会話を図解 (Claudeにmermaid図で要約させる)"
      >
        <Workflow className="size-5" />
      </button>
      <textarea
        ref={inputRef}
        value={inputValue}
        onChange={e => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={onUploadFile ? handlePaste : undefined}
        aria-label="メッセージ"
        placeholder={
          onUploadFile
            ? "メッセージを入力 (Enterで送信、Shift+Enterで改行。画像はD&D・貼り付けも可)"
            : "メッセージを入力 (Enterで送信、Shift+Enterで改行)"
        }
        rows={1}
        className={`field-sizing-content max-h-32 min-w-0 flex-1 resize-none rounded-[20px] border border-border px-3.5 text-[15px] leading-[1.4] placeholder:text-muted-foreground focus:border-primary focus:outline-none ${composerSize.input}`}
      />
      <button
        type="submit"
        disabled={!inputValue.trim()}
        aria-label="送信"
        className={`inline-flex shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:cursor-not-allowed disabled:opacity-40 ${composerSize.button}`}
      >
        <ArrowUp className="size-5" />
      </button>
      {isDragging && onUploadFile && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[20px] border-2 border-dashed border-primary bg-background/90 text-sm font-medium text-primary">
          ここにドロップ
        </div>
      )}
    </form>
  );

  // permission prompt 等のユーザー判断待ちフォールバック。
  // AskUserQuestion は専用カードが出る (hook 経由) ため、カード表示中
  // は出さない。hook が取りこぼされた場合のセーフティネットも兼ねる
  const showAwaitingPad = bridgeStatus === "AWAITING" && !activeAuq;
  // 入力欄の上に固定で出すカード (質問カード / 確認待ちのキー操作)
  const dockedCard = activeAuq ? (
    <AskUserQuestionCard
      key={activeAuq.toolUseId}
      socket={socket}
      sessionId={session.id}
      auq={activeAuq}
      screenContext={hookAuq?.screen ?? null}
      onSendKey={onSendKey}
    />
  ) : showAwaitingPad ? (
    <AwaitingPad
      socket={socket}
      sessionId={session.id}
      awaitingText={awaitingText}
      onSendKey={onSendKey}
    />
  ) : null;

  return (
    <div className="relative flex h-full flex-col">
      {/* JSONL イベントリスト (上段、flex-1)。
          relative ラッパーで囲み「下へジャンプ」ボタンをスクロール領域に
          重ねて配置する。スクロール領域自体は absolute inset-0 で内側を埋める。 */}
      <div className="relative min-h-0 flex-1">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: クリックで入力欄にフォーカスを移すだけの補助操作。会話ログ自体は非対話要素のまま */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: キーボード利用者は Tab で入力欄 (textarea) に直接到達できるため、キーハンドラは不要 */}
        <div
          ref={jsonlScrollRef}
          onClick={handleConversationClick}
          className="absolute inset-0 overflow-y-auto"
        >
          <div
            data-testid="chat-scroll-content"
            className="mx-auto w-full max-w-[760px] py-2"
          >
            {events.length === 0 &&
            pending.length === 0 &&
            localSlashCommands.length === 0 ? (
              <div className="pt-8 text-center text-sm text-muted-foreground">
                このセッションの履歴はまだありません
              </div>
            ) : (
              <>
                {hasMore && (
                  <div className="flex justify-center py-2 text-sm text-muted-foreground">
                    読み込み中...
                  </div>
                )}
                {renderItems.map(item => {
                  if (item.kind === "sidechain") {
                    return (
                      <SidechainGroupCard
                        key={item.id}
                        events={item.events}
                        sessionId={session.id}
                      />
                    );
                  }
                  if (item.kind === "tool-group") {
                    return (
                      <ToolGroupCard
                        key={item.id}
                        calls={item.calls}
                        latestRunning={item.latestRunning}
                        expanded={expandedToolGroups.has(item.id)}
                        onToggle={() => toggleToolGroup(item.id)}
                        surfaceClassName="bg-background"
                      />
                    );
                  }
                  return (
                    <EventCard
                      key={item.event.id}
                      event={item.event}
                      sessionId={session.id}
                    />
                  );
                })}
                {localSlashCommands.map(c => (
                  <SlashCommandCard key={c.id} name={c.name} args={c.args} />
                ))}
                {pending.map(p => (
                  <PendingMessageCard key={p.id} text={p.text} />
                ))}
              </>
            )}
          </div>
        </div>
        {!isNearBottom && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute bottom-3 left-1/2 z-10 flex size-9 -translate-x-1/2 items-center justify-center rounded-full bg-foreground/85 text-background shadow-card transition-colors hover:bg-foreground"
            title="最新まで一気にスクロール"
            aria-label="最新まで一気にスクロール"
          >
            <ArrowDown className="size-4" />
          </button>
        )}
      </div>

      {dockedCard && (
        <div className="max-h-[45%] shrink-0 overflow-y-auto px-4 pt-2 pb-3">
          <div className="mx-auto w-full max-w-[760px]">{dockedCard}</div>
        </div>
      )}

      <div className="shrink-0 border-t border-border px-4 pt-3 pb-3.5">
        <div className="relative mx-auto w-full max-w-[792px]">
          {slashMenu}
          {composerForm}
        </div>
      </div>
    </div>
  );
```

lucideのimportから `Send` を消して `ArrowUp` を足し、`import { Button } from "@/components/ui/button";` を削除する (どちらも使わなくなる)。

- [ ] **Step 22: テストを実行して通過を確認する**

Run: `pnpm vitest run packages/web/src/components/SplitChatPane.test.tsx`
Expected: PASS (6件)

- [ ] **Step 23: 型とlintを通してコミットする**

Run: `pnpm biome check --write packages/web/src/components/SplitChatPane.tsx packages/web/src/components/SplitChatPane.test.tsx && pnpm check`
Expected: エラーなし

```bash
git branch --show-current   # feat/visual-redesign-paperであること
git add packages/web/src/components/SplitChatPane.tsx packages/web/src/components/SplitChatPane.test.tsx
git commit -m "会話の吹き出しと入力欄をPaperの見た目にする"
```

#### 9d: 質問カードとAwaitingPad

- [ ] **Step 24: 質問カードの失敗するテストを書く**

`packages/web/src/components/AskUserQuestionCard.test.tsx` を作る (node環境。hooksはSSRで走るので描画だけを見る)。

```tsx
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ActiveAuq } from "@/lib/ask-user-question-state";
import { AskUserQuestionCard } from "./AskUserQuestionCard";

const SINGLE: ActiveAuq = {
  toolUseId: "hook:1",
  questions: [
    {
      question: "ログイン画面のデザインはどちらにしますか？",
      header: "デザイン",
      multiSelect: false,
      options: [
        {
          label: "シンプル",
          description: "メールアドレスの入力欄を先に見せる",
        },
        { label: "並べる" },
      ],
    },
  ],
};

function render(auq: ActiveAuq, screenContext: string | null = null): string {
  return renderToStaticMarkup(
    createElement(AskUserQuestionCard, {
      socket: null,
      sessionId: "s1",
      auq,
      screenContext,
      onSendKey: vi.fn(),
    })
  );
}

describe("AskUserQuestionCard", () => {
  it("見出しに「確認待ち」のチップとheaderを出し、選択肢に番号バッジを付ける", () => {
    const html = render(SINGLE);

    expect(html).toContain('aria-label="質問"');
    expect(html).toContain("確認待ち");
    expect(html).toContain("デザイン");
    expect(html).toMatch(/>1<\/span>/);
    expect(html).toMatch(/>2<\/span>/);
    expect(html).not.toContain("❓");
  });

  it("その他 (自由入力) は点線の行で出す", () => {
    const html = render(SINGLE);

    expect(html).toContain('placeholder="その他 (自由入力、Enterで送信)"');
    expect(html).toContain("border-dashed");
  });

  it("複数選択の質問はチェックの形で出し、記号の絵文字を使わない", () => {
    const html = render({
      toolUseId: "hook:2",
      questions: [{ ...SINGLE.questions[0], multiSelect: true }],
    });

    expect(html).toContain("(複数選択可)");
    expect(html).toContain("回答を送信");
    expect(html).not.toMatch(/☐|☑/u);
  });

  it("等幅は「直前の画面」だけに使う", () => {
    expect(render(SINGLE)).not.toContain("font-mono");
    expect(render(SINGLE, "● 画面の内容")).toContain("font-mono");
  });
});
```

`SplitChatPane.test.tsx` の末尾にも追記する。

```tsx
describe("SplitChatPane: 確認待ちのカード", () => {
  it("質問カードが無い確認待ちは「確認待ち」のチップ付きのカードで出し、キーを送れる", () => {
    const { container, onSendKey } = renderChat({
      bridgeStatus: "AWAITING",
      awaitingText: "Do you want to proceed?\n  1. Yes\n  2. No",
    });

    expect(container.textContent).toContain("確認待ち");
    expect(container.querySelector("pre")?.textContent).toContain(
      "Do you want to proceed?"
    );
    act(() =>
      container
        .querySelector<HTMLButtonElement>('button[title^="1を送信"]')
        ?.click()
    );
    expect(onSendKey).toHaveBeenCalledWith("1");
  });
});
```

- [ ] **Step 25: テストを実行して失敗を確認する**

Run: `pnpm vitest run packages/web/src/components/AskUserQuestionCard.test.tsx packages/web/src/components/SplitChatPane.test.tsx`
Expected: FAIL。`AskUserQuestionCard` は「確認待ち」「その他 (自由入力、Enterで送信)」が無く、`❓` `☐` `font-mono` を含むため。`SplitChatPane` の「確認待ちのカード」は「確認待ち」の文言が無く、キーボタンの `title` もまだ `1 を送信 …` なのでセレクタが当たらないため

- [ ] **Step 26: `AskUserQuestionCard` のimportを直す**

21行目の `import { Loader2 } from "lucide-react";` を次にし、`@/lib/ask-user-question-state` のimportの直前に `StatusChip` のimportを足す。

```tsx
import {
  CircleAlert,
  Loader2,
  Pencil,
  Square,
  SquareCheck,
} from "lucide-react";
```

```tsx
import { StatusChip } from "@/components/StatusChip";
```

- [ ] **Step 27: 質問カードの描画を置き換える**

`const handleCancel = () => {` の関数の直後にある `return (` から、`AskUserQuestionCard` 関数の閉じ括弧までを次で置き換える。

```tsx
  // 単問ならheaderをチップの横に、複数の質問なら各質問の上に出す
  const isSingleQuestion = auq.questions.length === 1;
  const singleHeader = isSingleQuestion ? auq.questions[0].header : undefined;

  return (
    <div
      role="group"
      aria-label="質問"
      className="rounded-lg border border-border bg-card px-4 pt-4 pb-3 shadow-card"
    >
      <div className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-muted-foreground">
        <StatusChip statusKey="AWAITING" />
        {singleHeader && <span className="min-w-0 truncate">{singleHeader}</span>}
      </div>

      {phase === "desync" && (
        <div className="mt-3 flex items-start gap-2 rounded-sm bg-status-awaiting/15 px-3 py-2 text-[13px] text-foreground">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            回答を確認できませんでした。ターミナル側の状態を確認してください
          </span>
        </div>
      )}

      {screenContext && <ScreenContextBlock text={screenContext} />}

      {auq.questions.map((q, qi) => {
        const draft = drafts[qi];
        return (
          <div key={`${auq.toolUseId}:${qi}`} className="mt-3">
            {!isSingleQuestion && q.header && (
              <div className="mb-1 text-[13px] font-semibold text-muted-foreground">
                {q.header}
              </div>
            )}
            <div className="break-words text-[15px] font-semibold leading-normal text-foreground">
              {q.question}
              {q.multiSelect && (
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  (複数選択可)
                </span>
              )}
            </div>
            <div className="mt-3 flex flex-col gap-2">
              {q.options.map((opt, oi) => {
                const selected =
                  draft?.kind === "options" && draft.indexes.includes(oi);
                return (
                  <button
                    key={`${oi}-${opt.label}`}
                    type="button"
                    disabled={phase === "submitting"}
                    onClick={() => {
                      if (isInstantMode) {
                        handleInstantOption(oi);
                      } else if (q.multiSelect) {
                        toggleMultiOption(qi, oi);
                      } else {
                        setDraft(qi, { kind: "options", indexes: [oi] });
                      }
                    }}
                    className={`flex w-full items-start gap-3 rounded-sm border px-3 py-2.5 text-left transition-colors disabled:opacity-50 ${
                      selected
                        ? "border-primary bg-primary/10"
                        : "border-border bg-card hover:border-primary hover:bg-primary/5"
                    }`}
                    title={`${oi + 1}. ${opt.label}`}
                  >
                    <span className="mt-px inline-flex size-[22px] shrink-0 items-center justify-center rounded-[6px] bg-muted text-xs font-semibold text-muted-foreground">
                      {q.multiSelect ? (
                        selected ? (
                          <SquareCheck aria-hidden="true" className="size-3.5" />
                        ) : (
                          <Square aria-hidden="true" className="size-3.5" />
                        )
                      ) : (
                        oi + 1
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[15px] font-semibold leading-normal text-foreground">
                        {opt.label}
                      </span>
                      {opt.description && (
                        <span className="mt-px block text-[13px] leading-normal text-muted-foreground">
                          {opt.description}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
              {/* 自由入力 (Type something.)。digit が 9 を超える構成では
                  buildKeySequence が null になるため表示しない */}
              {freeTextDigit(q) <= 9 && (
                <FreeTextRow
                  digitLabel={freeTextDigit(q)}
                  disabled={phase === "submitting"}
                  value={draft?.kind === "free" ? draft.text : ""}
                  onChange={text =>
                    setDraft(qi, text ? { kind: "free", text } : null)
                  }
                  onSubmit={
                    isInstantMode ? text => handleInstantFree(text) : undefined
                  }
                />
              )}
            </div>
          </div>
        );
      })}

      <div className="mt-3 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={handleCancel}
          disabled={phase === "submitting"}
          className="rounded-sm px-2 py-1 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          title="キャンセル (Esc)"
        >
          キャンセル
        </button>
        <div className="flex items-center gap-2">
          {phase === "submitting" && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2
                aria-hidden="true"
                className="size-3.5 animate-spin motion-reduce:animate-none"
              />
              送信中...
            </span>
          )}
          {!isInstantMode && phase !== "submitting" && (
            <button
              type="button"
              onClick={handleSubmitAll}
              disabled={!allAnswered}
              className="rounded-sm bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-30"
            >
              回答を送信
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 28: 「直前の画面」と「その他」の行を置き換える**

`function ScreenContextBlock(` の `return (` から関数の閉じ括弧までを次にする (等幅は `<pre>` に残す。括弧は半角にする)。

```tsx
  return (
    <div className="mt-3">
      <div className="mb-1 text-[11px] text-muted-foreground">
        直前の画面 (ターミナルの表示そのまま)
      </div>
      <div
        ref={scrollRef}
        className="max-h-36 overflow-y-auto rounded-sm border border-border bg-muted/50 px-2.5 py-1.5"
      >
        <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-[1.55] text-muted-foreground">
          {text}
        </pre>
      </div>
    </div>
  );
}
```

`function FreeTextRow(` の `return (` から関数の閉じ括弧までを次にする。

```tsx
  return (
    <div
      className="flex items-center gap-3 rounded-sm border border-dashed border-border px-3 py-2 focus-within:border-primary focus-within:border-solid"
      title={`${digitLabel}. その他 (自由入力)`}
    >
      <span className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-[6px] bg-muted text-muted-foreground">
        <Pencil aria-hidden="true" className="size-3.5" />
      </span>
      <input
        type="text"
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (
            e.key === "Enter" &&
            !e.nativeEvent.isComposing &&
            onSubmit &&
            value.trim()
          ) {
            e.preventDefault();
            onSubmit(value);
          }
        }}
        aria-label="その他 (自由入力)"
        placeholder={
          onSubmit ? "その他 (自由入力、Enterで送信)" : "その他 (自由入力)"
        }
        className="min-w-0 flex-1 bg-transparent text-[15px] placeholder:text-muted-foreground focus:outline-none disabled:opacity-50"
      />
      {onSubmit && (
        <button
          type="button"
          onClick={() => onSubmit(value)}
          disabled={!value.trim() || disabled}
          className="shrink-0 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-30"
        >
          送信
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 29: `AwaitingPad` をカードにする**

`SplitChatPane.tsx` のimportに `import { StatusChip } from "@/components/StatusChip";` を足す (`@/components/MermaidBlock` の後)。

`function AwaitingPad(` の中の `const keyBtn = (` から関数の閉じ括弧までを次で置き換える。

```tsx
  const keyBtn = (label: string, key: SpecialKey, title: string) => (
    <button
      key={label}
      type="button"
      onClick={() => onSendKey(key)}
      className="rounded-sm border border-border bg-background px-2 py-0.5 font-mono text-xs transition-colors hover:bg-muted"
      title={title}
    >
      {label}
    </button>
  );

  return (
    <div className="rounded-lg border border-border bg-card px-4 pt-3.5 pb-3 shadow-card">
      <div className="flex min-w-0 items-center gap-2">
        <StatusChip statusKey="AWAITING" />
        <span className="min-w-0 text-[13px] font-semibold text-foreground">
          Claudeが入力を求めています
        </span>
      </div>
      {awaitingText && (
        <pre className="mt-2 overflow-x-auto whitespace-pre rounded-sm border border-border bg-muted/50 px-2.5 py-2 font-mono text-[11px] leading-[1.5] text-foreground/80">
          {awaitingText}
        </pre>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {(["1", "2", "3", "4", "5", "6"] as const).map(d =>
          keyBtn(d, d, `${d}を送信 (選択肢ジャンプ/トグル)`)
        )}
        <span className="w-2" />
        {keyBtn("↑", "Up", "フォーカスを上へ")}
        {keyBtn("↓", "Down", "フォーカスを下へ")}
        {keyBtn("→", "Right", "次のタブ / Submitへ")}
        {keyBtn("Space", "Space", "チェックをトグル")}
        {keyBtn("Enter", "Enter", "フォーカス中の項目を選択/確定")}
        {keyBtn("Esc", "Escape", "キャンセル")}
      </div>
      <div className="mt-2 flex items-center gap-2 rounded-full border border-border bg-background py-1 pr-1 pl-3 focus-within:border-primary">
        <input
          type="text"
          value={freeText}
          onChange={e => setFreeText(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submitFreeText();
            }
          }}
          aria-label="自由入力"
          placeholder="自由入力: 先にType somethingの番号を押してから入力 (Enterで確定)"
          className="min-w-0 flex-1 bg-transparent py-0.5 text-[13px] placeholder:text-muted-foreground focus:outline-none"
        />
        <button
          type="button"
          onClick={submitFreeText}
          disabled={!freeText.trim()}
          className="shrink-0 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-30"
        >
          入力して確定
        </button>
      </div>
    </div>
  );
}
```

キーボタンの `title` は日本語と数字の間の空白だけを詰める (`1を送信 (選択肢ジャンプ/トグル)`。テストは `title^="1を送信"` で探す)。

- [ ] **Step 30: テストと直書き色・絵文字の残りを確かめる**

Run: `pnpm vitest run packages/web/src/components/AskUserQuestionCard.test.tsx packages/web/src/components/SplitChatPane.test.tsx`
Expected: PASS (`Test Files  2 passed`)

Run: `grep -nE "emerald-|blue-|violet-|amber-|slate-|#[0-9a-fA-F]{6}|⚙|❓|⏳|🧵|🖼|✂|🎨|🖥|☐|☑|▸|▾" packages/web/src/components/SplitChatPane.tsx packages/web/src/components/AskUserQuestionCard.tsx`
Expected: 何も出力されない

Run: `grep -n "font-mono" packages/web/src/components/SplitChatPane.tsx packages/web/src/components/AskUserQuestionCard.tsx`
Expected: 次の5か所だけ。`FileLink` の画像のパス表示、`ToolCallRow` の引数、`AwaitingPad` のキーボタンと `<pre>`、`ScreenContextBlock` の `<pre>`

- [ ] **Step 31: 型とlintを通してコミットする**

Run: `pnpm biome check --write packages/web/src/components/SplitChatPane.tsx packages/web/src/components/SplitChatPane.test.tsx packages/web/src/components/AskUserQuestionCard.tsx packages/web/src/components/AskUserQuestionCard.test.tsx && pnpm check`
Expected: エラーなし

```bash
git branch --show-current   # feat/visual-redesign-paperであること
git add packages/web/src/components/SplitChatPane.tsx packages/web/src/components/SplitChatPane.test.tsx packages/web/src/components/AskUserQuestionCard.tsx packages/web/src/components/AskUserQuestionCard.test.tsx
git commit -m "質問カードと確認待ちの操作をカードの形にそろえる"
```

#### 9e: layout="mobile"

- [ ] **Step 32: 余白の計算の失敗するテストを書く**

`packages/web/src/lib/floating-composer.test.ts` を作る。

```ts
import { describe, expect, it } from "vitest";
import { FLOATING_BAR_BOTTOM, floatingBarReserve } from "./floating-composer";

describe("floating-composer", () => {
  it("バーの下端からの距離は12pxとsafe areaの大きい方", () => {
    expect(FLOATING_BAR_BOTTOM).toBe("max(12px, env(safe-area-inset-bottom))");
  });

  it("余白は、実測の高さ・下端からの距離・12pxを足したcalc", () => {
    expect(floatingBarReserve(96)).toBe(
      "calc(96px + max(12px, env(safe-area-inset-bottom)) + 12px)"
    );
  });

  it("小数の高さは切り上げ、負の値は0として扱う", () => {
    expect(floatingBarReserve(95.2)).toBe(
      "calc(96px + max(12px, env(safe-area-inset-bottom)) + 12px)"
    );
    expect(floatingBarReserve(-1)).toBe(
      "calc(0px + max(12px, env(safe-area-inset-bottom)) + 12px)"
    );
  });
});
```

`SplitChatPane.test.tsx` の末尾にも追記する。

```tsx
describe('SplitChatPane: layout="mobile"', () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("入力欄を浮かぶガラスバーに入れ、composerAccessoryを入力欄の上段に置く", () => {
    const { container } = renderChat({
      layout: "mobile",
      composerAccessory: <div data-testid="accessory">会話 / 端末 / 図</div>,
    });

    const bar = container.querySelector("[data-mobile-bottom-bar]");
    expect(bar?.classList.contains("glass-bar")).toBe(true);
    const accessory = bar?.querySelector('[data-testid="accessory"]');
    const textarea = bar?.querySelector('textarea[aria-label="メッセージ"]');
    expect(accessory).not.toBeNull();
    expect(textarea).not.toBeNull();
    expect(accessory?.compareDocumentPosition(textarea as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it("バーを下端から浮かせ、本文の下端にバーの高さと下端からの距離を足した余白を取る", () => {
    const { container } = renderChat({ layout: "mobile" });

    const stack = container.querySelector<HTMLElement>(
      '[data-testid="floating-composer"]'
    );
    const content = container.querySelector<HTMLElement>(
      '[data-testid="chat-scroll-content"]'
    );
    expect(stack?.style.bottom).toBe("max(12px, env(safe-area-inset-bottom))");
    expect(content?.style.paddingBottom).toContain(
      "env(safe-area-inset-bottom)"
    );
  });

  it("質問カードはガラスバーの外 (上) に積む", () => {
    const { container } = renderChat({
      layout: "mobile",
      bridgeStatus: "AWAITING",
    });

    const stack = container.querySelector('[data-testid="floating-composer"]');
    const bar = stack?.querySelector("[data-mobile-bottom-bar]");
    expect(bar).not.toBeNull();
    expect(stack?.textContent).toContain("確認待ち");
    expect(bar?.textContent).not.toContain("確認待ち");
  });

  it("layoutを渡さない (PC) ときはガラスバーもaccessoryも出さず、本文の余白も足さない", () => {
    const { container } = renderChat({
      composerAccessory: <div data-testid="accessory" />,
    });

    expect(container.querySelector(".glass-bar")).toBeNull();
    expect(container.querySelector("[data-mobile-bottom-bar]")).toBeNull();
    expect(container.querySelector('[data-testid="accessory"]')).toBeNull();
    expect(
      container.querySelector<HTMLElement>(
        '[data-testid="chat-scroll-content"]'
      )?.style.paddingBottom
    ).toBe("");
  });
});
```

(jsdom 30は `calc()` を正規化するので、本文の余白は `env(safe-area-inset-bottom)` を含むことだけを見る。数値の組み立ては `floating-composer.test.ts` で固定する)

- [ ] **Step 33: テストを実行して失敗を確認する**

Run: `pnpm vitest run packages/web/src/lib/floating-composer.test.ts packages/web/src/components/SplitChatPane.test.tsx`
Expected: FAIL。`floating-composer.test.ts` はimportの解決に失敗する。`SplitChatPane.test.tsx` の `layout="mobile"` の3件は `[data-mobile-bottom-bar]` / `floating-composer` が無いため落ちる (PCの1件はPASS)

- [ ] **Step 34: `floating-composer.ts` を実装する**

```ts
/**
 * floating-composer - モバイルの浮かぶ入力バーの置き場所と、本文の下端に確保する余白。
 *
 * バーは本文コンテナの下端からFLOATING_BAR_BOTTOMだけ浮かせて絶対配置する。
 * 本文はバーの下を通るので、最下部までスクロールしたときに最後の行が隠れないよう
 * 「バーの実測の高さ + バーの下端からの距離 + 12px」の余白を本文の下端に取る。
 * 距離はenv(safe-area-inset-bottom) を含むのでpxに直さず、calcのままブラウザに解決させる
 */

/** 下端からの距離。ホームインジケータのある端末ではsafe areaの分だけ上げる */
export const FLOATING_BAR_BOTTOM = "max(12px, env(safe-area-inset-bottom))";

/** バーと本文の最後の行のあいだの余白 (px) */
const FLOATING_BAR_GAP_PX = 12;

/**
 * 本文の下端に確保する余白 (CSSの値)。
 * stackHeightPxはバー (と上に積んだカード) の実測の高さ
 */
export function floatingBarReserve(stackHeightPx: number): string {
  const height = Math.max(0, Math.ceil(stackHeightPx));
  return `calc(${height}px + ${FLOATING_BAR_BOTTOM} + ${FLOATING_BAR_GAP_PX}px)`;
}
```

- [ ] **Step 35: propsとimportを足す**

`SplitChatPane.tsx` の `interface SplitChatPaneProps` の `onActiveAuqChange` の直前に足す。

```tsx
  /**
   * "pane" = PC (入力欄は通常の配置)、"mobile" = 入力欄を浮かぶガラスバーにし、
   * 本文をその下に通す。既定は "pane"
   */
  layout?: "pane" | "mobile";
  /** layout="mobile" のとき、ガラスバーの上段 (入力欄の上) に置く要素 */
  composerAccessory?: ReactNode;
```

引数に `layout = "pane",` と `composerAccessory,` を足す (`onUploadFile,` の後)。

reactのimportに `type RefObject` を足す。

```tsx
import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
```

`@/lib/chat-render-items` のimportの後に足す。

```tsx
import {
  FLOATING_BAR_BOTTOM,
  floatingBarReserve,
} from "@/lib/floating-composer";
```

ファイル先頭のコメントの `入力欄は最下部に固定。` を次にする。

```tsx
 * 入力欄は最下部に固定 (layout="mobile" では本文の上に浮かぶガラスバー)。
```

- [ ] **Step 36: 要素の高さを追うフックを足す**

`// ===== 本体 =====` の直前に足す。

```tsx
/**
 * 要素の高さ (px) をResizeObserverで追う。enabledがfalseの間は0。
 * ResizeObserverの無い環境 (jsdom等) では最初の1回だけ測る
 */
function useElementHeight(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean
): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) {
      setHeight(0);
      return;
    }
    const measure = () => setHeight(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, enabled]);
  return height;
}
```

- [ ] **Step 37: 本体で余白を求め、末尾追従に足す**

`const jsonlScrollRef = useRef<HTMLDivElement>(null);` の直後に足す。

```tsx
  // モバイルの浮かぶバー (と上に積んだカード) の高さ。本文の下端の余白に使う
  const isMobile = layout === "mobile";
  const floatingStackRef = useRef<HTMLDivElement>(null);
  const floatingStackHeight = useElementHeight(floatingStackRef, isMobile);
  const bottomReserve = isMobile
    ? floatingBarReserve(floatingStackHeight)
    : undefined;
```

末尾追従のeffectの直前のコメントと依存配列を次にする (本体はそのまま)。

```tsx
  // biome-ignore lint/correctness/useExhaustiveDependencies: events (イベント追加で高さが変わる) とfloatingStackHeight (モバイルで入力欄が伸びて本文の下端の余白が増える) のたびに末尾追従スクロールを再実行するための意図的な依存
  useEffect(() => {
```

```tsx
  }, [events, isNearBottom, floatingStackHeight]);
```

- [ ] **Step 38: 描画をlayoutで分ける**

9cで書いた次の行を、

```tsx
  const composerSize = COMPOSER_SIZE.pane;
```

次にする。

```tsx
  const composerSize = COMPOSER_SIZE[layout];
```

`slashMenu` の直前のコメントを次にする。

```tsx
  // 補完候補。PCは入力欄の枠、モバイルは下部のスタックの上端に合わせて出す
```

textareaの `placeholder` を次にする (モバイルは幅が狭いので短くする)。

```tsx
        placeholder={
          isMobile
            ? "メッセージを入力"
            : onUploadFile
              ? "メッセージを入力 (Enterで送信、Shift+Enterで改行。画像はD&D・貼り付けも可)"
              : "メッセージを入力 (Enterで送信、Shift+Enterで改行)"
        }
```

本文のラッパーに余白を足す。

```tsx
          <div
            data-testid="chat-scroll-content"
            className="mx-auto w-full max-w-[760px] py-2"
          >
```

を次にする。

```tsx
          <div
            data-testid="chat-scroll-content"
            className="mx-auto w-full max-w-[760px] py-2"
            style={bottomReserve ? { paddingBottom: bottomReserve } : undefined}
          >
```

`ToolGroupCard` の `surfaceClassName="bg-background"` を次にする (PCはカードの上なので紙、モバイルは紙の上なので白)。

```tsx
                        surfaceClassName={isMobile ? "bg-card" : "bg-background"}
```

「最新まで一気にスクロール」ボタンのclassNameの `absolute bottom-3 left-1/2` を `absolute left-1/2` にし、`style` を足す。

```tsx
            className="absolute left-1/2 z-10 flex size-9 -translate-x-1/2 items-center justify-center rounded-full bg-foreground/85 text-background shadow-card transition-colors hover:bg-foreground"
            style={{ bottom: bottomReserve ?? "12px" }}
```

9cで書いた `{dockedCard && (` から、`{composerForm}` を含む入力欄のブロックの閉じタグ (`</div>` 2つ) までを次で置き換える。

```tsx
      {isMobile ? (
        // カードとガラスバーを1つのスタックに積み、本文コンテナの下端から浮かせる。
        // ガラスはバーだけに使い、カードは不透明のまま上に置く
        <div
          ref={floatingStackRef}
          data-testid="floating-composer"
          className="absolute inset-x-3 z-10 flex max-h-[70%] flex-col gap-2"
          style={{ bottom: FLOATING_BAR_BOTTOM }}
        >
          {slashMenu}
          {dockedCard && (
            <div className="-mx-1 min-h-0 overflow-y-auto px-1 pb-2">{dockedCard}</div>
          )}
          {/* data-mobile-bottom-bar: Task 12の検証スクリプトが下部バーの位置を測る目印
              (端末・図モードのバーにはTask 10が付ける) */}
          <div
            data-mobile-bottom-bar=""
            className="glass-bar flex shrink-0 flex-col gap-2 rounded-[28px] p-2"
          >
            {composerAccessory}
            {composerForm}
          </div>
        </div>
      ) : (
        <>
          {dockedCard && (
            <div className="max-h-[45%] shrink-0 overflow-y-auto px-4 pt-2 pb-3">
              <div className="mx-auto w-full max-w-[760px]">{dockedCard}</div>
            </div>
          )}
          <div className="shrink-0 border-t border-border px-4 pt-3 pb-3.5">
            <div className="relative mx-auto w-full max-w-[792px]">
              {slashMenu}
              {composerForm}
            </div>
          </div>
        </>
      )}
```

- [ ] **Step 39: テストを実行して通過を確認する**

Run: `pnpm vitest run packages/web/src/lib/floating-composer.test.ts packages/web/src/components/SplitChatPane.test.tsx`
Expected: PASS (`Test Files  2 passed`)

- [ ] **Step 40: 関連するテストをまとめて流す**

Run: `pnpm vitest run packages/web/src/index-css.test.ts packages/web/src/lib/chat-render-items.test.ts packages/web/src/lib/floating-composer.test.ts packages/web/src/lib/ask-user-question-state.test.ts packages/web/src/lib/jsonl-event-parser.test.ts packages/web/src/components/SplitChatPane.test.tsx packages/web/src/components/AskUserQuestionCard.test.tsx packages/web/src/components/SplitViewPane.test.tsx packages/web/src/pages/Dashboard.test.tsx`
Expected: PASS (すべて。`index-css.test.ts` はTask 1のトークンの検査で、`.md-prose` の書き換えで壊れないことを見る。`SplitViewPane` と `Dashboard` は `SplitChatPane` をモックしているので、propsの削除の影響を受けない)

- [ ] **Step 41: 型とlintを通してコミットする**

Run: `pnpm biome check --write packages/web/src/components/SplitChatPane.tsx packages/web/src/components/SplitChatPane.test.tsx packages/web/src/lib/floating-composer.ts packages/web/src/lib/floating-composer.test.ts && pnpm check`
Expected: エラーなし

```bash
git branch --show-current   # feat/visual-redesign-paperであること
git add packages/web/src/components/SplitChatPane.tsx packages/web/src/components/SplitChatPane.test.tsx packages/web/src/lib/floating-composer.ts packages/web/src/lib/floating-composer.test.ts
git commit -m "会話の入力欄をモバイルで浮かぶガラスバーにする"
```

---

### Task 10: モバイル会話: ヘッダー・状態の帯・下部バー

**Files:**
- Modify: `packages/web/src/components/MobileSessionViewModeToggle.tsx` (全体を置き換え)
- Modify: `packages/web/src/components/MobileSessionView.tsx`
  - コメントと import (1-73行目)、props (91-131行目)、分割代入 (133-167行目)、state (215行目の直後)、`slashCommands` (422-428行目) の直後
  - ヘッダー (439-529行目) を置き換え、直後に状態の帯を足す
  - 会話モード (531-548行目)、端末の容器と背景 (552-572行目)、Quick Keys と入力バー (713-787行目)、図モード (790-814行目) を置き換え
  - 削除確認ダイアログの説明文 (839-843行目)
- Modify: `packages/web/src/components/MobileLayout.tsx` (import と、詳細画面の map の中の `MobileSessionView` の呼び出し。Task 6 が props と一覧のブロックを先に書き換えるので、行番号ではなく引用したコードを目印にする)
- Test: `packages/web/src/components/MobileSessionView.test.tsx`

**Interfaces:**
- Consumes:
  - Task 1: `.status-dots` (子の `<span>` 3つ)、`bg-status-*/15` `text-status-*`、`bg-card` `bg-background` `border-border`、角丸 `rounded-sm` (8px)
  - Task 2: `resolveStatusKey` / `resolveStatusStrip` / `TONE_CLASSES` / `StatusTone` (`@/lib/status-tone`)、`StatusChip` (外側の要素に `data-status` を持つ)
  - Task 4: `TERMINAL_BG` (`@ark/shared`)
  - Task 7: `SegmentedControl` / `SegmentOption` (`./SegmentedControl`。任意の `label` を持つ)、`resolveSessionHeaderLabels` / `notificationMenuLabel` / `deleteSessionDescription` (`@/lib/session-header`)、`previewOf` (`./MessageShortcutMenu` から export 済み)
  - Task 6: `MobileLayoutProps` の `worktreeDisplayNames: Map<string, string>` (必須。Dashboard からの受け渡しも Task 6)
  - Task 9: `SplitChatPane` の `layout` / `composerAccessory` / `onActiveAuqChange` (マウント時に false で1回呼ぶ)、`FLOATING_BAR_BOTTOM` (`@/lib/floating-composer`)
- Produces:
  - `MobileSessionViewModeToggle` に `className?: string` を足す。`MOBILE_SESSION_VIEW_MODES` は `readonly SegmentOption<MobileSessionViewMode>[]` になる
  - `MobileSessionViewProps` に `repoName?: string` / `displayName?: string | null` / `notificationsSupported?: boolean` / `notificationsEnabled?: boolean` / `onNotificationsEnabledChange?: (enabled: boolean) => void` を足す (PC の `SplitViewPane` の props と同じ名前と型)

**前提 (他タスクとの契約):**
- `isConnected` は今も `MobileSessionViewProps` に届いている (`MobileDiagramPaneProps` 経由。`MobileLayout.tsx:389` で `isConnected={isSocketConnected}`)。状態の帯はこれをそのまま使い、新しい prop は足さない
- SplitChatPane の `layout="mobile"` は、質問カードとガラスバーを積んだスタック (`[data-testid="floating-composer"]`) を本文の下端から `FLOATING_BAR_BOTTOM` の位置に絶対配置し、本文の下端の余白も SplitChatPane 側で実測して付ける (Task 9)。Task 10 は SplitChatPane を本文コンテナいっぱいに置き、`composerAccessory` にセグメントを渡すだけにする。端末と図のバーの下端の余白も同じ `FLOATING_BAR_BOTTOM` を使う
- 下部バーのいちばん外側の要素に `data-mobile-bottom-bar` を付ける (Task 12 が端末モードで「iframe の下端 ≤ 下部バーの上端」を測る)。端末と図のバーは Task 10 が付ける。会話モードのガラスバー (`.glass-bar` の要素) は SplitChatPane の中にあるので Task 9 が付ける (08-09.md の 9e Step 38)。図モードのバーはガラスにせず不透明にするので、`.glass-bar` の class 列にはそろえない (理由は Step 25)。3モードの本文はマウントしたまま `hidden` で隠すので、属性を持つ要素はDOMに同時に3つある。測るときは表示中の1つに絞る
- セグメントの各ボタンは `SegmentedControl` (Task 7) が `<button type="button" aria-label="会話" | "端末" | "図">` で描く
- 質問カード (`AskUserQuestionCard`) と `AwaitingPad` の位置は Task 9 のまま。Task 10 は触らない
- 詳細画面のラッパーと下部タブバー (`showBottomNav`) は Task 6 の担当。Task 10 は触らない。Task 6 は詳細画面ではリモートでも下部タブを出さず、詳細画面のラッパーから `pb-14` を外す (`isActive ? "flex-1 flex flex-col min-h-0" : "hidden"`)。下部バーは画面の下端に置く前提でよい
- 主ラベルは PC の上部バーと同じ `resolveSessionHeaderLabels` で決め、リポジトリ名は Task 7 の Dashboard と同じ順 (`session.repoPath` → worktree のパス → 兄弟ディレクトリの推定) で求める。一覧 (`useGroupedWorktreeItems`) に出る行については、一覧のリポジトリ名と同じ結果になる (一覧は `session.repoPath` も worktree のパスの一致も無い worktree を出さないため)
- `worktreeDisplayNames: Map<string, string>` (必須) は Task 6 が `MobileLayoutProps` に足し、Dashboard から渡す (plan-t5-6 に確認済み)。Task 10 は読むだけ
- Radix の `DropdownMenu` は jsdom で開けない (Portal とポインタイベントが要り、リポジトリに前例も無い)。`…` メニューの中身は単体テストで開かず、入口のボタンだけを確かめる。項目の文言は Task 7 の `session-header.test.ts` が固定している。中身の見た目は Task 12 の撮影で確かめる

---

- [ ] **Step 1: 表示モードのセグメントのテストを、絵文字を見ないように直す**

`packages/web/src/components/MobileSessionView.test.tsx` の最後の `it("現在モードが分かる 3 択トグルを表示する", …)` (92-109行目) を、次に置き換える。

```tsx
  it("現在モードが分かる3択のセグメントを、絵文字を使わずに表示する", () => {
    const markup = renderToStaticMarkup(
      createElement(MobileSessionViewModeToggle, {
        value: "board",
        onChange: vi.fn(),
      })
    );

    expect(markup.match(/<button/g)).toHaveLength(3);
    for (const label of ["会話", "端末", "図"]) {
      expect(markup).toContain(`aria-label="${label}"`);
    }
    expect(markup).toMatch(
      /aria-label="図"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*aria-label="図"/
    );
    expect(markup).not.toMatch(/💬|🖥|📐/);
  });
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `pnpm vitest run packages/web/src/components/MobileSessionView.test.tsx`
Expected: FAIL (`現在モードが分かる3択のセグメントを、絵文字を使わずに表示する` が `expected … not to match /💬|🖥|📐/` で落ちる)

- [ ] **Step 3: `MobileSessionViewModeToggle` を `SegmentedControl` で書き直す**

`packages/web/src/components/MobileSessionViewModeToggle.tsx` を丸ごと次に置き換える。

```tsx
import { MessageCircle, Shapes, SquareTerminal } from "lucide-react";
import type { MobileSessionViewMode } from "../lib/mobile-session-view-mode";
import { type SegmentOption, SegmentedControl } from "./SegmentedControl";

export const MOBILE_SESSION_VIEW_MODES: readonly SegmentOption<MobileSessionViewMode>[] =
  [
    { value: "chat", label: "会話", icon: MessageCircle },
    { value: "terminal", label: "端末", icon: SquareTerminal },
    { value: "board", label: "図", icon: Shapes },
  ];

interface MobileSessionViewModeToggleProps {
  value: MobileSessionViewMode;
  onChange: (mode: MobileSessionViewMode) => void;
  className?: string;
}

/** モバイルの下部バーの上段に置く「会話 / 端末 / 図」 */
export function MobileSessionViewModeToggle({
  value,
  onChange,
  className,
}: MobileSessionViewModeToggleProps) {
  return (
    <SegmentedControl
      options={MOBILE_SESSION_VIEW_MODES}
      value={value}
      onChange={onChange}
      label="表示モード"
      className={className}
    />
  );
}
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `pnpm vitest run packages/web/src/components/MobileSessionView.test.tsx`
Expected: PASS (8件)

- [ ] **Step 5: 整形してコミット**

```bash
pnpm biome check --write packages/web/src/components/MobileSessionViewModeToggle.tsx packages/web/src/components/MobileSessionView.test.tsx
pnpm check   # エラー無し
git branch --show-current   # feat/visual-redesign-paper であること
git add packages/web/src/components/MobileSessionViewModeToggle.tsx packages/web/src/components/MobileSessionView.test.tsx
git commit -m "feat(web): モバイルの表示モード切替をセグメントコントロールにする

絵文字のアイコンをやめ、PCと同じ SegmentedControl で「会話 / 端末 / 図」を出す。
下部バーで幅いっぱいに広げられるよう className を受け取る。"
```

- [ ] **Step 6: ヘッダーのテストを書く**

`packages/web/src/components/MobileSessionView.test.tsx` の先頭の import (1-14行目) を、次に置き換える。既存の `describe("mobile session view mode", …)` はそのまま残す。

```tsx
// @vitest-environment jsdom

import type { ManagedSession, Worktree } from "@ark/shared";
import {
  act,
  type ComponentProps,
  createElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDiagramOpenRequest,
  getViewModeForDiagramOpenRequest,
  getViewModeForViewerTab,
  normalizeMobileSessionViewMode,
  writeSavedViewMode,
} from "../lib/mobile-session-view-mode";
import { MobileSessionView } from "./MobileSessionView";
import {
  MOBILE_SESSION_VIEW_MODES,
  MobileSessionViewModeToggle,
} from "./MobileSessionViewModeToggle";

interface ObservedChatProps {
  isActive: boolean;
  layout?: "pane" | "mobile";
  composerAccessory?: ReactNode;
  onActiveAuqChange?: (hasActiveAuq: boolean) => void;
}

const testDoubles = vi.hoisted(() => ({
  splitChatPane: vi.fn(),
}));

// 会話ビューの中身は Task 9 のテストで確かめる。ここでは受け取った props と、
// ガラスバーの上段に置かれる composerAccessory の描画だけを見る
vi.mock("./SplitChatPane", () => ({
  SplitChatPane: (props: ObservedChatProps) => {
    testDoubles.splitChatPane(props);
    return <div data-testid="chat-pane">{props.composerAccessory}</div>;
  },
}));

vi.mock("./DiagramPane", () => ({
  DiagramPane: () => <div data-testid="diagram-pane" />,
}));

vi.mock("../hooks/useTerminalLinkInjection", () => ({
  useTerminalLinkInjection: () => undefined,
}));

vi.mock("../hooks/useTtydReconnect", () => ({
  useTtydReconnect: () => undefined,
}));

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function mount(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mountedRoots.push({ root, container });
  return container;
}

const notCalled = async (): Promise<never> => {
  throw new Error("このテストでは呼ばれない関数です");
};

const worktree: Worktree = {
  id: "wt-1",
  path: "/repos/recipe-app-login",
  branch: "feat/login",
  commit: "abc1234",
  isMain: false,
  isBare: false,
};

function makeSession(): ManagedSession {
  return {
    id: "s1",
    worktreeId: "wt-1",
    worktreePath: "/repos/recipe-app-login",
    repoPath: "/repos/recipe-app",
    status: "active",
    createdAt: new Date("2026-09-17T00:00:00Z"),
    tmuxSessionName: "ark-s1",
    ttydPort: 7680,
    ttydUrl: "/ttyd/s1/",
  };
}

function makeProps(
  overrides: Partial<ComponentProps<typeof MobileSessionView>> = {}
): ComponentProps<typeof MobileSessionView> {
  return {
    socket: null,
    isActive: true,
    session: makeSession(),
    worktree,
    repoName: "recipe-app",
    onBack: vi.fn(),
    onSendMessage: vi.fn(),
    onSendKey: vi.fn(),
    onDeleteSession: vi.fn(),
    tabs: [{ type: "terminal", id: "terminal-s1" }],
    activeTabIndex: 0,
    diagramOpenRequest: null,
    onTabSelect: vi.fn(),
    onTabClose: vi.fn(),
    messageShortcuts: [],
    onCreateShortcut: vi.fn(),
    onUpdateShortcut: vi.fn(),
    onDeleteShortcut: vi.fn(),
    isConnected: true,
    diagramCommentsUpdate: null,
    listDiagrams: async () => [],
    deleteDiagram: notCalled,
    getDiagramComments: notCalled,
    createDiagramComment: notCalled,
    replyDiagramComment: notCalled,
    resolveDiagramComment: notCalled,
    deleteDiagramComment: notCalled,
    sendDiagramComment: notCalled,
    onSelectDiagram: vi.fn(),
    ...overrides,
  };
}

function latestChatProps(): ObservedChatProps {
  const latest = testDoubles.splitChatPane.mock.calls.at(-1)?.[0];
  expect(latest).toBeDefined();
  return latest as ObservedChatProps;
}

function click(element: Element | null | undefined): void {
  expect(element).not.toBeNull();
  expect(element).toBeDefined();
  act(() => (element as HTMLElement).click());
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  testDoubles.splitChatPane.mockClear();
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});
```

同じファイルの末尾に次を足す。

```tsx
describe("MobileSessionView のヘッダー", () => {
  it("表示名・ブランチ・状態チップを出し、絵文字と等幅を使わない", () => {
    const container = mount(
      <MobileSessionView
        {...makeProps({ bridgeStatus: "AWAITING", displayName: "ログイン画面" })}
      />
    );
    const header = container.querySelector("header");

    expect(header?.textContent).toContain("ログイン画面");
    expect(header?.textContent).not.toContain("recipe-app");
    expect(header?.textContent).toContain("feat/login");
    expect(
      header?.querySelector('[data-status="AWAITING"]')?.textContent
    ).toBe("確認待ち");
    expect(header?.querySelector(".font-mono")).toBeNull();
    expect(header?.querySelector(".status-indicator")).toBeNull();
    expect(container.innerHTML).not.toMatch(/💬|🖥|📐/);
  });

  it("戻るボタンと操作メニューの入口だけを置き、削除とショートカットはメニューへ畳む", () => {
    const onBack = vi.fn();
    const container = mount(<MobileSessionView {...makeProps({ onBack })} />);
    const header = container.querySelector("header");

    // 表示名が無ければリポジトリ名を主ラベルにする
    expect(header?.textContent).toContain("recipe-app");
    click(header?.querySelector('button[aria-label="一覧へ戻る"]'));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(
      header?.querySelector('button[aria-label="セッションの操作"]')
    ).not.toBeNull();
    expect(header?.querySelector('button[title="セッションを削除"]')).toBeNull();
    expect(
      header?.querySelector('button[title="メッセージショートカット"]')
    ).toBeNull();
  });
});
```

- [ ] **Step 7: テストが落ちることを確かめる**

Run: `pnpm vitest run packages/web/src/components/MobileSessionView.test.tsx`
Expected: FAIL (`MobileSessionView のヘッダー` の2件。1件目は `expected '…' to contain 'ログイン画面'`、2件目は今のヘッダーにリポジトリ名が無く `expected '…' to contain 'recipe-app'`)

- [ ] **Step 8: `MobileSessionView` の import を置き換える**

`packages/web/src/components/MobileSessionView.tsx` の先頭のコメントから `MobileDiagramPaneProps` の閉じ `>;` まで (1-79行目) を、次に置き換える (末尾の `TypedSocket` と `MobileDiagramPaneProps` も置き換えに含めるので、二重に宣言しない)。
ヘッダーの差し替えで使わなくなる `GitBranch` `MoreVertical` と、コンポーネントの `MessageShortcutMenu` はここで外す (本文の要約に使う `previewOf` だけを取り込む)。状態の帯と端末の背景で使う import は Step 16・23 で足す。

```tsx
/**
 * MobileSessionView - モバイル用セッション詳細画面
 *
 * ヘッダー (戻る・主ラベル・ブランチ・状態チップ・操作メニュー) と、その直下の状態の帯、
 * 「会話 / 端末 / 図」の本文と下部バーで組む。
 * 3モードの本文はマウントしたまま display で切り替える (ttyd と図の iframe を張り直さない)。
 */

import type {
  BridgeSessionStatus,
  ClientToServerEvents,
  ManagedSession,
  MessageShortcut,
  ServerToClientEvents,
  SpecialKey,
  Worktree,
} from "@ark/shared";
import {
  Bell,
  BellOff,
  ChevronLeft,
  Copy,
  Ellipsis,
  File as FileIcon,
  ImageIcon,
  MessageSquareQuote,
  RefreshCw,
  RotateCw,
  Send,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteSessionDescription,
  notificationMenuLabel,
  resolveSessionHeaderLabels,
} from "@/lib/session-header";
import { resolveStatusKey } from "@/lib/status-tone";
import { fileToBase64, validateFile } from "../hooks/useFileUpload";
import { useTerminalLinkInjection } from "../hooks/useTerminalLinkInjection";
import { useTtydReconnect } from "../hooks/useTtydReconnect";
import { useVisualViewport } from "../hooks/useVisualViewport";
import {
  type DiagramOpenRequest,
  getViewModeForDiagramOpenRequest,
  getViewModeForViewerTab,
  type MobileSessionViewMode,
  readSavedViewMode,
  writeSavedViewMode,
} from "../lib/mobile-session-view-mode";
import { DiagramPane, type DiagramPaneProps } from "./DiagramPane";
import { FileViewerPane } from "./FileViewerPane";
import { HtmlViewerPane } from "./HtmlViewerPane";
import { MessageShortcutManagerDialog } from "./MessageShortcutManagerDialog";
import { previewOf } from "./MessageShortcutMenu";
import { MobileSessionViewModeToggle } from "./MobileSessionViewModeToggle";
import { SplitChatPane } from "./SplitChatPane";
import { StatusChip } from "./StatusChip";
import type { ViewerTab } from "./TerminalPane";
import { ViewerTabBar } from "./ViewerTabBar";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

type MobileDiagramPaneProps = Omit<
  DiagramPaneProps,
  "sessionId" | "worktreePath" | "relPath"
>;
```

- [ ] **Step 9: props と分割代入に主ラベルと通知の設定を足す**

同じファイルの `MobileSessionViewProps` で、`worktree: Worktree | undefined;` の行 (101行目) の直後に次を足す。名前と型は PC の `SplitViewPane` (Task 7) にそろえる。

```tsx
  /** 主ラベルに使うリポジトリ名 (basename)。所属が分からなければ undefined */
  repoName?: string;
  /** worktree のカスタム表示名。あれば主ラベルにする */
  displayName?: string | null;
  /** Notification API 対応環境でだけ「このセッションの通知をオン/オフにする」を出す */
  notificationsSupported?: boolean;
  /** このセッションの通知が有効か (未設定なら有効) */
  notificationsEnabled?: boolean;
  onNotificationsEnabledChange?: (enabled: boolean) => void;
```

分割代入で、`worktree,` の行 (139行目) の直後に次を足す。

```tsx
  repoName,
  displayName,
  notificationsSupported = false,
  notificationsEnabled = true,
  onNotificationsEnabledChange,
```

スラッシュコマンドの配列 `const slashCommands = [ … ];` (422-428行目) の直後に次を足す。

```tsx
  // ヘッダーの主ラベル (表示名 → リポジトリ名 → worktree のフォルダ名) とブランチ。PC の上部バーと同じ決め方
  const headerLabels = resolveSessionHeaderLabels({
    displayName,
    repoName,
    branch: worktree?.branch,
    worktreePath: session.worktreePath,
  });
```

- [ ] **Step 10: ヘッダーを置き換える**

同じファイルの `{/* ヘッダー: 戻る、ブランチ名、Opsドロップダウン、Stopボタン */}` から、`</header>` まで (439-529行目) を、次に置き換える。
中身は今の Ops メニュー・メッセージショートカット・削除ボタンをまとめたもの。メニュー項目の文言は PC の上部バー (設計書 8.2 節) にそろえる。
メッセージショートカットはサブメニューにせず、見出し付きで同じメニューに並べる (`DropdownMenuSubContent` はスクロールせず、幅390pxでは左右どちらにも収まらないため。`DropdownMenuContent` は画面の高さを超えるとスクロールする)。
スラッシュコマンドの項目から `font-mono` を外す (等幅はGlobal Constraintsの対象外)。
表示モードの切替 (`MobileSessionViewModeToggle`) は、Step 21-25 で下部バーへ移すまでヘッダーに残す (途中のコミットでモードを切り替えられなくならないように)。

```tsx
      {/* ヘッダー: 戻る・主ラベル・ブランチ・状態チップ・操作メニュー。
          safe area の余白は外側の header に付け、行の高さ (56px) と分ける */}
      <header className="shrink-0 bg-background safe-area-top">
        <div className="flex h-14 items-center gap-1 pl-1.5 pr-2">
          <Button
            variant="ghost"
            size="icon"
            className="size-10 shrink-0 rounded-sm"
            onClick={onBack}
            aria-label="一覧へ戻る"
          >
            <ChevronLeft className="size-[22px]" />
          </Button>
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="min-w-0 truncate text-[17px] font-semibold tracking-[-0.01em]">
              {headerLabels.primary}
            </span>
            <span className="min-w-0 max-w-[40%] shrink-0 truncate text-[13px] text-muted-foreground">
              {headerLabels.branch}
            </span>
          </div>
          <StatusChip statusKey={resolveStatusKey(true, bridgeStatus)} />
          <MobileSessionViewModeToggle
            value={viewMode}
            onChange={handleViewModeChange}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-10 shrink-0 rounded-sm"
                aria-label="セッションの操作"
              >
                <Ellipsis className="size-[22px]" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                メッセージショートカット
              </DropdownMenuLabel>
              {messageShortcuts.map(shortcut => (
                <DropdownMenuItem
                  key={shortcut.id}
                  onSelect={() => onSendMessage(shortcut.message)}
                  title={shortcut.message.slice(0, 200)}
                >
                  <MessageSquareQuote className="mr-2 size-4" />
                  <span className="truncate">
                    {previewOf(shortcut.message)}
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem onSelect={() => setShowShortcutManager(true)}>
                <Settings className="mr-2 size-4" />
                ショートカットを管理...
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {notificationsSupported && onNotificationsEnabledChange && (
                <>
                  <DropdownMenuItem
                    onSelect={() =>
                      onNotificationsEnabledChange(!notificationsEnabled)
                    }
                  >
                    {notificationsEnabled ? (
                      <BellOff className="mr-2 size-4" />
                    ) : (
                      <Bell className="mr-2 size-4" />
                    )}
                    {notificationMenuLabel(notificationsEnabled)}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              {onCopyBuffer && (
                <DropdownMenuItem onSelect={handleCopyBuffer}>
                  <Copy className="mr-2 size-4" />
                  端末のバッファをコピー
                </DropdownMenuItem>
              )}
              {onUploadFile && (
                <DropdownMenuItem onSelect={handlePasteButtonClick}>
                  <ImageIcon className="mr-2 size-4" />
                  画像を貼り付け
                </DropdownMenuItem>
              )}
              {onUploadFile && (
                <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
                  <FileIcon className="mr-2 size-4" />
                  ファイルを添付
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={handleReloadIframe}>
                <RefreshCw className="mr-2 size-4" />
                端末を再読み込み
              </DropdownMenuItem>
              {onRestartSession && (
                <DropdownMenuItem onSelect={() => setShowRestartDialog(true)}>
                  <RotateCw className="mr-2 size-4" />
                  セッションを再起動
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              {slashCommands.map(({ label, cmd }) => (
                <DropdownMenuItem
                  key={cmd}
                  onSelect={() => onSendMessage(cmd)}
                  className="text-xs"
                >
                  {label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => setShowDeleteDialog(true)}
              >
                <Trash2 className="mr-2 size-4" />
                セッションを削除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
```

削除確認ダイアログの説明文 (839-843行目) の三項演算子を、PC と同じ関数に置き換える。

```tsx
            <AlertDialogDescription>
              {deleteSessionDescription(worktree)}
            </AlertDialogDescription>
```

- [ ] **Step 11: `MobileLayout` から主ラベルと通知の設定を渡す**

`packages/web/src/components/MobileLayout.tsx`:

import に次を足す (`import type { DiagramOpenRequest } from "@/lib/mobile-session-view-mode";` の直後)。

```tsx
import { getBaseName } from "@/utils/pathUtils";
import { findRepoForSession } from "@/utils/sessionUtils";
```

`MobileLayoutProps` の `worktreeDisplayNames` と、その分割代入・`Dashboard.tsx` からの受け渡しは Task 6 が足している。
`grep -n worktreeDisplayNames packages/web/src/components/MobileLayout.tsx packages/web/src/pages/Dashboard.tsx` で、props (`worktreeDisplayNames: Map<string, string>;`)・分割代入・Dashboard の受け渡しがあることを確かめる (無ければ Task 6 の漏れなので、Task 6 の該当ステップのとおりに足す)。

Task 6 が props と一覧のブロックを先に書き換えるので、以下は行番号ではなく引用したコードを目印にする。

詳細画面の map の中で、次の `const isActive` の直後に足す。

```tsx
          const isActive =
            activeTab === "session" &&
            effectiveSessionSubView === "detail" &&
            selectedSessionId === sessionId;
```

足すコード:

```tsx
          const worktree = getWorktreeForSession(session);
          // 主ラベルに使うリポジトリ名。PC の上部バー (Dashboard) とサイドバー
          // (useGroupedWorktreeItems) と同じ順 (session.repoPath → worktree のパス →
          // 兄弟ディレクトリの推定) で決める
          const repoPathOfSession =
            session.repoPath ??
            (worktree
              ? repoList.find(repo => worktree.path.startsWith(repo))
              : undefined) ??
            findRepoForSession(session, repoList);
```

続けて、`<MobileSessionView` から、その閉じの `/>` までを次に置き換える。外側の `<div key={sessionId} className={…}>` は Task 6 の担当なので触らない。

```tsx
              <MobileSessionView
                socket={socket}
                isActive={isActive}
                bridgeStatus={sessionStatuses.get(sessionId)}
                awaitingText={sessionAwaitingTexts.get(sessionId)}
                session={session}
                worktree={worktree}
                repoName={
                  repoPathOfSession ? getBaseName(repoPathOfSession) : undefined
                }
                displayName={
                  worktreeDisplayNames.get(
                    worktree?.path ?? session.worktreePath
                  ) ?? null
                }
                notificationsSupported={notificationsSupported}
                notificationsEnabled={
                  isSessionNotificationEnabled?.(sessionId) ?? true
                }
                onNotificationsEnabledChange={
                  onSessionNotificationEnabledChange
                    ? enabled =>
                        onSessionNotificationEnabledChange(sessionId, enabled)
                    : undefined
                }
                onBack={handleBack}
                onSendMessage={message => onSendMessage(sessionId, message)}
                onSendKey={key => onSendKey(sessionId, key)}
                onDeleteSession={() => onDeleteSession(sessionId, worktree)}
                onRestartSession={
                  onRestartSession
                    ? () => onRestartSession(sessionId)
                    : undefined
                }
                onUploadFile={
                  onUploadFile
                    ? data => onUploadFile({ sessionId, ...data })
                    : undefined
                }
                onCopyBuffer={
                  onCopyBuffer ? () => onCopyBuffer(sessionId) : undefined
                }
                tabs={getTabsForSession(sessionId)}
                activeTabIndex={getActiveTabForSession(sessionId)}
                diagramOpenRequest={diagramOpenRequest}
                onTabSelect={idx => handleTabSelect(sessionId, idx)}
                onTabClose={idx => handleTabClose(sessionId, idx)}
                isConnected={isSocketConnected}
                diagramCommentsUpdate={diagramCommentsUpdate}
                listDiagrams={listDiagrams}
                deleteDiagram={deleteDiagram}
                getDiagramComments={getDiagramComments}
                createDiagramComment={createDiagramComment}
                replyDiagramComment={replyDiagramComment}
                resolveDiagramComment={resolveDiagramComment}
                deleteDiagramComment={deleteDiagramComment}
                sendDiagramComment={sendDiagramComment}
                onSelectDiagram={(relPath, worktreePath) =>
                  openDiagramTab(sessionId, worktreePath, relPath)
                }
                messageShortcuts={messageShortcuts}
                onCreateShortcut={onCreateShortcut}
                onUpdateShortcut={onUpdateShortcut}
                onDeleteShortcut={onDeleteShortcut}
              />
```

- [ ] **Step 12: テストが通ることを確かめる**

Run: `pnpm vitest run packages/web/src/components/MobileSessionView.test.tsx packages/web/src/pages/Dashboard.test.tsx`
Expected: PASS (`MobileSessionView のヘッダー` の2件を含む)

- [ ] **Step 13: 型を確かめてコミット**

```bash
pnpm biome check --write packages/web/src/components/MobileSessionView.tsx packages/web/src/components/MobileSessionView.test.tsx packages/web/src/components/MobileLayout.tsx
pnpm check
```

Expected: エラー無し

```bash
git branch --show-current   # feat/visual-redesign-paper であること
git add packages/web/src/components/MobileSessionView.tsx packages/web/src/components/MobileSessionView.test.tsx packages/web/src/components/MobileLayout.tsx
git commit -m "feat(web): モバイル会話のヘッダーを主ラベルと状態チップにする

戻る・主ラベル (表示名かリポジトリ名)・ブランチ・状態チップ・… の1行にする。
session.status の点と等幅のブランチ名をやめ、状態は BridgeSessionStatus に統一する。
Ops メニュー・メッセージショートカット・通知オン・オフ・削除は … にまとめ、
削除は最下段の赤い項目にする (確認ダイアログは今のまま)。"
```

- [ ] **Step 14: 状態の帯のテストを書く**

`packages/web/src/components/MobileSessionView.test.tsx` の `../lib/mobile-session-view-mode` からの import に `STORAGE_KEY_MOBILE_VIEW` を足す (Step 6 で足さないのは、Step 13 の `biome check --write` が未使用の import を消すため)。

```tsx
import {
  createDiagramOpenRequest,
  getViewModeForDiagramOpenRequest,
  getViewModeForViewerTab,
  normalizeMobileSessionViewMode,
  STORAGE_KEY_MOBILE_VIEW,
  writeSavedViewMode,
} from "../lib/mobile-session-view-mode";
```

同じファイルの末尾に次を足す。

```tsx
function stripText(scope: ParentNode): string | null | undefined {
  return scope.querySelector(
    '[data-testid="mobile-status-strip"] [role="status"]'
  )?.textContent;
}

describe("MobileSessionView の状態の帯", () => {
  it("入力待ちでは帯を出さない", () => {
    const container = mount(
      <MobileSessionView {...makeProps({ bridgeStatus: "IDLE" })} />
    );
    expect(
      container.querySelector('[data-testid="mobile-status-strip"]')
    ).toBeNull();
  });

  it("考え中は「考えています」を出す", () => {
    const container = mount(
      <MobileSessionView {...makeProps({ bridgeStatus: "THINK" })} />
    );
    expect(stripText(container)).toBe("考えています");
  });

  it("サーバーと切断中はほかの状態より優先する", () => {
    const container = mount(
      <MobileSessionView
        {...makeProps({ bridgeStatus: "TOOL", isConnected: false })}
      />
    );
    expect(stripText(container)).toBe("サーバーとつながっていません");
  });

  it("会話モードで質問カードが出ていれば「質問があります」にし、ボタンは付けない", () => {
    const container = mount(
      <MobileSessionView {...makeProps({ bridgeStatus: "AWAITING" })} />
    );
    expect(stripText(container)).toBe("確認を求めています");

    act(() => latestChatProps().onActiveAuqChange?.(true));

    expect(stripText(container)).toBe("質問があります");
    expect(
      container.querySelector('[data-testid="mobile-status-strip"] button')
    ).toBeNull();
  });

  it("端末モードで確認を求められたら「会話で答える」で会話モードへ切り替える", () => {
    localStorage.setItem(STORAGE_KEY_MOBILE_VIEW, "terminal");
    const container = mount(
      <MobileSessionView {...makeProps({ bridgeStatus: "AWAITING" })} />
    );
    expect(latestChatProps().isActive).toBe(false);

    const button = Array.from(
      container.querySelectorAll('[data-testid="mobile-status-strip"] button')
    ).find(b => b.textContent?.includes("会話で答える"));
    click(button);

    expect(latestChatProps().isActive).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY_MOBILE_VIEW)).toBe("chat");
    expect(
      container.querySelector('[data-testid="mobile-status-strip"] button')
    ).toBeNull();
  });
});
```

- [ ] **Step 15: テストが落ちることを確かめる**

Run: `pnpm vitest run packages/web/src/components/MobileSessionView.test.tsx`
Expected: FAIL (`MobileSessionView の状態の帯` のうち「入力待ちでは帯を出さない」以外の4件。帯が無いので `stripText` が `undefined` になる。最後の1件は「会話で答える」のボタンが無く、`click` の `expected undefined to be defined` で落ちる)

- [ ] **Step 16: 質問カードの有無を受け取る state を足す**

`packages/web/src/components/MobileSessionView.tsx` の import を次のように変える。

- `lucide-react` の import に `ChevronRight` `CircleAlert` `CircleHelp` を足す
- `import { resolveStatusKey } from "@/lib/status-tone";` を次に置き換える

```tsx
import {
  resolveStatusKey,
  resolveStatusStrip,
  type StatusTone,
  TONE_CLASSES,
} from "@/lib/status-tone";
import { cn } from "@/lib/utils";
```

`const [showShortcutManager, setShowShortcutManager] = useState(false);` (215行目) の直後に次を足す。

```tsx
  // 質問カード (AskUserQuestion) の表示有無。SplitChatPane から受け取り、状態の帯の文言に使う。
  // 会話モード以外では JSONL の購読が止まり、カードを閉じる判定が遅れて true が残ることがある。
  // 帯は AWAITING のときだけこの値を見る (resolveStatusStrip) ので、確認が済めば帯は消える。
  // この値だけで帯を出す形に書き換えないこと
  const [hasActiveAuq, setHasActiveAuq] = useState(false);
  const statusStrip = resolveStatusStrip({
    bridgeStatus,
    hasActiveAuq,
    isConnected,
    viewMode,
  });
```

- [ ] **Step 17: 帯を描き、会話ビューから質問カードの有無を受け取る**

同じファイルで、Step 10 で置き換えた `</header>` の直後に次を足す。

```tsx
      {/* 状態の帯 (32px)。文言は状態と質問カードの有無だけから作り、端末の画面は解釈しない。
          会話モードでは質問カードと AwaitingPad が入力欄の上に出ているので、ボタンを付けない */}
      {statusStrip && (
        <div className="shrink-0 px-3 pb-2">
          <div
            data-testid="mobile-status-strip"
            className={cn(
              "flex h-8 items-center gap-2 rounded-sm px-3 text-[13px] font-semibold text-foreground",
              TONE_CLASSES[statusStrip.tone].softBg
            )}
          >
            <StatusStripIcon tone={statusStrip.tone} />
            <span role="status" className="min-w-0 flex-1 truncate">
              {statusStrip.text}
            </span>
            {statusStrip.offerChat && (
              <button
                type="button"
                onClick={() => handleViewModeChange("chat")}
                className="flex h-8 shrink-0 items-center gap-0.5 text-[13px] font-semibold text-foreground"
              >
                会話で答える
                <ChevronRight
                  className={cn(
                    "size-3.5",
                    TONE_CLASSES[statusStrip.tone].text
                  )}
                  aria-hidden="true"
                />
              </button>
            )}
          </div>
        </div>
      )}
```

ボタンの文字色は `text-foreground` にし、トーンの色はアイコンだけに付ける (設計書 4 節「ライトの琥珀の扱い」)。

会話モードの `<SplitChatPane … />` (538-547行目) の `onUploadFile={onUploadFile}` の直後に次を足す。

```tsx
          onActiveAuqChange={setHasActiveAuq}
```

ファイルの末尾 (`export function MobileSessionView` の閉じ括弧の後ろ) に次を足す。

```tsx
/** 状態の帯の先頭のアイコン。帯の文言と同じく、トーンだけから決める */
function StatusStripIcon({ tone }: { tone: StatusTone }) {
  if (tone === "busy") {
    return (
      <span
        className={cn("status-dots", TONE_CLASSES.busy.text)}
        aria-hidden="true"
      >
        <span />
        <span />
        <span />
      </span>
    );
  }
  const className = cn("size-4 shrink-0", TONE_CLASSES[tone].text);
  if (tone === "awaiting") {
    return <CircleHelp className={className} aria-hidden="true" />;
  }
  return <CircleAlert className={className} aria-hidden="true" />;
}
```

`resolveStatusStrip` が返すトーンは `awaiting` `busy` `error` の3つだけ (切断中は `error`)。

- [ ] **Step 18: テストが通ることを確かめてコミット**

Run: `pnpm vitest run packages/web/src/components/MobileSessionView.test.tsx`
Expected: PASS (`MobileSessionView の状態の帯` の5件を含む)

```bash
pnpm biome check --write packages/web/src/components/MobileSessionView.tsx packages/web/src/components/MobileSessionView.test.tsx
pnpm check   # エラー無し
git branch --show-current   # feat/visual-redesign-paper であること
git add packages/web/src/components/MobileSessionView.tsx packages/web/src/components/MobileSessionView.test.tsx
git commit -m "feat(web): モバイル会話のヘッダーの下に状態の帯を出す

確認待ち・作業中・問題・サーバーとの切断を32pxの帯で知らせる。切断中はほかより優先する。
端末と図のモードで確認を求められたときは「会話で答える」で会話モードへ戻す。
質問カードの有無は SplitChatPane の onActiveAuqChange で受け取る。"
```

- [ ] **Step 19: 下部バーのテストを書く**

`packages/web/src/components/MobileSessionView.test.tsx` の末尾に次を足す。
3モードの本文はマウントしたまま切り替えるので、セグメントはDOMに3つある。問い合わせは各モードの容器の中に絞る。

```tsx
describe("MobileSessionView の下部バー", () => {
  it("会話モードは SplitChatPane のガラスバーの上段にセグメントを渡し、ヘッダーには置かない", () => {
    const container = mount(<MobileSessionView {...makeProps()} />);

    expect(
      container.querySelector('header button[aria-label="会話"]')
    ).toBeNull();
    expect(latestChatProps().layout).toBe("mobile");
    const chat = container.querySelector('[data-testid="mobile-view-chat"]');
    expect(
      chat
        ?.querySelector('[data-testid="chat-pane"] button[aria-label="会話"]')
        ?.getAttribute("aria-pressed")
    ).toBe("true");
  });

  it("セグメントでモードを切り替えると保存し、端末の本文を出す", () => {
    const container = mount(<MobileSessionView {...makeProps()} />);
    const chat = container.querySelector('[data-testid="mobile-view-chat"]');

    click(chat?.querySelector('button[aria-label="端末"]'));

    expect(localStorage.getItem(STORAGE_KEY_MOBILE_VIEW)).toBe("terminal");
    expect(
      container.querySelector('[data-testid="mobile-view-terminal"]')
        ?.className
    ).not.toContain("hidden");
    expect(
      container.querySelector('[data-testid="mobile-view-chat"]')?.className
    ).toBe("hidden");
  });

  it("端末モードは不透明なバーにセグメント・Quick Keys・入力欄を置き、空のまま送るとEnterを送る", () => {
    localStorage.setItem(STORAGE_KEY_MOBILE_VIEW, "terminal");
    const onSendMessage = vi.fn();
    const container = mount(
      <MobileSessionView {...makeProps({ onSendMessage })} />
    );
    const bar = container.querySelector('[data-testid="mobile-terminal-bar"]');

    expect(bar?.hasAttribute("data-mobile-bottom-bar")).toBe(true);
    expect(bar?.className).not.toContain("glass-bar");
    expect(
      bar
        ?.querySelector('button[aria-label="端末"]')
        ?.getAttribute("aria-pressed")
    ).toBe("true");
    expect(bar?.textContent).toContain("Ctrl+C");
    expect(bar?.querySelector("input")?.className).not.toContain("font-mono");

    // jsdom は submit ボタンの click で form の submit イベントを発火する (React の onSubmit が受ける)
    click(bar?.querySelector('button[aria-label="送信"]'));
    expect(onSendMessage).toHaveBeenCalledWith("");
  });

  it("端末の背景は ttyd と同じ暖色の暗色にする", () => {
    localStorage.setItem(STORAGE_KEY_MOBILE_VIEW, "terminal");
    const container = mount(<MobileSessionView {...makeProps()} />);

    expect(
      container.querySelector("iframe")?.parentElement?.style.backgroundColor
    ).toBe("rgb(28, 26, 23)");
  });

  it("図モードはセグメントだけのバーを図の下に置く", () => {
    localStorage.setItem(STORAGE_KEY_MOBILE_VIEW, "board");
    const container = mount(<MobileSessionView {...makeProps()} />);
    const board = container.querySelector('[data-testid="mobile-view-board"]');
    const bar = board?.querySelector('[data-testid="mobile-board-bar"]');

    expect(bar?.hasAttribute("data-mobile-bottom-bar")).toBe(true);
    expect(bar?.querySelectorAll("button")).toHaveLength(3);
    expect(
      bar
        ?.querySelector('button[aria-label="図"]')
        ?.getAttribute("aria-pressed")
    ).toBe("true");
    expect(board?.lastElementChild).toBe(bar);
  });
});
```

- [ ] **Step 20: テストが落ちることを確かめる**

Run: `pnpm vitest run packages/web/src/components/MobileSessionView.test.tsx`
Expected: FAIL (`MobileSessionView の下部バー` の5件。1件目はヘッダーにセグメントが残っていて `expected <button …> to be null`、端末の背景は `expected '' to be 'rgb(28, 26, 23)'`、ほかの3件は容器の `data-testid` が無くて落ちる)

- [ ] **Step 21: セグメントの要素を1つ作り、ヘッダーから外す**

`SegmentedControl` (Task 7) は PC の上部バー向けに中身の幅で並ぶ (`inline-flex`、ボタンは高さ28px)。
モバイルの下部バーでは参照モック `A-mobile-chat.html` の `.segment` と同じく幅いっぱいに3等分し、押しやすい高さ34pxにする。
`SegmentedControl` 側は変えず、`className` の任意バリアント (`[&_button]:…`) で子のボタンに効かせる。

`packages/web/src/components/MobileSessionView.tsx` のヘッダーで、Step 10 で残した次の4行を消す。

```tsx
          <MobileSessionViewModeToggle
            value={viewMode}
            onChange={handleViewModeChange}
          />
```

Step 16 で足した `const statusStrip = …;` の直後に次を足す。

```tsx
  // 下部バーの上段に置く「会話 / 端末 / 図」。3モードの本文はマウントしたまま
  // display で切り替えるので、同じ要素を各モードのバーに置く (表示されるのは1つだけ)
  const viewModeSegment = (
    <MobileSessionViewModeToggle
      value={viewMode}
      onChange={handleViewModeChange}
      className="w-full [&_button]:h-[34px] [&_button]:flex-1 [&_button]:justify-center"
    />
  );
```

- [ ] **Step 22: 会話モードの本文を置き換える**

`{/* 会話モード（既定）: JSONL チャットビュー。…` のコメントから、会話モードの `</div>` まで (531-548行目。Step 17 で `onActiveAuqChange` を足した後の範囲) を、次に置き換える。

```tsx
      {/* 会話モード (既定): JSONL チャットビュー。入力欄はセグメントと一体の浮かぶガラスバーで、
          本文はバーの下を通る (位置と本文の余白は SplitChatPane の layout="mobile" が持つ)。
          ttyd を持たないため display:none で残置しても再接続コストはない。 */}
      <div
        data-testid="mobile-view-chat"
        className={
          viewMode === "chat" ? "flex-1 flex flex-col min-h-0" : "hidden"
        }
      >
        <SplitChatPane
          socket={socket}
          session={session}
          isActive={isActive && viewMode === "chat"}
          bridgeStatus={bridgeStatus}
          awaitingText={awaitingText}
          onSendMessage={onSendMessage}
          onSendKey={onSendKey}
          onUploadFile={onUploadFile}
          onActiveAuqChange={setHasActiveAuq}
          layout="mobile"
          composerAccessory={viewModeSegment}
        />
      </div>
```

- [ ] **Step 23: 端末モードの容器と背景を直す**

`@ark/shared` の import を、値の `TERMINAL_BG` を含む形に置き換える。

```tsx
import {
  type BridgeSessionStatus,
  type ClientToServerEvents,
  type ManagedSession,
  type MessageShortcut,
  type ServerToClientEvents,
  type SpecialKey,
  TERMINAL_BG,
  type Worktree,
} from "@ark/shared";
```

端末モードの容器 (552-556行目) を次に置き換える。

```tsx
      <div
        data-testid="mobile-view-terminal"
        className={
          viewMode === "terminal" ? "flex-1 flex flex-col min-h-0" : "hidden"
        }
      >
```

ttyd の iframe を包む `div` (566-572行目) を次に置き換える。

```tsx
        <div
          className="flex-1 min-h-0 overflow-hidden relative"
          style={{
            display:
              tabs[activeTabIndex]?.type === "terminal" ? undefined : "none",
            backgroundColor: TERMINAL_BG,
          }}
        >
```

- [ ] **Step 24: 端末モードの Quick Keys と入力バーを、不透明な下部バーに置き換える**

import に次を足す (`import { cn } from "@/lib/utils";` の直前)。下部バーの下端からの距離は、会話モードのガラスバー (Task 9) と同じ値を使う。

```tsx
import { FLOATING_BAR_BOTTOM } from "@/lib/floating-composer";
```

`{/* Quick Keys: ↑/↓/Esc/Ctrl+C/S-Tab 常時表示 */}` から、入力バーの `</form>` まで (713-787行目) を、次に置き換える。
Quick Keys のボタンと入力欄の送信の仕組み (`handleSubmit` が空文字でも送る = Enter) は今のまま。
入力欄の `font-mono` と `bg-input`、送信ボタンの `glow-green` を外す。

```tsx
        {/* 端末モードの下部バー。ガラスをやめて不透明にし、端末に重ねない
            (ttyd は iframe の大きさに合わせて描くので、端末の領域はバーの上端までにする)。
            上段にセグメント、下段に Quick Keys と入力欄 */}
        <div
          data-testid="mobile-terminal-bar"
          data-mobile-bottom-bar=""
          className="shrink-0 border-t border-border bg-card px-3 pt-2"
          style={{ paddingBottom: FLOATING_BAR_BOTTOM }}
        >
          {viewModeSegment}

          {/* Quick Keys: ↑/↓/Esc/Ctrl+C/S-Tab 常時表示 */}
          <div className="mt-1 flex items-center gap-1 overflow-x-auto select-none">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-3 text-xs shrink-0"
              onClick={() => onSendKey("Up")}
            >
              ↑
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-3 text-xs shrink-0"
              onClick={() => onSendKey("Down")}
            >
              ↓
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-3 text-xs shrink-0"
              onClick={() => onSendKey("Escape")}
            >
              Esc
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-3 text-xs text-destructive hover:text-destructive shrink-0"
              onClick={() => onSendKey("C-c")}
            >
              Ctrl+C
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-3 text-xs shrink-0"
              onClick={() => onSendKey("S-Tab")}
            >
              S-Tab
            </Button>
          </div>

          {/* 入力欄: 空のまま送るとEnterを送る (handleSubmit) */}
          <form onSubmit={handleSubmit} className="mt-1 flex items-center gap-2">
            <Input
              ref={inputRef}
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              enterKeyHint="send"
              placeholder="メッセージを入力... (Enter送信)"
              className="h-11 flex-1 rounded-full bg-background px-4 text-sm"
            />
            <Button
              type="submit"
              size="icon"
              aria-label="送信"
              className="size-11 shrink-0 rounded-full"
            >
              <Send className="size-5" />
            </Button>
          </form>
        </div>
```

- [ ] **Step 25: 図モードの本文の下に、セグメントだけのバーを置く**

`{/* 図モード: DiagramPane は他モードでもマウントしたまま hidden で切り替える。…` から、図モードの `</div>` まで (790-814行目) を、次に置き換える。

```tsx
      {/* 図モード: DiagramPane は他モードでもマウントしたまま hidden で切り替える。
          MessageChannel port と iframe の接続をモード切替で張り直さない。 */}
      <div
        data-testid="mobile-view-board"
        className={
          viewMode === "board" ? "flex-1 flex flex-col min-h-0" : "hidden"
        }
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <DiagramPane
            socket={socket}
            isConnected={isConnected}
            diagramCommentsUpdate={diagramCommentsUpdate}
            listDiagrams={listDiagrams}
            deleteDiagram={deleteDiagram}
            getDiagramComments={getDiagramComments}
            createDiagramComment={createDiagramComment}
            replyDiagramComment={replyDiagramComment}
            resolveDiagramComment={resolveDiagramComment}
            deleteDiagramComment={deleteDiagramComment}
            sendDiagramComment={sendDiagramComment}
            sessionId={session.id}
            worktreePath={session.worktreePath}
            relPath={tabs.find(tab => tab.type === "diagram")?.relPath}
            onSelectDiagram={onSelectDiagram}
          />
        </div>
        {/* 図モードの下部バーはセグメントだけ。図の iframe は中に下端固定の UI
            (diagram-harness.ts の .ark-harness-toolbar、コメント層の解決済みトグル) を持つので、
            ガラスを重ねずに図の領域をバーの上端までにする */}
        <div
          data-testid="mobile-board-bar"
          data-mobile-bottom-bar=""
          className="shrink-0 bg-background px-3 pt-2"
          style={{ paddingBottom: FLOATING_BAR_BOTTOM }}
        >
          {viewModeSegment}
        </div>
      </div>
```

- [ ] **Step 26: テストが通ることを確かめる**

Run: `pnpm vitest run packages/web/src/components/MobileSessionView.test.tsx`
Expected: PASS (`mobile session view mode` 8件、`MobileSessionView のヘッダー` 2件、`MobileSessionView の状態の帯` 5件、`MobileSessionView の下部バー` 5件)

- [ ] **Step 27: 禁止クラスが残っていないことを確かめる**

```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper/packages/web/src
grep -nE 'status-indicator|glow-green|font-mono|bg-\[#|bg-sidebar|bg-input|💬|🖥|📐' components/MobileSessionView.tsx components/MobileSessionViewModeToggle.tsx
cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper
```

Expected: 何も出ない (終了コード 1)

- [ ] **Step 28: 整形・型・lint と関連テストを通してコミット**

```bash
pnpm biome check --write packages/web/src/components/MobileSessionView.tsx packages/web/src/components/MobileSessionView.test.tsx
pnpm check
pnpm vitest run packages/web/src/components/MobileSessionView.test.tsx packages/web/src/pages/Dashboard.test.tsx packages/web/src/lib/status-tone.test.ts packages/web/src/lib/session-header.test.ts packages/web/src/components/StatusChip.test.tsx packages/web/src/components/SegmentedControl.test.tsx
```

Expected: `pnpm check` はエラー無し。テストはすべて PASS。`git status --short` に `MobileSessionView.tsx` と `MobileSessionView.test.tsx` 以外が出ていないこと

```bash
git branch --show-current   # feat/visual-redesign-paper であること
git add packages/web/src/components/MobileSessionView.tsx packages/web/src/components/MobileSessionView.test.tsx
git commit -m "feat(web): モバイル会話の下部バーを「セグメント + 入力部」にする

会話モードはセグメントを SplitChatPane の浮かぶガラスバーに載せる。
端末モードは不透明なバーにして端末に重ねず、Quick Keys と入力欄 (空送信でEnter) は今のまま使う。
図モードはセグメントだけのバーを図の下に置く (図の中に下端固定のツールバーがあるので重ねない)。
端末の背景を ttyd と同じ TERMINAL_BG にし、glow-green と等幅の入力欄をやめる。"
```

- [ ] **Step 29: 使われなくなった `MessageShortcutMenu` コンポーネントを消す**

Task 7 (PCの `…`) と Task 10 (モバイルの `…`) で、`MessageShortcutMenu` コンポーネントを描く箇所は無くなり、`previewOf` だけが使われる。

Run: `grep -rn "MessageShortcutMenu\b" packages/web/src --include='*.tsx' --include='*.ts' | grep -v "components/MessageShortcutMenu.tsx"`
Expected: `import { previewOf } from "./MessageShortcutMenu"` のような `previewOf` の import だけが出る (`<MessageShortcutMenu` を描く行が無い)

`packages/web/src/components/MessageShortcutMenu.tsx` から、`export function MessageShortcutMenu(…) { … }` の関数全体と、その関数だけが使っていた import (`DropdownMenu*`・lucide のアイコン・`Button` など) を消す。`previewOf` とその JSDoc は残す。

```bash
pnpm biome check --write packages/web/src/components/MessageShortcutMenu.tsx
pnpm check
pnpm vitest run packages/web/src
git branch --show-current   # feat/visual-redesign-paper であること
git add packages/web/src/components/MessageShortcutMenu.tsx
git commit -m "refactor(web): 使われなくなった MessageShortcutMenu コンポーネントを消す

ショートカットは PC とモバイルの … メニューから送るようになった。
本文の1行表示に使う previewOf だけを残す。"
```

Expected: `pnpm check` はエラー無し。テストはすべて PASS

---

### Task 11: 残りの画面の色とアイコン

**Files:**
- Create: `packages/web/src/components/RepoGridView.test.tsx`
- Modify: `packages/web/src/components/RepoGridView.tsx` (全体。1-21 冒頭コメントと import、96-154 セル、156-244 `STATUS_CONFIG` と `StatusBadge` を削除)
- Modify: `packages/web/src/components/RepoSelectDialog.tsx:227,254` (`glow-green`)
- Modify: `packages/web/src/components/FolderBrowserDialog.tsx:232,251-256` (`glow-green`)
- Modify: `packages/web/src/components/CreateWorktreeDialog.tsx:101,112,133` (ブランチ名の `font-mono`、`glow-green`)
- Modify: `packages/web/src/components/ProfileManagerDialog.tsx:217,230-236,301,352,375,404,415-417,431-435`
- Modify: `packages/web/src/components/MessageShortcutManagerDialog.tsx:170,201` (本文の `font-mono`)
- Modify: `packages/web/src/components/AboutDialog.tsx:114` (パッケージ名ボタンの `font-mono`。Task 5 が「このマシン」の節を足すので、4〜6行下にずれる)
- Modify: `packages/web/src/components/UpdateBanner.tsx:14,68,81-87` (blue、`×`)
- Modify: `packages/web/src/components/FileViewerPane.tsx:70,157,182,204` (`prose-invert`、blue、rgba)
- Modify: `packages/web/src/pages/NotFound.tsx` (全体)
- Modify: `packages/web/src/components/ViewerTabBar.tsx:1,51` (`×`。担当の一覧に無かったが、どのタスクも触らない絵文字相当のアイコンなのでここで直す)
- 確認のみ (変更しない): `packages/web/src/components/HtmlViewerPane.tsx` / `packages/web/src/components/DiagramPane.tsx` / `packages/web/src/components/MermaidBlock.tsx` / `packages/web/src/pages/Dashboard.tsx`
- 削除済みの確認: `packages/web/src/components/RepoProfileMenu.tsx` (Task 5 がファイルごと削除する。プロファイル別の5色 `PROFILE_COLORS` もそこで消える)

**Interfaces:**
- Consumes:
  - Task 1: `bg-primary/*` `text-destructive` `bg-destructive/*` `shadow-card` と、メディアクエリで効く `dark:` variant
  - Task 2: `resolveStatusKey(hasSession, bridgeStatus)` (`resolveStatusKey(true, undefined)` は `"UNKNOWN"`)、`StatusChip` (外側の要素に `data-status={statusKey}` を持ち、文言を textContent に出す。`UNKNOWN` は文言なしの `aria-hidden` の印)
- Produces:
  - 新しい部品は無い。`RepoGridView` の props は変えない

- [ ] **Step 1: 前提を確かめる**

```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper
git branch --show-current
grep -n 'export function resolveStatusKey' packages/web/src/lib/status-tone.ts
grep -n 'export function StatusChip' packages/web/src/components/StatusChip.tsx
grep -nE -- '--shadow-card|--elevation-card' packages/web/src/index.css
```

Expected: `feat/visual-redesign-paper` と、3つの grep がそれぞれ1行以上出る (最後の grep は `@theme inline` の `--shadow-card: var(--elevation-card);` と、`--elevation-card` の定義の両方)。出なければ Task 1 / 2 が終わっていないので先にそちらを終える

- [ ] **Step 2: RepoGridView の失敗するテストを書く**

`packages/web/src/components/RepoGridView.test.tsx`:

```tsx
// @vitest-environment jsdom

import type {
  BridgeSessionStatus,
  ManagedSession,
  SessionGridSnapshot,
} from "@ark/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepoGridView } from "./RepoGridView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function makeSession(name: string): ManagedSession {
  return {
    id: `id-${name}`,
    worktreeId: `wt-${name}`,
    worktreePath: `/repos/${name}`,
    status: "active",
    createdAt: new Date("2026-09-17T00:00:00Z"),
    tmuxSessionName: `ark-${name}`,
    ttydPort: 7680,
    ttydUrl: `/ttyd/${name}/`,
  };
}

function makeSnapshot(
  session: ManagedSession,
  status: BridgeSessionStatus,
  elapsedMs = 0
): SessionGridSnapshot {
  return {
    sessionId: session.id,
    repoPath: "/repos",
    name: session.worktreePath.split("/").pop() ?? "",
    status,
    previewText: "",
    currentTask: "",
    elapsedMs,
    capturedAt: 0,
  };
}

function render(
  sessions: ManagedSession[],
  snapshots: SessionGridSnapshot[]
): void {
  act(() =>
    root.render(
      <RepoGridView
        repoPath="/repos"
        sessions={sessions}
        worktreeBranchById={new Map()}
        snapshots={new Map(snapshots.map(s => [s.sessionId, s]))}
        onSubscribe={vi.fn()}
        onUnsubscribe={vi.fn()}
        onSelectSession={vi.fn()}
      />
    )
  );
}

/** セッション名を含むセル (button) を返す */
function cellOf(name: string): HTMLButtonElement {
  const cell = Array.from(container.querySelectorAll("button")).find(b =>
    b.textContent?.includes(name)
  );
  if (!cell) throw new Error(`${name} のセルが無い`);
  return cell;
}

describe("RepoGridView", () => {
  it("状態を設計書の対応表の文言でチップに出す", () => {
    const alpha = makeSession("alpha");
    const bravo = makeSession("bravo");
    const charlie = makeSession("charlie");
    const delta = makeSession("delta");
    render(
      [alpha, bravo, charlie, delta],
      [
        makeSnapshot(alpha, "AWAITING"),
        makeSnapshot(bravo, "IDLE"),
        makeSnapshot(charlie, "THINK"),
        makeSnapshot(delta, "ERR"),
      ]
    );

    const labelOf = (name: string) =>
      cellOf(name).querySelector("[data-status]")?.textContent;
    expect(labelOf("alpha")).toBe("確認待ち");
    expect(labelOf("bravo")).toBe("入力待ち");
    expect(labelOf("charlie")).toBe("作業中");
    expect(labelOf("delta")).toBe("問題");
  });

  it("スナップショットが未着のセルは入力待ちと決めつけない", () => {
    const echo = makeSession("echo");
    render([echo], []);

    const cell = cellOf("echo");
    expect(
      cell.querySelector("[data-status]")?.getAttribute("data-status")
    ).toBe("UNKNOWN");
    expect(cell.textContent).not.toContain("入力待ち");
  });

  it("スナップショットの経過時間を出す", () => {
    const alpha = makeSession("alpha");
    render([alpha], [makeSnapshot(alpha, "TOOL", 65_000)]);

    expect(cellOf("alpha").textContent).toContain("1m 5s");
  });

  it("直書きの色クラスを使わない", () => {
    const alpha = makeSession("alpha");
    const bravo = makeSession("bravo");
    render(
      [alpha, bravo],
      [makeSnapshot(alpha, "TOOL"), makeSnapshot(bravo, "AWAITING")]
    );

    expect(container.innerHTML).not.toMatch(
      /-(green|red|orange|neutral)-\d|bg-black\//
    );
  });
});
```

- [ ] **Step 3: テストが落ちることを確かめる**

Run: `pnpm vitest run packages/web/src/components/RepoGridView.test.tsx`

Expected: FAIL が3件、PASS が1件
- 「状態を設計書の対応表の文言でチップに出す」: `expected undefined to be '確認待ち'` (今の `StatusBadge` には `data-status` が無い)
- 「スナップショットが未着のセルは入力待ちと決めつけない」: `expected undefined to be 'UNKNOWN'`
- 「直書きの色クラスを使わない」: `bg-black/40` と `bg-green-500/15` に一致して落ちる
- 「スナップショットの経過時間を出す」: PASS (残す挙動の確認なので、置き換えの前から通る)

- [ ] **Step 4: RepoGridView を状態チップに置き換える**

`packages/web/src/components/RepoGridView.tsx` の全体を次にする。変えたのは、冒頭コメントの状態バッジの行、import、
`SessionCell` の状態の決め方・カードの影・ブランチの `font-mono`・プレビューの背景、`STATUS_CONFIG` と `StatusBadge` の削除だけ。
`formatElapsed` による経過時間の表示と、`(no output)` などの文言はそのまま残す。

```tsx
/**
 * RepoGridView — リポジトリ選択時のセッショングリッド表示
 *
 * 行のメニューの「このリポジトリの全セッションを並べて見る」を選ぶと、その repo 配下の
 * 全セッションをグリッドで一覧する。各セルは:
 *   - 状態チップ (lib/status-tone の対応表。PCサイドバー・モバイル一覧と同じ文言と色)
 *   - ターミナル末尾プレビュー (静的スナップショット、1.5秒間隔で更新)
 *   - セッション名 + 経過時間
 *
 * セルクリックで selectedSessionId を切替えて従来の TerminalPane に潜る。
 *
 * 軽量化のため ttyd iframe は使わず、サーバ側で tmux capture-pane した
 * プレーンテキストを流し込む (= 操作不可、見るだけ)。
 */

import type { ManagedSession, SessionGridSnapshot } from "@ark/shared";
import { useEffect } from "react";
import { resolveStatusKey } from "@/lib/status-tone";
import { StatusChip } from "./StatusChip";

interface RepoGridViewProps {
  /** 表示対象のリポジトリ絶対パス (ヘッダ表示用) */
  repoPath: string;
  /** 表示対象のセッション一覧 (このリポジトリのもの) */
  sessions: ManagedSession[];
  /** Worktree マップ (worktreeId → branch名) */
  worktreeBranchById: Map<string, string>;
  /** サーバから配信中のスナップショット (mount 中だけ購読) */
  snapshots: Map<string, SessionGridSnapshot>;
  /** マウント時に購読、アンマウント時に解除 */
  onSubscribe: () => void;
  onUnsubscribe: () => void;
  /** セルクリックでフルターミナル表示に切替 */
  onSelectSession: (sessionId: string) => void;
}

export function RepoGridView({
  repoPath,
  sessions,
  worktreeBranchById,
  snapshots,
  onSubscribe,
  onUnsubscribe,
  onSelectSession,
}: RepoGridViewProps) {
  // RepoGridView 表示中だけ session:grid:snapshot を購読する
  // (常時購読すると pane polling が二重化するため)
  useEffect(() => {
    onSubscribe();
    return () => onUnsubscribe();
  }, [onSubscribe, onUnsubscribe]);

  const repoName = repoPath.split("/").filter(Boolean).pop() ?? repoPath;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-background/40 flex items-baseline gap-2 shrink-0">
        <h2 className="text-base font-semibold">{repoName}</h2>
        <span className="text-xs text-muted-foreground truncate">
          {repoPath}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {sessions.length} sessions
        </span>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {sessions.length === 0 ? (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
            このリポジトリにはまだセッションがありません
          </div>
        ) : (
          <div className="grid gap-4 grid-cols-1 md:grid-cols-2 2xl:grid-cols-3">
            {sessions.map(session => (
              <SessionCell
                key={session.id}
                session={session}
                branch={worktreeBranchById.get(session.worktreeId)}
                snapshot={snapshots.get(session.id)}
                onClick={() => onSelectSession(session.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// セル
// ─────────────────────────────────────────────────────────────────

function SessionCell({
  session,
  branch,
  snapshot,
  onClick,
}: {
  session: ManagedSession;
  branch: string | undefined;
  snapshot: SessionGridSnapshot | undefined;
  onClick: () => void;
}) {
  // スナップショットが未着のあいだは IDLE と決めつけず、未着 (文言なしの印) として出す
  const statusKey = resolveStatusKey(true, snapshot?.status);
  const elapsed = snapshot
    ? formatElapsed(snapshot.elapsedMs)
    : formatElapsed(Date.now() - new Date(session.createdAt).getTime());
  const name = snapshot?.name ?? deriveName(session.worktreePath);
  const previewText = snapshot?.previewText ?? "";

  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left bg-card border border-border rounded-lg shadow-card overflow-hidden hover:border-primary/60 hover:bg-accent/30 transition-colors flex flex-col h-72"
    >
      {/* ヘッダー行: 名前 / branch / 経過時間 */}
      <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2 shrink-0">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{name}</div>
          {branch ? (
            <div className="text-xs text-muted-foreground truncate">
              {branch}
            </div>
          ) : null}
        </div>
        <div className="text-xs text-muted-foreground tabular-nums shrink-0">
          {elapsed}
        </div>
      </div>

      {/* 状態チップ */}
      <div className="px-3 py-2 border-b border-border shrink-0">
        <StatusChip statusKey={statusKey} />
      </div>

      {/* ターミナルプレビュー */}
      <div className="flex-1 min-h-0 overflow-hidden bg-muted text-foreground/80">
        {previewText ? (
          <pre className="text-[10px] leading-tight font-mono p-2 whitespace-pre overflow-hidden h-full">
            {previewText}
          </pre>
        ) : (
          <div className="h-full flex items-center justify-center text-[10px] text-muted-foreground">
            (no output)
          </div>
        )}
      </div>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────
// 補助
// ─────────────────────────────────────────────────────────────────

function deriveName(worktreePath: string): string {
  return worktreePath.split("/").filter(Boolean).pop() ?? worktreePath;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
```

プレビューの `<pre>` は「直前の画面」と同じく端末の出力をそのまま見せるものなので `font-mono` を残す。

- [ ] **Step 5: テストが通ることを確かめる**

Run: `pnpm vitest run packages/web/src/components/RepoGridView.test.tsx`

Expected: PASS (4件)。props を変えていないことは次の Step の `tsc -b` で確かめる (`Dashboard.tsx` が呼んでいる)

- [ ] **Step 6: 整形して型とlintを通し、コミット**

Run: `pnpm biome check --write packages/web/src/components/RepoGridView.tsx packages/web/src/components/RepoGridView.test.tsx && pnpm check`

Expected: エラー無し

```bash
git branch --show-current
git add packages/web/src/components/RepoGridView.tsx packages/web/src/components/RepoGridView.test.tsx
git commit -m "feat(web): RepoGridView の状態表示を状態チップにそろえる

STATUS_CONFIG の直書き色 (IDLE を赤、AWAITING を橙) をやめ、PCサイドバーと同じ
status-tone の対応表と StatusChip で出す。スナップショットの未着を IDLE と
みなさず、文言なしの印にする。経過時間の表示は残す。"
```

- [ ] **Step 7: リポジトリ選択・フォルダ選択・worktree作成のダイアログから glow-green を外す**

`packages/web/src/components/RepoSelectDialog.tsx:227` (モバイルのフッターの「選択」)

変更前:

```tsx
            className="glow-green h-12"
```

変更後:

```tsx
            className="h-12"
```

`packages/web/src/components/RepoSelectDialog.tsx:254` (PCのフッターの「選択」)

変更前:

```tsx
            className="glow-green h-12 md:h-10"
```

変更後:

```tsx
            className="h-12 md:h-10"
```

`packages/web/src/components/FolderBrowserDialog.tsx:232` (モバイルの「このフォルダを選択」)

変更前:

```tsx
            className="glow-green h-12"
```

変更後:

```tsx
            className="h-12"
```

`packages/web/src/components/FolderBrowserDialog.tsx:251-256` (PCの「このフォルダを選択」)

変更前:

```tsx
          <Button
            type="button"
            onClick={handleConfirm}
            disabled={isConfirmDisabled}
            className="glow-green"
          >
```

変更後:

```tsx
          <Button
            type="button"
            onClick={handleConfirm}
            disabled={isConfirmDisabled}
          >
```

`packages/web/src/components/CreateWorktreeDialog.tsx:101` と `:112` (Branch Name / Base Branch の入力欄。ブランチ名は等幅にしない)

変更前 (2か所とも同じ):

```tsx
              className="font-mono h-12 md:h-10 text-base md:text-sm"
```

変更後 (2か所とも):

```tsx
              className="h-12 md:h-10 text-base md:text-sm"
```

`packages/web/src/components/CreateWorktreeDialog.tsx:133`

変更前:

```tsx
          <Button onClick={handleCreate} className="glow-green h-12 md:h-10">
```

変更後:

```tsx
          <Button onClick={handleCreate} className="h-12 md:h-10">
```

パスの表示と入力の `font-mono` (`RepoSelectDialog.tsx:128,194,216` / `FolderBrowserDialog.tsx:139` / `CreateWorktreeDialog.tsx:119` の Worktree Path) は残す。

- [ ] **Step 8: ProfileManagerDialog の blue / amber / red をトークンにする**

`packages/web/src/components/ProfileManagerDialog.tsx:217` (「Linuxのみ」のバッジ。注意の色ではなく中立のチップにする)

変更前:

```tsx
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/30">
```

変更後:

```tsx
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 font-medium text-foreground">
```

`packages/web/src/components/ProfileManagerDialog.tsx:230-236` (一覧の「新規追加」。既定の variant が `bg-primary` なので className を外す)

変更前:

```tsx
          <Button
            type="button"
            size="sm"
            onClick={onAdd}
            className="bg-blue-600 hover:bg-blue-500 text-white"
          >
```

変更後:

```tsx
          <Button type="button" size="sm" onClick={onAdd}>
```

`packages/web/src/components/ProfileManagerDialog.tsx:301` (行の削除ボタン)

変更前:

```tsx
            className="p-1.5 text-muted-foreground hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
```

変更後:

```tsx
            className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded transition-colors"
```

`packages/web/src/components/ProfileManagerDialog.tsx:352` (追加・編集の見出しのアイコン)

変更前:

```tsx
          <UsersRound className="w-4 h-4 text-blue-400" />
```

変更後:

```tsx
          <UsersRound className="w-4 h-4 text-primary" />
```

`packages/web/src/components/ProfileManagerDialog.tsx:375` (名前の入力欄。`Input` 自身が `focus-visible:border-ring` を持つので上書きを外す)

変更前:

```tsx
            className="bg-background border-border focus-visible:border-blue-500"
```

変更後:

```tsx
            className="bg-background border-border"
```

`packages/web/src/components/ProfileManagerDialog.tsx:404` (設定ディレクトリの入力欄。パスなので `font-mono` は残す)

変更前:

```tsx
            className="bg-background border-border font-mono focus-visible:border-blue-500"
```

変更後:

```tsx
            className="bg-background border-border font-mono"
```

`packages/web/src/components/ProfileManagerDialog.tsx:415-417` (追加時の案内。`text-blue-200/80` はライトで読めない)

変更前:

```tsx
          <div className="bg-blue-500/5 border border-blue-500/20 rounded-md p-3 flex gap-2">
            <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
            <div className="text-xs text-blue-200/80">
```

変更後:

```tsx
          <div className="bg-primary/5 border border-primary/20 rounded-md p-3 flex gap-2">
            <Info className="w-4 h-4 text-primary shrink-0 mt-0.5" />
            <div className="text-xs text-foreground/80">
```

`packages/web/src/components/ProfileManagerDialog.tsx:431-435` (フォームの「追加」「保存」)

変更前:

```tsx
        <Button
          type="submit"
          size="sm"
          className="bg-blue-600 hover:bg-blue-500 text-white"
        >
```

変更後:

```tsx
        <Button type="submit" size="sm">
```

- [ ] **Step 9: メッセージショートカットとAboutの等幅を外す**

`packages/web/src/components/MessageShortcutManagerDialog.tsx:170` (登録済みの本文の欄。送信する本文は自然文で、コードでもパスでもない)

変更前:

```tsx
                    className="min-h-[80px] text-sm font-mono"
```

変更後:

```tsx
                    className="min-h-[80px] text-sm"
```

`packages/web/src/components/MessageShortcutManagerDialog.tsx:201` (新規追加の本文の欄)

変更前:

```tsx
                className="min-h-[80px] text-sm font-mono"
```

変更後:

```tsx
                className="min-h-[80px] text-sm"
```

`packages/web/src/components/AboutDialog.tsx` (「同梱コンポーネント」のパッケージ名。ボタンの中なので等幅にしない。Task 5 でも一覧はそのまま残るが、DialogHeader の直後に「このマシン」の節が入って4〜6行下にずれるので、`grep -n 'font-mono' packages/web/src/components/AboutDialog.tsx` で位置を探す)

変更前:

```tsx
                  <span className="font-mono text-sm">
```

変更後:

```tsx
                  <span className="text-sm">
```

AboutDialog の色は、今の時点で直書きが無い (`border-border` `bg-muted/30` `text-destructive` などのトークンだけ)。Task 5 で足された「このマシン」の節 (`SystemStatusBar`) の色も、Step 18 の grep で確かめる。

- [ ] **Step 10: RepoProfileMenu とプロファイル別の5色が残っていないことを確かめる**

`RepoProfileMenu.tsx` は Task 5 がファイルごと削除し、中身を `SessionRowMenu.tsx` に吸収している (5色のバッジは持たず、選択中のチェックは `text-primary`)。Task 11 ではこのファイルを変えない。

```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper
test ! -e packages/web/src/components/RepoProfileMenu.tsx && echo "削除済み"
grep -rnE 'PROFILE_COLORS|colorFor|badgeLabel' packages/web/src --include='*.ts' --include='*.tsx'
```

Expected: `削除済み` が出て、grep は1行も出ない (終了コード 1)。どちらかが外れたら Task 5 が終わっていないので、Task 5 を終えてから Task 11 に戻る

- [ ] **Step 11: 整形して型とlintを通し、コミット**

Run: `pnpm biome check --write packages/web/src/components/RepoSelectDialog.tsx packages/web/src/components/FolderBrowserDialog.tsx packages/web/src/components/CreateWorktreeDialog.tsx packages/web/src/components/ProfileManagerDialog.tsx packages/web/src/components/MessageShortcutManagerDialog.tsx packages/web/src/components/AboutDialog.tsx && pnpm check`

Expected: エラー無し

```bash
git branch --show-current
git add packages/web/src/components/RepoSelectDialog.tsx packages/web/src/components/FolderBrowserDialog.tsx packages/web/src/components/CreateWorktreeDialog.tsx packages/web/src/components/ProfileManagerDialog.tsx packages/web/src/components/MessageShortcutManagerDialog.tsx packages/web/src/components/AboutDialog.tsx
git commit -m "feat(web): ダイアログの発光と直書き色をトークンにする

glow-green を外し、プロファイル管理の blue / amber / red を primary と
destructive にする。ブランチ名・送信本文・About のパッケージ名の等幅を
やめる。パスの表示と入力は等幅のまま。"
```

- [ ] **Step 12: UpdateBanner の blue と × を直す**

`packages/web/src/components/UpdateBanner.tsx:14`

変更前:

```tsx
import { useEffect, useState } from "react";
```

変更後:

```tsx
import { X } from "lucide-react";
import { useEffect, useState } from "react";
```

`packages/web/src/components/UpdateBanner.tsx:68`

変更前:

```tsx
    <Alert className="m-2 border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950">
```

変更後:

```tsx
    <Alert className="m-2 border-primary/30 bg-primary/10">
```

`packages/web/src/components/UpdateBanner.tsx:81-87`

変更前:

```tsx
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setDismissedVersion(info.latestVersion)}
        >
          ×
        </Button>
```

変更後:

```tsx
        <Button
          size="sm"
          variant="ghost"
          aria-label="閉じる"
          onClick={() => setDismissedVersion(info.latestVersion)}
        >
          <X />
        </Button>
```

`<code>` の `brew upgrade --cask ark` はコマンドなので、ブラウザ既定の等幅のまま残す。

- [ ] **Step 13: FileViewerPane をライトでも読めるようにする**

`packages/web/src/components/FileViewerPane.tsx:70` (Markdown。ライトで白抜き文字にしない)

変更前:

```tsx
    <div className="p-6 prose prose-invert max-w-none prose-headings:text-foreground prose-p:text-foreground prose-li:text-foreground prose-strong:text-foreground prose-code:text-primary prose-a:text-primary">
```

変更後:

```tsx
    <div className="p-6 prose dark:prose-invert max-w-none prose-headings:text-foreground prose-p:text-foreground prose-li:text-foreground prose-strong:text-foreground prose-code:text-primary prose-a:text-primary">
```

`packages/web/src/components/FileViewerPane.tsx:157` (Shiki の対象行の強調。インラインstyleなので CSS 変数で書く)

変更前:

```tsx
      (lineEl as HTMLElement).style.backgroundColor = "rgba(59, 130, 246, 0.2)";
```

変更後:

```tsx
      (lineEl as HTMLElement).style.backgroundColor =
        "color-mix(in oklab, var(--primary) 20%, transparent)";
```

`packages/web/src/components/FileViewerPane.tsx:182` (Shiki 表示の行番号の強調)

変更前:

```tsx
              className={targetLine === i + 1 ? "bg-blue-500/20" : ""}
```

変更後:

```tsx
              className={targetLine === i + 1 ? "bg-primary/20" : ""}
```

`packages/web/src/components/FileViewerPane.tsx:204` (Shiki が使えないときのプレーン表示の行)

変更前:

```tsx
            className={`flex ${targetLine === i + 1 ? "bg-blue-500/20" : ""}`}
```

変更後:

```tsx
            className={`flex ${targetLine === i + 1 ? "bg-primary/20" : ""}`}
```

コードの `font-mono` (`:199`) と Shiki のテーマ `github-dark` (`:138`) は変えない。コードブロックは暗い面のまま両テーマで読める。

- [ ] **Step 14: NotFound をトークンにする**

`packages/web/src/pages/NotFound.tsx` の全体を次にする。ライト前提の slate / blue / red と `bg-white/80` を外し、
点滅 (`animate-pulse`) をやめる。`Card` の既定 (`bg-card` と罫線) をそのまま使い、`shadow-*` は上書きしない。
英語の文言は変えない (用語の言い換えは対象外)。

```tsx
import { AlertCircle, Home } from "lucide-react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function NotFound() {
  const [, setLocation] = useLocation();

  const handleGoHome = () => {
    setLocation("/");
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background">
      <Card className="w-full max-w-lg mx-4">
        <CardContent className="pt-8 pb-8 text-center">
          <div className="flex justify-center mb-6">
            <div className="rounded-full bg-destructive/10 p-4">
              <AlertCircle className="h-16 w-16 text-destructive" />
            </div>
          </div>

          <h1 className="text-4xl font-bold text-foreground mb-2">404</h1>

          <h2 className="text-xl font-semibold text-foreground mb-4">
            Page Not Found
          </h2>

          <p className="text-muted-foreground mb-8 leading-relaxed">
            Sorry, the page you are looking for doesn't exist.
            <br />
            It may have been moved or deleted.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button onClick={handleGoHome} className="px-6">
              <Home className="w-4 h-4 mr-2" />
              Go Home
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 15: ViewerTabBar の × を lucide にする**

`packages/web/src/components/ViewerTabBar.tsx:1`

変更前:

```tsx
import type { ViewerTab } from "./TerminalPane";
```

変更後:

```tsx
import { X } from "lucide-react";
import type { ViewerTab } from "./TerminalPane";
```

`packages/web/src/components/ViewerTabBar.tsx:51`

変更前:

```tsx
                ×
```

変更後:

```tsx
                <X className="h-3 w-3" />
```

閉じるボタンの `aria-label={`Close ${getTabLabel(tab)}`}` はそのまま残す。

- [ ] **Step 16: 変えないファイルを確かめる**

```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper/packages/web/src
grep -n 'bg-white' components/DiagramPane.tsx components/HtmlViewerPane.tsx pages/Dashboard.tsx
grep -n 'font-mono' components/MermaidBlock.tsx components/HtmlViewerPane.tsx pages/Dashboard.tsx
```

Expected (行番号は他のタスクの変更でずれてよい。中身がこの5種類だけならよい):
- `components/DiagramPane.tsx`: `className="block h-full w-full border-0 bg-white"` (iframe。中身が白い文書なので設計書で対象外)
- `components/HtmlViewerPane.tsx`: `className="w-full h-full border-0 bg-white"` (同上)
- `pages/Dashboard.tsx`: `<div className="p-4 bg-white rounded-lg">` (QRコード。ダークでも読み取れるよう白い余白が要る)
- `components/MermaidBlock.tsx`: `ark-mermaid-fallback … font-mono text-sm` (描画前・失敗時に出す生のMermaidコード。コードブロックなので残す)
- `pages/Dashboard.tsx`: Quick Tunnel の URL の `<a>` と Auth Token の `<Input>` の `font-mono` (URLとトークンの表示なので残す)

`HtmlViewerPane.tsx` のツールバーは `bg-muted/30` `text-destructive` `text-muted-foreground` だけでトークン化済み。このステップでは何も変えない。

- [ ] **Step 17: 整形して型とlintを通し、コミット**

Run: `pnpm biome check --write packages/web/src/components/UpdateBanner.tsx packages/web/src/components/FileViewerPane.tsx packages/web/src/pages/NotFound.tsx packages/web/src/components/ViewerTabBar.tsx && pnpm check`

Expected: エラー無し

```bash
git branch --show-current
git add packages/web/src/components/UpdateBanner.tsx packages/web/src/components/FileViewerPane.tsx packages/web/src/pages/NotFound.tsx packages/web/src/components/ViewerTabBar.tsx
git commit -m "feat(web): 更新バナー・ファイルビューア・404を両テーマで読める色にする

UpdateBanner と NotFound のライト前提の blue / slate / red をトークンにし、
FileViewerPane の Markdown は dark のときだけ prose-invert にする。
× の文字のアイコンを lucide の X に置き換える。"
```

- [ ] **Step 18: 禁止クラスが残っていないことを確かめる (全体)**

Task 1〜11 のすべてが終わった状態で、`packages/web/src` 全体に対して実行する。

```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper/packages/web/src
grep -rnE 'glow-green|glow-cyan|status-indicator|terminal-prompt|text-terminal-|bg-terminal-|(text|bg|border)-(green|emerald|lime|red|orange|amber|yellow|blue|violet|slate|gray|neutral|zinc)-[0-9]|bg-\[#' \
  --include='*.ts' --include='*.tsx' --include='*.css' . \
  | grep -vE '(^|/)components/bridge/|(^|/)pages/Bridge\.tsx:|\.test\.'
```

Expected: 何も出ない (終了コード 1)

除外の grep は `./` の有無のどちらの出力でも効くように `(^|/)` で書く (`grep -v '^\./components/bridge/'` だと `components/bridge/…` と出る grep で除外が効かない)。

このパターンに掛からないが、直書きのまま**残してよい**もの:

| 箇所 | 理由 |
|---|---|
| `components/DiagramPane.tsx` / `components/HtmlViewerPane.tsx` の iframe の `bg-white` | 中身が白い文書。設計書で対象外 |
| `pages/Dashboard.tsx` の QR コードの `bg-white` | QRの読み取りに白い余白が要る |
| `components/ui/dialog.tsx` / `ui/alert-dialog.tsx` / `ui/drawer.tsx` の `bg-black/50` と、モーダルの幕の `bg-black/50` | 画面を暗くする幕。テーマに依らず黒でよい |
| `components/ui/button.tsx` の destructive variant の `text-white` | shadcn/ui 標準。`bg-destructive` の上の文字 |
| `components/bridge/**` / `pages/Bridge.tsx` | `/bridge` ページは変更しない |
| `*.test.*` | テストの期待値として禁止クラスの名前を書くため |

- [ ] **Step 19: 補助の確認 (パターン外の色・旧名・絵文字・等幅)**

```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper/packages/web/src
EXCLUDE='(^|/)components/bridge/|(^|/)pages/Bridge\.tsx:|\.test\.'

# 1) 必須パターンに入っていない色名と、16進・rgba の直書き
grep -rnE '(text|bg|border|ring|from|via|to|fill|stroke|outline)-(purple|pink|rose|fuchsia|indigo|sky|cyan|teal|stone)-[0-9]|--color-terminal-|#[0-9a-fA-F]{6}\b|rgba?\(' \
  --include='*.ts' --include='*.tsx' --include='*.css' . | grep -vE "$EXCLUDE"

# 2) 置き換え済みのはずの旧名
grep -rnE 'STATUS_CONFIG|statusToDotColor|fallbackDotColor|PROFILE_COLORS|colorFor|badgeLabel' \
  --include='*.ts' --include='*.tsx' . | grep -vE "$EXCLUDE"

# 3) 絵文字のアイコン (コメント行を除く)
grep -rnP '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}\x{2B00}-\x{2BFF}]' --include='*.tsx' . \
  | grep -vE "$EXCLUDE" | grep -vE '^[^:]+:[0-9]+:\s*(\*|//|/\*|\{/\*)'

# 4) Task 11 の担当ファイルに残る等幅
grep -n 'font-mono' components/RepoGridView.tsx components/RepoSelectDialog.tsx components/FolderBrowserDialog.tsx \
  components/CreateWorktreeDialog.tsx components/ProfileManagerDialog.tsx components/MessageShortcutManagerDialog.tsx \
  components/AboutDialog.tsx components/UpdateBanner.tsx components/FileViewerPane.tsx \
  components/HtmlViewerPane.tsx components/ViewerTabBar.tsx pages/NotFound.tsx
```

Expected:
- 1): 何も出ない (端末の色 `#1c1a17` / `#e6e1da` は `packages/shared/src/types.ts` にあり、`packages/web/src` の外。`.md-prose` の rgba と `#2563eb` / `#60a5fa` は Task 9 でトークン化済み)
- 2): 何も出ない
- 3): 何も出ない。出た行が JSX の中で記号だけをアイコンとして表示しているなら直す。文字列の判定や正規表現の中の記号 (例: `/[✢✻◼◻]/`) はアイコンではないので残してよい
- 4): 次の9行だけ (どれもパスかコードか端末の出力)。これ以外が出たら、セッション名・ブランチ名・ボタン・チップに付いていないかを見て外す
  - `RepoGridView.tsx`: プレビューの `<pre>` (1行)
  - `RepoSelectDialog.tsx`: スキャンするパスのボタン内の表示、リポジトリのパス、直接パスを入力する欄 (3行)
  - `FolderBrowserDialog.tsx`: 現在のパスの入力欄 (1行)
  - `CreateWorktreeDialog.tsx`: Worktree Path の表示 (1行)
  - `ProfileManagerDialog.tsx`: 設定ディレクトリの表示と入力欄 (2行)
  - `FileViewerPane.tsx`: プレーン表示のコード (1行)

- [ ] **Step 20: 漏れを直す**

Step 18 と Step 19 で出た行を、次の置き換えで直す。ファイルがほかのタスクの担当でも、ここで直してよい (コミットメッセージに元のタスクを書く)。

| 出たもの | 置き換え |
|---|---|
| 状態を表す色 (動作中の緑、入力待ちの赤、判断待ちの橙など) | `StatusChip`、または `TONE_CLASSES[presentStatus(key).tone]` の `text` / `softBg` / `solidBg` |
| blue / sky / indigo (リンク・選択・強調) | `text-primary` / `bg-primary/15` / `border-primary` |
| red / rose (削除・エラー) | `text-destructive` / `bg-destructive/10` / `border-destructive/40` |
| amber / orange / yellow (注意・古い設定) | `text-status-awaiting` / `bg-status-awaiting/15` / `border-status-awaiting/40` |
| emerald / green (成功・チェック) | 状態なら上の状態の行。チェックの印なら `text-primary` |
| slate / gray / neutral / zinc / stone (中立) | `text-muted-foreground` / `bg-muted` / `border-border` |
| purple / pink / violet / fuchsia / teal / cyan (種類の見分け) | 色で見分けない。`bg-muted text-muted-foreground` にして文言かアイコンで見分ける |
| `bg-[#1a1b26]` など端末の背景 | `style={{ backgroundColor: TERMINAL_BG }}` (`import { TERMINAL_BG } from "@ark/shared"`) |
| `glow-green` / `glow-cyan` | クラスを消す |
| `status-indicator` | `StatusChip` |
| `text-terminal-*` / `bg-terminal-*` | 意味に合わせて `text-primary` か `text-status-*` |
| JSX の中の絵文字アイコン | lucide-react のアイコン (`aria-hidden` を付け、ボタンなら `aria-label` を付ける) |

担当の目安: `index.css` / `App.tsx` / `ui/sonner.tsx` は Task 1、`SessionSidebar` / `SidebarMainLayout` / `SessionListRow` / `SessionRowMenu` / `AboutDialog` の構成は Task 5、`MobileSessionList` / `MobileLayout` は Task 6、`SplitViewPane` / `SplitViewLeftModeToggle` / `TerminalPane` / `SessionHeaderMenu` / `SegmentedControl` は Task 7、`SplitChatPane` / `AskUserQuestionCard` は Task 8・9、`MobileSessionView` / `MobileSessionViewModeToggle` は Task 10。

直したら Step 18 と Step 19 をもう一度実行し、Expected どおりになるまで繰り返す。

- [ ] **Step 21: 全体のテストと型を通し、直したものがあればコミット**

Step 20 でファイルを変えたときは、先に整形する: `pnpm biome check --write <Step 20 で変えたファイル>`

Run: `pnpm check && pnpm test`

Expected: エラー無し、テストはすべて PASS

Step 20 で何も変えなかったときは、ここで Task 11 は終わり (コミットしない)。変えたときだけ次を実行する。
本文の箇条書きは、見つかったものを1件1行で書く。書式の例: `- MobileSessionList.tsx: bg-emerald-500 → bg-status-idle (Task 6)`

```bash
git branch --show-current
git add <Step 20 で変えたファイル>
git commit -m "fix(web): 残っていた直書き色と絵文字のアイコンをトークンと lucide にする

禁止クラスの grep で見つかった取りこぼしを直す。
- <ファイル名>: <直したクラス> → <置き換えたクラス> (Task <番号>)"
```

---

### Task 12: 撮影による確認とプレビュー

**Files:**
- Create (コミットしない): `$VERIFY/shoot.mjs` / `$VERIFY/verify-terminal.mjs`、worktree直下の `playwright.verify.config.ts` と `packages/web/vite.verify.config.ts` (どちらも実行後に削除)
- Modify: 撮影で見つかった崩れに応じて、Task 1〜11 のファイル

`$VERIFY` は `/tmp/claude-1000/-home-admin-dev-github-com-ignission-claude-code-manager/24cbab82-54a8-45db-9396-4357159c0fd5/scratchpad/verify` とする。
**撮影した画像には本物のセッションの会話が写る。コミット・PR・Artifact・Slack などに載せない。**

**Interfaces:**
- Consumes: Task 1〜11 のすべて。特に `data-session-key` / `data-section` (Task 5, 6)、`aria-label="会話" | "端末" | "図"` のセグメント (Task 7, 10)、`data-mobile-bottom-bar` (Task 9, 10)。全セッション・全モードのペインが hidden でマウントされたままなので、セグメントのボタンは `:visible` で表示中の1つに絞って押す
- Produces: 撮影結果 (`$VERIFY/shots/*.png`) と、見つかった崩れの修正コミット

- [ ] **Step 1: 全体のテストと型を通す**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper && pnpm check && pnpm test`
Expected: すべて PASS。落ちたら該当タスクに戻って直す

- [ ] **Step 2: 禁止したクラスが残っていないことを確かめる**

Run:

```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper
grep -rnE 'glow-(green|cyan)|status-indicator|terminal-prompt|(text|bg)-terminal-|bg-\[#1a1b26\]|(text|bg|border)-(green|emerald|lime|red|orange|amber|yellow|blue|violet|slate|gray|neutral|zinc)-[0-9]' packages/web/src \
  --include='*.tsx' --include='*.ts' --include='*.css' \
  | grep -v '/components/bridge/' | grep -v 'pages/Bridge.tsx' | grep -v '\.test\.'
grep -rnP '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' packages/web/src --include='*.tsx' | grep -v '/components/bridge/' | grep -v '\.test\.'
```

Expected: どちらも出力なし (Task 11 に書いた例外を除く)。残っていたら、そのファイルを担当したタスクの漏れとして直してコミットする

- [ ] **Step 3: 別の出力先にビルドし、preview を立てる**

Run:

```bash
VERIFY=/tmp/claude-1000/-home-admin-dev-github-com-ignission-claude-code-manager/24cbab82-54a8-45db-9396-4357159c0fd5/scratchpad/verify
mkdir -p "$VERIFY/shots"
cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper
pnpm --filter @ark/web exec vite build --outDir "$VERIFY/dist" --emptyOutDir
```

Expected: `✓ built in …`。`packages/web/dist` と、main のチェックアウトの `packages/web/dist` は変わらない

撮影と e2e 用の preview は、**`/ttyd` をどこにも中継しない設定**で立てる。ブラウザ側の遮断を書き忘れても、
ユーザーの tmux ペインに触れないようにするため。`packages/web/vite.verify.config.ts` を作る (コミットしない):

```ts
import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config";

// 検証用: /api と /socket.io は稼働中の Ark (4001) へ中継し、/ttyd だけは閉じたポートへ向ける
export default mergeConfig(
  base,
  defineConfig({
    server: {
      proxy: {
        "/ttyd": { target: "http://127.0.0.1:9", ws: true, changeOrigin: true },
      },
    },
  })
);
```

続けて、preview をバックグラウンドで起動する (Bash の `run_in_background: true`):

```bash
VERIFY=/tmp/claude-1000/-home-admin-dev-github-com-ignission-claude-code-manager/24cbab82-54a8-45db-9396-4357159c0fd5/scratchpad/verify
cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper/packages/web
pnpm exec vite preview --config vite.verify.config.ts --outDir "$VERIFY/dist" --port 4020 --strictPort --host 127.0.0.1
```

Run: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4020/ && curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4020/api/settings && curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4020/ttyd/x/`
Expected: `200` / `200` / `5xx` (`/ttyd` だけが中継されない)

- [ ] **Step 4: 撮影スクリプトを書く**

`$VERIFY/shoot.mjs`:

```js
// 使い方: node shoot.mjs
// preview (4020) を PC 2 幅・モバイル × ライト/ダーク × 状態の割り当て 2 通りで撮る。
// - /ttyd/ はすべて遮断する (ユーザーの tmux ペインが縮むのを防ぐ)
// - session:previews の bridgeStatus を 7 状態に順に書き換え、全状態のチップと並びを出す
// - 撮影の前後で /api/settings を退避・復元する (セッションを開くと選択状態が保存されるため)
import { createRequire } from "node:module";
import path from "node:path";

const WT = "/home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper";
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), "shots");
const BASE = "http://localhost:4020";
const { chromium } = createRequire(`${WT}/package.json`)("@playwright/test");

const STATES = ["AWAITING", "ERR", "IDLE", "TOOL", "THINK", "READY", "STOP"];

function rewriter(offset) {
  return text => {
    if (typeof text !== "string" || !text.includes('"bridgeStatus"')) return text;
    let i = 0;
    return text.replace(
      /"bridgeStatus":"[A-Z]+"/g,
      () => `"bridgeStatus":"${STATES[(offset + i++) % STATES.length]}"`
    );
  };
}

// 前の撮影でセッションを開くと「詳細画面を表示中」が保存され、次の撮影で一覧が出なくなる。
// 撮影ごとに一覧の状態へ戻す (最後に settingsBackup で元に戻す)
async function resetViewSettings() {
  await fetch(`${BASE}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      selectedSessionId: null,
      "mobile.activeTab": "session",
      "mobile.sessionSubView": "list",
    }),
  });
}

async function newPage(browser, { viewport, isMobile, scheme, offset, leftMode }) {
  await resetViewSettings();
  const context = await browser.newContext({
    viewport,
    isMobile,
    hasTouch: isMobile,
    deviceScaleFactor: 2,
    colorScheme: scheme,
  });
  if (leftMode) {
    await context.addInitScript(mode => {
      localStorage.setItem("ark-split-left-mode", mode);
    }, leftMode);
  }
  const page = await context.newPage();
  const rewrite = rewriter(offset);
  await page.route(/\/ttyd\//, route => route.abort());
  await page.route(/\/socket\.io\/.*transport=polling/, async route => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = rewrite(await response.text());
    await route.fulfill({ response, body });
  });
  await page.routeWebSocket(/\/socket\.io\//, ws => {
    const server = ws.connectToServer();
    ws.onMessage(message => server.send(message));
    server.onMessage(message => ws.send(rewrite(message)));
  });
  return { context, page };
}

const settingsBackup = await (await fetch(`${BASE}/api/settings`)).json();
const browser = await chromium.launch();
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

try {
  for (const scheme of ["light", "dark"]) {
    for (const offset of [0, 4]) {
      // PC 1440 と 1024 (会話モード)
      for (const [w, h] of [[1440, 900], [1024, 768]]) {
        const { context, page } = await newPage(browser, { viewport: { width: w, height: h }, isMobile: false, scheme, offset });
        await page.goto(BASE, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("[data-session-key]", { timeout: 15_000 });
        await page.waitForTimeout(2500);
        await shot(page, `pc${w}-${scheme}-o${offset}-chat`);
        await context.close();
      }

      // モバイル: 一覧 → 会話 → 端末 → 図 → キーボード相当
      const { context, page } = await newPage(browser, { viewport: { width: 390, height: 844 }, isMobile: true, scheme, offset });
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-session-key]", { timeout: 15_000 });
      await page.waitForTimeout(2500);
      await shot(page, `m-${scheme}-o${offset}-list`);
      // 未起動の行を押すとセッションが起動してしまうので、起動済みの行だけを押す
      const row = page.locator('[data-session-key]:not(:has([data-status="NOT_STARTED"]))').first();
      await row.click();
      await page.waitForTimeout(2500);
      await shot(page, `m-${scheme}-o${offset}-chat`);
      await page.locator('button[aria-label="端末"]:visible').first().click();
      await page.waitForTimeout(800);
      await shot(page, `m-${scheme}-o${offset}-terminal`);
      await page.locator('button[aria-label="図"]:visible').first().click();
      await page.waitForTimeout(800);
      await shot(page, `m-${scheme}-o${offset}-board`);
      await page.locator('button[aria-label="会話"]:visible').first().click();
      await page.setViewportSize({ width: 390, height: 500 });
      await page.waitForTimeout(800);
      await shot(page, `m-${scheme}-o${offset}-chat-short`);
      await context.close();
    }

    // PC 端末モードの額縁 (iframe は遮断しているので中身は空)
    const { context, page } = await newPage(browser, { viewport: { width: 1440, height: 900 }, isMobile: false, scheme, offset: 0, leftMode: "terminal" });
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-session-key]", { timeout: 15_000 });
    await page.waitForTimeout(2000);
    await shot(page, `pc1440-${scheme}-terminal`);
    await context.close();
  }

  // 実行中にOSのテーマを切り替えたとき追従するか
  const { context, page } = await newPage(browser, { viewport: { width: 1440, height: 900 }, isMobile: false, scheme: "light", offset: 0 });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-session-key]", { timeout: 15_000 });
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const lightBg = await bg();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(300);
  const darkBg = await bg();
  console.log(`テーマ追従: light=${lightBg} dark=${darkBg} → ${lightBg !== darkBg ? "OK" : "NG"}`);
  await context.close();
} finally {
  await browser.close();
  await fetch(`${BASE}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settingsBackup),
  });
  console.log("settings を復元した");
}
```

- [ ] **Step 5: 撮影して、画像を目で確かめる**

Run: `VERIFY=/tmp/claude-1000/-home-admin-dev-github-com-ignission-claude-code-manager/24cbab82-54a8-45db-9396-4357159c0fd5/scratchpad/verify && cd $VERIFY && node shoot.mjs && ls shots | wc -l`
Expected: `テーマ追従: … → OK`、`settings を復元した`、画像が 30 枚

撮った画像を Read ツールで1枚ずつ開き、参照モック
(`docs/superpowers/specs/2026-09-17-visual-redesign-paper/A-pc.html` / `A-mobile-chat.html` / `A-mobile-list.html`) と見比べて、次を確かめる。
崩れがあれば該当タスクのファイルを直し、Step 1 → Step 3 のビルド → Step 5 をやり直す。直したらコミットする。

- 状態: `o0` と `o4` の2枚で、確認待ち・問題・入力待ち・作業中・待機・停止のチップがすべて出ている。セクションが「あなたの番 → 作業中 → 休止中」の順で、「あなたの番」に件数バッジがある
- 文字: セッション名・ブランチ名・チップが等幅になっていない。見出しが大文字化されていない。文字が重なったり、はみ出したりしていない
- 色: ライトは明るい紙、ダークは暖色の暗い灰。ネオン緑・発光が残っていない。琥珀のチップの文字が読める
- PC: 上部バーに主ラベル・ブランチ・チップ・「端末 / 会話」・図・`…` がある。1024幅でも上部バーとサイドバーが崩れない。端末モードで額縁 (角丸・内側余白・暗い背景) が出ている
- モバイル: 下部のガラスバーの下を会話が通り、最下部までスクロールしても最後の行が隠れない。端末モードのバーは不透明で端末に重ならない。図モードはセグメントだけ。高さを縮めた `chat-short` でバーと入力欄が見切れない。状態の帯が状態に合った文言で出ている
- リモートでない (localhost) ので、モバイルの下部タブバーが出ていない

- [ ] **Step 6: 直した e2e を preview に対して実行する**

`/api/settings` を書き換える spec なので、実行の前後で退避・復元する。4020 の preview は `/ttyd` を中継しないので、この spec が画面を開いてもユーザーの tmux ペインには触れない。

worktree直下に `playwright.verify.config.ts` を作る (コミットしない):

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  reporter: "list",
  use: { baseURL: "http://localhost:4020" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
```

Run:

```bash
VERIFY=/tmp/claude-1000/-home-admin-dev-github-com-ignission-claude-code-manager/24cbab82-54a8-45db-9396-4357159c0fd5/scratchpad/verify
cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper
curl -s http://localhost:4020/api/settings > "$VERIFY/settings-backup.json"
pnpm exec playwright test -c playwright.verify.config.ts e2e/mobile-session-state.spec.ts
curl -s -X PUT -H 'content-type: application/json' --data @"$VERIFY/settings-backup.json" http://localhost:4020/api/settings
rm playwright.verify.config.ts
git status --short   # playwright.verify.config.ts が残っていないこと
```

Expected: spec がすべて PASS。settings の PUT が `{"success":true}` 等の成功を返す

- [ ] **Step 7: 端末 (ttyd) を、検証用のセッションだけで確かめる**

ほかのセッションの ttyd に触ると、ユーザーの tmux ペインが検証側の画面サイズに縮む。検証用の worktree とセッションを作り、
その ttyd だけを通す。`session:stop` は main 以外の worktree をブランチごと片付ける。

このステップだけは本物の ttyd が要るので、`/ttyd` も中継する通常の設定の preview を 4021 に立てる (Bash の `run_in_background: true`)。
ブラウザ側で検証用セッション以外の `/ttyd/` を必ず遮断する (スクリプトに入っている)。

```bash
VERIFY=/tmp/claude-1000/-home-admin-dev-github-com-ignission-claude-code-manager/24cbab82-54a8-45db-9396-4357159c0fd5/scratchpad/verify
cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper
pnpm --filter @ark/web exec vite preview --outDir "$VERIFY/dist" --port 4021 --strictPort --host 127.0.0.1
```

`$VERIFY/verify-terminal.mjs`:

```js
import { createRequire } from "node:module";

const WT = "/home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper";
const MAIN_REPO = "/home/admin/dev/github.com/ignission/claude-code-manager";
const BRANCH = "verify/ui-redesign-terminal";
const BASE = "http://localhost:4021";
const { chromium } = createRequire(`${WT}/package.json`)("@playwright/test");
const { io } = createRequire(`${WT}/packages/web/package.json`)("socket.io-client");

function waitFor(socket, event, predicate, ms = 60_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${event}`)), ms);
    const handler = payload => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

const settingsBackup = await (await fetch(`${BASE}/api/settings`)).json();
const socket = io("http://localhost:4001", { transports: ["websocket"] });
await new Promise(r => socket.once("connect", r));
socket.on("worktree:error", e => console.error("worktree:error", e));
socket.on("session:error", e => console.error("session:error", e));

socket.emit("worktree:create", { repoPath: MAIN_REPO, branchName: BRANCH });
const { worktree } = await waitFor(socket, "worktree:created", p => p.worktree.branch === BRANCH);
socket.emit("session:start", { worktreeId: worktree.id, worktreePath: worktree.path });
const session = await waitFor(socket, "session:created", s => s.worktreeId === worktree.id);
console.log("検証用セッション", session.id, worktree.path);

const browser = await chromium.launch();
let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "OK" : "NG"}: ${label}`);
  if (!ok) failures++;
};

try {
  // PC: 検証用セッションを選び、端末 ↔ 会話を切り替えても iframe が作り直されないこと
  const pc = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await pc.addInitScript(() => localStorage.setItem("ark-split-left-mode", "terminal"));
  const page = await pc.newPage();
  await page.route(/\/ttyd\//, route =>
    route.request().url().includes(`/ttyd/${session.id}`) ? route.continue() : route.abort()
  );
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.locator(`[data-session-key="wt:${worktree.id}"]`).click();
  const iframe = page.locator(`iframe[src*="/ttyd/${session.id}"]`).first();
  await iframe.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(3000);
  await iframe.evaluate(el => { el.dataset.verifyMark = "1"; });
  const frameBox = await iframe.boundingBox();
  const frameParentBox = await iframe.evaluate(el => {
    const r = el.parentElement.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  check("端末 iframe が額縁の内側に収まる", frameBox.x >= frameParentBox.x && frameBox.y >= frameParentBox.y && frameBox.x + frameBox.width <= frameParentBox.x + frameParentBox.width + 1);
  await page.screenshot({ path: `${process.env.VERIFY}/shots/verify-pc-terminal.png` });
  await page.locator('button[aria-label="会話"]:visible').first().click();
  await page.waitForTimeout(800);
  await page.locator('button[aria-label="端末"]:visible').first().click();
  await page.waitForTimeout(800);
  check("端末 ↔ 会話の切り替えで iframe が作り直されない", (await iframe.evaluate(el => el.dataset.verifyMark)) === "1");
  await pc.close();

  // モバイル: 端末モードで下部バーが iframe に重ならないこと
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mp = await m.newPage();
  await mp.route(/\/ttyd\//, route =>
    route.request().url().includes(`/ttyd/${session.id}`) ? route.continue() : route.abort()
  );
  await mp.goto(BASE, { waitUntil: "domcontentloaded" });
  await mp.locator(`[data-session-key="wt:${worktree.id}"]`).click();
  await mp.locator('button[aria-label="端末"]:visible').first().click();
  const miframe = mp.locator(`iframe[src*="/ttyd/${session.id}"]`).first();
  await miframe.waitFor({ state: "visible", timeout: 30_000 });
  await mp.waitForTimeout(3000);
  const iframeBottom = await miframe.evaluate(el => el.getBoundingClientRect().bottom);
  const segmentTop = await mp.locator('button[aria-label="会話"]:visible').first().evaluate(el => el.closest("[data-mobile-bottom-bar]")?.getBoundingClientRect().top ?? el.getBoundingClientRect().top);
  check("モバイル端末モードで下部バーが端末に重ならない", iframeBottom <= segmentTop + 1);
  await mp.screenshot({ path: `${process.env.VERIFY}/shots/verify-m-terminal.png` });
  await m.close();
} finally {
  await browser.close();
  socket.emit("session:stop", session.id);
  await waitFor(socket, "session:stopped", id => id === session.id).catch(e => console.error(e.message));
  socket.close();
  await fetch(`${BASE}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settingsBackup),
  });
}
process.exitCode = failures === 0 ? 0 : 1;
```

Run:

```bash
VERIFY=/tmp/claude-1000/-home-admin-dev-github-com-ignission-claude-code-manager/24cbab82-54a8-45db-9396-4357159c0fd5/scratchpad/verify
cd $VERIFY && VERIFY=$VERIFY node verify-terminal.mjs
git -C /home/admin/dev/github.com/ignission/claude-code-manager worktree list | grep ui-redesign-terminal || echo "片付け済み"
```

Expected: `OK:` が3行、`NG:` が無い。最後に `片付け済み`。残っていたら `git -C <MAIN_REPO> worktree remove <path>` と `git -C <MAIN_REPO> branch -D verify/ui-redesign-terminal` で消す

注: preview は稼働中の Ark (main のビルド) につながっているので、ttyd の色 (Task 4) はまだ古い `#1a1b26` のまま。額縁の色との段差はこの時点では想定どおり。

- [ ] **Step 8: preview を止め、一時ファイルを消す**

Step 3 と Step 7 でバックグラウンド起動した `vite preview` を止め、検証用の設定ファイルを消す。

Run:

```bash
lsof -ti tcp:4020 | xargs -r kill
lsof -ti tcp:4021 | xargs -r kill
cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper
rm -f packages/web/vite.verify.config.ts playwright.verify.config.ts
git status --short
```

Expected: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4020/` と 4021 がどちらも `000`。`git status --short` に一時ファイルが出ない

- [ ] **Step 9: 別のAIに実装をレビューさせる**

CLAUDE.md の「セルフレビュー禁止」に従い、gstack の `/codex` スキルで main との差分をレビューさせる (`codex review` モード)。
[P0] / [P1] の指摘は直してコミットし、Step 1 から確かめ直す。

- [ ] **Step 10: push して PR を作る**

```bash
VERIFY=/tmp/claude-1000/-home-admin-dev-github-com-ignission-claude-code-manager/24cbab82-54a8-45db-9396-4357159c0fd5/scratchpad/verify
cd /home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper
git branch --show-current
git push -u origin feat/visual-redesign-paper
gh pr create --base main --head feat/visual-redesign-paper --title "見た目を刷新する (Paper)" --body-file "$VERIFY/pr-body.md"
```

`$VERIFY/pr-body.md` には次を書く (スクリーンショットは本物の会話が写るので載せない):

```markdown
## 概要

Arkの見た目を、黒地にネオン緑のターミナル風から、明るい紙の上で「自分の番」が一目で分かる見た目に変える。
設計書: docs/superpowers/specs/2026-09-17-visual-redesign-paper-design.md

## 変更点

- ライトとダークのトークン (OSの設定に追従)。状態色・影・ガラスのトークンを追加し、ターミナル風の装飾を撤去
- 状態の表示を BridgeSessionStatus の1系統に統一 (これまでPCとモバイルで色が食い違っていた)
- PCサイドバーとモバイル一覧を「あなたの番 / 作業中 / 休止中」の注意の順に並べ、操作中は並び替えを保留
- PCの上部バーを統合し、会話モードでもセッション名と操作が見えるように。端末は暗い窓の額縁に
- 会話のツール行を「作業N件」に折りたたみ、吹き出し・質問カード・入力欄を刷新
- モバイル会話に状態の帯と、浮かぶガラスの下部バー
- PCの左ペインの既定を「会話」に (保存済みの選択は尊重)
- ttyd の背景色を暖色の暗色に (デプロイ時の ttyd 再起動で反映)

## モックからの変更

- 状態の文言を「質問 → 確認待ち」「完了 → 入力待ち」にした。AWAITING は許可プロンプトも含み、IDLE は成功を意味しないため
- エラーも人の対応が要るので「休止中」ではなく「あなたの番」に入れた

## 確認

- pnpm check / pnpm test
- 別出力先のビルドを PC (1440 / 1024) とモバイルでライト・ダーク撮影し、7状態すべてのチップと並びを確認
- 検証用セッションで、端末の額縁・切り替えで iframe が作り直されないこと・モバイルで下部バーが端末に重ならないことを確認
```

- [ ] **Step 11: ユーザーに実機で触ってもらう方法を決める**

本番 (リモート公開) に関わるので、AskUserQuestion で次の選択肢から選んでもらう。説明には「モックの『質問』『完了』を『確認待ち』『入力待ち』に変えた理由」も添える。

1. **本番のArkを一時的にこのブランチのビルドに切り替える** — スマホからそのまま触れる。確認後に main に戻す
2. **このPCのブラウザで preview (http://localhost:4020) を開く** — 本番に触れない。スマホからは見られない
3. **PRのレビューとマージの後、通常のデプロイ手順で出す**

1 が選ばれたら、次の順で実行する (間に別の作業を挟まない。`pm2 save` はしない):

```bash
WT=/home/admin/dev/github.com/ignission/claude-code-manager-feat-visual-redesign-paper
MAIN=/home/admin/dev/github.com/ignission/claude-code-manager
cd $WT && git status --short   # 未コミットの変更が無いこと
cd $WT && pnpm check && pnpm build   # worktree の dist にビルドする (main の dist は変わらない)
pkill -x ttyd
pm2 delete claude-code-ark
# data/ と logs/ は main 側を使う (worktree の ecosystem.config.cjs は cwd が worktree になるので使わない)
cd $MAIN && NODE_ENV=production pm2 start $WT/packages/server/dist/cli.js --name claude-code-ark --cwd $MAIN --interpreter "$(mise which node)" --node-args=--env-file=.env.production --output $MAIN/logs/out.log --error $MAIN/logs/error.log --merge-logs -- --remote
sleep 5 && curl -s http://localhost:4001/ | grep -o 'assets/index-[^"]*\.js'
ls $WT/packages/web/dist/assets | grep '^index-.*\.js$'   # 上と同じファイル名なら、このブランチが配信されている
```

main に戻すとき:

```bash
MAIN=/home/admin/dev/github.com/ignission/claude-code-manager
pkill -x ttyd
pm2 delete claude-code-ark
cd $MAIN && PM2_INTERPRETER="$(mise which node)" pm2 start packages/server/ecosystem.config.cjs
sleep 5 && pm2 jlist | node -e 'const a=JSON.parse(require("fs").readFileSync(0,"utf8"));const p=a.find(x=>x.name==="claude-code-ark");console.log(p.pm2_env.pm_exec_path, p.pm2_env.status)'
```

Expected (戻したとき): `…/claude-code-manager/packages/server/dist/cli.js online`
