/**
 * voice-turn-signals - JSONL のイベント列から、音声モードに入った後の「ターンの終わり」を拾う。
 *
 * ターンの終わり = `stop_reason: "end_turn"` の返答本文 (`endTurn`)。subagent の発言と、
 * ツール実行の合間の独り言 (`stop_reason: "tool_use"`) は読まない。
 *
 * 「入った後」は時刻ではなく配列上の位置で決める。JSONL の timestamp は単調でなく、
 * 実データで end_turn の返答が先行する tool_result より古い時刻を持っていたため。
 * - 入った時点で配列にあるidをすべて既読にする
 * - 既読idのうち配列で最も後ろにあるものより後ろにある未読idを新規とする
 *   (過去履歴の追加読み込みで先頭に足された分は新規にならない)
 * - 既読idが1つも無いとき (/clear の空snapshotの後) は未読idをすべて新規とする
 * - 新規の中にターンの終わりが複数あれば、最後のターンだけを返す (長い切断からの復帰など)
 *
 * 仕様: docs/superpowers/specs/2026-09-19-voice-mode-design.md の5章
 */

import type { JsonlParsedEvent } from "./jsonl-event-parser";

export interface TurnEndCursor {
  readonly seen: ReadonlySet<string>;
}

export interface TurnEnd {
  /** 読み上げる返答のイベントid (最後の返答が複数の本文に分かれていれば複数) */
  ids: string[];
  text: string;
}

type AssistantText = Extract<JsonlParsedEvent, { kind: "assistant-text" }>;

export function createTurnEndCursor(
  events: readonly JsonlParsedEvent[]
): TurnEndCursor {
  return { seen: new Set(events.map(event => event.id)) };
}

function isSpeakableTurnEnd(event: JsonlParsedEvent): event is AssistantText {
  return (
    event.kind === "assistant-text" &&
    event.endTurn === true &&
    event.isSidechain !== true &&
    event.text.trim() !== ""
  );
}

/** ここより前の返答は別のターン。最後の返答をつなぐときに越えない */
function isTurnBoundary(event: JsonlParsedEvent): boolean {
  if (event.isSidechain === true) return false;
  if (event.kind === "assistant-text") return event.endTurn !== true;
  return (
    event.kind === "user-input" ||
    event.kind === "slash-command" ||
    event.kind === "tool-call" ||
    event.kind === "compact-marker"
  );
}

export function scanTurnEnds(
  cursor: TurnEndCursor,
  events: readonly JsonlParsedEvent[]
): { cursor: TurnEndCursor; turnEnd: TurnEnd | null } {
  let lastSeen = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (cursor.seen.has(events[i].id)) {
      lastSeen = i;
      break;
    }
  }
  const fresh = events
    .slice(lastSeen + 1)
    .filter(event => !cursor.seen.has(event.id));
  if (fresh.length === 0) return { cursor, turnEnd: null };

  const seen = new Set(cursor.seen);
  for (const event of events) seen.add(event.id);
  const next: TurnEndCursor = { seen };

  let end = -1;
  for (let i = fresh.length - 1; i >= 0; i--) {
    if (isSpeakableTurnEnd(fresh[i])) {
      end = i;
      break;
    }
  }
  if (end < 0) return { cursor: next, turnEnd: null };

  const picked: AssistantText[] = [];
  for (let i = end; i >= 0; i--) {
    const event = fresh[i];
    if (isSpeakableTurnEnd(event)) picked.unshift(event);
    else if (isTurnBoundary(event)) break;
  }
  return {
    cursor: next,
    turnEnd: {
      ids: picked.map(event => event.id),
      text: picked.map(event => event.text).join("\n\n"),
    },
  };
}
