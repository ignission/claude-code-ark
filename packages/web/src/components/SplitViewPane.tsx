/**
 * SplitViewPane - PC 用セッションビュー（左ペイン + 右ペインの左右2ペイン）
 *
 * 左ペインは上部バーのトグルで「端末（TerminalPane = ttyd + file/html タブ）」と
 * 「会話（SplitChatPane = JSONL tail のチャットビュー）」を切り替える。
 * 右ペインは図が未選択でも上部バーのトグルで開閉できる。
 * 中身は DiagramPane（B-0a の図ペイン）。
 *
 * - diagram は TerminalPane のタブ機構から外れ、右ペイン専属になった
 *   （タブ自体は sessionTabs 上には残るが、非表示のまま「開いている印」として使う）
 * - 図（openDiagramTab）の activation id が変わると showBoard を自動 true にする
 * - 左ペインのモード / 右ペイン幅 / 右ペイン開閉状態は localStorage に永続化
 * - 左ペインは端末・会話の両方をマウントしたまま display 切替する。ttyd は
 *   iframe（別ブラウジングコンテキスト）なので、アンマウントすると再接続に
 *   なってしまう（.claude/rules/frontend-codegen.md）
 * - 会話ビューには showTerminal / onToggleTerminal を渡さない。渡すとチャット
 *   ヘッダにもう 1 つ 🖥 トグルが出て、上部バーの切替と二重になる。AUQ カードや
 *   AWAITING バナーの「ターミナルへ」導線も同 props 由来で消えるが、
 *   切替は 1 行上の上部バーにあり、モバイル（MobileSessionView）とも揃う
 */

import type {
  BridgeSessionStatus,
  ClientToServerEvents,
  DiagramCommentsResponse,
  DiagramDeleteResponse,
  DiagramListItem,
  ManagedSession,
  MessageShortcut,
  ServerToClientEvents,
  SpecialKey,
  Worktree,
} from "@ark/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import {
  readSavedSplitViewLeftMode,
  SPLIT_VIEW_LEFT_MODE_CHANGE_EVENT,
  type SplitViewLeftMode,
  STORAGE_KEY_SPLIT_LEFT_MODE,
  shouldAcceptTerminalFileDrop,
  shouldSubscribeChat,
  writeSavedSplitViewLeftMode,
} from "../lib/split-view-left-mode";
import { DiagramPane } from "./DiagramPane";
import { SplitChatPane } from "./SplitChatPane";
import { SplitViewLeftModeToggle } from "./SplitViewLeftModeToggle";
import { TerminalPane, type ViewerTab } from "./TerminalPane";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const BOARD_MIN_WIDTH = 320;
const BOARD_MAX_RATIO = 0.6;
const STORAGE_KEY_BOARD_WIDTH = "ark-split-board-width";
const STORAGE_KEY_SHOW_BOARD = "ark-split-show-board";

interface SplitViewPaneProps {
  socket: TypedSocket | null;
  isConnected: boolean;
  diagramCommentsUpdate: {
    worktreePath: string;
    relPath: string;
    sequence: number;
  } | null;
  listDiagrams: (worktreePath: string) => Promise<DiagramListItem[]>;
  deleteDiagram: (
    sessionId: string,
    relPath: string,
    expectedTracked: boolean
  ) => Promise<DiagramDeleteResponse>;
  getDiagramComments: (
    sessionId: string,
    relPath: string
  ) => Promise<DiagramCommentsResponse>;
  createDiagramComment: (
    sessionId: string,
    relPath: string,
    operationId: string,
    anchorId: string,
    body: string,
    anchorQuote?: string,
    anchorOccurrence?: number
  ) => Promise<DiagramCommentsResponse>;
  resolveDiagramComment: (
    sessionId: string,
    relPath: string,
    operationId: string,
    threadId: string
  ) => Promise<DiagramCommentsResponse>;
  replyDiagramComment: (
    sessionId: string,
    relPath: string,
    operationId: string,
    threadId: string,
    body: string
  ) => Promise<DiagramCommentsResponse>;
  deleteDiagramComment: (
    sessionId: string,
    relPath: string,
    operationId: string,
    threadId: string
  ) => Promise<DiagramCommentsResponse>;
  sendDiagramComment: (
    sessionId: string,
    relPath: string,
    operationId: string,
    threadId: string
  ) => Promise<DiagramCommentsResponse>;
  session: ManagedSession;
  /**
   * このセッションが現在選択中か。SplitViewPane は Dashboard で全セッション
   * ぶんが常時マウントされる（非選択は `hidden`）ため、会話ビューの JSONL
   * 購読はこれと左ペインのモードの両方で絞る（shouldSubscribeChat）
   */
  isActive: boolean;
  /** session:previews 由来のセッション状態（会話ビューの busy / AWAITING 表示） */
  bridgeStatus?: BridgeSessionStatus;
  /** AWAITING 時の確認 UI 生テキスト（会話ビューのバナー表示） */
  awaitingText?: string;
  worktree: Worktree | undefined;
  repoName?: string;
  tabs: ViewerTab[];
  activeTabIndex: number;
  onTabSelect: (index: number) => void;
  onTabClose: (index: number) => void;
  onSelectDiagram: (relPath: string, worktreePath: string) => void;
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
  // 左ペインのモード。選択は PC 全体で共有し、常時マウント済みの別セッション
  // および別ブラウザタブからの変更にも追随する。
  const [leftMode, setLeftMode] = useState<SplitViewLeftMode>(
    readSavedSplitViewLeftMode
  );

  useEffect(() => {
    const syncFromStorage = () => setLeftMode(readSavedSplitViewLeftMode());
    const handleStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY_SPLIT_LEFT_MODE) syncFromStorage();
    };

