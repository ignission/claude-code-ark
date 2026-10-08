import { useCallback, useEffect, useRef, useState } from "react";
import {
  closeFileTab,
  deserializeFileTabs,
  EMPTY_FILE_TABS,
  type FileTabsState,
  fileTabsStorageKey,
  openFileInTabs,
  selectFileTab,
  serializeFileTabs,
} from "../lib/file-tabs";

/**
 * セッションごとのファイルタブ (PC の作業エリアの「ファイル」) の状態。
 * 端末ペインのタブ列 (useViewerTabs) とは別に持つ。タブの中身は持たない。
 * worktree 単位で localStorage に永続化する。
 */
export function useFileTabs(sessions: Map<string, { worktreePath: string }>) {
  const [tabsBySession, setTabsBySession] = useState<
    Record<string, FileTabsState>
  >({});
  const [openSeqBySession, setOpenSeqBySession] = useState<
    Record<string, number>
  >({});
  const restoredRef = useRef<Set<string>>(new Set());
  // 復元を反映した後のセッション。これより前に保存すると未復元のタブを上書きで失う
  const [restoredIds, setRestoredIds] = useState<Record<string, true>>({});
  const idSeqRef = useRef(0);
  const makeId = useCallback(() => {
    idSeqRef.current += 1;
    return `ftab-${Date.now()}-${idSeqRef.current}`;
  }, []);

  // 初めて認識したセッションだけ、1 度だけ復元する
  useEffect(() => {
    const restored: Record<string, FileTabsState> = {};
    const seen: Record<string, true> = {};
    for (const [sessionId, { worktreePath }] of sessions) {
      if (restoredRef.current.has(sessionId)) continue;
      restoredRef.current.add(sessionId);
      seen[sessionId] = true;
      let raw: string | null = null;
      try {
        raw = localStorage.getItem(fileTabsStorageKey(worktreePath));
      } catch {
        // ストレージが使えなくても動く
      }
      const state = deserializeFileTabs(raw, makeId);
      if (state.tabs.length > 0) restored[sessionId] = state;
    }
    if (Object.keys(seen).length === 0) return;
    setTabsBySession(prev => {
      const next = { ...prev };
      for (const [sessionId, saved] of Object.entries(restored)) {
        const live = prev[sessionId];
        if (!live || live.tabs.length === 0) {
          next[sessionId] = saved;
          continue;
        }
        // 復元前に開かれたタブとは統合する: 保存分が先、続けて未収載の現タブ。アクティブは現状維持
        const savedPaths = new Set(saved.tabs.map(t => t.filePath));
        next[sessionId] = {
          tabs: [
            ...saved.tabs.map(
              t => live.tabs.find(l => l.filePath === t.filePath) ?? t
            ),
            ...live.tabs.filter(t => !savedPaths.has(t.filePath)),
          ],
          activeId: live.activeId,
        };
      }
      return next;
    });
    setRestoredIds(prev => ({ ...prev, ...seen }));
  }, [sessions, makeId]);

  // 状態が変わった worktree のキーへ保存する
  const savedRef = useRef<Record<string, FileTabsState>>({});
  useEffect(() => {
    for (const [sessionId, state] of Object.entries(tabsBySession)) {
      if (savedRef.current[sessionId] === state) continue;
      const session = sessions.get(sessionId);
      // セッション未認識・復元前は保存せず、揃った時に書く
      if (!session || !restoredIds[sessionId]) continue;
      savedRef.current[sessionId] = state;
      try {
        localStorage.setItem(
          fileTabsStorageKey(session.worktreePath),
          serializeFileTabs(state)
        );
      } catch {
        // 保存できなくても表示は続ける
      }
    }
  }, [tabsBySession, sessions, restoredIds]);

  const update = useCallback(
    (sessionId: string, fn: (s: FileTabsState) => FileTabsState) => {
      setTabsBySession(prev => ({
        ...prev,
        [sessionId]: fn(prev[sessionId] ?? EMPTY_FILE_TABS),
      }));
    },
    []
  );

  const getFileTabs = useCallback(
    (sessionId: string) => tabsBySession[sessionId] ?? EMPTY_FILE_TABS,
    [tabsBySession]
  );

  const openFile = useCallback(
    (
      sessionId: string,
      filePath: string,
      line?: number | null,
      endLine?: number | null
    ) => {
      const id = makeId();
      update(sessionId, s => openFileInTabs(s, filePath, id, line, endLine));
      setOpenSeqBySession(prev => ({
        ...prev,
        [sessionId]: (prev[sessionId] ?? 0) + 1,
      }));
    },
    [update, makeId]
  );

  const closeFile = useCallback(
    (sessionId: string, tabId: string) =>
      update(sessionId, s => closeFileTab(s, tabId)),
    [update]
  );

  const selectFile = useCallback(
    (sessionId: string, tabId: string) =>
      update(sessionId, s => selectFileTab(s, tabId)),
    [update]
  );

  const getOpenSeq = useCallback(
    (sessionId: string) => openSeqBySession[sessionId] ?? 0,
    [openSeqBySession]
  );

  return { getFileTabs, openFile, closeFile, selectFile, getOpenSeq };
}
