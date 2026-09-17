/**
 * SessionListRow - セッション一覧の1行 (PCサイドバーの行 / モバイル一覧のカード)
 *
 * 1行目は「状態チップ + 主ラベル」、2行目は「プロファイル + ブランチ · プレビュー文」。
 * 主ラベルは表示名があれば表示名、無ければリポジトリ名。行のtitleはリポジトリの絶対パス。
 * 行メニューはsidebarでは右クリックと `…`、cardでは `⋮` で開き、中身は同じ。
 */

import type { Profile } from "@ark/shared";
import { Ellipsis, MoreVertical, RotateCw, TriangleAlert } from "lucide-react";
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SessionListEntry } from "@/lib/session-sections";
import { cn } from "@/lib/utils";
import { getBaseName } from "@/utils/pathUtils";
import { SessionRowMenu, type SessionRowMenuProps } from "./SessionRowMenu";
import { StatusChip } from "./StatusChip";

export interface SessionRowProfile {
  name: string;
  /** worktree個別の上書きならtrue (リポジトリの既定を継承していればfalse) */
  individual: boolean;
}

/** 行に出すプロファイル。未割り当て (~/.claude) や機能が無効なときはnull */
export function resolveSessionRowProfile(input: {
  enabled: boolean;
  worktreePath: string | null;
  repoPath: string;
  profileById: ReadonlyMap<string, Profile>;
  repoProfileLinks?: ReadonlyMap<string, string>;
  worktreeProfileLinks?: ReadonlyMap<string, string>;
}): SessionRowProfile | null {
  if (!input.enabled) return null;
  const worktreeProfileId = input.worktreePath
    ? (input.worktreeProfileLinks?.get(input.worktreePath) ?? null)
    : null;
  const profileId =
    worktreeProfileId ?? input.repoProfileLinks?.get(input.repoPath) ?? null;
  const profile = profileId ? input.profileById.get(profileId) : undefined;
  if (!profile) return null;
  return { name: profile.name, individual: worktreeProfileId !== null };
}

export interface SessionListRowProps {
  /** "sidebar" = PCサイドバーの行、"card" = モバイル一覧のカード */
  variant: "sidebar" | "card";
  entry: SessionListEntry;
  /** 表示名 (前後の空白を除いた値。未設定ならnull) */
  displayName: string | null;
  /** 端末の最後の内容行。空なら2行目に出さない */
  previewText: string;
  /** プロファイルのチップ。未割り当てならnull */
  profile: SessionRowProfile | null;
  /** 起動後にプロファイルの割り当てが変わった (再起動が要る) */
  staleProfile: boolean;
  selected: boolean;
  /** 表示名を編集中か。どの行を編集するかは一覧が持つ */
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  /** 表示名を保存する。nullで解除 (主ラベルはリポジトリ名に戻る) */
  onSaveDisplayName?: (displayName: string | null) => void;
  menu: Omit<SessionRowMenuProps, "variant" | "entry">;
  /** 行メニューの開閉。一覧の並び替えの保留に使う */
  onMenuOpenChange: (open: boolean) => void;
}

