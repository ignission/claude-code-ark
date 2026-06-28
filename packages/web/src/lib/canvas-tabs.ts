import type { ViewerTab } from "../components/TerminalPane";

/** 図解キャンバスタブを開く/フォーカスする純関数。
 *  同一 mermaidCode のタブが既にあれば重複追加せずそれを active にする。
 *  id は呼び出し側で生成して渡す（純関数化のため Date.now を内部で使わない）。 */
export function addOrFocusCanvasTab(
  tabs: ViewerTab[],
  mermaidCode: string,
  title: string | undefined,
  id: string
): { tabs: ViewerTab[]; activeIndex: number } {
  const existing = tabs.findIndex(
    t => t.type === "canvas" && t.mermaidCode === mermaidCode
  );
  if (existing >= 0) {
    return { tabs, activeIndex: existing };
  }
  const newTab: ViewerTab = { type: "canvas", id, mermaidCode, title };
  const next = [...tabs, newTab];
  return { tabs: next, activeIndex: next.length - 1 };
}
