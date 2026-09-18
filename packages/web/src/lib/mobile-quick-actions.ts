/**
 * モバイル下部バーの1タップの操作 (MobileQuickActionRow) で、どれを出すかを決める。
 *
 * PCの `headerQuickActions` (session-header.ts) と同じ理由で、添付は会話モードでは
 * 出さない: 会話モードの添付は会話の入力欄 (コンポーザー) が自前のボタンを持っており、
 * 行にも出すと同じ「ファイルを添付」ボタンが2つ並んでしまう。
 * 画像の貼り付けは、会話の入力欄に貼り付けボタンが無いため、3モードとも行に出す。
 */

import type { MobileSessionViewMode } from "./mobile-session-view-mode";

export type MobileQuickAction =
  | "attach-file"
  | "paste-image"
  | "message-shortcuts"
  | "slash-commands";

export function mobileQuickActions(input: {
  viewMode: MobileSessionViewMode;
  canUploadFile: boolean;
}): MobileQuickAction[] {
  const actions: MobileQuickAction[] = [];
  if (input.canUploadFile) {
    if (input.viewMode !== "chat") actions.push("attach-file");
    actions.push("paste-image");
  }
  actions.push("message-shortcuts", "slash-commands");
  return actions;
}
