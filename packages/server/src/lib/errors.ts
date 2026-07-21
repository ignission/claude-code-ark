/**
 * エラーメッセージ抽出ユーティリティ
 */

/**
 * unknown型のエラーからメッセージ文字列を安全に取得する
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown error";
}

/** errno を持つ例外から code を取り出す（無ければ "UNKNOWN"） */
export function errnoCode(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
}

/**
 * errno 例外のメッセージを取り出す。Error でなければ String() で文字列化する
 * （getErrorMessage は非 Error を "Unknown error" に潰すが、errno 系のログでは
 * 元の値を残したいのでこちらを使う）。
 */
export function errnoMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
