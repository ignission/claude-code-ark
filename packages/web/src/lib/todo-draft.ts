import type { Todo } from "@ark/shared";
import { m } from "@/lib/i18n";

/**
 * 分岐TODOから会話を始めるときの、チャット入力欄の下書き。
 * originBranch を渡すと (新しいworktreeで始めるとき)、末尾に元のブランチを添える
 */
export function buildTodoDraft(todo: Todo, originBranch?: string): string {
  const parts = [todo.text];
  if (todo.note) parts.push(todo.note);
  if (originBranch) parts.push(m.todo.draftOrigin(originBranch));
  return parts.join("\n\n");
}

/** 本文かメモにあるチケット番号 (`ABC-123` の形)。無ければ null */
function ticketKeyOf(todo: Todo): string | null {
  const match = /\b[A-Z][A-Z0-9]+-\d+\b/.exec(
    `${todo.text}\n${todo.note ?? ""}`
  );
  return match ? match[0] : null;
}

/**
 * 新しいworktreeのブランチ名の候補 (タスクの名前になる)。Claudeが付けた名前があればそれ。
 * 無ければ本文かメモのチケット番号、それも無ければidから作る
 */
export function todoBranchCandidate(todo: Todo): string {
  if (todo.branchName) return todo.branchName;
  return ticketKeyOf(todo) ?? `todo-${todo.id.slice(0, 6)}`;
}
