/**
 * static-cache - Web UI の静的ファイルに付ける Cache-Control の判定
 *
 * vite build は `assets/` 配下のファイル名に内容のハッシュを入れる。中身が変われば
 * 名前も変わるので、ブラウザは一度取ったものを問い合わせなしで使い回してよい。
 * express.static の既定 (max-age=0) のままだと、起動のたびに全ファイルの再検証が
 * トンネルを往復し、モバイル回線ではそれが起動の待ち時間になる。
 *
 * index.html と `public/` 由来のファイル (manifest、アイコン) は名前が変わらないので、
 * 毎回確かめさせる。index.html を使い回すと、デプロイ後も古いハッシュを指し続ける。
 *
 * 長期キャッシュが付くのは実在するファイルを返したときだけ。`assets/` の未ヒットは
 * `spa-fallback.ts` が 404 に落とすので、偽のアセットが居座ることはない。
 */

import path from "node:path";

export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const REVALIDATE_CACHE_CONTROL = "no-cache";

/** `staticDir` から配信する `filePath` (絶対パス) の Cache-Control を返す */
export function staticCacheControl(
  staticDir: string,
  filePath: string
): string {
  const relative = path.relative(staticDir, filePath);
  const hashed = relative.split(path.sep)[0] === "assets";
  return hashed ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL;
}
