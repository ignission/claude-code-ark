import type { Todo } from "@ark/shared";

/**
 * 分岐TODOから会話を始めるときの、チャット入力欄の下書き。
 * originBranch を渡すと (新しいworktreeで始めるとき)、末尾に元のブランチを添える
 */
export function buildTodoDraft(todo: Todo, originBranch?: string): string {
  const parts = [todo.text];
  if (todo.note) parts.push(todo.note);
  if (originBranch) parts.push(`(分岐TODO。元のブランチ: ${originBranch})`);
  return parts.join("\n\n");
}

/** 新しいworktreeのブランチ名の候補。Claudeが付けた名前があればそれ、無ければidから作る */
export function todoBranchCandidate(todo: Todo): string {
  if (todo.branchName) return todo.branchName;
  return `todo-${todo.id.slice(0, 6)}`;
}
