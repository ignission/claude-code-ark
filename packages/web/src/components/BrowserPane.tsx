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
  type BrowserMouseMessage,
  chunkPasteText,
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
/**
 * compositionendからこの時間 (ミリ秒) までに届いたEnterのkeydownは、変換を確定した
 * Enterとして送らない。ブラウザによっては、確定のEnterがcompositionendの直後に
 * keyCode 13、isComposing: falseで届き、変換中のキーと見分けられない。送ると、
 * 確定した文字列のあとにリモートで改行や送信が起きる。
 */
const COMPOSITION_ENTER_MS = 30;
/** DOMの `MouseEvent.button` の順に並べた、`MouseEvent.buttons` のビット */
const BUTTON_BITS = [1, 4, 2, 8, 16];

interface Size {
  width: number;
  height: number;
}

interface HeldKey {
  key: string;
  code: string;
  keyCode: number;
}

function isCoarsePointer(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}

function isSize(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * canvas上の位置を、サーバーのビューポートの座標 (CSSピクセル) へ直す。
 * ビューポートの寸法をまだ知らないか、canvasが見えていなければ `null`。
 */
function toViewport(
  msg: BrowserMouseMessage,
  rect: DOMRect,
  viewport: Size | null
): BrowserMouseMessage | null {
  if (!viewport || rect.width <= 0 || rect.height <= 0) return null;
  return {
    ...msg,
    x: (msg.x * viewport.width) / rect.width,
    y: (msg.y * viewport.height) / rect.height,
  };
}

/**
 * ブラウザ機能の画面。サーバーのChromiumをcanvasに映し、手元の入力を送る。
 *
 * キー入力は透明のtextareaで受ける。canvasはIMEの対象にならないので、変換を
 * 手元のIMEで行うには入力欄が要る。未確定の文字列はcompositionイベントで送り、
 * サーバーがリモートのページの入力欄に表示する。
 *
 * 座標は、サーバーが知らせるビューポートの寸法で換算する (canvas上の位置に、
 * ビューポートの寸法とcanvasの表示寸法の比を掛ける)。ビューポートは視聴者の全員が
 * 共有する1つで、最後に寸法を送った視聴者に合うので、このペインの寸法や手元の倍率とは
 * 一致するとは限らない。寸法が届くまでは、マウスとwheelを送らない。
 *
 * ビューポートは、最後に操作した視聴者に合わせる。押したときに、知らされた寸法が
 * このペインの寸法と違えば、先に自分の寸法を送る。
 */
export function BrowserPane({ browserSession }: BrowserPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "connecting" });
  const [attempt, setAttempt] = useState(0);

  // サーバーが最後に知らせたビューポートの寸法 (CSSピクセル)
  const viewportRef = useRef<Size | null>(null);
  // デコードを待っているフレームがあれば、デコードを始める。接続のeffectが入れる
  const decodeNextRef = useRef<(() => void) | null>(null);
  // 間引きで送らずに持っている最新のmove
  const pendingMoveRef = useRef<BrowserMouseMessage | null>(null);
  const moveFrameRef = useRef<number | null>(null);
  // ボタンを押している間だけwindowに付けるリスナーを外す関数
  const stopDragRef = useRef<(() => void) | null>(null);
  const composingRef = useRef(false);
  const compositionEndAtRef = useRef(Number.NEGATIVE_INFINITY);
  // downを送ってupをまだ送っていないキーとボタン。フォーカスが外れるとupは届かないので、
  // 外れたときにこちらから離す。upを送るのも、ここにあるキーだけ
  const heldKeysRef = useRef(new Map<string, HeldKey>());
  const heldButtonsRef = useRef(new Set<number>());
  // 最後に送ろうとしたマウスの位置 (ビューポートの座標)
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);

  const send = useCallback((msg: BrowserClientMessage) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const sendSize = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    // display: none (Tailwindのhidden) で隠れている間は0になる。送ると、サーバーが見えていないペインにビューポートを合わせてしまう
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

  /** 送り先が無くなったとき。持っていた入力の状態を、何も送らずに捨てる */
  const dropInputState = useCallback(() => {
    stopDragRef.current?.();
    if (moveFrameRef.current !== null) {
      cancelAnimationFrame(moveFrameRef.current);
      moveFrameRef.current = null;
    }
    pendingMoveRef.current = null;
    heldKeysRef.current.clear();
    heldButtonsRef.current.clear();
  }, []);

  /** フォーカスが外れたとき。押したままのキーとボタンを、リモートで離す */
  const releaseHeld = useCallback(() => {
    for (const held of heldKeysRef.current.values()) {
      send({ t: "key", type: "up", ...held, repeat: false, modifiers: 0 });
    }
    heldKeysRef.current.clear();

    const buttons = heldButtonsRef.current;
    if (buttons.size > 0) {
      // 持っているmoveを先に送り、その位置で離す
      flushMove();
      const position = lastPointerRef.current;
      for (const button of [...buttons]) {
        buttons.delete(button);
        if (!position) continue;
        let remaining = 0;
        for (const other of buttons) remaining |= BUTTON_BITS[other] ?? 0;
        send({
          t: "mouse",
          type: "up",
          x: position.x,
          y: position.y,
          button,
          buttons: remaining,
          clickCount: 1,
          deltaX: 0,
          deltaY: 0,
          modifiers: 0,
        });
      }
    }
    stopDragRef.current?.();
  }, [send, flushMove]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attemptは本文中では読まないが、再接続ボタンを押すたびに接続をやり直すためのtriggerとして依存に入れている
  useEffect(() => {
    let cancelled = false;
    let serverError = "";
    // デコードは1枚ずつ。待っている間に届いたフレームは、最新の1枚だけを持つ
    let pendingFrame: ArrayBuffer | null = null;
    let decoding = false;
    let decodeWarned = false;

    setStatus({ kind: "connecting" });
    viewportRef.current = null;

    const ws = new WebSocket(buildBrowserWsUrl(browserSession.id));
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    const draw = (bitmap: ImageBitmap) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
      if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
      ctx.drawImage(bitmap, 0, 0);
    };

    const decodeNext = () => {
      if (cancelled || decoding || !pendingFrame) return;
      // 隠れている間はデコードしない。最新の1枚を持ったまま、見えるのを待つ
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      const data = pendingFrame;
      pendingFrame = null;
      decoding = true;
      let decoded: Promise<ImageBitmap>;
      try {
        decoded = createImageBitmap(new Blob([data], { type: "image/jpeg" }));
      } catch (error) {
        decoded = Promise.reject(error);
      }
      decoded
        .then(bitmap => {
          try {
            // 接続をやり直したあとに終わった分は描かない
            if (!cancelled) draw(bitmap);
          } finally {
            bitmap.close();
          }
        })
        .catch((error: unknown) => {
          // 壊れたフレームは捨てる。次のフレームで描き直される
          if (decodeWarned) return;
          decodeWarned = true;
          console.warn("[BrowserPane] フレームを描けません:", error);
        })
        .then(() => {
          decoding = false;
          decodeNext();
        });
    };
    decodeNextRef.current = decodeNext;

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
          if (msg.t === "viewport" && isSize(msg.width) && isSize(msg.height)) {
            viewportRef.current = { width: msg.width, height: msg.height };
          }
        } catch {
          // 読めないメッセージは捨てる
        }
        return;
      }
      pendingFrame = event.data as ArrayBuffer;
      decodeNext();
    };
    ws.onclose = event => {
      if (cancelled) return;
      dropInputState();
      setStatus({
        kind: "disconnected",
        reason: serverError || event.reason || DISCONNECTED_REASON,
      });
    };

    return () => {
      cancelled = true;
      pendingFrame = null;
      if (decodeNextRef.current === decodeNext) decodeNextRef.current = null;
      // 自分で閉じたときに「切断されました」を出さないよう、先にハンドラを外す
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.close();
      if (wsRef.current === ws) wsRef.current = null;
      dropInputState();
    };
  }, [browserSession.id, attempt, sendSize, dropInputState]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      sendSize();
      // 隠れている間に届いたフレームを、見えたところで描く
      decodeNextRef.current?.();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [sendSize]);

  // 手元の倍率が変わったら (倍率の違う画面へウィンドウを動かした、拡大率を変えた)、
  // ペインの寸法が同じでも送り直す。メディアクエリはいまの倍率に一致するものなので、
  // 変わるたびに新しい倍率で聞き直す
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    let query: MediaQueryList | null = null;
    const onChange = () => {
      sendSize();
      listen();
    };
    const listen = () => {
      query?.removeEventListener?.("change", onChange);
      query = window.matchMedia(
        `(resolution: ${window.devicePixelRatio || 1}dppx)`
      );
      query.addEventListener?.("change", onChange);
    };
    listen();
    return () => query?.removeEventListener?.("change", onChange);
  }, [sendSize]);

  // つながっていない間は、入力欄にフォーカスを残さない。残すと、再接続ボタンへ
  // キーボードで移る前に、入力欄へ文字が入る
  useEffect(() => {
    if (status.kind !== "connected") inputRef.current?.blur();
  }, [status.kind]);

  // ウィンドウのフォーカスが外れると、キーとボタンのupは届かない
  useEffect(() => {
    window.addEventListener("blur", releaseHeld);
    return () => window.removeEventListener("blur", releaseHeld);
  }, [releaseHeld]);

  const pointerMessage = (
    type: "down" | "up" | "move",
    e: MouseEvent
  ): BrowserMouseMessage | null => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const msg = toViewport(
      mouseMessage(type, e, rect),
      rect,
      viewportRef.current
    );
    if (msg) lastPointerRef.current = { x: msg.x, y: msg.y };
    return msg;
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

  // downとupの前に、持っているmoveを先に送る (順序が入れ替わるとドラッグの終点がずれる)。
  // 送れなかったら (ビューポートの寸法をまだ知らない) falseを返す
  const sendButton = (type: "down" | "up", e: MouseEvent): boolean => {
    flushMove();
    const msg = pointerMessage(type, e);
    if (!msg) return false;
    send(msg);
    if (type === "down") heldButtonsRef.current.add(e.button);
    else heldButtonsRef.current.delete(e.button);
    return true;
  };

  // ボタンを押したままペインの外へ出ても追えるよう、押している間はwindowで聞く
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

  // ビューポートがこのペインの寸法と違えば (ほかの視聴者が寸法を送った)、自分の寸法を送る
  const claimViewport = (container: DOMRect) => {
    const viewport = viewportRef.current;
    const width = Math.round(container.width);
    const height = Math.round(container.height);
    if (!viewport || width < 1 || height < 1) return;
    if (viewport.width !== width || viewport.height !== height) sendSize();
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    // 接続中と切断の表示が上に載っている間は、再接続ボタンの操作を邪魔しない
    if (status.kind !== "connected") return;
    // 既定の動作 (フォーカスの移動と文字の選択) を止め、フォーカスを入力欄に固定する
    e.preventDefault();
    const container = containerRef.current?.getBoundingClientRect();
    const input = inputRef.current;
    if (container && input) {
      // 入力欄を押した位置へ動かす。IMEの候補ウィンドウがその近くに出る
      input.style.left = `${e.clientX - container.left}px`;
      input.style.top = `${e.clientY - container.top}px`;
      input.focus({ preventScroll: true });
    }
    // 寸法が先。downの座標は、いま映っているフレームのビューポートで換算したまま送る
    if (container) claimViewport(container);
    if (sendButton("down", e.nativeEvent)) startDrag();
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    // 押している間はwindowのリスナーが送る。ここでも送ると二重になる
    if (stopDragRef.current) return;
    queueMove(e.nativeEvent);
  };

  // ReactのonWheelはpassiveでpreventDefaultできないので、自分で付ける
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const msg = toViewport(wheelMessage(e, rect), rect, viewportRef.current);
      if (msg) send(msg);
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [send]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // つながっていない間は何もしない。TabやEnterで再接続ボタンを操作できるようにする
    if (status.kind !== "connected") return;
    // 貼り付けはキーとして送らず、ブラウザのpasteイベントに任せる
    if (isPasteShortcut(e.nativeEvent)) return;
    const msg = keyMessage(e.nativeEvent, "down");
    if (!msg) return;
    // 手元の入力欄には文字を入れない (入れるとonInputが同じ文字をもう一度送る)。
    // コピーや切り取りのショートカットも、ここでは普通のキーとして送るだけ
    e.preventDefault();
    if (
      e.key === "Enter" &&
      performance.now() - compositionEndAtRef.current <= COMPOSITION_ENTER_MS
    ) {
      return;
    }
    send(msg);
    heldKeysRef.current.set(e.code || e.key, {
      key: e.key,
      code: e.code,
      keyCode: e.nativeEvent.keyCode,
    });
  };

  // upを送るのは、downを送ったキーだけ。貼り付けのショートカットや変換を確定したEnterの
  // ように、downを送らなかったキーのupは送らない
  const handleKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (status.kind !== "connected") return;
    const id = e.code || e.key;
    const held = heldKeysRef.current.get(id);
    if (!held) return;
    heldKeysRef.current.delete(id);
    // 押している間に変換が始まると、upは変換中のキーに見える。それでもリモートでは離す
    send(
      keyMessage(e.nativeEvent, "up") ?? {
        t: "key",
        type: "up",
        ...held,
        repeat: false,
        modifiers: 0,
      }
    );
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

  // 確定の文字列を送るのはcompositionendとonInputのどちらか一方だけ。
  // 変換の確定はここで送り、入力欄を空にする。Chromeはこのあとに
  // isComposing: falseのinputを出すが、値が空なのでonInputは送らない
  const handleCompositionEnd = (
    e: React.CompositionEvent<HTMLTextAreaElement>
  ) => {
    compositionEndAtRef.current = performance.now();
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
  // 変換中のinputは送らない。Firefoxはcompositionendより先に
  // isComposing: trueのinputを出すので、確定はcompositionendに任せる
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
    // サーバーは長すぎるメッセージを捨てるので、分けて順に送る
    for (const chunk of chunkPasteText(text)) send({ t: "paste", text: chunk });
  };

  const handleBlur = (e: React.FocusEvent<HTMLTextAreaElement>) => {
    // 変換の途中でフォーカスが外れたら、リモートに残る未確定の文字列を消す
    if (composingRef.current) {
      composingRef.current = false;
      e.currentTarget.value = "";
      send({ t: "ime", type: "cancel" });
    }
    releaseHeld();
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
      {/* ポインタの操作は受けない (受けると、入力欄の上を押したときにペインへ届かない)。
          置く場所を決めておくのは、フォーカスしたときにペインがスクロールしないようにするため */}
      <textarea
        ref={inputRef}
        aria-label="ブラウザへの入力"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className="pointer-events-none absolute left-0 top-0 h-px w-px opacity-0 resize-none border-0 p-0 outline-none"
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
