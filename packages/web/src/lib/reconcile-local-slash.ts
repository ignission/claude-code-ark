/**
 * SplitChatPane が組み込みスラッシュコマンドの送信直後に出すローカルカードを、
 * JSONL の slash-command イベントと突き合わせて整理する純粋関数。
 *
 * 組み込みコマンド (/clear 等) は送っても user-input として記録されないため、
 * pending bubble にすると spinner が残り続ける。そこで送信時にローカルの
 * カードを足している。ところが Claude Code は `/clear` を**新しい transcript の
 * 先頭**に記録するので、記録由来のカードと並んで同じコマンドが 2 枚出る。
 * 記録が現れたら対応するローカルカードを 1 枚消して二重表示を解く。
 *
 * pending bubble の `reconcile-pending.ts` と対になるが、時間切れの除去は
 * **しない**。記録が残らないコマンド (`<local-command-stdout>` だけのもの) では
 * ローカルカードが実行の唯一の痕跡になるため、消すと会話から消えてしまう。
 *
 * React に依存しない純粋関数として切り出してあるので、本ファイルは
 * `reconcile-local-slash.test.ts` で単体テストする。
 */

import type { JsonlParsedEvent } from "./jsonl-event-parser";

export interface LocalSlashCommand {
  id: string;
  name: string;
  args?: string;
  /** 送信時刻 (Date.now() ベース、ms) */
  sentAt: number;
}

/** JSONL timestamp と sentAt の clock skew 許容 (reconcile-pending と同じ) */
const CLOCK_SKEW_MS = 1_000;

/** 記録側の空引数は `<command-args></command-args>` で空文字になるため同一視する */
const normalizeArgs = (args: string | undefined): string =>
  (args ?? "").trim().replace(/\s+/g, " ");

export function reconcileLocalSlash(
  local: LocalSlashCommand[],
  events: JsonlParsedEvent[]
): LocalSlashCommand[] {
  if (local.length === 0) return local;

  // sentAt が古い順のローカルカードと、timestamp 昇順の記録イベント。
  // timestamp の無い記録は順序も新旧も判断できないので消費に使わない
  const sortedLocal = [...local].sort((a, b) => a.sentAt - b.sentAt);
  const candidates = events
    .filter(
      (e): e is Extract<JsonlParsedEvent, { kind: "slash-command" }> =>
        e.kind === "slash-command"
    )
    .filter(e => e.timestamp !== undefined)
    .map(e => ({
      name: e.name,
      args: normalizeArgs(e.args),
      timestamp: e.timestamp as number,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);

  const removed = new Set<string>();
  const consumed = new Set<number>();

  // コマンド名と引数が一致する記録を 1 対 1 で消費する。同じコマンドを 2 回
  // 送ったら、記録が 2 件現れるまでローカルカードは 1 枚残る
  for (const c of sortedLocal) {
    const args = normalizeArgs(c.args);
    for (let i = 0; i < candidates.length; i++) {
      if (consumed.has(i)) continue;
      const ev = candidates[i];
      // 送信より前の記録 = 過去に実行した同じコマンド。消費に使わない
      if (ev.timestamp < c.sentAt - CLOCK_SKEW_MS) continue;
      if (ev.name !== c.name || ev.args !== args) continue;
      removed.add(c.id);
      consumed.add(i);
      break;
    }
  }

  if (removed.size === 0) return local;
  return local.filter(c => !removed.has(c.id));
}
