/**
 * PCの画面の上に並べる、セッションのタブ。
 *
 * タブは「開いたセッション」の並びで、左の一覧とは別に持つ。一覧で選ぶ、通知から開く、
 * 新しく起こすなど、どの経路でもセッションが選ばれたらタブに加わる。タブを閉じても
 * セッションは止めない (一覧には残り、選べばまたタブに加わる)。
 *
 * 並びは開いた順で、状態では並べ替えない。状態で並ぶのは左の一覧の役目で、タブは
 * 位置を覚えて行き来するためのものなので、勝手に動かさない。
 *
 * ここは並びの計算だけを持つ。どれを選んでいるかは Dashboard の selectedSessionId が持つ。
 */

/** 保存した値から読むときの正規化。壊れた値や型の違う値は捨てる */
export function normalizeSessionTabs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tabs: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item !== "" && !tabs.includes(item)) {
      tabs.push(item);
    }
  }
  return tabs;
}

/** 末尾に加える。既にあれば並びを変えない */
export function openSessionTab(tabs: string[], sessionId: string): string[] {
  return tabs.includes(sessionId) ? tabs : [...tabs, sessionId];
}

/**
 * 閉じる。`neighbor` は、閉じたタブを選んでいたときに代わりに選ぶタブで、
 * 右隣を先に、無ければ左隣を選ぶ (残りが無ければ null)
 */
export function closeSessionTab(
  tabs: string[],
  sessionId: string
): { tabs: string[]; neighbor: string | null } {
  const index = tabs.indexOf(sessionId);
  if (index === -1) return { tabs, neighbor: null };
  const next = tabs.filter(id => id !== sessionId);
  return { tabs: next, neighbor: next[index] ?? next[index - 1] ?? null };
}

/** 無くなったセッションのタブを落とす。変わらなければ同じ配列を返す */
export function pruneSessionTabs(
  tabs: string[],
  exists: (sessionId: string) => boolean
): string[] {
  const next = tabs.filter(exists);
  return next.length === tabs.length ? tabs : next;
}

/**
 * 再起動でセッションのIDが替わったとき、同じ位置のまま新しいIDに付け替える。
 * 新しいIDのタブが別にあれば、そちらは落とす
 */
export function replaceSessionTab(
  tabs: string[],
  oldSessionId: string,
  newSessionId: string
): string[] {
  if (!tabs.includes(oldSessionId)) return tabs;
  return tabs
    .filter(id => id !== newSessionId)
    .map(id => (id === oldSessionId ? newSessionId : id));
}
