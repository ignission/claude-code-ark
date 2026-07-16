/**
 * 「キャンバスで開く」→ ボードへの mermaid 挿入依頼を運ぶ軽量バス。
 *
 * CanvasPane（購読側）はタブが開かれて初めてマウントされるため、
 * 未購読時の依頼は worktree ごとのキューに滞留させ、購読開始時に flush する。
 */

export interface BoardInsert {
  code: string;
  title?: string;
}

const queues = new Map<string, BoardInsert[]>();
const handlers = new Map<string, (insert: BoardInsert) => void>();

export function publishBoardInsert(
  worktreePath: string,
  insert: BoardInsert
): void {
  const handler = handlers.get(worktreePath);
  if (handler) {
    handler(insert);
    return;
  }
  const queue = queues.get(worktreePath) ?? [];
  queue.push(insert);
  queues.set(worktreePath, queue);
}

export function subscribeBoardInserts(
  worktreePath: string,
  handler: (insert: BoardInsert) => void
): () => void {
  handlers.set(worktreePath, handler);
  const queued = queues.get(worktreePath);
  if (queued) {
    queues.delete(worktreePath);
    for (const insert of queued) handler(insert);
  }
  return () => {
    if (handlers.get(worktreePath) === handler) {
      handlers.delete(worktreePath);
    }
  };
}
