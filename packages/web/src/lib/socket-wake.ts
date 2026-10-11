/**
 * 画面が前面に戻ったときに Socket.IO をどう扱うかの判定。
 *
 * iOS はアプリを背面へ送ると WebSocket を止め、タイマーも凍らせる。前面に戻った
 * ときの接続は次のどちらかで、どちらも放っておくと待たされる。
 *
 * - 切れたと分かっている: Socket.IO は再接続の待ち (バックオフ、最大 5 秒) の途中に
 *   いる。待ちを捨ててすぐつなぎ直す
 * - つながっているように見える: 相手だけが切れていても close が届かないことがあり、
 *   その場合は ping の期限 (既定で 45 秒) まで気づかない。応答を求めて確かめ、
 *   続けて返らなければつなぎ直す。1回の期限切れでは切らない (回線が遅いだけの
 *   生きた接続を切ると、切れている間にサーバーが送ったイベントを落とす)
 *
 * 復帰の合図 (visibilitychange / pageshow / online) は同時に複数届く。続けて
 * つなぎ直すと進行中の接続を自分で捨てるので、直前のつなぎ直しから間を空ける。
 */

/** 強制的なつなぎ直しの最小間隔 (ms)。接続の確立にかかる時間より長くする */
export const SOCKET_WAKE_MIN_INTERVAL_MS = 3_000;

/** 生存確認の応答を待つ時間 (ms)。モバイル回線の往復より長く、待たされたと感じるより短く */
export const SOCKET_PROBE_TIMEOUT_MS = 2_000;

/** つなぎ直す前に生存確認を送る回数。応答の遅れと切断を分けるために2回見る */
export const SOCKET_PROBE_ATTEMPTS = 2;

export type SocketWakeAction = "none" | "probe" | "reconnect";

export interface SocketWakeInput {
  /** ページが前面に出ているか */
  visible: boolean;
  /** 回線があるか (navigator.onLine) */
  online: boolean;
  /** Socket.IO が接続済みと認識しているか */
  connected: boolean;
  /** 最後に接続を試みた時刻 (ms)。初回、Socket.IO の自動再接続、強制のつなぎ直しを含む */
  lastConnectAttemptAt: number;
  now: number;
}

export function decideSocketWakeAction(
  input: SocketWakeInput
): SocketWakeAction {
  // 背面では何をしても凍るだけ。回線が無いときは online の合図を待つ
  if (!input.visible || !input.online) return "none";
  if (input.connected) return "probe";
  if (input.now - input.lastConnectAttemptAt < SOCKET_WAKE_MIN_INTERVAL_MS) {
    return "none";
  }
  return "reconnect";
}
