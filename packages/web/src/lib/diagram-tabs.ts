/**
 * 右ペインの現在図を設定する純関数。
 * diagram 以外のタブとその順序を保ち、diagram は最大1件へ正規化する。
 */
import type { ViewerTab } from "../components/TerminalPane";

export interface CurrentDiagramTabResult {
  tabs: ViewerTab[];
  activeIndex: number;
}

export function setCurrentDiagramTab(
  tabs: ViewerTab[],
  activeIndex: number,
  worktreePath: string,
  relPath: string,
  id: string,
  restoredOnLoad?: boolean
): CurrentDiagramTabResult {
  const currentActiveTab = tabs[activeIndex];
  const firstDiagramIndex = tabs.findIndex(tab => tab.type === "diagram");
  const nextDiagram: ViewerTab = {
    type: "diagram",
    id,
    worktreePath,
    relPath,
    restoredOnLoad,
  };

  const nextTabs: ViewerTab[] = tabs.filter(tab => tab.type !== "diagram");
  if (firstDiagramIndex < 0) {
    nextTabs.push(nextDiagram);
  } else {
    const insertionIndex = tabs
      .slice(0, firstDiagramIndex)
      .filter(tab => tab.type !== "diagram").length;
    nextTabs.splice(insertionIndex, 0, nextDiagram);
  }

  if (!currentActiveTab || currentActiveTab.type === "diagram") {
    const terminalIndex = nextTabs.findIndex(tab => tab.type === "terminal");
    return {
      tabs: nextTabs,
      activeIndex: terminalIndex >= 0 ? terminalIndex : 0,
    };
  }

  const nextActiveIndex = nextTabs.findIndex(
    tab => tab.id === currentActiveTab.id
  );
  return {
    tabs: nextTabs,
    activeIndex: nextActiveIndex >= 0 ? nextActiveIndex : 0,
  };
}

/**
 * 削除通知が現在図と一致する場合だけ diagram state を空にする。
 * legacy state の複数 diagram はまとめて除去するが、別図を開いた後に届いた
 * 古い通知では現在図を変更しない。
 */
export function clearCurrentDiagramTab(
  tabs: ViewerTab[],
  activeIndex: number,
  relPath: string
): CurrentDiagramTabResult {
  const currentDiagram = tabs.find(tab => tab.type === "diagram");
  if (
    !currentDiagram ||
    currentDiagram.type !== "diagram" ||
    currentDiagram.relPath !== relPath
  ) {
    return { tabs, activeIndex };
  }

  const activeTab = tabs[activeIndex];
  const nextTabs = tabs.filter(tab => tab.type !== "diagram");
  if (!activeTab || activeTab.type === "diagram") {
    const terminalIndex = nextTabs.findIndex(tab => tab.type === "terminal");
    return {
      tabs: nextTabs,
      activeIndex: terminalIndex >= 0 ? terminalIndex : 0,
    };
  }

  const nextActiveIndex = nextTabs.findIndex(tab => tab.id === activeTab.id);
  return {
    tabs: nextTabs,
    activeIndex: nextActiveIndex >= 0 ? nextActiveIndex : 0,
  };
}
