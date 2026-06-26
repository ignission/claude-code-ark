/**
 * worktreesByRepo - repoPath ごとに worktree リストを保持するイミュータブルな状態ヘルパー
 *
 * 背景: サイドバーは複数リポジトリを repoList でグルーピングして表示するが、
 * 旧実装は `worktrees: Worktree[]` を単一 state で保持し、worktree:list 受信のたびに
 * 丸ごと上書きしていた。このため worktree を取得できるのは「現在選択中の1リポジトリ」
 * だけで、リロード時に選択中以外のリポジトリの worktree がサイドバーから丸ごと消えていた。
 *
 * 本ヘルパーは worktree を repoPath ごとの bucket に分けて保持することで、複数リポジトリの
 * worktree を同時に保持できるようにする。useSocket から純粋ロジックを切り出してテスト可能にする。
 *
 * 前提: repoPath / worktree.id の非空・正当性は呼び出し側（useSocket の socket ハンドラ）で
 * allowlist 検証済みであること。本ヘルパーは検証済み入力を受け取る純粋な state 変換に徹する。
 */

import type { Worktree } from "@ark/shared";

// React state として扱うため、helper は常に新しい Map を返す（参照が変わるので再描画される）。
// 深い不変性まで型で強制するため ReadonlyMap + readonly 配列で公開し、
// 呼び出し側が state.get(repo)?.push(...) のような直接変異をできないようにする。
export type WorktreesByRepo = ReadonlyMap<string, readonly Worktree[]>;

/** repo の worktree リストを丸ごと差し替える（worktree:list 受信時） */
export function setRepoWorktrees(
  prev: WorktreesByRepo,
  repoPath: string,
  worktrees: Worktree[]
): WorktreesByRepo {
  const next = new Map(prev);
  // 受け取った配列・要素をそのまま保持すると、呼び出し元や payload 側の後続 mutation
  // （worktrees.push(...) や worktrees[0].branch = ... 等）が setter を通さず state に
  // 波及する。配列と各要素を浅くコピーして helper の immutable 契約を守る。
  next.set(
    repoPath,
    worktrees.map(w => ({ ...w }))
  );
  return next;
}

/** repo に worktree を1件追加（worktree:created）。重複 id は無視する */
export function addWorktree(
  prev: WorktreesByRepo,
  repoPath: string,
  worktree: Worktree
): WorktreesByRepo {
  const cur = prev.get(repoPath) ?? [];
  if (cur.some(w => w.id === worktree.id)) return prev;
  const next = new Map(prev);
  // 追加要素も浅くコピーして、呼び出し元の後続 mutation が state に波及しないようにする。
  next.set(repoPath, [...cur, { ...worktree }]);
  return next;
}

/** worktree を1件削除（worktree:deleted）。変化が無ければ同一参照を返す */
export function removeWorktree(
  prev: WorktreesByRepo,
  repoPath: string,
  worktreeId: string
): WorktreesByRepo {
  const cur = prev.get(repoPath);
  if (!cur) return prev;
  const filtered = cur.filter(w => w.id !== worktreeId);
  if (filtered.length === cur.length) return prev;
  const next = new Map(prev);
  next.set(repoPath, filtered);
  return next;
}

/** repo の bucket ごと破棄する（removeRepo / repo:error）。変化が無ければ同一参照を返す */
export function clearRepo(
  prev: WorktreesByRepo,
  repoPath: string
): WorktreesByRepo {
  if (!prev.has(repoPath)) return prev;
  const next = new Map(prev);
  next.delete(repoPath);
  return next;
}

/**
 * repoList に含まれない repo の bucket を掃除する（メモリ衛生）。
 * 変化が無ければ同一参照を返す。
 */
export function pruneToRepos(
  prev: WorktreesByRepo,
  repos: string[]
): WorktreesByRepo {
  const allowed = new Set(repos);
  let changed = false;
  for (const repoPath of prev.keys()) {
    if (!allowed.has(repoPath)) {
      changed = true;
      break;
    }
  }
  if (!changed) return prev;
  const next = new Map<string, readonly Worktree[]>();
  for (const [repoPath, worktrees] of prev) {
    if (allowed.has(repoPath)) next.set(repoPath, worktrees);
  }
  return next;
}

/**
 * 全 repo の worktree を1配列に平坦化する（消費側へ公開する配列）。
 *
 * repoOrder を渡すと、その順で flatten する。Map の挿入順は worktree:list 応答の
 * 到着順に左右されるため、repoList 順を渡すことで公開配列の順序を安定させる
 * （リロードごとにサイドバーの並びが揺れるのを防ぐ）。repoOrder に無い bucket は
 * 取りこぼし防止のため挿入順で末尾に付ける。
 */
export function flattenWorktrees(
  byRepo: WorktreesByRepo,
  repoOrder?: string[]
): Worktree[] {
  if (!repoOrder) return Array.from(byRepo.values()).flat();
  const result: Worktree[] = [];
  const seen = new Set<string>();
  for (const repoPath of repoOrder) {
    const wts = byRepo.get(repoPath);
    if (wts) {
      result.push(...wts);
      seen.add(repoPath);
    }
  }
  for (const [repoPath, wts] of byRepo) {
    if (!seen.has(repoPath)) result.push(...wts);
  }
  return result;
}
