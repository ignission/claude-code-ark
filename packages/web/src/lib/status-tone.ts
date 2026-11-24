/**
 * セッションの状態の表示を 1 か所に集約する (設計書 7 節)。
 *
 * PCサイドバー・モバイル一覧・PC上部バー・モバイルヘッダー・RepoGridView が
 * すべてここを通す。状態は BridgeSessionStatus だけから決め、端末の画面テキストは
 * 解釈しない (情報源分離の原則)。一覧だけは、手動で休止にした行を RESTED にする
 * (session-sections.ts)。
 */

import type { BridgeSessionStatus } from "@ark/shared";
import { m } from "./i18n";
import type { MobileSessionViewMode } from "./mobile-session-view-mode";

/** RESTED は人が手動で休止にした行 (BridgeSessionStatus に関係なく一覧の札をこれにする) */
export type StatusKey =
  | BridgeSessionStatus
  | "RESTED"
  | "NOT_STARTED"
  | "UNKNOWN";
export type StatusTone = "awaiting" | "error" | "idle" | "busy" | "neutral";
export type StatusIcon =
  | "question"
  | "alert"
  | "message"
  | "dots"
  | "minus"
  | "stop"
  | "pause"
  | "play";

export interface StatusPresentation {
  tone: StatusTone;
  label: string;
  icon: StatusIcon;
  /** あなたの番 (人の手を待っている) か。畳んだサイドバーの帯の件数と、休止にできる行の判定に使う */
  yourTurn: boolean;
  outlined: boolean;
}

const PRESENTATIONS: Readonly<Record<StatusKey, StatusPresentation>> = {
  // AWAITING は質問と許可プロンプトの両方を含むので「質問」ではなく「確認待ち」
  AWAITING: {
    tone: "awaiting",
    label: m.session.status.awaiting,
    icon: "question",
    yourTurn: true,
    outlined: false,
  },
  ERR: {
    tone: "error",
    label: m.session.status.error,
    icon: "alert",
    yourTurn: true,
    outlined: false,
  },
  // IDLE は「出力があり入力を待っている」だけで、成功を意味しない
  IDLE: {
    tone: "idle",
    label: m.session.status.idle,
    icon: "message",
    yourTurn: true,
    outlined: false,
  },
  TOOL: {
    tone: "busy",
    label: m.session.status.working,
    icon: "dots",
    yourTurn: false,
    outlined: false,
  },
  THINK: {
    tone: "busy",
    label: m.session.status.working,
    icon: "dots",
    yourTurn: false,
    outlined: false,
  },
  READY: {
    tone: "neutral",
    label: m.session.status.ready,
    icon: "minus",
    yourTurn: false,
    outlined: false,
  },
  STOP: {
    tone: "neutral",
    label: m.session.status.stopped,
    icon: "stop",
    yourTurn: false,
    outlined: false,
  },
  RESTED: {
    tone: "neutral",
    label: m.session.status.rested,
    icon: "pause",
    yourTurn: false,
    outlined: false,
  },
  NOT_STARTED: {
    tone: "neutral",
    label: m.session.status.notStarted,
    icon: "play",
    yourTurn: false,
    outlined: true,
  },
  UNKNOWN: {
    tone: "neutral",
    label: "",
    icon: "minus",
    yourTurn: false,
    outlined: false,
  },
};

export function resolveStatusKey(
  hasSession: boolean,
  bridgeStatus: BridgeSessionStatus | undefined
): StatusKey {
  if (!hasSession) return "NOT_STARTED";
  return bridgeStatus ?? "UNKNOWN";
}

export function presentStatus(key: StatusKey): StatusPresentation {
  return PRESENTATIONS[key];
}

/**
 * トーンごとの Tailwind クラス。Tailwind がクラス名を静的に拾えるよう、
 * 文字列を組み立てずに全部書く
 */
export const TONE_CLASSES: Readonly<
  Record<StatusTone, { text: string; softBg: string; solidBg: string }>
> = {
  awaiting: {
    text: "text-status-awaiting",
    softBg: "bg-status-awaiting/15",
    solidBg: "bg-status-awaiting",
  },
  error: {
    text: "text-status-error",
    softBg: "bg-status-error/15",
    solidBg: "bg-status-error",
  },
  idle: {
    text: "text-status-idle",
    softBg: "bg-status-idle/15",
    solidBg: "bg-status-idle",
  },
  busy: {
    text: "text-status-busy",
    softBg: "bg-status-busy/15",
    solidBg: "bg-status-busy",
  },
  neutral: {
    text: "text-status-neutral",
    softBg: "bg-status-neutral/15",
    solidBg: "bg-status-neutral",
  },
};

export interface StatusStrip {
  tone: StatusTone;
  text: string;
  /** 会話以外のモードで「会話で答える」ボタンを出すか */
  offerChat: boolean;
}

/** モバイル会話画面のヘッダー直下の帯 (設計書 8.5 節) */
export function resolveStatusStrip(input: {
  bridgeStatus: BridgeSessionStatus | undefined;
  hasActiveAuq: boolean;
  isConnected: boolean;
  viewMode: MobileSessionViewMode;
}): StatusStrip | null {
  if (!input.isConnected) {
    return {
      tone: "error",
      text: m.session.strip.disconnected,
      offerChat: false,
    };
  }
  switch (input.bridgeStatus) {
    case "AWAITING":
      return {
        tone: "awaiting",
        text: input.hasActiveAuq
          ? m.session.strip.question
          : m.session.strip.confirmation,
        offerChat: input.viewMode !== "chat",
      };
    case "THINK":
      return { tone: "busy", text: m.session.strip.thinking, offerChat: false };
    case "TOOL":
      return { tone: "busy", text: m.session.strip.working, offerChat: false };
    case "ERR":
      return { tone: "error", text: m.session.strip.error, offerChat: false };
    default:
      return null;
  }
}
