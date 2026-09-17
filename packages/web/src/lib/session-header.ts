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
export type TerminalMenuAction = "copy-buffer" | "reload" | "toggle-input-bar";

export function terminalMenuActions(input: {
  leftMode: SplitViewLeftMode;
  canCopyBuffer: boolean;
}): TerminalMenuAction[] {
  // 端末の操作は端末ペインの中の UI (添付確認画面・入力バー) を動かす。
  // 会話モードでは親ごと隠れているので呼ばない
  if (input.leftMode !== "terminal") return [];
  const actions: TerminalMenuAction[] = [];
  if (input.canCopyBuffer) actions.push("copy-buffer");
  actions.push("reload", "toggle-input-bar");
  return actions;
}

/**
 * 上部バーに 1 タップのボタンとして並べる操作。配列の順が左からの並び順。
 * `…` を開かずに届かせたい操作をここに出し、`…` からは外す
 */
export type HeaderQuickAction =
  | "attach-file"
  | "paste-image"
  | "message-shortcuts";

export function headerQuickActions(input: {
  leftMode: SplitViewLeftMode;
  canUploadFile: boolean;
}): HeaderQuickAction[] {
  const actions: HeaderQuickAction[] = [];
  // 会話モードの添付と貼り付けは会話の入力欄が担う。端末側の添付確認画面は
  // 端末ペインの中にあり、会話モードでは親ごと隠れているので呼ばない
  if (input.leftMode === "terminal" && input.canUploadFile) {
    actions.push("attach-file", "paste-image");
  }
  actions.push("message-shortcuts");
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
