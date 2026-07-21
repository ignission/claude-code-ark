import { describe, expect, it } from "vitest";
import type { ViewerTab } from "../components/TerminalPane";
import { addOrFocusDiagramTab } from "./diagram-tabs";

const base: ViewerTab[] = [{ type: "terminal", id: "terminal" }];

describe("addOrFocusDiagramTab", () => {
  it("図タブが無ければ追加する", () => {
    const tabs = addOrFocusDiagramTab(base, "/wt", "a.diagram.html", "d1");

    expect(tabs).toHaveLength(2);
    expect(tabs[1]).toEqual({
      type: "diagram",
      id: "d1",
      worktreePath: "/wt",
      relPath: "a.diagram.html",
    });
  });

  it("同じ図が既に開いていれば追加しない（配列をそのまま返す）", () => {
    const first = addOrFocusDiagramTab(base, "/wt", "a.diagram.html", "d1");

    const second = addOrFocusDiagramTab(first, "/wt", "a.diagram.html", "d2");

    expect(second).toHaveLength(2);
    expect(second).toBe(first); // 変更が無いので同じ参照を返す
  });

  it("別の図は別タブとして追加する", () => {
    const first = addOrFocusDiagramTab(base, "/wt", "a.diagram.html", "d1");

    const second = addOrFocusDiagramTab(first, "/wt", "b.diagram.html", "d2");

    expect(second).toHaveLength(3);
  });

  it("restoredOnLoad=true で追加したタブはそのフラグを持つ", () => {
    const tabs = addOrFocusDiagramTab(
      base,
      "/wt",
      "a.diagram.html",
      "d1",
      true
    );

    expect(tabs[1]).toMatchObject({ type: "diagram", restoredOnLoad: true });
  });

  it("restoredOnLoad は省略時 undefined になる（通常の live open）", () => {
    const tabs = addOrFocusDiagramTab(base, "/wt", "a.diagram.html", "d1");

    expect((tabs[1] as { restoredOnLoad?: boolean }).restoredOnLoad).toBe(
      undefined
    );
  });
});
