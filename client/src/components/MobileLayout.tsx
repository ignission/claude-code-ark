/**
 * MobileLayout - モバイル専用ルートコンポーネント
 *
 * 「セッション一覧」「セッション詳細」「Beaconチャット」を
 * ボトムナビゲーションと画面遷移で切り替える。
 * iframe再マウント防止のため、display:none/blockで表示を切り替える。
 */

import { useCallback, useEffect, useState } from "react";
import { MobileChatView } from "@/components/MobileChatView";
import { MobileSessionList } from "@/components/MobileSessionList";
import { MobileSessionView } from "@/components/MobileSessionView";
import type { ViewerTab } from "./TerminalPane";
import type {
  ChatMessage,
  ManagedSession,
  SpecialKey,
  Worktree,
} from "../../../shared/types";

interface MobileLayoutProps {
  sessions: Map<string, ManagedSession>;
  worktrees: Worktree[];
  repoList: string[];
  repoPath: string | null;
  onStartSession: (worktree: Worktree) => void;
  onStopSession: (sessionId: string) => void;
  onDeleteWorktree: (worktree: Worktree) => void;
  onSendMessage: (sessionId: string, message: string) => void;
  onSendKey: (sessionId: string, key: SpecialKey) => void;
  onSelectSession: (sessionId: string) => void;
  onUploadImage?: (
    sessionId: string,
    base64Data: string,
    mimeType: string
  ) => void;
  imageUploadResult?: { path: string; filename: string } | null;
  imageUploadError?: string | null;
  onClearImageUploadState?: () => void;
  onCopyBuffer?: (sessionId: string) => Promise<string | null>;
  onNewSession: () => void;
  // ファイルビューワー
  readFile: (worktreePath: string, filePath: string) => void;
  fileContent: {
    filePath: string;
    content: string;
    mimeType: string;
    size: number;
    error?: string;
  } | null;
  // Beaconチャット
  beaconMessages: ChatMessage[];
  beaconStreaming: boolean;
  beaconStreamText: string;
  onBeaconSend: (message: string) => void;
  onBeaconClear?: () => void;
}

