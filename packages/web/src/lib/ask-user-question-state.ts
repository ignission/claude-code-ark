/**
 * ask-user-question-state - AskUserQuestion の回答待ちの状態 (純粋関数)。
 *
 * 質問の中身は PreToolUse hook (session:auq) から、回答済みかどうかは JSONL の
 * tool_use / tool_result から得る。tmux 画面のパースは行わない。
 * 回答は端末で行う (Ark は質問が来たら端末を開くだけで、キーは送らない)。
 */

import type { JsonlParsedEvent, ToolCallEvent } from "./jsonl-event-parser";

export interface AuqOption {
  label: string;
  description?: string;
}

export interface AuqQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: AuqOption[];
}

/** 回答待ちの AskUserQuestion */
export interface ActiveAuq {
  toolUseId: string;
  questions: AuqQuestion[];
}

/** input.questions を型ガードしつつ正規化する。形が想定外なら null */
export function parseAuqInput(
  input: Record<string, unknown>
): AuqQuestion[] | null {
  const qs = input.questions;
  if (!Array.isArray(qs) || qs.length === 0) return null;
  const out: AuqQuestion[] = [];
  for (const q of qs) {
    if (!q || typeof q !== "object") return null;
    const rec = q as Record<string, unknown>;
    if (typeof rec.question !== "string") return null;
    const optsRaw = rec.options;
    if (!Array.isArray(optsRaw)) return null;
    const options: AuqOption[] = [];
    for (const o of optsRaw) {
      if (!o || typeof o !== "object") return null;
      const oRec = o as Record<string, unknown>;
      if (typeof oRec.label !== "string") return null;
      options.push({
        label: oRec.label,
        description:
          typeof oRec.description === "string" ? oRec.description : undefined,
      });
    }
    out.push({
      question: rec.question,
      header: typeof rec.header === "string" ? rec.header : undefined,
      multiSelect: rec.multiSelect === true,
      options,
    });
  }
  return out;
}

/**
 * events 内に「at (epoch ms) 以降に解決された AskUserQuestion」があるか。
 *
 * 対話版 claude は AUQ の tool_use を「回答/拒否が確定した瞬間」に
 * tool_result とまとめて JSONL へ書く (= 質問表示中は JSONL に何も出ない)。
 * そのため回答待ちの始まりは PreToolUse hook (session:auq) が知らせ、
 * この関数は「回答待ちが終わったか」(解決イベントが書かれたか) の判定に使う。
 *
 * 比べるのは tool_result の時刻 (回答確定時刻)。回答は質問が出てから (= hook 受信の
 * 後) にしかできないので、at より後であれば足りる (同一ホストなのでクロックずれは数 ms)。
 * 余裕を持たせると、直前の質問に答えた数秒後に出た次の質問を、前の回答で終わったとみなしてしまう。
 * tool_use の timestamp はモデルが出力した時刻で、PreToolUse hook が遅いと at より
 * 数十秒前になる (実測 30 秒) ので、tool_result の時刻が無いときだけ従来の 5 秒幅で使う。
 */
export function hasResolvedAuqSince(
  events: JsonlParsedEvent[],
  at: number
): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.kind !== "tool-call") continue;
    if (ev.tool !== "AskUserQuestion") continue;
    if (ev.isSidechain === true) continue;
    const tc = ev as ToolCallEvent;
    if (tc.status !== "done") continue;
    if (tc.resultTimestamp !== undefined) {
      if (tc.resultTimestamp > at) return true;
    } else if (tc.timestamp !== undefined && tc.timestamp >= at - 5000) {
      return true;
    }
    // これより古いイベントしか無いので打ち切り
    return false;
  }
  return false;
}
