# ゴーストリソース防止: PC/モバイル表示統一 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PC側サイドバーをworktree中心の表示に変更し、モバイルと同じくセッションのないworktreeも表示することでゴーストリソースを防止する

**Architecture:** SessionSidebarのイテレーション対象を`sessions` Mapから`worktrees`配列に変更し、各worktreeに対してsession lookupを行う。SessionCardにsession未作成状態のハンドリングを追加。他リポジトリのアクティブセッションは引き続き表示する。

**Tech Stack:** React 19, TypeScript, TailwindCSS 4, shadcn/ui

---

## 現状の問題

- **PC (SessionSidebar)**: `sessions` Mapをイテレート → セッションのないworktreeが非表示
- **モバイル (MobileSessionList)**: `worktrees`配列をイテレート → 全worktree表示
- セッション停止後、worktreeは残るがPC側で不可視になる（ゴーストリソース）

## ファイル構成

| ファイル | 変更種別 | 変更内容 |
|---------|---------|---------|
| `client/src/components/SessionSidebar.tsx` | Modify | worktree中心のイテレーションに変更、`onStartSession`追加 |
| `client/src/components/SessionCard.tsx` | Modify | `session`をoptionalに、未起動状態の表示追加 |
| `client/src/pages/Dashboard.tsx` | Modify | SessionSidebarに`onStartSession`を渡す |

---

### Task 1: SessionCard — session optionalハンドリング

**Files:**
- Modify: `client/src/components/SessionCard.tsx`

- [ ] **Step 1: SessionCardPropsのsessionをoptionalに変更**

`SessionCard.tsx`のインターフェースを変更する。sessionがない場合は`worktree`が必須。

```typescript
interface SessionCardProps {
  session: ManagedSession | null;
  worktree: Worktree | undefined;
  repoList: string[];
  isSelected: boolean;
  previewText: string;
  activityText: string;
  onClick: () => void;
  onStop: () => void;
  onStart?: () => void;  // セッション未起動時の開始ハンドラー
}
```

- [ ] **Step 2: session未起動時のレンダリング分岐を追加**

SessionCard関数内の先頭部分を変更。sessionがnullの場合はシンプルなworktreeカードを表示する。

```typescript
export function SessionCard({
  session,
  worktree,
  isSelected,
  previewText,
  activityText,
  onClick,
  onStop,
  onStart,
}: SessionCardProps) {
  const branch =
    worktree?.branch ||
    (session
      ? session.worktreePath.substring(session.worktreePath.lastIndexOf("/") + 1)
      : "unknown");

  // セッション未起動の場合はシンプルなカードを表示
  if (!session) {
    return (
      <button
        type="button"
        className={`w-full text-left p-3 rounded-lg transition-colors group ${
          isSelected
            ? "bg-primary/15 border border-primary/30"
            : "hover:bg-sidebar-accent/50"
        }`}
        onClick={onStart ?? onClick}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-2 h-2 rounded-full shrink-0 bg-muted-foreground/30" />
          <span className="text-sm font-mono truncate text-sidebar-foreground/60">
            {branch}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground truncate pl-4">
          セッション未起動
        </p>
      </button>
    );
  }

  // 以下、既存のsessionありロジックをそのまま維持
  // ...
```

