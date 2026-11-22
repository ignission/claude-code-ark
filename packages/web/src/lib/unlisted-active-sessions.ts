/**
 * 登録していないリポジトリのセッションを、動いている間と動いた直後だけ一覧に出すための判定。
 *
 * 一覧は、画面に登録したリポジトリ (repoList) のセッションだけを出す。登録を絞っていると、
 * 別のセッションからの伝言などで動き出した既存のセッションが、どこにも出ない。
 * そこで、いま動いているか確認待ちのセッションと、会話が直近に動いたセッションは、
 * リポジトリが未登録でも出す (useGroupedWorktreeItems)。
 *
 * 状態だけでは決めない。ターンを終えたセッションは IDLE (あなたの番) のまま残るので、
 * IDLE を条件にすると、登録から外した古いセッションが全部戻ってくる。会話の最終更新からの
 * 時間で区切り、触らなければ一覧から消えるようにする。
 *
 * リポジトリを repoList に足すことはしない (同じリポジトリの動いていないセッションと
 * worktree まで出てくる)。
 */

import type { BridgeSessionStatus } from "@ark/shared";

/** 会話が最後に動いてから、未登録のリポジトリのセッションを一覧に残す時間 */
export const UNLISTED_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

const ACTIVE_STATUSES: ReadonlySet<BridgeSessionStatus> = new Set([
  "TOOL",
  "THINK",
  "AWAITING",
]);

export function isActiveSession(
  status: BridgeSessionStatus | undefined,
  lastUpdatedAt: number | null | undefined,
  now: number
): boolean {
  if (status && ACTIVE_STATUSES.has(status)) return true;
  if (lastUpdatedAt == null) return false;
  return now - lastUpdatedAt < UNLISTED_ACTIVE_WINDOW_MS;
}

/** いま動いているか、直近に動いたセッションの id */
export function collectActiveSessionIds(
  sessionIds: Iterable<string>,
  statuses: ReadonlyMap<string, BridgeSessionStatus>,
  lastUpdatedAt: ReadonlyMap<string, number>,
  now: number
): string[] {
  const active: string[] = [];
  for (const id of sessionIds) {
    if (isActiveSession(statuses.get(id), lastUpdatedAt.get(id), now)) {
      active.push(id);
    }
  }
  return active.sort();
}
