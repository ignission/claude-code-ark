/** 列の色の数。描画側はこの数だけパレットを持つ */
export const GRAPH_COLOR_COUNT = 8;

export interface GraphSegment {
  /** "in": 上端の fromColumn からこの行の丸へ / "out": 丸から下端の toColumn へ / "pass": 上端から下端へ素通り */
  kind: "in" | "out" | "pass";
  fromColumn: number;
  toColumn: number;
  /** 0..GRAPH_COLOR_COUNT-1 */
  color: number;
}

export interface GraphRow {
  sha: string;
  /** この行のコミットの列 (0 始まり) */
  column: number;
  color: number;
  isMerge: boolean;
  segments: GraphSegment[];
  /** この行で使っている列数 (描画幅の計算用。最大の列 + 1) */
  columns: number;
}

/** 「この列は sha のコミットを待っている」 */
interface Lane {
  sha: string;
  color: number;
}

/**
 * コミット (新しい順) から、行ごとの列と線分を割り当てる。
 * 計算量は O(コミット数 × 同時に開いている列数)。履歴が途中で切れていても
 * (親が現れなくても) その列を開いたままにするだけで、例外は出さない。
 */
export function layoutGraph(
  commits: readonly { sha: string; parents: readonly string[] }[]
): GraphRow[] {
  const lanes: (Lane | null)[] = [];
  let colorCounter = 0;
  const nextColor = () => colorCounter++ % GRAPH_COLOR_COUNT;

  /** 最も左の空き列。無ければ新しい列 (lanes.length) */
  const firstFree = () => {
    const i = lanes.indexOf(null);
    return i === -1 ? lanes.length : i;
  };
  /** sha を待っている列。無ければ -1 */
  const findLane = (sha: string) => lanes.findIndex(l => l?.sha === sha);

  return commits.map(({ sha, parents }) => {
    const segments: GraphSegment[] = [];

    const waiting: number[] = [];
    lanes.forEach((lane, i) => {
      if (lane?.sha === sha) waiting.push(i);
    });

    let column: number;
    let color: number;
    if (waiting.length > 0) {
      column = waiting[0];
      color = (lanes[column] as Lane).color;
      for (const i of waiting) {
        segments.push({
          kind: "in",
          fromColumn: i,
          toColumn: column,
          color: (lanes[i] as Lane).color,
        });
        lanes[i] = null;
      }
    } else {
      column = firstFree();
      color = nextColor();
    }

    lanes.forEach((lane, i) => {
      if (lane) {
        segments.push({
          kind: "pass",
          fromColumn: i,
          toColumn: i,
          color: lane.color,
        });
      }
    });

    // 同じ親が重なっても線を二重に引かない
    const uniqueParents = [...new Set(parents)];
    uniqueParents.forEach((parent, index) => {
      if (index === 0) {
        // 第 1 親は必ず自分の列で受ける。別の列が同じ親を待っていても寄らない
        // (寄ると本線が枝の列へ飛ぶ)。同じ親を待つ列は、親の行で in として合流する
        lanes[column] = { sha: parent, color };
        segments.push({
          kind: "out",
          fromColumn: column,
          toColumn: column,
          color,
        });
        return;
      }
      const existing = findLane(parent);
      if (existing !== -1) {
        // 第 2 親以降は、すでに待っている列があればそこへ合流する
        segments.push({
          kind: "out",
          fromColumn: column,
          toColumn: existing,
          color: (lanes[existing] as Lane).color,
        });
        return;
      }
      const slot = firstFree();
      const laneColor = nextColor();
      lanes[slot] = { sha: parent, color: laneColor };
      segments.push({
        kind: "out",
        fromColumn: column,
        toColumn: slot,
        color: laneColor,
      });
    });

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    let maxColumn = column;
    for (const s of segments) {
      maxColumn = Math.max(maxColumn, s.fromColumn, s.toColumn);
    }
    return {
      sha,
      column,
      color,
      isMerge: parents.length > 1,
      segments,
      columns: maxColumn + 1,
    };
  });
}
