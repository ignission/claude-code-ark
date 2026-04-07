import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { Button } from "./ui/button";

interface BrowserPaneProps {
  url: string;
}

function resolveUrl(url: string): string {
  if (
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
  ) {
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

export function BrowserPane({ url }: BrowserPaneProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const resolvedUrl = resolveUrl(url);

  const handleReload = useCallback(() => {
    setIframeKey(k => k + 1);
  }, []);

  const handleOpenExternal = useCallback(() => {
    window.open(url, "_blank");
  }, [url]);

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
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
        <div className="flex-1 bg-muted rounded px-2 py-0.5 text-xs text-muted-foreground truncate mx-1">
          {url}
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
          src={resolvedUrl}
          className="w-full h-full border-0"
          title={`Browser - ${url}`}
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      </div>
    </div>
  );
}
