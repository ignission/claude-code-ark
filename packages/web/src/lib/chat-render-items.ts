/**
 * chat-render-items - 会話ビューの描画単位をJSONLイベント列から組み立てる純粋関数。
 *
 * 1. groupSidechain: 連続するsubagent (isSidechain) イベントを1つのまとまりに畳む
 * 2. groupToolCalls: sidechainの外で連続するツール呼び出しを「作業N件」の
 *    1つのまとまりに畳む
 *
 * ツール呼び出しのまとまりを閉じるもの (境界):
 *   user-input / assistant-text / slash-command / compact-marker /
 *   sidechainのまとまり / AskUserQuestionのtool-call
 * 表示されないthinkingは境界にしない (まとまりの途中にあれば出力から落とす)。
 */

import type { JsonlParsedEvent, ToolCallEvent } from "./jsonl-event-parser";

export type { ToolCallEvent } from "./jsonl-event-parser";

export type SidechainGroupedItem =
  | { kind: "event"; event: JsonlParsedEvent }
  | { kind: "sidechain"; id: string; events: JsonlParsedEvent[] };

export type ChatRenderItem =
  | SidechainGroupedItem
  | {
      kind: "tool-group";
      /** 先頭のtool-callのidから作る。tool_resultが届いても変わらない */
      id: string;
      calls: ToolCallEvent[];
      /** statusがrunningのうち配列順で最後の1件。無ければnull */
      latestRunning: ToolCallEvent | null;
    };

/** 連続するsidechainイベントを1グループに畳む */
export function groupSidechain(
  events: JsonlParsedEvent[]
): SidechainGroupedItem[] {
  const out: SidechainGroupedItem[] = [];
  for (const ev of events) {
    if (ev.isSidechain === true) {
      const last = out[out.length - 1];
      if (last && last.kind === "sidechain") {
        last.events.push(ev);
      } else {
        out.push({ kind: "sidechain", id: `sc:${ev.id}`, events: [ev] });
      }
    } else {
      out.push({ kind: "event", event: ev });
    }
  }
  return out;
}

/** 折りたたみの対象か。AskUserQuestionは回答済みカードとして独立して出す */
function isCollapsibleToolCall(
  event: JsonlParsedEvent
): event is ToolCallEvent {
  return event.kind === "tool-call" && event.tool !== "AskUserQuestion";
}

/**
 * runningのうち配列順で最後の1件。並列の呼び出しは結果の届いたものから
 * doneになるので、最後の1件のstatusだけでは実行中かを判定しない
 */
function findLatestRunning(calls: ToolCallEvent[]): ToolCallEvent | null {
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i].status === "running") return calls[i];
  }
  return null;
}

function flushToolGroup(out: ChatRenderItem[], calls: ToolCallEvent[]): void {
  if (calls.length === 0) return;
  out.push({
    kind: "tool-group",
    id: `tg:${calls[0].id}`,
    calls,
    latestRunning: findLatestRunning(calls),
  });
}

/** sidechainの外で連続するtool-callを「作業N件」のまとまりに畳む */
export function groupToolCalls(
  items: SidechainGroupedItem[]
): ChatRenderItem[] {
  const out: ChatRenderItem[] = [];
  let calls: ToolCallEvent[] = [];
  for (const item of items) {
    if (item.kind === "event") {
      const ev = item.event;
      if (isCollapsibleToolCall(ev)) {
        calls.push(ev);
        continue;
      }
      // 表示されないthinkingはまとまりを閉じない
      if (ev.kind === "thinking" && calls.length > 0) continue;
    }
    flushToolGroup(out, calls);
    calls = [];
    out.push(item);
  }
  flushToolGroup(out, calls);
  return out;
}
