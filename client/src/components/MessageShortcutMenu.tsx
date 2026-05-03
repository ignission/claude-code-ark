/**
 * MessageShortcutMenu - ヘッダーに表示するショートカット送信ドロップダウン
 *
 * クリック即送信。空状態・管理導線も内包する。
 */

import { MessageSquareQuote, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { MessageShortcut } from "../../../shared/types";

interface Props {
  shortcuts: MessageShortcut[];
  onSendMessage: (message: string) => void;
  onOpenManager: () => void;
  /** PCは小サイズアイコン、モバイルは大きめにしたい場合に切り替え */
  size?: "sm" | "lg";
}

/** 表示用に message の先頭行を 40 字で切り詰める（label 廃止に伴う代替） */
function previewOf(message: string): string {
  const firstLine = message.split("\n")[0];
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
}

export function MessageShortcutMenu({
  shortcuts,
  onSendMessage,
  onOpenManager,
  size = "sm",
}: Props) {
  const triggerSize = size === "lg" ? "h-10 w-10" : "h-10 w-10 md:h-6 md:w-6";
  const iconSize = size === "lg" ? "w-5 h-5" : "w-5 h-5 md:w-3 md:h-3";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={triggerSize}
          title="メッセージショートカット"
        >
          <MessageSquareQuote className={iconSize} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {shortcuts.length === 0 ? (
          <>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              ショートカットがありません
            </DropdownMenuLabel>
            <DropdownMenuItem onClick={onOpenManager}>+ 追加</DropdownMenuItem>
          </>
        ) : (
          <>
            {shortcuts.map(s => (
              <DropdownMenuItem
                key={s.id}
                onClick={() => onSendMessage(s.message)}
                title={s.message.slice(0, 200)}
                className="truncate"
              >
                {previewOf(s.message)}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onOpenManager}>
              <Settings className="w-4 h-4 mr-2" />
              ショートカットを管理...
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default MessageShortcutMenu;
