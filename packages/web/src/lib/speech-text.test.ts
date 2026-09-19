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
