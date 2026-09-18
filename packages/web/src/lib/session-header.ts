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

/**
 * 上部バーに 1 タップのボタンとして並べる操作。配列の順が左からの並び順。
 * `…` を開かずに届かせたい操作をここに出し、`…` からは外す。
 * `…` に残すのはセッション全体の操作 (通知・削除) だけ
 */
export type HeaderQuickAction =
  | "attach-file"
  | "paste-image"
  | "message-shortcuts"
  | "copy-buffer"
  | "reload-terminal"
  | "toggle-input-bar";

export function headerQuickActions(input: {
  leftMode: SplitViewLeftMode;
  canUploadFile: boolean;
  canCopyBuffer: boolean;
}): HeaderQuickAction[] {
  const actions: HeaderQuickAction[] = [];
  // 会話モードの添付と貼り付けは会話の入力欄が担う。端末側の添付確認画面は
  // 端末ペインの中にあり、会話モードでは親ごと隠れているので呼ばない
  const isTerminal = input.leftMode === "terminal";
  if (isTerminal && input.canUploadFile) {
    actions.push("attach-file", "paste-image");
  }
  actions.push("message-shortcuts");
  // 端末の操作も端末ペインの中の UI (バッファ・iframe・入力バー) を動かすので、
  // 会話モードでは出さない。送る操作のあと、`図` と `…` の手前にまとめる
  if (isTerminal) {
    if (input.canCopyBuffer) actions.push("copy-buffer");
    actions.push("reload-terminal", "toggle-input-bar");
  }
  return actions;
}

/** 入力バーのボタンの文言。今の状態ではなく、押すと起きることを書く */
export function inputBarToggleLabel(visible: boolean): string {
  return visible ? "入力バーを隠す" : "入力バーを表示";
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
