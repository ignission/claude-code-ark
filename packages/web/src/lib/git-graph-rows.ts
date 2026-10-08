import { type GraphRow, layoutGraph } from "./git-graph";

/**
 * git-graph-rows - コミット一覧のグラフに「未コミットの変更」の行をつなぐ
 *
 * 未コミットの変更を「HEAD を親に持つ仮のコミット」として先頭に足してから割り当てる。
 * こうすると、HEAD が一覧の先頭に無くても (他のブランチのほうが新しくても)、
 * 仮の行から HEAD まで線が素通りでつながる。
 *
 * 変更が無いときも仮の行を足して割り当て、あとでその線だけを外す。足したり足さなかったり
 * すると、作業ツリーが汚れる / 片付くたびに全レーンの列と色がずれる
 * (Claude が編集とコミットを繰り返すあいだ、グラフがちらつく)
 */

/** 仮の行の sha。git のハッシュ (16 進) と衝突しない */
export const WORKING_SHA = "working";

export interface GraphLayout {
  /** 「未コミットの変更」の行。出さないときは null */
  working: GraphRow | null;
  /** commits と同じ並びの行 */
  rows: GraphRow[];
}

export function layoutGraphWithWorking(
  commits: readonly { sha: string; parents: readonly string[] }[],
  headSha: string | null,
  showWorking: boolean
): GraphLayout {
  if (!headSha) {
    // コミットの無いリポジトリ。つなぐ先が無いので、丸だけを出す
    const rows = layoutGraph(commits);
    const working: GraphRow | null = showWorking
      ? {
          sha: WORKING_SHA,
          column: 0,
          color: 0,
          isMerge: false,
          segments: [],
          columns: 1,
        }
      : null;
    return { working, rows };
  }

  const all = layoutGraph([
    { sha: WORKING_SHA, parents: [headSha] },
    ...commits,
  ]);
  const working = all[0];
  const rows = all.slice(1);
  if (showWorking) return { working, rows };

  // 仮の行の列は HEAD の行まで他のコミットに使われない。その列の素通りと、
  // HEAD へ入る線だけを外す
  const lane = working.column;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const isHead = row.sha === headSha;
    rows[i] = {
      ...row,
      segments: row.segments.filter(s =>
        isHead
          ? !(s.kind === "in" && s.fromColumn === lane)
          : !(s.kind === "pass" && s.fromColumn === lane)
      ),
    };
    if (isHead) break;
  }
  return { working: null, rows };
}
