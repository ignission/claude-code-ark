import type { Screen, ScreenCredentialsResult } from "@ark/shared";
import RFB from "@novnc/novnc";
import { Loader2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { buildScreenWsUrl } from "@/lib/auth-token";

interface ScreenPaneProps {
  screen: Screen;
  /** 接続の直前に 1 回だけ呼ぶ。未登録とサーバー不達を区別して返す */
  requestCredentials: (id: string) => Promise<ScreenCredentialsResult>;
}

type Status =
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "disconnected"; reason: string };

const DEFAULT_ERROR_REASON = "接続に失敗しました";
const UNREGISTERED_REASON =
  "画面の設定が見つかりません。画面の管理から登録し直してください";
const UNAVAILABLE_REASON =
  "サーバーに繋がりません。しばらくしてから再接続してください";

/**
 * リモート画面 (noVNC)。
 *
 * WebSocket は自前で開いて RFB に渡す。RFB は close の reason を
 * イベントに載せないので、close を自分で聞いて理由を表示に使う。
 * ARD 認証は WebCrypto を使うため、安全なコンテキスト
 * (localhost か HTTPS) でしか繋がらない。
 */
export function ScreenPane({ screen, requestCredentials }: ScreenPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>({ kind: "connecting" });
  const [attempt, setAttempt] = useState(0);
  const secure = window.isSecureContext;

  // requestCredentials は親の再レンダーごとに別インスタンスで渡ってくることがある。
  // effect の依存に入れるとその度にセッションを繋ぎ直してしまうため、最新の関数を
  // ref に持たせておき、effect からは ref 経由で読む（依存には入れない）
  const requestCredentialsRef = useRef(requestCredentials);
  requestCredentialsRef.current = requestCredentials;

  // 接続先の変更 (画面の管理で編集) は id が変わらないので、接続に使う列を個別に
  // 依存へ入れて繋ぎ直す。screen オブジェクトそのものを依存にすると screen:list の
  // 再配信のたびに別インスタンスになり、内容が同じでも繋ぎ直してしまう
  const { sshHost, sshPort, sshUser, vncHost, vncPort, vncUser } = screen;

  // biome-ignore lint/correctness/useExhaustiveDependencies: secure (window.isSecureContext) は文書の生存期間中に変わらない値なので依存から外している。attempt と接続先の各列は本文中では読まないが、再接続ボタン押下や接続先の編集のたびに接続をやり直すためだけの trigger として依存に入れている
  useEffect(() => {
    if (!secure) return;
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let ws: WebSocket | null = null;
    let rfb: RFB | null = null;
    let sizeObserver: ResizeObserver | null = null;
    // RFB が disconnect イベントを一度でも出したかどうか。既に切断済みの RFB へ
    // cleanup 側から重ねて disconnect() を呼ぶと noVNC がエラーログを出すため、
    // その二重切断を避ける目印に使う
    let ended = false;

    setStatus({ kind: "connecting" });

    const fail = (reason: string) => {
      if (cancelled) return;
      setStatus({ kind: "disconnected", reason });
    };

    // 隠していたペインが戻ってきたとき、倍率を組み直させる保険。
    // 表示の側 (Dashboard / MobileLayout) は display:none ではなく
    // visibility で隠してサイズを保つが、それでも 0 で計算された状態に
    // 落ちていたら、ここで scaleViewport を入れ直して再計算させる
    // (noVNC の setter は毎回 _updateScale() を呼ぶので、代入するだけでよい)
    const observeSize = (target: HTMLElement) => {
      if (typeof ResizeObserver === "undefined") return;
      let hadSize = target.clientWidth > 0 && target.clientHeight > 0;
      sizeObserver = new ResizeObserver(() => {
        const hasSize = target.clientWidth > 0 && target.clientHeight > 0;
        // 0 → 非 0 の遷移だけを拾う (毎回の resize は noVNC 自身が見ている)
        if (hasSize && !hadSize && !cancelled && !ended && rfb) {
          rfb.scaleViewport = true;
        }
        hadSize = hasSize;
      });
      sizeObserver.observe(target);
    };

    const run = async () => {
      try {
        const result = await requestCredentialsRef.current(screen.id);
        if (cancelled) return;
        if (result.kind === "unregistered") {
          fail(UNREGISTERED_REASON);
          return;
        }
        if (result.kind === "unavailable") {
          fail(UNAVAILABLE_REASON);
          return;
        }
        const creds = result.credentials;

        let closeReason = "";
        let securityReason = "";
        ws = new WebSocket(buildScreenWsUrl(screen.id));
        ws.binaryType = "arraybuffer";
        ws.addEventListener("close", event => {
          closeReason = event.reason;
        });

        rfb = new RFB(container, ws, {
          credentials: { username: creds.username, password: creds.password },
        });
        rfb.scaleViewport = true;
        rfb.background = "transparent";
        rfb.addEventListener("connect", () => {
          if (!cancelled) setStatus({ kind: "connected" });
        });
        rfb.addEventListener("securityfailure", event => {
          securityReason = `認証に失敗しました (${event.detail.reason ?? "理由不明"})`;
        });
        observeSize(container);
        rfb.addEventListener("disconnect", event => {
          ended = true;
          if (cancelled) return;
          const reason =
            securityReason ||
            closeReason ||
            (event.detail.clean ? "切断されました" : "接続が切れました");
          setStatus({ kind: "disconnected", reason });
        });
      } catch (error) {
        // WebSocket が既に開かれていたら、RFB 初期化失敗などで捨てる際に
        // サーバー側の ssh -W をぶら下げたままにしないよう明示的に閉じる
        ws?.close();
        fail(error instanceof Error ? error.message : DEFAULT_ERROR_REASON);
      }
    };

    // run() 内は try/catch で全経路をカバーしているので基本的に reject しないが、
    // 想定外の例外が漏れて unhandled rejection になることを避ける最後の砦として catch する
    run().catch(error => {
      fail(error instanceof Error ? error.message : DEFAULT_ERROR_REASON);
    });

    return () => {
      cancelled = true;
      sizeObserver?.disconnect();
      if (rfb && !ended) rfb.disconnect();
    };
  }, [
    screen.id,
    attempt,
    sshHost,
    sshPort,
    sshUser,
    vncHost,
    vncPort,
    vncUser,
  ]);

  if (!secure) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground px-6 text-center">
        リモート画面は HTTPS か localhost でだけ使えます (認証に WebCrypto
        が要るため)
      </div>
    );
  }

  return (
    <div className="relative h-full bg-black">
      <div ref={containerRef} className="absolute inset-0" />
      {status.kind === "connected" && (
        <button
          type="button"
          onClick={() => setAttempt(n => n + 1)}
          aria-label="再接続"
          title="再接続"
          className="absolute top-2 right-2 rounded-md bg-background/60 p-1.5 text-muted-foreground opacity-40 transition-opacity hover:opacity-100 hover:text-foreground"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      )}
      {status.kind === "connecting" && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground bg-background/80">
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          {screen.name} に接続中...
        </div>
      )}
      {status.kind === "disconnected" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm bg-background/90 px-6 text-center">
          <p className="text-muted-foreground break-all">{status.reason}</p>
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
