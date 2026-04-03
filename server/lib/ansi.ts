/**
 * ANSIエスケープシーケンスを除去するユーティリティ
 */

/** ANSIエスケープシーケンスを除去する正規表現 */
const ANSI_REGEX =
  /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[>=<]|\x0f/g;

/**
 * ANSIエスケープシーケンスを除去してプレーンテキストを返す
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}
