/**
 * セッションの状態の表示を 1 か所に集約する (設計書 7 節)。
 *
 * PCサイドバー・モバイル一覧・PC上部バー・モバイルヘッダー・RepoGridView が
 * すべてここを通す。状態は BridgeSessionStatus だけから決め、端末の画面テキストは
 * 解釈しない (情報源分離の原則)。
 */

import type { BridgeSessionStatus } from "@ark/shared";
import { m } from "./i18n";
import type { MobileSessionViewMode } from "./mobile-session-view-mode";

export type StatusKey = BridgeSessionStatus | "NOT_STARTED" | "UNKNOWN";
export type StatusTone = "awaiting" | "error" | "idle" | "busy" | "neutral";
export type StatusIcon =
  | "question"
  | "alert"
  | "message"
  | "dots"
  | "minus"
  | "stop"
  | "play";
export type SessionSection = "your-turn" | "working" | "resting";

export interface StatusPresentation {
  tone: StatusTone;
  label: string;
  icon: StatusIcon;
  section: SessionSection;
  priority: number;
  outlined: boolean;
}

const PRESENTATIONS: Readonly<Record<StatusKey, StatusPresentation>> = {
  // AWAITING は質問と許可プロンプトの両方を含むので「質問」ではなく「確認待ち」
  AWAITING: {
    tone: "awaiting",
    label: m.session.status.awaiting,
    icon: "question",
    section: "your-turn",
    priority: 1,
    outlined: false,
  },
  ERR: {
    tone: "error",
    label: m.session.status.error,
    icon: "alert",
    section: "your-turn",
    priority: 2,
    outlined: false,
  },
  // IDLE は「出力があり入力を待っている」だけで、成功を意味しない
  IDLE: {
    tone: "idle",
    label: m.session.status.idle,
    icon: "message",
    section: "your-turn",
    priority: 3,
    outlined: false,
  },
  TOOL: {
    tone: "busy",
    label: m.session.status.working,
    icon: "dots",
    section: "working",
    priority: 4,
    outlined: false,
  },
  THINK: {
    tone: "busy",
    label: m.session.status.working,
    icon: "dots",
    section: "working",
    priority: 4,
    outlined: false,
  },
  READY: {
    tone: "neutral",
    label: m.session.status.ready,
    icon: "minus",
    section: "resting",
    priority: 5,
    outlined: false,
  },
  STOP: {
    tone: "neutral",
    label: m.session.status.stopped,
    icon: "stop",
    section: "resting",
    priority: 6,
    outlined: false,
  },
  NOT_STARTED: {
    tone: "neutral",
    label: m.session.status.notStarted,
    icon: "play",
    section: "resting",
    priority: 7,
    outlined: true,
  },
  UNKNOWN: {
    tone: "neutral",
    label: "",
    icon: "minus",
    section: "resting",
    priority: 8,
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

export const SECTION_ORDER: readonly SessionSection[] = [
  "your-turn",
  "working",
  "resting",
];

export const SECTION_LABELS: Readonly<Record<SessionSection, string>> = {
  "your-turn": m.session.sections.yourTurn,
  working: m.session.sections.working,
  resting: m.session.sections.resting,
};

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
