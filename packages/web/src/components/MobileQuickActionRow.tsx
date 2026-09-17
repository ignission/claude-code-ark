/**
 * MobileQuickActionRow - モバイル下部バーの1タップ操作の行
 *
 * ファイルの添付 / 画像の貼り付け / メッセージのショートカット / スラッシュコマンド。
 * どれも `…` を開かずに届かせたいので、セグメントと入力欄のあいだに並べる。
 * 会話・端末・図のどのモードのバーにも同じ行を置く (見えるのは1枚だけ)。
 *
 * 添付と画像の実体はモードで違う (会話は入力欄に `@path`、端末は確認ダイアログ)
 * ので、呼ぶ先はMobileSessionViewが渡す。ここは並べて押せるようにするだけ。
 * ショートカットの管理ダイアログも、3枚ぶん作らないよう呼び出し側に置く。
 */

import type { MessageShortcut } from "@ark/shared";
import { ImagePlus, Paperclip, SquareSlash } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MessageShortcutQuickButton } from "./MessageShortcutQuickButton";

/** `…` に並べていたものをそのまま持ってくる。送るのも同じ (本文をそのまま送信) */
const SLASH_COMMANDS = [
  "/resume",
  "/help",
  "/status",
  "/clear",
  "/compact",
] as const;

/** 指で押せる44pxの丸いボタン。バーは紙の色なので、押した地は muted で示す */
const TOUCH_ICON_BUTTON =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground";

export interface MobileQuickActionRowProps {
  messageShortcuts: MessageShortcut[];
  onSendMessage: (message: string) => void;
  /** 「ショートカットを管理」を選んだとき。ダイアログは呼び出し側が開く */
  onManageShortcuts: () => void;
  /** 未指定ならファイルの操作を出さない (アップロードできない環境) */
  onAttachFile?: () => void;
  onPasteImage?: () => void;
}

export function MobileQuickActionRow({
  messageShortcuts,
  onSendMessage,
  onManageShortcuts,
  onAttachFile,
  onPasteImage,
}: MobileQuickActionRowProps) {
  return (
    <div className="flex items-center gap-1">
      {onAttachFile && (
        <button
          type="button"
          aria-label="ファイルを添付"
          title="ファイルを添付"
          onClick={onAttachFile}
          className={TOUCH_ICON_BUTTON}
        >
          <Paperclip className="size-5" aria-hidden="true" />
        </button>
      )}
      {onPasteImage && (
        <button
          type="button"
          aria-label="画像を貼り付け"
          title="画像を貼り付け"
          onClick={onPasteImage}
          className={TOUCH_ICON_BUTTON}
        >
          <ImagePlus className="size-5" aria-hidden="true" />
        </button>
      )}
      <MessageShortcutQuickButton
        shortcuts={messageShortcuts}
        onSendMessage={onSendMessage}
        onManage={onManageShortcuts}
        className={TOUCH_ICON_BUTTON}
        side="top"
        align="start"
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="スラッシュコマンド"
            title="スラッシュコマンド"
            className={TOUCH_ICON_BUTTON}
          >
            <SquareSlash className="size-5" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-48">
          {SLASH_COMMANDS.map(command => (
            <DropdownMenuItem
              key={command}
              onSelect={() => onSendMessage(command)}
            >
              {/* コマンドそのものなので等幅で出す */}
              <span className="font-mono text-xs">{command}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
