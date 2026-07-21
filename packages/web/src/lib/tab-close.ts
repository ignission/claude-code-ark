/**
 * タブを閉じたあとの activeTab インデックス補正（純関数）。
 *
 * useViewerTabs.ts の handleTabClose から切り出し、テスト可能にする。
 * `diagram-tabs.ts` と同じ方針: 状態を持たず、テストからは配列とインデックスの
 * 入出力だけで検証できるようにする。
 */
import type { ViewerTab } from "../components/TerminalPane";

/**
 * @param tabsAfterClose 閉じたタブを splice 済みの配列
 * @param closedIndex 閉じたタブの（splice 前の）インデックス
 * @param prevActiveIndex 閉じる前の activeTab インデックス
 * @returns 補正後の activeTab インデックス
 */
export function correctActiveIndexAfterClose(
  tabsAfterClose: ViewerTab[],
  closedIndex: number,
  prevActiveIndex: number
): number {
  if (!(prevActiveIndex >= closedIndex && prevActiveIndex > 0)) {
    return prevActiveIndex;
  }

  let next = prevActiveIndex - 1;
  // diagram タブはタブバーに表示されない（右ペイン専属）ため、補正後の
  // インデックスがそこに着地すると TerminalPane に描画分岐が無く左ペインが
  // 空白になる。着地候補が diagram の間はさらに手前へずらす。
  // index 0 は常に terminal（close 不可）なのでループは必ず停止する。
  while (next > 0 && tabsAfterClose[next]?.type === "diagram") {
    next -= 1;
  }
  return next;
}
