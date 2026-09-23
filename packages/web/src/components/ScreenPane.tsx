import type { Screen, ScreenCredentials } from "@ark/shared";
import RFB from "@novnc/novnc";
import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { buildScreenWsUrl } from "@/lib/auth-token";

interface ScreenPaneProps {
  screen: Screen;
  /** 接続の直前に 1 回だけ呼ぶ。未登録なら null */
  requestCredentials: (id: string) => Promise<ScreenCredentials | null>;
}

type Status =
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "disconnected"; reason: string };

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
  const rfbRef = useRef<RFB | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "connecting" });
  const [attempt, setAttempt] = useState(0);
  const secure = window.isSecureContext;

  const connect = useCallback(async () => {
    const container = containerRef.current;
    if (!container) return () => {};
    setStatus({ kind: "connecting" });

    const creds = await requestCredentials(screen.id);
    if (!creds) {
      setStatus({
        kind: "disconnected",
        reason:
          "画面の設定が見つかりません。画面の管理から登録し直してください",
      });
      return () => {};
    }

    let closeReason = "";
    let securityReason = "";
    const ws = new WebSocket(buildScreenWsUrl(screen.id));
    ws.binaryType = "arraybuffer";
    ws.addEventListener("close", event => {
      closeReason = event.reason;
    });

    const rfb = new RFB(container, ws, {
      credentials: { username: creds.username, password: creds.password },
    });
    rfb.scaleViewport = true;
    rfb.background = "transparent";
    rfb.addEventListener("connect", () => setStatus({ kind: "connected" }));
    rfb.addEventListener("securityfailure", event => {
      securityReason = `認証に失敗しました (${event.detail.reason ?? "理由不明"})`;
    });
    rfb.addEventListener("disconnect", event => {
      const reason =
        securityReason ||
        closeReason ||
        (event.detail.clean ? "切断されました" : "接続が切れました");
      setStatus({ kind: "disconnected", reason });
    });
    rfbRef.current = rfb;

    return () => {
      rfb.disconnect();
      if (rfbRef.current === rfb) rfbRef.current = null;
    };
  }, [screen.id, requestCredentials]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: secure と attempt (再接続ボタン押下時のカウンタ) の変化のたびに接続をやり直すための意図的な依存
  useEffect(() => {
    if (!secure) return;
    let cleanup: (() => void) | null = null;
    let cancelled = false;
    void connect().then(fn => {
      if (cancelled) fn();
      else cleanup = fn;
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [connect, secure, attempt]);

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
