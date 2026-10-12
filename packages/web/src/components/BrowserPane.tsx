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
  canvasScale,
  FRAME_HEADER_BYTES,
  FRAME_QUEUE_LIMIT,
  type FrameHeader,
  frameImageType,
  parseFrameHeader,
  pruneQueue,
  REFRESH_INTERVAL_MS,
  refreshIntervalMs,
} from "@/lib/browser-frame";
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
const GEN_MAX = 0xffff;

interface Size {
  width: number;
  height: number;
}

/** canvasの画素数と、ビューポートのCSSピクセル1つに持つ画素の数 */
interface CanvasSize extends Size {
  scale: 1 | 2;
}

/** 復号を待つフレーム。`data` はヘッダを含む、届いたままのバイト列 */
interface QueuedFrame {
  header: FrameHeader;
  data: ArrayBuffer;
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

function isGen(value: unknown): value is number {
  return (
    Number.isInteger(value) && Number(value) >= 0 && Number(value) <= GEN_MAX
  );
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
 *
 * canvasの画素数は、届いた画像ではなく、サーバーが知らせるビューポートの寸法で決める
 * (ビューポートの寸法に、1か2の倍率を掛ける。倍率の決まりは `canvasScale`)。届く画像は、
 * 画面の一部の矩形や粗い全画面のこともあり、画像の寸法は画面の寸法を表さない。倍率を
 * 整数にするのは、矩形をcanvasの画素の境目へちょうど描くため。整数でないと、丸めた分だけ
 * 矩形が隣の絵へはみ出し、次の全画面まで直らない。この倍率は描く細かさを決めるだけで、
 * 座標の換算には使わない。
 *
 * 画素数を変えるとcanvasは消える。そこで、変えるのは次の全画面を描く直前にし、同じ処理の
 * 中で続けて描く。それまでは前の絵を残す。ビューポートの世代が変わったときは、サーバーが
 * 全画面を送る。手元の倍率が変わってcanvasの倍率が変わったときは、サーバーは世代を
 * 変えないので、こちらから全画面を頼む。座標の換算に使うビューポートの寸法は、絵が
 * 替わるのを待たず、知らされた時点で替える。
 *
 * フレームは、届いた順に1枚ずつ復号して描く。矩形は前の絵に重ねる差分なので、
 * 間を飛ばさない。全画面が届いたら、その前で待っていた分は上書きされるので捨てる。
 * ビューポートの世代が違うフレームは描かない。1枚でも取りこぼしたら (復号の失敗、
 * 描画先が無い、待ち行列の溢れ、隠れている間に届いた、読めないヘッダ)、待っている分を
 * 捨てて全画面の送り直しを頼み、次の全画面が届くまで矩形を描かない。穴の空いた絵に
 * 矩形を重ねても、正しい絵にならない。ただし、描けなかったフレームのあとに全画面が
 * 待っていれば、その全画面が絵を直すので、頼まずに続きを描く。隠れている間は復号せず、
 * 見えるようになったときに1回だけ頼む。隠れているかどうかは、寸法の監視が知らせた値を
 * 覚えておき、フレームのたびにレイアウトを読まない。
 *
 * 送り直しを頼むのは、前に頼んでから500ms以上空けて、1回ずつ。頼んだ全画面が届けば、
 * 待っている分は取り消す (世代が変わったときも、全画面が届くので取り消す)。描けない失敗
 * (復号の失敗、描画先が無い) が続く間は、頼む間隔を失敗のたびに倍にして8秒まで延ばし、
 * 1枚描けたら元へ戻す。手元で描けない画像を送られ続けても、頼むのは8秒に1回で止まる。
 * ほかの理由で頼むときは、間隔を延ばさない。
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
  // ペインが見えているか (寸法が0でないか)。寸法の監視が更新する
  const visibleRef = useRef(true);
  // ペインが見えるようになったときに、頼みそびれた全画面の送り直しを頼む。接続のeffectが入れる
  const resumeRef = useRef<(() => void) | null>(null);
  // 手元の倍率が変わったときに、canvasの倍率を決め直す。接続のeffectが入れる
  const rescaleRef = useRef<(() => void) | null>(null);
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
    // 復号を待つフレーム。届いた順に並べ、先頭から1枚ずつ復号する
    let queue: QueuedFrame[] = [];
    let decoding = false;
    let paintWarned = false;
    let viewportWarned = false;
    // サーバーが最後に知らせたビューポートの世代。知らされるまではフレームを描かない
    let gen: number | null = null;
    // 全画面を待っている間は、矩形を描かない。重ねる先の絵が無いか、穴が空いている
    let awaitingFull = true;
    // いまのcanvasの倍率。フレームの位置と寸法に掛けて描く
    let scale: 1 | 2 = 1;
    // 次の全画面を描く直前に、canvasへ当てる画素数と倍率
    let pendingCanvas: CanvasSize | null = null;
    // 描けない失敗が続いた回数。1枚描けたら0へ戻す
    let failures = 0;
    let refreshWanted = false;
    // 待っている送り直しが、前に頼んでから空ける間隔
    let refreshGap = REFRESH_INTERVAL_MS;
    let lastRefreshAt = Number.NEGATIVE_INFINITY;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    setStatus({ kind: "connecting" });
    viewportRef.current = null;

    const ws = new WebSocket(buildBrowserWsUrl(browserSession.id));
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    const clearRefreshTimer = () => {
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      refreshTimer = null;
    };

    const cancelRefresh = () => {
      refreshWanted = false;
      clearRefreshTimer();
    };

    // 頼むのは、見えていて、つながっていて、前に頼んでから間隔が空いているときだけ。
    // 間隔が空いていなければ、空くのを待って頼む
    const flushRefresh = () => {
      if (cancelled || !refreshWanted || refreshTimer !== null) return;
      if (ws.readyState !== WebSocket.OPEN || !visibleRef.current) return;
      const wait = lastRefreshAt + refreshGap - performance.now();
      if (wait > 0) {
        refreshTimer = setTimeout(() => {
          refreshTimer = null;
          flushRefresh();
        }, wait);
        return;
      }
      refreshWanted = false;
      lastRefreshAt = performance.now();
      const msg: BrowserClientMessage = { t: "refresh" };
      ws.send(JSON.stringify(msg));
    };
    resumeRef.current = flushRefresh;

    /**
     * フレームを取りこぼしたとき。待っている分を捨て、全画面の送り直しを頼む。
     * `interval` は前に頼んでから空ける間隔。待っている分があれば、短いほうに合わせる
     */
    const requestRefresh = (interval = REFRESH_INTERVAL_MS) => {
      queue = [];
      awaitingFull = true;
      refreshGap = refreshWanted ? Math.min(refreshGap, interval) : interval;
      refreshWanted = true;
      // 間隔が変わったかもしれないので、待つ時間を計り直す
      clearRefreshTimer();
      flushRefresh();
    };

    /** 復号したフレームを描けなかったとき */
    const failPaint = (error: unknown) => {
      failures += 1;
      if (!paintWarned) {
        paintWarned = true;
        console.warn("[BrowserPane] フレームを描けません:", error);
      }
      // 全画面が待っていれば、それが絵を直す。頼まずに続きを描く
      if (queue.some(queued => queued.header.kind !== 3)) return;
      requestRefresh(refreshIntervalMs(failures));
    };

    /** 描けたら `true`。描画先が無ければ、canvasに触れずに `false` */
    const paint = (header: FrameHeader, bitmap: ImageBitmap): boolean => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return false;
      if (header.kind !== 3 && pendingCanvas) {
        // 同じ値でも代入するとcanvasが消えるので、違うときだけ変える
        if (canvas.width !== pendingCanvas.width) {
          canvas.width = pendingCanvas.width;
        }
        if (canvas.height !== pendingCanvas.height) {
          canvas.height = pendingCanvas.height;
        }
        scale = pendingCanvas.scale;
        pendingCanvas = null;
      }
      ctx.drawImage(
        bitmap,
        header.x * scale,
        header.y * scale,
        header.width * scale,
        header.height * scale
      );
      return true;
    };

