// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GraphRow } from "@/lib/git-graph";
import { GitGraphCell, GRAPH_MAX_COLUMNS, graphWidth } from "./GitGraphCell";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

function mount(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mounted.push({ root, container });
  return container;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

const row = (overrides: Partial<GraphRow> = {}): GraphRow => ({
  sha: "a",
  column: 0,
  color: 0,
  isMerge: false,
  segments: [],
  columns: 1,
  ...overrides,
});

const paths = (scope: ParentNode) =>
  [...scope.querySelectorAll("path")].map(p => ({
    kind: p.getAttribute("data-kind"),
    d: p.getAttribute("d"),
    stroke: p.getAttribute("stroke"),
  }));
const nodes = (scope: ParentNode) =>
  [...scope.querySelectorAll("circle")].map(c => c.getAttribute("data-node"));

describe("GitGraphCell", () => {
  it("素通り・入る線・出る線を、行の上端から下端までつながる形で描く", () => {
    const container = mount(
      <GitGraphCell
        row={row({
          column: 0,
          color: 2,
          columns: 3,
          segments: [
            { kind: "in", fromColumn: 0, toColumn: 0, color: 2 },
            { kind: "in", fromColumn: 2, toColumn: 0, color: 4 },
            { kind: "pass", fromColumn: 1, toColumn: 1, color: 3 },
            { kind: "out", fromColumn: 0, toColumn: 0, color: 2 },
          ],
        })}
      />
    );
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe(String(graphWidth(3)));
    expect(svg?.getAttribute("height")).toBe("28");
    expect(paths(container)).toEqual([
      // 同じ列は直線。レーンの x は 6 + 列 × 14 + 7
      { kind: "in", d: "M 13 0 V 14", stroke: "var(--git-lane-2)" },
      // 列が違えば、両端が垂直な曲線
      {
        kind: "in",
        d: "M 41 0 C 41 7, 13 7, 13 14",
        stroke: "var(--git-lane-4)",
      },
      { kind: "pass", d: "M 27 0 V 28", stroke: "var(--git-lane-3)" },
      { kind: "out", d: "M 13 14 V 28", stroke: "var(--git-lane-2)" },
    ]);
    expect(nodes(container)).toEqual(["commit"]);
    const node = container.querySelector("circle");
    expect(node?.getAttribute("cx")).toBe("13");
    expect(node?.getAttribute("cy")).toBe("14");
    expect(node?.getAttribute("fill")).toBe("var(--git-lane-2)");
  });

  it("別の列へ出る線は曲線で下端まで届く", () => {
    const container = mount(
      <GitGraphCell
        row={row({
          columns: 2,
          isMerge: true,
          segments: [{ kind: "out", fromColumn: 0, toColumn: 1, color: 1 }],
        })}
      />
    );
    expect(paths(container)[0].d).toBe("M 13 14 C 13 21, 27 21, 27 28");
  });

  it("マージは輪 (中を塗らない)", () => {
    const container = mount(<GitGraphCell row={row({ isMerge: true })} />);
    expect(nodes(container)).toEqual(["merge"]);
    const node = container.querySelector("circle");
    expect(node?.getAttribute("stroke")).toBe("var(--git-lane-0)");
    expect(node?.getAttribute("fill")).toBe("var(--background)");
  });

  it("HEAD は外側に輪を足す", () => {
    const container = mount(<GitGraphCell row={row()} isHead />);
    expect(nodes(container)).toEqual(["head-ring", "commit"]);
  });

  it("未コミットの変更は点線の輪", () => {
    const container = mount(<GitGraphCell row={row()} isWorking />);
    expect(nodes(container)).toEqual(["working"]);
    expect(
      container.querySelector("circle")?.getAttribute("stroke-dasharray")
    ).not.toBeNull();
  });

  it("列が多すぎるときは幅を止めて、右端をぼかす", () => {
    const wide = mount(
      <GitGraphCell row={row({ columns: GRAPH_MAX_COLUMNS + 5 })} />
    );
    expect(wide.querySelector("svg")?.getAttribute("width")).toBe(
      String(graphWidth(GRAPH_MAX_COLUMNS))
    );
    expect(wide.querySelector('[data-testid="git-graph-fade"]')).not.toBeNull();

    const narrow = mount(<GitGraphCell row={row({ columns: 3 })} />);
    expect(narrow.querySelector('[data-testid="git-graph-fade"]')).toBeNull();
  });
});
