/**
 * パス操作ユーティリティ
 *
 * ファイルパスの分解・表示名の取得などを提供する。
 */

/**
 * パスの親ディレクトリを返す
 */
export function getParentPath(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash >= 0 ? path.substring(0, lastSlash) : "";
}

/**
 * パスの末尾のファイル名・ディレクトリ名を返す
 */
export function getBaseName(path: string): string {
  return path.substring(path.lastIndexOf("/") + 1);
}
