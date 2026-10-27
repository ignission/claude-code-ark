import type { Worktree } from "@ark/shared";

/**
 * TODO の見出しに出す worktree の表示名。サイドバーと同じく、自分で付けた名前、ブランチ名の順。
 * worktree 自体が無い (消した) ときだけ null (TodoPane が「削除済み worktree」と出す)。
 * セッションを止めただけで worktree が残っているものは、ブランチ名で引く
 */
export function todoWorktreeLabel(
  worktreePath: string,
  worktrees: readonly Pick<Worktree, "path" | "branch">[],
  displayNames: ReadonlyMap<string, string>
): string | null {
  const worktree = worktrees.find(item => item.path === worktreePath);
  if (!worktree) return null;
  return displayNames.get(worktreePath)?.trim() || worktree.branch;
}
