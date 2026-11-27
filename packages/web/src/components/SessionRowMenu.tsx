/**
 * SessionRowMenu - セッション一覧の行メニューの中身
 *
 * PCの右クリック (ContextMenu) と `…`、モバイルの `⋮` (DropdownMenu) で同じ中身を出す。
 * Radixはメニューの種類ごとに内部の文脈が分かれ、ContextMenuItemをDropdownMenuの中では
 * 使えないため、Itemなどの部品をvariantで差し替える。
 * 操作のpropsを渡さなかった項目は出さない。
 * リポジトリの操作 (新しいタスク、ホームにする、除外など) は行ではなく見出しのメニューにある
 * (RepoHeadingMenu.tsx。mainの行を出さないので、行が無いリポジトリでも使えるように)。
 */

import {
  GitBranchPlus,
  MessageSquare,
  Moon,
  Pencil,
  Play,
  RotateCw,
  Trash2,
  Undo2,
} from "lucide-react";
import type { ComponentProps, ComponentType } from "react";
import {
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
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
  /** 表示名の編集を始める */
  onStartRename?: () => void;
  /** 手動の休止。rested は今手動で休止にしているか (server の session-rest.ts) */
  rest?: { rested: boolean; onChange: (rested: boolean) => void };
  /** 再起動の確認を開く */
  onRestart?: () => void;
  /** 削除の確認を開く。セッションがあればセッション、無ければworktreeの削除 */
  onDelete?: () => void;
}

type MenuParts = {
  Group: ComponentType<ComponentProps<typeof ContextMenuGroup>>;
  Item: ComponentType<ComponentProps<typeof ContextMenuItem>>;
  Separator: ComponentType<ComponentProps<typeof ContextMenuSeparator>>;
};

const PARTS_BY_VARIANT: Record<SessionRowMenuProps["variant"], MenuParts> = {
  context: {
    Group: ContextMenuGroup,
    Item: ContextMenuItem,
    Separator: ContextMenuSeparator,
  },
  dropdown: {
    Group: DropdownMenuGroup as MenuParts["Group"],
    Item: DropdownMenuItem as MenuParts["Item"],
    Separator: DropdownMenuSeparator as MenuParts["Separator"],
  },
};

export function SessionRowMenu({
  variant,
  entry,
  onOpen,
  onSplitTask,
  onStartRename,
  rest,
  onRestart,
  onDelete,
}: SessionRowMenuProps) {
  const Menu = PARTS_BY_VARIANT[variant];

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
