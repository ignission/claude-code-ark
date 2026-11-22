/**
 * チャット入力のリポジトリメンション。
 *
 * 入力欄で `@` を打つと、Ark が知っているリポジトリの候補が出る。確定すると入力欄には
 * `@shop` のような短い名前が入り、送るときにリポジトリの絶対パスへ置き換える。
 * 受け取った Claude は、そのパスを task_start / todo_add の repo にそのまま渡せる。
 *
 * - 候補は task_start の repo が受け付ける集合と同じものをサーバーから取る (`repo:mention-list`)。
 *   画面に登録したリポジトリ (repoList) とは別の集合。走査で集めるときは `.git` がディレクトリの
 *   ものだけを拾うので、worktree (`.git` がファイル) は入らない。セッションも入らない
 * - 短い名前は、パスを `/` で区切った末尾の並びのうち、候補の中で 1 つに決まるもの
 *   (task-repo.ts の解決と同じ決まり)。同じ名前のリポジトリが 2 つあれば `owner/name` まで伸びる
 * - 送る文字列に `@` を残さない。`@パス` は、アップロードしたファイルを Claude に渡すときの
 *   ファイル参照の書き方で、リポジトリを指す表記と混ざるため
 * - 会話の吹き出しは JSONL の本文 (絶対パス) から描くので、候補のパスを短い名前へ戻して見せる。
 *   人が絶対パスを手で書いた発言も同じ見た目になる (どちらも同じリポジトリを指す)
 * - `@/` で始まるものはメンションにしない (アップロードしたファイルの参照 `@/path/to/file`)
 * - `@` の直前がパスの文字か `@` のときはメンションにしない (メールアドレスなど)。
 *   日本語は空白を挟まずに書くので、それ以外の文字の直後 (`これを@shop で`) は対象にする
 */

/** リポジトリのパスの一部になりうる文字。メンションとパスの終わりを見分けるのに使う */
const PATH_CHAR = /[A-Za-z0-9._/-]/;
/** カーソルの直前にある打ちかけのメンション。別の `@` はまたがない */
const MENTION_AT_CARET = /@([^\s@]*)$/;
const MENTION_IN_TEXT = /@([^\s@]+)/g;

/** `@` の直前の文字から、メンションとして読むかを決める (英数字などパスの文字と `@` の直後は読まない) */
function canStartMention(prev: string | undefined): boolean {
  return prev === undefined || (prev !== "@" && !PATH_CHAR.test(prev));
}

/** 名前に空白か `@` を含むと、`@名前` の終わりを本文から読み取れない */
function isPlainLabel(label: string): boolean {
  return !/[\s@]/.test(label);
}

export interface RepoMentionCandidate {
  /** リポジトリの絶対パス */
  path: string;
  /** 入力欄に入る短い名前 (`@` は含まない) */
  label: string;
  /** 候補の一覧で名前に添える、親ディレクトリまでのパス */
  parent: string;
}

function segmentsOf(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** 末尾の並び → その並びで終わる候補のパス。1 つに決まらない並びは null */
function buildTailIndex(paths: readonly string[]): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const path of new Set(paths)) {
    const segments = segmentsOf(path);
    for (let i = segments.length - 1; i >= 0; i--) {
      const tail = segments.slice(i).join("/");
      index.set(tail, index.has(tail) ? null : path);
    }
  }
  return index;
}

/** 候補のパスに、1 つに決まる最短の名前を付ける。パスの順に並べて返す */
export function buildRepoMentionCandidates(
  paths: readonly string[]
): RepoMentionCandidate[] {
  const unique = Array.from(new Set(paths)).filter(p => p.startsWith("/"));
  const index = buildTailIndex(unique);
  const candidates: RepoMentionCandidate[] = [];
  for (const path of unique) {
    const segments = segmentsOf(path);
    if (segments.length === 0) continue;
    // 末尾 1 つから伸ばし、初めて 1 つに決まった並びを名前にする。全体まで伸ばせば必ず決まる
    let label = segments.join("/");
    for (let i = segments.length - 1; i >= 0; i--) {
      const tail = segments.slice(i).join("/");
      if (index.get(tail) === path) {
        label = tail;
        break;
      }
    }
    candidates.push({
      path,
      label,
      parent: `/${segments.slice(0, -1).join("/")}`,
    });
  }
  return candidates.sort((a, b) => a.path.localeCompare(b.path));
}

export interface ActiveRepoMention {
  /** `@` の位置 */
  start: number;
  /** `@` のあとからカーソルまでの文字列 */
  query: string;
}

/**
 * カーソルが打ちかけのメンションの中にあれば、その範囲を返す。
 * 英数字などパスの文字に続く `@` は拾わない (メールアドレスなど)
 */
