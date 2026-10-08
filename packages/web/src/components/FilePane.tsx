import type { ClientToServerEvents, ServerToClientEvents } from "@ark/shared";
import { PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Socket } from "socket.io-client";
import { createFileApi } from "@/lib/file-api";
import type { FileTabsState } from "@/lib/file-tabs";
import { cn } from "@/lib/utils";
import { FileEditor } from "./FileEditor";
import { FileTree } from "./FileTree";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface FilePaneProps {
  socket: TypedSocket | null;
  sessionId: string;
  worktreePath: string;
  state: FileTabsState;
  onOpenFile: (filePath: string) => void;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  /**
   * このペインが実際に見えているか (中ペインが開いていて、セッションが選択中)。
   * 閉じている間も、非選択のセッションでもマウントされたままなので、
   * ファイルの監視は見えているタブ 1 枚だけに絞る
   */
  isActive: boolean;
}

const TREE_COLLAPSED_KEY = "ark-file-tree-collapsed";

function loadTreeCollapsed(): boolean {
  try {
    return localStorage.getItem(TREE_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * 中ペイン。左にファイルツリー、右にタブバーと本体を置く。
 * タブの並びは親 (useFileTabs) が持ち、ここは未保存の印だけを持つ
 */
export function FilePane({
  socket,
  sessionId,
  worktreePath,
  state,
  onOpenFile,
  onSelect,
  onClose,
  isActive: paneActive,
}: FilePaneProps) {
  // FileTree と FileEditor は api の同一性で読み直すので、作り直しを最小にする
  const api = useMemo(
    () => (socket ? createFileApi(socket, sessionId) : null),
    [socket, sessionId]
  );
  const [treeCollapsed, setTreeCollapsed] = useState(loadTreeCollapsed);
  const [dirtyIds, setDirtyIds] = useState<ReadonlySet<string>>(new Set());
  const [refreshSeq, setRefreshSeq] = useState(0);

  const toggleTree = () => {
    setTreeCollapsed(prev => {
      const next = !prev;
      try {
        localStorage.setItem(TREE_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // 保存できなくても動作には影響しない
      }
      return next;
    });
  };

  const handleDirtyChange = useCallback((tabId: string, dirty: boolean) => {
    setDirtyIds(prev => {
      if (prev.has(tabId) === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(tabId);
      else next.delete(tabId);
      return next;
    });
  }, []);

  const handleSaved = useCallback(() => setRefreshSeq(seq => seq + 1), []);

  const handleClose = (tabId: string) => {
    if (
      dirtyIds.has(tabId) &&
      !window.confirm("保存していない変更があります。閉じますか？")
    ) {
      return;
    }
    handleDirtyChange(tabId, false);
    onClose(tabId);
  };

  // 未保存があるままページを離れるときに確認する。FilePane は 1 度見せたら
  // 閉じても非選択でもマウントされたままなので、全セッションの未保存を拾える
  const hasDirty = dirtyIds.size > 0;
  useEffect(() => {
    if (!hasDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // 古いブラウザは returnValue を見る
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasDirty]);

  const activeTab = state.tabs.find(t => t.id === state.activeId) ?? null;
  // ツリーが指せるのは worktree 内の相対パスだけ (/tmp や html タブは対象外)
  const activeFilePath =
    activeTab && !activeTab.filePath.startsWith("/")
      ? activeTab.filePath
      : null;

  return (
    <div className="flex h-full min-h-0 bg-background">
      {api && (
        <div
          className={cn(
            "h-full w-[220px] shrink-0 border-border border-r",
            treeCollapsed && "hidden"
          )}
        >
          <FileTree
            api={api}
            worktreePath={worktreePath}
            activeFilePath={activeFilePath}
            onOpenFile={onOpenFile}
            refreshSeq={refreshSeq}
          />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[31px] shrink-0 items-stretch border-border border-b bg-muted/30">
          <button
            type="button"
            aria-label={
              treeCollapsed
                ? "ファイルツリーを開く"
                : "ファイルツリーを折りたたむ"
            }
            title={
              treeCollapsed
                ? "ファイルツリーを開く"
                : "ファイルツリーを折りたたむ"
            }
            aria-expanded={!treeCollapsed}
            onClick={toggleTree}
            className="inline-flex w-8 shrink-0 items-center justify-center border-border border-r text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {treeCollapsed ? (
              <PanelLeftOpen className="size-3.5" />
            ) : (
              <PanelLeftClose className="size-3.5" />
            )}
          </button>
          <div
            role="tablist"
            aria-label="開いているファイル"
            className="flex min-w-0 flex-1 items-stretch overflow-x-auto"
          >
            {state.tabs.map(tab => {
              const isActive = tab.id === state.activeId;
              const name = tab.filePath.split("/").pop() || tab.filePath;
              const isDirty = dirtyIds.has(tab.id);
              return (
                // 閉じるボタンを選択のボタンの中に入れないよう、兄弟として並べる
                <div
                  key={tab.id}
                  role="tab"
                  aria-selected={isActive}
                  title={tab.filePath}
                  className={cn(
                    "flex shrink-0 items-center whitespace-nowrap border-border border-r text-xs",
                    isActive
                      ? "bg-background text-foreground"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(tab.id)}
                    className="flex h-full items-center gap-1.5 pr-1 pl-3"
                  >
                    <span>{name}</span>
                    {isDirty && (
                      <span
                        role="img"
                        aria-label="未保存"
                        className="text-status-awaiting"
                      >
                        ●
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label={`${name} を閉じる`}
                    onClick={() => handleClose(tab.id)}
                    className="mr-1.5 inline-flex size-4 items-center justify-center rounded hover:bg-muted hover:text-destructive"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        <div className="min-h-0 flex-1">
          {state.tabs.length === 0 ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-muted-foreground text-sm">
              ツリーからファイルを選ぶか、会話やボードのリンクを押すと開きます
            </div>
          ) : !api ? (
            <div className="flex h-full items-center justify-center text-muted-foreground text-xs">
              接続中…
            </div>
          ) : (
            // 全タブをマウントしたまま切り替える (未保存の編集を保つ)
            state.tabs.map(tab => {
              const isActive = tab.id === state.activeId;
              return (
                <div
                  key={tab.id}
                  role="tabpanel"
                  className={cn("h-full", !isActive && "hidden")}
                >
                  <FileEditor
                    api={api}
                    tab={tab}
                    isVisible={paneActive && isActive}
                    onDirtyChange={handleDirtyChange}
                    onSaved={handleSaved}
                  />
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