export function SessionListRow({
  variant,
  entry,
  displayName,
  previewText,
  profile,
  staleProfile,
  selected,
  editing,
  onEditingChange,
  onSaveDisplayName,
  menu,
  onMenuOpenChange,
}: SessionListRowProps) {
  const primaryLabel = displayName ?? entry.repoName;
  const branch =
    entry.worktree?.branch ?? getBaseName(entry.session?.worktreePath ?? "");
  const quiet = entry.statusKey === "NOT_STARTED" || entry.statusKey === "STOP";

  // 入力途中の表示名。編集の開始と終了に合わせて、レンダー中に用意・破棄する
  const [draft, setDraft] = useState<string | null>(null);
  if (editing && draft === null) setDraft(primaryLabel);
  if (!editing && draft !== null) setDraft(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const cancelEditRef = useRef(false);
  // keepFocusWhileEditing はDropdownMenu/ContextMenuのonCloseAutoFocusに渡す。Radixの
  // close-autofocusはFocusScopeのunmount後に走るため、描画時のクロージャで`editing`を
  // 閉じ込めると古い値 (前の描画のfalse) で呼ばれうる。refで常に最新値を読む
  const editingRef = useRef(editing);
  editingRef.current = editing;

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  // 開いている行メニューの数 (sidebarは右クリックと `…` の2つ)。Radixはメニューを開いたまま
  // 行が消えてもonOpenChange(false)を呼ばない。知らせないと一覧の並び替えの保留が解けなくなるので、
  // 行が消えるときに開いていた分を閉じたことにする
  const openMenuCountRef = useRef(0);
  const onMenuOpenChangeRef = useRef(onMenuOpenChange);
  useEffect(() => {
    onMenuOpenChangeRef.current = onMenuOpenChange;
  });
  useEffect(
    () => () => {
      while (openMenuCountRef.current > 0) {
        openMenuCountRef.current -= 1;
        onMenuOpenChangeRef.current(false);
      }
    },
    []
  );
  const handleMenuOpenChange = (open: boolean) => {
    openMenuCountRef.current = Math.max(
      0,
      openMenuCountRef.current + (open ? 1 : -1)
    );
    onMenuOpenChange(open);
  };

  // 保存と取り消しはblurに一本化する。Enter / Escapeはblurを起こすだけにし、
  // 入力欄が消えるときにblurを出さないブラウザでも、一覧からフォーカスが確実に抜けるようにする
  const finishEditing = () => {
    const canceled = cancelEditRef.current;
    cancelEditRef.current = false;
    if (!canceled && draft !== null) {
      const trimmed = draft.trim();
      const next =
        trimmed === "" || trimmed === entry.repoName ? null : trimmed;
      if (next !== displayName) onSaveDisplayName?.(next);
    }
    onEditingChange(false);
  };

  const handleEditKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    // 日本語入力の変換を確定するEnterでは保存しない
    if (event.nativeEvent.isComposing) return;
    if (event.key !== "Enter" && event.key !== "Escape") return;
    event.preventDefault();
    cancelEditRef.current = event.key === "Escape";
    event.currentTarget.blur();
  };

  const handleRowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    menu.onOpen();
  };

  // メニューが閉じるとき、Radixは直前のフォーカス先 (行や `…`) へフォーカスを戻す。
  // 「表示名を変更」を選んだ直後は、入力欄のフォーカスを奪わせない
  const keepFocusWhileEditing = (event: Event) => {
    if (editingRef.current) event.preventDefault();
  };

  const detailSegments: { key: string; node: ReactNode }[] = [];
  if (displayName !== null) {
    detailSegments.push({
      key: "repo",
      node: (
        <>
          {entry.repoName}
          {entry.disambiguator && (
            <span className="ml-1">{entry.disambiguator}</span>
          )}
        </>
      ),
    });
  }
  if (branch) {
    detailSegments.push({
      key: "branch",
      node: <span className="text-foreground/80">{branch}</span>,
    });
  }
  if (previewText) {
    detailSegments.push({ key: "preview", node: previewText });
  }

  const row = (
    <div
      className={cn(
        "group rounded-lg border transition-colors",
        variant === "sidebar"
          ? cn(
              "px-3 py-2.5",
              selected
                ? "border-border bg-card shadow-card"
                : "border-transparent hover:bg-sidebar-accent"
            )
          : cn(
              "border-border px-3.5 py-3 active:bg-accent",
              quiet ? "bg-transparent" : "bg-card shadow-card"
            )
      )}
    >
      <div className="flex items-start gap-1">
        <div
          role="button"
          tabIndex={0}
          data-session-key={entry.key}
          title={entry.repoPath}
          aria-current={selected ? "true" : undefined}
          className="min-w-0 flex-1 cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={menu.onOpen}
          onKeyDown={handleRowKeyDown}
          // マウスで押しただけで一覧にフォーカスが残ると、並び替えの保留が解けなくなる。
          // キーボードのフォーカスは残す。編集中は入力欄のカーソル操作を妨げない
          onMouseDown={event => {
            if (editing) return;
            event.preventDefault();
            // 直前に `…` のメニューを使うと、閉じたときにフォーカスがそのボタンへ戻って残る。
            // 一覧の中にフォーカスがあるときだけ外す (メインペインの入力欄のフォーカスは奪わない)
            const active = document.activeElement;
            if (
              active instanceof HTMLElement &&
              event.currentTarget
                .closest("[data-session-list]")
                ?.contains(active)
            ) {
              active.blur();
            }
          }}
        >
          <div className="flex min-w-0 items-center gap-2">
            <StatusChip statusKey={entry.statusKey} />
            {editing ? (
              <input
                ref={inputRef}
                type="text"
                // size=1でinputの既定の最小幅 (20文字分) を外し、狭いサイドバーでも親を押し広げない
                size={1}
                value={draft ?? ""}
                onChange={event => setDraft(event.target.value)}
                onClick={event => event.stopPropagation()}
                onKeyDown={handleEditKeyDown}
                onBlur={finishEditing}
                maxLength={200}
                aria-label="表示名を編集"
                className="h-7 w-0 min-w-0 flex-1 rounded-sm border border-input bg-background px-1.5 text-[15px] font-semibold text-foreground outline-none focus:border-ring"
              />
            ) : (
              <span
                data-testid="session-row-label"
                className={cn(
                  "min-w-0 flex-1 truncate text-[15px] font-semibold",
                  quiet ? "text-muted-foreground" : "text-foreground"
                )}
              >
                {primaryLabel}
                {displayName === null && entry.disambiguator && (
                  <span
                    data-testid="session-row-disambiguator"
                    className="ml-1.5 font-normal text-muted-foreground"
                  >
                    {entry.disambiguator}
                  </span>
                )}
              </span>
            )}
          </div>
          {(profile || detailSegments.length > 0) && (
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
              {profile && (
                <span
                  data-testid="session-row-profile"
                  className="inline-flex h-5 max-w-[9rem] shrink-0 items-center gap-1 rounded-full bg-muted px-2 text-xs font-medium text-muted-foreground"
                >
                  <span className="truncate">{profile.name}</span>
                  {profile.individual && <span className="shrink-0">個別</span>}
                </span>
              )}
              <span
                data-testid="session-row-detail"
                className="min-w-0 truncate"
              >
                {detailSegments.map((segment, index) => (
                  <Fragment key={segment.key}>
                    {index > 0 && (
                      <span aria-hidden="true" className="mx-1.5">
                        ·
                      </span>
                    )}
                    {segment.node}
                  </Fragment>
                ))}
              </span>
            </div>
          )}
        </div>
        <DropdownMenu onOpenChange={handleMenuOpenChange}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={
                branch
                  ? `${primaryLabel} (${branch}) のメニュー`
                  : `${primaryLabel}のメニュー`
              }
              className={cn(
                "inline-flex shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground",
                variant === "sidebar"
                  ? "h-7 w-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                  : "-mr-2 -mt-1 h-10 w-10"
              )}
            >
              {variant === "sidebar" ? (
                <Ellipsis className="size-4" />
              ) : (
                <MoreVertical className="size-5" />
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-64"
            onCloseAutoFocus={keepFocusWhileEditing}
          >
            <SessionRowMenu variant="dropdown" entry={entry} {...menu} />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {staleProfile && (
        <div className="mt-2 flex items-center gap-1.5">
          <span
            className="inline-flex h-6 items-center gap-1 rounded-full bg-status-awaiting/15 px-2 text-xs font-semibold text-status-awaiting"
            title="プロファイルの割り当てが変わりました。このセッションは元の設定で動いています"
          >
            <TriangleAlert className="size-3.5" aria-hidden="true" />
            古い設定
          </span>
          {menu.onRestart && (
            <button
              type="button"
              onClick={menu.onRestart}
              className="inline-flex h-6 items-center gap-1 rounded-full bg-status-awaiting/15 px-2 text-xs font-semibold text-status-awaiting transition-colors hover:bg-status-awaiting/25"
            >
              <RotateCw className="size-3.5" aria-hidden="true" />
              再起動
            </button>
          )}
        </div>
      )}
    </div>
  );

  if (variant === "card") return row;

  return (
    <ContextMenu onOpenChange={handleMenuOpenChange}>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent
        className="w-64"
        onCloseAutoFocus={keepFocusWhileEditing}
      >
        <SessionRowMenu variant="context" entry={entry} {...menu} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
