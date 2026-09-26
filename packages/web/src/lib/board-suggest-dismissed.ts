/**
 * 閉じたボード提案の通知を覚えておく。
 *
 * サーバーは会話ビューを開き直す (再接続する) たびに直前の通知を送り直すので、
 * × で閉じた通知がまた出ないよう、閉じた通知の時刻 (at) をセッションごとに残す。
 * 送り直されるのは直前の 1 件だけなので、同じ時刻の通知だけを無視すれば足りる。
 *
 * localStorage が使えない環境 (プライベートモード等) では、タブの中だけ覚える。
 */

const KEY_PREFIX = "ark.boardSuggest.dismissedAt.";
const memory = new Map<string, number>();

export function markBoardSuggestDismissed(sessionId: string, at: number): void {
  memory.set(sessionId, at);
  try {
    window.localStorage.setItem(KEY_PREFIX + sessionId, String(at));
  } catch {
    // タブの中だけ覚えれば足りる
  }
}

export function isBoardSuggestDismissed(
  sessionId: string,
  at: number
): boolean {
  let dismissedAt = memory.get(sessionId);
  if (dismissedAt === undefined) {
    try {
      const stored = Number(
        window.localStorage.getItem(KEY_PREFIX + sessionId)
      );
      if (Number.isFinite(stored) && stored > 0) dismissedAt = stored;
    } catch {
      // 読めなければ覚えていない扱い
    }
  }
  return dismissedAt !== undefined && at === dismissedAt;
}
