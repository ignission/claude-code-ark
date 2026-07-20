import { describe, expect, it } from "vitest";
import type { ViewerTab } from "../components/TerminalPane";
import { addOrFocusDiagramTab } from "./diagram-tabs";

const base: ViewerTab[] = [{ type: "terminal", id: "terminal" }];

describe("addOrFocusDiagramTab", () => {
  it("図タブが無ければ追加する", () => {
    const { tabs, activeIndex } = addOrFocusDiagramTab(
      base,
      "/wt",
      "a.diagram.html",
      "d1"
    );

    expect(tabs).toHaveLength(2);
    expect(tabs[1]).toEqual({
      type: "diagram",
      id: "d1",
      worktreePath: "/wt",
      relPath: "a.diagram.html",
    });
    expect(activeIndex).toBe(1);
  });

  it("同じ図が既に開いていれば追加せずその index を返す", () => {
    const first = addOrFocusDiagramTab(base, "/wt", "a.diagram.html", "d1");

    const second = addOrFocusDiagramTab(
      first.tabs,
      "/wt",
      "a.diagram.html",
      "d2"
    );

    expect(second.tabs).toHaveLength(2);
    expect(second.activeIndex).toBe(1);
  });

  it("別の図は別タブとして追加する", () => {
    const first = addOrFocusDiagramTab(base, "/wt", "a.diagram.html", "d1");

    const second = addOrFocusDiagramTab(
      first.tabs,
      "/wt",
      "b.diagram.html",
      "d2"
    );

    expect(second.tabs).toHaveLength(3);
    expect(second.activeIndex).toBe(2);
  });
});
