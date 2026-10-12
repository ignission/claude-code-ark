/**
 * モバイル下部バーの1タップの操作 (MobileQuickActionRow) で、どれを出すかを決める。
 *
 * 行を置く場所 (surface) は3つ: 会話モードのバー、図モードのバー、端末の窓のバー。
 *
 * 添付は会話モードでは出さない: 会話モードの添付は会話の入力欄 (コンポーザー) が
 * 自前のボタンを持っており、行にも出すと同じ「ファイルを添付」ボタンが2つ並んでしまう。
 * 画像の貼り付けは、会話の入力欄に貼り付けボタンが無いため、3か所とも行に出す。
 *
 * 端末に関する操作 (バッファのコピー・再読み込み) は端末の窓だけに出す。
 * 図モードの添付は端末側の流儀で受けるが、端末そのものは見えていないので出さない。
 * `…` に残すのはセッション全体の操作 (通知・再起動・削除) だけ。
 *
 * 音声モードは会話モードの先頭に出す。音声モードは会話ビューのイベント列を読み上げるので、
 * 会話を見ているときの操作にする。音声APIの無いブラウザ (canUseVoice=false) では出さない。
 */

import type { MobileSessionViewMode } from "./mobile-session-view-mode";

/** 1タップの操作の行を置く場所。表示モードのバーか、端末の窓のバー */
export type MobileQuickActionSurface = MobileSessionViewMode | "terminal";

export type MobileQuickAction =
  | "voice-mode"
  | "attach-file"
  | "paste-image"
  | "message-shortcuts"
  | "slash-commands"
  | "copy-buffer"
  | "reload-terminal";

export function mobileQuickActions(input: {
  surface: MobileQuickActionSurface;
  canUploadFile: boolean;
  canCopyBuffer: boolean;
  /** 音声の認識と読み上げの両方が使えるブラウザか */
  canUseVoice?: boolean;
}): MobileQuickAction[] {
  const actions: MobileQuickAction[] = [];
  if (input.surface === "chat" && input.canUseVoice) {
    actions.push("voice-mode");
  }
  if (input.canUploadFile) {
    if (input.surface !== "chat") actions.push("attach-file");
    actions.push("paste-image");
  }
  actions.push("message-shortcuts", "slash-commands");
  if (input.surface === "terminal") {
    if (input.canCopyBuffer) actions.push("copy-buffer");
    actions.push("reload-terminal");
  }
  return actions;
}
