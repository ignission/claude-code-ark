/**
 * PCサイドバーとモバイル一覧の並べ方。
 *
 * 行はリポジトリごとにまとめ、リポジトリの見出しの下に並べる。状態では並べ替えない
 * (会話が動くたびに行の場所が変わると、押そうとした行が逃げる)。
 *
 * - 行はworktreeごとに1つで、どの行も同じ高さに並べる。mainのworktreeは行にしない
 *   (useGroupedWorktreeItems)。task_start / task:start で起こした子も、親子で寄せたり字下げしたりしない。
 *   親の記録 (session.parentWorktreePath) はサーバーの task_list と、TODOを完了にしたときの後片付けが使う
 * - 登録したリポジトリは、行が1つも無くても見出しを出す。新しいタスクやホームにする操作は見出しのメニューにある
 * - リポジトリの順は、人がドラッグで決めた順 (設定 `sessionListRepoOrder`、サーバーに保存して
 *   PCとモバイルで共有) を先に置き、そこに無いリポジトリはリポジトリ名 → 絶対パスの順で後ろへ足す。
 *   保存値には、いま一覧に見えていないリポジトリのパスも残す (worktreeが届く前のリロード直後や、
 *   一時的に除外したリポジトリの位置を失わないため)。書き込むのは人が並べ替えたときだけ
 * - リポジトリの中は、worktreeのある行をworktreeのパス順に、worktreeの無いセッションを後ろに置く
 *   (useGroupedWorktreeItems が積んだ順のまま)
 * - 人が手動で休止にした行 (session.restedAt がある行) は、状態に関係なく状態の札を「休止」にする。
 *   位置は動かさない。いつ外すかはサーバーが決める (server の session-rest.ts)
 */

import type {
  BridgeSessionStatus,
  ManagedSession,
  Worktree,
} from "@ark/shared";
import type { RepoGroup } from "@/hooks/useGroupedWorktreeItems";
import { presentStatus, resolveStatusKey, type StatusKey } from "./status-tone";

/** リポジトリの並び順を保存する設定のキー。値は repoPath の配列 */
export const REPO_ORDER_SETTING = "sessionListRepoOrder";

export interface SessionListEntry {
  key: string;
  worktree: Worktree | null;
  session: ManagedSession | null;
  repoPath: string;
  repoName: string;
  disambiguator: string | null;
  /** 状態の札に出す状態。手動で休止にした行は RESTED */
  statusKey: StatusKey;
  /** 手動で休止にした行か (行メニューの「休止にする / 休止から戻す」の出し分けに使う) */
  manuallyRested: boolean;
  /** あなたの番 (確認待ち・問題・入力待ち) で、手動で休止にしていない行か */
  yourTurn: boolean;
}

export interface SessionRepoSection {
  repoPath: string;
  repoName: string;
  disambiguator: string | null;
  /** mainのworktreeのパス (見出しの「ホームにする」)。worktreeが届く前はnull */
  mainWorktreePath: string | null;
  entries: SessionListEntry[];
}

export function buildSessionEntries(
  groupedItems: Map<string, RepoGroup>,
  statuses: Map<string, BridgeSessionStatus>
): SessionListEntry[] {
  const entries: SessionListEntry[] = [];
  for (const [repoPath, group] of groupedItems) {
    for (const { worktree, session } of group.items) {
      const key = worktree ? `wt:${worktree.id}` : `s:${session?.id ?? ""}`;
      const liveStatusKey = resolveStatusKey(
        session !== null,
        session ? statuses.get(session.id) : undefined
      );
      const manuallyRested = session?.restedAt != null;
      entries.push({
        key,
        worktree,
        session,
        repoPath,
        repoName: group.repoName,
        disambiguator: group.disambiguator,
        statusKey: manuallyRested ? "RESTED" : liveStatusKey,
        manuallyRested,
        yourTurn: !manuallyRested && presentStatus(liveStatusKey).yourTurn,
      });
    }
  }
  return entries;
}

/** 設定から読んだ値を repoPath の配列に揃える (壊れた値は空、重複は先の方を残す) */
export function normalizeRepoOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item === "string" && item !== "") seen.add(item);
  }
  return [...seen];
}

/**
 * 見えているリポジトリ (既定の順に並べたもの) を、保存した順で並べ直す。
 * 保存順に無いものは既定の順のまま後ろに足す
 */
export function orderRepoPaths(
  repoPaths: readonly string[],
  savedOrder: readonly string[]
): string[] {
  const present = new Set(repoPaths);
  const ordered = savedOrder.filter(path => present.has(path));
  const placed = new Set(ordered);
  for (const path of repoPaths) {
    if (!placed.has(path)) ordered.push(path);
  }
  return ordered;
}

/**
 * 見えている順 (visibleOrder) の from を toIndex へ動かした結果を、保存する値にして返す。
 * toIndex は from を抜いた列での挿入位置。いま見えていない保存済みのパスは後ろに残す
 */
export function moveRepo(
  visibleOrder: readonly string[],
  savedOrder: readonly string[],
  from: string,
  toIndex: number
): string[] {
  const rest = visibleOrder.filter(path => path !== from);
  const index = Math.max(0, Math.min(toIndex, rest.length));
  const moved = [...rest.slice(0, index), from, ...rest.slice(index)];
  const visible = new Set(moved);
  return [...moved, ...savedOrder.filter(path => !visible.has(path))];
}

/**
 * ドラッグ中のポインタの縦位置から、つまんだリポジトリを入れる位置を求める。
 * otherMidpoints は、つまんだもの以外のかたまりの縦の中心 (上から順)。
 * 戻り値は moveRepo の toIndex (つまんだものを抜いた列での挿入位置)
 */
export function resolveDropIndex(
  pointerY: number,
  otherMidpoints: readonly number[]
): number {
  return otherMidpoints.filter(mid => mid < pointerY).length;
}

/**
 * 行をリポジトリのかたまりにまとめ、保存した順に並べる。登録したリポジトリ (repoList) は
 * 行が無くてもかたまりを作る。登録していないリポジトリは、行があるときだけ出す。
 * entries は buildSessionEntries の順 (リポジトリ名 → パス、中はworktreeのパス順) のまま渡す
 */
export function groupByRepo(
  groupedItems: Map<string, RepoGroup>,
  entries: readonly SessionListEntry[],
  repoList: readonly string[],
  savedOrder: readonly string[]
): SessionRepoSection[] {
  const byRepo = new Map<string, SessionRepoSection>();
  for (const [repoPath, group] of groupedItems) {
    byRepo.set(repoPath, {
      repoPath,
      repoName: group.repoName,
      disambiguator: group.disambiguator,
      mainWorktreePath: group.mainWorktreePath,
      entries: [],
    });
  }
  for (const entry of entries) {
    byRepo.get(entry.repoPath)?.entries.push(entry);
  }
  const listed = new Set(repoList);
  for (const [repoPath, section] of byRepo) {
    if (section.entries.length === 0 && !listed.has(repoPath)) {
      byRepo.delete(repoPath);
    }
  }
  return orderRepoPaths([...byRepo.keys()], savedOrder).map(
    path => byRepo.get(path) as SessionRepoSection
  );
}
