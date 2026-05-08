/** ttydポート範囲の開始ポート */
export const TTYD_PORT_START = 7680;

/** ttydポート範囲の終了ポート */
export const TTYD_PORT_END = 7780;

/**
 * 1ttydインスタンス（=1tmuxセッション）あたりの最大同時接続数
 *
 * Why: ttyd 1.7.4 には idle timeout オプションが無く、stale な WebSocket
 *      接続（タブclose・ネットワーク断・スリープ復帰で綺麗に閉じない接続）
 *      が累積すると ttyd が epoll_wait を空回りして %sys CPU を浴び続ける。
 *      `-m` で接続数に上限を設けて累積を頭打ちにする。
 * 想定: PC + iPhone + 別タブ + リモートトンネル越し = 最大4接続を想定し、
 *      余裕分を1足して5。
 */
export const TTYD_MAX_CLIENTS = 5;

/**
 * VNCポート範囲の開始ポート（x11vnc用）
 *
 * 注: x11vncには `-rfbport <port>` で明示的にポートを指定して起動しているため、
 * 標準のVNC `port = 5900 + display` マッピングには依存しない。
 * VNCポートとディスプレイ番号は独立して動的に割り当てられる。
 */
export const VNC_PORT_START = 5900;
/** VNCポート範囲の終了ポート */
export const VNC_PORT_END = 5999;
/** WebSocketポート範囲の開始ポート（websockify用） */
export const WS_PORT_START = 6080;
/** WebSocketポート範囲の終了ポート */
export const WS_PORT_END = 6179;
/**
 * Xvfb仮想ディスプレイ番号の開始値
 *
 * 注: 標準VNCの `port = 5900 + display` マッピングには依存しない
 * （上記VNC_PORT_STARTのコメント参照）。
 */
export const DISPLAY_START = 99;

/**
 * CDP（Chrome DevTools Protocol）リモートデバッグポート
 *
 * browser-manager.tsが起動するChromiumの `--remote-debugging-port` として使用する。
 * このポートはローカル127.0.0.1のみでリッスンされるが、`/proxy/:port/*` や
 * ポートスキャンから露出しないようブロックリストに含める必要がある。
 */
export const CDP_PORT = 9222;
