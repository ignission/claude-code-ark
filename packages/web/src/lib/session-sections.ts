/**
 * PCサイドバーとモバイル一覧の並べ方。
 *
 * 行はリポジトリごとにまとめ、リポジトリの見出しの下に並べる。状態では並べ替えない
 * (会話が動くたびに行の場所が変わると、押そうとした行が逃げる)。
 *
 * - リポジトリの順は、人がドラッグで決めた順 (設定 `sessionListRepoOrder`、サーバーに保存して
 *   PCとモバイルで共有) を先に置き、そこに無いリポジトリはリポジトリ名 → 絶対パスの順で後ろへ足す。
 *   保存値には、いま一覧に見えていないリポジトリのパスも残す (worktreeが届く前のリロード直後や、
 *   一時的に除外したリポジトリの位置を失わないため)。書き込むのは人が並べ替えたときだけ
 * - リポジトリの中は、worktreeのある行をworktreeのパス順に、worktreeの無いセッションを後ろに置く
 *   (useGroupedWorktreeItems が積んだ順のまま)
 * - task_start / task:start で起こした子 (セッションに parentWorktreePath がある行) は、
 *   親と同じリポジトリにいるときだけ親の直後に寄せる (nestChildEntries)。別のリポジトリへ
 *   切り出した子はそのリポジトリに残り、行の「↳ 親」で親をたどる
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
  /** 子の行なら親の worktree のパス。親の行や普通の行は null */
  parentWorktreePath: string | null;
  /** 親の直後に寄せた子の行 (字下げして出す) */
  nested: boolean;
}

export interface SessionRepoSection {
  repoPath: string;
  repoName: string;
  disambiguator: string | null;
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
        parentWorktreePath: session?.parentWorktreePath ?? null,
        nested: false,
      });
    }
  }
  return entries;
}

function itemPath(entry: SessionListEntry): string {
  return entry.worktree?.path ?? entry.session?.worktreePath ?? "";
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
 * 行をリポジトリのかたまりにまとめ、保存した順に並べる。行の無いリポジトリは出さない。
 * entries は useGroupedWorktreeItems の順 (リポジトリ名 → パス、中はworktreeのパス順) のまま渡す
 */
export function groupByRepo(
  entries: readonly SessionListEntry[],
  savedOrder: readonly string[]
): SessionRepoSection[] {
  const byRepo = new Map<string, SessionRepoSection>();
  for (const entry of entries) {
    let section = byRepo.get(entry.repoPath);
    if (!section) {
      section = {
        repoPath: entry.repoPath,
        repoName: entry.repoName,
        disambiguator: entry.disambiguator,
        entries: [],
      };
      byRepo.set(entry.repoPath, section);
    }
    section.entries.push(entry);
  }
  return orderRepoPaths([...byRepo.keys()], savedOrder).map(path => {
    const section = byRepo.get(path) as SessionRepoSection;
    return { ...section, entries: nestChildEntries(section.entries) };
  });
}

/**
 * 1つのリポジトリの (並べ替え済みの) 行で、親が同じリポジトリにいる子を親の直後へ寄せる。
 * 子どうしの順は元の並びのまま。孫も同じ規則でたどる (親子が輪になっていても止まる)
 */
export function nestChildEntries(
  entries: SessionListEntry[]
): SessionListEntry[] {
  const pathOf = new Map<string, SessionListEntry>();
  for (const entry of entries) {
    const path = itemPath(entry);
    if (path) pathOf.set(path, entry);
  }
  const childrenOf = new Map<string, SessionListEntry[]>();
  const roots: SessionListEntry[] = [];
  for (const entry of entries) {
    const parent = entry.parentWorktreePath;
    if (parent && parent !== itemPath(entry) && pathOf.has(parent)) {
      const list = childrenOf.get(parent) ?? [];
      list.push(entry);
      childrenOf.set(parent, list);
    } else {
      roots.push(entry);
    }
  }
  const result: SessionListEntry[] = [];
  const placed = new Set<SessionListEntry>();
  const place = (entry: SessionListEntry, nested: boolean) => {
    if (placed.has(entry)) return;
    placed.add(entry);
    result.push(entry.nested === nested ? entry : { ...entry, nested });
    for (const child of childrenOf.get(itemPath(entry)) ?? []) {
      place(child, true);
    }
  };
  for (const root of roots) place(root, false);
  // 親子が輪になっていて根にたどり着けない行も落とさない
  for (const entry of entries) place(entry, false);
  return result;
}

/** worktree のパス → そのパスを親に持つ行の数 (リポジトリをまたいで数える) */
export function countChildren(
  entries: readonly SessionListEntry[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const parent = entry.parentWorktreePath;
    if (!parent) continue;
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  return counts;
}
