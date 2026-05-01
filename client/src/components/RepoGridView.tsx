/**
 * RepoGridView — リポジトリ選択時のセッショングリッド表示
 *
 * 主 Dashboard でリポジトリヘッダをクリックすると、その repo 配下の全セッションを
 * グリッドで一覧する。各セルは:
 *   - 大きな状態バッジ (TOOL / THINK / AWAITING / IDLE / ERR / STOP) - 一瞥で状態が分かる
 *   - ターミナル末尾プレビュー (静的スナップショット、1.5秒間隔で更新)
 *   - セッション名 + 経過時間
 *
 * セルクリックで selectedSessionId を切替えて従来の TerminalPane に潜る。
 *
 * 軽量化のため ttyd iframe は使わず、サーバ側で tmux capture-pane した
 * プレーンテキストを流し込む (= 操作不可、見るだけ)。
 */

import { Activity, AlertTriangle, Brain, Loader2, Pause } from "lucide-react";
import { useEffect } from "react";
import type {
  BridgeSessionStatus,
  ManagedSession,
  SessionGridSnapshot,
} from "../../../shared/types";

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
  const status: BridgeSessionStatus = snapshot?.status ?? "IDLE";
  const elapsed = snapshot
    ? formatElapsed(snapshot.elapsedMs)
    : formatElapsed(Date.now() - new Date(session.createdAt).getTime());
  const name = snapshot?.name ?? deriveName(session.worktreePath);
  const previewText = snapshot?.previewText ?? "";

  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left bg-card border border-border rounded-lg overflow-hidden hover:border-primary/60 hover:bg-accent/30 transition-colors flex flex-col h-72"
    >
      {/* ヘッダー行: 名前 / branch / 経過時間 */}
      <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2 shrink-0">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{name}</div>
          {branch ? (
            <div className="text-[10px] text-muted-foreground truncate font-mono">
              {branch}
            </div>
          ) : null}
        </div>
        <div className="text-[10px] text-muted-foreground tabular-nums shrink-0">
          {elapsed}
        </div>
      </div>

      {/* 大きな状態バッジ */}
      <div className="px-3 py-2 border-b border-border shrink-0">
        <StatusBadge status={status} />
      </div>

      {/* ターミナルプレビュー */}
      <div className="flex-1 min-h-0 overflow-hidden bg-black/40 text-foreground/80">
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
// 状態バッジ
// ─────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  BridgeSessionStatus,
  {
    label: string;
    sublabel: string;
    bgClass: string;
    fgClass: string;
    Icon: React.ComponentType<{ className?: string }>;
    spin?: boolean;
  }
> = {
  // サイドバー左ドットの配色に合わせる:
  //   緑 (bg-green-500) = 動作中 → TOOL / THINK
  //   赤 (bg-red-500)   = 入力待ち → IDLE / ERR
  // AWAITING は新概念なのでサイドバーに対応色がない。橙で強調 + 点滅。
  TOOL: {
    label: "実行中",
    sublabel: "tool calls running",
    bgClass: "bg-green-500/15 border-green-500/40",
    fgClass: "text-green-300",
    Icon: Loader2,
    spin: true,
  },
  THINK: {
    label: "思考中",
    sublabel: "pondering",
    bgClass: "bg-green-500/15 border-green-500/40",
    fgClass: "text-green-300",
    Icon: Brain,
  },
  AWAITING: {
    label: "判断要",
    sublabel: "awaiting decision",
    // 最も目立たせる: オレンジ太枠 (サイドバーに対応色なし)
    bgClass: "bg-orange-500/25 border-orange-500/70 border-2",
    fgClass: "text-orange-200",
    Icon: AlertTriangle,
  },
  IDLE: {
    label: "入力待ち",
    sublabel: "waiting for input",
    bgClass: "bg-red-500/15 border-red-500/40",
    fgClass: "text-red-300",
    Icon: Activity,
  },
  READY: {
    label: "待機",
    sublabel: "ready (empty)",
    // /clear 直後など、何もしていない状態。サイドバーの青ドットに対応するが
    // グレー寄りに抑えて「特にアクション不要」を示す。
    bgClass: "bg-neutral-500/15 border-neutral-500/40",
    fgClass: "text-neutral-400",
    Icon: Activity,
  },
  ERR: {
    label: "エラー",
    sublabel: "error detected",
    bgClass: "bg-red-500/25 border-red-500/60",
    fgClass: "text-red-200",
    Icon: AlertTriangle,
  },
  STOP: {
    label: "停止",
    sublabel: "session stopped",
    bgClass: "bg-neutral-500/15 border-neutral-500/40",
    fgClass: "text-neutral-300",
    Icon: Pause,
  },
};

function StatusBadge({ status }: { status: BridgeSessionStatus }) {
  const cfg = STATUS_CONFIG[status];
  const Icon = cfg.Icon;
  return (
    <div
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md border ${cfg.bgClass} ${cfg.fgClass}`}
    >
      <Icon className={`w-4 h-4 ${cfg.spin ? "animate-spin" : ""}`} />
      <div className="leading-tight">
        <div className="text-sm font-semibold">{cfg.label}</div>
        <div className="text-[10px] opacity-70">{cfg.sublabel}</div>
      </div>
    </div>
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
