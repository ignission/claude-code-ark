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
 *      余裕分を1足して5。1ユーザが複数接続を消費しうるため "client" ではなく
 *      "connection" の語を採用し、識別子にも "PER_INSTANCE" を含めて単位を明示。
 * 注: これは症状の天井化であり stale 接続自体は残る。idle 接続のクリーンアップ
 *     と上限到達時の退避策（health monitor）は #173 で対応予定。
 */
export const TTYD_MAX_CONNECTIONS_PER_INSTANCE = 5;
