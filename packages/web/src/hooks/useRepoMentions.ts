/**
 * useRepoMentions - チャット入力の `@` 補完に出すリポジトリの候補をサーバーから取る。
 *
 * 候補は入力欄の補完と、会話の吹き出しでパスを短い名前へ戻すのに使う (lib/repo-mention.ts)。
 *
 * - サーバーは呼ばれるたびに走査先を走査する (手元で 1 秒弱)。結果は socket ごとに 1 つ持ち、
 *   会話の画面のあいだで使い回す。会話を開いただけでは取り直さない
 * - `refresh` は `@` を打ったときに呼ぶ。結果が古ければ取り直す
 *   (Ark を開いたあとに clone したリポジトリを出すため)
 * - 応答が来ないまま待ち続けない。サーバーの再起動で応答が失われても、次の `@` で取り直せる
 */

import type { ClientToServerEvents, ServerToClientEvents } from "@ark/shared";
import { useCallback, useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import {
  buildRepoMentionCandidates,
  type RepoMentionCandidate,
} from "@/lib/repo-mention";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** `@` を打ったとき、これより新しい結果があれば取り直さない */
export const REPO_MENTION_FRESH_MS = 30_000;
/** 応答をこれ以上待たない */
export const REPO_MENTION_TIMEOUT_MS = 10_000;

interface CacheEntry {
  candidates: RepoMentionCandidate[];
  /** 最後に取れた時刻。まだ取れていなければ 0 */
  fetchedAt: number;
  inFlight: Promise<RepoMentionCandidate[]> | null;
  /** 要求ごとの番号。あとから別の要求を出していたら、古い要求の応答は書き込まない */
  requestSeq: number;
}

const cache = new WeakMap<object, CacheEntry>();

/**
 * 候補を返す。まだ取れていないか、`maxAgeMs` より古ければサーバーに聞く。
 * 取れなかったとき (エラー、時間切れ) は前の結果を返す。補完が出ないだけで、送信は妨げない
 */
export function loadRepoMentionCandidates(
  socket: TypedSocket,
  maxAgeMs: number
): Promise<RepoMentionCandidate[]> {
  let entry = cache.get(socket);
  if (!entry) {
    entry = { candidates: [], fetchedAt: 0, inFlight: null, requestSeq: 0 };
    cache.set(socket, entry);
  }
  const current = entry;
  if (current.inFlight) return current.inFlight;
  if (current.fetchedAt > 0 && Date.now() - current.fetchedAt < maxAgeMs) {
    return Promise.resolve(current.candidates);
  }
  // ack は emit の中で同期に呼ばれることもあるので、待ちの片付けは emit より前に用意する
  let finish: (candidates: RepoMentionCandidate[]) => void = () => {};
  const request = new Promise<RepoMentionCandidate[]>(resolve => {
    finish = resolve;
  });
  current.inFlight = request;
  const settle = () => {
    clearTimeout(timer);
    if (current.inFlight === request) current.inFlight = null;
    finish(current.candidates);
  };
  const timer = setTimeout(settle, REPO_MENTION_TIMEOUT_MS);
  current.requestSeq += 1;
  const seq = current.requestSeq;
  socket.emit("repo:mention-list", response => {
    // 時間切れのあとに届いた応答も、あとから別の要求を出していなければ結果として使う
    if (!response.error && seq === current.requestSeq) {
      current.candidates = buildRepoMentionCandidates(response.repos ?? []);
      current.fetchedAt = Date.now();
    }
    settle();
  });
  return request;
}

export interface UseRepoMentionsResult {
  candidates: RepoMentionCandidate[];
  refresh: () => void;
}

export function useRepoMentions(
  socket: TypedSocket | null,
  enabled: boolean
): UseRepoMentionsResult {
  const [candidates, setCandidates] = useState<RepoMentionCandidate[]>(
    () => (socket && cache.get(socket)?.candidates) || []
  );
  // 0 は会話を開いたときの読み込み (一度取れていれば取り直さない)。refresh のたびに増える
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey(k => k + 1), []);

  useEffect(() => {
    if (!socket || !enabled) return;
    let cancelled = false;
    loadRepoMentionCandidates(
      socket,
      refreshKey === 0 ? Number.POSITIVE_INFINITY : REPO_MENTION_FRESH_MS
    ).then(next => {
      if (!cancelled) setCandidates(next);
    });
    return () => {
      cancelled = true;
    };
  }, [socket, enabled, refreshKey]);

  return { candidates, refresh };
}
