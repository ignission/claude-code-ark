/**
 * SplitViewPane - チャット UI 時代の PC 用セッションビュー
 *
 * 左ペイン (SplitChatPane = JSONL ベースの会話ビュー) を全幅表示し、
 * 上部の「🖥 ターミナル」トグルで右に既存 TerminalPane (ttyd) を展開する。
 * 旧来の TerminalPane 単独表示に戻したい場合は URL に `?view=classic` を付ける
 * (Dashboard.tsx で分岐)。
 *
 * - ttyd は display 切替で残置 (unmount するとセッション再接続コストが発生)
 * - 左右比 / ターミナル開閉状態は localStorage に永続化
 */

import type {
  BridgeSessionStatus,
  ClientToServerEvents,
  ManagedSession,
  MessageShortcut,
  ServerToClientEvents,
  SpecialKey,
  Worktree,
} from "@ark/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { SplitChatPane } from "./SplitChatPane";
import { TerminalPane, type ViewerTab } from "./TerminalPane";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const LEFT_MIN_WIDTH = 280;
const LEFT_MAX_RATIO = 0.6;
const STORAGE_KEY_WIDTH = "ark-split-left-width";
const STORAGE_KEY_TERMINAL = "ark-split-show-terminal";

interface SplitViewPaneProps {
  socket: TypedSocket | null;
  session: ManagedSession;
  /** このペインが現在表示中か (JSONL 購読をアクティブセッションに限定する) */
  isActive: boolean;
  /** session:previews 由来のセッション状態 (busy/AWAITING 表示用) */
  bridgeStatus?: BridgeSessionStatus;
  /** AWAITING 時の確認 UI 生テキスト (バナーに表示) */
  awaitingText?: string;
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

function readSavedLeftWidth(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_WIDTH);
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function readSavedShowTerminal(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY_TERMINAL) === "1";
  } catch {
    return false;
  }
}

export function SplitViewPane(props: SplitViewPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [leftWidth, setLeftWidth] = useState<number>(
    () => readSavedLeftWidth() ?? 420
  );
  const [isDragging, setIsDragging] = useState(false);
  const [showTerminal, setShowTerminal] = useState<boolean>(() =>
    readSavedShowTerminal()
  );

  // キャンバスタブが新規に開かれたら右ペインを自動表示する。
  // canvas タブ数の増加時のみ true 化し、ユーザーが後で閉じた操作は尊重する。
  const prevCanvasCountRef = useRef(0);
  useEffect(() => {
    const canvasCount = props.tabs.filter(
      t => t.type === "canvas" || t.type === "board"
    ).length;
    if (canvasCount > prevCanvasCountRef.current) {
      setShowTerminal(true);
    }
    prevCanvasCountRef.current = canvasCount;
  }, [props.tabs]);

  // コンテナ幅変化時に left を最大比率内に丸める (ターミナル表示中のみ意味あり)
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !showTerminal) return;
    const observer = new ResizeObserver(() => {
      const total = el.clientWidth;
      if (total <= 0) return;
      const max = Math.floor(total * LEFT_MAX_RATIO);
      setLeftWidth(prev => clamp(prev, LEFT_MIN_WIDTH, max));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [showTerminal]);

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
      const next = e.clientX - rect.left;
      const max = Math.floor(total * LEFT_MAX_RATIO);
      const clamped = clamp(next, LEFT_MIN_WIDTH, max);
      setLeftWidth(clamped);
    };
    const onUp = () => {
      setIsDragging(false);
      try {
        localStorage.setItem(STORAGE_KEY_WIDTH, String(leftWidth));
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
  }, [isDragging, leftWidth]);

  const handleToggleTerminal = useCallback(() => {
    setShowTerminal(prev => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY_TERMINAL, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  return (
    <div ref={containerRef} className="h-full flex relative">
      <div
        style={
          showTerminal
            ? { width: leftWidth, flexShrink: 0 }
            : { flex: "1 1 auto", minWidth: 0 }
        }
        className={`h-full overflow-hidden ${showTerminal ? "border-r border-border" : ""}`}
      >
        <SplitChatPane
          socket={props.socket}
          session={props.session}
          isActive={props.isActive}
          bridgeStatus={props.bridgeStatus}
          awaitingText={props.awaitingText}
          onSendMessage={props.onSendMessage}
          onSendKey={props.onSendKey}
          onUploadFile={props.onUploadFile}
          showTerminal={showTerminal}
          onToggleTerminal={handleToggleTerminal}
        />
      </div>

      {/* リサイザはターミナル表示時のみ */}
      {showTerminal && (
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
      )}

      {/* TerminalPane は display 切替で永続マウント (ttyd の再接続コストを避ける) */}
      <div
        className={`h-full overflow-hidden ${
          showTerminal ? "flex-1 min-w-0" : "hidden"
        }`}
      >
        <div className={`h-full ${isDragging ? "pointer-events-none" : ""}`}>
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
      </div>
    </div>
  );
}
