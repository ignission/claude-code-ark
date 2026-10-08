import type { GitRefs } from "@ark/shared";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  FilePenLine,
  GitBranch,
  GitCommitHorizontal,
  Tag,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type { GitSelection } from "./types";

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
}

type GroupId = "branches" | "remotes" | "tags" | "stashes";

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
    const groups = new Map<
      string,
      { name: string; short: string; sha: string }[]
    >();
    for (const remote of refs?.remotes ?? []) {
      const slash = remote.name.indexOf("/");
      const host = slash === -1 ? remote.name : remote.name.slice(0, slash);
      const short = slash === -1 ? remote.name : remote.name.slice(slash + 1);
      if (short === "HEAD") continue;
      const list = groups.get(host) ?? [];
      list.push({ name: remote.name, short, sha: remote.sha });
      groups.set(host, list);
    }
    return [...groups.entries()];
  }, [refs]);

  const selectedSha = selection?.kind === "commit" ? selection.sha : null;
  const refRow = (
    key: string,
    sha: string,
    depth: number,
    content: ReactNode,
    title: string
  ) => (
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
      className="flex h-full flex-col overflow-y-auto overflow-x-hidden bg-background py-1"
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

      <div className="my-1 border-border border-t" />

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
              : branch.name
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
                    {remote.short}
                  </span>
                </>,
                remote.name
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
