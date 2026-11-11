/** 英語の単数と複数を数で選ぶ (`plural(1, "file", "files")` は "file") */
export function plural(count: number, one: string, other: string): string {
  return count === 1 ? one : other;
}
