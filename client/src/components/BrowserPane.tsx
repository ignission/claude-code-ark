import type { BrowserSession } from "../../../shared/types";

interface BrowserPaneProps {
  browserSession: BrowserSession;
}

/** URLからtokenパラメータを取得 */
function getUrlToken(): string | null {
  return new URLSearchParams(window.location.search).get("token");
}

export function BrowserPane({ browserSession }: BrowserPaneProps) {
  const token = getUrlToken();
  const wsPath = `browser/${browserSession.id}/websockify`;
  const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
  const src = `/browser/${browserSession.id}/vnc.html?autoconnect=true&resize=scale&path=${encodeURIComponent(wsPath)}${tokenParam}`;

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
