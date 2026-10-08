import type { GitCommit, GitStatus } from "@ark/shared";

/**
 * git-format - Git タブの表示用の純関数 (時刻・ハッシュ・作者の丸・絞り込み)
 */

const pad = (n: number) => String(n).padStart(2, "0");

const formatDate = (d: Date) =>
  `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;

/** その日の 0 時 (ローカル) */
const startOfDay = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 相対時刻。「たった今」「3分前」「5時間前」「昨日」「3日前」、7 日以上前は日付。
 * 24 時間以内は時間で言い、それより前は暦の日数で言う (「昨日」は暦の上の前日)
 */
export function formatRelativeTime(unixSeconds: number, nowMs: number): string {
  const then = unixSeconds * 1000;
  const diff = nowMs - then;
  if (diff < MINUTE) return "たった今";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}分前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}時間前`;
  const days = Math.round(
    (startOfDay(new Date(nowMs)) - startOfDay(new Date(then))) / DAY
  );
  if (days <= 1) return "昨日";
  if (days < 7) return `${days}日前`;
  return formatDate(new Date(then));
}

/** 絶対時刻 (ローカル)。`2026/09/12 14:03` */
export function formatAbsoluteTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const shortSha = (sha: string) => sha.slice(0, 7);

/** 作者の丸に入れる頭文字。英字は 2 語の頭を大文字で、それ以外は先頭の 1 文字 */
export function authorInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = [...words[0]][0] ?? "?";
  // 英数字でなければ (日本語など) 1 文字で足りる
  if (!/^[a-z0-9]$/i.test(first)) return first;
  const second =
    words.length > 1 ? ([...words[words.length - 1]][0] ?? "") : "";
  return (first + (/^[a-z0-9]$/i.test(second) ? second : "")).toUpperCase();
}

/** 作者ごとに決まる色相 (0..359)。メールが無ければ名前から決める */
export function authorHue(email: string, name: string): number {
  const key = (email || name).toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}

/** 未コミットの変更の数 (ステージ済み + 変更 + 未追跡) */
export function countChanges(status: GitStatus | null): number {
  if (!status) return 0;
  return (
    status.staged.length + status.unstaged.length + status.untracked.length
  );
}

/** 件名・作者・ハッシュの部分一致 (大文字小文字を区別しない)。空の query は全件 */
export function filterCommits(
  commits: readonly GitCommit[],
  query: string
): GitCommit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...commits];
  return commits.filter(
    c =>
      c.subject.toLowerCase().includes(q) ||
      c.authorName.toLowerCase().includes(q) ||
      c.authorEmail.toLowerCase().includes(q) ||
      c.sha.toLowerCase().startsWith(q)
  );
}
