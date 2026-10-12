/**
 * FloatingTerminal - 端末を、会話の上に重ねて開く窓
 *
 * 中身 (ttydのiframeを持つ端末) は `children` で受け、この部品は枠だけを持つ。
 * 位置を決めるのは親で、`position: relative` の祖先の領域いっぱいに背景を敷き、
 * その中に窓を置く。
 *
 * - 閉じている間も中身はマウントしたまま、いちばん外の要素に `hidden` を付けて隠す。
 *   開閉で変えるのはclassと属性だけで、中身を作り直すことも、DOMの親を付け替える
 *   こともしない。iframeはアンマウントでも付け替えでも読み込み直し、ttydがつなぎ直しに
 *   なるため
 * - `variant="window"` は、親の中央に幅90%・高さ80%で重ね、背後を薄く暗くする。
 *   最小は480 x 320で、親より大きくはしない。`variant="fullscreen"` は親の全面を埋める。
 *   窓は動かせない
 * - 閉じ方は、閉じるボタンと、窓の外 (暗くした部分) を押すこと。外を押したかどうかは
 *   背景の要素への pointerdown で見る。端末はiframeで、中で起きたポインターの
 *   イベントは親の文書に届かないので、documentに張る「外側のクリック」の検出は使わない
 * - Escでは閉じない。EscはClaudeの中断に使うキーで、端末へそのまま届ける。
 *   この部品はキーのハンドラを1つも持たない (端末へのキーを横取りしない)
 * - モーダルではない。フォーカスを閉じ込めず、`aria-modal` も付けない。
 *   開いたあと・閉じたあとのフォーカスの移し先は、呼び出し側が `onOpened` / `onClosed` で決める
 * - キーボード操作の層 (KeyNavLayer) には、アプリのダイアログとして数えさせない
 *   (`data-keynav-nonmodal`)。数えさせると、開いている間は前置キーが効かなくなり、
 *   端末の中からノーマルモードへ出て窓を閉じることができない。
 *   `role="dialog"` は開いている間だけ付ける (セッションの数だけ常にマウントされるため)
 */

import { X } from "lucide-react";
import {
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { cn } from "@/lib/utils";

interface FloatingTerminalProps {
  open: boolean;
  /** 閉じるボタンか、窓の外を押したとき */
  onClose: () => void;
  /** 上端のバーの見出しで、ダイアログの読み上げ名。既定は「端末」 */
  title?: string;
  /** 上端のバーの右、閉じるボタンの手前に並べる操作 */
  actions?: ReactNode;
  /** "window" = 親の中央に重ねる (既定)、"fullscreen" = 親の全面を埋める */
  variant?: "window" | "fullscreen";
  /** 開いて見えるようになったあとに呼ぶ (端末へフォーカスを移す) */
  onOpened?: () => void;
  /** 閉じて隠れたあとに呼ぶ (元の入力欄へフォーカスを戻す)。マウント時には呼ばない */
  onClosed?: () => void;
  children: ReactNode;
}

export function FloatingTerminal({
  open,
  onClose,
  title = "端末",
  actions,
  variant = "window",
  onOpened,
  onClosed,
  children,
}: FloatingTerminalProps) {
  // 開閉が変わったときだけ呼ぶ (関数が替わっただけの再描画では呼び直さない)
  const callbacksRef = useRef({ onOpened, onClosed });
  callbacksRef.current = { onOpened, onClosed };
  const wasOpenRef = useRef(open);
  useEffect(() => {
    if (wasOpenRef.current === open) return;
    wasOpenRef.current = open;
    if (open) callbacksRef.current.onOpened?.();
    else callbacksRef.current.onClosed?.();
  }, [open]);

  const handleBackdropPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      // 窓の中から上がってきたイベントでは閉じない
      if (event.target === event.currentTarget) onClose();
    },
    [onClose]
  );

  // pointerdown で閉じた直後に、続く mousedown の既定の動き (押した場所へフォーカスを移す)
  // が走ると、onClosed で移したフォーカスが外れる。背景を押したときだけ止める
  const handleBackdropMouseDown = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) event.preventDefault();
    },
    []
  );

  const isWindow = variant === "window";

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 窓の外を押して閉じるのはポインターの近道。キーボードでは閉じるボタンで閉じられる
    <div
      data-testid="floating-terminal"
      onPointerDown={handleBackdropPointerDown}
      onMouseDown={handleBackdropMouseDown}
      className={
        open
          ? cn(
              "absolute inset-0 z-30 flex items-center justify-center",
              isWindow && "rounded-[var(--radius-panel)] bg-foreground/15"
            )
          : "hidden"
      }
    >
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-label は role="dialog" と同じ条件 (開いている間) でだけ付く */}
      <div
        data-testid="floating-terminal-window"
        data-keynav-nonmodal=""
        role={open ? "dialog" : undefined}
        aria-label={open ? title : undefined}
        className={cn(
          "flex flex-col overflow-hidden bg-card",
          isWindow
            ? "h-[min(100%,max(80%,320px))] w-[min(100%,max(90%,480px))] rounded-xl border border-border shadow-panel"
            : "h-full w-full"
        )}
      >
        <div className="flex h-11 shrink-0 items-center gap-1 pr-2 pl-4">
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
            {title}
          </h2>
          {actions}
          <button
            type="button"
            aria-label="端末を閉じる"
            title="端末を閉じる"
            onClick={onClose}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
