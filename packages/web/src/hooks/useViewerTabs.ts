import { useCallback, useEffect, useRef, useState } from "react";
import type { ViewerTab } from "../components/TerminalPane";
import { setCurrentDiagramTab } from "../lib/diagram-tabs";
import { correctActiveIndexAfterClose } from "../lib/tab-close";

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
  enabled = true
) {
  const [sessionTabs, setSessionTabs] = useState<Record<string, ViewerTab[]>>(
    {}
  );
  const [sessionActiveTab, setSessionActiveTab] = useState<
    Record<string, number>
  >({});
  const sessionTabsRef = useRef(sessionTabs);
  const sessionActiveTabRef = useRef(sessionActiveTab);
  sessionTabsRef.current = sessionTabs;
  sessionActiveTabRef.current = sessionActiveTab;

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
    // openFileTab と同様、tabs 変更後の配列を使って activeTab を補正する必要が
    // あるため、両方の setState を同じ setSessionTabs updater 内に閉じ込める
    // （updater 外の closure 変数経由だと2つの setState 呼び出しの実行順序に
    // 依存してしまい、タイミングによって補正が効かない回帰があった）。
    setSessionTabs(prev => {
      const tabs = [
        ...(prev[sessionId] ?? [{ type: "terminal" as const, id: "terminal" }]),
      ];
      tabs.splice(index, 1);

      setSessionActiveTab(prevActive => {
        const current = prevActive[sessionId] ?? 0;
        // 根本修正: 補正後のインデックスがタブバーに出ない diagram タブ
        // （右ペイン専属）に着地しないようにする。diagram に着地すると
        // TerminalPane にはそれを描画する分岐が無く、左ペインが完全に
        // 空白になってしまう（例: [terminal, diagram, file] で file を
        // 閉じると素朴な current-1 補正では diagram に着地する）。補正ロジック
        // は純関数として lib/tab-close.ts に切り出してユニットテスト済み。
        const next = correctActiveIndexAfterClose(tabs, index, current);
        return next === current
          ? prevActive
          : { ...prevActive, [sessionId]: next };
      });

      return { ...prev, [sessionId]: tabs };
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

  // diagram は右ペインの「現在図」1件として設定する。左ペインの active tab は
  // id で追跡して維持し、旧 state に複数 diagram があっても同時に畳み込む。
  // live open ごとに新しい id を採用し、SplitViewPane の再表示トリガーにする。
  const diagramTabSequenceRef = useRef(0);
  const openDiagramTab = useCallback(
    (
      sessionId: string,
      worktreePath: string,
      relPath: string,
      restoredOnLoad?: boolean
    ) => {
      diagramTabSequenceRef.current += 1;
      const id = `diagram-${Date.now()}-${diagramTabSequenceRef.current}`;
      const currentTabs = sessionTabsRef.current[sessionId] ?? [
        { type: "terminal" as const, id: "terminal" },
      ];
      const currentActiveIndex = sessionActiveTabRef.current[sessionId] ?? 0;
      const { tabs, activeIndex } = setCurrentDiagramTab(
        currentTabs,
        currentActiveIndex,
        worktreePath,
        relPath,
        id,
        restoredOnLoad
      );

      sessionTabsRef.current = {
        ...sessionTabsRef.current,
        [sessionId]: tabs,
      };
      sessionActiveTabRef.current = {
        ...sessionActiveTabRef.current,
        [sessionId]: activeIndex,
      };
      setSessionTabs(prev => ({ ...prev, [sessionId]: tabs }));
      setSessionActiveTab(prev => {
        const previousActiveIndex = prev[sessionId] ?? 0;
        return activeIndex === previousActiveIndex
          ? prev
          : { ...prev, [sessionId]: activeIndex };
      });
    },
    []
  );

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
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [selectedSessionId, sessions, openFileTab, readFile, onOpenUrl, enabled]);

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
    openDiagramTab,
  };
}
