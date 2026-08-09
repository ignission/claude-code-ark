import { describe, expect, it } from "vitest";
import type { ViewerTab } from "../components/TerminalPane";
import { clearCurrentDiagramTab, setCurrentDiagramTab } from "./diagram-tabs";

const terminal: ViewerTab = { type: "terminal", id: "terminal" };
const diagram = (
  id: string,
  relPath: string,
  restoredOnLoad?: boolean
): ViewerTab => ({
  type: "diagram",
  id,
  worktreePath: "/wt",
  relPath,
  restoredOnLoad,
});
const file = (id: string): ViewerTab => ({
  type: "file",
  id,
  filePath: `/${id}.txt`,
  content: "",
  mimeType: "text/plain",
  size: 0,
});
const html = (id: string): ViewerTab => ({
  type: "html",
  id,
  filePath: `/${id}.html`,
});

describe("setCurrentDiagramTab", () => {
  it("図タブが無ければ現在図を1件追加する", () => {
    const result = setCurrentDiagramTab(
      [terminal],
      0,
      "/wt",
      "a.diagram.html",
      "d1"
    );

    expect(result).toEqual({
      tabs: [
        terminal,
        {
          type: "diagram",
          id: "d1",
          worktreePath: "/wt",
          relPath: "a.diagram.html",
          restoredOnLoad: undefined,
        },
      ],
      activeIndex: 0,
    });
  });

  it("同じ図の live open でも新しい id と restoredOnLoad=false へ更新する", () => {
    const result = setCurrentDiagramTab(
      [terminal, diagram("old", "a.diagram.html", true)],
      0,
      "/wt",
      "a.diagram.html",
      "live"
    );

    expect(result.tabs).toHaveLength(2);
    expect(result.tabs[1]).toEqual({
      type: "diagram",
      id: "live",
      worktreePath: "/wt",
      relPath: "a.diagram.html",
      restoredOnLoad: undefined,
    });
  });

  it("別図なら既存 diagram の位置で置換する", () => {
    const f1 = file("f1");
    const result = setCurrentDiagramTab(
      [terminal, diagram("old", "a.diagram.html"), f1],
      2,
      "/wt",
      "b.diagram.html",
      "new"
    );

    expect(result.tabs.map(tab => tab.id)).toEqual(["terminal", "new", "f1"]);
    expect(result.tabs[1]).toMatchObject({
      type: "diagram",
      relPath: "b.diagram.html",
    });
    expect(result.activeIndex).toBe(2);
  });

  it("過去の複数 diagram tabs を現在図1件へ畳み込む", () => {
    const result = setCurrentDiagramTab(
      [
        terminal,
        diagram("a", "a.diagram.html"),
        file("f1"),
        diagram("b", "b.diagram.html"),
        html("h1"),
      ],
      4,
      "/wt",
      "c.diagram.html",
      "current"
    );

    expect(result.tabs.map(tab => tab.id)).toEqual([
      "terminal",
      "current",
      "f1",
      "h1",
    ]);
    expect(result.tabs.filter(tab => tab.type === "diagram")).toHaveLength(1);
  });

  it("reload 復元だけ restoredOnLoad=true を保持する", () => {
    const result = setCurrentDiagramTab(
      [terminal],
      0,
      "/wt",
      "a.diagram.html",
      "restored",
      true
    );

    expect(result.tabs[1]).toMatchObject({
      type: "diagram",
      restoredOnLoad: true,
    });
  });

  it.each([
    { active: 2, expected: 2, label: "file" },
    { active: 4, expected: 3, label: "html" },
  ])(
    "複数 diagram を畳んでも active $label を id で追跡する",
    ({ active, expected }) => {
      const tabs = [
        terminal,
        diagram("a", "a.diagram.html"),
        file("active-file"),
        diagram("b", "b.diagram.html"),
        html("active-html"),
      ];

      const result = setCurrentDiagramTab(
        tabs,
        active,
        "/wt",
        "c.diagram.html",
        "current"
      );

      expect(result.activeIndex).toBe(expected);
      expect(result.tabs[result.activeIndex]?.id).toBe(tabs[active]?.id);
    }
  );

  it("active が diagram を指していた場合だけ terminal へ戻す", () => {
    const result = setCurrentDiagramTab(
      [terminal, diagram("a", "a.diagram.html"), file("f1")],
      1,
      "/wt",
      "b.diagram.html",
      "current"
    );

    expect(result.activeIndex).toBe(0);
    expect(result.tabs[0]).toBe(terminal);
  });
});

describe("clearCurrentDiagramTab", () => {
  it("current relPath 一致時だけ diagram を除去して non-diagram 順序と active id を維持する", () => {
    const tabs = [
      terminal,
      diagram("current", "a.diagram.html"),
      file("active-file"),
      html("h1"),
    ];

    const result = clearCurrentDiagramTab(tabs, 2, "a.diagram.html");

    expect(result.tabs.map(tab => tab.id)).toEqual([
      "terminal",
      "active-file",
      "h1",
    ]);
    expect(result.tabs[result.activeIndex]?.id).toBe("active-file");
  });

  it("不一致の遅延通知は別 current を消さない no-op", () => {
    const tabs = [terminal, diagram("current", "new.diagram.html")];

    expect(clearCurrentDiagramTab(tabs, 0, "old.diagram.html")).toEqual({
      tabs,
      activeIndex: 0,
    });
  });

  it("legacy の複数 diagram は current 一致時にすべて除去する", () => {
    const tabs = [
      terminal,
      diagram("current", "a.diagram.html"),
      file("f1"),
      diagram("legacy", "old.diagram.html"),
      html("h1"),
    ];

    const result = clearCurrentDiagramTab(tabs, 4, "a.diagram.html");

    expect(result.tabs.map(tab => tab.id)).toEqual(["terminal", "f1", "h1"]);
    expect(result.tabs[result.activeIndex]?.id).toBe("h1");
  });

  it("legacy state で diagram が active なら terminal へ戻す", () => {
    const result = clearCurrentDiagramTab(
      [terminal, diagram("current", "a.diagram.html"), file("f1")],
      1,
      "a.diagram.html"
    );

    expect(result.tabs.map(tab => tab.id)).toEqual(["terminal", "f1"]);
    expect(result.activeIndex).toBe(0);
  });
});
