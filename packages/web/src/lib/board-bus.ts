/**
 * 「キャンバスで開く」→ ボードへの mermaid 挿入依頼を運ぶ軽量バス。
 *
 * CanvasPane（購読側）はタブが開かれて初めてマウントされるため、
 * 未購読時の依頼は worktree ごとのキューに滞留させ、購読開始時に flush する。
 *
 * handler は async（Excalidraw への挿入は mermaid 変換を await するため）だが、
 * 複数件が短時間に publish されると並行実行され、Excalidraw の scene 更新が
 * 後勝ちで消える可能性がある。worktree ごとに実行を直列化し、前の handler
 * 呼び出しが完了してから次を開始する（同期 handler はこれまで通り即時実行）。
 */

export interface BoardInsert {
  code: string;
  title?: string;
}

type BoardInsertHandler = (insert: BoardInsert) => void | Promise<void>;

interface PendingCall {
  handler: BoardInsertHandler;
  insert: BoardInsert;
}

const queues = new Map<string, BoardInsert[]>();
const handlers = new Map<string, BoardInsertHandler>();
/** 実行中（前の handler の Promise 待ち）の worktree 集合 */
const busy = new Set<string>();
/** busy 中に来た呼び出しの待ち行列（worktree ごと） */
const pending = new Map<string, PendingCall[]>();

/** busy な worktree の次のキュー項目を処理する。無ければ busy を解除する */
function runNext(worktreePath: string): void {
  const queue = pending.get(worktreePath);
  const next = queue?.shift();
  if (!next) {
    busy.delete(worktreePath);
    return;
  }
  invoke(worktreePath, next.handler, next.insert);
}

/** handler を呼び出す。Promise を返す場合は完了を待ってから次のキュー項目を処理する */
function invoke(
  worktreePath: string,
  handler: BoardInsertHandler,
  insert: BoardInsert
): void {
  busy.add(worktreePath);
  let result: void | Promise<void>;
  try {
    result = handler(insert);
  } catch (error) {
    console.error("board-bus handler failed:", error);
    runNext(worktreePath);
    return;
  }
  if (result && typeof result.then === "function") {
    result
      .catch(error => {
        console.error("board-bus handler failed:", error);
      })
      .finally(() => {
        runNext(worktreePath);
      });
  } else {
    // 同期 handler は呼び出し時点で完了済み。次のキュー項目があれば続けて処理する
    // (JS はシングルスレッドのため同一 tick 内で新規キューが積まれることは無いが、
    // 将来 handler が変わっても安全なよう一般化しておく)
    runNext(worktreePath);
  }
}

/**
 * handler 呼び出しを worktree ごとに直列化する。
 * 実行中でなければ即座に（同期 handler なら同期的に）呼び出し、
 * 実行中ならキューに積んで前の呼び出し完了後に処理する。
 */
function scheduleHandlerCall(
  worktreePath: string,
  handler: BoardInsertHandler,
  insert: BoardInsert
): void {
  if (busy.has(worktreePath)) {
    const queue = pending.get(worktreePath) ?? [];
    queue.push({ handler, insert });
    pending.set(worktreePath, queue);
    return;
  }
  invoke(worktreePath, handler, insert);
}

export function publishBoardInsert(
  worktreePath: string,
  insert: BoardInsert
): void {
  const handler = handlers.get(worktreePath);
  if (handler) {
    scheduleHandlerCall(worktreePath, handler, insert);
    return;
  }
  const queue = queues.get(worktreePath) ?? [];
  queue.push(insert);
  queues.set(worktreePath, queue);
}

export function subscribeBoardInserts(
  worktreePath: string,
  handler: BoardInsertHandler
): () => void {
  handlers.set(worktreePath, handler);
  const queued = queues.get(worktreePath);
  if (queued) {
    queues.delete(worktreePath);
    for (const insert of queued) {
      scheduleHandlerCall(worktreePath, handler, insert);
    }
  }
  return () => {
    if (handlers.get(worktreePath) === handler) {
      handlers.delete(worktreePath);
    }
  };
}
