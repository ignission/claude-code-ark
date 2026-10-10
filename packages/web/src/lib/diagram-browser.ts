/**
 * diagram-browser - 図の一覧 (DiagramSwitcher) の絞り込み・並べ替え・表示の言葉
 *
 * 一覧は Finder のリスト表示に寄せる: 名前・種類・更新日時の列を持ち、既定は更新の
 * 新しい順。列の見出しで並べ替え、上の欄で名前とパスを絞り込む。
 */

import type { DiagramKind, DiagramListItem } from "@ark/shared";
import { DIAGRAM_DIR } from "@ark/shared";

export const DIAGRAM_KIND_LABEL: Readonly<Record<DiagramKind, string>> = {
  deck: "デッキ",
  doc: "文書",
  sequence: "シーケンス",
  "call-tree": "呼び出し",
  graph: "図",
};

/** 種類で並べるときの順 (文字の並びではなく、決まった順にする) */
const KIND_ORDER: readonly DiagramKind[] = [
  "deck",
  "doc",
  "sequence",
  "call-tree",
  "graph",
];

export type DiagramSortKey = "name" | "kind" | "mtime";

export interface DiagramSort {
  key: DiagramSortKey;
  dir: "asc" | "desc";
}

/** 既定は更新の新しい順 (いま描いた図が先頭に来る) */
export const DEFAULT_DIAGRAM_SORT: DiagramSort = { key: "mtime", dir: "desc" };

const STORAGE_KEY = "ark-diagram-browser-sort";

/**
 * 見出しを押したときの次の並び。同じ列なら向きを返し、別の列ならその列の自然な向き
 * (更新は新しい順、名前と種類は昇順) にする。
 */
export function toggleDiagramSort(
  current: DiagramSort,
  key: DiagramSortKey
): DiagramSort {
  if (current.key === key) {
    return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  }
  return { key, dir: key === "mtime" ? "desc" : "asc" };
}

export function diagramKind(item: DiagramListItem): DiagramKind {
  return item.kind ?? "graph";
}

/** `.claude/diagrams/` を除いたパス (名前の下に薄く出す) */
export function diagramShortPath(relPath: string): string {
  const prefix = `${DIAGRAM_DIR}/`;
  return relPath.startsWith(prefix) ? relPath.slice(prefix.length) : relPath;
}

function compare(a: DiagramListItem, b: DiagramListItem, key: DiagramSortKey) {
  if (key === "mtime") {
    // 更新日時が読めなかった図は、どちらの向きでも古いものとして扱う
    return (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0);
  }
  if (key === "kind") {
    return (
      KIND_ORDER.indexOf(diagramKind(a)) - KIND_ORDER.indexOf(diagramKind(b))
    );
  }
  return a.displayName.localeCompare(b.displayName, "ja");
}

/** 絞り込んで並べる。問い合わせは空白で区切った語をすべて含むものを残す (大文字小文字は見ない) */
export function browseDiagrams(
  items: readonly DiagramListItem[],
  query: string,
  sort: DiagramSort
): DiagramListItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matched = items.filter(item => {
    const text = `${item.displayName} ${item.relPath}`.toLowerCase();
    return words.every(word => text.includes(word));
  });
  const sign = sort.dir === "asc" ? 1 : -1;
  return matched.sort(
    (a, b) =>
      sign * compare(a, b, sort.key) ||
      // 同じなら名前、それも同じならパスで、並びを決める
      a.displayName.localeCompare(b.displayName, "ja") ||
      a.relPath.localeCompare(b.relPath)
  );
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 更新日時を Finder 風に出す (今日は時刻、昨日は「昨日」、今年は月日、それより前は年月日) */
export function formatDiagramTime(
  mtimeMs: number | undefined,
  now: Date
): string {
  if (mtimeMs === undefined) return "—";
  const at = new Date(mtimeMs);
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  ).getTime();
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (mtimeMs >= startOfToday) return `今日 ${time}`;
  if (mtimeMs >= startOfToday - 24 * 60 * 60 * 1000) return `昨日 ${time}`;
  const day = `${at.getMonth() + 1}/${at.getDate()}`;
  return at.getFullYear() === now.getFullYear()
    ? day
    : `${at.getFullYear()}/${day}`;
}

export function loadDiagramSort(): DiagramSort {
  try {
    const value = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "null"
    ) as Partial<DiagramSort> | null;
    if (
      value &&
      (value.key === "name" || value.key === "kind" || value.key === "mtime") &&
      (value.dir === "asc" || value.dir === "desc")
    ) {
      return { key: value.key, dir: value.dir };
    }
  } catch {
    // 読めなければ既定の並びにする
  }
  return DEFAULT_DIAGRAM_SORT;
}

export function saveDiagramSort(sort: DiagramSort): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sort));
  } catch {
    // 保存できなくても、並びはこの画面の間は保つ
  }
}
