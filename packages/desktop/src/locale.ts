/**
 * デスクトップ (Electron のメインプロセス) が自分で出す文の言語。
 *
 * サーバーの `m()` はリクエストごとの言語を読むので、ここでは使えない
 * (メインプロセスが出すダイアログには、リクエストが無い)。OS の言語から決める。
 *
 * `app.getLocale()` は `app` の ready より後でないと正しい値を返さない。
 * そのため起動時に辞書を定数へ持たず、文を出すその場で `desktopMessages()` を呼ぶ。
 */
import { getMessages, type Messages, resolveLocale } from "@ark/shared/i18n";
import { app } from "electron";

/** OS の言語の辞書 (日本語でなければ英語)。`app` の ready より後に呼ぶ */
export function desktopMessages(): Messages["desktop"] {
  return getMessages(resolveLocale(null, [app.getLocale()])).desktop;
}
