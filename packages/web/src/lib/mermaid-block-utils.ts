/** fenced code の className が mermaid 言語かを判定する。 */
export function isMermaidCodeClass(className?: string): boolean {
  if (!className) return false;
  return /\blanguage-mermaid\b/.test(className);
}
