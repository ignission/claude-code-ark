/**
 * PC（SplitViewPane）の左ペイン表示モードと、その永続化。
 *
 * 左ペインは「端末（ttyd）」と「会話（SplitChatPane）」の 2 値で切り替える。
 * 図（board）は右ペイン側の独立した開閉状態（`ark-split-show-board`）が担うため、
 * ここには含めない。モバイルの `mobile-session-view-mode.ts` と形は似ているが、
 * 取りうる値も保存キーも別物なので独立したモジュールとして持つ。
 *
 * 既定は "terminal"。従来の PC は常にターミナルだったため、未保存の
 * ユーザーには従来どおりの見え方を返す。
 */

export const SPLIT_VIEW_LEFT_MODE_VALUES = ["terminal", "chat"] as const;

export type SplitViewLeftMode = (typeof SPLIT_VIEW_LEFT_MODE_VALUES)[number];

export interface SplitViewLeftModeChangeDetail {
  mode: SplitViewLeftMode;
}

interface LeftModeStorageReader {
  getItem(key: string): string | null;
}

interface LeftModeStorageWriter {
  setItem(key: string, value: string): void;
}

export const STORAGE_KEY_SPLIT_LEFT_MODE = "ark-split-left-mode";

/** 同じタブ内で、常時マウント済みの全 SplitViewPane へ変更を伝える。 */
export const SPLIT_VIEW_LEFT_MODE_CHANGE_EVENT =
  "ark:split-view-left-mode-change";

export function normalizeSplitViewLeftMode(value: unknown): SplitViewLeftMode {
  return SPLIT_VIEW_LEFT_MODE_VALUES.includes(value as SplitViewLeftMode)
    ? (value as SplitViewLeftMode)
    : "terminal";
}

export function readSavedSplitViewLeftMode(
  storage?: LeftModeStorageReader
): SplitViewLeftMode {
  try {
    const source = storage ?? window.localStorage;
    return normalizeSplitViewLeftMode(
      source.getItem(STORAGE_KEY_SPLIT_LEFT_MODE)
    );
  } catch {
    return "terminal";
  }
}

export function writeSavedSplitViewLeftMode(
  mode: SplitViewLeftMode,
  storage?: LeftModeStorageWriter
): void {
  // storage イベントは同じ window には発火しない。Dashboard で常時
  // マウントされている別セッションにも、Storage の成否にかかわらず
  // 選択値を直接反映できるよう、書き込みより先に同一タブへ通知する。
  if (storage === undefined && typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<SplitViewLeftModeChangeDetail>(
        SPLIT_VIEW_LEFT_MODE_CHANGE_EVENT,
        { detail: { mode } }
      )
    );
  }

  try {
    const target = storage ?? window.localStorage;
    target.setItem(STORAGE_KEY_SPLIT_LEFT_MODE, mode);
  } catch {
    // Storage unavailable (SSR / private mode / quota) must not break switching.
  }
}

/**
 * 会話ビューが JSONL を購読してよいか。
 *
 * SplitViewPane は Dashboard で全セッションぶんが常時マウントされる
 * （選択中でないものは `hidden` で存在し続ける）。さらに左ペインは
 * 端末・会話の両方をマウントしたまま display 切替する。したがって
 * 「選択中のセッション」かつ「会話モード」の 1 枚だけが購読しないと、
 * セッション数ぶんの JSONL tail が常時走ってしまう。
 */
export function shouldSubscribeChat(
  isSelectedSession: boolean,
  mode: SplitViewLeftMode
): boolean {
  return isSelectedSession && mode === "chat";
}

/**
 * 端末ペインが window レベルのファイル D&D を受け取ってよいか。
 *
 * TerminalPane の D&D は ttyd iframe を跨ぐため window で受けており、
 * 表示状態と無関係に発火する。上と同じ理由でマウント枚数ぶん多重に効くので、
 * 実際に見えている 1 枚だけに絞る。絞らないと、会話モードでチャット欄へ
 * 落としたファイルが裏の端末ペインにも入り、端末へ戻したときに
 * 身に覚えのない送信プレビューが出る。
 */
export function shouldAcceptTerminalFileDrop(
  isSelectedSession: boolean,
  mode: SplitViewLeftMode
): boolean {
  return isSelectedSession && mode === "terminal";
}
