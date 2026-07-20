/**
 * SplitViewPane - PC 用セッションビュー（ターミナル + 右ペインの左右2ペイン）
 *
 * 左ペイン = TerminalPane（ttyd + file/html/canvas タブ）を常時表示、
 * 右ペインは上部バーのトグルで開閉する。中身は diagram タブの有無で切り替わる:
 * diagram タブがあれば DiagramPane（B-0a の図ペイン）、無ければ従来どおり
 * CanvasPane（Excalidraw ホワイトボード）。
 * 会話ビュー（SplitChatPane）は使わない — チャット内容を確認したい場合は
 * ttyd の生ターミナル（左ペイン）を直接見る。
 *
 * - board / diagram は TerminalPane のタブ機構から外れ、右ペイン専属になった
 *   （タブ自体は sessionTabs 上には残るが、非表示のまま「開いている印」として使う）
 * - 会話内の mermaid ブロック「キャンバスで開く」は publishBoardInsert で
 *   board-bus にキューされ、useViewerTabs.openBoardTab が board タブを
 *   sessionTabs に追加する。下の useEffect がその追加を検知して showBoard を
 *   自動 true にし、CanvasPane がマウントされてキューが flush される
 * - 図（openDiagramTab）が開かれたときも同じ useEffect が showBoard を自動 true にする
 * - 右ペイン幅 / 開閉状態は localStorage に永続化
 */

import type {
  ClientToServerEvents,
  ManagedSession,
  MessageShortcut,
  ServerToClientEvents,
  SpecialKey,
  Worktree,
} from "@ark/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { CanvasPane } from "./CanvasPane";
import { DiagramPane } from "./DiagramPane";
import { TerminalPane, type ViewerTab } from "./TerminalPane";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const BOARD_MIN_WIDTH = 320;
const BOARD_MAX_RATIO = 0.6;
const STORAGE_KEY_BOARD_WIDTH = "ark-split-board-width";
const STORAGE_KEY_SHOW_BOARD = "ark-split-show-board";

interface SplitViewPaneProps {
  socket: TypedSocket | null;
  session: ManagedSession;
  worktree: Worktree | undefined;
  repoName?: string;
  tabs: ViewerTab[];
  activeTabIndex: number;
  onTabSelect: (index: number) => void;
  onTabClose: (index: number) => void;
  onSendMessage: (message: string) => void;
  onSendKey: (key: SpecialKey) => void;
  onDeleteSession: () => void;
  onUploadFile?: (data: {
    base64Data: string;
    mimeType: string;
    originalFilename?: string;
  }) => Promise<{ path: string; filename: string; originalFilename?: string }>;
  onCopyBuffer?: () => Promise<string | null>;
  messageShortcuts: MessageShortcut[];
  onCreateShortcut: (message: string) => void;
  onUpdateShortcut: (id: string, patch: { message?: string }) => void;
  onDeleteShortcut: (id: string) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readSavedBoardWidth(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_BOARD_WIDTH);
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function readSavedShowBoard(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY_SHOW_BOARD) === "1";
  } catch {
    return false;
  }
}

