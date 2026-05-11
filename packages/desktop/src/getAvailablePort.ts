/**
 * 空きポートを 1 つ確保して返す。
 *
 * `net.createServer().listen(0)` で OS にエフェメラルポートを割り当てさせ、
 * 即座に close する典型パターン。Ark の `.app` 起動時に `startServer({ port })`
 * へ渡す動的ポート決定に使う。
 *
 * 戻り値は「直前まで OS に予約されていたポート番号」であり、close から
 * `startServer` までの間に他プロセスが奪う可能性は理屈上ある。Phase 2 では
 * シングルユーザーの local 用途のみを想定し、衝突したら startServer 側の
 * listen エラーで判明する設計とする (リトライは F3 以降)。
 */
import { createServer } from "node:net";

export function getAvailablePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Failed to determine ephemeral port"));
        return;
      }
      const port = address.port;
      server.close(closeErr => {
        if (closeErr) {
          reject(closeErr);
        } else {
          resolve(port);
        }
      });
    });
  });
}
