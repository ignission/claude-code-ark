# 音声モード (iPhone向け) 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** モバイルの会話ビューに、話して指示を送り、Claudeの返答を読み上げで聞ける全画面の音声モードを足す。

**Architecture:** 状態遷移・読み上げ文への変換・ターンの終わりの検出を純関数に分け、ブラウザの音声APIは `SpeechPort` の窓口越しに使う。`useVoiceMode` が reducer の返す副作用を同期的に実行し (iOSはユーザー操作の中でしか認識を始めさせない)、`MobileSessionView` が会話ビュー (`SplitChatPane`) から JSONL のイベント列と質問カードを受け取って渡す。サーバーは診断ログを1行出すだけ。

**Tech Stack:** React 19, TypeScript 7 (tsc -b), vitest 4 (jsdom は `// @vitest-environment jsdom` で指定), Biome, Socket.IO, Web Speech API (`webkitSpeechRecognition` / `speechSynthesis`), Screen Wake Lock API

**仕様:** `docs/superpowers/specs/2026-09-19-voice-mode-design.md`

## Global Constraints

- 対象はiPhoneのSafari (タブ)。PC・Android・デスクトップアプリ向けの分岐は作らない
- 追加の外部サービス・npm依存は入れない (要約LLM、音声API、サーバー側の音声処理なし)
- 会話内容の情報源はJSONLだけ。tmuxの画面テキストを解釈しない
- Claudeのセッションに音声向けの指示を注入しない
- JSONLの購読を増やさない (会話ビューが持つイベント列を受け取る)
- `SplitChatPane.tsx` に足すのはコールバックの呼び出しだけ
- 送信待ちの猶予は2秒 (`CONFIRM_MS = 2000`)、無音の判定は2秒 (`SILENCE_MS = 2000`)、止まったままの判定は5秒 (`SETTLED_MS = 5000`)
- 1回の返答で読むのは300文字まで (`SPEECH_MAX_CHARS = 300`)。超えたら「続きは画面で」
- 読み上げの見張りは発話ごとに `文字数 × 300ms + 3000ms`
- 認識は `lang = "ja-JP"`、`continuous = false`、`interimResults = true`
- 診断ログには認識した文や返答の本文を載せない (文字数だけ)
- コメント・テスト名・UIの文言は日本語。日本語と半角英数字の間に空白を入れない
- コミットメッセージは日本語。Co-Authored-Byは付けない
- 各タスクの最後に `pnpm exec vitest run <対象>` を通す。最後のタスクで `pnpm check` と `pnpm test` を通す

---

## ファイル構成

| ファイル | 種別 | 役割 |
|---|---|---|
| `packages/web/src/lib/speech-text.ts` | 新規 | Markdown → 読み上げる文の配列。質問の読み上げ文。案内の定型文 |
| `packages/web/src/lib/voice-turn-signals.ts` | 新規 | JSONLイベント列から、音声モードに入った後のターンの終わりを取り出す |
| `packages/web/src/lib/voice-mode-machine.ts` | 新規 | 状態遷移のreducer (状態 + 入力 → 次の状態 + 副作用) |
| `packages/web/src/lib/browser-speech.ts` | 新規 | `SpeechPort` とブラウザAPIによる実装 |
| `packages/web/src/hooks/useVoiceMode.ts` | 新規 | reducerとSpeechPortをつなぐ。時間の経過とJSONLを入力に変える |
| `packages/web/src/components/VoiceModeOverlay.tsx` | 新規 | 全画面の音声モードと、畳んだときの帯 |
| `packages/server/src/lib/voice-diagnostic.ts` | 新規 | 診断イベントをログの1行に整える |
| `packages/web/src/lib/jsonl-event-parser.ts` | 変更 | `assistant-text` に `endTurn` を載せる |
| `packages/web/src/components/SplitChatPane.tsx` | 変更 | `onEventsChange` を足し、`onActiveAuqChange` を `ActiveAuq \| null` にする |
| `packages/web/src/components/MobileSessionView.tsx` | 変更 | 音声モードを組み込む |
| `packages/web/src/lib/mobile-quick-actions.ts` | 変更 | `"voice-mode"` を足す |
| `packages/web/src/components/MobileQuickActionRow.tsx` | 変更 | 音声モードのボタン |
| `packages/shared/src/types.ts` | 変更 | `voice:diagnostic` イベント |
| `packages/server/src/index.ts` | 変更 | `voice:diagnostic` を受けてログに出す |
| `CLAUDE.md` | 変更 | イベント表と機能表に追記 |

---

### Task 1: 読み上げ用の文への変換 (`speech-text.ts`)

**Files:**
- Create: `packages/web/src/lib/speech-text.ts`
- Test: `packages/web/src/lib/speech-text.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `toSpeechSentences(markdown: string, maxChars?: number): string[]`
  - `questionsToSpeechSentences(questions: readonly { question: string; options: readonly { label: string }[] }[]): string[]`
  - 定数 `SPEECH_MAX_CHARS` / `CODE_PLACEHOLDER` / `TABLE_PLACEHOLDER` / `CONTINUED_SUFFIX` / `ANSWER_ON_SCREEN` / `CONFIRM_ON_SCREEN` / `REPLY_ON_SCREEN`

- [ ] **Step 1: 失敗するテストを書く**

`packages/web/src/lib/speech-text.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ANSWER_ON_SCREEN,
  CODE_PLACEHOLDER,
  CONTINUED_SUFFIX,
  questionsToSpeechSentences,
  TABLE_PLACEHOLDER,
  toSpeechSentences,
} from "./speech-text";

describe("toSpeechSentences", () => {
  it("句点で文に分ける", () => {
    expect(toSpeechSentences("直しました。テストも通りました。")).toEqual([
      "直しました。",
      "テストも通りました。",
    ]);
  });

  it("コードブロックは「コードは画面で」に置き換え、続くコードブロックは1回にまとめる", () => {
    const md = [
      "修正です。",
      "```ts",
      "const a = 1;",
      "```",
      "",
      "```ts",
      "const b = 2;",
      "```",
      "以上です。",
    ].join("\n");
    expect(toSpeechSentences(md)).toEqual([
      "修正です。",
      CODE_PLACEHOLDER,
      "以上です。",
    ]);
  });

  it("表は「表は画面で」に置き換える", () => {
    const md = [
      "比較です。",
      "| 案 | 結果 |",
      "|---|---|",
      "| A | 良い |",
      "おすすめはAです。",
    ].join("\n");
    expect(toSpeechSentences(md)).toEqual([
      "比較です。",
      TABLE_PLACEHOLDER,
      "おすすめはAです。",
    ]);
  });

  it("リンクは文だけ読み、URLは読まない", () => {
    expect(
      toSpeechSentences(
        "[仕様書](https://example.com/spec)を見てください。詳細は https://example.com/x にあります。"
      )
    ).toEqual(["仕様書を見てください。", "詳細はにあります。"]);
  });

  it("短いインラインコードは中身を読み、長いものは読まない", () => {
    expect(
      toSpeechSentences(
        "`pnpm check` を実行し、`const veryLongIdentifierName = computeSomething()` を消しました。"
      )
    ).toEqual(["pnpm checkを実行し、を消しました。"]);
  });

  it("パスはファイル名だけ読み、行番号は落とす", () => {
    expect(
      toSpeechSentences("packages/web/src/lib/speech-text.ts:42 を直しました。")
    ).toEqual(["speech-text.tsを直しました。"]);
  });

  it("英字を含まないスラッシュ区切り (日付) はパスとして扱わない", () => {
    expect(toSpeechSentences("2026/09/19 に出しました。")).toEqual([
      "2026/09/19に出しました。",
    ]);
  });

  it("見出し・箇条書き・強調の記号を落とし、箇条書きの各項目を1文にする", () => {
    const md = [
      "## 結果",
      "- **テスト**が通った",
      "- 型チェックも通った",
      "1. 次はレビュー",
    ].join("\n");
    expect(toSpeechSentences(md)).toEqual([
      "結果",
      "テストが通った",
      "型チェックも通った",
      "次はレビュー",
    ]);
  });

  it("絵文字を落とす", () => {
    expect(toSpeechSentences("✅ 完了しました 🎉")).toEqual(["完了しました"]);
  });

  it("300文字を超える分は読まず「続きは画面で」で締める", () => {
    const sentence = `${"あ".repeat(99)}。`;
    expect(toSpeechSentences(sentence.repeat(4))).toEqual([
      sentence,
      sentence,
      sentence,
      CONTINUED_SUFFIX,
    ]);
  });

  it("1文目だけで上限を超えるときは、上限で切って続きを案内する", () => {
    expect(toSpeechSentences("い".repeat(400), 300)).toEqual([
      "い".repeat(300),
      CONTINUED_SUFFIX,
    ]);
  });

  it("読むものが無ければ空配列を返す", () => {
    expect(toSpeechSentences("   \n\n")).toEqual([]);
  });
});

describe("questionsToSpeechSentences", () => {
  it("質問文と選択肢を読み、最後に画面で答えるよう案内する", () => {
    expect(
      questionsToSpeechSentences([
        {
          question: "どちらで進めますか？",
          options: [{ label: "A案" }, { label: "B案" }],
        },
      ])
    ).toEqual([
      "Claudeから質問です。",
      "どちらで進めますか？",
      "選択肢は、A案、B案。",
      ANSWER_ON_SCREEN,
    ]);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `pnpm exec vitest run packages/web/src/lib/speech-text.test.ts`
Expected: FAIL (`Failed to resolve import "./speech-text"`)

- [ ] **Step 3: 実装する**

`packages/web/src/lib/speech-text.ts`:

```ts
/**
 * speech-text - Claude の返答 (Markdown) を、音声モードで読み上げる文の配列に変える。
 *
 * 耳で聞いて意味を持たないもの (コード、表、URL、長いパス) は読まず、「画面で」と一言に
 * 置き換える。Claude に音声向けの書き方をさせるのではなく、読む側で選ぶ
 * (セッションへの注入は .claude/rules/context-engineering.md の「こだま」に当たる)。
 *
 * 文ごとに分けて返すのは、呼び出し側が1文ずつ別の発話にするため
 * (長い1発話は途中で切れることがある)。
 *
 * 仕様: docs/superpowers/specs/2026-09-19-voice-mode-design.md の5章
 */

/** 1回の返答で読む上限 (文字数)。超えた分は読まず CONTINUED_SUFFIX で締める */
export const SPEECH_MAX_CHARS = 300;
export const CODE_PLACEHOLDER = "コードは画面で";
export const TABLE_PLACEHOLDER = "表は画面で";
export const CONTINUED_SUFFIX = "続きは画面で";
export const ANSWER_ON_SCREEN = "画面で答えてください";
export const CONFIRM_ON_SCREEN = "画面で確認が必要です";
export const REPLY_ON_SCREEN = "返答は画面で";

/** インラインコードはこの長さまでなら中身を読む (識別子やコマンド名は聞いて分かる) */
const INLINE_CODE_MAX = 24;

const FENCE_RE = /^\s*(```|~~~)/;
const TABLE_RE = /^\s*\|/;
const RULE_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const HEADING_RE = /^\s{0,3}#{1,6}\s+/;
const QUOTE_RE = /^\s*>\s?/;
const LIST_RE = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;
const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK_RE = /\[([^\]]+)\]\([^)]*\)/g;
const URL_RE = /https?:\/\/\S+/g;
const INLINE_CODE_RE = /`([^`]+)`/g;
/** `/` を2つ以上含む語。末尾の `:行` `:行:列` も含めて1つとして拾う */
const PATH_RE = /[\w.@~-]*\/[\w.@~-]*\/[\w.@~/-]*[\w@~-](?::\d+){0,2}/g;
const EMPHASIS_RE = /\*\*|__|~~/g;
const EMOJI_RE = /\p{Extended_Pictographic}|\u{FE0F}|\u{200D}|\u{20E3}/gu;
/** 日本語の文字に隣り合う空白。記号を落とした跡に残る「は にあります」の類を詰める */
const CJK = "[\\u3000-\\u30ff\\u3400-\\u9fff\\uff00-\\uffef]";
const SPACE_NEAR_CJK_RE = new RegExp(`\\s+(?=${CJK})|(?<=${CJK})\\s+`, "g");

function shortenPath(match: string): string {
  // 日付 (2026/09/19) のように英字を含まないものはパスとみなさない
  if (!/[A-Za-z]/.test(match)) return match;
  const withoutLine = match.replace(/(?::\d+)+$/, "");
  return withoutLine.split("/").filter(Boolean).at(-1) ?? "";
}

function cleanLine(line: string): string {
  return line
    .replace(HEADING_RE, "")
    .replace(QUOTE_RE, "")
    .replace(LIST_RE, "")
    .replace(IMAGE_RE, "")
    .replace(LINK_RE, "$1")
    .replace(URL_RE, "")
    .replace(INLINE_CODE_RE, (_match, code: string) => {
      const shortened = code.replace(PATH_RE, shortenPath);
      return shortened.length <= INLINE_CODE_MAX ? shortened : "";
    })
    .replace(PATH_RE, shortenPath)
    .replace(/`/g, "")
    .replace(EMPHASIS_RE, "")
    .replace(EMOJI_RE, "")
    .replace(/\s+/g, " ")
    .replace(SPACE_NEAR_CJK_RE, "")
    .trim();
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?])/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 0);
}

function fitToBudget(segments: string[], maxChars: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const segment of segments) {
    if (used + segment.length > maxChars) {
      if (out.length === 0) out.push(segment.slice(0, maxChars));
      out.push(CONTINUED_SUFFIX);
      return out;
    }
    out.push(segment);
    used += segment.length;
  }
  return out;
}

/** Claude の返答 (Markdown) を、読み上げる文の配列に変える。読むものが無ければ空配列 */
export function toSpeechSentences(
  markdown: string,
  maxChars: number = SPEECH_MAX_CHARS
): string[] {
  const segments: string[] = [];
  const pushPlaceholder = (placeholder: string) => {
    if (segments.at(-1) !== placeholder) segments.push(placeholder);
  };
  let inFence = false;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (FENCE_RE.test(line)) {
      if (!inFence) pushPlaceholder(CODE_PLACEHOLDER);
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (TABLE_RE.test(line)) {
      pushPlaceholder(TABLE_PLACEHOLDER);
      continue;
    }
    if (RULE_RE.test(line)) continue;
    const cleaned = cleanLine(line);
    if (cleaned) segments.push(...splitSentences(cleaned));
  }
  return fitToBudget(segments, maxChars);
}

