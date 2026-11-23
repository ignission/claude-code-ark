/**
 * 現行の会話 (JSONL transcript) で、ある時刻より後に会話が動いたかを見る。
 * 手動の休止を外す判定 (session-rest.ts) に使う。
 *
 * ## なぜ mtime では足りないのか
 *
 * JSONL の mtime は会話が無くても動く。実データ (2026-11-23) では、最後の返答の
 * 3分後に mtime だけが進んだファイルがあり、末尾には `ai-title` / `mode` /
 * `permission-mode` / `pr-link` のような会話でないレコードが書き足されていた。
 * mtime で比べると、休止にしたセッションが会話の無いまま外れる。
 *
 * そこで、会話のレコード (transcript-conversation.ts の isConversationRecord) の
 * `timestamp` を見る。mtime は「読む価値があるか」の門にだけ使う (呼び出し側)。
 *
 * ## 読み方と倒れ方
 *
 * 末尾 TAIL_LIMIT_BYTES だけ読み、後ろから 1 行ずつ見る。JSONL は追記だけなので、
 * 後ろほど新しい。
 *
 * - 会話のレコードで timestamp が since より後 → 動いた
 * - timestamp が since 以前のレコード (種類を問わない) に着いた → それより前は
 *   もっと古いので、動いていない
 * - どちらにも着かずに読んだ範囲を使い切った:
 *   - ファイル全体を読んでいた → 動いていない
 *   - 切り詰めていた → **動いたとみなす**。範囲を埋めるほど大きな行はほぼ
 *     ツールの結果で、会話が動いている。休止のまま呼ばれて気づかないよりは、
 *     外れて「あなたの番」に戻る方を選ぶ
 * - 失敗 (ファイル無し・権限など) は「動いていない」。polling を落とさない
 *
 * 1 秒ごとの polling に載るので、大きさと mtime と since が同じなら読み直さない。
 */

import fs from "node:fs";
import path from "node:path";
import { rememberFifoEntry } from "./bounded-fifo-map.js";
import {
  encodeProjectDir,
  pickLatestJsonl,
  projectsDirFor,
} from "./claude-projects.js";
import { isConversationRecord } from "./transcript-conversation.js";

/** 末尾から読む上限 */
const TAIL_LIMIT_BYTES = 256 * 1024;

const MEMO_LIMIT = 128;

/** 末尾だけ読んだ結果 */
export interface TranscriptTail {
  text: string;
  /** 上限に達して切り詰めた (= この前にまだ行がある) */
  truncated: boolean;
}

/** fs を差し替えてテストするための入出力 */
export interface TranscriptSinceIo {
  pickLatestJsonl(dir: string, expectedCwd: string): string | null;
  statFile(file: string): { size: number; mtimeMs: number };
  readTail(file: string, maxBytes: number): TranscriptTail;
}

const defaultIo: TranscriptSinceIo = {
  pickLatestJsonl,
  statFile: file => {
    const stat = fs.statSync(file);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  },
  readTail: (file, maxBytes) => {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      const buffer = Buffer.alloc(size - start);
      const read = fs.readSync(fd, buffer, 0, buffer.length, start);
      return {
        text: buffer.toString("utf-8", 0, read),
        truncated: start > 0,
      };
    } finally {
      fs.closeSync(fd);
    }
  },
};

interface MemoEntry {
  size: number;
  mtimeMs: number;
  since: number;
  moved: boolean;
}

const memo = new Map<string, MemoEntry>();

/** テスト用: メモを破棄する */
export function clearTranscriptSinceMemo(): void {
  memo.clear();
}

/**
 * worktree + configDir の現行 JSONL で、since (epochミリ秒) より後に会話が動いたか。
 * 現行ファイルの選び方は readTranscriptLastUpdatedAt と同じ
 */
export function hasConversationSince(
  worktreePath: string,
  configDir: string | null | undefined,
  since: number,
  io: TranscriptSinceIo = defaultIo
): boolean {
  if (!worktreePath) return false;
  try {
    const dir = path.join(
      projectsDirFor(configDir),
      encodeProjectDir(worktreePath)
    );
    const file = io.pickLatestJsonl(dir, worktreePath);
    if (!file) return false;
    const { size, mtimeMs } = io.statFile(file);
    const cached = memo.get(file);
    if (
      cached &&
      cached.size === size &&
      cached.mtimeMs === mtimeMs &&
      cached.since === since
    ) {
      return cached.moved;
    }
    const moved = classifyTail(io.readTail(file, TAIL_LIMIT_BYTES), since);
    rememberFifoEntry(memo, file, { size, mtimeMs, since, moved }, MEMO_LIMIT);
    return moved;
  } catch {
    return false;
  }
}

function classifyTail(tail: TranscriptTail, since: number): boolean {
  const lines = tail.text.split("\n");
  // 切り詰めた場合、先頭は行の途中かもしれないので捨てる
  if (tail.truncated) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      // 書き込み途中の行など
      continue;
    }
    const at = timestampOf(record);
    if (at === null) continue;
    if (at <= since) return false;
    if (isConversationRecord(record)) return true;
  }
  return tail.truncated;
}

function timestampOf(record: unknown): number | null {
  if (typeof record !== "object" || record === null) return null;
  const value = (record as { timestamp?: unknown }).timestamp;
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
