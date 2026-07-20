import { useCallback, useEffect, useState } from "react";
import type { ViewerTab } from "../components/TerminalPane";
import { publishBoardInsert } from "../lib/board-bus";
import { addOrFocusBoardTab, addOrFocusCanvasTab } from "../lib/canvas-tabs";
import { addOrFocusDiagramTab } from "../lib/diagram-tabs";

/**
 * セッションごとのタブ状態管理を提供するカスタムフック。
 * Dashboard.tsx と MobileLayout.tsx で共通利用する。
 *
 * `enabled` は postMessage リスナー（リンクタップ受信）の有効化フラグ。
 * Dashboard と MobileLayout の双方が同時にマウントされるため、片方のみで
 * 受信するように呼び出し側で排他制御する。
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
  } | null,
  onOpenUrl?: (url: string) => void,
  enabled = true,
  boardMode = false
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
      // 注意: 以前は setSessionTabs の updater 内で closure 変数 newActiveIndex を
      // 代入し、updater 外で setSessionActiveTab を呼んでいた。React の useState
      // updater は eager bailout 最適化が効くときだけ同期実行され、保留 update が
      // ある等の条件で render phase まで遅延されると closure 変数が null のまま
      // 条件分岐に落ちて active tab が切り替わらない (= タブは追加されるが遷移しない)
      // 回帰が発生する。両方の setState を同じ updater 内に閉じ込めることで
      // closure timing 依存を排除する。strict mode の二重実行でも同じ idx を
      // 書き込むだけで idempotent。
      const isHtml = /\.html?$/i.test(filePath) && filePath.startsWith("/");
      setSessionTabs(prev => {
        const tabs = [
          ...(prev[sessionId] ?? [
            { type: "terminal" as const, id: "terminal" },
          ]),
        ];
        const setActive = (idx: number) => {
          setSessionActiveTab(p => ({ ...p, [sessionId]: idx }));
        };
        // HTMLタブ: filePathで既存タブを検索
        if (isHtml) {
          const existing = tabs.findIndex(
            t => t.type === "html" && t.filePath === filePath
          );
          if (existing >= 0) {
            setActive(existing);
            return { ...prev, [sessionId]: tabs };
          }
          tabs.push({
            type: "html",
            id: `html-${Date.now()}`,
            filePath,
          });
          setActive(tabs.length - 1);
          return { ...prev, [sessionId]: tabs };
        }
        // ファイルタブ: 既存のロジック
        const existing = tabs.findIndex(
          t => t.type === "file" && t.filePath === filePath
        );
        if (existing >= 0) {
          const tab = tabs[existing];
          if (tab.type === "file") {
            tabs[existing] = { ...tab, targetLine };
          }
          setActive(existing);
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
        setActive(tabs.length - 1);
        return { ...prev, [sessionId]: tabs };
      });
    },
    []
  );

  const openCanvasTab = useCallback(
    (sessionId: string, mermaidCode: string, title?: string) => {
      setSessionTabs(prev => {
        const current = prev[sessionId] ?? [
          { type: "terminal" as const, id: "terminal" },
        ];
        const { tabs, activeIndex } = addOrFocusCanvasTab(
          current,
          mermaidCode,
          title,
          `canvas-${Date.now()}`
        );
        setSessionActiveTab(p => ({ ...p, [sessionId]: activeIndex }));
        return { ...prev, [sessionId]: tabs };
      });
    },
    []
  );

  // diagram は openBoardTab と同じく右ペイン（SplitViewPane の DiagramPane）専属になった
  // ため、ここでは sessionTabs への追加のみ行い、アクティブタブは変更しない（変更すると
  // TerminalPane の表示対象が diagram タブになり、diagram を描画しない TerminalPane では
  // 画面が空白になってしまう）。sessionTabs への追加自体は、SplitViewPane 側の
  // 「diagram タブ数が増えたら右ペインを自動表示する」effect のトリガーとして必要。
  const openDiagramTab = useCallback(
    (sessionId: string, worktreePath: string, relPath: string) => {
      setSessionTabs(prev => {
        const current = prev[sessionId] ?? [
          { type: "terminal" as const, id: "terminal" },
        ];
        const { tabs } = addOrFocusDiagramTab(
          current,
          worktreePath,
          relPath,
          `diagram-${Date.now()}`
        );
        return { ...prev, [sessionId]: tabs };
      });
    },
    []
  );

  // board はデスクトップでは TerminalPane のタブ機構ではなく右ペイン（SplitViewPane
  // の CanvasPane）専属になったため、ここでは sessionTabs への追加のみ行い、
  // アクティブタブは変更しない（変更すると TerminalPane の表示対象が board タブになり、
  // board を描画しない TerminalPane では画面が空白になってしまう）。
  // sessionTabs への追加自体は、SplitViewPane 側の「board タブ数が増えたら右ペインを
  // 自動表示する」effect のトリガーとして必要。
  const openBoardTab = useCallback((sessionId: string) => {
    setSessionTabs(prev => {
      const current = prev[sessionId] ?? [
        { type: "terminal" as const, id: "terminal" },
      ];
      const { tabs } = addOrFocusBoardTab(current);
      return { ...prev, [sessionId]: tabs };
    });
  }, []);

  // postMessageリスナー（ttyd iframe内のリンククリックを受信）
  useEffect(() => {
    if (!enabled) return;
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const { type } = event.data ?? {};

      if (type === "ark:open-url") {
        const { url } = event.data;
        if (typeof url !== "string" || !url) return;
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
            return;
        } catch {
          return;
        }
        if (onOpenUrl) {
          onOpenUrl(url);
        } else {
          // window.open ではなく <a> 要素クリックで開く
          // iframe 経由の window.open は COOP 対応サイトで2タブ開く問題がある
          const a = document.createElement("a");
          a.href = url;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.click();
        }
        return;
      }

      // 以下はセッション選択中のみ有効（ファイルビューワー）
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
        // 絶対パスのHTMLファイルはiframeで直接表示するのでreadFile不要
        if (!/\.html?$/i.test(filePath) || !filePath.startsWith("/")) {
          readFile(selectedSessionId, filePath);
        }
      }

      if (type === "ark:open-canvas") {
        const { code, title } = event.data;
        if (typeof code !== "string" || !code) return;
        const canvasTitle = typeof title === "string" ? title : undefined;
        if (boardMode) {
          // デスクトップ: ボードに要素として挿入し、ボードタブを開く
          publishBoardInsert(session.worktreePath, {
            code,
            title: canvasTitle,
          });
          openBoardTab(selectedSessionId);
        } else {
          // モバイル: 従来の図解ビューワータブ
          openCanvasTab(selectedSessionId, code, canvasTitle);
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [
    selectedSessionId,
    sessions,
    openFileTab,
    openCanvasTab,
    openBoardTab,
    readFile,
    onOpenUrl,
    enabled,
    boardMode,
  ]);

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
    openCanvasTab,
    openBoardTab,
    openDiagramTab,
  };
}
