/**
 * RepoHeadingMenu - セッション一覧のリポジトリの見出しに付ける「+」と `…` のメニュー
 *
 * 一覧はmainのworktreeを行にしないので (lib/session-sections.ts)、リポジトリ単位の操作は
 * 行ではなく見出しに置く。行が1つも無いリポジトリでも、ここから新しいタスクを始められる。
 * 「+」はそのリポジトリで新しいタスクのダイアログを開く。メニューの中身は、渡した操作だけを出す。
 * sidebar はかたまりにポインタを載せたときだけ出す (行の `…` と同じ)。card は指で押すので常に出す。
 */

import {
  Ellipsis,
  EyeOff,
  FolderPlus,
  Home,
  LayoutGrid,
  MoreVertical,
  Plus,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { m } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface RepoHeadingMenuProps {
  variant: "sidebar" | "card";
  repoName: string;
  /** このリポジトリで新しいタスクのダイアログを開く */
  onNewTask?: () => void;
  /** mainのworktreeをホームにする (lib/home-session.ts)。mainが分からないか、既にホームなら渡さない */
  onSetHome?: () => void;
  onCreateWorktree?: () => void;
  /** このリポジトリの全セッションを並べて見る (RepoGridView。PCだけ) */
  onOpenRepoGrid?: () => void;
  /** サイドバーからの除外の確認を開く */
  onRemoveRepo?: () => void;
}

export function RepoHeadingMenu({
  variant,
  repoName,
  onNewTask,
  onSetHome,
  onCreateWorktree,
  onOpenRepoGrid,
  onRemoveRepo,
}: RepoHeadingMenuProps) {
  const buttonClass = cn(
    "inline-flex shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground",
    variant === "sidebar"
      ? "h-6 w-6 opacity-0 group-hover/repo:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
      : "h-9 w-9"
  );
  const hasMenuItems =
    onSetHome !== undefined ||
    onCreateWorktree !== undefined ||
    onOpenRepoGrid !== undefined ||
    onRemoveRepo !== undefined;
  const hasViewItems =
    onOpenRepoGrid !== undefined || onRemoveRepo !== undefined;
  const hasCreateItems =
    onSetHome !== undefined || onCreateWorktree !== undefined;

  return (
    <>
      {onNewTask && (
        <button
          type="button"
          onClick={onNewTask}
          aria-label={m.session.repoMenu.newTaskLabel(repoName)}
          title={m.session.repoMenu.newTaskLabel(repoName)}
          className={buttonClass}
        >
          <Plus className="size-4" aria-hidden="true" />
        </button>
      )}
      {hasMenuItems && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={m.session.repoMenu.label(repoName)}
              className={buttonClass}
            >
              {variant === "sidebar" ? (
                <Ellipsis className="size-4" />
              ) : (
                <MoreVertical className="size-5" />
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            {onSetHome && (
              <DropdownMenuItem onSelect={onSetHome}>
                <Home />
                {m.session.repoMenu.setHome}
              </DropdownMenuItem>
            )}
            {onCreateWorktree && (
              <DropdownMenuItem onSelect={onCreateWorktree}>
                <FolderPlus />
                {m.session.repoMenu.newWorktree}
              </DropdownMenuItem>
            )}
            {hasCreateItems && hasViewItems && <DropdownMenuSeparator />}
            {onOpenRepoGrid && (
              <DropdownMenuItem onSelect={onOpenRepoGrid}>
                <LayoutGrid />
                {m.session.repoMenu.openRepoGrid}
              </DropdownMenuItem>
            )}
            {onRemoveRepo && (
              <DropdownMenuItem onSelect={onRemoveRepo}>
                <EyeOff />
                {m.session.repoMenu.removeFromSidebar}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}
