/** ttydポート範囲の開始ポート */
export const TTYD_PORT_START = 7680;

/** ttydポート範囲の終了ポート */
export const TTYD_PORT_END = 7780;

/**
 * ttyd ログインインスタンス用ポート範囲（開始）
 *
 * `claude /login` を tmux 内で実行する `arklogin-*` セッションに対する
 * ttyd インスタンス専用のポート範囲。通常セッション用の `TTYD_PORT_*`
 * と衝突しないよう独立した範囲を確保する。
 */
export const TTYD_LOGIN_PORT_START = 7800;
/** ttyd ログインインスタンス用ポート範囲（終了） */
export const TTYD_LOGIN_PORT_END = 7819;

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
