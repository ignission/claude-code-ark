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