    window.addEventListener(SPLIT_VIEW_LEFT_MODE_CHANGE_EVENT, syncFromStorage);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(
        SPLIT_VIEW_LEFT_MODE_CHANGE_EVENT,
        syncFromStorage
      );
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const handleLeftModeChange = useCallback((next: SplitViewLeftMode) => {
    writeSavedSplitViewLeftMode(next);
    setLeftMode(next);
  }, []);

  // 現在図は session ごとに最大1件。diagram タブは左タブバーから除外され、
  // ここでのみ参照する。
  const diagramTab = props.tabs.find(t => t.type === "diagram");

  // current diagram の activation id が変わったら右ペインを自動表示する。
  // tabs は session 単位でスコープされているため、他セッションの変化には反応しない。
  // 同じ relPath の board_open でも id は新しくなるため再表示できる。
  //
  // 「lastDiagramPath からの復元」除外について:
  // このコンポーネントは Dashboard.tsx で全セッション分が session.id をキーに
  // 常時マウントされている（selectedSessionId でなくても hidden で存在し続ける）。
  // ページロード直後、対象セッションが sessions に現れた最初のレンダーでは
  // props.tabs はまだ [terminal] のみ（sessionTabs の復元用 setState は
  // Dashboard 側の別 effect で非同期に行われるため、同一コミットには乗らない）。
  // そのため「マウント時点で図タブが既にあれば増加とみなさない」という直感的な
  // 前提は成り立たない ― prevBoardCountRef は常にマウント直後は 0 から始まり、
  // 直後に復元 openDiagramTab が発火すると 0→1 の「増加」として観測されてしまう。
  // ここでは live な board_open / user switch だけを自動表示したいので、
  // restoredOnLoad タグの付いた復元タブは除外する
  // （タグは openDiagramTab の呼び出し元 = Dashboard.tsx の復元 effect が付与する）。
  const prevDiagramIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const currentId = diagramTab?.id;
    if (
      currentId !== undefined &&
      currentId !== prevDiagramIdRef.current &&
      diagramTab?.restoredOnLoad !== true
    ) {
      setShowBoard(true);
    }
    prevDiagramIdRef.current = currentId;
  }, [diagramTab]);

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
      {/* 上部バー: 左は左ペイン切替（端末 / 会話）、右は右ペイン開閉トグル */}
      <div className="h-8 shrink-0 border-b border-border bg-sidebar flex items-center justify-between px-2">
        <SplitViewLeftModeToggle
          value={leftMode}
          onChange={handleLeftModeChange}
        />
        <button
          type="button"
          onClick={handleToggleBoard}
          className={`text-[11px] px-2 py-1 rounded-md font-medium flex items-center gap-1 transition-colors ${
            showBoard
              ? "bg-primary text-primary-foreground"
              : "bg-muted hover:bg-muted/70 text-foreground"
          }`}
          title={showBoard ? "右ペインを閉じる" : "図を開く"}
        >
          <span>📐</span>
          <span>{showBoard ? "閉じる" : "図"}</span>
        </button>
      </div>

      <div ref={containerRef} className="flex-1 min-h-0 flex relative">
        {/* 左ペイン: 端末 / 会話（上部バーで切替。両方マウントしたまま display 切替）
            リサイズ中は pointer-events-none にする。ターミナルは ttyd の iframe
            （別ブラウジングコンテキスト）で、分割線を左へドラッグしてカーソルが
            この上に乗ると mousemove / mouseup を iframe が飲み込み、window の
            リスナーへ届かなくなる。結果、幅が更新されず（ターミナルが狭くならない）、
            mouseup も発火せずドラッグが解除されない（カーソル追従が止まらない）。
            右ペイン（ボード）と同様に透過させて window リスナーへ届かせる。 */}
        <div
          className={`h-full flex-1 min-w-0 overflow-hidden ${
            isDragging ? "pointer-events-none" : ""
          }`}
        >
          {/* 端末: ttyd の再接続を避けるため hidden で残置する */}
          <div className={leftMode === "terminal" ? "h-full" : "hidden"}>
            <TerminalPane
              session={props.session}
              worktree={props.worktree}
              repoName={props.repoName}
              isVisible={shouldAcceptTerminalFileDrop(props.isActive, leftMode)}
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

          {/* 会話: JSONL tail のチャットビュー。入力欄 / AUQ カード / slash 補完 /
              ファイルアップロード / busy・AWAITING 表示を内包する */}
          <div className={leftMode === "chat" ? "h-full" : "hidden"}>
            <SplitChatPane
              socket={props.socket}
              session={props.session}
              isActive={shouldSubscribeChat(props.isActive, leftMode)}
              bridgeStatus={props.bridgeStatus}
              awaitingText={props.awaitingText}
              onSendMessage={props.onSendMessage}
              onSendKey={props.onSendKey}
              onUploadFile={props.onUploadFile}
            />
          </div>
        </div>

        {/* リサイザ・右ペイン */}
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
              <DiagramPane
                socket={props.socket}
                isConnected={props.isConnected}
                diagramCommentsUpdate={props.diagramCommentsUpdate}
                listDiagrams={props.listDiagrams}
                deleteDiagram={props.deleteDiagram}
                getDiagramComments={props.getDiagramComments}
                createDiagramComment={props.createDiagramComment}
                replyDiagramComment={props.replyDiagramComment}
                resolveDiagramComment={props.resolveDiagramComment}
                deleteDiagramComment={props.deleteDiagramComment}
                sendDiagramComment={props.sendDiagramComment}
                sessionId={props.session.id}
                worktreePath={
                  diagramTab?.worktreePath ?? props.session.worktreePath
                }
                relPath={diagramTab?.relPath}
                onSelectDiagram={props.onSelectDiagram}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
