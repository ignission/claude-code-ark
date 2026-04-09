import { useCallback, useEffect, useState } from "react";
import type { ViewerTab } from "../components/TerminalPane";

/**
 * セッションごとのタブ状態管理を提供するカスタムフック。
 * Dashboard.tsx と MobileLayout.tsx で共通利用する。
 */
export function useViewerTabs(
  selectedSessionId: string | null,
  sessions: Map<string, { worktreePath: string }>,
  readFile: (sessionId: string, filePath: string) => void,
  fileContent: {
    filePath: string;
    content: string;
    mimeType: string;
    size: number;
    error?: string;
  } | null
) {
  const [sessionTabs, setSessionTabs] = useState<Record<string, ViewerTab[]>>(
    {}
  );
  const [sessionActiveTab, setSessionActiveTab] = useState<
    Record<string, number>
  >({});

  const getTabsForSession = useCallback(
    (sessionId: string): ViewerTab[] => {
      return sessionTabs[sessionId] ?? [{ type: "terminal", id: "terminal" }];
    },
    [sessionTabs]
  );

  const getActiveTabForSession = useCallback(
    (sessionId: string): number => {
      return sessionActiveTab[sessionId] ?? 0;
    },
    [sessionActiveTab]
  );

  const handleTabSelect = useCallback((sessionId: string, index: number) => {
    setSessionActiveTab(prev => ({ ...prev, [sessionId]: index }));
  }, []);

  const handleTabClose = useCallback((sessionId: string, index: number) => {
    setSessionTabs(prev => {
      const tabs = [
        ...(prev[sessionId] ?? [{ type: "terminal" as const, id: "terminal" }]),
      ];
      tabs.splice(index, 1);
      return { ...prev, [sessionId]: tabs };
    });
    setSessionActiveTab(prev => {
      const current = prev[sessionId] ?? 0;
      if (current >= index && current > 0) {
        return { ...prev, [sessionId]: current - 1 };
      }
      return prev;
    });
  }, []);

  const openFileTab = useCallback(
    (sessionId: string, filePath: string, targetLine?: number | null) => {
      let newActiveIndex: number | null = null;
      setSessionTabs(prev => {
        const tabs = [
          ...(prev[sessionId] ?? [
            { type: "terminal" as const, id: "terminal" },
          ]),
        ];
        const existing = tabs.findIndex(
          t => t.type === "file" && t.filePath === filePath
        );
        if (existing >= 0) {
          const tab = tabs[existing];
          if (tab.type === "file") {
            tabs[existing] = { ...tab, targetLine };
          }
          newActiveIndex = existing;
          return { ...prev, [sessionId]: tabs };
        }
        tabs.push({
          type: "file",
          id: `file-${Date.now()}`,
          filePath,
          content: "",
          mimeType: "text/plain",
          size: 0,
          targetLine,
        });
        newActiveIndex = tabs.length - 1;
        return { ...prev, [sessionId]: tabs };
      });
      if (newActiveIndex !== null) {
        const idx = newActiveIndex;
        setSessionActiveTab(p => ({ ...p, [sessionId]: idx }));
      }
    },
    []
  );

  // postMessageリスナー（ttyd iframe内のリンククリックを受信）
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const { type } = event.data ?? {};
      if (!selectedSessionId) return;
      const session = sessions.get(selectedSessionId);
      if (!session) return;

      if (type === "ark:open-file") {
        const { path: filePath, line } = event.data;
        if (typeof filePath !== "string" || !filePath) return;
        openFileTab(
          selectedSessionId,
          filePath,
          typeof line === "number" ? line : undefined
        );
        readFile(selectedSessionId, filePath);
      } else if (type === "ark:open-url") {
        const { url } = event.data;
        if (typeof url !== "string" || !url) return;
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
            return;
        } catch {
          return;
        }
        // ブラウザタブはシングルトンnoVNC内で開くため、新しいウィンドウで開く
        window.open(url, "_blank");
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [selectedSessionId, sessions, openFileTab, readFile]);

  // fileContent受信時にタブを更新（全セッションを検索してレースコンディション対策）
  useEffect(() => {
    if (!fileContent) return;
    setSessionTabs(prev => {
      const updated = { ...prev };
      let found = false;
      for (const sessionId of Object.keys(updated)) {
        const tabs = [...(updated[sessionId] ?? [])];
        const idx = tabs.findIndex(
          t => t.type === "file" && t.filePath === fileContent.filePath
        );
        if (idx >= 0) {
          const existingTab = tabs[idx];
          tabs[idx] = {
            type: "file",
            id:
              existingTab.type === "file"
                ? existingTab.id
                : `file-${Date.now()}`,
            filePath: fileContent.filePath,
            content: fileContent.content,
            mimeType: fileContent.mimeType,
            size: fileContent.size,
            targetLine:
              existingTab.type === "file" ? existingTab.targetLine : undefined,
            error: fileContent.error,
          };
          updated[sessionId] = tabs;
          found = true;
        }
      }
      return found ? updated : prev;
    });
  }, [fileContent]);

  return {
    getTabsForSession,
    getActiveTabForSession,
    handleTabSelect,
    handleTabClose,
    openFileTab,
  };
}
