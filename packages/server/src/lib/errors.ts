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
