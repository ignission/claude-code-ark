/**
 * MobileQuickActionRow - モバイル下部バーの1タップ操作の行
 *
 * ファイルの添付 / 画像の貼り付け / メッセージのショートカット / スラッシュコマンド /
 * 端末のバッファのコピー / 端末の再読み込み。
 * どれも `…` を開かずに届かせたいので、セグメントと入力欄のあいだに並べる。
 * 会話・端末・図のどのモードのバーにも同じ行を置く (見えるのは1枚だけ)。
 * `…` に残すのはセッション全体の操作 (通知・再起動・削除) だけ。
 *
 * どのボタンを出すかは `actions` prop で渡され、判断は `lib/mobile-quick-actions.ts`
 * に寄せてある。会話モードは添付ボタンを出さない (会話の入力欄が自前の添付ボタンを
 * 持っており、行にも出すと同じボタンが2つ並ぶため)。
 *
 * 添付と画像の実体はモードで違う (会話は入力欄に `@path`、端末は確認ダイアログ)
 * ので、呼ぶ先はMobileSessionViewが渡す。ここは並べて押せるようにするだけ。
 * ショートカットの管理ダイアログも、3枚ぶん作らないよう呼び出し側に置く。
 *
 * 端末の操作は端末モードだけに出る (判断は同じく mobile-quick-actions.ts)。
 * 一番混む端末モードで6つ並ぶが、44px×6 + 4px×5 = 284px なので、
 * 幅390pxの画面 (左右の余白12pxずつ) の366pxに収まる。
 */

import type { MessageShortcut } from "@ark/shared";
import {
  Copy,
  ImagePlus,
  Mic,
  Paperclip,
  RefreshCw,
  SquareSlash,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { MobileQuickAction } from "@/lib/mobile-quick-actions";
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
  /** どのボタンを並べるか。判断は `lib/mobile-quick-actions.ts` に寄せる */
  actions: MobileQuickAction[];
  messageShortcuts: MessageShortcut[];
  onSendMessage: (message: string) => void;
  /** 「ショートカットを管理」を選んだとき。ダイアログは呼び出し側が開く */
  onManageShortcuts: () => void;
  /** 音声モードに入る。iOSはこのタップの中でしか認識を始めさせないので、そのまま呼ぶ */
  onStartVoice?: () => void;
  onAttachFile?: () => void;
  onPasteImage?: () => void;
  /** 以下は端末モードだけの操作。未指定の操作は出さない */
  onCopyBuffer?: () => void;
  onReloadTerminal?: () => void;
}

export function MobileQuickActionRow({
  actions,
  messageShortcuts,
  onSendMessage,
  onManageShortcuts,
  onStartVoice,
  onAttachFile,
  onPasteImage,
  onCopyBuffer,
  onReloadTerminal,
}: MobileQuickActionRowProps) {
  return (
    <div data-testid="mobile-quick-actions" className="flex items-center gap-1">
      {actions.includes("voice-mode") && onStartVoice && (
        <button
          type="button"
          aria-label="音声モード"
          title="音声モード"
          onClick={onStartVoice}
          className={TOUCH_ICON_BUTTON}
        >
          <Mic className="size-5" aria-hidden="true" />
        </button>
      )}
      {actions.includes("attach-file") && onAttachFile && (
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
      {actions.includes("paste-image") && onPasteImage && (
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
      {actions.includes("message-shortcuts") && (
        <MessageShortcutQuickButton
          shortcuts={messageShortcuts}
          onSendMessage={onSendMessage}
          onManage={onManageShortcuts}
          className={TOUCH_ICON_BUTTON}
          side="top"
          align="start"
        />
      )}
      {actions.includes("slash-commands") && (
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
      )}
      {actions.includes("copy-buffer") && onCopyBuffer && (
        <button
          type="button"
          aria-label="端末のバッファをコピー"
          title="端末のバッファをコピー"
          onClick={onCopyBuffer}
          className={TOUCH_ICON_BUTTON}
        >
          <Copy className="size-5" aria-hidden="true" />
        </button>
      )}
      {actions.includes("reload-terminal") && onReloadTerminal && (
        <button
          type="button"
          aria-label="端末を再読み込み"
          title="端末を再読み込み"
          onClick={onReloadTerminal}
          className={TOUCH_ICON_BUTTON}
        >
          <RefreshCw className="size-5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