export function MobileLayout({
  sessions,
  worktrees,
  repoList,
  repoPath: _repoPath,
  onStartSession,
  onStopSession,
  onDeleteWorktree,
  onSendMessage,
  onSendKey,
  onSelectSession,
  onUploadImage,
  imageUploadResult,
  imageUploadError,
  onClearImageUploadState,
  onCopyBuffer,
  onNewSession,
  readFile,
  fileContent,
  beaconMessages,
  beaconStreaming,
  beaconStreamText,
  onBeaconSend,
  onBeaconClear,
}: MobileLayoutProps) {
  const [activeView, setActiveView] = useState<"list" | "detail" | "beacon">(
    "list"
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );
  const [openedSessions, setOpenedSessions] = useState<Set<string>>(new Set());

  // タブ状態管理
  const [sessionTabs, setSessionTabs] = useState<Record<string, ViewerTab[]>>(
    {}
  );
  const [sessionActiveTab, setSessionActiveTab] = useState<
    Record<string, number>
  >({});

  // タブ操作ヘルパー関数
  const getTabsForSession = useCallback(
    (sessionId: string): ViewerTab[] => {
      return sessionTabs[sessionId] ?? [{ type: "terminal" }];
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
      const tabs = [...(prev[sessionId] ?? [{ type: "terminal" as const }])];
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
      setSessionTabs(prev => {
        const tabs = [...(prev[sessionId] ?? [{ type: "terminal" as const }])];
        const existing = tabs.findIndex(
          t => t.type === "file" && t.filePath === filePath
        );
        if (existing >= 0) {
          const tab = tabs[existing];
          if (tab.type === "file") {
            tabs[existing] = { ...tab, targetLine };
          }
          setSessionActiveTab(p => ({ ...p, [sessionId]: existing }));
          return { ...prev, [sessionId]: tabs };
        }
        tabs.push({
          type: "file",
          filePath,
          content: "",
          mimeType: "text/plain",
          size: 0,
          targetLine,
        });
        setSessionActiveTab(p => ({ ...p, [sessionId]: tabs.length - 1 }));
        return { ...prev, [sessionId]: tabs };
      });
    },
    []
  );

  const openBrowserTab = useCallback((sessionId: string, url: string) => {
    setSessionTabs(prev => {
      const tabs = [...(prev[sessionId] ?? [{ type: "terminal" as const }])];
      const existing = tabs.findIndex(
        t => t.type === "browser" && t.url === url
      );
      if (existing >= 0) {
        setSessionActiveTab(p => ({ ...p, [sessionId]: existing }));
        return prev;
      }
      tabs.push({ type: "browser", url });
      setSessionActiveTab(p => ({ ...p, [sessionId]: tabs.length - 1 }));
      return { ...prev, [sessionId]: tabs };
    });
  }, []);

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
        openFileTab(selectedSessionId, filePath, line);
        readFile(session.worktreePath, filePath);
      } else if (type === "ark:open-url") {
        const { url } = event.data;
        openBrowserTab(selectedSessionId, url);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [selectedSessionId, sessions, openFileTab, openBrowserTab, readFile]);

  // fileContent受信時にタブを更新
  useEffect(() => {
    if (!fileContent || !selectedSessionId) return;
    setSessionTabs(prev => {
      const tabs = [
        ...(prev[selectedSessionId] ?? [{ type: "terminal" as const }]),
      ];
      const idx = tabs.findIndex(
        t => t.type === "file" && t.filePath === fileContent.filePath
      );
      if (idx >= 0) {
        const existingTab = tabs[idx];
        tabs[idx] = {
          type: "file",
          filePath: fileContent.filePath,
          content: fileContent.content,
          mimeType: fileContent.mimeType,
          size: fileContent.size,
          targetLine:
            existingTab.type === "file" ? existingTab.targetLine : undefined,
          error: fileContent.error,
        };
        return { ...prev, [selectedSessionId]: tabs };
      }
      return prev;
    });
  }, [fileContent, selectedSessionId]);

  // セッションを選択して詳細画面に遷移
  const handleOpenSession = useCallback(
    (sessionId: string) => {
      setSelectedSessionId(sessionId);
      setActiveView("detail");
      setOpenedSessions(prev => new Set(prev).add(sessionId));
      onSelectSession(sessionId);
    },
    [onSelectSession]
  );

  // 一覧画面に戻る
  const handleBack = useCallback(() => {
    setActiveView("list");
  }, []);

  // 選択中のセッションが削除された場合、一覧画面にフォールバック
  useEffect(() => {
    if (
      activeView === "detail" &&
      selectedSessionId &&
      !sessions.has(selectedSessionId)
    ) {
      setActiveView("list");
    }
  }, [activeView, selectedSessionId, sessions]);

  // ワークツリーのIDからWorktreeを取得するヘルパー
  const getWorktreeForSession = (
    session: ManagedSession
  ): Worktree | undefined => {
    return worktrees.find(w => w.id === session.worktreeId);
  };

  // ボトムナビゲーションの表示判定（セッション詳細画面以外で表示）
  const showBottomNav = activeView !== "detail";

  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden">
      {/* 一覧画面 */}
      <div
        className={
          activeView === "list"
            ? "flex-1 flex flex-col min-h-0 pb-14"
            : "hidden"
        }
      >
        <MobileSessionList
          sessions={sessions}
          worktrees={worktrees}
          repoList={repoList}
          onOpenSession={handleOpenSession}
          onStartSession={onStartSession}
          onStopSession={onStopSession}
          onDeleteWorktree={onDeleteWorktree}
          onNewSession={onNewSession}
        />
      </div>

      {/* 詳細画面 - 一度でも開いたセッションのみ描画（iframe再マウント防止） */}
      {Array.from(sessions.entries())
        .filter(([sessionId]) => openedSessions.has(sessionId))
        .map(([sessionId, session]) => (
          <div
            key={sessionId}
            className={
              activeView === "detail" && selectedSessionId === sessionId
                ? "flex-1 flex flex-col min-h-0"
                : "hidden"
            }
          >
            <MobileSessionView
              session={session}
              worktree={getWorktreeForSession(session)}
              onBack={handleBack}
              onSendMessage={message => onSendMessage(sessionId, message)}
              onSendKey={key => onSendKey(sessionId, key)}
              onStopSession={() => onStopSession(sessionId)}
              onUploadImage={
                onUploadImage
                  ? (base64Data, mimeType) =>
                      onUploadImage(sessionId, base64Data, mimeType)
                  : undefined
              }
              imageUploadResult={imageUploadResult}
              imageUploadError={imageUploadError}
              onClearImageUploadState={onClearImageUploadState}
              onCopyBuffer={
                onCopyBuffer ? () => onCopyBuffer(sessionId) : undefined
              }
              tabs={getTabsForSession(sessionId)}
              activeTabIndex={getActiveTabForSession(sessionId)}
              onTabSelect={idx => handleTabSelect(sessionId, idx)}
              onTabClose={idx => handleTabClose(sessionId, idx)}
            />
          </div>
        ))}

      {/* Beaconチャットビュー */}
      <div
        className={
          activeView === "beacon"
            ? "flex-1 flex flex-col min-h-0 pb-14"
            : "hidden"
        }
      >
        <MobileChatView
          messages={beaconMessages}
          isStreaming={beaconStreaming}
          streamingText={beaconStreamText}
          onSendMessage={onBeaconSend}
          onClear={onBeaconClear}
        />
      </div>

      {/* ボトムナビゲーション（セッション詳細画面以外で表示） */}
      {showBottomNav && (
        <nav className="fixed bottom-0 left-0 right-0 border-t border-border bg-background z-50 flex">
          <button
            type="button"
            className={`flex-1 py-3 text-center text-sm font-medium ${
              activeView !== "beacon"
                ? "text-primary border-t-2 border-primary"
                : "text-muted-foreground"
            }`}
            onClick={() => setActiveView("list")}
          >
            セッション
          </button>
          <button
            type="button"
            className={`flex-1 py-3 text-center text-sm font-medium ${
              activeView === "beacon"
                ? "text-primary border-t-2 border-primary"
                : "text-muted-foreground"
            }`}
            onClick={() => setActiveView("beacon")}
          >
            Beacon
          </button>
        </nav>
      )}
    </div>
  );
}
