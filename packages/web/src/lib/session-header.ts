/**
 * PC上部バー (SplitViewPane) の表示、端末の窓の操作、`…` メニュー (SessionHeaderMenu) の中身を決める。
 *
 * メニューはRadixのPortalに描かれ、jsdomでは開いた状態を検証しにくい。
 * どの項目をどの順に出すかと文言をここに寄せ、テストで固定する。
 */

import { getBaseName } from "@/utils/pathUtils";

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
 * 端末の窓の上端のバーに並べる操作。配列の順が左からの並び順。
 * どれも端末ペインの中のもの (バッファ・iframe・入力バー) を動かすので、端末が
 * 見えている窓の中に置く。上部バーに置くのは会話へ送る操作 (メッセージの
 * ショートカット) と、作業エリアの開閉、`…` (通知・削除) だけ。
 * 添付と画像の貼り付けは、会話の入力欄が担う
 */
export type TerminalWindowAction =
  | "copy-buffer"
  | "reload-terminal"
  | "toggle-input-bar";

export function terminalWindowActions(input: {
  canCopyBuffer: boolean;
}): TerminalWindowAction[] {
  const actions: TerminalWindowAction[] = [];
  if (input.canCopyBuffer) actions.push("copy-buffer");
  actions.push("reload-terminal", "toggle-input-bar");
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
