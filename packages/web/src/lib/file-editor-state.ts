/**
 * ファイルエディタの再読込と競合の判断。副作用を持たない純関数だけを置く。
 */

export type DiskEvent = "reload-silently" | "show-conflict" | "ignore";

/** この差までは同じ mtime とみなす (経路で小数が丸められても反響と分かるように) */
const SAME_MTIME_TOLERANCE_MS = 1;

/** file:updated を受けて open し直した結果を、手元の状態と突き合わせる */
export function decideOnDiskChange(input: {
  loadedMtimeMs: number;
  diskMtimeMs: number;
  dirty: boolean;
}): DiskEvent {
  const { loadedMtimeMs, diskMtimeMs, dirty } = input;
  // 自分の保存の反響。サーバーは抑止しないので、ここで捨てる
  if (Math.abs(diskMtimeMs - loadedMtimeMs) <= SAME_MTIME_TOLERANCE_MS) {
    return "ignore";
  }
  return dirty ? "show-conflict" : "reload-silently";
}

/**
 * 読み取った内容の改行。エディタは LF で持つので、保存のときにこれへ戻す。
 * 混在しているファイルは最初の改行で決める
 */
export function detectLineEnding(content: string): "\n" | "\r\n" {
  const index = content.indexOf("\n");
  return index > 0 && content[index - 1] === "\r" ? "\r\n" : "\n";
}
