/**
 * next-actions - Claude が next_actions で出した「次の一手」を、JSONL のイベント列から読む。
 *
 * サーバーは選択肢を保持も配信もしない (board-mcp-server.ts)。画面は会話と同じ JSONL の
 * tool_use の入力から読むので、リロードしても Ark を再起動しても同じ選択肢が出て、
 * 返事をすれば (会話欄、端末、別の端末のどこからでも) 消える。
 *
 * 出すのは「最後の next_actions のあとに、人の発言も Claude の次の作業も無い」ときだけ。
 * - 後ろに人の発言、スラッシュコマンド、/compact がある: もう答えたか、会話が切り替わった
 * - 後ろに別のツール呼び出しがある: Claude が作業を続けたので、選択肢は古い
 * - 後ろが返答の本文だけ: 出す (Claude は最後の返答の前に呼ぶ)
 * - 後ろがバックグラウンド作業の完了通知などの system-note だけ: 出したままにする
 * subagent の中の呼び出しは読まない。
 *
 * 入力は Claude が書いたものなので、サーバーの検証 (zod) を通っていても画面で検証し直す
 * (検証に落ちた呼び出しも tool_use としては JSONL に残る)。
 */

import { NEXT_ACTIONS_LIMITS, NEXT_ACTIONS_TOOL_USE_NAME } from "@ark/shared";
import type { JsonlParsedEvent } from "./jsonl-event-parser";

export interface NextAction {
  /** ボタンに出す文 */
  label: string;
  /** 押したときに会話へ送る文 */
  prompt: string;
  /** ボタンの下に出す理由。無ければ undefined */
  reason?: string;
}

export interface PendingNextActions {
  /** この選択肢を出した tool_use の id。押したあとに同じものを出し直さないために使う */
  toolUseId: string;
  actions: NextAction[];
}

function readText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text !== "" && text.length <= max ? text : null;
}

/** tool_use の入力を検証して選択肢にする。1つでも形が違えば全体を捨てる (空配列) */
export function readNextActions(input: unknown): NextAction[] {
  const raw = (input as { actions?: unknown } | null)?.actions;
  if (!Array.isArray(raw)) return [];
  if (raw.length === 0 || raw.length > NEXT_ACTIONS_LIMITS.maxActions) {
    return [];
  }
  const actions: NextAction[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return [];
    const { label, prompt, reason } = item as Record<string, unknown>;
    const labelText = readText(label, NEXT_ACTIONS_LIMITS.label);
    const promptText = readText(prompt, NEXT_ACTIONS_LIMITS.prompt);
    if (labelText === null || promptText === null) return [];
    const reasonText =
      reason === undefined || reason === ""
        ? undefined
        : readText(reason, NEXT_ACTIONS_LIMITS.reason);
    // 理由だけが壊れているなら、理由を落として選択肢は残す
    actions.push({
      label: labelText,
      prompt: promptText,
      ...(reasonText ? { reason: reasonText } : {}),
    });
  }
  return actions;
}

/** いま出すべき次の一手。無ければ null */
export function pendingNextActions(
  events: readonly JsonlParsedEvent[]
): PendingNextActions | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event || event.isSidechain === true) continue;
    switch (event.kind) {
      case "assistant-text":
      case "thinking":
      case "system-note":
        continue;
      case "tool-call": {
        if (event.tool !== NEXT_ACTIONS_TOOL_USE_NAME) return null;
        // 結果がまだ無い (呼び出しの途中) か、検証に落ちた呼び出しは出さない
        if (event.status !== "done" || event.isError === true) return null;
        const actions = readNextActions(event.input);
        return actions.length > 0
          ? { toolUseId: event.toolUseId, actions }
          : null;
      }
      default:
        return null;
    }
  }
  return null;
}
