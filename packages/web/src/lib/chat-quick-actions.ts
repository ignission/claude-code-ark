/**
 * chat-quick-actions - 会話の入力欄の左にある「図解」「TODO」のボタンが送る文
 *
 * どちらも Claude への普通のメッセージとして送る (ボードと TODO の使い方は
 * SessionStart hook が伝えてある)。入力欄に文があれば、それを対象として前に置く。
 */

export type ChatQuickAction = "diagram" | "todo";

export const CHAT_QUICK_ACTION_LABEL: Readonly<
  Record<ChatQuickAction, string>
> = {
  diagram: "ボードに図解させる",
  todo: "TODOに残させる",
};

const INSTRUCTION: Readonly<
  Record<ChatQuickAction, { alone: string; withText: string }>
> = {
  diagram: {
    alone: "直前の説明をボードに図解して。",
    withText: "これをボードに図解して。",
  },
  todo: {
    alone: "この会話で保留にした話題をTODOに残して。",
    withText: "これをTODOに残して。",
  },
};

export function buildChatQuickActionMessage(
  action: ChatQuickAction,
  draft: string
): string {
  const text = draft.trim();
  const instruction = INSTRUCTION[action];
  return text ? `${text}\n\n${instruction.withText}` : instruction.alone;
}
