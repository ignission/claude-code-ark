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
  EyeOff,
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
import type { SessionListEntry } from "@/lib/session-sections";

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
  },
  dropdown: {
    Group: DropdownMenuGroup as MenuParts["Group"],
    Item: DropdownMenuItem as MenuParts["Item"],
    Label: DropdownMenuLabel as MenuParts["Label"],
    Separator: DropdownMenuSeparator as MenuParts["Separator"],
    Sub: DropdownMenuSub as MenuParts["Sub"],
    SubContent: DropdownMenuSubContent as MenuParts["SubContent"],
    SubTrigger: DropdownMenuSubTrigger as MenuParts["SubTrigger"],
  },
};

export function SessionRowMenu({
  variant,
  entry,
  onOpen,
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
          {entry.session ? "開く" : "セッションを起動"}
        </Menu.Item>
        {onStartRename && (
          <Menu.Item onSelect={onStartRename}>
            <Pencil />
            表示名を変更
          </Menu.Item>
        )}
        {notifications && (
          <Menu.Item
            onSelect={() => notifications.onChange(!notifications.enabled)}
          >
            {notifications.enabled ? <BellOff /> : <Bell />}
            {notifications.enabled ? "通知をオフにする" : "通知をオンにする"}
          </Menu.Item>
        )}
        {onRestart && (
          <Menu.Item onSelect={onRestart}>
            <RotateCw />
            再起動
          </Menu.Item>
        )}
        {worktreeProfile && (
          <Menu.Sub>
            <Menu.SubTrigger>
              <UserRound />
              このworktreeのプロファイル
            </Menu.SubTrigger>
            <Menu.SubContent className="w-60">
              <ProfileChoiceItems
                Menu={Menu}
                choice={worktreeProfile}
                unsetLabel={`リポジトリの設定を継承 (${worktreeProfile.inheritedProfileName ?? "既定"})`}
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
              リポジトリ
            </Menu.Label>
            {onCreateWorktree && (
              <Menu.Item onSelect={onCreateWorktree}>
                <Plus />
                新規worktreeを作成
              </Menu.Item>
            )}
            {onOpenRepoGrid && (
              <Menu.Item onSelect={onOpenRepoGrid}>
                <LayoutGrid />
                このリポジトリの全セッションを並べて見る
              </Menu.Item>
            )}
            {repoProfile && (
              <Menu.Sub>
                <Menu.SubTrigger>
                  <UserRound />
                  リポジトリの既定プロファイル
                </Menu.SubTrigger>
                <Menu.SubContent className="w-60">
                  <ProfileChoiceItems
                    Menu={Menu}
                    choice={repoProfile}
                    unsetLabel="既定 (~/.claude)"
                    onOpenProfileManager={onOpenProfileManager}
                  />
                </Menu.SubContent>
              </Menu.Sub>
            )}
            {onRemoveRepo && (
              <Menu.Item onSelect={onRemoveRepo}>
                <EyeOff />
                サイドバーから除外
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
            {entry.session ? "セッションを削除" : "Worktreeを削除"}
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
            プロファイル管理を開く...
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
