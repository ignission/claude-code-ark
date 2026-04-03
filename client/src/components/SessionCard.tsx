import type { ManagedSession, Worktree } from "../../../shared/types";

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
  isSelected,
  previewText,
  onClick,
  onStop,
}: SessionCardProps) {
  // ブランチ名のみ表示（リポジトリ名はサイドバーのグループヘッダーで表示）
  const branch =
    worktree?.branch ||
    session.worktreePath.substring(session.worktreePath.lastIndexOf("/") + 1);

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
        <div
          className={`w-2 h-2 rounded-full shrink-0 ${statusColor(session.status)}`}
        />
        <span className="text-sm font-mono truncate text-sidebar-foreground">
          {branch}
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
