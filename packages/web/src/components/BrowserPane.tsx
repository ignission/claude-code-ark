import type { BrowserSession } from "@ark/shared";
import { getAuthToken } from "@/lib/auth-token";

interface BrowserPaneProps {
  browserSession: BrowserSession;
}

export function BrowserPane({ browserSession }: BrowserPaneProps) {
  const token = getAuthToken();
  // tokenはpath内のクエリに含める必要がある。
  // noVNCは `path` をそのままWebSocket URLに使うため、
  // vnc.htmlのクエリに `token=` を付けるだけではupgradeリクエストに届かない。
  const wsPath = token
    ? `browser/${browserSession.id}/websockify?token=${encodeURIComponent(token)}`
    : `browser/${browserSession.id}/websockify`;
  const src = `/browser/${browserSession.id}/vnc.html?autoconnect=true&resize=scale&path=${encodeURIComponent(wsPath)}`;

  return (
    <div className="h-full bg-background">
      <iframe
        src={src}
        className="w-full h-full border-0"
        title="Remote Browser"
      />
    </div>
  );
}
