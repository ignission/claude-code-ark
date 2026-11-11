/**
 * speech-text - Claude の返答 (Markdown) を、音声モードで読み上げる文の配列に変える。
 *
 * 耳で聞いて意味を持たないもの (コード、表、URL、長いパス) は読まず、「画面で」と一言に
 * 置き換える。Claude に音声向けの書き方をさせるのではなく、読む側で選ぶ
 * (セッションへの注入は CLAUDE.md の「コンテキスト機構は持たない」の「こだま」に当たる)。
 *
 * 文ごとに分けて返すのは、呼び出し側が1文ずつ別の発話にするため
 * (長い1発話は途中で切れることがある)。
 *
 * 読み上げる文言は辞書 (`m.voice.speech`) にある。文の区切りと文末を見る正規表現は照合の規則なので、
 * 辞書に入れずここに持つ。日本語の句読点はどの言語でも見る (返答が日本語のことがある)。
 * 英語のときだけ、空白が続くピリオドも文の区切りに足す。
 */

import type { Locale } from "@ark/shared/i18n";
import { locale, m } from "@/lib/i18n";

/** 1回の返答で読む上限 (文字数)。超えた分は読まず CONTINUED_SUFFIX で締める */
export const SPEECH_MAX_CHARS = 300;
export const CODE_PLACEHOLDER = m.voice.speech.codePlaceholder;
export const TABLE_PLACEHOLDER = m.voice.speech.tablePlaceholder;
export const CONTINUED_SUFFIX = m.voice.speech.continued;
export const ANSWER_ON_SCREEN = m.voice.speech.answerOnScreen;
export const CONFIRM_ON_SCREEN = m.voice.speech.confirmOnScreen;
export const REPLY_ON_SCREEN = m.voice.speech.replyOnScreen;

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
    .replace(/\u0060/g, "")
    .replace(EMPHASIS_RE, "")
    .replace(EMOJI_RE, "")
    .replace(/\s+/g, " ")
    .replace(SPACE_NEAR_CJK_RE, "")
    .trim();
}

/** 文の区切り。英語は `v1.2` や `file.ts` を割らないよう、空白が続くピリオドだけを区切りにする */
const SENTENCE_BREAK_RE: Record<Locale, RegExp> = {
  ja: /(?<=[。！？!?])/,
  en: /(?<=[。！？!?])|(?<=\.)\s+/,
};
/** 文末で終わっているか */
const SENTENCE_END_RE: Record<Locale, RegExp> = {
  ja: /[。！？!?]$/,
  en: /[。！？!?.]$/,
};

export function endsWithSentenceEnd(
  text: string,
  lang: Locale = locale
): boolean {
  return SENTENCE_END_RE[lang].test(text);
}

export function splitSentences(text: string, lang: Locale = locale): string[] {
  return text
    .split(SENTENCE_BREAK_RE[lang])
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
  const out = [m.voice.speech.questionIntro];
  for (const q of questions) {
    out.push(...splitSentences(cleanLine(q.question)));
    const labels = q.options
      .map(option => cleanLine(option.label))
      .filter(Boolean);
    if (labels.length > 0) out.push(m.voice.speech.options(labels));
  }
  out.push(ANSWER_ON_SCREEN);
  return out;
}
