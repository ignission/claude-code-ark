/**
 * 画面の文の言語。
 *
 * 言語はモジュールの読み込み時に1回だけ決める (保存済みの選択 → ブラウザの言語)。
 * 切り替えは保存してリロードする。ラベルをモジュールの定数で持つファイルがあり、
 * その場で差し替えると古い言語の文が残るため。
 *
 * 選択はブラウザごとに cookie で持つ (名前と理由は shared の `LOCALE_COOKIE`)。
 * サーバーの設定に置くと、PCとモバイルで言語を変えられず、最初の描画にも間に合わない。
 */
import {
  getMessages,
  LOCALE_COOKIE,
  type Locale,
  type Messages,
  readLocaleCookie,
  resolveLocale,
} from "@ark/shared/i18n";

/** 選択を覚えておく期間 (1年) */
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** 言語の名前は、その言語自身で書く (読めない言語に切り替えても戻れるように) */
export const LOCALE_NAMES: Record<Locale, string> = {
  ja: "日本語",
  en: "English",
};

function readSavedLocale(): string | null {
  try {
    return readLocaleCookie(globalThis.document?.cookie);
  } catch {
    // cookie を読めない環境 (sandbox の iframe など) では、ブラウザの言語で決める
    return null;
  }
}

function detectLocale(): Locale {
  const nav = globalThis.navigator;
  const preferred = nav?.languages?.length
    ? nav.languages
    : nav?.language
      ? [nav.language]
      : [];
  return resolveLocale(readSavedLocale(), preferred);
}

/** いまの言語 */
export let locale: Locale = detectLocale();

/** いまの言語の辞書。`m.common.cancel` のように読む */
export let m: Messages = getMessages(locale);

function applyDocumentLang(): void {
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}
applyDocumentLang();

/** 言語を選び直す。保存してリロードする (保存できなければ何もしない) */
export function changeLocale(next: Locale): void {
  if (next === locale) return;
  try {
    // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API は Safari で使えない版がある
    document.cookie = `${LOCALE_COOKIE}=${next}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
  } catch {
    return;
  }
  if (readSavedLocale() !== next) return;
  globalThis.location.reload();
}

/** テスト用: リロードせずに言語を差し替える。ほかのモジュールを読み込む前に呼ぶ */
export function setLocaleForTest(next: Locale): void {
  locale = next;
  m = getMessages(next);
  applyDocumentLang();
}
