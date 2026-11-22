/**
 * task_start の `repo` を、Ark が知っているリポジトリの絶対パスへ解決する。
 *
 * 呼び出し元と別のリポジトリへ子タスクを切り出すための指定。受け付けるのは次の 2 つ。
 *
 * - 絶対パス: 候補のどれかと一致するもの
 * - パスの末尾の並び: `app` / `acme/app` / `github.com/acme/app` のように、
 *   候補のパスを `/` で区切った末尾と一致するもの。区切りの途中では切らない
 *   (`pp` は `app` に一致しない)
 *
 * 候補は呼び出し側が渡す (許可リストがあればそれ、無ければ保存済みの走査先を走査した結果)。
 * 候補に無いパスは、実在する git リポジトリでも受け付けない。人が Ark に見せていない場所へ、
 * セッションの Claude が worktree を作れないようにするため。
 *
 * 複数に一致したら選ばずに失敗させ、候補を文に入れて返す (Claude が長い指定で呼び直せる)。
 */

function stripTrailingSlashes(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

function segmentsOf(value: string): string[] {
  return value.split("/").filter(Boolean);
}

function endsWithSegments(pathSegments: string[], tail: string[]): boolean {
  if (tail.length === 0 || tail.length > pathSegments.length) return false;
  const offset = pathSegments.length - tail.length;
  return tail.every((segment, i) => pathSegments[offset + i] === segment);
}

export function resolveTaskRepo(spec: string, candidates: string[]): string {
  const wanted = stripTrailingSlashes(spec.trim());
  if (!wanted) throw new Error("repo is empty");
  const known = Array.from(new Set(candidates.map(stripTrailingSlashes)));
  if (known.length === 0) {
    throw new Error(
      "Ark has no repository list to resolve repo against (no allowed repositories and no saved scan path)"
    );
  }

  if (wanted.startsWith("/")) {
    if (known.includes(wanted)) return wanted;
    throw new Error(`repo '${wanted}' is not a repository Ark knows`);
  }

  const tail = segmentsOf(wanted);
  const matches = known.filter(candidate =>
    endsWithSegments(segmentsOf(candidate), tail)
  );
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(
      `repo '${wanted}' does not match any repository Ark knows. Pass an absolute path or the trailing part of one (e.g. owner/name)`
    );
  }
  throw new Error(
    `repo '${wanted}' is ambiguous. Candidates: ${matches.join(", ")}`
  );
}
