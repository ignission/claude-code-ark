/**
 * PCサイドバーとモバイル一覧の並べ方 (設計書 7 節)。
 *
 * リポジトリ順ではなく注意の順に並べる。比較キーは
 * セクション → 最終更新の降順 → 状態の優先度 → リポジトリ名 →
 * リポジトリの絶対パス → worktreeのパス (worktreeの無いセッションは後ろ)。
 *
 * セクションの中は「上から見ていけばいい」ように最後に動いた会話を先頭に置く。
 * 3セクションとも同じ規則で並べる。最終更新の不明な行 (未起動・会話がまだ無い)
 * はそのセクションの最後へ回す。
 * 同着で並びが毎秒揺れないよう、従来の比較キーはそのまま tiebreaker に残す。
 */

import type {
  BridgeSessionStatus,
  ManagedSession,
  Worktree,
} from "@ark/shared";
import type { RepoGroup } from "@/hooks/useGroupedWorktreeItems";
import {
  presentStatus,
  resolveStatusKey,
  SECTION_ORDER,
  type SessionSection,
  type StatusKey,
} from "./status-tone";

export interface SessionListEntry {
  key: string;
  worktree: Worktree | null;
  session: ManagedSession | null;
  repoPath: string;
  repoName: string;
  disambiguator: string | null;
  statusKey: StatusKey;
  /**
   * 会話 (JSONL transcript) の最終更新時刻 (epochミリ秒)。不明なら null。
   * tmux の session_activity は端末の再描画でも動くので使わない
   */
  lastUpdatedAt: number | null;
}

export interface SessionSectionGroup {
  section: SessionSection;
  entries: SessionListEntry[];
}

/**
 * 描画用の平らな行。セクション見出しも行として同じ親に並べ、useHeldOrder の対象にする。
 * コンポーネントの SessionListRow (SessionListRow.tsx) と名前が同じなので、両方を使う側は
 * `type SessionListRow as ListRow` のように別名で import する
 */
export type SessionListRow =
  | { kind: "section"; key: string; section: SessionSection; count: number }
  | { kind: "entry"; key: string; entry: SessionListEntry };

export function buildSessionEntries(
  groupedItems: Map<string, RepoGroup>,
  statuses: Map<string, BridgeSessionStatus>,
  /** sessionId → 会話の最終更新時刻 (session:previews 由来)。未起動の行は載らない */
  lastUpdatedAt: ReadonlyMap<string, number> = new Map()
): SessionListEntry[] {
  const entries: SessionListEntry[] = [];
  for (const [repoPath, group] of groupedItems) {
    for (const { worktree, session } of group.items) {
      const key = worktree ? `wt:${worktree.id}` : `s:${session?.id ?? ""}`;
      entries.push({
        key,
        worktree,
        session,
        repoPath,
        repoName: group.repoName,
        disambiguator: group.disambiguator,
        statusKey: resolveStatusKey(
          session !== null,
          session ? statuses.get(session.id) : undefined
        ),
        lastUpdatedAt: (session && lastUpdatedAt.get(session.id)) ?? null,
      });
    }
  }
  return entries;
}

const SECTION_RANK: Readonly<Record<SessionSection, number>> = {
  "your-turn": 0,
  working: 1,
  resting: 2,
};

function itemPath(entry: SessionListEntry): string {
  return entry.worktree?.path ?? entry.session?.worktreePath ?? "";
}

/**
 * 最終更新の降順。不明 (null) は常に後ろ。
 * 同着 (両方不明を含む) は 0 を返し、後続の比較キーに委ねる
 */
function compareLastUpdated(a: SessionListEntry, b: SessionListEntry): number {
  if (a.lastUpdatedAt === b.lastUpdatedAt) return 0;
  if (a.lastUpdatedAt === null) return 1;
  if (b.lastUpdatedAt === null) return -1;
  return b.lastUpdatedAt - a.lastUpdatedAt;
}

function compareEntries(a: SessionListEntry, b: SessionListEntry): number {
  const pa = presentStatus(a.statusKey);
  const pb = presentStatus(b.statusKey);
  return (
    SECTION_RANK[pa.section] - SECTION_RANK[pb.section] ||
    compareLastUpdated(a, b) ||
    pa.priority - pb.priority ||
    a.repoName.localeCompare(b.repoName) ||
    a.repoPath.localeCompare(b.repoPath) ||
    Number(a.worktree === null) - Number(b.worktree === null) ||
    itemPath(a).localeCompare(itemPath(b))
  );
}

export function sortSessionEntries(
  entries: SessionListEntry[]
): SessionListEntry[] {
  return [...entries].sort(compareEntries);
}

export function sectionize(entries: SessionListEntry[]): SessionSectionGroup[] {
  return SECTION_ORDER.map(section => ({
    section,
    entries: entries.filter(
      e => presentStatus(e.statusKey).section === section
    ),
  })).filter(g => g.entries.length > 0);
}

/**
 * 見出しは空のセクションも含めて3つとも出す (件数0)。保留中にセクションが空になったとき
 * 見出しのkeyが消えると、useHeldOrderがそれを落として下の行が繰り上がるため。
 * 空の見出しを描くかどうかは描く側 (SessionSectionList) が決める
 */
export function toListRows(groups: SessionSectionGroup[]): SessionListRow[] {
  const rows: SessionListRow[] = [];
  for (const section of SECTION_ORDER) {
    const entries = groups.find(g => g.section === section)?.entries ?? [];
    rows.push({
      kind: "section",
      key: `section:${section}`,
      section,
      count: entries.length,
    });
    for (const entry of entries) {
      rows.push({ kind: "entry", key: entry.key, entry });
    }
  }
  return rows;
}
