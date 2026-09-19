/**
 * VoiceModeOverlay - 音声モードの画面 (モバイル)。
 *
 * 全画面で「いま何をしているか」と、そのときに押せるボタンだけを大きく出す。
 * 画面での操作が要るとき (質問・権限確認) は画面上部の帯に縮め、下の会話ビューを見せる。
 * 状態の持ち主は useVoiceMode。ここは描くだけ。
 *
 * 仕様: docs/superpowers/specs/2026-09-19-voice-mode-design.md の4章
 */

import type { BridgeSessionStatus } from "@ark/shared";
import { Mic, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { VoiceState } from "@/lib/voice-mode-machine";

export interface VoiceModeOverlayProps {
  state: VoiceState;
  bridgeStatus?: BridgeSessionStatus;
  onExit: () => void;
  onTapMic: () => void;
  onCancel: () => void;
  onSendNow: () => void;
  onStopSpeaking: () => void;
  onExpand: () => void;
}

export function voicePhaseLabel(
  state: VoiceState,
  bridgeStatus?: BridgeSessionStatus
): string {
  switch (state.phase) {
    case "ready":
      return "タップして話す";
    case "listening":
      return "聞いています";
    case "confirming":
      return "2秒後に送ります";
    case "working":
      if (bridgeStatus === "THINK") return "考えています";
      if (bridgeStatus === "TOOL") return "作業しています";
      return "Claudeの返答を待っています";
    case "speaking":
      return "読み上げています";
    case "screen":
      return "画面で操作してください";
    case "off":
      return "";
  }
}

const PRIMARY_BUTTON =
  "inline-flex h-12 min-w-32 items-center justify-center gap-2 rounded-full bg-primary px-6 text-[15px] font-semibold text-primary-foreground";
const SECONDARY_BUTTON =
  "inline-flex h-12 min-w-32 items-center justify-center gap-2 rounded-full border border-border bg-card px-6 text-[15px] font-semibold text-foreground";

export function VoiceModeOverlay({
  state,
  bridgeStatus,
  onExit,
  onTapMic,
  onCancel,
  onSendNow,
  onStopSpeaking,
  onExpand,
}: VoiceModeOverlayProps) {
  if (state.phase === "off") return null;
  const label = voicePhaseLabel(state, bridgeStatus);

  if (state.phase === "screen") {
    return (
      <button
        type="button"
        data-testid="voice-mode-minimized"
        onClick={onExpand}
        className="fixed inset-x-3 top-[calc(env(safe-area-inset-top)+64px)] z-50 flex h-11 items-center gap-2 rounded-full bg-primary px-4 text-left text-[14px] font-semibold text-primary-foreground shadow-lg"
      >
        <Mic className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">音声モード: {label}</span>
        <span className="shrink-0 text-[13px] opacity-90">戻る</span>
      </button>
    );
  }

  const text =
    state.phase === "speaking"
      ? state.speaking.join("")
      : state.phase === "listening" || state.phase === "confirming"
        ? state.transcript
        : "";
  const active = state.phase === "listening" || state.phase === "speaking";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="音声モード"
      data-testid="voice-mode-overlay"
      className="fixed inset-0 z-50 flex flex-col bg-background text-foreground safe-area-top safe-area-x"
    >
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        <span className="text-[17px] font-semibold">音声モード</span>
        <button
          type="button"
          onClick={onExit}
          aria-label="音声モードを終える"
          className="inline-flex size-10 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
        >
          <X className="size-5" aria-hidden="true" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
        <div
          aria-hidden="true"
          className={cn(
            "flex size-28 items-center justify-center rounded-full bg-primary/15",
            active && "animate-pulse"
          )}
        >
          <Mic className="size-10 text-primary" />
        </div>
        <p
          role="status"
          className="text-[15px] font-semibold text-muted-foreground"
        >
          {label}
        </p>
        {text && (
          <p
            data-testid="voice-mode-text"
            className="max-h-[40vh] overflow-y-auto whitespace-pre-wrap break-words text-[20px] leading-relaxed"
          >
            {text}
          </p>
        )}
        {state.notice && (
          <p className="text-[13px] text-muted-foreground">{state.notice}</p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-center gap-3 px-6 pt-4 pb-[calc(env(safe-area-inset-bottom)+24px)]">
        {state.phase === "ready" && (
          <button type="button" onClick={onTapMic} className={PRIMARY_BUTTON}>
            <Mic className="size-5" aria-hidden="true" />
            話す
          </button>
        )}
        {state.phase === "listening" && (
          <button type="button" onClick={onCancel} className={SECONDARY_BUTTON}>
            やめる
          </button>
        )}
        {state.phase === "confirming" && (
          <>
            <button
              type="button"
              onClick={onCancel}
              className={SECONDARY_BUTTON}
            >
              取り消す
            </button>
            <button
              type="button"
              onClick={onSendNow}
              className={PRIMARY_BUTTON}
            >
              すぐ送る
            </button>
          </>
        )}
        {state.phase === "working" && (
          <button type="button" onClick={onTapMic} className={SECONDARY_BUTTON}>
            <Mic className="size-5" aria-hidden="true" />
            追加で話す
          </button>
        )}
        {state.phase === "speaking" && (
          <button
            type="button"
            onClick={onStopSpeaking}
            className={PRIMARY_BUTTON}
          >
            タップで止める
          </button>
        )}
      </div>
    </div>
  );
}
