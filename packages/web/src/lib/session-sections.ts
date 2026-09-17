/**
 * PCサイドバーとモバイル一覧の並べ方 (設計書 7 節)。
 *
 * リポジトリ順ではなく注意の順に並べる。比較キーは
 * セクション → 状態の優先度 → リポジトリ名 → リポジトリの絶対パス → worktreeのパス
 * (worktreeの無いセッションは後ろ)。
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
  statuses: Map<string, BridgeSessionStatus>
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

function compareEntries(a: SessionListEntry, b: SessionListEntry): number {
  const pa = presentStatus(a.statusKey);
  const pb = presentStatus(b.statusKey);
  return (
    SECTION_RANK[pa.section] - SECTION_RANK[pb.section] ||
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

export function toListRows(groups: SessionSectionGroup[]): SessionListRow[] {
  const rows: SessionListRow[] = [];
  for (const g of groups) {
    rows.push({
      kind: "section",
      key: `section:${g.section}`,
      section: g.section,
      count: g.entries.length,
    });
    for (const entry of g.entries) {
      rows.push({ kind: "entry", key: entry.key, entry });
    }
  }
  return rows;
}
