/**
 * SessionListRow - セッション一覧の1行 (PCサイドバーの行 / モバイル一覧のカード)
 *
 * 1行目は「状態チップ + 主ラベル」、2行目は「PRの札 + ブランチ」。
 * PRの札はチェックの結果 (✓ / ✕ / 待ち) かマージ済み・クローズを出し、押すとPRを開く。
 * 色を付けるのは落ちたときだけ (セッションの状態の色は使わない)。
 * 行はリポジトリの見出しの下に並ぶので、主ラベルにリポジトリ名は出さない。表示名があれば表示名
 * (2行目にブランチ)、無ければブランチ。行のtitleはリポジトリの絶対パス。
 * 行メニューはsidebarでは右クリックと `…`、cardでは `⋮` で開き、中身は同じ。
 * task_start で起こした子の行は、親の直後に寄せたときだけ字下げし、2行目の先頭に「↳ 親」を出す
 * (押すと親を開く)。親の行には子の数を出す。
 */

import type { SessionPrStatus } from "@ark/shared";
import { CornerDownRight, Ellipsis, MoreVertical } from "lucide-react";
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
import { m } from "@/lib/i18n";
import { type PrBadgeTone, prBadge } from "@/lib/pr-status";
import type { SessionListEntry } from "@/lib/session-sections";
import { cn } from "@/lib/utils";
import { getBaseName } from "@/utils/pathUtils";
import { SessionRowMenu, type SessionRowMenuProps } from "./SessionRowMenu";
import { StatusChip } from "./StatusChip";

const PR_BADGE_TONE: Readonly<Record<PrBadgeTone, string>> = {
  ng: "bg-destructive/10 text-destructive",
  ok: "bg-muted text-foreground/80",
  wait: "bg-muted text-muted-foreground",
  muted: "bg-muted text-muted-foreground",
};

export interface SessionListRowProps {
  /** "sidebar" = PCサイドバーの行、"card" = モバイル一覧のカード */
  variant: "sidebar" | "card";
  entry: SessionListEntry;
  /** 表示名 (前後の空白を除いた値。未設定ならnull) */
  displayName: string | null;
  /** ブランチのPRとチェックの集計。PRが無ければnull */
  prStatus: SessionPrStatus | null;
  /** 未完了の分岐TODOの件数。0なら出さない */
  todoCount?: number;
  /** この worktree から起こした子の数。0なら出さない */
  childCount?: number;
  /** 子の行なら親の名前。親の行や普通の行は null */
  parentLabel?: string | null;
  /** 親を開く。親のセッションが無ければ undefined (名前だけ出す) */
  onOpenParent?: () => void;
  selected: boolean;
  /** 表示名を編集中か。どの行を編集するかは一覧が持つ */
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  /** 表示名を保存する。nullで解除 (主ラベルはブランチに戻る) */
  onSaveDisplayName?: (displayName: string | null) => void;
  menu: Omit<SessionRowMenuProps, "variant" | "entry">;
}

