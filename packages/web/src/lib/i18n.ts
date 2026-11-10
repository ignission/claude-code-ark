/**
 * 画面の文の言語。
 *
 * 言語はモジュールの読み込み時に1回だけ決める (保存済みの選択 → ブラウザの言語)。
 * 切り替えは保存してリロードする。ラベルをモジュールの定数で持つファイルがあり、
 * その場で差し替えると古い言語の文が残るため。
 *
 * 選択はブラウザごとに持つ (`localStorage`)。サーバーの設定に置くと、
 * PCとモバイルで言語を変えられず、最初の描画にも間に合わない。
 */
import {
  getMessages,
  type Locale,
  type Messages,
  resolveLocale,
} from "@ark/shared/i18n";

export const LOCALE_STORAGE_KEY = "ark.locale";

function readSavedLocale(): string | null {
  try {
    return globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY) ?? null;
  } catch {
    // プライベートブラウズなどで localStorage が使えないときは、ブラウザの言語で決める
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
    globalThis.localStorage.setItem(LOCALE_STORAGE_KEY, next);
  } catch {
    return;
  }
  globalThis.location.reload();
}

/** テスト用: リロードせずに言語を差し替える。ほかのモジュールを読み込む前に呼ぶ */
export function setLocaleForTest(next: Locale): void {
  locale = next;
  m = getMessages(next);
  applyDocumentLang();
}