/** 質問 (AskUserQuestion) を読み上げる文にする。回答は画面で行うよう最後に案内する */
export function questionsToSpeechSentences(
  questions: readonly {
    question: string;
    options: readonly { label: string }[];
  }[]
): string[] {
  const out = ["Claudeから質問です。"];
  for (const q of questions) {
    out.push(...splitSentences(cleanLine(q.question)));
    const labels = q.options
      .map(option => cleanLine(option.label))
      .filter(Boolean);
    if (labels.length > 0) out.push(`選択肢は、${labels.join("、")}。`);
  }
  out.push(ANSWER_ON_SCREEN);
  return out;
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `pnpm exec vitest run packages/web/src/lib/speech-text.test.ts`
Expected: PASS (13 tests)

Biomeの `noControlCharactersInRegex` / `noMisleadingCharacterClass` に掛かった場合は、`pnpm exec biome check packages/web/src/lib/speech-text.ts` の指摘に従い、正規表現を同じ意味のまま書き換える (文字クラスに結合文字を入れず、選択 `|` で並べる)。

- [ ] **Step 5: コミット**

```bash
git add packages/web/src/lib/speech-text.ts packages/web/src/lib/speech-text.test.ts
git commit -m "feat(web): 返答を読み上げ用の文に変える"
```

---

### Task 2: ターンの終わりの検出 (`endTurn` と `voice-turn-signals.ts`)

**Files:**
- Modify: `packages/web/src/lib/jsonl-event-parser.ts` (型 `JsonlParsedEvent` の `assistant-text`、`RawJsonlMessage.message`、`mergeJsonlLine` の assistant 分岐)
- Test: `packages/web/src/lib/jsonl-event-parser.test.ts` (末尾に追記)
- Create: `packages/web/src/lib/voice-turn-signals.ts`
- Test: `packages/web/src/lib/voice-turn-signals.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `JsonlParsedEvent` の `assistant-text` に `endTurn?: boolean`
  - `interface TurnEndCursor { readonly seen: ReadonlySet<string> }`
  - `interface TurnEnd { ids: string[]; text: string }`
  - `createTurnEndCursor(events: readonly JsonlParsedEvent[]): TurnEndCursor`
  - `scanTurnEnds(cursor: TurnEndCursor, events: readonly JsonlParsedEvent[]): { cursor: TurnEndCursor; turnEnd: TurnEnd | null }`

- [ ] **Step 1: パーサーの失敗するテストを書く**

`packages/web/src/lib/jsonl-event-parser.test.ts` の末尾に追記 (`parseJsonlEvents` は既にimport済み):

```ts
describe("assistant-text の endTurn", () => {
  it("stop_reason が end_turn の本文にだけ endTurn を立てる", () => {
    const record = (uuid: string, stopReason: string | null) => ({
      uuid,
      type: "assistant",
      message: {
        role: "assistant",
        stop_reason: stopReason,
        content: [{ type: "text", text: "本文" }],
      },
    });
    const events = parseJsonlEvents([
      JSON.stringify(record("a1", "end_turn")),
      JSON.stringify(record("a2", "tool_use")),
      JSON.stringify(record("a3", null)),
    ]);
    expect(
      events.map(e => (e.kind === "assistant-text" ? e.endTurn : "other"))
    ).toEqual([true, undefined, undefined]);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `pnpm exec vitest run packages/web/src/lib/jsonl-event-parser.test.ts`
Expected: FAIL (`expected [ undefined, undefined, undefined ] to deeply equal [ true, undefined, undefined ]`。型エラーはvitestでは出ない)

- [ ] **Step 3: パーサーを変える**

`packages/web/src/lib/jsonl-event-parser.ts` で3か所を変える。

型の `assistant-text` を次に置き換える:

```ts
  | ({
      id: string;
      kind: "assistant-text";
      text: string;
      /**
       * このレコードの `message.stop_reason` が `"end_turn"` (Claude がターンを終えた最後の返答)。
       * `"tool_use"` の本文 (ツール実行の合間の独り言) では立たない。音声モードが読み上げの合図に使う
       */
      endTurn?: boolean;
    } & CommonEventFields)
```

`RawJsonlMessage` の `message` に `stop_reason` を足す (`role?: string;` の次の行):

```ts
    /** "end_turn" / "tool_use" など。ストリーミング途中のレコードでは null のことがある */
    stop_reason?: string | null;
```

`mergeJsonlLine` の assistant 分岐 (`} else if (obj.type === "assistant" && obj.message?.role === "assistant") {`) で、`const content = obj.message.content;` の次の行に足す:

```ts
    const endTurn = obj.message.stop_reason === "end_turn" ? true : undefined;
```

同じ分岐の `assistant-text` を push している箇所を次に置き換える:

```ts
          pushIfNew({
            id: `${uuid}:a:${idx}`,
            kind: "assistant-text",
            text: block.text,
            endTurn,
            timestamp: ts,
            isSidechain: sc,
          });
```

- [ ] **Step 4: パーサーのテストが通ることを確かめる**

Run: `pnpm exec vitest run packages/web/src/lib/jsonl-event-parser.test.ts`
Expected: PASS (既存のテストも含めてすべて)

- [ ] **Step 5: ターンの終わりの検出の失敗するテストを書く**

`packages/web/src/lib/voice-turn-signals.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { JsonlParsedEvent } from "./jsonl-event-parser";
import { createTurnEndCursor, scanTurnEnds } from "./voice-turn-signals";

const user = (id: string): JsonlParsedEvent => ({
  id,
  kind: "user-input",
  text: "指示",
});
const reply = (
  id: string,
  text: string,
  options: { endTurn?: boolean; isSidechain?: boolean; timestamp?: number } = {}
): JsonlParsedEvent => ({
  id,
  kind: "assistant-text",
  text,
  endTurn: options.endTurn === false ? undefined : true,
  isSidechain: options.isSidechain,
  timestamp: options.timestamp,
});
const tool = (id: string): JsonlParsedEvent => ({
  id,
  kind: "tool-call",
  tool: "Bash",
  input: {},
  status: "done",
  toolUseId: id,
});

describe("scanTurnEnds", () => {
  it("入った時点の履歴は読まない", () => {
    const events = [user("u1"), reply("a1", "前の返答")];
    const cursor = createTurnEndCursor(events);
    expect(scanTurnEnds(cursor, events).turnEnd).toBeNull();
  });

  it("入った後に届いたターンの終わりを読む", () => {
    const before = [user("u1"), reply("a1", "前の返答")];
    const cursor = createTurnEndCursor(before);
    const after = [...before, user("u2"), tool("t1"), reply("a2", "直しました")];
    expect(scanTurnEnds(cursor, after).turnEnd).toEqual({
      ids: ["a2"],
      text: "直しました",
    });
  });

  it("ツール実行の合間の独り言 (end_turn でない本文) は読まない", () => {
    const cursor = createTurnEndCursor([user("u1")]);
    const events = [
      user("u1"),
      reply("n1", "見てみます", { endTurn: false }),
      tool("t1"),
    ];
    expect(scanTurnEnds(cursor, events).turnEnd).toBeNull();
  });

  it("subagent の発言は読まない", () => {
    const cursor = createTurnEndCursor([user("u1")]);
    const events = [
      user("u1"),
      reply("s1", "subagentの返答", { isSidechain: true }),
    ];
    expect(scanTurnEnds(cursor, events).turnEnd).toBeNull();
  });

  it("同じ返答を二度読まない", () => {
    const cursor = createTurnEndCursor([user("u1")]);
    const events = [user("u1"), reply("a1", "返答")];
    const first = scanTurnEnds(cursor, events);
    expect(first.turnEnd?.text).toBe("返答");
    expect(scanTurnEnds(first.cursor, events).turnEnd).toBeNull();
  });

  it("過去履歴の追加読み込みで先頭に足された返答は読まない", () => {
    const cursor = createTurnEndCursor([user("u1"), reply("a1", "返答")]);
    const withOlder = [
      user("u0"),
      reply("a0", "もっと前の返答"),
      user("u1"),
      reply("a1", "返答"),
    ];
    expect(scanTurnEnds(cursor, withOlder).turnEnd).toBeNull();
  });

  it("timestamp が前後していても、位置が後ろなら読む", () => {
    const cursor = createTurnEndCursor([
      user("u1"),
      tool("t1"),
      reply("a1", "前", { timestamp: 2000 }),
    ]);
    const events = [
      user("u1"),
      tool("t1"),
      reply("a1", "前", { timestamp: 2000 }),
      user("u2"),
      reply("a2", "新しい返答", { timestamp: 1000 }),
    ];
    expect(scanTurnEnds(cursor, events).turnEnd?.text).toBe("新しい返答");
  });

  it("/clear の空snapshotの後に届いた返答を読む", () => {
    const cursor = createTurnEndCursor([user("u1"), reply("a1", "返答")]);
    const cleared = scanTurnEnds(cursor, []);
    expect(cleared.turnEnd).toBeNull();
    const fresh = [user("n1"), reply("n2", "新しいファイルの返答")];
    expect(scanTurnEnds(cleared.cursor, fresh).turnEnd?.text).toBe(
      "新しいファイルの返答"
    );
  });

  it("再接続のsnapshotでは、切断中に届いた返答を読む", () => {
    const cursor = createTurnEndCursor([user("u1"), reply("a1", "返答")]);
    const snapshot = [
      user("u1"),
      reply("a1", "返答"),
      user("u2"),
      reply("a2", "切断中の返答"),
    ];
    expect(scanTurnEnds(cursor, snapshot).turnEnd?.text).toBe("切断中の返答");
  });

  it("一度に複数のターンの終わりが届いたら、最後のターンだけを読む", () => {
    const cursor = createTurnEndCursor([user("u1")]);
    const events = [
      user("u1"),
      reply("a1", "一つ目"),
      user("u2"),
      reply("a2", "二つ目"),
    ];
    expect(scanTurnEnds(cursor, events).turnEnd).toEqual({
      ids: ["a2"],
      text: "二つ目",
    });
  });

  it("最後の返答が複数の本文に分かれていれば、つないで読む", () => {
    const cursor = createTurnEndCursor([user("u1")]);
    const events = [user("u1"), reply("b1", "前半"), reply("b2", "後半")];
    expect(scanTurnEnds(cursor, events).turnEnd).toEqual({
      ids: ["b1", "b2"],
      text: "前半\n\n後半",
    });
  });
});
```

- [ ] **Step 6: 失敗を確かめる**

Run: `pnpm exec vitest run packages/web/src/lib/voice-turn-signals.test.ts`
Expected: FAIL (`Failed to resolve import "./voice-turn-signals"`)

- [ ] **Step 7: 実装する**

`packages/web/src/lib/voice-turn-signals.ts`:

```ts
/**
 * voice-turn-signals - JSONL のイベント列から、音声モードに入った後の「ターンの終わり」を拾う。
 *
 * ターンの終わり = `stop_reason: "end_turn"` の返答本文 (`endTurn`)。subagent の発言と、
 * ツール実行の合間の独り言 (`stop_reason: "tool_use"`) は読まない。
 *
 * 「入った後」は時刻ではなく配列上の位置で決める。JSONL の timestamp は単調でなく、
 * 実データで end_turn の返答が先行する tool_result より古い時刻を持っていたため。
 * - 入った時点で配列にあるidをすべて既読にする
 * - 既読idのうち配列で最も後ろにあるものより後ろにある未読idを新規とする
 *   (過去履歴の追加読み込みで先頭に足された分は新規にならない)
 * - 既読idが1つも無いとき (/clear の空snapshotの後) は未読idをすべて新規とする
 * - 新規の中にターンの終わりが複数あれば、最後のターンだけを返す (長い切断からの復帰など)
 *
 * 仕様: docs/superpowers/specs/2026-09-19-voice-mode-design.md の5章
 */

import type { JsonlParsedEvent } from "./jsonl-event-parser";

export interface TurnEndCursor {
  readonly seen: ReadonlySet<string>;
}

export interface TurnEnd {
  /** 読み上げる返答のイベントid (最後の返答が複数の本文に分かれていれば複数) */
  ids: string[];
  text: string;
}

type AssistantText = Extract<JsonlParsedEvent, { kind: "assistant-text" }>;

export function createTurnEndCursor(
  events: readonly JsonlParsedEvent[]
): TurnEndCursor {
  return { seen: new Set(events.map(event => event.id)) };
}

function isSpeakableTurnEnd(event: JsonlParsedEvent): event is AssistantText {
  return (
    event.kind === "assistant-text" &&
    event.endTurn === true &&
    event.isSidechain !== true &&
    event.text.trim() !== ""
  );
}

/** ここより前の返答は別のターン。最後の返答をつなぐときに越えない */
function isTurnBoundary(event: JsonlParsedEvent): boolean {
  if (event.isSidechain === true) return false;
  if (event.kind === "assistant-text") return event.endTurn !== true;
  return (
    event.kind === "user-input" ||
    event.kind === "slash-command" ||
    event.kind === "tool-call" ||
    event.kind === "compact-marker"
  );
}

export function scanTurnEnds(
  cursor: TurnEndCursor,
  events: readonly JsonlParsedEvent[]
): { cursor: TurnEndCursor; turnEnd: TurnEnd | null } {
  let lastSeen = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (cursor.seen.has(events[i].id)) {
      lastSeen = i;
      break;
    }
  }
  const fresh = events
    .slice(lastSeen + 1)
    .filter(event => !cursor.seen.has(event.id));
  if (fresh.length === 0) return { cursor, turnEnd: null };

  const seen = new Set(cursor.seen);
  for (const event of events) seen.add(event.id);
  const next: TurnEndCursor = { seen };

  let end = -1;
  for (let i = fresh.length - 1; i >= 0; i--) {
    if (isSpeakableTurnEnd(fresh[i])) {
      end = i;
      break;
    }
  }
  if (end < 0) return { cursor: next, turnEnd: null };

  const picked: AssistantText[] = [];
  for (let i = end; i >= 0; i--) {
    const event = fresh[i];
    if (isSpeakableTurnEnd(event)) picked.unshift(event);
    else if (isTurnBoundary(event)) break;
  }
  return {
    cursor: next,
    turnEnd: {
      ids: picked.map(event => event.id),
      text: picked.map(event => event.text).join("\n\n"),
    },
  };
}
```

- [ ] **Step 8: 通ることを確かめる**

Run: `pnpm exec vitest run packages/web/src/lib/voice-turn-signals.test.ts packages/web/src/lib/jsonl-event-parser.test.ts`
Expected: PASS

- [ ] **Step 9: コミット**

```bash
git add packages/web/src/lib/jsonl-event-parser.ts packages/web/src/lib/jsonl-event-parser.test.ts packages/web/src/lib/voice-turn-signals.ts packages/web/src/lib/voice-turn-signals.test.ts
git commit -m "feat(web): JSONLからClaudeがターンを終えた返答を拾う"
```

---

### Task 3: 状態遷移 (`voice-mode-machine.ts`)

**Files:**
- Create: `packages/web/src/lib/voice-mode-machine.ts`
- Test: `packages/web/src/lib/voice-mode-machine.test.ts`

**Interfaces:**
- Consumes: Task 1 の `CONFIRM_ON_SCREEN` / `REPLY_ON_SCREEN`
- Produces:
  - `type VoicePhase = "off" | "ready" | "listening" | "confirming" | "working" | "speaking" | "screen"`
  - `type AfterSpeech = "listen" | "ready" | "screen"`
  - `interface VoiceState { phase; transcript: string; confirmDeadline: number | null; speaking: string[]; afterSpeech: AfterSpeech; heldSpeech: string[]; notice: string | null }`
  - `type SendGuard = "awaiting" | "disconnected" | null`
  - `type VoiceAction` / `type VoiceEffect` (下のコードのとおり)
  - `const CONFIRM_MS = 2000`、`const INITIAL_VOICE_STATE: VoiceState`
  - `reduceVoice(state: VoiceState, action: VoiceAction): { state: VoiceState; effects: VoiceEffect[] }`
  - `recognitionErrorNotice(error: string, auto: boolean): string | null`

- [ ] **Step 1: 失敗するテストを書く**

`packages/web/src/lib/voice-mode-machine.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CONFIRM_ON_SCREEN, REPLY_ON_SCREEN } from "./speech-text";
import {
  CONFIRM_MS,
  INITIAL_VOICE_STATE,
  reduceVoice,
  type VoiceAction,
  type VoiceEffect,
  type VoiceState,
} from "./voice-mode-machine";

/** actions を順に流し、最後の状態と、最後の action が出した副作用を返す */
function run(
  state: VoiceState,
  ...actions: VoiceAction[]
): { state: VoiceState; effects: VoiceEffect[] } {
  let current = state;
  let effects: VoiceEffect[] = [];
  for (const action of actions) {
    const next = reduceVoice(current, action);
    current = next.state;
    effects = next.effects;
  }
  return { state: current, effects };
}

const NOW = 1_000_000;
const listening = run(INITIAL_VOICE_STATE, { type: "enter" }).state;
const confirming = run(listening, {
  type: "final",
  text: "テストを直して",
  now: NOW,
}).state;
const working = run(confirming, { type: "commit", guard: null }).state;
const speakingReply = run(working, {
  type: "turnEnd",
  sentences: ["直しました。"],
}).state;

describe("reduceVoice", () => {
  it("入ると、読み上げの解錠・画面の点灯維持・認識の開始をこの順に指示する", () => {
    const { state, effects } = run(INITIAL_VOICE_STATE, { type: "enter" });
    expect(state.phase).toBe("listening");
    expect(effects).toEqual([
      { type: "unlockSpeech" },
      { type: "requestWakeLock" },
      { type: "startRecognition", auto: false },
    ]);
  });

  it("音声モードの外では入る以外の入力を無視する", () => {
    const { state, effects } = run(INITIAL_VOICE_STATE, { type: "tapMic" });
    expect(state).toBe(INITIAL_VOICE_STATE);
    expect(effects).toEqual([]);
  });

  it("認識が確定したら、2秒の送信待ちに入る", () => {
    expect(confirming.phase).toBe("confirming");
    expect(confirming.transcript).toBe("テストを直して");
    expect(confirming.confirmDeadline).toBe(NOW + CONFIRM_MS);
  });

  it("空の確定は待機に戻る", () => {
    const { state } = run(listening, { type: "final", text: "  ", now: NOW });
    expect(state.phase).toBe("ready");
  });

  it("無音が続いたら途中結果で確定し、認識を止める", () => {
    const { state, effects } = run(
      listening,
      { type: "interim", text: "途中まで" },
      { type: "silence", now: NOW }
    );
    expect(state.phase).toBe("confirming");
    expect(state.transcript).toBe("途中まで");
    expect(effects).toEqual([{ type: "stopRecognition" }]);
  });

  it("認識が何も聞き取らずに終わったら待機、途中結果があれば送信待ち", () => {
    expect(
      run(listening, { type: "recognitionEnd", now: NOW }).state.phase
    ).toBe("ready");
    expect(
      run(
        listening,
        { type: "interim", text: "途中" },
        { type: "recognitionEnd", now: NOW }
      ).state.phase
    ).toBe("confirming");
  });

  it("送信待ち中に遅れて確定が届いたら、文を置き換えて2秒を取り直す", () => {
    const { state } = run(confirming, {
      type: "final",
      text: "テストを直してから出して",
      now: NOW + 500,
    });
    expect(state.transcript).toBe("テストを直してから出して");
    expect(state.confirmDeadline).toBe(NOW + 500 + CONFIRM_MS);
  });

  it("送ると作業中になり、認識を捨ててから送信を指示する", () => {
    const { state, effects } = run(confirming, { type: "commit", guard: null });
    expect(state.phase).toBe("working");
    expect(effects).toEqual([
      { type: "abortRecognition" },
      { type: "send", text: "テストを直して" },
    ]);
  });

  it("送る直前に確認が出ていたら送らず、画面での操作へ案内する", () => {
    const held = run(confirming, { type: "commit", guard: "awaiting" });
    expect(held.effects).not.toContainEqual({
      type: "send",
      text: "テストを直して",
    });
    expect(held.state.phase).toBe("speaking");
    expect(held.state.speaking).toEqual([CONFIRM_ON_SCREEN]);
    expect(held.state.notice).toBe("送っていません:「テストを直して」");
    const done = run(held.state, { type: "speechDone" });
    expect(done.state.phase).toBe("screen");
    expect(run(done.state, { type: "screenResolved" }).state.phase).toBe(
      "working"
    );
  });

  it("接続が切れていたら送らず、文を画面に残して待機に戻る", () => {
    const { state, effects } = run(confirming, {
      type: "commit",
      guard: "disconnected",
    });
    expect(state.phase).toBe("ready");
    expect(state.notice).toBe(
      "接続が切れているため送っていません:「テストを直して」"
    );
    expect(effects).toEqual([{ type: "abortRecognition" }]);
  });

  it("取り消すと待機に戻り、認識を捨てる", () => {
    const { state, effects } = run(confirming, { type: "cancel" });
    expect(state.phase).toBe("ready");
    expect(effects).toEqual([{ type: "abortRecognition" }]);
  });

  it("作業中にターンの終わりが届いたら読み上げ、読み終えたら自動で聞き取りを試す", () => {
    expect(speakingReply.phase).toBe("speaking");
    expect(speakingReply.speaking).toEqual(["直しました。"]);
    const { state, effects } = run(speakingReply, { type: "speechDone" });
    expect(state.phase).toBe("listening");
    expect(effects).toEqual([{ type: "startRecognition", auto: true }]);
  });

  it("自動の聞き取りをiOSに拒否されたら、何も言わずに待機に落ちる", () => {
    const auto = run(speakingReply, { type: "speechDone" }).state;
    const { state } = run(auto, {
      type: "recognitionError",
      error: "not-allowed",
      auto: true,
    });
    expect(state.phase).toBe("ready");
    expect(state.notice).toBeNull();
  });

  it("タップで始めた聞き取りが拒否されたら、設定を確かめるよう出す", () => {
    const { state } = run(listening, {
      type: "recognitionError",
      error: "not-allowed",
      auto: false,
    });
    expect(state.phase).toBe("ready");
    expect(state.notice).toContain("iPhoneの設定");
  });

  it("聞き取り中に届いたターンの終わりは溜め、聞き取りが終わってから読む", () => {
    const held = run(listening, {
      type: "turnEnd",
      sentences: ["別の返答。"],
    }).state;
    expect(held.phase).toBe("listening");
    expect(held.heldSpeech).toEqual(["別の返答。"]);
    const { state, effects } = run(held, { type: "recognitionEnd", now: NOW });
    expect(state.phase).toBe("speaking");
    expect(effects).toEqual([{ type: "speak", sentences: ["別の返答。"] }]);
  });

  it("読み上げ中に届いたターンの終わりは後ろに続ける", () => {
    const { state, effects } = run(speakingReply, {
      type: "turnEnd",
      sentences: ["続きです。"],
    });
    expect(state.speaking).toEqual(["直しました。", "続きです。"]);
    expect(effects).toEqual([{ type: "speak", sentences: ["続きです。"] }]);
  });

  it("読み上げ中にタップすると止めて待機に戻る", () => {
    const { state, effects } = run(speakingReply, { type: "stopSpeaking" });
    expect(state.phase).toBe("ready");
    expect(effects).toEqual([{ type: "cancelSpeech" }]);
  });

  it("質問が来たら読み上げ、読み終えたら画面での操作へ移る", () => {
    const asked = run(working, {
      type: "question",
      sentences: ["Claudeから質問です。"],
    }).state;
    expect(asked.phase).toBe("speaking");
    expect(asked.afterSpeech).toBe("screen");
    expect(run(asked, { type: "speechDone" }).state.phase).toBe("screen");
  });

  it("送信待ち中に質問が来たら送らず、認識を捨てて質問を読む", () => {
    const { state, effects } = run(confirming, {
      type: "question",
      sentences: ["Claudeから質問です。"],
    });
    expect(state.phase).toBe("speaking");
    expect(state.notice).toBe("送っていません:「テストを直して」");
    expect(effects).toEqual([
      { type: "abortRecognition" },
      { type: "speak", sentences: ["Claudeから質問です。"] },
    ]);
  });

  it("作業中に権限確認が出たら、画面での確認が要ると言って画面での操作へ移る", () => {
    const { state } = run(working, { type: "awaiting" });
    expect(state.speaking).toEqual([CONFIRM_ON_SCREEN]);
    expect(state.afterSpeech).toBe("screen");
    expect(run(listening, { type: "awaiting" }).state.phase).toBe("listening");
  });

  it("作業中なのに止まったままなら、返答は画面でと言って待機に戻る", () => {
    const settled = run(working, { type: "settled" }).state;
    expect(settled.speaking).toEqual([REPLY_ON_SCREEN]);
    expect(run(settled, { type: "speechDone" }).state.phase).toBe("ready");
  });

  it("作業中でも話せる", () => {
    const { state, effects } = run(working, { type: "tapMic" });
    expect(state.phase).toBe("listening");
    expect(effects).toEqual([{ type: "startRecognition", auto: false }]);
  });

  it("畳んだ帯をタップすると待機に戻る", () => {
    const screen = run(
      working,
      { type: "awaiting" },
      { type: "speechDone" }
    ).state;
    expect(screen.phase).toBe("screen");
    expect(run(screen, { type: "expand" }).state.phase).toBe("ready");
  });

  it("画面が隠れたら認識と読み上げを止めて待機にする", () => {
    const { state, effects } = run(speakingReply, { type: "hidden" });
    expect(state.phase).toBe("ready");
    expect(effects).toEqual([
      { type: "abortRecognition" },
      { type: "cancelSpeech" },
    ]);
  });

  it("終えると、認識・読み上げ・画面の点灯維持をすべて止める", () => {
    const { state, effects } = run(speakingReply, { type: "exit" });
    expect(state).toEqual(INITIAL_VOICE_STATE);
    expect(effects).toEqual([
      { type: "abortRecognition" },
      { type: "cancelSpeech" },
      { type: "releaseWakeLock" },
    ]);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `pnpm exec vitest run packages/web/src/lib/voice-mode-machine.test.ts`
Expected: FAIL (`Failed to resolve import "./voice-mode-machine"`)

- [ ] **Step 3: 実装する**

`packages/web/src/lib/voice-mode-machine.ts`:

```ts
/**
 * voice-mode-machine - 音声モードの状態遷移 (純関数)。
 *
 * 状態と入力 (タップ、認識結果、ターンの終わり、質問、読み上げ終了、画面の表示状態) から、
 * 次の状態と「実行してほしい副作用」の列を返す。副作用 (認識の開始、読み上げ、送信) は
 * useVoiceMode が同期的に実行する。iOS はユーザー操作の中でしか認識と読み上げを
 * 始めさせないため、タップ → reducer → 副作用 が同じ呼び出しの中で終わる必要がある。
 *
 * 仕様: docs/superpowers/specs/2026-09-19-voice-mode-design.md の4章
 */

import { CONFIRM_ON_SCREEN, REPLY_ON_SCREEN } from "./speech-text";

export type VoicePhase =
  | "off"
  | "ready"
  | "listening"
  | "confirming"
  | "working"
  | "speaking"
  | "screen";

/** 読み上げが終わった後に移る先 */
export type AfterSpeech = "listen" | "ready" | "screen";

export interface VoiceState {
  phase: VoicePhase;
  /** 聞き取り中は途中結果、送信待ちでは送る文 */
  transcript: string;
  /** 送信待ちの締め切り (端末の時計の ms)。送信待ち以外は null */
  confirmDeadline: number | null;
  /** 読み上げている文 (画面に出す) */
  speaking: string[];
  afterSpeech: AfterSpeech;
  /** 聞き取り中・送信待ちに届いたターンの終わり。抜けた後に読む */
  heldSpeech: string[];
  /** 画面に出す一言 (エラー、送らなかった理由)。無ければ null */
  notice: string | null;
}

/** 送信待ちの猶予 */
export const CONFIRM_MS = 2000;

/**
 * 送る直前の確認の結果。null なら送ってよい。
 * `session:send` は無条件に C-u → 文字 → Enter を打つので、権限確認や質問が出ている最中に
 * 送るとその Enter が選択肢を確定させてしまう。切断中に送ると Socket.IO が溜めて前後して届く
 */
export type SendGuard = "awaiting" | "disconnected" | null;

export type VoiceAction =
  | { type: "enter" }
  | { type: "exit" }
  | { type: "hidden" }
  | { type: "tapMic" }
  | { type: "interim"; text: string }
  | { type: "final"; text: string; now: number }
  | { type: "silence"; now: number }
  | { type: "recognitionEnd"; now: number }
  | { type: "recognitionError"; error: string; auto: boolean }
  | { type: "cancel" }
  | { type: "commit"; guard: SendGuard }
  | { type: "turnEnd"; sentences: string[] }
  | { type: "question"; sentences: string[] }
  | { type: "awaiting" }
  | { type: "settled" }
  | { type: "speechDone" }
  | { type: "stopSpeaking" }
  | { type: "screenResolved" }
  | { type: "expand" };

export type VoiceEffect =
  /** auto: 読み上げの後に自動で開くとき true (ユーザー操作の外なので iOS に拒否されうる) */
  | { type: "startRecognition"; auto: boolean }
  | { type: "stopRecognition" }
  | { type: "abortRecognition" }
  | { type: "unlockSpeech" }
  | { type: "speak"; sentences: string[] }
  | { type: "cancelSpeech" }
  | { type: "send"; text: string }
  | { type: "requestWakeLock" }
  | { type: "releaseWakeLock" };

export const INITIAL_VOICE_STATE: VoiceState = {
  phase: "off",
  transcript: "",
  confirmDeadline: null,
  speaking: [],
  afterSpeech: "listen",
  heldSpeech: [],
  notice: null,
};

interface Transition {
  state: VoiceState;
  effects: VoiceEffect[];
}

const unchanged = (state: VoiceState): Transition => ({ state, effects: [] });

function notSentNotice(text: string): string {
  return `送っていません:「${text}」`;
}

function speak(
  state: VoiceState,
  sentences: string[],
  afterSpeech: AfterSpeech,
  effects: VoiceEffect[] = [],
  notice: string | null = null
): Transition {
  return {
    state: {
      ...state,
      phase: "speaking",
      transcript: "",
      confirmDeadline: null,
      speaking: sentences,
      afterSpeech,
      notice,
    },
    effects: [...effects, { type: "speak", sentences }],
  };
}

/** 待機へ。溜めていた返答があれば、待機ではなく読み上げに入る */
function toReady(
  state: VoiceState,
  effects: VoiceEffect[] = [],
  notice: string | null = null
): Transition {
  if (state.heldSpeech.length > 0) {
    return speak(
      { ...state, heldSpeech: [] },
      state.heldSpeech,
      "listen",
      effects,
      notice
    );
  }
  return {
    state: {
      ...state,
      phase: "ready",
      transcript: "",
      confirmDeadline: null,
      speaking: [],
      notice,
    },
    effects,
  };
}

function confirm(
  state: VoiceState,
  text: string,
  now: number,
  effects: VoiceEffect[] = []
): Transition {
  return {
    state: {
      ...state,
      phase: "confirming",
      transcript: text,
      confirmDeadline: now + CONFIRM_MS,
      notice: null,
    },
    effects,
  };
}

/** 認識のエラーを画面の一言にする。黙って待機に戻せばよいものは null */
export function recognitionErrorNotice(
  error: string,
  auto: boolean
): string | null {
  switch (error) {
    case "no-speech":
    case "aborted":
      return null;
    case "not-allowed":
    case "service-not-allowed":
      // 読み上げの後に自動で開こうとして拒否されたのは想定内。タップを待つだけ
      return auto
        ? null
        : "マイクか音声入力が許可されていません。iPhoneの設定で、Safariのマイクと音声入力 (Siri) を確かめてください";
    case "network":
      return "音声認識につながりません (network)";
    case "audio-capture":
      return "マイクが使えません (audio-capture)";
    default:
      return `音声認識が止まりました (${error})`;
  }
}

export function reduceVoice(
  state: VoiceState,
  action: VoiceAction
): Transition {
  if (action.type === "enter") {
    if (state.phase !== "off") return unchanged(state);
    return {
      state: { ...INITIAL_VOICE_STATE, phase: "listening" },
      effects: [
        { type: "unlockSpeech" },
        { type: "requestWakeLock" },
        { type: "startRecognition", auto: false },
      ],
    };
  }
  if (state.phase === "off") return unchanged(state);

  switch (action.type) {
    case "exit":
      return {
        state: INITIAL_VOICE_STATE,
        effects: [
          { type: "abortRecognition" },
          { type: "cancelSpeech" },
          { type: "releaseWakeLock" },
        ],
      };
    case "hidden":
      return toReady({ ...state, heldSpeech: [] }, [
        { type: "abortRecognition" },
        { type: "cancelSpeech" },
      ]);
    case "tapMic":
      if (state.phase !== "ready" && state.phase !== "working") {
        return unchanged(state);
      }
      return {
        state: { ...state, phase: "listening", transcript: "", notice: null },
        effects: [{ type: "startRecognition", auto: false }],
      };
    case "interim":
      if (state.phase !== "listening") return unchanged(state);
      return { state: { ...state, transcript: action.text }, effects: [] };
    case "final": {
      const text = action.text.trim();
      if (state.phase === "listening") {
        return text ? confirm(state, text, action.now) : toReady(state);
      }
      if (state.phase === "confirming" && text) {
        return confirm(state, text, action.now);
      }
      return unchanged(state);
    }
    case "silence": {
      const text = state.transcript.trim();
      if (state.phase !== "listening" || !text) return unchanged(state);
      return confirm(state, text, action.now, [{ type: "stopRecognition" }]);
    }
    case "recognitionEnd": {
      if (state.phase !== "listening") return unchanged(state);
      const text = state.transcript.trim();
      return text ? confirm(state, text, action.now) : toReady(state);
    }
    case "recognitionError":
      if (state.phase !== "listening") return unchanged(state);
      return toReady(
        state,
        [],
        recognitionErrorNotice(action.error, action.auto)
      );
    case "cancel":
      if (state.phase !== "listening" && state.phase !== "confirming") {
        return unchanged(state);
      }
      return toReady(state, [{ type: "abortRecognition" }]);
    case "commit": {
      if (state.phase !== "confirming") return unchanged(state);
      const text = state.transcript;
      const stop: VoiceEffect = { type: "abortRecognition" };
      if (action.guard === "awaiting") {
        return speak(
          state,
          [CONFIRM_ON_SCREEN],
          "screen",
          [stop],
          notSentNotice(text)
        );
      }
      if (action.guard === "disconnected") {
        return toReady(
          state,
          [stop],
          `接続が切れているため送っていません:「${text}」`
        );
      }
      const sent: VoiceEffect[] = [stop, { type: "send", text }];
      if (state.heldSpeech.length > 0) {
        return speak(
          { ...state, heldSpeech: [] },
          state.heldSpeech,
          "listen",
          sent
        );
      }
      return {
        state: {
          ...state,
          phase: "working",
          transcript: "",
          confirmDeadline: null,
          notice: null,
        },
        effects: sent,
      };
    }
    case "turnEnd":
      if (action.sentences.length === 0) return unchanged(state);
      if (state.phase === "listening" || state.phase === "confirming") {
        return {
          state: {
            ...state,
            heldSpeech: [...state.heldSpeech, ...action.sentences],
          },
          effects: [],
        };
      }
      if (state.phase === "speaking") {
        return {
          state: {
            ...state,
            speaking: [...state.speaking, ...action.sentences],
            afterSpeech: "listen",
          },
          effects: [{ type: "speak", sentences: action.sentences }],
        };
      }
      return speak(state, action.sentences, "listen");
    case "question": {
      if (action.sentences.length === 0) return unchanged(state);
      if (state.phase === "speaking") {
        return {
          state: {
            ...state,
            speaking: [...state.speaking, ...action.sentences],
            afterSpeech: "screen",
          },
          effects: [{ type: "speak", sentences: action.sentences }],
        };
      }
      const interrupted =
        state.phase === "listening" || state.phase === "confirming";
      return speak(
        state,
        action.sentences,
        "screen",
        interrupted ? [{ type: "abortRecognition" }] : [],
        state.phase === "confirming" ? notSentNotice(state.transcript) : null
      );
    }
    case "awaiting":
      if (state.phase !== "working") return unchanged(state);
      return speak(state, [CONFIRM_ON_SCREEN], "screen");
    case "settled":
      if (state.phase !== "working") return unchanged(state);
      return speak(state, [REPLY_ON_SCREEN], "ready");
    case "speechDone":
      if (state.phase !== "speaking") return unchanged(state);
      if (state.afterSpeech === "listen") {
        return {
          state: {
            ...state,
            phase: "listening",
            transcript: "",
            speaking: [],
            notice: null,
          },
          effects: [{ type: "startRecognition", auto: true }],
        };
      }
      if (state.afterSpeech === "screen") {
        return { state: { ...state, phase: "screen", speaking: [] }, effects: [] };
      }
      return toReady(state, [], state.notice);
    case "stopSpeaking":
      if (state.phase !== "speaking") return unchanged(state);
      if (state.afterSpeech === "screen") {
        return {
          state: { ...state, phase: "screen", speaking: [] },
          effects: [{ type: "cancelSpeech" }],
        };
      }
      return toReady({ ...state, heldSpeech: [] }, [{ type: "cancelSpeech" }]);
    case "screenResolved":
      if (state.phase !== "screen") return unchanged(state);
      return { state: { ...state, phase: "working", notice: null }, effects: [] };
    case "expand":
      if (state.phase !== "screen") return unchanged(state);
      return toReady(state);
  }
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `pnpm exec vitest run packages/web/src/lib/voice-mode-machine.test.ts`
Expected: PASS (25 tests)

- [ ] **Step 5: コミット**

```bash
git add packages/web/src/lib/voice-mode-machine.ts packages/web/src/lib/voice-mode-machine.test.ts
git commit -m "feat(web): 音声モードの状態遷移を書く"
```

---

### Task 4: ブラウザの音声APIの窓口 (`browser-speech.ts`)

**Files:**
- Create: `packages/web/src/lib/browser-speech.ts`
- Test: `packages/web/src/lib/browser-speech.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `interface RecognitionHandlers { onInterim(text); onFinal(text); onEnd(); onError(error: string) }`
  - `interface SpeechPort { startRecognition(handlers); stopRecognition(); abortRecognition(); unlockSpeech(); speak(sentences: string[], onIdle: () => void, onWatchdog?: () => void); cancelSpeech(); requestWakeLock(): Promise<boolean>; releaseWakeLock() }`
  - `interface SpeechEnvironment` (下のコードのとおり)
  - `isVoiceModeSupported(env: SpeechEnvironment | undefined): boolean`
  - `browserSpeechEnvironment(): SpeechEnvironment | undefined`
  - `createSpeechPort(env: SpeechEnvironment): SpeechPort`
  - `watchdogMs(text: string): number`

- [ ] **Step 1: 失敗するテストを書く**

`packages/web/src/lib/browser-speech.test.ts`:

```ts
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSpeechPort,
  isVoiceModeSupported,
  type RecognitionHandlers,
  type SpeechEnvironment,
  watchdogMs,
} from "./browser-speech";

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  static throwOnStart = false;
  lang = "";
  continuous = true;
  interimResults = false;
  maxAlternatives = 0;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  stopped = false;
  aborted = false;
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    if (FakeRecognition.throwOnStart) {
      throw new DOMException("already started", "InvalidStateError");
    }
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  abort() {
    this.aborted = true;
  }
  emit(results: Array<{ transcript: string; isFinal: boolean }>) {
    this.onresult?.({
      results: results.map(r =>
        Object.assign([{ transcript: r.transcript }], { isFinal: r.isFinal })
      ),
    });
  }
}

class FakeUtterance {
  lang = "";
  volume = 1;
  voice: unknown = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

class FakeSynthesis {
  spoken: FakeUtterance[] = [];
  cancelled = 0;
  speak(utterance: FakeUtterance) {
    this.spoken.push(utterance);
  }
  cancel() {
    this.cancelled++;
  }
  getVoices() {
    return [
      { lang: "en-US", name: "Samantha" },
      { lang: "ja-JP", name: "Kyoko" },
    ];
  }
}

let synth: FakeSynthesis;
let audioSession: { type: string };
let released: number;
let env: SpeechEnvironment;

function handlers(): RecognitionHandlers & {
  log: string[];
} {
  const log: string[] = [];
  return {
    log,
    onInterim: text => log.push(`interim:${text}`),
    onFinal: text => log.push(`final:${text}`),
    onEnd: () => log.push("end"),
    onError: error => log.push(`error:${error}`),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeRecognition.instances = [];
  FakeRecognition.throwOnStart = false;
  synth = new FakeSynthesis();
  audioSession = { type: "auto" };
  released = 0;
  env = {
    webkitSpeechRecognition:
      FakeRecognition as unknown as SpeechEnvironment["webkitSpeechRecognition"],
    speechSynthesis: synth as unknown as SpeechSynthesis,
    SpeechSynthesisUtterance:
      FakeUtterance as unknown as SpeechEnvironment["SpeechSynthesisUtterance"],
    navigator: {
      audioSession,
      wakeLock: {
        request: async () =>
          ({
            release: async () => {
              released++;
            },
          }) as unknown as WakeLockSentinel,
      },
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isVoiceModeSupported", () => {
  it("認識と読み上げの両方があるときだけ使える", () => {
    expect(isVoiceModeSupported(env)).toBe(true);
    expect(
      isVoiceModeSupported({ ...env, webkitSpeechRecognition: undefined })
    ).toBe(false);
    expect(isVoiceModeSupported({ ...env, speechSynthesis: undefined })).toBe(
      false
    );
    expect(isVoiceModeSupported(undefined)).toBe(false);
  });
});

describe("createSpeechPort の認識", () => {
  it("日本語・1回きり・途中結果ありで始め、録音用の経路に切り替える", () => {
    const port = createSpeechPort(env);
    port.startRecognition(handlers());
    const rec = FakeRecognition.instances[0];
    expect(rec.started).toBe(true);
    expect(rec.lang).toBe("ja-JP");
    expect(rec.continuous).toBe(false);
    expect(rec.interimResults).toBe(true);
    expect(audioSession.type).toBe("play-and-record");
  });

  it("途中結果と確定を分けて届ける", () => {
    const port = createSpeechPort(env);
    const h = handlers();
    port.startRecognition(h);
    const rec = FakeRecognition.instances[0];
    rec.emit([{ transcript: "テスト", isFinal: false }]);
    rec.emit([{ transcript: "テストを直して", isFinal: true }]);
    rec.onend?.();
    expect(h.log).toEqual(["interim:テスト", "final:テストを直して", "end"]);
  });

  it("捨てた認識からは何も届かない", () => {
    const port = createSpeechPort(env);
    const h = handlers();
    port.startRecognition(h);
    const rec = FakeRecognition.instances[0];
    port.abortRecognition();
    expect(rec.aborted).toBe(true);
    expect(rec.onend).toBeNull();
    expect(h.log).toEqual([]);
  });

  it("開始で例外が出たらエラーとして届ける", () => {
    FakeRecognition.throwOnStart = true;
    const port = createSpeechPort(env);
    const h = handlers();
    port.startRecognition(h);
    expect(h.log).toEqual(["error:InvalidStateError"]);
  });

  it("認識が無い環境ではエラーとして届ける", () => {
    const port = createSpeechPort({
      ...env,
      webkitSpeechRecognition: undefined,
    });
    const h = handlers();
    port.startRecognition(h);
    expect(h.log).toEqual(["error:unsupported"]);
  });
});

describe("createSpeechPort の読み上げ", () => {
  it("文を1つずつ順に読み、読み終えたら onIdle を呼ぶ。読む前に再生用の経路へ切り替える", () => {
    const port = createSpeechPort(env);
    const onIdle = vi.fn();
    port.speak(["一文目。", "二文目。"], onIdle);
    expect(audioSession.type).toBe("playback");
    expect(synth.spoken.map(u => u.text)).toEqual(["一文目。"]);
    expect(synth.spoken[0].lang).toBe("ja-JP");
    expect(synth.spoken[0].voice).toEqual({ lang: "ja-JP", name: "Kyoko" });
    synth.spoken[0].onend?.();
    expect(synth.spoken.map(u => u.text)).toEqual(["一文目。", "二文目。"]);
    expect(onIdle).not.toHaveBeenCalled();
    synth.spoken[1].onend?.();
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("onend が来なくても、見張りの時間が過ぎたら次へ進む", () => {
    const port = createSpeechPort(env);
    const onIdle = vi.fn();
    const onWatchdog = vi.fn();
    port.speak(["止まる文。", "次の文。"], onIdle, onWatchdog);
    vi.advanceTimersByTime(watchdogMs("止まる文。"));
    expect(onWatchdog).toHaveBeenCalledTimes(1);
    expect(synth.cancelled).toBe(1);
    expect(synth.spoken.map(u => u.text)).toEqual(["止まる文。", "次の文。"]);
    // 見張りで進んだ後に古い発話の onend が遅れて来ても、二重に進まない
    synth.spoken[0].onend?.();
    expect(synth.spoken).toHaveLength(2);
  });

  it("止めたら残りを捨て、onIdle を呼ばない", () => {
    const port = createSpeechPort(env);
    const onIdle = vi.fn();
    port.speak(["一文目。", "二文目。"], onIdle);
    port.cancelSpeech();
    synth.spoken[0].onend?.();
    expect(synth.spoken).toHaveLength(1);
    expect(synth.cancelled).toBe(1);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("読み上げの解錠は無音の空の発話で行う", () => {
    const port = createSpeechPort(env);
    port.unlockSpeech();
    expect(synth.spoken[0].text).toBe("");
    expect(synth.spoken[0].volume).toBe(0);
  });
});

describe("createSpeechPort の画面の点灯維持", () => {
  it("取れたら true を返し、解放で release を呼ぶ", async () => {
    const port = createSpeechPort(env);
    await expect(port.requestWakeLock()).resolves.toBe(true);
    port.releaseWakeLock();
    await vi.runAllTimersAsync();
    expect(released).toBe(1);
  });

  it("APIが無ければ false を返す", async () => {
    const port = createSpeechPort({ ...env, navigator: {} });
    await expect(port.requestWakeLock()).resolves.toBe(false);
  });

  it("取れる前に解放を頼まれていたら、取れた直後に手放す", async () => {
    const port = createSpeechPort(env);
    const pending = port.requestWakeLock();
    port.releaseWakeLock();
    await pending;
    await vi.runAllTimersAsync();
    expect(released).toBe(1);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `pnpm exec vitest run packages/web/src/lib/browser-speech.test.ts`
Expected: FAIL (`Failed to resolve import "./browser-speech"`)

- [ ] **Step 3: 実装する**

`packages/web/src/lib/browser-speech.ts`:

```ts
/**
 * browser-speech - 音声モードが使うブラウザの音声API (認識・読み上げ・画面の点灯維持) の窓口。
 *
 * useVoiceMode はこの SpeechPort だけを通して音声APIに触る。テストでは偽物に差し替える。
 * TypeScript の lib.dom には SpeechRecognition のコンストラクタと navigator.audioSession が
 * 無いので、使う部分だけを型にしてある。
 *
 * iOS Safari で分かっていること (仕様の7章):
 * - 認識の開始はユーザー操作の中でしか許されないことがある (not-allowed)
 * - 発話の onend が来ないことがある → 発話ごとに見張りを置く
 * - 認識の後は音声の経路が録音用のままになり、読み上げが受話口から小さく鳴るおそれがある
 *   → navigator.audioSession があれば、読み上げの前は再生用、認識の前は録音用に切り替える
 */

export interface RecognitionHandlers {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onEnd: () => void;
  onError: (error: string) => void;
}

export interface SpeechPort {
  /** 認識を始める。前の認識が残っていれば捨てる */
  startRecognition: (handlers: RecognitionHandlers) => void;
  /** 認識を止める。聞き取った分は onFinal / onEnd で届く */
  stopRecognition: () => void;
  /** 認識を捨てる。以後、その認識からは何も届かない */
  abortRecognition: () => void;
  /** 無音の発話で読み上げを使える状態にする (ユーザー操作の中で呼ぶ) */
  unlockSpeech: () => void;
  /**
   * 文を順に読む。読んでいる途中なら後ろに足す。すべて読み終えたら onIdle を呼ぶ
   * (途中で足したときは、最後に渡した onIdle だけを呼ぶ)。
   * onend が来ずに見張りで次へ進んだときは onWatchdog を呼ぶ
   */
  speak: (
    sentences: string[],
    onIdle: () => void,
    onWatchdog?: () => void
  ) => void;
  /** 読み上げを止め、残りを捨てる。onIdle は呼ばない */
  cancelSpeech: () => void;
  /** 画面の消灯を止める。取れたら true */
  requestWakeLock: () => Promise<boolean>;
  releaseWakeLock: () => void;
}

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type RecognitionConstructor = new () => RecognitionLike;

/** 窓口が使うブラウザの部分。本物は window、テストでは偽物を渡す */
export interface SpeechEnvironment {
  SpeechRecognition?: RecognitionConstructor;
  webkitSpeechRecognition?: RecognitionConstructor;
  speechSynthesis?: SpeechSynthesis;
  SpeechSynthesisUtterance?: new (text?: string) => SpeechSynthesisUtterance;
  navigator: {
    wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinel> };
    /** Safari の Audio Session API。無いブラウザもある */
    audioSession?: { type: string };
  };
}

/** 発話の見張り。日本語の読み上げは1文字およそ150ミリ秒なので、倍の余裕を見る */
const WATCHDOG_MS_PER_CHAR = 300;
const WATCHDOG_MS_BASE = 3000;

export function watchdogMs(text: string): number {
  return text.length * WATCHDOG_MS_PER_CHAR + WATCHDOG_MS_BASE;
}

export function isVoiceModeSupported(
  env: SpeechEnvironment | undefined
): boolean {
  if (!env) return false;
  return Boolean(
    (env.SpeechRecognition ?? env.webkitSpeechRecognition) &&
      env.speechSynthesis &&
      env.SpeechSynthesisUtterance
  );
}

export function browserSpeechEnvironment(): SpeechEnvironment | undefined {
  if (typeof window === "undefined") return undefined;
  return window as unknown as SpeechEnvironment;
}

export function createSpeechPort(env: SpeechEnvironment): SpeechPort {
  let recognition: RecognitionLike | null = null;
  let queue: string[] = [];
  /** 発話の世代。止めたときに進め、古い発話からの onend を無視する */
  let generation = 0;
  let speakingNow = false;
  let onIdle: (() => void) | null = null;
  let onWatchdog: (() => void) | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let wakeLock: WakeLockSentinel | null = null;
  let wakeLockWanted = false;

  const setAudioSession = (type: "playback" | "play-and-record") => {
    const session = env.navigator.audioSession;
    if (!session) return;
    try {
      session.type = type;
    } catch {
      // 未対応の値は無視する (経路の切り替えは補助で、無くても読み上げはできる)
    }
  };

  const detach = (rec: RecognitionLike) => {
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
  };

  const clearWatchdog = () => {
    if (watchdog !== null) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  };

  const japaneseVoice = (synth: SpeechSynthesis) =>
    synth
      .getVoices()
      .find(voice => voice.lang.replace("_", "-").toLowerCase().startsWith("ja"));

  const speakNext = () => {
    const synth = env.speechSynthesis;
    const Utterance = env.SpeechSynthesisUtterance;
    const text = queue.shift();
    if (text === undefined || !synth || !Utterance) {
      speakingNow = false;
      const done = onIdle;
      onIdle = null;
      done?.();
      return;
    }
    speakingNow = true;
    setAudioSession("playback");
    generation++;
    const mine = generation;
    let settled = false;
    const utterance = new Utterance(text);
    utterance.lang = "ja-JP";
    const voice = japaneseVoice(synth);
    if (voice) utterance.voice = voice;
    const finish = () => {
      if (settled || mine !== generation) return;
      settled = true;
      clearWatchdog();
      speakNext();
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    watchdog = setTimeout(() => {
      if (settled || mine !== generation) return;
      settled = true;
      watchdog = null;
      onWatchdog?.();
      // 止まった発話を片付けてから次へ。cancel で遅れて来る onend は settled で無視される
      synth.cancel();
      speakNext();
    }, watchdogMs(text));
    synth.speak(utterance);
  };

  return {
    startRecognition(handlers) {
      if (recognition) {
        detach(recognition);
        recognition.abort();
        recognition = null;
      }
      const Recognition = env.SpeechRecognition ?? env.webkitSpeechRecognition;
      if (!Recognition) {
        handlers.onError("unsupported");
        return;
      }
      setAudioSession("play-and-record");
      const rec = new Recognition();
      rec.lang = "ja-JP";
      rec.continuous = false;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.onresult = event => {
        let finalText = "";
        let interimText = "";
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i];
          const transcript = result[0]?.transcript ?? "";
          if (result.isFinal) finalText += transcript;
          else interimText += transcript;
        }
        if (finalText) handlers.onFinal(finalText);
        else if (interimText) handlers.onInterim(interimText);
      };
      rec.onerror = event => handlers.onError(event.error);
      rec.onend = () => {
        if (recognition === rec) recognition = null;
        handlers.onEnd();
      };
      recognition = rec;
      try {
        rec.start();
      } catch (err) {
        detach(rec);
        recognition = null;
        handlers.onError(err instanceof DOMException ? err.name : "start-failed");
      }
    },
    stopRecognition() {
      recognition?.stop();
    },
    abortRecognition() {
      if (!recognition) return;
      detach(recognition);
      recognition.abort();
      recognition = null;
    },
    unlockSpeech() {
      const synth = env.speechSynthesis;
      const Utterance = env.SpeechSynthesisUtterance;
      if (!synth || !Utterance) return;
      const utterance = new Utterance("");
      utterance.volume = 0;
      synth.speak(utterance);
    },
    speak(sentences, idle, watchdogHandler) {
      onIdle = idle;
      onWatchdog = watchdogHandler ?? null;
      queue.push(...sentences);
      if (!speakingNow) speakNext();
    },
    cancelSpeech() {
      queue = [];
      generation++;
      clearWatchdog();
      speakingNow = false;
      onIdle = null;
      env.speechSynthesis?.cancel();
    },
    async requestWakeLock() {
      const lock = env.navigator.wakeLock;
      if (!lock) return false;
      wakeLockWanted = true;
      try {
        const sentinel = await lock.request("screen");
        if (!wakeLockWanted) {
          // 取れる前に解放を頼まれていた
          void sentinel.release().catch(() => undefined);
          return false;
        }
        wakeLock = sentinel;
        return true;
      } catch {
        return false;
      }
    },
    releaseWakeLock() {
      wakeLockWanted = false;
      const current = wakeLock;
      wakeLock = null;
      if (current) void current.release().catch(() => undefined);
    },
  };
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `pnpm exec vitest run packages/web/src/lib/browser-speech.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: コミット**

```bash
git add packages/web/src/lib/browser-speech.ts packages/web/src/lib/browser-speech.test.ts
git commit -m "feat(web): 音声の認識と読み上げの窓口を作る"
```

---

### Task 5: 診断ログ (`voice:diagnostic`)

**Files:**
- Create: `packages/server/src/lib/voice-diagnostic.ts`
- Test: `packages/server/src/lib/voice-diagnostic.test.ts`
- Modify: `packages/shared/src/types.ts` (`ClientToServerEvents` の `"session:send-literal"` の次)
- Modify: `packages/server/src/index.ts` (`socket.on("session:send-literal", ...)` の直後)
- Modify: `CLAUDE.md` (「クライアント → サーバー」の表の `session:send-literal` の行の次)

**Interfaces:**
- Consumes: なし
- Produces:
  - `formatVoiceDiagnostic(data: unknown): string | null`
  - `ClientToServerEvents["voice:diagnostic"]: (data: { sessionId: string; kind: string; detail: string }) => void`

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/lib/voice-diagnostic.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatVoiceDiagnostic } from "./voice-diagnostic.js";

describe("formatVoiceDiagnostic", () => {
  it("セッション・種類・詳細を1行にする", () => {
    expect(
      formatVoiceDiagnostic({
        sessionId: "s1",
        kind: "recognition-error",
        detail: "not-allowed (auto)",
      })
    ).toBe("[Voice] session=s1 recognition-error not-allowed (auto)");
  });

  it("詳細が空なら付けない", () => {
    expect(
      formatVoiceDiagnostic({ sessionId: "s1", kind: "hidden", detail: "" })
    ).toBe("[Voice] session=s1 hidden");
  });

  it("改行や制御文字を空白にし、長さを切り詰める", () => {
    const line = formatVoiceDiagnostic({
      sessionId: "s1",
      kind: "speak",
      detail: `a\nb[31m${"x".repeat(300)}`,
    });
    expect(line).not.toContain("\n");
    expect(line).not.toContain("");
    expect(line?.length).toBeLessThanOrEqual(
      "[Voice] session=s1 speak ".length + 200
    );
  });

  it("形が違えば null", () => {
    expect(formatVoiceDiagnostic(null)).toBeNull();
    expect(formatVoiceDiagnostic({ sessionId: 1, kind: "x" })).toBeNull();
    expect(formatVoiceDiagnostic({ sessionId: "s1" })).toBeNull();
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `pnpm exec vitest run packages/server/src/lib/voice-diagnostic.test.ts`
Expected: FAIL (`Failed to resolve import "./voice-diagnostic.js"`)

- [ ] **Step 3: 実装する**

`packages/server/src/lib/voice-diagnostic.ts`:

```ts
/**
 * voice-diagnostic - 音声モード (iPhone) の診断イベントを、pm2 のログの1行に整える。
 *
 * 実機で「認識が拒否されたか」「自動でマイクを開けたか」「読み上げの onend が来たか」を、
 * ユーザーに報告してもらわずに確かめるためのもの。保存も配信もしない。
 * クライアントは認識した文や返答の本文を送らない (文字数だけ)。
 */

const MAX_SESSION_ID = 64;
const MAX_KIND = 40;
const MAX_DETAIL = 200;

function clean(value: string, max: number): string {
  return value.replace(/\p{Cc}+/gu, " ").trim().slice(0, max);
}

export function formatVoiceDiagnostic(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { sessionId?: unknown; kind?: unknown; detail?: unknown };
  if (typeof d.sessionId !== "string" || typeof d.kind !== "string") {
    return null;
  }
  const detail = typeof d.detail === "string" ? clean(d.detail, MAX_DETAIL) : "";
  const head = `[Voice] session=${clean(d.sessionId, MAX_SESSION_ID)} ${clean(d.kind, MAX_KIND)}`;
  return detail ? `${head} ${detail}` : head;
}
```

`packages/shared/src/types.ts` の `ClientToServerEvents` で、`"session:send-literal": (data: { sessionId: string; text: string }) => void;` の次に足す:

```ts

  /**
   * 音声モード (iPhone) の診断。サーバーはログに1行出すだけで、保存も配信もしない。
   * 認識した文や返答の本文は送らない (文字数だけ)
   */
  "voice:diagnostic": (data: {
    sessionId: string;
    kind: string;
    detail: string;
  }) => void;
```

`packages/server/src/index.ts` の import 群 (`./lib/` からの import がアルファベット順に並んでいる) に足す:

```ts
import { formatVoiceDiagnostic } from "./lib/voice-diagnostic.js";
```

同じファイルの `socket.on("session:send-literal", ...)` のハンドラの閉じ `});` の直後に足す:

```ts

    // 音声モード (iPhone) の診断。実機での認識エラーや、自動でマイクを開けたかを
    // pm2 のログに1行残すだけ。保存も配信もしない
    socket.on("voice:diagnostic", (data: unknown) => {
      const line = formatVoiceDiagnostic(data);
      if (line) console.log(line);
    });
```

`CLAUDE.md` の「クライアント → サーバー」の表で、`session:send-literal` の行の次に足す:

```markdown
| `voice:diagnostic` | `{ sessionId, kind, detail }`           | 音声モードの診断。サーバーのログに1行出すだけ（本文は送らない） |
```

- [ ] **Step 4: 通ることを確かめる**

Run: `pnpm exec vitest run packages/server/src/lib/voice-diagnostic.test.ts && pnpm exec tsc -b`
Expected: PASS、tscはエラーなし

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/lib/voice-diagnostic.ts packages/server/src/lib/voice-diagnostic.test.ts packages/shared/src/types.ts packages/server/src/index.ts CLAUDE.md
git commit -m "feat(server): 音声モードの診断をログに残す"
```

---

### Task 6: 音声モードのフック (`useVoiceMode.ts`)

**Files:**
- Create: `packages/web/src/hooks/useVoiceMode.ts`
- Test: `packages/web/src/hooks/useVoiceMode.test.tsx`

**Interfaces:**
- Consumes:
  - Task 1: `toSpeechSentences`, `questionsToSpeechSentences`
  - Task 2: `createTurnEndCursor`, `scanTurnEnds`, `TurnEndCursor`
  - Task 3: `reduceVoice`, `INITIAL_VOICE_STATE`, `VoiceState`, `VoiceAction`, `VoiceEffect`, `SendGuard`
  - Task 4: `SpeechPort`, `createSpeechPort`, `browserSpeechEnvironment`, `isVoiceModeSupported`
  - 既存: `ActiveAuq` (`@/lib/ask-user-question-state`), `JsonlParsedEvent` (`@/lib/jsonl-event-parser`), `BridgeSessionStatus` (`@ark/shared`)
- Produces:
  - `useVoiceMode(options: UseVoiceModeOptions): VoiceModeControls`
  - `interface UseVoiceModeOptions { isActive: boolean; isConnected: boolean; bridgeStatus: BridgeSessionStatus | undefined; activeAuq: ActiveAuq | null; onSendMessage: (message: string) => void; onDiagnostic?: (kind: string, detail: string) => void; port?: SpeechPort; supported?: boolean }`
  - `interface VoiceModeControls { state: VoiceState; supported: boolean; enter(); exit(); tapMic(); cancel(); sendNow(); stopSpeaking(); expand(); pushEvents(events: readonly JsonlParsedEvent[]) }`
  - `SILENCE_MS = 2000`, `SETTLED_MS = 5000`

- [ ] **Step 1: 失敗するテストを書く**

`packages/web/src/hooks/useVoiceMode.test.tsx`:

```tsx
// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveAuq } from "@/lib/ask-user-question-state";
import type { RecognitionHandlers, SpeechPort } from "@/lib/browser-speech";
import type { JsonlParsedEvent } from "@/lib/jsonl-event-parser";
import { CONFIRM_ON_SCREEN, REPLY_ON_SCREEN } from "@/lib/speech-text";
import {
  SETTLED_MS,
  SILENCE_MS,
  type UseVoiceModeOptions,
  useVoiceMode,
  type VoiceModeControls,
} from "./useVoiceMode";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class FakePort implements SpeechPort {
  calls: string[] = [];
  handlers: RecognitionHandlers | null = null;
  spoken: string[][] = [];
  private idle: (() => void) | null = null;
  startRecognition(handlers: RecognitionHandlers) {
    this.calls.push("startRecognition");
    this.handlers = handlers;
  }
  stopRecognition() {
    this.calls.push("stopRecognition");
  }
  abortRecognition() {
    this.calls.push("abortRecognition");
    this.handlers = null;
  }
  unlockSpeech() {
    this.calls.push("unlockSpeech");
  }
  speak(sentences: string[], onIdle: () => void) {
    this.calls.push("speak");
    this.spoken.push(sentences);
    this.idle = onIdle;
  }
  cancelSpeech() {
    this.calls.push("cancelSpeech");
    this.idle = null;
  }
  async requestWakeLock() {
    this.calls.push("requestWakeLock");
    return true;
  }
  releaseWakeLock() {
    this.calls.push("releaseWakeLock");
  }
  finishSpeech() {
    const idle = this.idle;
    this.idle = null;
    act(() => idle?.());
  }
}

const user = (id: string): JsonlParsedEvent => ({
  id,
  kind: "user-input",
  text: "指示",
});
const reply = (id: string, text: string): JsonlParsedEvent => ({
  id,
  kind: "assistant-text",
  text,
  endTurn: true,
});
const AUQ: ActiveAuq = {
  toolUseId: "hook:1",
  questions: [
    {
      question: "どちらにしますか？",
      multiSelect: false,
      options: [{ label: "A" }, { label: "B" }],
    },
  ],
};

let container: HTMLDivElement;
let root: Root;
let port: FakePort;
let controls: VoiceModeControls;
let props: UseVoiceModeOptions;

function Probe(options: UseVoiceModeOptions) {
  controls = useVoiceMode(options);
  return null;
}

function render(overrides: Partial<UseVoiceModeOptions> = {}) {
  props = { ...props, ...overrides };
  act(() => root.render(<Probe {...props} />));
}

/** 話して送り、作業中にする */
function speakAndSend(text: string) {
  act(() => controls.enter());
  act(() => port.handlers?.onFinal(text));
  act(() => vi.advanceTimersByTime(2000));
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  port = new FakePort();
  props = {
    isActive: true,
    isConnected: true,
    bridgeStatus: "IDLE",
    activeAuq: null,
    onSendMessage: vi.fn(),
    port,
    supported: true,
  };
  render();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("useVoiceMode", () => {
  it("入ると、タップの処理の中で読み上げの解錠・画面の点灯維持・認識の開始を行う", () => {
    act(() => controls.enter());
    expect(port.calls).toEqual([
      "unlockSpeech",
      "requestWakeLock",
      "startRecognition",
    ]);
    expect(controls.state.phase).toBe("listening");
  });

  it("話して2秒待つと送る", () => {
    act(() => controls.enter());
    act(() => port.handlers?.onFinal("テストを直して"));
    expect(controls.state.phase).toBe("confirming");
    expect(props.onSendMessage).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(2000));
    expect(props.onSendMessage).toHaveBeenCalledWith("テストを直して");
    expect(controls.state.phase).toBe("working");
  });

  it("送る直前に確認が出ていたら送らず、画面での確認が要ると読む", () => {
    act(() => controls.enter());
    act(() => port.handlers?.onFinal("テストを直して"));
    render({ bridgeStatus: "AWAITING" });
    act(() => vi.advanceTimersByTime(2000));
    expect(props.onSendMessage).not.toHaveBeenCalled();
    expect(port.spoken.at(-1)).toEqual([CONFIRM_ON_SCREEN]);
  });

  it("接続が切れていたら送らない", () => {
    act(() => controls.enter());
    act(() => port.handlers?.onFinal("テストを直して"));
    render({ isConnected: false });
    act(() => vi.advanceTimersByTime(2000));
    expect(props.onSendMessage).not.toHaveBeenCalled();
    expect(controls.state.phase).toBe("ready");
  });

  it("途中結果が2秒変わらなければ、認識を止めて送信待ちに入る", () => {
    act(() => controls.enter());
    act(() => port.handlers?.onInterim("途中まで"));
    act(() => vi.advanceTimersByTime(SILENCE_MS));
    expect(port.calls).toContain("stopRecognition");
    expect(controls.state.phase).toBe("confirming");
    expect(controls.state.transcript).toBe("途中まで");
  });

  it("入る前の返答は読まず、入った後のターンの終わりを読み、読み終えたら自動で聞き取る", () => {
    const history = [user("u1"), reply("a1", "前の返答。")];
    act(() => controls.pushEvents(history));
    speakAndSend("テストを直して");
    act(() => controls.pushEvents(history));
    expect(port.spoken).toEqual([]);
    act(() =>
      controls.pushEvents([...history, user("u2"), reply("a2", "直しました。")])
    );
    expect(port.spoken).toEqual([["直しました。"]]);
    expect(controls.state.phase).toBe("speaking");
    const startsBefore = port.calls.filter(c => c === "startRecognition").length;
    port.finishSpeech();
    expect(port.calls.filter(c => c === "startRecognition").length).toBe(
      startsBefore + 1
    );
    expect(controls.state.phase).toBe("listening");
  });

  it("作業中にClaudeが止まったまま5秒経ったら、返答は画面でと読む", () => {
    speakAndSend("テストを直して");
    expect(controls.state.phase).toBe("working");
    act(() => vi.advanceTimersByTime(SETTLED_MS));
    expect(port.spoken.at(-1)).toEqual([REPLY_ON_SCREEN]);
  });

  it("Claudeが動き出したら、止まったままの判定をやり直す", () => {
    speakAndSend("テストを直して");
    act(() => vi.advanceTimersByTime(SETTLED_MS - 1000));
    render({ bridgeStatus: "THINK" });
    act(() => vi.advanceTimersByTime(SETTLED_MS));
    expect(port.spoken).toEqual([]);
  });

  it("質問が来たら読み、読み終えたら畳む。質問が解決したら作業中に戻る", () => {
    speakAndSend("テストを直して");
    render({ activeAuq: AUQ, bridgeStatus: "AWAITING" });
    expect(port.spoken.at(-1)?.[0]).toBe("Claudeから質問です。");
    port.finishSpeech();
    expect(controls.state.phase).toBe("screen");
    render({ activeAuq: null, bridgeStatus: "THINK" });
    expect(controls.state.phase).toBe("working");
  });

  it("同じ質問は二度読まない", () => {
    speakAndSend("テストを直して");
    render({ activeAuq: AUQ, bridgeStatus: "AWAITING" });
    port.finishSpeech();
    render({ activeAuq: { ...AUQ }, bridgeStatus: "AWAITING" });
    expect(port.spoken).toHaveLength(1);
  });

  it("セッションの画面から離れたら終える", () => {
    act(() => controls.enter());
    render({ isActive: false });
    expect(controls.state.phase).toBe("off");
    expect(port.calls.slice(-3)).toEqual([
      "abortRecognition",
      "cancelSpeech",
      "releaseWakeLock",
    ]);
  });

  it("画面が隠れたら止めて待機にする", () => {
    act(() => controls.enter());
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(controls.state.phase).toBe("ready");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  it("診断を送る", () => {
    const onDiagnostic = vi.fn();
    render({ onDiagnostic });
    act(() => controls.enter());
    act(() => port.handlers?.onError("not-allowed"));
    expect(onDiagnostic).toHaveBeenCalledWith(
      "recognition-error",
      "not-allowed"
    );
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `pnpm exec vitest run packages/web/src/hooks/useVoiceMode.test.tsx`
Expected: FAIL (`Failed to resolve import "./useVoiceMode"`)

- [ ] **Step 3: 実装する**

`packages/web/src/hooks/useVoiceMode.ts`:

```ts
/**
 * useVoiceMode - 音声モード (iPhone 向け) の状態と副作用をまとめるフック。
 *
 * 状態遷移は lib/voice-mode-machine.ts の純関数に任せ、ここは次の3つだけを持つ。
 * 1. reducer が返した副作用を SpeechPort で実行する
 * 2. 時間の経過 (送信待ちの2秒、無音の2秒、止まったままの5秒) を入力に変える
 * 3. 会話ビューから受け取った JSONL のイベント列から、ターンの終わりを拾う
 *
 * 副作用は dispatch の中で同期的に実行する。iOS は認識と読み上げの開始を
 * ユーザー操作の中でしか許さないので、タップ → reducer → 開始 を1つの呼び出しで終える。
 *
 * 仕様: docs/superpowers/specs/2026-09-19-voice-mode-design.md
 */

import type { BridgeSessionStatus } from "@ark/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ActiveAuq } from "@/lib/ask-user-question-state";
import {
  browserSpeechEnvironment,
  createSpeechPort,
  isVoiceModeSupported,
  type SpeechPort,
} from "@/lib/browser-speech";
import type { JsonlParsedEvent } from "@/lib/jsonl-event-parser";
import {
  questionsToSpeechSentences,
  toSpeechSentences,
} from "@/lib/speech-text";
import {
  INITIAL_VOICE_STATE,
  reduceVoice,
  type SendGuard,
  type VoiceAction,
  type VoiceEffect,
  type VoiceState,
} from "@/lib/voice-mode-machine";
import {
  createTurnEndCursor,
  scanTurnEnds,
  type TurnEndCursor,
} from "@/lib/voice-turn-signals";

/** 途中結果がこの間変わらなければ、話し終えたとみなす (1.2秒では日本語の言い淀みで切れる) */
export const SILENCE_MS = 2000;
/**
 * 作業中なのに Claude が止まった状態がこの間続いたら、「返答は画面で」と言って待機に戻る。
 * Esc での中断・APIエラー・作業中の /clear・停止は end_turn を書かないので、この退路が要る
 */
export const SETTLED_MS = 5000;
const SETTLED_STATUSES: ReadonlySet<BridgeSessionStatus> = new Set([
  "IDLE",
  "READY",
  "ERR",
  "STOP",
]);

export interface UseVoiceModeOptions {
  /** このセッションの画面が表示中か。離れたら音声モードを終える */
  isActive: boolean;
  /** サーバーとの接続。切れていたら送らない */
  isConnected: boolean;
  bridgeStatus: BridgeSessionStatus | undefined;
  /** 回答待ちの質問カード (会話ビューから受け取る)。無ければ null */
  activeAuq: ActiveAuq | null;
  onSendMessage: (message: string) => void;
  /** 実機の挙動をサーバーのログに残す。本文は渡さない (文字数だけ) */
  onDiagnostic?: (kind: string, detail: string) => void;
  /** テスト用。未指定ならブラウザの音声APIを使う */
  port?: SpeechPort;
  /** テスト用。未指定ならブラウザの音声APIの有無で決める */
  supported?: boolean;
}

export interface VoiceModeControls {
  state: VoiceState;
  /** このブラウザで音声モードを使えるか (認識と読み上げの両方がある) */
  supported: boolean;
  enter: () => void;
  exit: () => void;
  tapMic: () => void;
  cancel: () => void;
  sendNow: () => void;
  stopSpeaking: () => void;
  expand: () => void;
  /** 会話ビューの JSONL イベント列を受け取る (SplitChatPane の onEventsChange に渡す) */
  pushEvents: (events: readonly JsonlParsedEvent[]) => void;
}

export function useVoiceMode(options: UseVoiceModeOptions): VoiceModeControls {
  const { isActive, bridgeStatus, activeAuq } = options;
  const [port] = useState<SpeechPort>(
    () =>
      options.port ??
      createSpeechPort(browserSpeechEnvironment() ?? { navigator: {} })
  );
  const [supported] = useState(
    () => options.supported ?? isVoiceModeSupported(browserSpeechEnvironment())
  );
  const [state, setState] = useState<VoiceState>(INITIAL_VOICE_STATE);
  const stateRef = useRef(state);
  // タイマーの中から最新の props を読むため (送る直前の確認は、そのときの状態で行う)
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });
  const eventsRef = useRef<readonly JsonlParsedEvent[]>([]);
  const cursorRef = useRef<TurnEndCursor | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dispatchRef = useRef<(action: VoiceAction) => void>(() => undefined);

  const diagnose = useCallback((kind: string, detail = "") => {
    optionsRef.current.onDiagnostic?.(kind, detail);
  }, []);

  const clearSilence = useCallback(() => {
    if (silenceTimerRef.current !== null) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const runEffect = useCallback(
    (effect: VoiceEffect) => {
      const dispatch = (action: VoiceAction) => dispatchRef.current(action);
      switch (effect.type) {
        case "startRecognition": {
          const auto = effect.auto;
          diagnose("listen", auto ? "auto" : "tap");
          port.startRecognition({
            onInterim: text => {
              dispatch({ type: "interim", text });
              clearSilence();
              silenceTimerRef.current = setTimeout(() => {
                silenceTimerRef.current = null;
                dispatch({ type: "silence", now: Date.now() });
              }, SILENCE_MS);
            },
            onFinal: text => {
              clearSilence();
              diagnose("final", `${text.length}文字`);
              dispatch({ type: "final", text, now: Date.now() });
            },
            onEnd: () => {
              clearSilence();
              dispatch({ type: "recognitionEnd", now: Date.now() });
            },
            onError: error => {
              clearSilence();
              diagnose("recognition-error", auto ? `${error} (auto)` : error);
              dispatch({ type: "recognitionError", error, auto });
            },
          });
          return;
        }
        case "stopRecognition":
          port.stopRecognition();
          return;
        case "abortRecognition":
          clearSilence();
          port.abortRecognition();
          return;
        case "unlockSpeech":
          port.unlockSpeech();
          return;
        case "speak": {
          const startedAt = Date.now();
          diagnose("speak", `${effect.sentences.join("").length}文字`);
          port.speak(
            effect.sentences,
            () => {
              diagnose("speak-done", `${Date.now() - startedAt}ms`);
              dispatch({ type: "speechDone" });
            },
            () => diagnose("speak-watchdog")
          );
          return;
        }
        case "cancelSpeech":
          port.cancelSpeech();
          return;
        case "send":
          diagnose("send", `${effect.text.length}文字`);
          optionsRef.current.onSendMessage(effect.text);
          return;
        case "requestWakeLock":
          void port
            .requestWakeLock()
            .then(ok => diagnose("wakelock", ok ? "ok" : "unavailable"));
          return;
        case "releaseWakeLock":
          port.releaseWakeLock();
          return;
      }
    },
    [port, diagnose, clearSilence]
  );

  const dispatch = useCallback(
    (action: VoiceAction) => {
      const previous = stateRef.current;
      const { state: next, effects } = reduceVoice(previous, action);
      if (next !== previous) {
        stateRef.current = next;
        setState(next);
        // 入った時点の履歴は読まない。抜けたら忘れる
        if (previous.phase === "off") {
          cursorRef.current = createTurnEndCursor(eventsRef.current);
        }
        if (next.phase === "off") cursorRef.current = null;
      }
      for (const effect of effects) runEffect(effect);
    },
    [runEffect]
  );
  useEffect(() => {
    dispatchRef.current = dispatch;
  }, [dispatch]);

  /** 送る直前の確認。カウントダウンが0になった時点 (入った時点ではない) の状態で決める */
  const commitNow = useCallback(() => {
    const current = optionsRef.current;
    const guard: SendGuard =
      current.bridgeStatus === "AWAITING" || current.activeAuq !== null
        ? "awaiting"
        : !current.isConnected
          ? "disconnected"
          : null;
    if (guard) diagnose("send-held", guard);
    dispatch({ type: "commit", guard });
  }, [dispatch, diagnose]);

  // 送信待ちの2秒
  useEffect(() => {
    if (state.phase !== "confirming" || state.confirmDeadline === null) return;
    const timer = setTimeout(
      commitNow,
      Math.max(0, state.confirmDeadline - Date.now())
    );
    return () => clearTimeout(timer);
  }, [state.phase, state.confirmDeadline, commitNow]);

  // セッションの画面から離れたら終える。モバイルはセッションごとに画面を常駐させて
  // 隠すだけなので、セッションの切り替えもここで拾える
  useEffect(() => {
    if (!isActive) dispatch({ type: "exit" });
  }, [isActive, dispatch]);

  // 質問 (AskUserQuestion)。同じ質問は一度だけ読む。抜けたら忘れ、入り直したら今の質問を読む
  const spokenAuqRef = useRef<string | null>(null);
  const isOff = state.phase === "off";
  useEffect(() => {
    if (isOff) {
      spokenAuqRef.current = null;
      return;
    }
    if (!activeAuq || spokenAuqRef.current === activeAuq.toolUseId) return;
    spokenAuqRef.current = activeAuq.toolUseId;
    diagnose("question", `${activeAuq.questions.length}問`);
    dispatch({
      type: "question",
      sentences: questionsToSpeechSentences(activeAuq.questions),
    });
  }, [isOff, activeAuq, dispatch, diagnose]);

  // 権限確認など (質問カードの無い AWAITING) と、画面での操作が済んだこと
  useEffect(() => {
    if (state.phase === "working" && bridgeStatus === "AWAITING" && !activeAuq) {
      dispatch({ type: "awaiting" });
    }
    if (state.phase === "screen" && bridgeStatus !== "AWAITING" && !activeAuq) {
      dispatch({ type: "screenResolved" });
    }
  }, [state.phase, bridgeStatus, activeAuq, dispatch]);

  // 作業中なのに Claude が止まったまま。状態が変わるたびに数え直す
  useEffect(() => {
    if (
      state.phase !== "working" ||
      !bridgeStatus ||
      !SETTLED_STATUSES.has(bridgeStatus)
    ) {
      return;
    }
    const timer = setTimeout(() => dispatch({ type: "settled" }), SETTLED_MS);
    return () => clearTimeout(timer);
  }, [state.phase, bridgeStatus, dispatch]);

  // 画面が隠れたら止める。戻ったら画面の点灯維持を取り直す (隠れると外れるため)
  useEffect(() => {
    if (isOff) return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        diagnose("hidden");
        dispatch({ type: "hidden" });
      } else {
        void port.requestWakeLock();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [isOff, port, dispatch, diagnose]);

  // アンマウント (セッションの停止・削除) で止める
  useEffect(
    () => () => {
      clearSilence();
      port.abortRecognition();
      port.cancelSpeech();
      port.releaseWakeLock();
    },
    [port, clearSilence]
  );

  const pushEvents = useCallback(
    (events: readonly JsonlParsedEvent[]) => {
      eventsRef.current = events;
      const cursor = cursorRef.current;
      if (!cursor) return;
      const { cursor: next, turnEnd } = scanTurnEnds(cursor, events);
      cursorRef.current = next;
      if (!turnEnd) return;
      diagnose("turn-end", `${turnEnd.text.length}文字`);
      dispatch({ type: "turnEnd", sentences: toSpeechSentences(turnEnd.text) });
    },
    [dispatch, diagnose]
  );

  const enter = useCallback(() => dispatch({ type: "enter" }), [dispatch]);
  const exit = useCallback(() => dispatch({ type: "exit" }), [dispatch]);
  const tapMic = useCallback(() => dispatch({ type: "tapMic" }), [dispatch]);
  const cancel = useCallback(() => dispatch({ type: "cancel" }), [dispatch]);
  const stopSpeaking = useCallback(
    () => dispatch({ type: "stopSpeaking" }),
    [dispatch]
  );
  const expand = useCallback(() => dispatch({ type: "expand" }), [dispatch]);

  return {
    state,
    supported,
    enter,
    exit,
    tapMic,
    cancel,
    sendNow: commitNow,
    stopSpeaking,
    expand,
    pushEvents,
  };
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `pnpm exec vitest run packages/web/src/hooks/useVoiceMode.test.tsx`
Expected: PASS (13 tests)

`dispatchRef` を effect で入れているため、初回描画の直後に `enter` を呼ぶテストで `dispatchRef.current` が空関数のまま使われて認識のコールバックが無視される場合は、`dispatchRef.current = dispatch;` を `useEffect` ではなく `useLayoutEffect` で入れる (`import { useLayoutEffect } from "react"`)。

- [ ] **Step 5: コミット**

```bash
git add packages/web/src/hooks/useVoiceMode.ts packages/web/src/hooks/useVoiceMode.test.tsx
git commit -m "feat(web): 音声モードのフックを作る"
```

---

### Task 7: 会話ビューからイベント列と質問を渡す

**Files:**
- Modify: `packages/web/src/components/SplitChatPane.tsx` (props の `onActiveAuqChange` 定義 131行付近、コンポーネント引数、1195行付近の effect)
- Modify: `packages/web/src/components/SplitChatPane.test.tsx` (260行付近のテスト)
- Modify: `packages/web/src/components/MobileSessionView.tsx` (256-260行付近の `hasActiveAuq` の state、672行付近の `onActiveAuqChange`)
- Modify: `packages/web/src/components/MobileSessionView.test.tsx` (34行の型、397・413・416行の呼び出し)

**Interfaces:**
- Consumes: 既存の `ActiveAuq`、`JsonlParsedEvent`
- Produces:
  - `SplitChatPaneProps.onActiveAuqChange?: (auq: ActiveAuq | null) => void`
  - `SplitChatPaneProps.onEventsChange?: (events: JsonlParsedEvent[]) => void`
  - `MobileSessionView` 内の state `activeAuq: ActiveAuq | null` (Task 8 が `useVoiceMode` に渡す)

- [ ] **Step 1: SplitChatPane のテストを先に直す (失敗させる)**

`packages/web/src/components/SplitChatPane.test.tsx` の「質問カードの表示有無が変わるたびにonActiveAuqChangeを呼ぶ」のテストで、期待値を3か所変える:

```ts
    expect(onActiveAuqChange).toHaveBeenLastCalledWith(null);
```

(最初の `toHaveBeenLastCalledWith(false)`)

```ts
    expect(onActiveAuqChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        questions: [
          expect.objectContaining({ question: "どちらにしますか？" }),
        ],
      })
    );
```

(`toHaveBeenLastCalledWith(true)`)

```ts
    expect(onActiveAuqChange).toHaveBeenLastCalledWith(null);
```

(最後の `toHaveBeenLastCalledWith(false)`)

テスト名を「質問カードが変わるたびに、そのカードの中身 (無ければ null) でonActiveAuqChangeを呼ぶ」に変える。

同じ `describe` の中、このテストの次に足す:

```ts
  it("JSONLのイベント列が変わるたびにonEventsChangeで渡す", () => {
    const onEventsChange = vi.fn();
    const { emitServer } = renderChat({ onEventsChange });
    emitServer("session:jsonl-snapshot", {
      sessionId: "s1",
      lines: [
        line({
          type: "assistant",
          uuid: "a1",
          message: {
            role: "assistant",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "直しました。" }],
          },
        }),
      ],
    });
    expect(onEventsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({
        kind: "assistant-text",
        text: "直しました。",
        endTurn: true,
      }),
    ]);
  });
```

- [ ] **Step 2: 失敗を確かめる**

Run: `pnpm exec vitest run packages/web/src/components/SplitChatPane.test.tsx`
Expected: FAIL (`expected "spy" to be last called with [ null ]` と、`onEventsChange` が呼ばれない)

- [ ] **Step 3: SplitChatPane を変える**

`packages/web/src/components/SplitChatPane.tsx` の props 定義で、`onActiveAuqChange` の JSDoc と型を次に置き換える:

```ts
  /**
   * 回答待ちの質問カード (AskUserQuestion) が変わったときに、その中身 (無ければ null) で呼ぶ。
   * マウント時にも現在の値 (null) で1回呼ぶ。モバイルの状態の帯と音声モードが使う。
   * アンマウント時には呼ばない。effectの依存に使うため、呼び出し側は安定した
   * 関数 (useCallback等) を渡すこと
   */
  onActiveAuqChange?: (auq: ActiveAuq | null) => void;
  /**
   * JSONL のイベント列が変わったときに呼ぶ (音声モードがターンの終わりを拾う)。
   * 購読は増やさず、このペインが持っている列をそのまま渡す。安定した関数を渡すこと
   */
  onEventsChange?: (events: JsonlParsedEvent[]) => void;
```

コンポーネントの引数の分割代入で、`onActiveAuqChange,` の次に `onEventsChange,` を足す。

1195行付近の effect を次に置き換える:

```ts
  useEffect(() => {
    onActiveAuqChange?.(activeAuq);
  }, [activeAuq, onActiveAuqChange]);

  // 音声モードがターンの終わりを拾う。購読は増やさず、この列を渡す
  useEffect(() => {
    onEventsChange?.(events);
  }, [events, onEventsChange]);
```

(`const hasActiveAuq = activeAuq !== null;` は `workingIndicatorLabel` が使うので残す。その上のコメント「質問カードの有無を親へ知らせる」は「質問カードを親へ知らせる (モバイルの状態の帯と音声モードが使う)」に変える)

- [ ] **Step 4: MobileSessionView を変える**

`packages/web/src/components/MobileSessionView.tsx` の import に足す (`@/lib/` の import 群の中、`@/lib/clipboard-images` の前):

```ts
import type { ActiveAuq } from "@/lib/ask-user-question-state";
```

`const [hasActiveAuq, setHasActiveAuq] = useState(false);` を次に置き換える (その上の4行のコメントは残し、1行目の「質問カード (AskUserQuestion) の表示有無」を「質問カード (AskUserQuestion)」に変える):

```ts
  const [activeAuq, setActiveAuq] = useState<ActiveAuq | null>(null);
  const hasActiveAuq = activeAuq !== null;
```

`<SplitChatPane>` の `onActiveAuqChange={setHasActiveAuq}` を `onActiveAuqChange={setActiveAuq}` に変える。

- [ ] **Step 5: MobileSessionView のテストを直す**

`packages/web/src/components/MobileSessionView.test.tsx` の先頭の import に足す:

```ts
import type { ActiveAuq } from "../lib/ask-user-question-state";
```

`ObservedChatProps` の `onActiveAuqChange?: (hasActiveAuq: boolean) => void;` を次に置き換える:

```ts
  onActiveAuqChange?: (auq: ActiveAuq | null) => void;
```

`function latestChatProps()` の前に足す:

```ts
const SAMPLE_AUQ: ActiveAuq = {
  toolUseId: "hook:1",
  questions: [
    {
      question: "どちらにしますか？",
      multiSelect: false,
      options: [{ label: "A" }, { label: "B" }],
    },
  ],
};
```

`onActiveAuqChange?.(true)` を2か所とも `onActiveAuqChange?.(SAMPLE_AUQ)` に、`onActiveAuqChange?.(false)` を `onActiveAuqChange?.(null)` に置き換える。

- [ ] **Step 6: 通ることを確かめる**

Run: `pnpm exec vitest run packages/web/src/components/SplitChatPane.test.tsx packages/web/src/components/MobileSessionView.test.tsx && pnpm exec tsc -b`
Expected: PASS、tscはエラーなし

- [ ] **Step 7: コミット**

```bash
git add packages/web/src/components/SplitChatPane.tsx packages/web/src/components/SplitChatPane.test.tsx packages/web/src/components/MobileSessionView.tsx packages/web/src/components/MobileSessionView.test.tsx
git commit -m "refactor(web): 会話ビューから質問カードの中身とイベント列を親へ渡す"
```

---

### Task 8: 音声モードの画面と組み込み

**Files:**
- Create: `packages/web/src/components/VoiceModeOverlay.tsx`
- Test: `packages/web/src/components/VoiceModeOverlay.test.tsx`
- Modify: `packages/web/src/lib/mobile-quick-actions.ts`
- Modify: `packages/web/src/lib/mobile-quick-actions.test.ts`
- Modify: `packages/web/src/components/MobileQuickActionRow.tsx`
- Modify: `packages/web/src/components/MobileSessionView.tsx`
- Modify: `packages/web/src/components/MobileSessionView.test.tsx`
- Modify: `CLAUDE.md` (「実装済み機能」の表)

**Interfaces:**
- Consumes: Task 3 の `VoiceState`、Task 6 の `useVoiceMode` / `VoiceModeControls`、Task 7 の `activeAuq` state と `onEventsChange`
- Produces:
  - `VoiceModeOverlay(props: VoiceModeOverlayProps)`、`voicePhaseLabel(state, bridgeStatus?): string`
  - `MobileQuickAction` に `"voice-mode"`、`mobileQuickActions` の入力に `canUseVoice?: boolean`
  - `MobileQuickActionRowProps.onStartVoice?: () => void`

- [ ] **Step 1: 1タップ操作の失敗するテストを書く**

`packages/web/src/lib/mobile-quick-actions.test.ts` の `describe` の中の最後に足す:

```ts
  it("会話モードで音声が使えるときは、音声モードを先頭に出す", () => {
    expect(
      mobileQuickActions({
        viewMode: "chat",
        canUploadFile: true,
        canCopyBuffer: true,
        canUseVoice: true,
      })
    ).toEqual([
      "voice-mode",
      "paste-image",
      "message-shortcuts",
      "slash-commands",
    ]);
  });

  it("端末モードと図モードでは、音声が使えても音声モードを出さない", () => {
    for (const viewMode of ["terminal", "board"] as const) {
      expect(
        mobileQuickActions({
          viewMode,
          canUploadFile: false,
          canCopyBuffer: false,
          canUseVoice: true,
        })
      ).not.toContain("voice-mode");
    }
  });
```

- [ ] **Step 2: 画面の失敗するテストを書く**

`packages/web/src/components/VoiceModeOverlay.test.tsx`:

```tsx
// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INITIAL_VOICE_STATE,
  type VoiceState,
} from "@/lib/voice-mode-machine";
import { VoiceModeOverlay, type VoiceModeOverlayProps } from "./VoiceModeOverlay";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let handlers: Omit<VoiceModeOverlayProps, "state" | "bridgeStatus">;

function render(state: Partial<VoiceState>, bridgeStatus?: VoiceModeOverlayProps["bridgeStatus"]) {
  act(() =>
    root.render(
      <VoiceModeOverlay
        state={{ ...INITIAL_VOICE_STATE, ...state }}
        bridgeStatus={bridgeStatus}
        {...handlers}
      />
    )
  );
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    b => b.textContent?.includes(label) || b.getAttribute("aria-label") === label
  );
  expect(found).toBeDefined();
  return found as HTMLButtonElement;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  handlers = {
    onExit: vi.fn(),
    onTapMic: vi.fn(),
    onCancel: vi.fn(),
    onSendNow: vi.fn(),
    onStopSpeaking: vi.fn(),
    onExpand: vi.fn(),
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("VoiceModeOverlay", () => {
  it("音声モードの外では何も描かない", () => {
    render({ phase: "off" });
    expect(container.innerHTML).toBe("");
  });

  it("待機では話すボタンを出す", () => {
    render({ phase: "ready", notice: "マイクが使えません (audio-capture)" });
    expect(container.textContent).toContain("タップして話す");
    expect(container.textContent).toContain("マイクが使えません");
    act(() => button("話す").click());
    expect(handlers.onTapMic).toHaveBeenCalled();
  });

  it("聞き取り中は途中結果を出し、やめられる", () => {
    render({ phase: "listening", transcript: "テストを" });
    expect(container.textContent).toContain("聞いています");
    expect(container.textContent).toContain("テストを");
    act(() => button("やめる").click());
    expect(handlers.onCancel).toHaveBeenCalled();
  });

  it("送信待ちでは文を出し、取り消しとすぐ送るを押せる", () => {
    render({ phase: "confirming", transcript: "テストを直して" });
    expect(container.textContent).toContain("2秒後に送ります");
    expect(container.textContent).toContain("テストを直して");
    act(() => button("取り消す").click());
    act(() => button("すぐ送る").click());
    expect(handlers.onCancel).toHaveBeenCalled();
    expect(handlers.onSendNow).toHaveBeenCalled();
  });

  it("作業中はClaudeの状態を出し、追加で話せる", () => {
    render({ phase: "working" }, "TOOL");
    expect(container.textContent).toContain("作業しています");
    act(() => button("追加で話す").click());
    expect(handlers.onTapMic).toHaveBeenCalled();
  });

  it("読み上げ中は読んでいる文を出し、タップで止められる", () => {
    render({ phase: "speaking", speaking: ["直しました。", "テストも通りました。"] });
    expect(container.textContent).toContain("直しました。テストも通りました。");
    act(() => button("タップで止める").click());
    expect(handlers.onStopSpeaking).toHaveBeenCalled();
  });

  it("画面で操作するときは帯に畳み、タップで戻る", () => {
    render({ phase: "screen" });
    expect(container.querySelector('[data-testid="voice-mode-overlay"]')).toBeNull();
    const bar = container.querySelector('[data-testid="voice-mode-minimized"]');
    expect(bar?.textContent).toContain("画面で操作してください");
    act(() => (bar as HTMLButtonElement).click());
    expect(handlers.onExpand).toHaveBeenCalled();
  });

  it("終了ボタンで抜ける", () => {
    render({ phase: "ready" });
    act(() => button("音声モードを終える").click());
    expect(handlers.onExit).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: 失敗を確かめる**

Run: `pnpm exec vitest run packages/web/src/lib/mobile-quick-actions.test.ts packages/web/src/components/VoiceModeOverlay.test.tsx`
Expected: FAIL (`voice-mode` が出ない、`Failed to resolve import "./VoiceModeOverlay"`)

- [ ] **Step 4: 1タップ操作に音声モードを足す**

`packages/web/src/lib/mobile-quick-actions.ts` の先頭コメントの最後 (`` `…` に残すのはセッション全体の操作 (通知・再起動・削除) だけ。`` の次) に足す:

```ts
 *
 * 音声モードは会話モードの先頭に出す。音声モードは会話ビューのイベント列を読み上げるので、
 * 会話を見ているときの操作にする。音声APIの無いブラウザ (canUseVoice=false) では出さない。
```

型に `"voice-mode"` を足す:

```ts
export type MobileQuickAction =
  | "voice-mode"
  | "attach-file"
  | "paste-image"
  | "message-shortcuts"
  | "slash-commands"
  | "copy-buffer"
  | "reload-terminal";
```

入力と本体を次に置き換える:

```ts
export function mobileQuickActions(input: {
  viewMode: MobileSessionViewMode;
  canUploadFile: boolean;
  canCopyBuffer: boolean;
  /** 音声の認識と読み上げの両方が使えるブラウザか */
  canUseVoice?: boolean;
}): MobileQuickAction[] {
  const actions: MobileQuickAction[] = [];
  if (input.viewMode === "chat" && input.canUseVoice) {
    actions.push("voice-mode");
  }
  if (input.canUploadFile) {
    if (input.viewMode !== "chat") actions.push("attach-file");
    actions.push("paste-image");
  }
  actions.push("message-shortcuts", "slash-commands");
  if (input.viewMode === "terminal") {
    if (input.canCopyBuffer) actions.push("copy-buffer");
    actions.push("reload-terminal");
  }
  return actions;
}
```

`packages/web/src/components/MobileQuickActionRow.tsx` の lucide の import に `Mic` を足す (アルファベット順で `ImagePlus` の次):

```ts
import {
  Copy,
  ImagePlus,
  Mic,
  Paperclip,
  RefreshCw,
  SquareSlash,
} from "lucide-react";
```

`MobileQuickActionRowProps` の `onManageShortcuts` の次に足す:

```ts
  /** 音声モードに入る。iOSはこのタップの中でしか認識を始めさせないので、そのまま呼ぶ */
  onStartVoice?: () => void;
```

関数の引数の分割代入に `onStartVoice,` を足し (`onManageShortcuts,` の次)、`<div data-testid="mobile-quick-actions" ...>` の最初の子として足す:

```tsx
      {actions.includes("voice-mode") && onStartVoice && (
        <button
          type="button"
          aria-label="音声モード"
          title="音声モード"
          onClick={onStartVoice}
          className={TOUCH_ICON_BUTTON}
        >
          <Mic className="size-5" aria-hidden="true" />
        </button>
      )}
```

- [ ] **Step 5: 音声モードの画面を作る**

`packages/web/src/components/VoiceModeOverlay.tsx`:

```tsx
/**
 * VoiceModeOverlay - 音声モードの画面 (モバイル)。
 *
 * 全画面で「いま何をしているか」と、そのときに押せるボタンだけを大きく出す。
 * 画面での操作が要るとき (質問・権限確認) は画面上部の帯に縮め、下の会話ビューを見せる。
 * 状態の持ち主は useVoiceMode。ここは描くだけ。
 *
 * 仕様: docs/superpowers/specs/2026-09-19-voice-mode-design.md の4章
 */

import type { BridgeSessionStatus } from "@ark/shared";
import { Mic, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { VoiceState } from "@/lib/voice-mode-machine";

export interface VoiceModeOverlayProps {
  state: VoiceState;
  bridgeStatus?: BridgeSessionStatus;
  onExit: () => void;
  onTapMic: () => void;
  onCancel: () => void;
  onSendNow: () => void;
  onStopSpeaking: () => void;
  onExpand: () => void;
}

export function voicePhaseLabel(
  state: VoiceState,
  bridgeStatus?: BridgeSessionStatus
): string {
  switch (state.phase) {
    case "ready":
      return "タップして話す";
    case "listening":
      return "聞いています";
    case "confirming":
      return "2秒後に送ります";
    case "working":
      if (bridgeStatus === "THINK") return "考えています";
      if (bridgeStatus === "TOOL") return "作業しています";
      return "Claudeの返答を待っています";
    case "speaking":
      return "読み上げています";
    case "screen":
      return "画面で操作してください";
    case "off":
      return "";
  }
}

const PRIMARY_BUTTON =
  "inline-flex h-12 min-w-32 items-center justify-center gap-2 rounded-full bg-primary px-6 text-[15px] font-semibold text-primary-foreground";
const SECONDARY_BUTTON =
  "inline-flex h-12 min-w-32 items-center justify-center gap-2 rounded-full border border-border bg-card px-6 text-[15px] font-semibold text-foreground";

export function VoiceModeOverlay({
  state,
  bridgeStatus,
  onExit,
  onTapMic,
  onCancel,
  onSendNow,
  onStopSpeaking,
  onExpand,
}: VoiceModeOverlayProps) {
  if (state.phase === "off") return null;
  const label = voicePhaseLabel(state, bridgeStatus);

  if (state.phase === "screen") {
    return (
      <button
        type="button"
        data-testid="voice-mode-minimized"
        onClick={onExpand}
        className="fixed inset-x-3 top-[calc(env(safe-area-inset-top)+64px)] z-50 flex h-11 items-center gap-2 rounded-full bg-primary px-4 text-left text-[14px] font-semibold text-primary-foreground shadow-lg"
      >
        <Mic className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">音声モード: {label}</span>
        <span className="shrink-0 text-[13px] opacity-90">戻る</span>
      </button>
    );
  }

  const text =
    state.phase === "speaking"
      ? state.speaking.join("")
      : state.phase === "listening" || state.phase === "confirming"
        ? state.transcript
        : "";
  const active = state.phase === "listening" || state.phase === "speaking";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="音声モード"
      data-testid="voice-mode-overlay"
      className="fixed inset-0 z-50 flex flex-col bg-background text-foreground safe-area-top safe-area-x"
    >
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        <span className="text-[17px] font-semibold">音声モード</span>
        <button
          type="button"
          onClick={onExit}
          aria-label="音声モードを終える"
          className="inline-flex size-10 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
        >
          <X className="size-5" aria-hidden="true" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
        <div
          aria-hidden="true"
          className={cn(
            "flex size-28 items-center justify-center rounded-full bg-primary/15",
            active && "animate-pulse"
          )}
        >
          <Mic className="size-10 text-primary" />
        </div>
        <p
          role="status"
          className="text-[15px] font-semibold text-muted-foreground"
        >
          {label}
        </p>
        {text && (
          <p
            data-testid="voice-mode-text"
            className="max-h-[40vh] overflow-y-auto whitespace-pre-wrap break-words text-[20px] leading-relaxed"
          >
            {text}
          </p>
        )}
        {state.notice && (
          <p className="text-[13px] text-muted-foreground">{state.notice}</p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-center gap-3 px-6 pt-4 pb-[calc(env(safe-area-inset-bottom)+24px)]">
        {state.phase === "ready" && (
          <button type="button" onClick={onTapMic} className={PRIMARY_BUTTON}>
            <Mic className="size-5" aria-hidden="true" />
            話す
          </button>
        )}
        {state.phase === "listening" && (
          <button type="button" onClick={onCancel} className={SECONDARY_BUTTON}>
            やめる
          </button>
        )}
        {state.phase === "confirming" && (
          <>
            <button
              type="button"
              onClick={onCancel}
              className={SECONDARY_BUTTON}
            >
              取り消す
            </button>
            <button
              type="button"
              onClick={onSendNow}
              className={PRIMARY_BUTTON}
            >
              すぐ送る
            </button>
          </>
        )}
        {state.phase === "working" && (
          <button type="button" onClick={onTapMic} className={SECONDARY_BUTTON}>
            <Mic className="size-5" aria-hidden="true" />
            追加で話す
          </button>
        )}
        {state.phase === "speaking" && (
          <button
            type="button"
            onClick={onStopSpeaking}
            className={PRIMARY_BUTTON}
          >
            タップで止める
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: 画面と1タップ操作のテストが通ることを確かめる**

Run: `pnpm exec vitest run packages/web/src/lib/mobile-quick-actions.test.ts packages/web/src/components/VoiceModeOverlay.test.tsx`
Expected: PASS

- [ ] **Step 7: MobileSessionView の失敗するテストを書く**

`packages/web/src/components/MobileSessionView.test.tsx` で、`vi.mock("../hooks/useTtydReconnect", ...)` の次に足す:

```tsx
const voiceDoubles = vi.hoisted(() => ({
  supported: false,
  enter: vi.fn(),
  pushEvents: vi.fn(),
}));

vi.mock("../hooks/useVoiceMode", async () => {
  const { INITIAL_VOICE_STATE } = await import("../lib/voice-mode-machine");
  return {
    useVoiceMode: () => ({
      state: INITIAL_VOICE_STATE,
      supported: voiceDoubles.supported,
      enter: voiceDoubles.enter,
      exit: vi.fn(),
      tapMic: vi.fn(),
      cancel: vi.fn(),
      sendNow: vi.fn(),
      stopSpeaking: vi.fn(),
      expand: vi.fn(),
      pushEvents: voiceDoubles.pushEvents,
    }),
  };
});
```

`ObservedChatProps` に足す:

```ts
  onEventsChange?: (events: unknown[]) => void;
```

`beforeEach` の中に足す:

```ts
  voiceDoubles.supported = false;
  voiceDoubles.enter.mockClear();
  voiceDoubles.pushEvents.mockClear();
```

ファイル末尾の最後の `describe` の中に足す (その `describe` が `MobileSessionView` 全体でない場合は、新しく `describe("MobileSessionView の音声モード", () => { ... })` を作ってその中に置く):

```tsx
  it("音声が使えるブラウザでは、会話モードの1タップ操作に音声モードを出し、押すと入る", () => {
    voiceDoubles.supported = true;
    const container = mount(<MobileSessionView {...makeProps()} />);
    const voiceButton = container.querySelector(
      'button[aria-label="音声モード"]'
    );
    click(voiceButton);
    expect(voiceDoubles.enter).toHaveBeenCalledTimes(1);
  });

  it("音声が使えないブラウザでは音声モードを出さない", () => {
    const container = mount(<MobileSessionView {...makeProps()} />);
    expect(container.querySelector('button[aria-label="音声モード"]')).toBeNull();
  });

  it("会話ビューのイベント列を音声モードへ渡す", () => {
    mount(<MobileSessionView {...makeProps()} />);
    expect(latestChatProps().onEventsChange).toBe(voiceDoubles.pushEvents);
  });
```

- [ ] **Step 8: 失敗を確かめる**

Run: `pnpm exec vitest run packages/web/src/components/MobileSessionView.test.tsx`
Expected: FAIL (音声モードのボタンが無い、`onEventsChange` が undefined)

- [ ] **Step 9: MobileSessionView に組み込む**

`packages/web/src/components/MobileSessionView.tsx` の import に足す:

```ts
import { useVoiceMode } from "../hooks/useVoiceMode";
```

(`../hooks/useVisualViewport` の次)

```ts
import { VoiceModeOverlay } from "./VoiceModeOverlay";
```

(`./ViewerTabBar` の次)

`const hasActiveAuq = activeAuq !== null;` の次に足す:

```ts
  // 音声モード (iPhone)。会話ビューのイベント列と質問カードを受け取り、話して送り、返答を読む。
  // 診断はサーバーのログに1行残す (本文は送らない)
  const emitVoiceDiagnostic = useCallback(
    (kind: string, detail: string) => {
      socket?.emit("voice:diagnostic", { sessionId: session.id, kind, detail });
    },
    [socket, session.id]
  );
  const voice = useVoiceMode({
    isActive,
    isConnected,
    bridgeStatus,
    activeAuq,
    onSendMessage,
    onDiagnostic: emitVoiceDiagnostic,
  });
```

`mobileQuickActions({ ... })` の呼び出しに `canUseVoice: voice.supported,` を足す。

`<MobileQuickActionRow ...>` に `onStartVoice={voice.enter}` を足す (`onManageShortcuts=...` の次)。

`<SplitChatPane ...>` に `onEventsChange={voice.pushEvents}` を足す (`onActiveAuqChange={setActiveAuq}` の次)。

コンポーネントが返すルートの `<div className="flex-1 flex flex-col min-h-0 safe-area-x" ...>` の閉じタグの直前に足す:

```tsx
      <VoiceModeOverlay
        state={voice.state}
        bridgeStatus={bridgeStatus}
        onExit={voice.exit}
        onTapMic={voice.tapMic}
        onCancel={voice.cancel}
        onSendNow={voice.sendNow}
        onStopSpeaking={voice.stopSpeaking}
        onExpand={voice.expand}
      />
```

ファイル先頭のコメント (1行目からの `/** ... */`) の最後に足す:

```ts
 *
 * 音声モード (iPhone) は会話モードの1タップ操作から入る。状態は useVoiceMode、画面は
 * VoiceModeOverlay。JSONL の購読は増やさず、会話ビューのイベント列を onEventsChange で受け取る。
```

- [ ] **Step 10: CLAUDE.md の機能表に足す**

`CLAUDE.md` の「実装済み機能」の表で、`| チャットビュー ...` の行の次に足す:

```markdown
| 音声モード（iPhone）   | 会話モードの1タップ操作から全画面の音声モードに入る。話した指示を2秒の取り消し猶予つきで送り、Claude がターンを終えた返答（JSONL の `stop_reason: "end_turn"`）を読み上げる。質問・権限確認は読み上げて画面での操作に回す。ブラウザ内蔵の音声認識・読み上げだけを使い、画面を点けて前面に出している間だけ動く |
```

- [ ] **Step 11: 通ることを確かめる**

Run: `pnpm exec vitest run packages/web/src/components/MobileSessionView.test.tsx packages/web/src/components/VoiceModeOverlay.test.tsx packages/web/src/lib/mobile-quick-actions.test.ts && pnpm exec tsc -b`
Expected: PASS、tscはエラーなし

- [ ] **Step 12: コミット**

```bash
git add packages/web/src/components/VoiceModeOverlay.tsx packages/web/src/components/VoiceModeOverlay.test.tsx packages/web/src/lib/mobile-quick-actions.ts packages/web/src/lib/mobile-quick-actions.test.ts packages/web/src/components/MobileQuickActionRow.tsx packages/web/src/components/MobileSessionView.tsx packages/web/src/components/MobileSessionView.test.tsx CLAUDE.md
git commit -m "feat(web): 会話モードから音声モードに入れるようにする"
```

---

### Task 9: 全体の検証

**Files:** なし (検証だけ。直しが出たら該当ファイルを直してコミット)

- [ ] **Step 1: 型・lint・全テスト**

Run: `pnpm check && pnpm test`
Expected: どちらもエラーなし

Biomeの整形差分が出たら `pnpm exec biome check --write <ファイル>` で直し、`style: 整形` でコミットする。

- [ ] **Step 2: ビルドが通ることを確かめる**

Run: `pnpm build`
Expected: エラーなし。この worktree の `packages/web/dist` と `packages/server/dist` だけが更新される (本番のArkは別ディレクトリの `claude-code-manager` から動いているので影響しない)

- [ ] **Step 3: 仕様との突き合わせ**

`docs/superpowers/specs/2026-09-19-voice-mode-design.md` の4章の状態表・送る直前の確認・作業中の退路、5章の読み上げ対象と変換表、7章の対処を1項目ずつ読み、実装の該当箇所 (`voice-mode-machine.ts` / `useVoiceMode.ts` / `speech-text.ts` / `voice-turn-signals.ts` / `browser-speech.ts`) を指せることを確かめる。指せない項目があれば、その項目のテストを足して実装する。
