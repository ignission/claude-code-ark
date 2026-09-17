/**
 * RepoGridView — リポジトリ選択時のセッショングリッド表示
 *
 * 行のメニューの「このリポジトリの全セッションを並べて見る」を選ぶと、その repo 配下の
 * 全セッションをグリッドで一覧する。各セルは:
 *   - 状態チップ (lib/status-tone の対応表。PCサイドバー・モバイル一覧と同じ文言と色)
 *   - ターミナル末尾プレビュー (静的スナップショット、1.5秒間隔で更新)
 *   - セッション名 + 経過時間
 *
 * セルクリックで selectedSessionId を切替えて従来の TerminalPane に潜る。
 *
 * 軽量化のため ttyd iframe は使わず、サーバ側で tmux capture-pane した
 * プレーンテキストを流し込む (= 操作不可、見るだけ)。
 */

import type { ManagedSession, SessionGridSnapshot } from "@ark/shared";
import { useEffect } from "react";
import { resolveStatusKey } from "@/lib/status-tone";
import { StatusChip } from "./StatusChip";

interface RepoGridViewProps {
  /** 表示対象のリポジトリ絶対パス (ヘッダ表示用) */
  repoPath: string;
  /** 表示対象のセッション一覧 (このリポジトリのもの) */
  sessions: ManagedSession[];
  /** Worktree マップ (worktreeId → branch名) */
  worktreeBranchById: Map<string, string>;
  /** サーバから配信中のスナップショット (mount 中だけ購読) */
  snapshots: Map<string, SessionGridSnapshot>;
  /** マウント時に購読、アンマウント時に解除 */
  onSubscribe: () => void;
  onUnsubscribe: () => void;
  /** セルクリックでフルターミナル表示に切替 */
  onSelectSession: (sessionId: string) => void;
}

export function RepoGridView({
  repoPath,
  sessions,
  worktreeBranchById,
  snapshots,
  onSubscribe,
  onUnsubscribe,
  onSelectSession,
}: RepoGridViewProps) {
  // RepoGridView 表示中だけ session:grid:snapshot を購読する
  // (常時購読すると pane polling が二重化するため)
  useEffect(() => {
    onSubscribe();
    return () => onUnsubscribe();
  }, [onSubscribe, onUnsubscribe]);

  const repoName = repoPath.split("/").filter(Boolean).pop() ?? repoPath;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-background/40 flex items-baseline gap-2 shrink-0">
        <h2 className="text-base font-semibold">{repoName}</h2>
        <span className="text-xs text-muted-foreground truncate">
          {repoPath}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {sessions.length} sessions
        </span>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {sessions.length === 0 ? (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
            このリポジトリにはまだセッションがありません
          </div>
        ) : (
          <div className="grid gap-4 grid-cols-1 md:grid-cols-2 2xl:grid-cols-3">
            {sessions.map(session => (
              <SessionCell
                key={session.id}
                session={session}
                branch={worktreeBranchById.get(session.worktreeId)}
                snapshot={snapshots.get(session.id)}
                onClick={() => onSelectSession(session.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// セル
// ─────────────────────────────────────────────────────────────────

function SessionCell({
  session,
  branch,
  snapshot,
  onClick,
}: {
  session: ManagedSession;
  branch: string | undefined;
  snapshot: SessionGridSnapshot | undefined;
  onClick: () => void;
}) {
  // スナップショットが未着のあいだは IDLE と決めつけず、未着 (文言なしの印) として出す
  const statusKey = resolveStatusKey(true, snapshot?.status);
  const elapsed = snapshot
    ? formatElapsed(snapshot.elapsedMs)
    : formatElapsed(Date.now() - new Date(session.createdAt).getTime());
  const name = snapshot?.name ?? deriveName(session.worktreePath);
  const previewText = snapshot?.previewText ?? "";

  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left bg-card border border-border rounded-lg shadow-card overflow-hidden hover:border-primary/60 hover:bg-accent/30 transition-colors flex flex-col h-72"
    >
      {/* ヘッダー行: 名前 / branch / 経過時間 */}
      <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2 shrink-0">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{name}</div>
          {branch ? (
            <div className="text-xs text-muted-foreground truncate">
              {branch}
            </div>
          ) : null}
        </div>
        <div className="text-xs text-muted-foreground tabular-nums shrink-0">
          {elapsed}
        </div>
      </div>

      {/* 状態チップ */}
      <div className="px-3 py-2 border-b border-border shrink-0">
        <StatusChip statusKey={statusKey} />
      </div>

      {/* ターミナルプレビュー */}
      <div className="flex-1 min-h-0 overflow-hidden bg-muted text-foreground/80">
        {previewText ? (
          <pre className="text-[10px] leading-tight font-mono p-2 whitespace-pre overflow-hidden h-full">
            {previewText}
          </pre>
        ) : (
          <div className="h-full flex items-center justify-center text-[10px] text-muted-foreground">
            (no output)
          </div>
        )}
      </div>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────
// 補助
// ─────────────────────────────────────────────────────────────────

function deriveName(worktreePath: string): string {
  return worktreePath.split("/").filter(Boolean).pop() ?? worktreePath;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
