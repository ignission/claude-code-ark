/** Git タブで選んでいるもの。未コミットの変更か、コミット 1 つ */
export type GitSelection =
  | { kind: "working" }
  | { kind: "commit"; sha: string };

export const sameSelection = (a: GitSelection | null, b: GitSelection | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.kind === b.kind &&
    (a.kind === "working" || a.sha === (b as { sha: string }).sha));
