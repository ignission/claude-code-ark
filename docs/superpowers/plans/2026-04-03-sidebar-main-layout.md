# サイドバー + メイン + Beacon 3カラムレイアウト 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 2列グリッドレイアウトを廃止し、セッション一覧サイドバー + メイン1ペイン + Beacon常設の3カラムレイアウトに移行する

**Architecture:** サーバー側でtmux capture-paneによるプレビューポーリングを追加し、Socket.IOでクライアントに配信。クライアント側はMultiPaneLayoutを廃止し、SessionSidebar + TerminalPane + MobileChatViewの3カラム構成に置き換える。モバイルは既存MobileLayout維持。

**Tech Stack:** React 19, TailwindCSS 4, shadcn/ui, Socket.IO, tmux

**設計ドキュメント:** `docs/superpowers/specs/2026-04-03-sidebar-main-layout-design.md`

---

### Task 1: shared/types.ts — プレビューイベントの型定義追加

**Files:**
- Modify: `shared/types.ts:92-157` (ServerToClientEvents)
- Modify: `shared/types.ts:159-203` (ClientToServerEvents)

- [ ] **Step 1: ServerToClientEventsにプレビューイベントを追加**

`shared/types.ts` の `ServerToClientEvents` インターフェースの `session:restore_failed` の後に追加:

```typescript
  // Session preview events
  "session:previews": (previews: Array<{ sessionId: string; text: string; timestamp: number }>) => void;
```

- [ ] **Step 2: 型チェックを実行**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && pnpm check`
Expected: エラーなし

- [ ] **Step 3: コミット**

```bash
git add shared/types.ts
git commit -m "feat: セッションプレビュー用のSocket.IOイベント型を追加"
```

---

### Task 2: サーバー — ANSI除去ユーティリティとプレビューポーリング

**Files:**
- Create: `server/lib/ansi.ts`
- Modify: `server/lib/session-orchestrator.ts:21-26` (constructor周辺)
- Modify: `server/index.ts:425` (connection handler周辺)

- [ ] **Step 1: ANSI除去ユーティリティを作成**

`server/lib/ansi.ts` を作成:

```typescript
/**
 * ANSIエスケープシーケンスを除去するユーティリティ
 */

/** ANSIエスケープシーケンスを除去する正規表現 */
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[>=<]|\x0f/g;

/**
 * ANSIエスケープシーケンスを除去してプレーンテキストを返す
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}
```

- [ ] **Step 2: SessionOrchestratorにプレビュー取得メソッドを追加**

`server/lib/session-orchestrator.ts` に以下のメソッドを追加（`cleanup()` の前）:

```typescript
  /**
   * 全アクティブセッションのプレビューテキストを取得
   * @param excludeSessionId メイン表示中のセッションID（スキップ対象）
   */
  getAllPreviews(excludeSessionId?: string): Array<{ sessionId: string; text: string; timestamp: number }> {
    const allSessions = tmuxManager.getAllSessions();
    const previews: Array<{ sessionId: string; text: string; timestamp: number }> = [];

    for (const session of allSessions) {
      if (excludeSessionId && session.id === excludeSessionId) continue;
      const raw = tmuxManager.capturePane(session.id, 3);
      if (raw === null) continue;
      const text = stripAnsi(raw).split("\n").filter(line => line.trim() !== "").slice(-1).join("") || "";
      previews.push({ sessionId: session.id, text, timestamp: Date.now() });
    }

    return previews;
  }
