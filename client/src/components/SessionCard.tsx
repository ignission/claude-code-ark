import { MessageSquare, Pencil, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type {
  BridgeSessionStatus,
  ManagedSession,
  Worktree,
} from "../../../shared/types";

/** プレビュー無変化でアイドル判定するまでの秒数 */
const IDLE_THRESHOLD_MS = 10_000;

interface SessionCardProps {
  session: ManagedSession | null;
  worktree: Worktree | undefined;
  repoList: string[];
  isSelected: boolean;
  previewText: string;
  activityText: string;
  /**
   * Bridge collector が判定した最新のセッション状態 (グリッドビューと同じソース)。
   * 渡されればこれを優先してドット色を決定し、サイドバーとグリッドで表示が一致する。
   * 未取得 (snapshot 未着信) の場合は activityText/previewText 由来のフォールバックを使う。
   */
  gridStatus?: BridgeSessionStatus;
  onClick: () => void;
  /** セッション削除（停止 + メイン以外のWorktree削除） */
  onDelete: () => void;
  onStart?: () => void;
  /**
   * ステータスドットと worktree名 (branch) の間に挿入するバッジ等のスロット。
   * worktree個別のプロファイル選択メニューを差し込むのに使う。
   * 自身が `<button>` 等のインタラクティブ要素を含む場合があるため、
   * SessionCard 外側のクリック領域は `<button>` ではなく role=button な div で実装する
   * (HTML では button の入れ子が許されない)。
   */
  profileBadgeSlot?: ReactNode;
  /**
   * worktree のカスタム表示名 (未設定なら null、UI 側で branch にフォールバック)。
   */
  customDisplayName?: string | null;
  /**
   * 表示名を保存。null / 空文字でクリア (branch 名へのフォールバックに戻る)。
   * 渡されたときだけ編集UI (鉛筆アイコン) が表示される。
   */
  onSetCustomDisplayName?: (displayName: string | null) => void;
}

export function SessionCard({
  session,
  worktree,
  isSelected,
  previewText,
  activityText,
  gridStatus,
  onClick,
  onDelete,
  onStart,
  profileBadgeSlot,
  customDisplayName,
  onSetCustomDisplayName,
}: SessionCardProps) {
  const branch =
    worktree?.branch ||
    (session
      ? session.worktreePath.substring(
          session.worktreePath.lastIndexOf("/") + 1
        )
      : "unknown");
  const effectiveName = customDisplayName?.trim()
    ? customDisplayName.trim()
    : branch;
  const isCustomName = !!customDisplayName?.trim();
  const canRename = !!onSetCustomDisplayName;

  // プレビュー/アクティビティの変化を追跡してアイドル判定
  const prevTextRef = useRef(previewText);
  const prevActivityRef = useRef(activityText);
  const lastChangedRef = useRef(Date.now());
  const [isIdle, setIsIdle] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  // インライン編集モード
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement | null>(null);

  const startEditing = () => {
    if (!canRename) return;
    setEditValue(effectiveName);
    setIsEditing(true);
  };

  const commitEditing = () => {
    if (!canRename) {
      setIsEditing(false);
      return;
    }
    const trimmed = editValue.trim();
    // 空文字 or branch と同一ならカスタム名をクリア (= branch にフォールバック)
    if (trimmed.length === 0 || trimmed === branch) {
      onSetCustomDisplayName?.(null);
    } else if (trimmed !== effectiveName || !isCustomName) {
      onSetCustomDisplayName?.(trimmed);
    }
    setIsEditing(false);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setEditValue("");
  };

  // 編集モード突入時に input にフォーカス + 全選択
  useEffect(() => {
    if (isEditing) {
      const el = editInputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    }
  }, [isEditing]);

  // worktree名スロットを描画。編集モードならテキスト入力、通常時は span + 鉛筆。
  // 鉛筆は親 (role=button) のクリックを横取りしないように stopPropagation する。
  const renderNameSlot = (textColorClass: string) => {
    if (isEditing) {
      return (
        <input
          ref={editInputRef}
          type="text"
          // size=1 で input の intrinsic min-width を 1ch まで縮められるようにする。
          // 既定 size=20 だと長い既存名や狭いサイドバーで親 flex を押し広げてしまい、
          // 結果としてコンテナ全体が水平スクロール状態になり左端が見切れる事象が起きた。
          size={1}
          value={editValue}
          onChange={e => setEditValue(e.target.value)}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commitEditing();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelEditing();
            }
          }}
          onBlur={commitEditing}
          className="text-sm font-mono bg-background/40 border border-input rounded px-1 py-0 min-w-0 w-0 flex-1 outline-none focus:border-primary"
          maxLength={200}
          aria-label="worktree表示名を編集"
        />
      );
    }
    return (
      <>
        <span
          // flex item としては default で min-width: auto なので、長い名前を入れると
          // 内容幅まで span が広がり親 flex を押し広げる → サイドバー全体に水平
          // スクロールが発生して「左端が切れる」事象になる。min-w-0 で縮められる
          // ようにし、truncate で末尾を ellipsis で打ち切る。
          className={`text-sm font-mono truncate min-w-0 ${textColorClass}`}
          title={isCustomName ? `branch: ${branch}` : undefined}
        >
          {effectiveName}
        </span>
        {canRename && (
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              startEditing();
            }}
            onKeyDown={e => e.stopPropagation()}
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-sidebar-accent transition-opacity"
            aria-label="表示名を変更"
            title="表示名を変更"
          >
            <Pencil className="w-3 h-3" />
          </button>
        )}
      </>
    );
  };

  useEffect(() => {
    if (
      previewText !== prevTextRef.current ||
      activityText !== prevActivityRef.current
    ) {
      prevTextRef.current = previewText;
      prevActivityRef.current = activityText;
      lastChangedRef.current = Date.now();
      setIsIdle(false);
    }
  }, [previewText, activityText]);

  useEffect(() => {
    const timer = setInterval(() => {
      const elapsed = Date.now() - lastChangedRef.current;
      setIsIdle(elapsed >= IDLE_THRESHOLD_MS);
    }, 2000);
    return () => clearInterval(timer);
  }, []);

  const handleStartClick = onStart ?? onClick;

  // セッション未起動の場合はシンプルなカードを表示。
  // profileBadgeSlot がインタラクティブ要素 (button 等) を含むため
  // 外側は role=button な div として実装する (HTML の button 入れ子回避)。
  if (!session) {
    return (
      <div
        role="button"
        tabIndex={0}
        className={`w-full text-left p-3 rounded-lg transition-colors group cursor-pointer min-w-0 overflow-hidden ${
          isSelected
            ? "bg-primary/15 border border-primary/30"
            : "hover:bg-sidebar-accent/50"
        }`}
        onClick={handleStartClick}
        onKeyDown={e => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleStartClick();
          }
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-2 h-2 rounded-full shrink-0 bg-muted-foreground/30" />
          {profileBadgeSlot}
          {renderNameSlot("text-sidebar-foreground/60")}
        </div>
        <p className="mt-1 text-xs text-muted-foreground truncate pl-4">
          セッション未起動
        </p>
      </div>
    );
  }

  // ドット色はグリッドビューと統一するため BridgeSessionStatus を優先する。
  // gridStatus が未着信のときだけ既存ヒューリスティック (✢✻ / ◼◻ / …) にフォールバック。
  const dotColor = gridStatus
    ? statusToDotColor(gridStatus)
    : fallbackDotColor(previewText, activityText, isIdle);

  // アイドル時はactivityText（✻ Baked for ...）、アクティブ時はコンテンツ行
  const idle = session.status === "idle" || isIdle;
  const displayText = idle && activityText ? activityText : previewText;

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            className={`w-full text-left p-3 rounded-lg transition-colors group cursor-pointer min-w-0 overflow-hidden ${
              isSelected
                ? "bg-primary/15 border border-primary/30"
                : "hover:bg-sidebar-accent/50"
            }`}
            onClick={onClick}
            onKeyDown={e => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <div className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
              {profileBadgeSlot}
              {renderNameSlot("text-sidebar-foreground")}
              {isSelected && !isEditing && (
                <span className="ml-auto text-xs text-primary shrink-0">◀</span>
              )}
            </div>
            {displayText && (
              <div className="mt-1 flex items-center gap-1 pl-4 min-w-0">
                <p className="text-xs text-muted-foreground truncate">
                  {displayText}
                </p>
              </div>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuItem onSelect={onClick}>
            <MessageSquare className="w-4 h-4 mr-2" />
            セッションを開く
          </ContextMenuItem>
          {canRename && (
            <ContextMenuItem onSelect={() => startEditing()}>
              <Pencil className="w-4 h-4 mr-2" />
              表示名を変更
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => setShowDeleteDialog(true)}
          >
            <Trash2 className="w-4 h-4 mr-2" />
            セッションを削除
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent className="bg-card border-border w-[calc(100%-2rem)] max-w-md mx-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>セッションを削除</AlertDialogTitle>
            <AlertDialogDescription>
              {worktree?.isMain
                ? "このセッションを削除しますか？メインWorktreeは削除されません。"
                : "このセッションとWorktreeを削除しますか？関連するブランチも削除されます。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="h-12 md:h-10">
              キャンセル
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 h-12 md:h-10"
              onClick={() => {
                onDelete();
                setShowDeleteDialog(false);
              }}
            >
              削除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * Bridge の状態判定 → サイドバードット色のマップ。
 * グリッドビュー側 (RepoGridView の STATUS_CONFIG) と色を揃える。
 *
 *   TOOL/THINK = 緑     (動作中)
 *   AWAITING   = 橙     (判断要)
 *   IDLE/ERR   = 赤     (アクション必要)
 *   READY/STOP = グレー (アイドル相当)
 */
function statusToDotColor(status: BridgeSessionStatus): string {
  switch (status) {
    case "TOOL":
    case "THINK":
      return "bg-green-500";
    case "AWAITING":
      return "bg-orange-500";
    case "IDLE":
    case "ERR":
      return "bg-red-500";
    case "READY":
    case "STOP":
      return "bg-neutral-500";
  }
}

/**
 * gridStatus が未着信の間だけ使う旧ロジックのフォールバック。
 *   - 緑: 活動記号 (✢✻◼◻ / `…`) あり、かつ idle でない or タスク記号
 *   - 青: 出力なし (起動直後/clear 後)
 *   - 赤: それ以外
 */
function fallbackDotColor(
  previewText: string,
  activityText: string,
  isIdle: boolean
): string {
  const hasActivitySymbol =
    /[✢✻◼◻]/.test(activityText) ||
    /[◼◻]/.test(previewText) ||
    /\S+…/.test(activityText);
  const hasTaskSymbol =
    /[◼◻]/.test(activityText) ||
    /[◼◻]/.test(previewText) ||
    /\S+…/.test(activityText);
  const hasVisibleContent =
    previewText.trim().length > 0 || activityText.trim().length > 0;
  if (hasActivitySymbol && (!isIdle || hasTaskSymbol)) return "bg-green-500";
  if (!hasVisibleContent) return "bg-neutral-500";
  return "bg-red-500";
}
