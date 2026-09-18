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
 * 消費済みの記録イベント id は**呼び出しをまたいで**持ち回る。呼び出し側は
 * events が更新されるたびに全履歴を突き合わせ直すので、1 回の呼び出しの中
 * だけで 1 対 1 を守っても、次の呼び出しで同じ記録が再利用されてしまう
 * (同じコマンドを 2 回送って記録が 1 件のとき、無関係なイベントが 1 件
 * 届いただけで残りの 1 枚まで消える)。
 *
 * この id の集合に上限は設けない。1 件増えるのはカードを 1 枚消したときだけ
 * なので、大きさはセッション中にユーザーが送った組み込みコマンドの数
 * (高々数十) で頭打ちになり、セッション切替で捨てられる。逆に刈り取ると、
 * 刈った記録が再利用されて残っているカードを消す元の不具合に戻る
 * (`/clear` のリセットで events が一時的に空になる瞬間があるため、
 * 「events に無い id を捨てる」方式も取れない)。
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

export interface ReconcileLocalSlashResult {
  local: LocalSlashCommand[];
  consumedEventIds: ReadonlySet<string>;
}

export function reconcileLocalSlash(
  local: LocalSlashCommand[],
  events: JsonlParsedEvent[],
  consumedEventIds: ReadonlySet<string>
): ReconcileLocalSlashResult {
  if (local.length === 0) return { local, consumedEventIds };

  // sentAt が古い順のローカルカードと、timestamp 昇順の記録イベント。
  // timestamp の無い記録は順序も新旧も判断できないので消費に使わない
  const sortedLocal = [...local].sort((a, b) => a.sentAt - b.sentAt);
  const candidates = events
    .filter(
      (e): e is Extract<JsonlParsedEvent, { kind: "slash-command" }> =>
        e.kind === "slash-command"
    )
    // 消費済みの記録 (過去の呼び出しで既にカードを 1 枚消したもの) は除く。
    // id はパーサが振る安定した `${uuid}:slash`
    .filter(e => e.timestamp !== undefined && !consumedEventIds.has(e.id))
    .map(e => ({
      id: e.id,
      name: e.name,
      args: normalizeArgs(e.args),
      timestamp: e.timestamp as number,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);

  const removed = new Set<string>();
  const newlyConsumed = new Set<string>();

  // コマンド名と引数が一致する記録を 1 対 1 で消費する。同じコマンドを 2 回
  // 送ったら、記録が 2 件現れるまでローカルカードは 1 枚残る
  for (const c of sortedLocal) {
    const args = normalizeArgs(c.args);
    for (const ev of candidates) {
      if (newlyConsumed.has(ev.id)) continue;
      // 送信より前の記録 = 過去に実行した同じコマンド。消費に使わない
      if (ev.timestamp < c.sentAt - CLOCK_SKEW_MS) continue;
      if (ev.name !== c.name || ev.args !== args) continue;
      removed.add(c.id);
      newlyConsumed.add(ev.id);
      break;
    }
  }

  if (removed.size === 0) return { local, consumedEventIds };
  return {
    local: local.filter(c => !removed.has(c.id)),
    consumedEventIds: new Set([...consumedEventIds, ...newlyConsumed]),
  };
}