export function findRepoMentionAtCaret(
  value: string,
  caret: number
): ActiveRepoMention | null {
  const before = value.slice(0, caret);
  const match = MENTION_AT_CARET.exec(before);
  if (!match) return null;
  const query = match[1] ?? "";
  const start = before.length - query.length - 1;
  if (query.startsWith("/") || !canStartMention(before[start - 1])) return null;
  return { start, query };
}

/** 打った文字で候補を絞る。名前の先頭に一致するものを先に、途中に一致するものを後に並べる */
export function filterRepoMentionCandidates(
  candidates: readonly RepoMentionCandidate[],
  query: string,
  limit = 8
): RepoMentionCandidate[] {
  const q = query.toLowerCase();
  if (!q) return candidates.slice(0, limit);
  const nameOf = (c: RepoMentionCandidate) =>
    (c.path.split("/").pop() ?? "").toLowerCase();
  const head: RepoMentionCandidate[] = [];
  const rest: RepoMentionCandidate[] = [];
  for (const candidate of candidates) {
    const label = candidate.label.toLowerCase();
    if (nameOf(candidate).startsWith(q) || label.startsWith(q)) {
      head.push(candidate);
    } else if (candidate.path.toLowerCase().includes(q)) {
      rest.push(candidate);
    }
  }
  // 先頭一致の中では短い名前を先にする (`sho` で shop を shop-app-ios より上に出す)
  head.sort((a, b) => nameOf(a).length - nameOf(b).length);
  return [...head, ...rest].slice(0, limit);
}

/**
 * 打ちかけのメンションを、選んだ候補の短い名前に置き換える。続けて書けるよう空白を 1 つ足す。
 * 名前に空白か `@` を含む候補は、送るときに名前の終わりを読み取れないので、絶対パスをそのまま入れる
 */
export function applyRepoMention(
  value: string,
  mention: ActiveRepoMention,
  caret: number,
  candidate: RepoMentionCandidate
): { value: string; caret: number } {
  const after = value.slice(caret);
  const text = isPlainLabel(candidate.label)
    ? `@${candidate.label}`
    : candidate.path;
  const inserted = `${text}${/^\s/.test(after) ? "" : " "}`;
  return {
    value: value.slice(0, mention.start) + inserted + after,
    caret: mention.start + inserted.length + (/^\s/.test(after) ? 1 : 0),
  };
}

/**
 * 送る直前に、`@名前` をリポジトリの絶対パスへ置き換える。
 * 名前は候補の中で 1 つに決まる末尾の並びならどれでもよい (手で打った `@owner/name` も通る)。
 * 決まらないものと候補に無いものは、書かれたまま残す
 */
export function expandRepoMentions(
  value: string,
  candidates: readonly RepoMentionCandidate[]
): string {
  if (candidates.length === 0 || !value.includes("@")) return value;
  const index = buildTailIndex(candidates.map(c => c.path));
  return value.replace(
    MENTION_IN_TEXT,
    (whole: string, token: string, offset: number) => {
      if (token.startsWith("/") || !canStartMention(value[offset - 1])) {
        return whole;
      }
      // 日本語は空白を挟まずに続くので (`@shopで直して`)、長い方から順に名前を探す
      for (let end = token.length; end > 0; end--) {
        const next = token[end];
        if (next !== undefined && PATH_CHAR.test(next)) continue;
        const path = index.get(token.slice(0, end));
        if (path) return `${path}${token.slice(end)}`;
      }
      return whole;
    }
  );
}

/** 会話に見せる本文で、候補のリポジトリの絶対パスを `@名前` へ戻す */
export function collapseRepoPaths(
  text: string,
  candidates: readonly RepoMentionCandidate[]
): string {
  if (candidates.length === 0 || !text.includes("/")) return text;
  // 長いパスから当てる (あるリポジトリのパスが、別のリポジトリのパスの先頭になっている場合)
  const sorted = [...candidates].sort((a, b) => b.path.length - a.path.length);
  let result = "";
  let i = 0;
  while (i < text.length) {
    const prev = i > 0 ? text[i - 1] : undefined;
    const atBoundary =
      text[i] === "/" &&
      (prev === undefined || (prev !== "@" && !PATH_CHAR.test(prev)));
    const hit = atBoundary
      ? sorted.find(c => {
          if (!text.startsWith(c.path, i)) return false;
          const next = text[i + c.path.length];
          return next === undefined || !PATH_CHAR.test(next);
        })
      : undefined;
    if (hit) {
      result += `@${hit.label}`;
      i += hit.path.length;
    } else {
      result += text[i];
      i += 1;
    }
  }
  return result;
}
