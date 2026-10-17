import type { GitRefs } from "@ark/shared";
import {
  Archive,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  FilePenLine,
  GitBranch,
  GitBranchPlus,
  GitCommitHorizontal,
  Pencil,
  Tag,
  Trash2,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import type { GitSelection } from "./types";
import type { GitOpsActions } from "./useGitOps";

interface GitSidebarProps {
  refs: GitRefs | null;
  /** 未コミットの変更の数 (ステージ済み + 変更 + 未追跡) */
  changeCount: number;
  selection: GitSelection | null;
  onSelectWorking: () => void;
  /** 「すべてのコミット」。一覧の先頭 (HEAD) へ戻る */
  onShowAll: () => void;
  /** ref を押した。そのコミットを一覧で選んでスクロールする */
  onSelectSha: (sha: string) => void;
  /** ブランチの右クリックの操作。渡さなければメニューを出さない */
  ops?: GitOpsActions;
  /** リモートの操作の最中。サーバーは同じ worktree の操作を重ねず断るので、どの操作も押せなくする */
  remoteBusy?: boolean;
}

type GroupId = "branches" | "remotes" | "tags" | "stashes";

type LocalBranch = GitRefs["branches"][number];

type RemoteBranch = GitRefs["remotes"][number];

const GROUPS_KEY = "ark-git-sidebar-groups";

/** 折りたたんでいるグループ。保存が無い / 読めないときは全部開く */
function loadCollapsedGroups(): Set<GroupId> {
  try {
    const raw = localStorage.getItem(GROUPS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((v): v is GroupId => typeof v === "string")
        : []
    );
  } catch {
    return new Set();
  }
}

function saveCollapsedGroups(groups: Set<GroupId>): void {
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify([...groups]));
  } catch {
    // 保存できなくても動作には影響しない
  }
}

/** FileTree と同じ詰まり具合 (26px・13px) */
const ROW =
  "flex h-[26px] w-full shrink-0 items-center gap-1.5 pr-2 text-left text-[13px] hover:bg-muted/60";

/**
 * Git タブのサイドバー。変更・すべてのコミットと、ブランチ / リモート / タグ / スタッシュ。
 * ref を押すと、そのコミットへ一覧が飛ぶ
 */
