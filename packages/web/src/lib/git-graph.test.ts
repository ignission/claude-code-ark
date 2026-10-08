import { describe, expect, it } from "vitest";
import { GRAPH_COLOR_COUNT, type GraphSegment, layoutGraph } from "./git-graph";

const c = (sha: string, ...parents: string[]) => ({ sha, parents });

/** segment を比較しやすい文字列にする (順序に依存しない比較用) */
const seg = (s: GraphSegment) => `${s.kind}:${s.fromColumn}>${s.toColumn}`;
const segs = (row: { segments: GraphSegment[] }) =>
  row.segments.map(seg).sort();

describe("layoutGraph", () => {
  it("空配列は空配列", () => {
    expect(layoutGraph([])).toEqual([]);
  });

  it("線形履歴はすべて列 0 で、中間行は in と out を 1 本ずつ持つ", () => {
    const rows = layoutGraph([c("c", "b"), c("b", "a"), c("a")]);
    expect(rows.map(r => r.column)).toEqual([0, 0, 0]);
    expect(segs(rows[0])).toEqual(["out:0>0"]);
    expect(segs(rows[1])).toEqual(["in:0>0", "out:0>0"]);
    expect(segs(rows[2])).toEqual(["in:0>0"]);
    expect(rows.every(r => r.columns === 1 && !r.isMerge)).toBe(true);
  });

  it("枝とマージ: 側枝が列 1 を使い、基点の行で 2 本が in として合流する", () => {
    const rows = layoutGraph([
      c("M", "a", "b"),
      c("b", "base"),
      c("a", "base"),
      c("base"),
    ]);
    // 本線 (M → a → base) は列 0 のまま動かない
    expect(rows.map(r => r.column)).toEqual([0, 1, 0, 0]);
    expect(rows[0].isMerge).toBe(true);
    expect(segs(rows[0])).toEqual(["out:0>0", "out:0>1"]);
    expect(segs(rows[1])).toEqual(["in:1>1", "out:1>1", "pass:0>0"]);
    expect(segs(rows[2])).toEqual(["in:0>0", "out:0>0", "pass:1>1"]);
    expect(segs(rows[3])).toEqual(["in:0>0", "in:1>0"]);
    expect(rows[3].columns).toBe(2);
  });

  it("本線が先に来る並びでも、基点で合流する", () => {
    const rows = layoutGraph([
      c("M", "a", "b"),
      c("a", "base"),
      c("b", "base"),
      c("base"),
    ]);
    expect(rows.map(r => r.column)).toEqual([0, 0, 1, 0]);
    expect(segs(rows[2])).toEqual(["in:1>1", "out:1>1", "pass:0>0"]);
    expect(segs(rows[3])).toEqual(["in:0>0", "in:1>0"]);
  });

  it("3 本の並行枝は列 0 / 1 / 2 を使う", () => {
    const rows = layoutGraph([
      c("A", "a"),
      c("B", "b"),
      c("C", "c"),
      c("a"),
      c("b"),
      c("c"),
    ]);
    expect(rows.map(r => r.column)).toEqual([0, 1, 2, 0, 1, 2]);
    expect(rows[2].columns).toBe(3);
    expect(segs(rows[2])).toEqual(["out:2>2", "pass:0>0", "pass:1>1"]);
    expect(segs(rows[3])).toEqual(["in:0>0", "pass:1>1", "pass:2>2"]);
  });

  it("octopus マージは親の数だけ out を出す", () => {
    const rows = layoutGraph([c("M", "p", "q", "r"), c("p"), c("q"), c("r")]);
    expect(rows[0].isMerge).toBe(true);
    expect(segs(rows[0])).toEqual(["out:0>0", "out:0>1", "out:0>2"]);
    expect(rows[0].columns).toBe(3);
    expect(rows.map(r => r.column)).toEqual([0, 0, 1, 2]);
  });

  it("切り詰められた履歴: 親が現れなくても out が残り、落ちない", () => {
    const rows = layoutGraph([c("c1", "c0")]);
    expect(segs(rows[0])).toEqual(["out:0>0"]);
  });

  it("重複する親・未知の sha でも落ちず、out は重複しない", () => {
    const rows = layoutGraph([c("m", "a", "a"), c("x", "nowhere"), c("a")]);
    expect(segs(rows[0])).toEqual(["out:0>0"]);
    expect(rows).toHaveLength(3);
  });

  it("無関係な 2 つのルートはどちらも列 0", () => {
    const rows = layoutGraph([c("a"), c("b")]);
    expect(rows.map(r => r.column)).toEqual([0, 0]);
    expect(segs(rows[1])).toEqual([]);
  });

  it("別の列が開いている間に枝の先端が現れると、その列は pass になる", () => {
    const rows = layoutGraph([c("A", "x"), c("B", "y")]);
    expect(rows[1].column).toBe(1);
    expect(segs(rows[1])).toEqual(["out:1>1", "pass:0>0"]);
  });

  it("空いた列は左から再利用する", () => {
    const rows = layoutGraph([
      c("A", "r"),
      c("B", "r"), // 列 1
      c("r"), // 列 0 と列 1 が合流して両方空く
      c("X", "y"), // 列 0 を再利用
      c("Z", "y"), // 列 1 を再利用
    ]);
    expect(rows.map(r => r.column)).toEqual([0, 1, 0, 0, 1]);
    expect(segs(rows[2])).toEqual(["in:0>0", "in:1>0"]);
  });

  it("色は範囲内で、列は先端からマージまで同じ色を保つ", () => {
    const rows = layoutGraph([
      c("M", "a", "b"),
      c("b", "base"),
      c("a", "base"),
      c("base"),
    ]);
    for (const r of rows) {
      expect(r.color).toBeGreaterThanOrEqual(0);
      expect(r.color).toBeLessThan(GRAPH_COLOR_COUNT);
      for (const s of r.segments) {
        expect(s.color).toBeGreaterThanOrEqual(0);
        expect(s.color).toBeLessThan(GRAPH_COLOR_COUNT);
      }
    }
    const side = rows[0].segments.find(s => seg(s) === "out:0>1");
    expect(side?.color).toBe(rows[1].color);
    expect(
      rows[1].segments.every(
        s => s.color === rows[1].color || s.kind === "pass"
      )
    ).toBe(true);
    // 側枝の色は、基点へ合流する in まで変わらない
    const merged = rows[3].segments.find(s => seg(s) === "in:1>0");
    expect(merged?.color).toBe(rows[1].color);
  });

  it("色は GRAPH_COLOR_COUNT で一巡する", () => {
    const tips = Array.from({ length: GRAPH_COLOR_COUNT + 2 }, (_, i) =>
      c(`t${i}`, `p${i}`)
    );
    const rows = layoutGraph(tips);
    expect(rows[GRAPH_COLOR_COUNT].color).toBe(0);
    expect(rows[GRAPH_COLOR_COUNT + 1].color).toBe(1);
  });

  it("5,000 コミットの線形履歴が速く終わる", () => {
    const n = 5000;
    const commits = Array.from({ length: n }, (_, i) =>
      c(`s${n - i}`, ...(i === n - 1 ? [] : [`s${n - i - 1}`]))
    );
    const t0 = performance.now();
    const rows = layoutGraph(commits);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(rows).toHaveLength(n);
    expect(rows.every(r => r.column === 0)).toBe(true);
  });
});
