/**
 * SessionRowMenu - セッション一覧の行メニューの中身
 *
 * PCの右クリック (ContextMenu) と `…`、モバイルの `⋮` (DropdownMenu) で同じ中身を出す。
 * Radixはメニューの種類ごとに内部の文脈が分かれ、ContextMenuItemをDropdownMenuの中では
 * 使えないため、Itemなどの部品をvariantで差し替える。
 * 操作のpropsを渡さなかった項目は出さない。
 */

import type { Profile } from "@ark/shared";
import {
  Bell,
  BellOff,
  Check,
  CornerLeftUp,
  EyeOff,
  GitBranchPlus,
  LayoutGrid,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Settings,
  Trash2,
  UserRound,
} from "lucide-react";
import type { ComponentProps, ComponentType } from "react";
import {
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { m } from "@/lib/i18n";
import type { SessionListEntry } from "@/lib/session-sections";
import { cn } from "@/lib/utils";

export interface ProfileChoice {
  profiles: Profile[];
  /** いま選ばれているプロファイル。未設定はnull */
  currentProfileId: string | null;
  onSelect: (profileId: string | null) => void;
}

export interface SessionRowMenuProps {
  variant: "context" | "dropdown";
  entry: SessionListEntry;
  /** セッションがあれば開き、未起動のworktreeなら起動する */
  onOpen: () => void;
  /** この worktree を親にして子タスクを分離する */
  onSplitTask?: () => void;
  /** 子の行で、親のセッションを開く */
  onOpenParent?: () => void;
  /** 表示名の編集を始める */
  onStartRename?: () => void;
  /** このセッションの通知。ブラウザが通知に対応していなければundefined */
  notifications?: { enabled: boolean; onChange: (enabled: boolean) => void };
  /** 再起動の確認を開く */
  onRestart?: () => void;
  /** このworktreeの個別プロファイル。inheritedProfileNameはリポジトリの既定 (未設定はnull) */
  worktreeProfile?: ProfileChoice & { inheritedProfileName: string | null };
  onCreateWorktree?: () => void;
  /** このリポジトリの全セッションを並べて見る (RepoGridView。PCだけ) */
  onOpenRepoGrid?: () => void;
  repoProfile?: ProfileChoice;
  onOpenProfileManager?: () => void;
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
  Sub: ComponentType<ComponentProps<typeof ContextMenuSub>>;
  SubContent: ComponentType<ComponentProps<typeof ContextMenuSubContent>>;
  SubTrigger: ComponentType<ComponentProps<typeof ContextMenuSubTrigger>>;
  /**
   * プロファイルが多いとサブメニューが画面の下にはみ出すので、使える高さに収めてスクロールさせる。
   * Radixが渡す高さの変数名はメニューの種類ごとに違う
   */
  subContentClassName: string;
};

const PARTS_BY_VARIANT: Record<SessionRowMenuProps["variant"], MenuParts> = {
  context: {
    Group: ContextMenuGroup,
    Item: ContextMenuItem,
    Label: ContextMenuLabel,
    Separator: ContextMenuSeparator,
    Sub: ContextMenuSub,
    SubContent: ContextMenuSubContent,
    SubTrigger: ContextMenuSubTrigger,
    subContentClassName:
      "max-h-(--radix-context-menu-content-available-height) overflow-y-auto",
  },
  dropdown: {
    Group: DropdownMenuGroup as MenuParts["Group"],
    Item: DropdownMenuItem as MenuParts["Item"],
    Label: DropdownMenuLabel as MenuParts["Label"],
    Separator: DropdownMenuSeparator as MenuParts["Separator"],
    Sub: DropdownMenuSub as MenuParts["Sub"],
    SubContent: DropdownMenuSubContent as MenuParts["SubContent"],
    SubTrigger: DropdownMenuSubTrigger as MenuParts["SubTrigger"],
    subContentClassName:
      "max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto",
  },
};

export function SessionRowMenu({
  variant,
  entry,
  onOpen,
  onSplitTask,
  onOpenParent,
  onStartRename,
  notifications,
  onRestart,
  worktreeProfile,
  onCreateWorktree,
  onOpenRepoGrid,
  repoProfile,
  onOpenProfileManager,
  onRemoveRepo,
  onDelete,
}: SessionRowMenuProps) {
  const Menu = PARTS_BY_VARIANT[variant];
  const hasRepoItems =
    onCreateWorktree !== undefined ||
    onOpenRepoGrid !== undefined ||
    repoProfile !== undefined ||
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
        {onStartRename && (
          <Menu.Item onSelect={onStartRename}>
            <Pencil />
            {m.session.menu.rename}
          </Menu.Item>
        )}
        {notifications && (
          <Menu.Item
            onSelect={() => notifications.onChange(!notifications.enabled)}
          >
            {notifications.enabled ? <BellOff /> : <Bell />}
            {notifications.enabled
              ? m.session.menu.muteNotifications
              : m.session.menu.unmuteNotifications}
          </Menu.Item>
        )}
        {onRestart && (
          <Menu.Item onSelect={onRestart}>
            <RotateCw />
            {m.session.actions.restart}
          </Menu.Item>
        )}
        {worktreeProfile && (
          <Menu.Sub>
            <Menu.SubTrigger>
              <UserRound />
              {m.session.menu.worktreeProfile}
            </Menu.SubTrigger>
            <Menu.SubContent className={cn("w-60", Menu.subContentClassName)}>
              <ProfileChoiceItems
                Menu={Menu}
                choice={worktreeProfile}
                unsetLabel={m.session.menu.inheritRepoProfile(
                  worktreeProfile.inheritedProfileName
                )}
                onOpenProfileManager={onOpenProfileManager}
              />
            </Menu.SubContent>
          </Menu.Sub>
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
            {repoProfile && (
              <Menu.Sub>
                <Menu.SubTrigger>
                  <UserRound />
                  {m.session.menu.repoDefaultProfile}
                </Menu.SubTrigger>
                <Menu.SubContent
                  className={cn("w-60", Menu.subContentClassName)}
                >
                  <ProfileChoiceItems
                    Menu={Menu}
                    choice={repoProfile}
                    unsetLabel={m.session.menu.defaultProfile}
                    onOpenProfileManager={onOpenProfileManager}
                  />
                </Menu.SubContent>
              </Menu.Sub>
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

function ProfileChoiceItems({
  Menu,
  choice,
  unsetLabel,
  onOpenProfileManager,
}: {
  Menu: MenuParts;
  choice: ProfileChoice;
  unsetLabel: string;
  onOpenProfileManager?: () => void;
}) {
  return (
    <>
      {choice.profiles.map(profile => {
        const current = choice.currentProfileId === profile.id;
        return (
          <Menu.Item
            key={profile.id}
            data-current={current ? "true" : undefined}
            onSelect={() => choice.onSelect(profile.id)}
          >
            <CheckMark checked={current} />
            <span className="truncate">{profile.name}</span>
          </Menu.Item>
        );
      })}
      {choice.profiles.length > 0 && <Menu.Separator />}
      <Menu.Item
        data-current={choice.currentProfileId === null ? "true" : undefined}
        onSelect={() => choice.onSelect(null)}
      >
        <CheckMark checked={choice.currentProfileId === null} />
        <span className="truncate">{unsetLabel}</span>
      </Menu.Item>
      {onOpenProfileManager && (
        <>
          <Menu.Separator />
          <Menu.Item onSelect={onOpenProfileManager}>
            <Settings />
            {m.session.menu.openProfileManager}
          </Menu.Item>
        </>
      )}
    </>
  );
}

function CheckMark({ checked }: { checked: boolean }) {
  return checked ? (
    <Check className="text-primary" />
  ) : (
    <span className="size-4 shrink-0" aria-hidden="true" />
  );
}
