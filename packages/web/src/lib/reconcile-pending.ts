/**
 * SplitChatPane の pending bubble (Claude 処理待ち表示) を JSONL の
 * user-input イベントと突き合わせて整理する純粋関数。
 *
 * 単純な text === text 比較だと、Claude Code が queue 経由で処理した際に
 * 末尾改行・空白の付与や Unicode 正規化形の差異で取りこぼすため、
 *  1. NFC + 空白圧縮 + trim で正規化して 1 対 1 マッチング
 *  2. 5 秒以上経過しても未マッチなら FIFO で時系列消費
 *  3. 10 分超は無条件除去
 * の 3 段構えで残留を防ぐ。
 *
 * React に依存しない純粋関数として切り出してあるので、本ファイルは
 * `reconcile-pending.test.ts` で単体テストする。
 */

import type { JsonlParsedEvent } from "./jsonl-event-parser";

export interface PendingMessage {
  id: string;
  text: string;
  /** 送信時刻 (Date.now() ベース、ms) */
  sentAt: number;
}

/** 10 分超は無条件で除去 (queue から消えた / そもそも届かなかったケースの保険) */
const STALE_PENDING_MS = 10 * 60_000;
/** JSONL timestamp と sentAt の clock skew 許容 */
const CLOCK_SKEW_MS = 1_000;
/** これ以上経過した未マッチ pending は FIFO フォールバックの対象にする */
const FIFO_FALLBACK_DELAY_MS = 5_000;

const normalize = (s: string): string =>
  s.trim().normalize("NFC").replace(/\s+/g, " ");

export function reconcilePending(
  pending: PendingMessage[],
  events: JsonlParsedEvent[],
  now: number
): PendingMessage[] {
  if (pending.length === 0) return pending;

  // sentAt が古い順に並べた pending と、timestamp 昇順の user-input イベント
  const sortedPending = [...pending].sort((a, b) => a.sentAt - b.sentAt);
  const candidateEvents = events
    .filter(
      (e): e is Extract<JsonlParsedEvent, { kind: "user-input" }> =>
        e.kind === "user-input"
    )
    .map(e => ({
      text: normalize(e.text),
      timestamp: e.timestamp ?? 0,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);

  const removed = new Set<string>();
  const consumed = new Set<number>();

  // 1st pass: 正規化テキストが完全一致するペアを優先で消費
  for (const p of sortedPending) {
    if (now - p.sentAt > STALE_PENDING_MS) {
      removed.add(p.id);
      continue;
    }
    const np = normalize(p.text);
    for (let i = 0; i < candidateEvents.length; i++) {
      if (consumed.has(i)) continue;
      const ev = candidateEvents[i];
      if (ev.timestamp < p.sentAt - CLOCK_SKEW_MS) continue;
      if (ev.text === np) {
        removed.add(p.id);
        consumed.add(i);
        break;
      }
    }
  }

  // 2nd pass (FIFO フォールバック): 5 秒以上経過しても未マッチの pending を、
  // 未消費の user-input イベントに古い順で割り当てる。テキストが微妙に違っても
  // Claude Code の queue 内で順序は保たれるという仮定。
  for (const p of sortedPending) {
    if (removed.has(p.id)) continue;
    if (now - p.sentAt < FIFO_FALLBACK_DELAY_MS) continue;
    for (let i = 0; i < candidateEvents.length; i++) {
      if (consumed.has(i)) continue;
      const ev = candidateEvents[i];
      if (ev.timestamp < p.sentAt - CLOCK_SKEW_MS) continue;
      removed.add(p.id);
      consumed.add(i);
      break;
    }
  }

  if (removed.size === 0) return pending;
  return pending.filter(p => !removed.has(p.id));
}
