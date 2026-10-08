import { describe, expect, it } from "vitest";
import { layoutGraph } from "./git-graph";
import { layoutGraphWithWorking, WORKING_SHA } from "./git-graph-rows";

const c = (sha: string, ...parents: string[]) => ({ sha, parents });

describe("layoutGraphWithWorking", () => {
  // x は別のブランチの新しいコミット。HEAD (h) は 2 行目にある
  const commits = [c("x", "b"), c("h", "b"), c("b")];

  it("変更があるとき、仮の行から HEAD の列まで線がつながる", () => {
    const { working, rows } = layoutGraphWithWorking(commits, "h", true);
    expect(working?.sha).toBe(WORKING_SHA);
    expect(working?.column).toBe(0);
    expect(working?.segments).toEqual([
      { kind: "out", fromColumn: 0, toColumn: 0, color: working?.color },
    ]);
    // x は HEAD を待つ列を避けて隣に置かれ、HEAD への線が素通りする
    expect(rows[0].column).toBe(1);
    expect(rows[0].segments).toContainEqual({
      kind: "pass",
      fromColumn: 0,
      toColumn: 0,
      color: working?.color,
    });
    expect(rows[1].column).toBe(0);
    expect(rows[1].segments).toContainEqual({
      kind: "in",
      fromColumn: 0,
      toColumn: 0,
      color: working?.color,
    });
  });

  it("変更が無くても列と色は変わらず、仮の行の線だけが消える", () => {
    const dirty = layoutGraphWithWorking(commits, "h", true);
    const clean = layoutGraphWithWorking(commits, "h", false);
    expect(clean.working).toBeNull();
    expect(clean.rows.map(r => [r.sha, r.column, r.color])).toEqual(
      dirty.rows.map(r => [r.sha, r.column, r.color])
    );
    expect(clean.rows[0].segments.some(s => s.kind === "pass")).toBe(false);
    expect(clean.rows[1].segments.some(s => s.kind === "in")).toBe(false);
    // HEAD より下の線はそのまま
    expect(clean.rows[2].segments).toEqual(dirty.rows[2].segments);
  });

  it("HEAD を第 2 親に持つマージが上にあれば、合流した線は変更が無くても残す", () => {
    // m は別のブランチが HEAD (h) を取り込んだマージ
    const merged = [c("m", "x", "h"), c("x", "b"), c("h", "b"), c("b")];
    const { working, rows } = layoutGraphWithWorking(merged, "h", false);
    expect(working).toBeNull();
    const [m, x, h] = rows;
    // m から HEAD の列 (0) へ線が出る。合流点より上の素通りは無い
    expect(m.segments).toContainEqual(
      expect.objectContaining({
        kind: "out",
        fromColumn: m.column,
        toColumn: 0,
      })
    );
    expect(m.segments.some(s => s.kind === "pass" && s.fromColumn === 0)).toBe(
      false
    );
    // その線は x の行を素通りして、HEAD へ入る
    expect(x.segments).toContainEqual(
      expect.objectContaining({ kind: "pass", fromColumn: 0 })
    );
    expect(h.column).toBe(0);
    expect(h.segments).toContainEqual(
      expect.objectContaining({ kind: "in", fromColumn: 0, toColumn: 0 })
    );
    // 変更があるときと同じ列・色
    const dirty = layoutGraphWithWorking(merged, "h", true);
    expect(rows.map(r => [r.sha, r.column, r.color])).toEqual(
      dirty.rows.map(r => [r.sha, r.column, r.color])
    );
  });

  it("HEAD が読み込み済みに無ければ、線は末尾まで素通りする", () => {
    const { rows } = layoutGraphWithWorking([c("x", "y")], "far", true);
    expect(rows[0].segments.some(s => s.kind === "pass")).toBe(true);
    const clean = layoutGraphWithWorking([c("x", "y")], "far", false);
    expect(clean.rows[0].segments.some(s => s.kind === "pass")).toBe(false);
  });

  it("コミットの無いリポジトリでは丸だけを出す", () => {
    const { working, rows } = layoutGraphWithWorking([], null, true);
    expect(rows).toEqual([]);
    expect(working?.segments).toEqual([]);
    expect(layoutGraphWithWorking([], null, false).working).toBeNull();
  });

  it("HEAD が無ければ layoutGraph と同じ", () => {
    expect(layoutGraphWithWorking(commits, null, false).rows).toEqual(
      layoutGraph(commits)
    );
  });
});