```

ファイル先頭のimportに追加:

```typescript
import { stripAnsi } from "./ansi.js";
```

- [ ] **Step 3: server/index.tsにプレビューポーリングを追加**

`server/index.ts` の `io.on("connection", socket => {` ハンドラー内（`socket.on("disconnect", ...)` の前）に以下を追加:

```typescript
    // セッションプレビューのポーリング（3秒間隔）
    const previewInterval = setInterval(() => {
      try {
        const previews = sessionOrchestrator.getAllPreviews();
        if (previews.length > 0) {
          socket.emit("session:previews", previews);
        }
      } catch (err) {
        console.error("[Preview] Error:", getErrorMessage(err));
      }
    }, 3000);

    // 接続時に初回プレビューを送信
    try {
      const initialPreviews = sessionOrchestrator.getAllPreviews();
      if (initialPreviews.length > 0) {
        socket.emit("session:previews", initialPreviews);
      }
    } catch (err) {
      console.error("[Preview] Initial error:", getErrorMessage(err));
    }
```

既存の `socket.on("disconnect", () => {` ハンドラー内にintervalクリアを追加:

```typescript
    socket.on("disconnect", () => {
      clearInterval(previewInterval);
      console.log(`[Socket.IO] Client disconnected: ${socket.id}`);
    });
```

- [ ] **Step 4: 型チェックを実行**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && pnpm check`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add server/lib/ansi.ts server/lib/session-orchestrator.ts server/index.ts
git commit -m "feat: tmux capture-paneベースのセッションプレビュー配信を追加"
```

---

### Task 3: クライアント — useSocket.tsにプレビュー状態を追加

**Files:**
- Modify: `client/src/hooks/useSocket.ts`

- [ ] **Step 1: UseSocketReturnにプレビュー関連の型を追加**

`client/src/hooks/useSocket.ts` の `UseSocketReturn` インターフェースに追加（`// Image upload` コメントの前あたり）:

```typescript
  // Session previews
  sessionPreviews: Map<string, string>;
```

- [ ] **Step 2: useSocket関数内にプレビュー状態を追加**

useSocket関数内に状態を追加:

```typescript
  const [sessionPreviews, setSessionPreviews] = useState<Map<string, string>>(new Map());
```

Socket.IOイベントリスナー設定部分（`useEffect` 内）に追加:

```typescript
    socket.on("session:previews", (previews) => {
      setSessionPreviews(prev => {
        const next = new Map(prev);
        for (const p of previews) {
          next.set(p.sessionId, p.text);
        }
        return next;
      });
    });
```

クリーンアップ部分に追加:

```typescript
    socket.off("session:previews");
```

- [ ] **Step 3: return文にsessionPreviewsを追加**

```typescript
    sessionPreviews,
```

- [ ] **Step 4: 型チェックを実行**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && pnpm check`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add client/src/hooks/useSocket.ts
git commit -m "feat: useSocketにセッションプレビュー状態管理を追加"
```

---

### Task 4: クライアント — SessionCard.tsxの作成

**Files:**
- Create: `client/src/components/SessionCard.tsx`

- [ ] **Step 1: SessionCardコンポーネントを作成**

`client/src/components/SessionCard.tsx` を作成:

```tsx
/**
 * SessionCard - サイドバーの各セッション表示カード
 *
 * 状態アイコン + repo短縮名/ブランチ名 + プレビューテキストを表示。
 * クリックでメインエリアにそのセッションを表示する。
 */

import type { ManagedSession, Worktree } from "../../../shared/types";
import { getBaseName } from "@/utils/pathUtils";
import { findRepoForSession } from "@/utils/sessionUtils";

interface SessionCardProps {
  session: ManagedSession;
  worktree: Worktree | undefined;
  repoList: string[];
  isSelected: boolean;
  previewText: string;
  onClick: () => void;
  onStop: () => void;
}

/** セッションステータスに応じた色クラスを返す */
function statusColor(status: ManagedSession["status"]): string {
  switch (status) {
    case "active":
      return "bg-green-500";
    case "idle":
      return "bg-yellow-500";
    case "stopped":
    case "error":
      return "bg-red-500";
    default:
      return "bg-gray-500";
  }
}

export function SessionCard({
  session,
  worktree,
  repoList,
  isSelected,
  previewText,
  onClick,
  onStop,
}: SessionCardProps) {
  const repo = findRepoForSession(session, repoList);
  const repoName = repo ? getBaseName(repo) : "";
  const branch = worktree?.branch || session.worktreePath.substring(session.worktreePath.lastIndexOf("/") + 1);
  const label = repoName ? `${repoName}/${branch}` : branch;

  return (
    <button
      type="button"
      className={`w-full text-left p-3 rounded-lg transition-colors group ${
        isSelected
          ? "bg-primary/15 border border-primary/30"
          : "hover:bg-sidebar-accent/50"
      }`}
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        onStop();
      }}
    >
      <div className="flex items-center gap-2 min-w-0">
        <div className={`w-2 h-2 rounded-full shrink-0 ${statusColor(session.status)}`} />
        <span className="text-sm font-mono truncate text-sidebar-foreground">
          {label}
        </span>
        {isSelected && (
          <span className="ml-auto text-xs text-primary shrink-0">◀</span>
        )}
      </div>
      {previewText && (
        <p className="mt-1 text-xs text-muted-foreground truncate pl-4">
          {previewText}
        </p>
      )}
    </button>
  );
}
```

- [ ] **Step 2: 型チェックを実行**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && pnpm check`
Expected: エラーなし

- [ ] **Step 3: コミット**

```bash
git add client/src/components/SessionCard.tsx
git commit -m "feat: セッションカードコンポーネントを作成"
```

---

### Task 5: クライアント — SessionSidebar.tsxの作成

**Files:**
- Create: `client/src/components/SessionSidebar.tsx`

- [ ] **Step 1: SessionSidebarコンポーネントを作成**

`client/src/components/SessionSidebar.tsx` を作成:

```tsx
/**
 * SessionSidebar - 全セッションをフラット表示するサイドバー
 *
 * セッション一覧（SessionCard） + 新規作成「+」ボタンを提供。
 * リポジトリ横断で全セッションを表示する。
 */

import { Plus, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ManagedSession, Worktree } from "../../../shared/types";
import { SessionCard } from "./SessionCard";

interface SessionSidebarProps {
  sessions: Map<string, ManagedSession>;
  worktrees: Worktree[];
  repoList: string[];
  selectedSessionId: string | null;
  sessionPreviews: Map<string, string>;
  onSelectSession: (sessionId: string) => void;
  onStopSession: (sessionId: string) => void;
  onNewSession: () => void;
}

export function SessionSidebar({
  sessions,
  worktrees,
  repoList,
  selectedSessionId,
  sessionPreviews,
  onSelectSession,
  onStopSession,
  onNewSession,
}: SessionSidebarProps) {
  const sessionList = Array.from(sessions.values());

  const getWorktree = (session: ManagedSession): Worktree | undefined => {
    return worktrees.find(w => w.id === session.worktreeId);
  };

  return (
    <div className="h-full flex flex-col bg-sidebar">
      {/* ヘッダー */}
      <div className="h-12 border-b border-sidebar-border flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-primary" />
          <h1 className="font-semibold text-sm text-sidebar-foreground">Ark</h1>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onNewSession}
          title="新規セッション"
        >
          <Plus className="w-4 h-4" />
        </Button>
      </div>

      {/* セッション一覧 */}
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {sessionList.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">
              <Terminal className="w-8 h-8 mx-auto mb-3 opacity-50" />
              <p>セッションがありません</p>
              <p className="text-xs mt-1">「+」から新規作成</p>
            </div>
          ) : (
            sessionList.map(session => (
              <SessionCard
                key={session.id}
                session={session}
                worktree={getWorktree(session)}
                repoList={repoList}
                isSelected={selectedSessionId === session.id}
                previewText={sessionPreviews.get(session.id) || ""}
                onClick={() => onSelectSession(session.id)}
                onStop={() => onStopSession(session.id)}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
```

- [ ] **Step 2: 型チェックを実行**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && pnpm check`
Expected: エラーなし

- [ ] **Step 3: コミット**

```bash
git add client/src/components/SessionSidebar.tsx
git commit -m "feat: セッションサイドバーコンポーネントを作成"
```

---

### Task 6: クライアント — SidebarMainLayout.tsxの作成

**Files:**
- Create: `client/src/components/SidebarMainLayout.tsx`

- [ ] **Step 1: 3カラムレイアウトコンポーネントを作成**

`client/src/components/SidebarMainLayout.tsx` を作成:

```tsx
/**
 * SidebarMainLayout - PC用3カラムレイアウト
 *
 * サイドバー（セッション一覧） + メイン（ttyd 1ペイン） + Beacon（チャット）
 * の3カラム構成。MultiPaneLayoutを置き換える。
 */

import type { ReactNode } from "react";

interface SidebarMainLayoutProps {
  sidebar: ReactNode;
  main: ReactNode;
  beacon: ReactNode;
}

export function SidebarMainLayout({
  sidebar,
  main,
  beacon,
}: SidebarMainLayoutProps) {
  return (
    <div className="h-[100dvh] flex">
      {/* サイドバー */}
      <div className="w-[250px] shrink-0 border-r border-border">
        {sidebar}
      </div>

      {/* メインエリア */}
      <div className="flex-1 min-w-0 flex flex-col">
        {main}
      </div>

      {/* Beacon */}
      <div className="w-[350px] shrink-0 border-l border-border">
        {beacon}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 型チェックを実行**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && pnpm check`
Expected: エラーなし

- [ ] **Step 3: コミット**

```bash
git add client/src/components/SidebarMainLayout.tsx
git commit -m "feat: 3カラムレイアウトコンテナコンポーネントを作成"
```

---

### Task 7: クライアント — TerminalPane.tsxから最大化/閉じるボタンを削除

**注意:** Dashboard書き換え（Task 8）より先に実行すること。Task 8ではonMaximize/isMaximizedを渡さないため。

**Files:**
- Modify: `client/src/components/TerminalPane.tsx:39-53` (props), `client/src/components/TerminalPane.tsx:320-349` (buttons)

- [ ] **Step 1: 最大化関連のpropsとUIを削除**

`TerminalPaneProps` から削除:
- `onMaximize?: () => void;`
- `isMaximized?: boolean;`

コンポーネント引数から削除:
- `onMaximize`
- `isMaximized = false`

ヘッダー内の最大化ボタン（`{onMaximize && (` で始まるブロック）を削除。

閉じるボタン（`onClose` の `<Button>` with `<X>` アイコン）を削除。

不要なimportを削除:
- `Maximize2`, `Minimize2`, `X` (lucide-react)

- [ ] **Step 2: 型チェックを実行**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && pnpm check`
Expected: エラーなし（MultiPaneLayoutが`onMaximize`を渡しているためエラーになる可能性あり → Task 9で削除されるので無視可）

- [ ] **Step 3: コミット**

```bash
git add client/src/components/TerminalPane.tsx
git commit -m "refactor: TerminalPaneから最大化・閉じるボタンを削除"
```

---

### Task 8: クライアント — Dashboard.tsxの書き換え

**Files:**
- Modify: `client/src/pages/Dashboard.tsx`

この変更は大きいため、ステップを細分化する。

- [ ] **Step 1: 不要なimportを削除し、新しいimportを追加**

削除するimport:
- `MultiPaneLayout` import
- `Separator` import（空状態メッセージで使用、不要に）

追加するimport:
```typescript
import { SessionSidebar } from "@/components/SessionSidebar";
import { SidebarMainLayout } from "@/components/SidebarMainLayout";
```

- [ ] **Step 2: 不要な状態・定数を削除**

削除する定数:
- `ACTIVE_PANES_STORAGE_KEY`
- `MAXIMIZED_PANE_STORAGE_KEY`
- `CLOSED_PANES_STORAGE_KEY`
- `loadClosedPanes` 関数

削除する状態:
- `activePanesPerRepo` と関連する `setActivePanesPerRepo`
- `maximizedPane` と `setMaximizedPane`
- `closedPanesRef` と `saveClosedPanes`
- `selectedWorktreeId` と `setSelectedWorktreeId`
- `showBeaconDialog` と `setShowBeaconDialog`

追加する状態:
```typescript
const SELECTED_SESSION_STORAGE_KEY = "selectedSessionId";

const [selectedSessionId, setSelectedSessionId] = useState<string | null>(() => {
  try {
    const saved = localStorage.getItem(SELECTED_SESSION_STORAGE_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
});
```

useSocketからの追加の取得:
```typescript
const { ..., sessionPreviews } = useSocket();
```

- [ ] **Step 3: selectedSessionIdのlocalStorage永続化を追加**

```typescript
useEffect(() => {
  try {
    localStorage.setItem(SELECTED_SESSION_STORAGE_KEY, JSON.stringify(selectedSessionId));
  } catch {}
}, [selectedSessionId]);
```

- [ ] **Step 4: 不要なuseEffect・ハンドラーを削除**

削除するuseEffect:
- `activePanesPerRepo`のlocalStorage保存
- `maximizedPane`のlocalStorage保存
- リポジトリ切替時の`setMaximizedPane(null)` + `setSelectedWorktreeId(null)`
- `sessions`変更時の`setActivePanesPerRepo`自動追加
- `maximizedPane`存在チェック

削除するハンドラー・ヘルパー:
- `setActivePanes`
- `removeSessionFromPanes`
- `handleClosePane`
- `handleMaximizePane`
- `handleSelectSession` (新しいロジックで置き換え)
- `filteredSessions` / `validActivePanes` の `useMemo`
- `allActivePanes` の `useMemo`
- `activePanes` の算出

- [ ] **Step 5: ハンドラーを簡素化**

`handleStartSession`を簡素化:
```typescript
const handleStartSession = (worktree: Worktree) => {
  const existingSession = getSessionForWorktree(worktree.id);
  if (existingSession) {
    setSelectedSessionId(existingSession.id);
    return;
  }
  startSession(worktree.id, worktree.path);
  toast.success("Session started");
};
```

`handleStopSession`を簡素化:
```typescript
const handleStopSession = (sessionId: string) => {
  stopSession(sessionId);
  if (selectedSessionId === sessionId) {
    // 別のセッションを自動選択
    const remaining = Array.from(sessions.values()).filter(s => s.id !== sessionId);
    setSelectedSessionId(remaining.length > 0 ? remaining[0].id : null);
  }
  toast.info("Session stopped");
};
```

新規セッション作成後の自動選択:
```typescript
// session:created イベントで自動選択
useEffect(() => {
  // 新しいセッションが追加されたら自動選択（selectedSessionIdがnullの場合）
  if (!selectedSessionId && sessions.size > 0) {
    const first = Array.from(sessions.values())[0];
    setSelectedSessionId(first.id);
  }
  // selectedSessionIdが存在しないセッションを指していたら修正
  if (selectedSessionId && !sessions.has(selectedSessionId)) {
    const remaining = Array.from(sessions.values());
    setSelectedSessionId(remaining.length > 0 ? remaining[0].id : null);
  }
}, [sessions, selectedSessionId]);
```

`handleNewSession`を追加（「+」ボタン用）:
```typescript
const [isNewSessionFlow, setIsNewSessionFlow] = useState(false);

const handleNewSession = () => {
  if (repoList.length === 0) {
    setIsSelectRepoOpen(true);
  } else if (repoList.length === 1) {
    selectRepo(repoList[0]);
    setIsCreateWorktreeOpen(true);
  } else {
    // 複数リポジトリがある場合、最後に選択したリポジトリを使用
    setIsCreateWorktreeOpen(true);
  }
};
```

- [ ] **Step 6: SidebarContentをSessionSidebarに置き換え**

既存の `SidebarContent` コンポーネント全体を削除する。

- [ ] **Step 7: PC表示のレンダリング部分を3カラムに書き換え**

`return` 文をまるごと書き換え。

PC表示:
```tsx
const selectedSession = selectedSessionId ? sessions.get(selectedSessionId) : undefined;
const selectedWorktree = selectedSession
  ? worktrees.find(w => w.id === selectedSession.worktreeId)
  : undefined;

return (
  <>
    {isMobile ? (
      <MobileLayout
        sessions={sessions}
        worktrees={worktrees}
        repoName={repoPath ? getBaseName(repoPath) : null}
        repoPath={repoPath}
        onStartSession={handleStartSession}
        onStopSession={handleStopSession}
        onDeleteWorktree={handleDeleteWorktree}
        onSendMessage={sendMessage}
        onSendKey={sendKey}
        onSelectSession={(sessionId) => setSelectedSessionId(sessionId)}
        onUploadImage={uploadImage}
        imageUploadResult={imageUploadResult}
        imageUploadError={imageUploadError}
        onClearImageUploadState={clearImageUploadState}
        onCopyBuffer={copyBuffer}
        beaconMessages={beaconMessages}
        beaconStreaming={beaconStreaming}
        beaconStreamText={beaconStreamText}
        onBeaconSend={beaconSend}
        onBeaconClear={beaconClear}
      />
    ) : (
      <SidebarMainLayout
        sidebar={
          <SessionSidebar
            sessions={sessions}
            worktrees={worktrees}
            repoList={repoList}
            selectedSessionId={selectedSessionId}
            sessionPreviews={sessionPreviews}
            onSelectSession={setSelectedSessionId}
            onStopSession={handleStopSession}
            onNewSession={handleNewSession}
          />
        }
        main={
          <div className="h-full flex flex-col">
            {!isConnected && (
              <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 flex items-center gap-2 text-destructive text-sm shrink-0">
                <AlertCircle className="w-4 h-4" />
                <span>Not connected to server</span>
              </div>
            )}
            <div className="flex-1 overflow-hidden">
              {selectedSession ? (
                <TerminalPane
                  session={selectedSession}
                  worktree={selectedWorktree}
                  repoName={repoPath ? getBaseName(repoPath) : undefined}
                  onSendMessage={msg => sendMessage(selectedSession.id, msg)}
                  onSendKey={key => sendKey(selectedSession.id, key)}
                  onStopSession={() => handleStopSession(selectedSession.id)}
                  onClose={() => handleStopSession(selectedSession.id)}
                  onUploadImage={(base64, mimeType) =>
                    uploadImage(selectedSession.id, base64, mimeType)
                  }
                  imageUploadResult={imageUploadResult}
                  imageUploadError={imageUploadError}
                  onClearImageUploadState={clearImageUploadState}
                  onCopyBuffer={
                    copyBuffer ? () => copyBuffer(selectedSession.id) : undefined
                  }
                />
              ) : (
                <div className="h-full flex items-center justify-center">
                  <div className="text-center">
                    <Terminal className="w-12 h-12 text-muted-foreground/50 mx-auto mb-4" />
                    <p className="text-muted-foreground">
                      サイドバーの「+」からセッションを作成
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        }
        beacon={
          <MobileChatView
            messages={beaconMessages}
            isStreaming={beaconStreaming}
            streamingText={beaconStreamText}
            onSendMessage={beaconSend}
            onClear={beaconClear}
          />
        }
      />
    )}

    {/* ダイアログ群（Tunnel、RepoSelect、CreateWorktree）はここに残す */}
    {/* showBeaconDialog関連のDialogは削除 */}

    {/* ポート選択ダイアログ */}
    <Dialog open={showPortSelector} onOpenChange={setShowPortSelector}>
      {/* 既存のまま */}
    </Dialog>

    {/* Quick Tunnel Dialog */}
    <Dialog open={showTunnelDialog} onOpenChange={setShowTunnelDialog}>
      {/* 既存のまま */}
    </Dialog>

    {/* リポジトリ選択ダイアログ */}
    <RepoSelectDialog
      isOpen={isSelectRepoOpen}
      onOpenChange={setIsSelectRepoOpen}
      scannedRepos={scannedRepos}
      isScanning={isScanning}
      onScanRepos={scanRepos}
      onSelectRepo={handleSelectRepo}
    />

    {/* Worktree作成ダイアログ */}
    <CreateWorktreeDialog
      open={isCreateWorktreeOpen}
      onOpenChange={setIsCreateWorktreeOpen}
      selectedRepoPath={repoPath}
      onCreateWorktree={handleCreateWorktree}
    />
  </>
);
```

- [ ] **Step 8: 不要なimportをクリーンアップ**

使わなくなったimportを削除:
- `MultiPaneLayout`
- `Separator`
- `Sheet`, `SheetContent`, `SheetHeader`, `SheetTitle`, `SheetTrigger`
- `WorktreeContextMenu`
- `ScrollArea`（SessionSidebarに移動済み）
- `Menu`, `Play`, `GitBranch`, `FolderOpen`, `Trash2`, `RefreshCw`（サイドバーで使わなくなったもの）

ルートコンポーネントのPC用サイドバー（`<aside>` タグ）も削除（SessionSidebarに移行済み）。

- [ ] **Step 9: 型チェックを実行**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && pnpm check`
Expected: エラーなし（修正が必要な場合は修正）

- [ ] **Step 10: コミット**

```bash
git add client/src/pages/Dashboard.tsx
git commit -m "feat: Dashboard.tsxを3カラムレイアウトに書き換え"
```

---

### Task 9: クリーンアップ — MultiPaneLayout.tsxの削除と不要コードの整理

**Files:**
- Delete: `client/src/components/MultiPaneLayout.tsx`
- Modify: `client/src/pages/Dashboard.tsx` (最終クリーンアップ)

- [ ] **Step 1: MultiPaneLayout.tsxを削除**

```bash
rm client/src/components/MultiPaneLayout.tsx
```

- [ ] **Step 2: MultiPaneLayoutへの参照が残っていないか確認**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && grep -r "MultiPaneLayout" client/ shared/ server/`
Expected: 出力なし

- [ ] **Step 3: 古いlocalStorageキーのクリーンアップコードを追加（任意）**

`Dashboard.tsx`の初期化付近に一度だけ実行するクリーンアップを追加:

```typescript
// 旧レイアウトのlocalStorageキーをクリーンアップ（移行用、しばらくしたら削除可）
useEffect(() => {
  localStorage.removeItem("activePanesPerRepo");
  localStorage.removeItem("maximizedPane");
  localStorage.removeItem("closedPanes");
}, []);
```

- [ ] **Step 4: ビルド確認**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && pnpm build`
Expected: ビルド成功

- [ ] **Step 5: コミット**

```bash
git add -A
git commit -m "refactor: MultiPaneLayout削除と旧localStorage キーのクリーンアップ"
```

---

### Task 10: E2Eテスト — ビルド + 起動確認

**Files:** なし（動作確認のみ）

- [ ] **Step 1: ビルドを実行**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && pnpm build`
Expected: エラーなし

- [ ] **Step 2: サーバーを起動して基本動作を確認**

Run: ビルド済みサーバーを起動し、ブラウザで以下を確認:
1. 3カラムレイアウトが表示される（サイドバー + メイン + Beacon）
2. サイドバーの「+」ボタンでセッション作成ダイアログが開く
3. セッション作成後、メインにttyd iframeが表示される
4. サイドバーのセッションカードにプレビューテキストが表示される（3秒後）
5. Beaconチャットが右カラムに常設表示される
6. モバイル表示が正常（既存MobileLayout）

- [ ] **Step 3: Biomeによるリント確認**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && pnpm biome check --write .`
Expected: 自動修正適用、エラーなし

- [ ] **Step 4: 最終コミット（lint修正があれば）**

```bash
git add -A
git commit -m "fix: biome lint修正"
```