export function SplitViewPane(props: SplitViewPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [boardWidth, setBoardWidth] = useState<number>(
    () => readSavedBoardWidth() ?? 420
  );
  const [isDragging, setIsDragging] = useState(false);
  const [showBoard, setShowBoard] = useState<boolean>(() =>
    readSavedShowBoard()
  );

  // 右ペインに出す図（最後に開かれたもの）。diagram タブはタブバーから
  // 除外されており、ここでのみ描画される。
  const diagramTab = [...props.tabs].reverse().find(t => t.type === "diagram");

  // board / diagram タブが sessionTabs に新規追加されたら右ペインを自動表示する
  // （「キャンバスで開く」→ publishBoardInsert + openBoardTab、または図を開く導線）。
  // tabs は session 単位でスコープされているため、他セッションの変化には反応しない。
  // 数の増加時のみ true 化し、ユーザーが後で閉じた操作は尊重する。
  const prevBoardCountRef = useRef(0);
  useEffect(() => {
    const boardCount = props.tabs.filter(
      t => t.type === "board" || t.type === "canvas" || t.type === "diagram"
    ).length;
    if (boardCount > prevBoardCountRef.current) {
      setShowBoard(true);
    }
    prevBoardCountRef.current = boardCount;
  }, [props.tabs]);

  // コンテナ幅変化時に board 幅を最大比率内に丸める（表示中のみ意味あり）
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !showBoard) return;
    const observer = new ResizeObserver(() => {
      const total = el.clientWidth;
      if (total <= 0) return;
      const max = Math.floor(total * BOARD_MAX_RATIO);
      setBoardWidth(prev => clamp(prev, BOARD_MIN_WIDTH, max));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [showBoard]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: MouseEvent) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const total = rect.width;
      // 右ペイン（board）の幅 = コンテナ右端からカーソルまでの距離
      const next = rect.right - e.clientX;
      const max = Math.floor(total * BOARD_MAX_RATIO);
      const clamped = clamp(next, BOARD_MIN_WIDTH, max);
      setBoardWidth(clamped);
    };
    const onUp = () => {
      setIsDragging(false);
      try {
        localStorage.setItem(STORAGE_KEY_BOARD_WIDTH, String(boardWidth));
      } catch {
        // ignore
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isDragging, boardWidth]);

  const handleToggleBoard = useCallback(() => {
    setShowBoard(prev => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY_SHOW_BOARD, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  return (
    <div className="h-full flex flex-col">
      {/* 上部バー: ボード開閉トグル */}
      <div className="h-8 shrink-0 border-b border-border bg-sidebar flex items-center justify-end px-2">
        <button
          type="button"
          onClick={handleToggleBoard}
          className={`text-[11px] px-2 py-1 rounded-md font-medium flex items-center gap-1 transition-colors ${
            showBoard
              ? "bg-primary text-primary-foreground"
              : "bg-muted hover:bg-muted/70 text-foreground"
          }`}
          title={
            showBoard
              ? "右ペインを閉じる"
              : diagramTab
                ? "図を開く"
                : "ボードを開く"
          }
        >
          <span>{diagramTab ? "📐" : "🎨"}</span>
          <span>{showBoard ? "閉じる" : diagramTab ? "図" : "ボード"}</span>
        </button>
      </div>

      <div ref={containerRef} className="flex-1 min-h-0 flex relative">
        {/* 左ペイン: ターミナル（常時表示） */}
        <div className="h-full flex-1 min-w-0 overflow-hidden">
          <TerminalPane
            session={props.session}
            worktree={props.worktree}
            repoName={props.repoName}
            tabs={props.tabs}
            activeTabIndex={props.activeTabIndex}
            onTabSelect={props.onTabSelect}
            onTabClose={props.onTabClose}
            onSendMessage={props.onSendMessage}
            onSendKey={props.onSendKey}
            onDeleteSession={props.onDeleteSession}
            onUploadFile={props.onUploadFile}
            onCopyBuffer={props.onCopyBuffer}
            messageShortcuts={props.messageShortcuts}
            onCreateShortcut={props.onCreateShortcut}
            onUpdateShortcut={props.onUpdateShortcut}
            onDeleteShortcut={props.onDeleteShortcut}
          />
        </div>

        {/* リサイザ・右ペインはボード表示時のみ */}
        {showBoard && (
          <>
            <button
              type="button"
              aria-label="左右の幅を調整"
              onMouseDown={handleMouseDown}
              className={`relative w-1 shrink-0 cursor-col-resize bg-border hover:bg-primary/50 transition-colors ${
                isDragging ? "bg-primary/70" : ""
              }`}
            >
              <span className="absolute inset-y-0 -left-1 -right-1" />
            </button>
            <div
              style={{ width: boardWidth, flexShrink: 0 }}
              className={`h-full overflow-hidden border-l border-border ${
                isDragging ? "pointer-events-none" : ""
              }`}
            >
              {diagramTab && diagramTab.type === "diagram" ? (
                <DiagramPane
                  socket={props.socket}
                  worktreePath={diagramTab.worktreePath}
                  relPath={diagramTab.relPath}
                />
              ) : (
                <CanvasPane
                  socket={props.socket}
                  sessionId={props.session.id}
                  worktreePath={props.session.worktreePath}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
