import { describe, expect, it } from "vitest";
import type { ViewerTab } from "../components/TerminalPane";
import { addOrFocusBoardTab, addOrFocusCanvasTab } from "./canvas-tabs";

const term: ViewerTab = { type: "terminal", id: "terminal" };

describe("addOrFocusCanvasTab", () => {
  it("新規 code は末尾に canvas タブを追加し active にする", () => {
    const r = addOrFocusCanvasTab([term], "flowchart LR\nA-->B", "図1", "c1");
    expect(r.tabs).toHaveLength(2);
    expect(r.tabs[1]).toMatchObject({
      type: "canvas",
      id: "c1",
      mermaidCode: "flowchart LR\nA-->B",
      title: "図1",
    });
    expect(r.activeIndex).toBe(1);
  });

  it("同一 code は既存タブにフォーカスし重複追加しない", () => {
    const start = addOrFocusCanvasTab([term], "X", undefined, "c1").tabs;
    const r = addOrFocusCanvasTab(start, "X", undefined, "c2");
    expect(r.tabs).toHaveLength(2);
    expect(r.activeIndex).toBe(1);
    // 既存配列を不変で返す（新規追加していない）
    expect(r.tabs[1]).toMatchObject({ type: "canvas", id: "c1" });
  });

  it("異なる code は別タブとして追加する", () => {
    const start = addOrFocusCanvasTab([term], "X", undefined, "c1").tabs;
    const r = addOrFocusCanvasTab(start, "Y", undefined, "c2");
    expect(r.tabs).toHaveLength(3);
    expect(r.activeIndex).toBe(2);
  });
});

describe("addOrFocusBoardTab", () => {
  it("board タブがなければ追加して active にする", () => {
    const { tabs, activeIndex } = addOrFocusBoardTab([term]);
    expect(tabs).toHaveLength(2);
    expect(tabs[1]).toEqual({ type: "board", id: "board" });
    expect(activeIndex).toBe(1);
  });

  it("既に board タブがあれば追加せずフォーカスする", () => {
    const first = addOrFocusBoardTab([term]);
    const second = addOrFocusBoardTab(first.tabs);
    expect(second.tabs).toHaveLength(2);
    expect(second.activeIndex).toBe(1);
  });
});
