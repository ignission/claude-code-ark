/**
 * spa-fallback - SPA フォールバック (catch-all で index.html を返す) の対象判定
 *
 * /assets/ を除外する理由 (2026-07-20 の白画面障害の再発防止):
 *   vite build は dist を空にしてから書き直すため、再ビルドの狭間や
 *   ビルド入れ替え直後に旧ハッシュのアセットを要求したクライアントへ、
 *   フォールバックが index.html を **200** で返してしまう。ブラウザは
 *   その「偽アセット (HTML)」をキャッシュし、MIME 不一致でスクリプト
 *   実行を拒否するため、以後リロードしても白画面のままになる。
 *   アセットの未ヒットは 404 で明確に失敗させることで、キャッシュ汚染を防ぐ。
 *
 * /ttyd/ /proxy/ /browser/ は従来どおり別ハンドラ (プロキシ) の領域。
 */

/** SPA フォールバック (index.html 配信) の対象パスにマッチする正規表現 */
export const SPA_FALLBACK_ROUTE_PATTERN =
  /^(?!\/ttyd\/|\/proxy\/|\/browser\/|\/assets\/).*$/;
