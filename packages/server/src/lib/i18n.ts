/**
 * サーバーが利用者に見せる文の言語。
 *
 * 言語はブラウザごとの選択なので、リクエストごとに決める。HTTP のリクエストと socket のイベントを
 * `runWithLocale` の中で処理し、文を作る側は `m()` でその言語の辞書を読む。
 * `AsyncLocalStorage` で運ぶので、奥の関数へ言語を引数で渡さなくてよい。
 *
 * リクエストの外 (タイマー、プロセスのイベント、全員への配信) で作る文は、最後に見た利用者の言語にする。
 * Ark は単一ユーザーの前提なので、その人がいま使っている言語に合わせれば足りる。
 *
 * ここを通すのは利用者に見せる文だけ。サーバーのログと、Claude が読む文 (MCP ツールの説明など) は
 * 英語で直接書く。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingHttpHeaders } from "node:http";
import {
  FALLBACK_LOCALE,
  getMessages,
  type Locale,
  type Messages,
  readLocaleCookie,
  resolveLocale,
} from "@ark/shared/i18n";

const store = new AsyncLocalStorage<Locale>();

/** リクエストの外で使う言語。利用者の接続やリクエストを見るたびに更新する */
let lastSeenLocale: Locale = FALLBACK_LOCALE;

/** `Accept-Language` を、希望の強い順の言語タグに直す (`q` の重みで並べる) */
export function parseAcceptLanguage(header: string | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params
        .map(p => p.trim())
        .find(p => p.startsWith("q="))
        ?.slice(2);
      const weight = q === undefined ? 1 : Number.parseFloat(q);
      return {
        tag: tag.trim(),
        weight: Number.isNaN(weight) ? 0 : weight,
        index,
      };
    })
    .filter(entry => entry.tag !== "" && entry.tag !== "*")
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .map(entry => entry.tag);
}

/**
 * リクエストのヘッダから言語を決める。ブラウザと同じ決め方 (cookie の選択 → 第1希望の言語) にして、
 * 画面とサーバーの文の言語がずれないようにする。
 */
export function localeFromHeaders(headers: IncomingHttpHeaders): Locale {
  const acceptLanguage = headers["accept-language"];
  return resolveLocale(
    readLocaleCookie(headers.cookie),
    parseAcceptLanguage(
      Array.isArray(acceptLanguage) ? acceptLanguage[0] : acceptLanguage
    )
  );
}

/** ブラウザから来たリクエストか (言語の手がかりを持つか)。hook や MCP からの呼び出しは持たない */
export function hasLocaleHint(headers: IncomingHttpHeaders): boolean {
  return (
    readLocaleCookie(headers.cookie) !== null ||
    headers["accept-language"] !== undefined
  );
}

/** この言語で `fn` を実行する。`fn` から始まる非同期の処理にも引き継がれる */
export function runWithLocale<T>(locale: Locale, fn: () => T): T {
  lastSeenLocale = locale;
  return store.run(locale, fn);
}

/** 利用者の言語を覚える (接続した時点など、処理を包まずに言語だけ分かったとき) */
export function rememberLocale(locale: Locale): void {
  lastSeenLocale = locale;
}

/** いま処理しているリクエストの言語 (リクエストの外では、最後に見た利用者の言語) */
export function currentLocale(): Locale {
  return store.getStore() ?? lastSeenLocale;
}

/** いまの言語の辞書。`m().server.sessionNotFound` のように、文を作るその場で呼ぶ */
export function m(): Messages {
  return getMessages(currentLocale());
}

/** テスト用: リクエストの外で使う言語を決める */
export function setLastSeenLocaleForTest(locale: Locale): void {
  lastSeenLocale = locale;
}