- [ ] **Step 3: 型チェック実行**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && pnpm check`
Expected: PASS（SessionCard内部の変更のみなので、呼び出し元に影響なし）

- [ ] **Step 4: コミット**

```bash
git add client/src/components/SessionCard.tsx
git commit -m "feat: SessionCardにセッション未起動状態の表示を追加"
```

---

### Task 2: SessionSidebar — worktree中心のイテレーションに変更

**Files:**
- Modify: `client/src/components/SessionSidebar.tsx`

- [ ] **Step 1: SessionSidebarPropsにonStartSessionを追加**

```typescript
interface SessionSidebarProps {
  sessions: Map<string, ManagedSession>;
  worktrees: Worktree[];
  repoList: string[];
  selectedSessionId: string | null;
  sessionPreviews: Map<string, string>;
  sessionActivityTexts: Map<string, string>;
  onSelectSession: (sessionId: string) => void;
  onStopSession: (sessionId: string) => void;
  onStartSession: (worktree: Worktree) => void;  // 追加
  onDeleteWorktree: (worktreePath: string) => void;
  onNewSession: () => void;
}
```

- [ ] **Step 2: sessionByWorktreeIdマップを追加**

MobileSessionListと同じパターンで、worktreeIdからsessionを引けるようにする。

```typescript
// worktreeId → session のルックアップ
const sessionByWorktreeId = useMemo(() => {
  const map = new Map<string, ManagedSession>();
  sessions.forEach(session => {
    map.set(session.worktreeId, session);
  });
  return map;
}, [sessions]);
```

- [ ] **Step 3: groupedSessionsをworktree中心に変更**

worktrees配列をイテレートし、各worktreeに対してsessionを検索。他リポジトリのセッションも表示するために、worktreeに紐づかないセッションも別グループに追加。

```typescript
// 選択中リポジトリのworktree + 他リポジトリのセッションをグルーピング
const groupedItems = useMemo(() => {
  const groups = new Map<string, { worktree: Worktree; session: ManagedSession | null }[]>();
  const worktreeSessionIds = new Set<string>();

  // 1. 選択中リポのworktreeを表示（セッションの有無問わず）
  for (const wt of worktrees) {
    const session = sessionByWorktreeId.get(wt.id) ?? null;
    if (session) worktreeSessionIds.add(session.id);
    const repo = session?.repoPath ?? findRepoForSession(session ?? { worktreePath: wt.path } as ManagedSession, repoList);
    const repoName = repo ? getBaseName(repo) : repoList.length > 0 ? getBaseName(repoList[0]) : "unknown";
    const existing = groups.get(repoName) || [];
    existing.push({ worktree: wt, session });
    groups.set(repoName, existing);
  }

  // 2. 他リポジトリのセッション（worktreesに含まれないもの）
  for (const session of Array.from(sessions.values())) {
    if (worktreeSessionIds.has(session.id)) continue;
    const repo = session.repoPath ?? findRepoForSession(session, repoList);
    const repoName = repo ? getBaseName(repo) : "unknown";
    const existing = groups.get(repoName) || [];
    existing.push({ worktree: undefined as unknown as Worktree, session });
    groups.set(repoName, existing);
  }

  return groups;
}, [worktrees, sessions, sessionByWorktreeId, repoList]);
```

- [ ] **Step 4: レンダリング部分をgroupedItemsに合わせて更新**

groupedSessionsをgroupedItemsに変更し、SessionCardへのprops渡しを調整。

```tsx
{sessions.size === 0 && worktrees.length === 0 ? (
  <div className="p-8 text-center text-muted-foreground text-sm">
    <Terminal className="w-8 h-8 mx-auto mb-3 opacity-50" />
    <p>セッションがありません</p>
    <p className="text-xs mt-1">「+」から新規作成</p>
  </div>
) : (
  Array.from(groupedItems.entries()).map(
    ([repoName, items]) => (
      <div key={repoName} className="mb-3">
        <div className="flex items-center gap-1.5 px-2 py-1.5">
          <FolderOpen className="w-3 h-3 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider truncate">
            {repoName}
          </span>
        </div>
        <div className="space-y-1">
          {items.map(({ worktree: wt, session }) => (
            <SessionCard
              key={session?.id ?? wt.id}
              session={session}
              worktree={wt}
              repoList={repoList}
              isSelected={session ? selectedSessionId === session.id : false}
              previewText={session ? (sessionPreviews.get(session.id) || "") : ""}
              activityText={session ? (sessionActivityTexts.get(session.id) || "") : ""}
              onClick={() => session && onSelectSession(session.id)}
              onStop={() => session && onStopSession(session.id)}
              onStart={() => wt && onStartSession(wt)}
            />
          ))}
        </div>
      </div>
    )
  )
)}
```

- [ ] **Step 5: 不要になったgetWorktreeヘルパーを削除**

L42-44の`getWorktree`関数は不要になるので削除する。

- [ ] **Step 6: 型チェック実行**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && pnpm check`
Expected: FAIL（中間状態） — Dashboard.tsxがonStartSessionを渡していないため（Task 3で解消）

- [ ] **Step 7: コミット（WIP）**

```bash
git add client/src/components/SessionSidebar.tsx
git commit -m "feat: SessionSidebarをworktree中心のイテレーションに変更"
```

---

### Task 3: Dashboard.tsx — onStartSessionの接続

**Files:**
- Modify: `client/src/pages/Dashboard.tsx`

- [ ] **Step 1: SessionSidebarにonStartSessionを渡す**

Dashboard.tsxのSessionSidebarコンポーネント呼び出し（L258-272）にonStartSessionを追加。

```tsx
<SessionSidebar
  sessions={sessions}
  worktrees={worktrees}
  repoList={repoList}
  selectedSessionId={selectedSessionId}
  sessionPreviews={sessionPreviews}
  sessionActivityTexts={sessionActivityTexts}
  onSelectSession={setSelectedSessionId}
  onStopSession={handleStopSession}
  onStartSession={handleStartSession}
  onDeleteWorktree={path => {
    const wt = worktrees.find(w => w.path === path);
    if (wt) handleDeleteWorktree(wt);
  }}
  onNewSession={handleNewSession}
/>
```

`handleStartSession`は既にDashboard.tsx L204-212に定義済みで、`Worktree`を引数に取る。

- [ ] **Step 2: 型チェック実行**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && pnpm check`
Expected: PASS

- [ ] **Step 3: ビルド実行**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && pnpm build`
Expected: PASS

- [ ] **Step 4: コミット**

```bash
git add client/src/pages/Dashboard.tsx
git commit -m "feat: SessionSidebarにonStartSessionを接続"
```

---

### Task 4: 動作確認

- [ ] **Step 1: ビルドしてpm2再起動**

```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager
pkill -f ttyd
pnpm build
pm2 restart claude-code-ark
```

- [ ] **Step 2: PC表示の動作確認**

確認項目:
1. セッションのあるworktreeが従来通り表示される（dotColor、previewText等）
2. セッションのないworktreeが「セッション未起動」状態で表示される
3. セッション未起動のworktreeをクリックするとセッションが開始される
4. 他リポジトリのアクティブセッションが引き続き表示される

- [ ] **Step 3: モバイル表示との整合性確認**

確認項目:
1. PC・モバイルで同じworktreeが表示される
2. セッション停止後、PC・モバイル両方でworktreeが残る
3. test1 worktreeがPC・モバイル両方で見える
