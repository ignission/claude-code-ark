import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Loader2,
  Monitor,
  RotateCw,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type {
  BrowserSession,
  ClientToServerEvents,
  ServerToClientEvents,
} from "../../../shared/types";
import { Button } from "./ui/button";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface BrowserPaneProps {
  url: string;
  port: number;
  socket: TypedSocket | null;
}

/** ローカルアクセスかどうかを判定 */
function isLocalAccess(): boolean {
  return (
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
  );
}

/** URLをローカル/リモートに応じて解決 */
function resolveUrl(url: string): string {
  if (isLocalAccess()) {
    return url;
  }
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      const defaultPort = parsed.protocol === "https:" ? "443" : "80";
      return `/proxy/${parsed.port || defaultPort}${parsed.pathname}${parsed.search}`;
    }
  } catch {
    // パース失敗時はそのまま返す
  }
  return url;
}

/** URLからtokenパラメータを取得 */
function getUrlToken(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("token");
}

export function BrowserPane({ url, port, socket }: BrowserPaneProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const isLocal = isLocalAccess();
  const resolvedUrl = resolveUrl(url);

  // リモート時のnoVNCセッション管理
  const [browserSession, setBrowserSession] = useState<BrowserSession | null>(
    null
  );
  const [isLoading, setIsLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const browserSessionRef = useRef<BrowserSession | null>(null);

  // browserSessionRefを同期
  useEffect(() => {
    browserSessionRef.current = browserSession;
  }, [browserSession]);

  // リモートアクセス時: Socket.IOでnoVNCセッションを起動
  useEffect(() => {
    if (isLocal || !socket) return;

    setIsLoading(true);
    setRemoteError(null);

    const handleStarted = (session: BrowserSession) => {
      setBrowserSession(session);
      browserSessionRef.current = session;
      setIsLoading(false);
      setRemoteError(null);
    };

    const handleError = (data: { message: string }) => {
      setRemoteError(data.message);
      setIsLoading(false);
    };

    socket.on("browser:started", handleStarted);
    socket.on("browser:error", handleError);

    // ブラウザセッション起動をリクエスト
    socket.emit("browser:start", { port, url });

    return () => {
      socket.off("browser:started", handleStarted);
      socket.off("browser:error", handleError);

      // クリーンアップ: セッションを停止
      const currentSession = browserSessionRef.current;
      if (currentSession) {
        socket.emit("browser:stop", { browserId: currentSession.id });
      }
    };
  }, [isLocal, socket, port, url]);

  const handleReload = useCallback(() => {
    setIframeKey(k => k + 1);
  }, []);

  const handleOpenExternal = useCallback(() => {
    window.open(url, "_blank");
  }, [url]);

  // リモートアクセス時のnoVNC URL構築
  const getNoVncUrl = (): string | null => {
    if (!browserSession) return null;
    const token = getUrlToken();
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
    const wsPath = `browser/${browserSession.id}/websockify`;
    return `/browser/${browserSession.id}/vnc.html?autoconnect=true&resize=scale&path=${encodeURIComponent(wsPath)}${tokenParam}`;
  };

  // ローディング状態（リモートのみ）
  if (!isLocal && isLoading) {
    return (
      <div className="h-full flex flex-col bg-background">
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin" />
            <span className="text-sm">ブラウザセッションを起動中...</span>
          </div>
        </div>
      </div>
    );
  }

  // エラー状態（リモートのみ）
  if (!isLocal && remoteError) {
    return (
      <div className="h-full flex flex-col bg-background">
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-destructive">
            <span className="text-sm">
              ブラウザセッションエラー: {remoteError}
            </span>
          </div>
        </div>
      </div>
    );
  }

  // リモートでnoVNCセッションがまだない場合
  const noVncUrl = !isLocal ? getNoVncUrl() : null;
  if (!isLocal && !noVncUrl) {
    return (
      <div className="h-full flex flex-col bg-background">
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin" />
            <span className="text-sm">ブラウザセッションを起動中...</span>
          </div>
        </div>
      </div>
    );
  }

  const iframeSrc = isLocal ? resolvedUrl : (noVncUrl as string);
  const isRemote = !isLocal;

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          disabled={isRemote}
          onClick={() => {
            try {
              iframeRef.current?.contentWindow?.history.back();
            } catch {
              // クロスオリジンiframe
            }
          }}
          title="戻る"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          disabled={isRemote}
          onClick={() => {
            try {
              iframeRef.current?.contentWindow?.history.forward();
            } catch {
              // クロスオリジンiframe
            }
          }}
          title="進む"
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={handleReload}
          title="リロード"
        >
          <RotateCw className="h-3.5 w-3.5" />
        </Button>
        <div className="flex-1 flex items-center bg-muted rounded px-2 py-0.5 text-xs text-muted-foreground truncate mx-1 gap-1">
          {isRemote && <Monitor className="h-3 w-3 shrink-0" />}
          <span className="truncate">{url}</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={handleOpenExternal}
          title="外部ブラウザで開く"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex-1 min-h-0">
        <iframe
          key={iframeKey}
          ref={iframeRef}
          src={iframeSrc}
          className="w-full h-full border-0"
          title={`Browser - ${url}`}
        />
      </div>
    </div>
  );
}
