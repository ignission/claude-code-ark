/**
 * PC上部バー (SplitViewPane) の表示と、`…` メニュー (SessionHeaderMenu) の中身を決める。
 *
 * メニューはRadixのPortalに描かれ、jsdomでは開いた状態を検証しにくい。
 * どの項目をどの順に出すかと文言をここに寄せ、テストで固定する。
 */

import { getBaseName } from "@/utils/pathUtils";
import type { SplitViewLeftMode } from "./split-view-left-mode";

export interface SessionHeaderLabels {
  /** 主ラベル。表示名 → リポジトリ名 → worktreeのフォルダ名の順に決める */
  primary: string;
  /** ブランチ。worktreeが無ければworktreeのフォルダ名 */
  branch: string;
}

export function resolveSessionHeaderLabels(input: {
  displayName: string | null | undefined;
  repoName: string | undefined;
  branch: string | undefined;
  worktreePath: string;
}): SessionHeaderLabels {
  const folderName = getBaseName(input.worktreePath);
  return {
    primary: input.displayName?.trim() || input.repoName || folderName,
    branch: input.branch || folderName,
  };
}

/** 端末モードのときだけ `…` メニューに出す操作。配列の順がメニューの表示順 */
export type TerminalMenuAction =
  | "copy-buffer"
  | "paste-image"
  | "attach-file"
  | "reload"
  | "toggle-input-bar";

export function terminalMenuActions(input: {
  leftMode: SplitViewLeftMode;
  canCopyBuffer: boolean;
  canUploadFile: boolean;
}): TerminalMenuAction[] {
  // 会話モードの添付と貼り付けは会話の入力欄が担う。端末側の添付確認画面は
  // 端末ペインの中にあり、会話モードでは親ごと隠れているので呼ばない
  if (input.leftMode !== "terminal") return [];
  const actions: TerminalMenuAction[] = [];
  if (input.canCopyBuffer) actions.push("copy-buffer");
  if (input.canUploadFile) actions.push("paste-image", "attach-file");
  actions.push("reload", "toggle-input-bar");
  return actions;
}

export function notificationMenuLabel(enabled: boolean): string {
  return enabled
    ? "このセッションの通知をオフにする"
    : "このセッションの通知をオンにする";
}

export function deleteSessionDescription(
  worktree: { isMain: boolean } | undefined
): string {
  if (worktree === undefined) return "このセッションを削除しますか？";
  return worktree.isMain
    ? "このセッションを削除しますか？メインWorktreeは削除されません。"
    : "このセッションとWorktreeを削除しますか？関連するブランチも削除されます。";
}
