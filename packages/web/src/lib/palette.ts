/**
 * palette - コマンドパレット (`:`) の候補と絞り込み
 *
 * 候補は「セッション・図・ファイル・コマンド」と、打った文を Claude へ送る「聞く」の行。
 * ここは候補の形と並べ方だけを持ち、実行は CommandPalette が行う。
 *
 * 絞り込みは空白で区切った語をすべて含むものを残す。語は連続して含まれるものを高く、
 * 飛び飛び (部分列) を低く採点する。語の頭 (`/` `-` `_` `.` 空白の直後) と、パスの
 * 最後の名前の中で一致したものを上げる。
 */

import type { KeyNavCommand, KeyNavRegion } from "./keynav";

/** パレットを開く合図 (KeyNavLayer が投げ、CommandPalette が受ける) */
export const PALETTE_OPEN_EVENT = "ark:palette-open";
/** パレットが閉じた合図 (CommandPalette が投げ、KeyNavLayer が受ける) */
export const PALETTE_CLOSED_EVENT = "ark:palette-closed";

export interface PaletteClosedDetail {
  /** 閉じたあとに KeyNavLayer が実行する指示 (場所やタブを替える操作) */
  command?: KeyNavCommand;
  /** 閉じたあとにいる場所 (開いたものが作業エリアにある、など) */
  region?: KeyNavRegion;
  /** 別のダイアログを開いた。フォーカスはそちらが持つので、置き直さない */
  handoff?: boolean;
}

export type PaletteAction =
  | { type: "session"; sessionId: string }
  | { type: "diagram"; relPath: string }
  | { type: "file"; path: string }
  | { type: "keynav"; command: KeyNavCommand }
  | { type: "board-suggest-settings" }
  | { type: "ask"; text: string };

export type PaletteKind = "session" | "diagram" | "file" | "command" | "ask";

export interface PaletteItem {
  /** 一覧の中で一意 */
  id: string;
  kind: PaletteKind;
  title: string;
  /** 題の横に薄く出す補足 (リポジトリ名・状態・フォルダ) */
  detail?: string;
  /** 題のほかに絞り込みの対象にする文字列 */
  keywords?: string;
  action: PaletteAction;
}

export const PALETTE_KIND_LABEL: Readonly<Record<PaletteKind, string>> = {
  session: "セッション",
  diagram: "図",
  file: "ファイル",
  command: "コマンド",
  ask: "Claude",
};

/** パレットを閉じたあと、ノーマルモードのいる場所をどこにするか */
export function regionAfter(action: PaletteAction): KeyNavRegion | undefined {
  if (action.type === "diagram" || action.type === "file") return "work";
  if (action.type === "ask") return "left";
  return undefined;
}

/** 名前で実行できる操作。取り消せない操作 (停止・削除・再起動) は載せない */
export const PALETTE_COMMANDS: readonly PaletteItem[] = [
  command("toggle-left", "端末と会話を切り替える", "terminal chat t", {
    type: "keynav",
    command: { type: "toggle-left-mode" },
  }),
  command("toggle-work", "作業エリアを開閉する", "panel パネル p", {
    type: "keynav",
    command: { type: "toggle-work-area" },
  }),
  command("tab-board", "図のタブを開く", "board diagram ボード gd", {
    type: "keynav",
    command: { type: "work-tab", tab: "board" },
  }),
  command("tab-files", "ファイルのタブを開く", "files tree ツリー gf", {
    type: "keynav",
    command: { type: "work-tab", tab: "files" },
  }),
  command("tab-git", "Git のタブを開く", "git commit コミット 差分 gs", {
    type: "keynav",
    command: { type: "work-tab", tab: "git" },
  }),
  command("next-turn", "次の「あなたの番」のセッションへ", "next your turn n", {
    type: "keynav",
    command: { type: "next-your-turn" },
  }),
  command("help", "キーの一覧を見る", "help keys ヘルプ ?", {
    type: "keynav",
    command: { type: "help" },
  }),
  command("board-suggest", "ボード提案の設定", "jev board suggest settings", {
    type: "board-suggest-settings",
  }),
];

function command(
  id: string,
  title: string,
  keywords: string,
  action: PaletteAction
): PaletteItem {
  return { id: `command:${id}`, kind: "command", title, keywords, action };
}

/** ファイルのパスを候補にする (題は最後の名前、補足はフォルダ) */
export function fileItem(path: string): PaletteItem {
  const slash = path.lastIndexOf("/");
  return {
    id: `file:${path}`,
    kind: "file",
    title: slash < 0 ? path : path.slice(slash + 1),
    detail: slash < 0 ? undefined : path.slice(0, slash),
    keywords: path,
    action: { type: "file", path },
  };
}

const BOUNDARY = new Set(["/", "-", "_", ".", " ", "(", ":"]);

function isBoundary(text: string, at: number): boolean {
  return at === 0 || BOUNDARY.has(text[at - 1]);
}

/**
 * 1 語が text にどれだけよく一致するか。一致しなければ null。
 * text と word は小文字にして渡す。
 */