export function SessionListRow({
  variant,
  entry,
  displayName,
  prStatus,
  todoCount = 0,
  childCount = 0,
  parentLabel = null,
  onOpenParent,
  selected,
  editing,
  onEditingChange,
  onSaveDisplayName,
  menu,
}: SessionListRowProps) {
  const branch =
    entry.worktree?.branch ?? getBaseName(entry.session?.worktreePath ?? "");
  // 表示名が無いときの主ラベル。表示名にこれと同じ文字を入れたら解除として扱う
  const fallbackLabel = branch || entry.repoName;
  const primaryLabel = displayName ?? fallbackLabel;
  const quiet = entry.statusKey === "NOT_STARTED" || entry.statusKey === "STOP";
  const badge = prStatus ? prBadge(prStatus) : null;

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

  // 保存と取り消しはblurに一本化する。Enter / Escapeはblurを起こすだけにし、
  // 入力欄が消えるときにblurを出さないブラウザでも、一覧からフォーカスが確実に抜けるようにする
  const finishEditing = () => {
    const canceled = cancelEditRef.current;
    cancelEditRef.current = false;
    if (!canceled && draft !== null) {
      const trimmed = draft.trim();
      const next = trimmed === "" || trimmed === fallbackLabel ? null : trimmed;
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
  if (displayName !== null && branch) {
    detailSegments.push({
      key: "branch",
      // ブランチは機械が付けた名前なので等幅にする (差分の量や CPU と同じ扱い)
      node: <span className="font-mono text-foreground/80">{branch}</span>,
    });
  }

  // 選ばれた行が一覧のスクロールの外にあれば、見える位置へ寄せる。タブなどから
  // 選んだときに、一覧のどこにいるかを見失わないようにする
  const rowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (selected && variant === "sidebar") {
      rowRef.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [selected, variant]);

  const row = (
    <div
      ref={rowRef}
      className={cn(
        "group rounded-md border transition-colors",
        entry.nested && (variant === "sidebar" ? "ml-4" : "ml-5"),
        // sidebar の行は地に置き、選んだ行だけを面と線で示す (影は付けない)。
        // 選んだ行の左には、上のタブの印と同じ色の線を引いて、タブと行を見比べられるようにする
        // card (モバイル) は指で押す的なので、行ごとの面を残す
        variant === "sidebar"
          ? cn(
              "px-2.5 py-1.5",
              selected
                ? "border-sidebar-border bg-background shadow-[inset_2px_0_0_0_var(--color-foreground)]"
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
          // マウスで押しただけで一覧にフォーカスの枠を残さない。
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
            {/* 一覧では状態の文言を出さない。アイコンと色で足り、行の幅は名前に回したい。
                読み上げには残す */}
            <StatusChip
              statusKey={entry.statusKey}
              labelClassName="sr-only"
              className="px-0.5"
              bare={variant === "sidebar"}
            />
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
                aria-label={m.session.row.editDisplayName}
                className="h-7 w-0 min-w-0 flex-1 rounded-sm border border-input bg-background px-1.5 text-[15px] font-semibold text-foreground outline-none focus:border-ring"
              />
            ) : (
              <span
                data-testid="session-row-label"
                className={cn(
                  "min-w-0 flex-1 truncate",
                  variant === "sidebar"
                    ? "text-[14px] font-medium"
                    : "text-[15px] font-semibold",
                  quiet ? "text-muted-foreground" : "text-foreground"
                )}
              >
                {primaryLabel}
              </span>
            )}
          </div>
          {(badge ||
            todoCount > 0 ||
            childCount > 0 ||
            parentLabel !== null ||
            detailSegments.length > 0) && (
            <div
              className={cn(
                "flex min-w-0 items-center gap-1.5 text-muted-foreground",
                variant === "sidebar"
                  ? "mt-0.5 text-[12px]"
                  : "mt-1 text-[13px]"
              )}
            >
              {parentLabel !== null && (
                <button
                  type="button"
                  data-testid="session-row-parent"
                  title={m.session.row.parentTitle(parentLabel)}
                  aria-label={m.session.row.openParentLabel(parentLabel)}
                  disabled={!onOpenParent}
                  // 行を押したときの動き (行を開く・フォーカスを外す) を起こさない
                  onClick={event => {
                    event.stopPropagation();
                    onOpenParent?.();
                  }}
                  onMouseDown={event => event.stopPropagation()}
                  onKeyDown={event => event.stopPropagation()}
                  className="inline-flex h-5 max-w-[8rem] shrink-0 items-center gap-0.5 rounded-sm bg-muted px-1.5 text-xs text-muted-foreground enabled:hover:text-foreground"
                >
                  <CornerDownRight
                    className="size-3 shrink-0"
                    aria-hidden="true"
                  />
                  <span className="truncate">{parentLabel}</span>
                </button>
              )}
              {badge && prStatus && (
                <a
                  href={prStatus.url}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="session-row-pr"
                  title={badge.label}
                  aria-label={badge.label}
                  // 行を押したときの動き (メニューを開く・フォーカスを外す) を起こさない
                  onClick={event => event.stopPropagation()}
                  onMouseDown={event => event.stopPropagation()}
                  onKeyDown={event => event.stopPropagation()}
                  className={cn(
                    "inline-flex h-5 shrink-0 items-center rounded-sm px-2 text-xs font-medium tabular-nums hover:underline",
                    PR_BADGE_TONE[badge.tone]
                  )}
                >
                  {badge.text}
                </a>
              )}
              {childCount > 0 && (
                <span
                  role="img"
                  data-testid="session-row-children"
                  aria-label={m.session.row.childTasks(childCount)}
                  title={m.session.row.childTasks(childCount)}
                  className="inline-flex shrink-0 items-center gap-0.5 rounded-sm bg-muted px-1.5 text-[11px] leading-4 text-muted-foreground"
                >
                  <CornerDownRight className="size-3" aria-hidden="true" />
                  {childCount}
                </span>
              )}
              {todoCount > 0 && (
                <span
                  role="img"
                  data-testid="session-row-todo"
                  aria-label={m.session.row.openTodos(todoCount)}
                  title={m.session.row.openTodos(todoCount)}
                  className="shrink-0 rounded-sm bg-muted px-1.5 text-[11px] leading-4 text-muted-foreground"
                >
                  {todoCount}
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              // 読み上げではリポジトリ名も添える (見出しは画面の位置でしか結び付かない)
              aria-label={m.session.row.menuLabel(
                displayName ?? entry.repoName,
                branch
              )}
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
    </div>
  );

  if (variant === "card") return row;

  return (
    <ContextMenu>
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
