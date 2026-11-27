/**
 * Arkサーバーの待ち受けアドレス。
 *
 * 既定は 127.0.0.1。Arkがトークンを確かめるのは Quick Tunnel 経由のアクセスだけで
 * (`auth.ts`)、サーバーへ直接届くアクセスは素通しになる。全インターフェースで
 * 待ち受けると、同じネットワークの相手がターミナルとセッションを操作できてしまう。
 * Named Tunnel と Quick Tunnel の cloudflared は 127.0.0.1 へ接続するので、
 * 絞ってもトンネルの経路は変わらない。
 *
 * LANから直接使うときだけ `ARK_HOST` (例: `0.0.0.0`) で広げる。`HOST` は
 * シェルや他の道具が書き出していることがあり、意図せず広がるので読まない。
 */

import type { Server } from "node:net";

export const DEFAULT_LISTEN_HOST = "127.0.0.1";

/** 明示の指定 → `ARK_HOST` → 127.0.0.1 の順に決める。空白だけの値は未指定として扱う */
export function resolveListenHost(
  explicit?: string,
  envValue: string | undefined = process.env.ARK_HOST
): string {
  for (const value of [explicit, envValue]) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return DEFAULT_LISTEN_HOST;
}

/** ループバックだけで待ち受けるアドレスか */
export function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/** listen を Promise にする。待ち受けが始まるまで解決せず、失敗 (EADDRINUSE など) は reject する */
export function listenOn(
  server: Server,
  port: number,
  host: string
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
