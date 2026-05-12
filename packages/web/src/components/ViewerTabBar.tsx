import type { ViewerTab } from "./TerminalPane";

interface ViewerTabBarProps {
  tabs: ViewerTab[];
  activeTabIndex: number;
  onTabSelect: (index: number) => void;
  onTabClose: (index: number) => void;
}

function getTabLabel(tab: ViewerTab): string {
  if (tab.type === "terminal") return "Terminal";
  if (tab.type === "html") return tab.filePath?.split("/").pop() || "HTML";
  return tab.filePath?.split("/").pop() || "File";
}

export function ViewerTabBar({
  tabs,
  activeTabIndex,
  onTabSelect,
  onTabClose,
}: ViewerTabBarProps) {
  if (tabs.length <= 1) return null;

  return (
    <div className="flex items-center border-b border-border bg-muted/30 overflow-x-auto shrink-0">
      {tabs.map((tab, i) => {
        const isActive = i === activeTabIndex;
        return (
          <button
            type="button"
            key={tab.id}
            className={`flex items-center gap-1 px-3 py-1.5 text-xs cursor-pointer border-r border-border whitespace-nowrap ${
              isActive
                ? "bg-background text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
            }`}
            onClick={() => onTabSelect(i)}
          >
            <span>{getTabLabel(tab)}</span>
            {tab.type !== "terminal" && (
              <button
                type="button"
                className="ml-1 hover:text-destructive"
                onClick={e => {
                  e.stopPropagation();
                  onTabClose(i);
                }}
                aria-label={`Close ${getTabLabel(tab)}`}
              >
                ×
              </button>
            )}
          </button>
        );
      })}
    </div>
  );
}
