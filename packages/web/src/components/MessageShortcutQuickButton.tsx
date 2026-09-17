/**
 * MessageShortcutQuickButton - メッセージのショートカットを1タップで開くボタン
 *
 * PC の上部バーとモバイルの下部バーの両方から使う。`…` の中に畳むと一覧まで
 * 2タップかかるので、ボタン自体を出して1タップで届かせる。
 * 管理ダイアログ (MessageShortcutManagerDialog) は呼び出し側が持つ。
 * モバイルは同じ行を3つのモードのバーに置くため、ここで持つと3枚になってしまう。
 */

import type { MessageShortcut } from "@ark/shared";
import { Settings, Zap } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { previewOf } from "./MessageShortcutMenu";

export interface MessageShortcutQuickButtonProps {
  shortcuts: MessageShortcut[];
  onSendMessage: (message: string) => void;
  /** 「ショートカットを管理」を選んだとき。ダイアログは呼び出し側が開く */
  onManage: () => void;
  /** トリガーの見た目。PC は上部バーの 32px、モバイルは指で押せる 44px */
  className?: string;
  /** メニューを出す向き。下部バーから開くモバイルは "top" */
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
}

export function MessageShortcutQuickButton({
  shortcuts,
  onSendMessage,
  onManage,
  className = "",
  side = "bottom",
  align = "end",
}: MessageShortcutQuickButtonProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="メッセージのショートカット"
          title="メッセージのショートカット"
          className={`inline-flex shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground ${className}`}
        >
          <Zap className="size-5" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      {/* ショートカットが多いと画面からはみ出すので、使える高さに収めて
          スクロールさせる (DropdownMenuContent が max-h と overflow を持つ) */}
      <DropdownMenuContent align={align} side={side} className="w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          メッセージショートカット
        </DropdownMenuLabel>
        {shortcuts.length === 0 ? (
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            ショートカットがありません
          </DropdownMenuLabel>
        ) : (
          shortcuts.map(shortcut => (
            <DropdownMenuItem
              key={shortcut.id}
              title={shortcut.message.slice(0, 200)}
              onSelect={() => onSendMessage(shortcut.message)}
            >
              <span className="truncate">{previewOf(shortcut.message)}</span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onManage}>
          <Settings />
          ショートカットを管理
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
