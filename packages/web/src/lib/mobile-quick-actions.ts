/**
 * モバイル下部バーの1タップの操作 (MobileQuickActionRow) で、どれを出すかを決める。
 *
 * PCの `headerQuickActions` (session-header.ts) と同じ理由で、添付は会話モードでは
 * 出さない: 会話モードの添付は会話の入力欄 (コンポーザー) が自前のボタンを持っており、
 * 行にも出すと同じ「ファイルを添付」ボタンが2つ並んでしまう。
 * 画像の貼り付けは、会話の入力欄に貼り付けボタンが無いため、3モードとも行に出す。
 *
 * 端末に関する操作 (バッファのコピー・再読み込み) は端末モードだけに出す。
 * 図モードの添付は端末側の流儀で受けるが、端末そのものは見えていないので出さない。
 * `…` に残すのはセッション全体の操作 (通知・再起動・削除) だけ。
 */

import type { MobileSessionViewMode } from "./mobile-session-view-mode";

export type MobileQuickAction =
  | "attach-file"
  | "paste-image"
  | "message-shortcuts"
  | "slash-commands"
  | "copy-buffer"
  | "reload-terminal";

export function mobileQuickActions(input: {
  viewMode: MobileSessionViewMode;
  canUploadFile: boolean;
  canCopyBuffer: boolean;
}): MobileQuickAction[] {
  const actions: MobileQuickAction[] = [];
  if (input.canUploadFile) {
    if (input.viewMode !== "chat") actions.push("attach-file");
    actions.push("paste-image");
  }
  actions.push("message-shortcuts", "slash-commands");
  if (input.viewMode === "terminal") {
    if (input.canCopyBuffer) actions.push("copy-buffer");
    actions.push("reload-terminal");
  }
  return actions;
}