export function scoreWord(text: string, word: string): number | null {
  if (word === "") return 0;
  // 連続した一致。語の頭から始まるものを優先して探す
  let best: number | null = null;
  let from = text.indexOf(word);
  while (from !== -1) {
    const score = 100 + (isBoundary(text, from) ? 40 : 0) - from * 0.1;
    if (best === null || score > best) best = score;
    if (isBoundary(text, from)) break;
    from = text.indexOf(word, from + 1);
  }
  if (best !== null) return best;
  // 飛び飛びの一致 (前から貪欲に拾う)
  let at = 0;
  let score = 20;
  let previous = -2;
  for (const char of word) {
    const found = text.indexOf(char, at);
    if (found === -1) return null;
    if (isBoundary(text, found)) score += 6;
    if (found === previous + 1) score += 3;
    else score -= Math.min(4, (found - previous - 1) * 0.3);
    previous = found;
    at = found + 1;
  }
  return score;
}

/** 候補が問い合わせにどれだけよく一致するか。語のどれかが一致しなければ null */
export function scoreItem(item: PaletteItem, words: string[]): number | null {
  const title = item.title.toLowerCase();
  const rest = `${item.keywords ?? ""} ${item.detail ?? ""}`.toLowerCase();
  let total = 0;
  for (const word of words) {
    const inTitle = scoreWord(title, word);
    const inRest = scoreWord(rest, word);
    if (inTitle === null && inRest === null) return null;
    // 題での一致を、補足やキーワードでの一致より上に置く
    total += Math.max(
      inTitle === null ? Number.NEGATIVE_INFINITY : inTitle + 30,
      inRest === null ? Number.NEGATIVE_INFINITY : inRest
    );
  }
  // 同じ点なら短い題を上に (`a.ts` を `a.test.ts` より先に)
  return total - item.title.length * 0.2;
}

export function splitQuery(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** 同じ点のとき、種類でどちらを上に置くか */
const KIND_RANK: Readonly<Record<PaletteKind, number>> = {
  session: 0,
  command: 1,
  diagram: 2,
  file: 3,
  ask: 4,
};

export interface PaletteSources {
  sessions: readonly PaletteItem[];
  diagrams: readonly PaletteItem[];
  commands: readonly PaletteItem[];
  /** worktree からの相対パス (多いので、候補の形にするのは残ったものだけ) */
  filePaths: readonly string[];
}

/** 1 度に出す候補の上限 (「聞く」の行は別) */
export const PALETTE_LIMIT = 40;
/** そのうちファイルが占めてよい数 */
const FILE_LIMIT = 25;

/**
 * 問い合わせに合う候補を、よく合う順に返す。
 * 何も打っていないときは、セッションとコマンドをそのままの順で出す (ファイルと図は
 * 数が多いので、打ち始めてから出す)。
 */
export function rankPalette(
  query: string,
  sources: PaletteSources
): PaletteItem[] {
  const words = splitQuery(query);
  if (words.length === 0) {
    return [...sources.sessions, ...sources.commands].slice(0, PALETTE_LIMIT);
  }
  const scored: Array<{ item: PaletteItem; score: number }> = [];
  for (const item of [
    ...sources.sessions,
    ...sources.commands,
    ...sources.diagrams,
  ]) {
    const score = scoreItem(item, words);
    if (score !== null) scored.push({ item, score });
  }
  const files: Array<{ path: string; score: number }> = [];
  for (const path of sources.filePaths) {
    const score = scoreFilePath(path, words);
    if (score !== null) files.push({ path, score });
  }
  files.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  for (const { path, score } of files.slice(0, FILE_LIMIT)) {
    scored.push({ item: fileItem(path), score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      KIND_RANK[a.item.kind] - KIND_RANK[b.item.kind] ||
      a.item.title.localeCompare(b.item.title)
  );
  return scored.slice(0, PALETTE_LIMIT).map(entry => entry.item);
}

/** ファイルは数が多いので、候補の形を作らずにパスのまま採点する (scoreItem と同じ点) */
function scoreFilePath(path: string, words: string[]): number | null {
  const lower = path.toLowerCase();
  const slash = lower.lastIndexOf("/");
  const name = slash < 0 ? lower : lower.slice(slash + 1);
  let total = 0;
  for (const word of words) {
    const inName = scoreWord(name, word);
    const inPath = scoreWord(lower, word);
    if (inName === null && inPath === null) return null;
    total += Math.max(
      inName === null ? Number.NEGATIVE_INFINITY : inName + 30,
      inPath === null ? Number.NEGATIVE_INFINITY : inPath
    );
  }
  return total - name.length * 0.2;
}

/** 打った文を Claude へ送る行。空なら出さない */
export function askItem(
  query: string,
  sessionLabel: string
): PaletteItem | null {
  const text = query.trim();
  if (text === "") return null;
  return {
    id: "ask",
    kind: "ask",
    title: `Claude に聞く: ${text}`,
    detail: sessionLabel,
    action: { type: "ask", text },
  };
}