    const decodeNext = () => {
      if (cancelled || decoding || queue.length === 0) return;
      // 隠れている間は復号しない。待っている分は捨て、見えたときに全画面を頼む
      if (!visibleRef.current) {
        requestRefresh();
        return;
      }
      const item = queue.shift();
      if (!item) return;
      decoding = true;
      let decoded: Promise<ImageBitmap>;
      try {
        const type = frameImageType(item.data);
        if (!type) throw new Error("JPEGでもWebPでもない画像です");
        decoded = createImageBitmap(
          new Blob([new Uint8Array(item.data, FRAME_HEADER_BYTES)], { type })
        );
      } catch (error) {
        decoded = Promise.reject(error);
      }
      decoded
        .then(bitmap => {
          try {
            // 接続をやり直したあとや、世代が変わったあとに終わった分は描かない
            if (cancelled || item.header.gen !== gen) return;
            if (!paint(item.header, bitmap)) {
              throw new Error("canvasの描画先がありません");
            }
            failures = 0;
          } finally {
            bitmap.close();
          }
        })
        .catch((error: unknown) => {
          if (cancelled || item.header.gen !== gen) return;
          failPaint(error);
        })
        .then(() => {
          decoding = false;
          decodeNext();
        });
    };

    const receiveFrame = (data: ArrayBuffer) => {
      if (gen === null) return;
      const header = parseFrameHeader(data);
      if (!header) {
        requestRefresh();
        return;
      }
      if (header.gen !== gen) return;
      if (!visibleRef.current) {
        requestRefresh();
        return;
      }
      if (header.kind === 3) {
        if (awaitingFull) return;
      } else {
        // 全画面が届いたので、頼まなくても絵は揃う
        awaitingFull = false;
        cancelRefresh();
      }
      queue = pruneQueue([...queue, { header, data }], gen);
      if (queue.length > FRAME_QUEUE_LIMIT) {
        requestRefresh();
        return;
      }
      decodeNext();
    };

