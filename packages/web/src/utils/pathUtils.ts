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

/**
 * path が base そのものか、base の配下にあるか。
 * 単純な前方一致だと `/repos/app-copy` が `/repos/app` に一致してしまうので、
 * ディレクトリの区切りまで含めて比べる
 */
export function isPathWithin(path: string, base: string): boolean {
  const normalizedBase = base.replace(/\/+$/, "");
  return path === normalizedBase || path.startsWith(`${normalizedBase}/`);
}
