import { type RefObject, useEffect, useRef } from "react";
import {
  createTtydReconnectState,
  isTtydStuckOverlay,
  stepTtydReconnect,
  type TtydReconnectState,
} from "@/lib/ttyd-reconnect";
import { usePersistFn } from "./usePersistFn";

/**
 * ttyd の接続断を監視する間隔 (ms)。
 *
 * MutationObserver ではなく polling にしているのは 2 点の理由による。
 *
 * - 切断は visibilitychange の「後」に届く。バックグラウンド復帰の瞬間に
 *   1 回だけ見ても overlay はまだ出ていないので、定期的に見る必要がある
 * - overlay は xterm の描画 DOM と同じ木の中にあり、DOM renderer 使用時は
 *   端末出力のたびに mutation が飛ぶ。監視より数秒おきの読み取りの方が軽い
 */
const POLL_INTERVAL_MS = 1_500;

interface UseTtydReconnectOptions {
  /** ターミナルが実際に画面へ出ているか (display:none の残置ペインは false) */
  isVisible: boolean;
  /** iframe を貼り直す (呼び出し側の iframeKey を進める) */
  onReload: () => void;
}

/**
 * ttyd が切断されたまま "Press ⏎ to Reconnect" で止まったら iframe を貼り直す。
 *
 * モバイル Chrome のバックグラウンド復帰やスリープ復帰で WebSocket が落ちると、
 * ttyd 自身の自動再接続は効かず端末が固まったままになる (理由は
 * `@/lib/ttyd-reconnect` のコメント参照)。判定と抑止のロジックはそちらに置き、
 * ここは iframe から観測して結果を反映するだけにしている。
 */
export function useTtydReconnect(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  iframeKey: number,
  { isVisible, onReload }: UseTtydReconnectOptions
) {
  const stateRef = useRef<TtydReconnectState>(createTtydReconnectState());
  const exhaustedRef = useRef(false);
  const reload = usePersistFn(onReload);

  // biome-ignore lint/correctness/useExhaustiveDependencies: iframeKey は iframe 貼り直し後に監視を張り直すために必要
  useEffect(() => {
    const check = () => {
      let ready = false;
      let stuck = false;
      try {
        const iframeWindow = iframeRef.current?.contentWindow;
        if (!iframeWindow) return;
        // biome-ignore lint/suspicious/noExplicitAny: ttyd iframe 内の xterm オブジェクトにアクセスするため
        const term = (iframeWindow as any).term;
        const element: Element | undefined = term?.element;
        ready = Boolean(element);
        stuck = isTtydStuckOverlay(element);
      } catch {
        // 読み込み途中でクロスオリジン扱いになる等。次の観測に任せる
        return;
      }

      // ブラウザ側がバックグラウンドのときにリロードしても無駄なので待つ
      const pageVisible = document.visibilityState === "visible";

      const result = stepTtydReconnect(stateRef.current, {
        ready,
        stuck,
        isVisible: isVisible && pageVisible,
        online: navigator.onLine,
        now: Date.now(),
      });
      stateRef.current = result.state;

      if (result.exhausted) {
        if (!exhaustedRef.current) {
          exhaustedRef.current = true;
          console.warn(
            "[ark] ttyd の自動再接続を諦めました。手動でリロードしてください"
          );
        }
      } else {
        exhaustedRef.current = false;
      }

      if (result.reload) {
        console.info("[ark] ttyd が切断されたため iframe を貼り直します");
        reload();
      }
    };

    check();
    const intervalId = setInterval(check, POLL_INTERVAL_MS);
    // コールバックはフリーズ中に動かないので、復帰の合図でも即座に見る
    const handleWake = () => check();
    document.addEventListener("visibilitychange", handleWake);
    window.addEventListener("pageshow", handleWake);
    window.addEventListener("online", handleWake);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleWake);
      window.removeEventListener("pageshow", handleWake);
      window.removeEventListener("online", handleWake);
    };
  }, [iframeRef, iframeKey, isVisible, reload]);
}
