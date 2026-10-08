import { memo } from "react";
import { GRAPH_COLOR_COUNT, type GraphRow } from "@/lib/git-graph";

/** 一覧の 1 行の高さ。線は 0 からこの高さまで描き、上下の行と継ぎ目なくつなぐ */
export const GRAPH_ROW_HEIGHT = 28;
const LANE_WIDTH = 14;
const PADDING_X = 6;
/** これより多い列は切り落として右端をぼかす (件名を画面の外へ押し出さない) */
export const GRAPH_MAX_COLUMNS = 12;

/** レーンの色。index.css の --git-lane-0..7 (明暗で値が変わる) */
export const laneColor = (index: number) =>
  `var(--git-lane-${((index % GRAPH_COLOR_COUNT) + GRAPH_COLOR_COUNT) % GRAPH_COLOR_COUNT})`;

const laneX = (column: number) =>
  PADDING_X + column * LANE_WIDTH + LANE_WIDTH / 2;

/** その行のグラフの幅 (px)。列が多すぎるときは GRAPH_MAX_COLUMNS で止める */
export const graphWidth = (columns: number) =>
  Math.min(Math.max(columns, 1), GRAPH_MAX_COLUMNS) * LANE_WIDTH +
  PADDING_X * 2;

const MID = GRAPH_ROW_HEIGHT / 2;

/**
 * (x1, y1) から (x2, y2) へ。同じ列なら直線、列が違えば S 字の 3 次ベジェ
 * (両端で垂直になるので、上下の行の縦線となめらかにつながる)
 */
function linkPath(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M ${x1} ${y1} V ${y2}`;
  const c = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${c}, ${x2} ${c}, ${x2} ${y2}`;
}

interface GitGraphCellProps {
  row: GraphRow;
  /** HEAD のコミット。外側に輪を足す */
  isHead?: boolean;
  /** 「未コミットの変更」の行。点線の輪にする */
  isWorking?: boolean;
}

/**
 * 1 行ぶんのグラフ。行ごとに独立した SVG で、線を上端 (0) と下端 (行の高さ) まで
 * 描くことで隣の行とつなぐ
 */
export const GitGraphCell = memo(function GitGraphCell({
  row,
  isHead = false,
  isWorking = false,
}: GitGraphCellProps) {
  const width = graphWidth(row.columns);
  const clipped = row.columns > GRAPH_MAX_COLUMNS;
  const cx = laneX(row.column);
  const color = laneColor(row.color);

  return (
    <span
      className="relative block shrink-0 overflow-hidden"
      style={{ width, height: GRAPH_ROW_HEIGHT }}
    >
      <svg
        aria-hidden="true"
        width={width}
        height={GRAPH_ROW_HEIGHT}
        className="block"
        fill="none"
        strokeWidth={2}
        strokeLinecap="round"
      >
        {row.segments.map((s, i) => {
          const d =
            s.kind === "pass"
              ? linkPath(
                  laneX(s.fromColumn),
                  0,
                  laneX(s.toColumn),
                  GRAPH_ROW_HEIGHT
                )
              : s.kind === "in"
                ? linkPath(laneX(s.fromColumn), 0, laneX(s.toColumn), MID)
                : linkPath(
                    laneX(s.fromColumn),
                    MID,
                    laneX(s.toColumn),
                    GRAPH_ROW_HEIGHT
                  );
          return (
            <path
              // 同じ行の線分は並びが変わらない
              // biome-ignore lint/suspicious/noArrayIndexKey: 線分に固有の id は無い
              key={i}
              data-kind={s.kind}
              d={d}
              stroke={laneColor(s.color)}
            />
          );
        })}
        {isHead && (
          <circle
            data-node="head-ring"
            cx={cx}
            cy={MID}
            r={6.5}
            stroke={color}
            strokeWidth={1.5}
            fill="var(--background)"
          />
        )}
        {isWorking ? (
          <circle
            data-node="working"
            cx={cx}
            cy={MID}
            r={4}
            stroke={color}
            strokeDasharray="2.5 2"
            strokeLinecap="butt"
            fill="var(--background)"
          />
        ) : row.isMerge ? (
          <circle
            data-node="merge"
            cx={cx}
            cy={MID}
            r={4}
            stroke={color}
            fill="var(--background)"
          />
        ) : (
          <circle data-node="commit" cx={cx} cy={MID} r={4} fill={color} />
        )}
      </svg>
      {clipped && (
        <span
          data-testid="git-graph-fade"
          className="pointer-events-none absolute inset-y-0 right-0 w-5 bg-gradient-to-r from-transparent to-background"
        />
      )}
    </span>
  );
});
