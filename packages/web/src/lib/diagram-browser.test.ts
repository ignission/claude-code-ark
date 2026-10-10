import type { DiagramListItem } from "@ark/shared";
import { describe, expect, it } from "vitest";
import {
  browseDiagrams,
  DEFAULT_DIAGRAM_SORT,
  diagramShortPath,
  formatDiagramTime,
  toggleDiagramSort,
} from "./diagram-browser";

const at = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();

const items: DiagramListItem[] = [
  {
    relPath: ".claude/diagrams/login.diagram.html",
    displayName: "ログインの流れ",
    tracked: false,
    kind: "sequence",
    mtimeMs: at(2026, 10, 9, 12),
  },
  {
    relPath: ".claude/diagrams/palette.diagram.html",
    displayName: "コマンドパレット",
    tracked: false,
    kind: "deck",
    mtimeMs: at(2026, 10, 10, 19, 2),
  },
  {
    relPath: ".claude/diagrams/design/memo.diagram.html",
    displayName: "設計メモ",
    tracked: true,
    kind: "doc",
    mtimeMs: at(2026, 10, 7),
  },
  {
    relPath: ".claude/diagrams/old.diagram.html",
    displayName: "old.diagram.html",
    tracked: true,
  },
];
const names = (list: DiagramListItem[]) => list.map(item => item.displayName);

describe("browseDiagrams", () => {
  it("既定は更新の新しい順。更新日時が無い図は最後", () => {
    expect(names(browseDiagrams(items, "", DEFAULT_DIAGRAM_SORT))).toEqual([
      "コマンドパレット",
      "ログインの流れ",
      "設計メモ",
      "old.diagram.html",
    ]);
  });

  it("名前と種類でも並べられる", () => {
    expect(
      names(browseDiagrams(items, "", { key: "name", dir: "asc" }))[0]
    ).toBe("old.diagram.html");
    expect(
      browseDiagrams(items, "", { key: "kind", dir: "asc" }).map(
        item => item.kind ?? "graph"
      )
    ).toEqual(["deck", "doc", "sequence", "graph"]);
  });

  it("名前とパスの両方で絞り込み、語はすべて含むものだけを残す", () => {
    const sort = DEFAULT_DIAGRAM_SORT;
    expect(names(browseDiagrams(items, "ログイン", sort))).toEqual([
      "ログインの流れ",
    ]);
    expect(names(browseDiagrams(items, "DESIGN memo", sort))).toEqual([
      "設計メモ",
    ]);
    expect(browseDiagrams(items, "無い語", sort)).toEqual([]);
  });

  it("元の配列を並べ替えない", () => {
    const before = names(items);
    browseDiagrams(items, "", { key: "name", dir: "asc" });
    expect(names(items)).toEqual(before);
  });
});

describe("toggleDiagramSort", () => {
  it("同じ列は向きを返し、別の列はその列の自然な向きにする", () => {
    expect(toggleDiagramSort({ key: "mtime", dir: "desc" }, "mtime")).toEqual({
      key: "mtime",
      dir: "asc",
    });
    expect(toggleDiagramSort({ key: "mtime", dir: "desc" }, "name")).toEqual({
      key: "name",
      dir: "asc",
    });
    expect(toggleDiagramSort({ key: "name", dir: "asc" }, "mtime")).toEqual({
      key: "mtime",
      dir: "desc",
    });
  });
});

describe("表示の言葉", () => {
  const now = new Date(2026, 9, 10, 21, 0);

  it("今日は時刻、昨日は「昨日」、今年は月日、それより前は年月日", () => {
    expect(formatDiagramTime(at(2026, 10, 10, 9, 5), now)).toBe("今日 09:05");
    expect(formatDiagramTime(at(2026, 10, 9, 23, 59), now)).toBe("昨日 23:59");
    expect(formatDiagramTime(at(2026, 10, 7, 8), now)).toBe("10/7");
    expect(formatDiagramTime(at(2025, 12, 31, 8), now)).toBe("2025/12/31");
    expect(formatDiagramTime(undefined, now)).toBe("—");
  });

  it("パスは図の置き場を除いて出す", () => {
    expect(diagramShortPath(".claude/diagrams/design/memo.diagram.html")).toBe(
      "design/memo.diagram.html"
    );
    expect(diagramShortPath("other/x.diagram.html")).toBe(
      "other/x.diagram.html"
    );
  });
});
