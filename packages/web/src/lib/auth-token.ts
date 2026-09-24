/**
 * Quick Tunnel のトークンは URL のクエリで届く。Socket.IO は handshake の auth に、
 * 生の WebSocket (リモート画面) は upgrade リクエストのクエリに載せる。
 */

export function getAuthToken(): string | null {
  return new URLSearchParams(window.location.search).get("token");
}

/** リモート画面ブリッジ (`/screen/:id/ws`) の WebSocket URL */
export function buildScreenWsUrl(screenId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const base = `${protocol}://${window.location.host}/screen/${encodeURIComponent(screenId)}/ws`;
  const token = getAuthToken();
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}
