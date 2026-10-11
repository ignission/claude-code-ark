import type {
  BrowserClientMessage,
  BrowserServerMessage,
  BrowserSession,
} from "@ark/shared";
import { Loader2, RefreshCw } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { buildBrowserWsUrl } from "@/lib/auth-token";
import {
  isPasteShortcut,
  keyMessage,
  mouseMessage,
  wheelMessage,
} from "@/lib/browser-input";

interface BrowserPaneProps {
  browserSession: BrowserSession;
}

type Status =
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "disconnected"; reason: string };

const DISCONNECTED_REASON = "切断されました";
/** サーバーがビューポートに使う倍率の範囲。フレームの寸法をCSSピクセルへ直すのに使う */
const MIN_DPR = 1;
const MAX_DPR = 2;

function isCoarsePointer(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}

interface FrameSize {
  width: number;
  height: number;
}

/** canvas上の位置を、最後に描いたフレームの座標 (ビューポートのCSSピクセル) へ直す */
function toViewport(
  msg: BrowserClientMessage,
  rect: DOMRect,
  frame: FrameSize | null
): BrowserClientMessage {
  if (msg.t !== "mouse" || !frame || rect.width <= 0 || rect.height <= 0) {
    return msg;
  }
  return {
    ...msg,
    x: msg.x * (frame.width / rect.width),
    y: msg.y * (frame.height / rect.height),
  };
}

/**
 * ブラウザ機能の画面。サーバーのChromiumをcanvasに映し、手元の入力を送る。
 *
 * キー入力は透明のtextareaで受ける。canvasはIMEの対象にならないので、変換を
 * 手元のIMEで行うには入力欄が要る。未確定の文字列はcompositionイベントで送り、
 * サーバーがリモートのページの入力欄に表示する。
 *
 * canvasの表示寸法とChromiumのビューポートを一致させる (寸法を送り、サーバーが
 * 合わせる) ので、座標の変換は持たない。
 *
 * ただし、寸法が反映される前のフレームと、ペインがサーバーの下限 (200px) より
 * 小さい間のフレームは、表示寸法と一致しない。その間も押した位置がずれないよう、
 * 座標には最後に描いたフレームの寸法と表示寸法の比を掛ける (一致していれば1)。
 */
