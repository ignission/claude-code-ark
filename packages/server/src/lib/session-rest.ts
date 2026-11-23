/**
 * 手動の休止。
 *
 * 一覧のセクションは状態 (BridgeSessionStatus) だけで決まるので、返答が終わって入力待ちの
 * セッションは、手を付けないと決めても「あなたの番」に残り続ける。人が「今は相手をしない」と
 * 印を付けられるよう、休止にした時刻を sessions.rested_at に持つ。印のある行は状態に関係なく
 * 「休止中」に並べる (web の session-sections.ts)。
 *
 * - ホームの行 (web の lib/home-session.ts) はセクションの外に固定で出るので、休止の対象外。
 *   行メニューにも出さない
 * - 保存はサーバーの SQLite。PCで付けた印をモバイルでも効かせ、サーバー再起動のあとにも残す
 * - 休止にした時刻より後の会話のレコード (user / assistant) が JSONL transcript に現れたら、
 *   サーバーが印を消す。自分で入力したときも、Claude が動いて確認待ちやエラーになったときも
 *   会話のレコードが増えるので、印を消し忘れて呼ばれたことに気づかない、ということが起きない
 * - transcript の mtime は外す条件に使わない。会話が無くてもメタデータの追記で動くため
 *   (理由と実測は transcript-conversation-since.ts)。mtime は読みに行くかの門にだけ使う
 * - 判定はサーバーのここ1か所で行う。クライアントは restedAt の有無だけを見る
 * - 比べる時刻 (rested_at、mtime、レコードの timestamp) はどれもサーバーの機械の時計
 * - tmux セッションを新しく起こしたとき (起動・再起動) は印を消す (upsertSession)。
 *   サーバーの再起動で既存のセッションを見つけ直す経路は upsert を通らないので、印は残る
 */

import type { ManagedSession } from "@ark/shared";

/** transcript の mtime が休止にした時刻より後なら、会話が動いたかを読みに行く価値がある */
export function mayHaveMovedSince(
  restedAt: number,
  lastUpdatedAt: number | null
): boolean {
  return lastUpdatedAt !== null && lastUpdatedAt > restedAt;
}

export interface SessionRestDeps {
  getRestedSessions: () => Map<string, number>;
  clearRestedAtIfMatches: (sessionId: string, restedAt: number) => boolean;
  updateRestedAt: (sessionId: string, restedAt: number | null) => boolean;
  getSession: (sessionId: string) => ManagedSession | undefined;
  /** since より後に会話のレコードが現れたか (transcript-conversation-since.ts) */
  hasConversationSince: (sessionId: string, since: number) => boolean;
  /** 更新したセッションを全クライアントへ配る (session:updated) */
  emitUpdated: (session: ManagedSession) => void;
  now?: () => number;
}

/**
 * previews を集めたあとに呼び、会話が動いた休止中のセッションを休止から外す。
 * previews はクライアントごとに毎秒集めるので何度も呼ばれるが、消すのは
 * rested_at が読んだ値のままのときだけなので、配るのは1回になる
 */
export function wakeRestedSessions(
  previews: ReadonlyArray<{ sessionId: string; lastUpdatedAt: number | null }>,
  deps: SessionRestDeps
): void {
  const rested = deps.getRestedSessions();
  if (rested.size === 0) return;
  for (const { sessionId, lastUpdatedAt } of previews) {
    const restedAt = rested.get(sessionId);
    if (restedAt === undefined) continue;
    if (!mayHaveMovedSince(restedAt, lastUpdatedAt)) continue;
    if (!deps.hasConversationSince(sessionId, restedAt)) continue;
    if (!deps.clearRestedAtIfMatches(sessionId, restedAt)) continue;
    const session = deps.getSession(sessionId);
    if (session) deps.emitUpdated(session);
  }
}

/** session:rest の処理。payload は外部入力なので形を確かめてから使う */
export function handleSessionRest(
  payload: unknown,
  deps: SessionRestDeps
): void {
  if (typeof payload !== "object" || payload === null) return;
  const { sessionId, rested } = payload as Record<string, unknown>;
  if (typeof sessionId !== "string" || typeof rested !== "boolean") return;
  const now = deps.now ?? Date.now;
  if (!deps.updateRestedAt(sessionId, rested ? now() : null)) return;
  const session = deps.getSession(sessionId);
  if (session) deps.emitUpdated(session);
}