export function GitSidebar({
  refs,
  changeCount,
  selection,
  onSelectWorking,
  onShowAll,
  onSelectSha,
  ops,
  remoteBusy = false,
}: GitSidebarProps) {
  const [collapsed, setCollapsed] = useState(loadCollapsedGroups);
  const toggleGroup = (id: GroupId) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveCollapsedGroups(next);
      return next;
    });
  };

  // リモートのブランチを、リモートの名前ごとにまとめる (origin/HEAD は出さない)
  const remoteGroups = useMemo(() => {
    const groups = new Map<string, RemoteBranch[]>();
    for (const remote of refs?.remotes ?? []) {
      if (remote.branch === "HEAD") continue;
      const list = groups.get(remote.remote) ?? [];
      list.push(remote);
      groups.set(remote.remote, list);
    }
    return [...groups.entries()];
  }, [refs]);

  const selectedSha = selection?.kind === "commit" ? selection.sha : null;
  /** ref の行。menu を渡すと右クリックでそのメニューを出す */
  const refRow = (
    key: string,
    sha: string,
    depth: number,
    content: ReactNode,
    title: string,
    menu?: ReactNode
  ) => {
    const row = (
      <button
        key={key}
        type="button"
        title={title}
        data-sha={sha}
        onClick={() => onSelectSha(sha)}
        className={cn(ROW, sha === selectedSha && "bg-muted")}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        {content}
      </button>
    );
    if (!menu) return row;
    return (
      <ContextMenu key={key}>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        <ContextMenuContent className="min-w-48">{menu}</ContextMenuContent>
      </ContextMenu>
    );
  };

  const group = (
    id: GroupId,
    label: string,
    count: number,
    children: () => ReactNode
  ) => {
    const open = !collapsed.has(id);
    return (
      <section key={id} data-group={id}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => toggleGroup(id)}
          className="flex h-[26px] w-full items-center gap-1 pr-2 pl-1.5 text-left font-semibold text-[11px] text-muted-foreground uppercase tracking-wide hover:text-foreground"
        >
          {open ? (
            <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
          )}
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <span className="font-normal tabular-nums">{count}</span>
        </button>
        {open && children()}
      </section>
    );
  };

  return (
    <nav
      aria-label="Git の参照"
      className="flex h-full flex-col overflow-y-auto overflow-x-hidden py-1"
    >
      <button
        type="button"
        onClick={onSelectWorking}
        aria-current={selection?.kind === "working" ? "true" : undefined}
        className={cn(ROW, "pl-2", selection?.kind === "working" && "bg-muted")}
      >
        <FilePenLine
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate">
          変更{changeCount > 0 && ` (${changeCount})`}
        </span>
      </button>
      <button type="button" onClick={onShowAll} className={cn(ROW, "pl-2")}>
        <GitCommitHorizontal
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate">すべてのコミット</span>
      </button>

      <div className="h-2 shrink-0" />

      {group("branches", "ブランチ", refs?.branches.length ?? 0, () =>
        (refs?.branches ?? []).map(branch =>
          refRow(
            `branch:${branch.name}`,
            branch.sha,
            1,
            <>
              {branch.current ? (
                <Check
                  className="size-3.5 shrink-0 text-primary"
                  strokeWidth={3}
                  aria-label="いまのブランチ"
                />
              ) : (
                <GitBranch
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  branch.current && "font-semibold"
                )}
              >
                {branch.name}
              </span>
              {((branch.ahead ?? 0) > 0 || (branch.behind ?? 0) > 0) && (
                <span
                  data-testid="git-ahead-behind"
                  className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
                >
                  {[
                    (branch.ahead ?? 0) > 0 ? `↑${branch.ahead}` : "",
                    (branch.behind ?? 0) > 0 ? `↓${branch.behind}` : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                </span>
              )}
            </>,
            branch.upstream
              ? `${branch.name} → ${branch.upstream}`
              : branch.name,
            ops && (
              <BranchMenu branch={branch} ops={ops} remoteBusy={remoteBusy} />
            )
          )
        )
      )}

      {group("remotes", "リモート", refs?.remotes.length ?? 0, () =>
        remoteGroups.map(([host, branches]) => (
          <div key={host} data-remote={host}>
            <div className="flex h-[26px] items-center gap-1.5 pr-2 pl-[22px] text-[13px] text-muted-foreground">
              <Cloud className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{host}</span>
            </div>
            {branches.map(remote =>
              refRow(
                `remote:${remote.name}`,
                remote.sha,
                2,
                <>
                  <GitBranch
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {remote.branch}
                  </span>
                </>,
                remote.name,
                ops && (
                  <RemoteBranchMenu
                    remote={remote}
                    ops={ops}
                    remoteBusy={remoteBusy}
                  />
                )
              )
            )}
          </div>
        ))
      )}

      {group("tags", "タグ", refs?.tags.length ?? 0, () =>
        (refs?.tags ?? []).map(tag =>
          refRow(
            `tag:${tag.name}`,
            tag.sha,
            1,
            <>
              <Tag
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate">{tag.name}</span>
            </>,
            tag.name
          )
        )
      )}

      {group("stashes", "スタッシュ", refs?.stashes.length ?? 0, () =>
        (refs?.stashes ?? []).map(stash =>
          refRow(
            `stash:${stash.name}`,
            stash.sha,
            1,
            <>
              <Archive
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate">
                {stash.subject || stash.name}
              </span>
            </>,
            `${stash.name}: ${stash.subject}`
          )
        )
      )}
    </nav>
  );
}

const ITEM_ICON = "size-4 text-muted-foreground";

/**
 * ローカルのブランチのメニュー。いまのブランチと、別の作業ツリー (別のセッション) で
 * 使っているブランチは消せない (git が断る) ので、項目を無効にして理由を出す
 */
function BranchMenu({
  branch,
  ops,
  remoteBusy,
}: {
  branch: LocalBranch;
  ops: GitOpsActions;
  remoteBusy: boolean;
}) {
  const inUse = branch.current
    ? "いまのブランチは削除できません"
    : branch.worktreePath
      ? `ほかの作業ツリーで使用中 (${branch.worktreePath})`
      : null;
  return (
    <>
      <ContextMenuItem
        disabled={remoteBusy}
        onSelect={() => ops.createBranchAt(branch.sha)}
      >
        <GitBranchPlus className={ITEM_ICON} aria-hidden="true" />
        ここから新しいブランチ
      </ContextMenuItem>
      <ContextMenuItem
        disabled={remoteBusy}
        onSelect={() => ops.renameBranch(branch.name)}
      >
        <Pencil className={ITEM_ICON} aria-hidden="true" />
        名前を変更
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        disabled={remoteBusy}
        onSelect={() => ops.pushBranch(branch.name)}
      >
        <ArrowUpFromLine className={ITEM_ICON} aria-hidden="true" />
        push
        {!branch.upstream && (
          <span className="ml-auto text-muted-foreground text-xs">新規</span>
        )}
      </ContextMenuItem>
      {branch.current && (
        <ContextMenuItem disabled={remoteBusy} onSelect={() => ops.pull()}>
          <ArrowDownToLine className={ITEM_ICON} aria-hidden="true" />
          pull (fast-forward)
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        variant="destructive"
        disabled={inUse !== null || remoteBusy}
        title={inUse ?? undefined}
        onSelect={() => ops.deleteBranch(branch.name)}
      >
        <Trash2 className="size-4" aria-hidden="true" />
        削除
      </ContextMenuItem>
      {inUse && (
        <div className="px-2 pb-1.5 text-[11px] text-muted-foreground">
          {inUse}
        </div>
      )}
    </>
  );
}

/** リモートのブランチのメニュー。既定のブランチ (`origin/HEAD` の指す先) は消せない */
function RemoteBranchMenu({
  remote,
  ops,
  remoteBusy,
}: {
  remote: RemoteBranch;
  ops: GitOpsActions;
  remoteBusy: boolean;
}) {
  return (
    <>
      <ContextMenuItem
        disabled={remoteBusy}
        onSelect={() => ops.createBranchAt(remote.sha)}
      >
        <GitBranchPlus className={ITEM_ICON} aria-hidden="true" />
        ここから新しいブランチ
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        variant="destructive"
        disabled={remote.isDefault || remoteBusy}
        onSelect={() => ops.deleteRemoteBranch(remote.remote, remote.branch)}
      >
        <Trash2 className="size-4" aria-hidden="true" />
        リモートから削除
      </ContextMenuItem>
      {remote.isDefault && (
        <div className="px-2 pb-1.5 text-[11px] text-muted-foreground">
          リモートの既定のブランチは削除できません
        </div>
      )}
    </>
  );
}