export function BrowserPane({ browserSession }: BrowserPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "connecting" });
  const [attempt, setAttempt] = useState(0);

  // 最後に描いたフレームの寸法 (CSSピクセル)。座標の補正に使う
  const frameSizeRef = useRef<FrameSize | null>(null);
  // 間引きで送らずに持っている最新のmove
  const pendingMoveRef = useRef<BrowserClientMessage | null>(null);
  const moveFrameRef = useRef<number | null>(null);
  // ボタンを押している間だけ window に付けるリスナーを外す関数
  const stopDragRef = useRef<(() => void) | null>(null);
  const composingRef = useRef(false);
  // 貼り付けのショートカットとして送らなかったキー。upも送らない
  const pasteKeyCodesRef = useRef(new Set<string>());

  const send = useCallback((msg: BrowserClientMessage) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const sendSize = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    // display: hiddenで隠れている間は0になる。送るとサーバーが下限の寸法に縮めてしまう
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    send({
      t: "resize",
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      dpr: window.devicePixelRatio || 1,
      mobile: isCoarsePointer(),
    });
  }, [send]);

  const flushMove = useCallback(() => {
    if (moveFrameRef.current !== null) {
      cancelAnimationFrame(moveFrameRef.current);
      moveFrameRef.current = null;
    }
    const pending = pendingMoveRef.current;
    pendingMoveRef.current = null;
    if (pending) send(pending);
  }, [send]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attemptは本文中では読まないが、再接続ボタンを押すたびに接続をやり直すためのtriggerとして依存に入れている
  useEffect(() => {
    let cancelled = false;
    let serverError = "";
    // フレームの連番。デコードは届いた順に終わるとは限らない
    let received = 0;
    let drawn = 0;

    setStatus({ kind: "connecting" });
    frameSizeRef.current = null;

    const ws = new WebSocket(buildBrowserWsUrl(browserSession.id));
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    const draw = (bitmap: ImageBitmap, seq: number) => {
      const canvas = canvasRef.current;
      // 自分より新しいフレームが既に描かれていたら捨てる
      if (cancelled || seq < drawn || !canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      drawn = seq;
      if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
      if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
      ctx.drawImage(bitmap, 0, 0);
      const dpr = Math.min(
        MAX_DPR,
        Math.max(MIN_DPR, window.devicePixelRatio || 1)
      );
      frameSizeRef.current = {
        width: bitmap.width / dpr,
        height: bitmap.height / dpr,
      };
    };

    ws.onopen = () => {
      if (cancelled) return;
      setStatus({ kind: "connected" });
      sendSize();
    };
    ws.onmessage = event => {
      if (typeof event.data === "string") {
        try {
          const msg = JSON.parse(event.data) as BrowserServerMessage;
          // サーバーは閉じる直前に理由を送る。表示するのはcloseが来てから
          if (msg.t === "error") serverError = msg.message;
        } catch {
          // 読めないメッセージは捨てる
        }
        return;
      }
      const seq = ++received;
      createImageBitmap(new Blob([event.data], { type: "image/jpeg" }))
        .then(bitmap => {
          try {
            draw(bitmap, seq);
          } finally {
            bitmap.close();
          }
        })
        .catch(() => {
          // 壊れたフレームは捨てる。次のフレームで描き直される
        });
    };
    ws.onclose = () => {
      if (cancelled) return;
      setStatus({
        kind: "disconnected",
        reason: serverError || DISCONNECTED_REASON,
      });
    };

    return () => {
      cancelled = true;
      // 自分で閉じたときに「切断されました」を出さないよう、先にハンドラを外す
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.close();
      if (wsRef.current === ws) wsRef.current = null;
      // 送り先が無くなるので、持っていた入力の状態も捨てる
      stopDragRef.current?.();
      if (moveFrameRef.current !== null) {
        cancelAnimationFrame(moveFrameRef.current);
        moveFrameRef.current = null;
      }
      pendingMoveRef.current = null;
      pasteKeyCodesRef.current.clear();
    };
  }, [browserSession.id, attempt, sendSize]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => sendSize());
    observer.observe(container);
    return () => observer.disconnect();
  }, [sendSize]);

  const pointerMessage = (
    type: "down" | "up" | "move",
    e: MouseEvent
  ): BrowserClientMessage | null => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect
      ? toViewport(mouseMessage(type, e, rect), rect, frameSizeRef.current)
      : null;
  };

  // moveは1フレームに1回へ間引き、最新の位置だけを送る
  const queueMove = (e: MouseEvent) => {
    const msg = pointerMessage("move", e);
    if (!msg) return;
    pendingMoveRef.current = msg;
    if (moveFrameRef.current !== null) return;
    moveFrameRef.current = requestAnimationFrame(() => {
      moveFrameRef.current = null;
      flushMove();
    });
  };

  // downとupの前に、持っているmoveを先に送る (順序が入れ替わるとドラッグの終点がずれる)
  const sendButton = (type: "down" | "up", e: MouseEvent) => {
    flushMove();
    const msg = pointerMessage(type, e);
    if (msg) send(msg);
  };

  // ボタンを押したままペインの外へ出ても追えるよう、押している間は window で聞く
  const startDrag = () => {
    if (stopDragRef.current) return;
    const onMove = (e: MouseEvent) => queueMove(e);
    const onUp = (e: MouseEvent) => {
      sendButton("up", e);
      // 別のボタンがまだ押されていれば、聞き続ける
      if (e.buttons === 0) stopDragRef.current?.();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    stopDragRef.current = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      stopDragRef.current = null;
    };
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    // 接続中と切断の表示が上に載っている間は、再接続ボタンの操作を邪魔しない
    if (status.kind !== "connected") return;
    // 既定の動作 (フォーカスの移動と文字の選択) を止め、フォーカスを入力欄に固定する
    e.preventDefault();
    const canvas = canvasRef.current;
    const input = inputRef.current;
    if (canvas && input) {
      // 入力欄を押した位置へ動かす。IMEの候補ウィンドウがその近くに出る
      const rect = canvas.getBoundingClientRect();
      input.style.left = `${e.clientX - rect.left}px`;
      input.style.top = `${e.clientY - rect.top}px`;
      input.focus({ preventScroll: true });
    }
    sendButton("down", e.nativeEvent);
    startDrag();
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    // 押している間は window のリスナーが送る。ここでも送ると二重になる
    if (stopDragRef.current) return;
    queueMove(e.nativeEvent);
  };

  // Reactの onWheel はpassiveで preventDefault できないので、自分で付ける
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect) {
        send(toViewport(wheelMessage(e, rect), rect, frameSizeRef.current));
      }
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [send]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 貼り付けはキーとして送らず、ブラウザの paste イベントに任せる
    if (isPasteShortcut(e.nativeEvent)) {
      pasteKeyCodesRef.current.add(e.code);
      return;
    }
    const msg = keyMessage(e.nativeEvent, "down");
    if (!msg) return;
    // 手元の入力欄には文字を入れない (入れると onInput が同じ文字をもう一度送る)。
    // コピーや切り取りのショートカットも、ここでは普通のキーとして送るだけ
    e.preventDefault();
    send(msg);
  };

  const handleKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 修飾キーを先に離すと、upは貼り付けのショートカットに見えない。downで覚えた方を見る
    if (pasteKeyCodesRef.current.delete(e.code)) return;
    if (isPasteShortcut(e.nativeEvent)) return;
    const msg = keyMessage(e.nativeEvent, "up");
    if (msg) send(msg);
  };

  const handleCompositionStart = () => {
    composingRef.current = true;
  };

  const handleCompositionUpdate = (
    e: React.CompositionEvent<HTMLTextAreaElement>
  ) => {
    send({
      t: "ime",
      type: "update",
      text: e.data,
      selectionStart: e.data.length,
      selectionEnd: e.data.length,
    });
  };

  // 確定の文字列を送るのは compositionend と onInput のどちらか一方だけ。
  // 変換の確定はここで送り、入力欄を空にする。Chromeはこのあとに
  // isComposing: false の input を出すが、値が空なので onInput は送らない
  const handleCompositionEnd = (
    e: React.CompositionEvent<HTMLTextAreaElement>
  ) => {
    e.currentTarget.value = "";
    // blurで取り消しを送ったあとに届いた分は、もう送らない
    if (!composingRef.current) return;
    composingRef.current = false;
    send(
      e.data
        ? { t: "ime", type: "commit", text: e.data }
        : { t: "ime", type: "cancel" }
    );
  };

  // 変換を経ない入力 (ソフトキーボードやOSの文字ビューア) をここで送る。
  // 変換中の input は送らない。Firefoxは compositionend より先に
  // isComposing: true の input を出すので、確定は compositionend に任せる
  const handleInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const native = e.nativeEvent as InputEvent;
    if (native.isComposing || composingRef.current) return;
    const text = e.currentTarget.value;
    if (!text) return;
    e.currentTarget.value = "";
    send({ t: "ime", type: "commit", text });
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    if (text) send({ t: "paste", text });
  };

  // 変換の途中でフォーカスが外れたら、リモートに残る未確定の文字列を消す
  const handleBlur = (e: React.FocusEvent<HTMLTextAreaElement>) => {
    if (!composingRef.current) return;
    composingRef.current = false;
    e.currentTarget.value = "";
    send({ t: "ime", type: "cancel" });
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: リモートの画面への操作をそのまま送る面で、対応する役割が無い。キー入力は中のtextareaが受ける
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-background"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onContextMenu={e => e.preventDefault()}
    >
      <canvas
        ref={canvasRef}
        className="block h-full w-full"
        style={{ touchAction: "none" }}
      />
      <textarea
        ref={inputRef}
        aria-label="ブラウザへの入力"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className="absolute h-px w-px opacity-0 resize-none border-0 p-0 outline-none"
        style={{ caretColor: "transparent" }}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onCompositionStart={handleCompositionStart}
        onCompositionUpdate={handleCompositionUpdate}
        onCompositionEnd={handleCompositionEnd}
        onInput={handleInput}
        onPaste={handlePaste}
        onBlur={handleBlur}
      />
      {status.kind === "connecting" && (
        <div
          role="status"
          className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground bg-background/80"
        >
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          ブラウザに接続中...
        </div>
      )}
      {status.kind === "disconnected" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm bg-background/90 px-6 text-center">
          <p role="status" className="text-muted-foreground break-all">
            {status.reason}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setAttempt(n => n + 1)}
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
            再接続
          </Button>
        </div>
      )}
    </div>
  );
}
