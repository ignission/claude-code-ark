/**
 * SessionRowMenu - セッション一覧の行メニューの中身
 *
 * PCの右クリック (ContextMenu) と `…`、モバイルの `⋮` (DropdownMenu) で同じ中身を出す。
 * Radixはメニューの種類ごとに内部の文脈が分かれ、ContextMenuItemをDropdownMenuの中では
 * 使えないため、Itemなどの部品をvariantで差し替える。
 * 操作のpropsを渡さなかった項目は出さない。
 */

import {
  CornerLeftUp,
  EyeOff,
  GitBranchPlus,
  Home,
  LayoutGrid,
  MessageSquare,
  Moon,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Trash2,
  Undo2,
} from "lucide-react";
import type { ComponentProps, ComponentType } from "react";
import {
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { m } from "@/lib/i18n";
import type { SessionListEntry } from "@/lib/session-sections";

export interface SessionRowMenuProps {
  variant: "context" | "dropdown";
  entry: SessionListEntry;
  /** セッションがあれば開き、未起動のworktreeなら起動する */
  onOpen: () => void;
  /** この worktree を親にして子タスクを分離する */
  onSplitTask?: () => void;
  /** 子の行で、親のセッションを開く */
  onOpenParent?: () => void;
  /** この worktree をホームにする (lib/home-session.ts) */
  onSetHome?: () => void;
  /** 表示名の編集を始める */
  onStartRename?: () => void;
  /** 手動の休止。rested は今手動で休止にしているか (server の session-rest.ts) */
  rest?: { rested: boolean; onChange: (rested: boolean) => void };
  /** 再起動の確認を開く */
  onRestart?: () => void;
  onCreateWorktree?: () => void;
  /** このリポジトリの全セッションを並べて見る (RepoGridView。PCだけ) */
  onOpenRepoGrid?: () => void;
  /** サイドバーからの除外の確認を開く */
  onRemoveRepo?: () => void;
  /** 削除の確認を開く。セッションがあればセッション、無ければworktreeの削除 */
  onDelete?: () => void;
}

type MenuParts = {
  Group: ComponentType<ComponentProps<typeof ContextMenuGroup>>;
  Item: ComponentType<ComponentProps<typeof ContextMenuItem>>;
  Label: ComponentType<ComponentProps<typeof ContextMenuLabel>>;
  Separator: ComponentType<ComponentProps<typeof ContextMenuSeparator>>;
};

const PARTS_BY_VARIANT: Record<SessionRowMenuProps["variant"], MenuParts> = {
  context: {
    Group: ContextMenuGroup,
    Item: ContextMenuItem,
    Label: ContextMenuLabel,
    Separator: ContextMenuSeparator,
  },
  dropdown: {
    Group: DropdownMenuGroup as MenuParts["Group"],
    Item: DropdownMenuItem as MenuParts["Item"],
    Label: DropdownMenuLabel as MenuParts["Label"],
    Separator: DropdownMenuSeparator as MenuParts["Separator"],
  },
};

export function SessionRowMenu({
  variant,
  entry,
  onOpen,
  onSplitTask,
  onOpenParent,
  onSetHome,
  onStartRename,
  rest,
  onRestart,
  onCreateWorktree,
  onOpenRepoGrid,
  onRemoveRepo,
  onDelete,
}: SessionRowMenuProps) {
  const Menu = PARTS_BY_VARIANT[variant];
  const hasRepoItems =
    onCreateWorktree !== undefined ||
    onOpenRepoGrid !== undefined ||
    onRemoveRepo !== undefined;

  return (
    <>
      <Menu.Group>
        <Menu.Item onSelect={onOpen}>
          {entry.session ? <MessageSquare /> : <Play />}
          {entry.session ? m.session.menu.open : m.session.menu.startSession}
        </Menu.Item>
        {onSplitTask && (
          <Menu.Item onSelect={onSplitTask}>
            <GitBranchPlus />
            {m.session.menu.splitTask}
          </Menu.Item>
        )}
        {onOpenParent && (
          <Menu.Item onSelect={onOpenParent}>
            <CornerLeftUp />
            {m.session.menu.openParent}
          </Menu.Item>
        )}
        {onSetHome && (
          <Menu.Item onSelect={onSetHome}>
            <Home />
            {m.session.menu.setHome}
          </Menu.Item>
        )}
        {onStartRename && (
          <Menu.Item onSelect={onStartRename}>
            <Pencil />
            {m.session.menu.rename}
          </Menu.Item>
        )}
        {rest && (
          <Menu.Item onSelect={() => rest.onChange(!rest.rested)}>
            {rest.rested ? <Undo2 /> : <Moon />}
            {rest.rested ? m.session.menu.unrest : m.session.menu.rest}
          </Menu.Item>
        )}
        {onRestart && (
          <Menu.Item onSelect={onRestart}>
            <RotateCw />
            {m.session.actions.restart}
          </Menu.Item>
        )}
      </Menu.Group>
      {hasRepoItems && (
        <>
          <Menu.Separator />
          <Menu.Group>
            <Menu.Label className="text-xs font-semibold text-muted-foreground">
              {m.session.menu.repository}
            </Menu.Label>
            {onCreateWorktree && (
              <Menu.Item onSelect={onCreateWorktree}>
                <Plus />
                {m.session.menu.newWorktree}
              </Menu.Item>
            )}
            {onOpenRepoGrid && (
              <Menu.Item onSelect={onOpenRepoGrid}>
                <LayoutGrid />
                {m.session.menu.openRepoGrid}
              </Menu.Item>
            )}
            {onRemoveRepo && (
              <Menu.Item onSelect={onRemoveRepo}>
                <EyeOff />
                {m.session.menu.removeFromSidebar}
              </Menu.Item>
            )}
          </Menu.Group>
        </>
      )}
      {onDelete && (
        <>
          <Menu.Separator />
          <Menu.Item variant="destructive" onSelect={onDelete}>
            <Trash2 />
            {entry.session
              ? m.session.actions.deleteSession
              : m.session.actions.deleteWorktree}
          </Menu.Item>
        </>
      )}
    </>
  );
}
