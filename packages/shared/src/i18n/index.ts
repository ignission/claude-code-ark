/**
 * 表示する文の辞書と、言語の決め方。
 *
 * - 辞書は日本語 (`ja/`) がキーの正本。英語 (`en/`) は `Messages` 型で同じ形を強制されるので、
 *   訳し漏れは型検査で落ちる
 * - 値は文字列か、引数を取って文字列を返す関数。途中に値が挟まる文も断片に分けず、
 *   1つの関数にする (言語で語順が違うため)
 * - 画面や音声の照合に使う文字 (文末の句点を見る正規表現など) は辞書に入れない。
 *   訳すと照合が壊れる
 */
import { en } from "./en";
import { ja, type Messages } from "./ja";

export { plural } from "./plural";
export type { Messages };

export const LOCALES = ["ja", "en"] as const;
export type Locale = (typeof LOCALES)[number];

/** ブラウザの言語が日本語でないときと、言語が分からないときに使う */
export const FALLBACK_LOCALE: Locale = "en";

const DICTIONARIES: Record<Locale, Messages> = { ja, en };

export function isLocale(value: unknown): value is Locale {
  return (LOCALES as readonly unknown[]).includes(value);
}

export function getMessages(locale: Locale): Messages {
  return DICTIONARIES[locale];
}

/**
 * 言語を決める。保存済みの選択があればそれを使い、無ければ利用者の第1希望の言語で決める
 * (`ja` と `ja-JP` は日本語、それ以外は英語)。
 */
export function resolveLocale(
  saved: unknown,
  preferred: readonly string[]
): Locale {
  if (isLocale(saved)) return saved;
  const first = preferred[0]?.toLowerCase();
  if (first === undefined) return FALLBACK_LOCALE;
  return first === "ja" || first.startsWith("ja-") ? "ja" : FALLBACK_LOCALE;
}
