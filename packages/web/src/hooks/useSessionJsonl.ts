/**
 * useSessionJsonl - Claude Code の JSONL 履歴を購読し、構造化イベント列を返す。
 *
 * 差分パース方針: line イベントが届いたら 1 行だけパースして既存 events に
 * 追加マージする。snapshot は一括パース。これにより毎回フルパースする
 * CPU 消費を回避する (大規模履歴のセッションで顕著)。
 *
 * 状態管理:
 *   - events: パース済みイベント配列 (描画用、安定参照を保つ)
 *   - toolMapRef: tool_use → tool_result マージ用の Map (state ではなく ref に置く。
 *     setState を経由させると差分マージが不必要に再描画を起こす)
 */

import type { ClientToServerEvents, ServerToClientEvents } from "@ark/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import {
  type JsonlParsedEvent,
  mergeJsonlLine,
  parseJsonlEvents,
} from "@/lib/jsonl-event-parser";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const INITIAL_LIMIT = 100;
const LOAD_MORE_STEP = 100;

export interface UseSessionJsonlResult {
  events: JsonlParsedEvent[];
  isSubscribed: boolean;
  /** Snapshot 受信済みかどうか (true 以前はまだ過去履歴を読み込み中) */
  hasSnapshot: boolean;
  /** 過去履歴をさらに読み込む。サーバが limit 付きで snapshot を再送する */
  loadMore: () => void;
  /** 現在の取得 limit 行数 (UI 上の「さらに読み込む」ボタン disable 判定用) */
  loadedLimit: number;
  /** 取得した snapshot の行数が limit と等しい (まだ読める可能性が高い) か */
  hasMore: boolean;
}

export function useSessionJsonl(
  socket: TypedSocket | null,
  sessionId: string | null
): UseSessionJsonlResult {
  const [events, setEvents] = useState<JsonlParsedEvent[]>([]);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const [loadedLimit, setLoadedLimit] = useState(INITIAL_LIMIT);
  const [hasMore, setHasMore] = useState(true);
  // tool_use → tool_result のマッピング。再描画を発生させたくないので ref で保持
  const toolMapRef = useRef(
    new Map<string, Extract<JsonlParsedEvent, { kind: "tool-call" }>>()
  );
  // loadMore で次回 emit する limit を ref で保持 (useEffect 内 callback からアクセス)
  const limitRef = useRef(INITIAL_LIMIT);

  useEffect(() => {
    if (!socket || !sessionId) {
      setEvents([]);
      setIsSubscribed(false);
      setHasSnapshot(false);
      setLoadedLimit(INITIAL_LIMIT);
      setHasMore(true);
      limitRef.current = INITIAL_LIMIT;
      toolMapRef.current = new Map();
      return;
    }
    setHasSnapshot(false);
    setEvents([]);
    setLoadedLimit(INITIAL_LIMIT);
    setHasMore(true);
    limitRef.current = INITIAL_LIMIT;
    toolMapRef.current = new Map();

    const handleSnapshot = (data: { sessionId: string; lines: string[] }) => {
      if (data.sessionId !== sessionId) return;
      const fresh = parseJsonlEvents(data.lines);
      const map = new Map<
        string,
        Extract<JsonlParsedEvent, { kind: "tool-call" }>
      >();
      for (const ev of fresh) {
        if (ev.kind === "tool-call") map.set(ev.toolUseId, ev);
      }
      toolMapRef.current = map;
      setEvents(fresh);
      setHasSnapshot(true);
      // 受信行数 < 要求 limit ならファイル先頭まで到達したと判断
      setHasMore(data.lines.length >= limitRef.current);
    };

    const handleLine = (data: { sessionId: string; line: string }) => {
      if (data.sessionId !== sessionId) return;
      setEvents(prev => mergeJsonlLine(prev, toolMapRef.current, data.line));
    };

    socket.on("session:jsonl-snapshot", handleSnapshot);
    socket.on("session:jsonl-line", handleLine);
    socket.emit("session:jsonl-subscribe", sessionId);
    setIsSubscribed(true);

    return () => {
      socket.off("session:jsonl-snapshot", handleSnapshot);
      socket.off("session:jsonl-line", handleLine);
      socket.emit("session:jsonl-unsubscribe", sessionId);
      setIsSubscribed(false);
    };
  }, [socket, sessionId]);

  const loadMore = useCallback(() => {
    if (!socket || !sessionId) return;
    const next = limitRef.current + LOAD_MORE_STEP;
    limitRef.current = next;
    setLoadedLimit(next);
    socket.emit("session:jsonl-load-more", { sessionId, limit: next });
  }, [socket, sessionId]);

  return { events, isSubscribed, hasSnapshot, loadMore, loadedLimit, hasMore };
}