    /**
     * いまのビューポートと手元の倍率から、canvasの画素数を決め直す。変わるなら、次の全画面で
     * 当てるように覚えて `true` を返す
     */
    const retargetCanvas = (): boolean => {
      const viewport = viewportRef.current;
      if (!viewport) return false;
      const nextScale = canvasScale(viewport, window.devicePixelRatio || 1);
      const next: CanvasSize = {
        width: viewport.width * nextScale,
        height: viewport.height * nextScale,
        scale: nextScale,
      };
      const canvas = canvasRef.current;
      const current =
        pendingCanvas ??
        (canvas ? { width: canvas.width, height: canvas.height, scale } : null);
      if (
        current &&
        current.width === next.width &&
        current.height === next.height &&
        current.scale === next.scale
      ) {
        return false;
      }
      pendingCanvas = next;
      return true;
    };

    const applyViewport = (width: number, height: number, nextGen: number) => {
      // 座標の換算は、ここから新しい寸法を使う
      viewportRef.current = { width, height };
      const genChanged = nextGen !== gen;
      if (genChanged) {
        // 前の世代のフレームは、寸法の違う画面のもの。新しい世代は全画面から始まり、
        // サーバーが頼まれなくても送る
        gen = nextGen;
        queue = [];
        awaitingFull = true;
        cancelRefresh();
      }
      // 世代が同じまま画素数が変わるなら、全画面は届かないので頼む
      if (retargetCanvas() && !genChanged) requestRefresh();
    };

    rescaleRef.current = () => {
      if (gen !== null && retargetCanvas()) requestRefresh();
    };
    const rescale = rescaleRef.current;

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
          if (msg.t === "viewport") {
            if (isSize(msg.width) && isSize(msg.height) && isGen(msg.gen)) {
              applyViewport(msg.width, msg.height, msg.gen);
            } else {
              // 世代が分からないと、このあとのフレームを全部捨てることになる
              if (!viewportWarned) {
                viewportWarned = true;
                console.warn("[BrowserPane] viewportを読めません:", msg);
              }
              requestRefresh();
            }
          }
        } catch {
          // 読めないメッセージは捨てる
        }
        return;
      }
      receiveFrame(event.data as ArrayBuffer);
    };
    ws.onclose = event => {
      if (cancelled) return;
      queue = [];
      cancelRefresh();
      dropInputState();
      setStatus({
        kind: "disconnected",
        reason: serverError || event.reason || DISCONNECTED_REASON,
      });
    };

    return () => {
      cancelled = true;
      queue = [];
      cancelRefresh();
      if (resumeRef.current === flushRefresh) resumeRef.current = null;
      if (rescaleRef.current === rescale) rescaleRef.current = null;
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
    // display: none (Tailwindのhidden) で隠れている間は0になる
    const measure = () => {
      const rect = container.getBoundingClientRect();
      visibleRef.current = rect.width > 0 && rect.height > 0;
    };
    measure();
    const observer = new ResizeObserver(() => {
      measure();
      sendSize();
      // 隠れている間にフレームを取りこぼしていたら、見えたところで全画面を頼む
      resumeRef.current?.();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [sendSize]);

  // 手元の倍率が変わったら (倍率の違う画面へウィンドウを動かした、拡大率を変えた)、
  // ペインの寸法が同じでも送り直し、canvasの倍率を決め直す。メディアクエリはいまの倍率に
  // 一致するものなので、変わるたびに新しい倍率で聞き直す
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    let query: MediaQueryList | null = null;
    const onChange = () => {
      sendSize();
      rescaleRef.current?.();
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
