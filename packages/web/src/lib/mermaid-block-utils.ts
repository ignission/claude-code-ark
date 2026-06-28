/** fenced code の className が mermaid 言語かを判定する。 */
export function isMermaidCodeClass(className?: string): boolean {
  if (!className) return false;
  return /\blanguage-mermaid\b/.test(className);
}

export type MermaidRenderResult =
  | { ok: true; svg: string }
  | { ok: false; error: string };

/** mermaid を strict 設定で初期化し、code を SVG にレンダリングする。
 *  initialize は冪等なため毎回呼ぶ（テスト決定性 + 設定取りこぼし防止）。
 *  失敗時は throw せず ok:false を返す。 */
export async function renderMermaidToSvg(
  code: string,
  id: string
): Promise<MermaidRenderResult> {
  try {
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "default",
    });
    const { svg } = await mermaid.render(id, code);
    return { ok: true, svg };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
