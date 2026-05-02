/**
 * OAuth callback URL を loopback IP (127.0.0.1) で受ける一時 HTTP server。
 *
 * 用途:
 * - Ark サーバと同じマシンのブラウザから接続する場合の自動 callback 受信
 * - リモート (Cloudflare Tunnel 等) からアクセスしてる場合は user の browser
 *   から Ark サーバの 127.0.0.1 には届かないので、callback はペーストバック
 *   フォールバックで処理される。loopback server は起動しているが何も受信しない
 *   まま timeout する (それで OK; orchestrator 側がペースト経由で完了させる)
 *
 * 設計判断:
 * - port は OS 採番 (0)
 * - host は 127.0.0.1 固定 (RFC 8252 §7.3 / DCR 登録時 redirect_uri と一致)
 * - 1 ハンドル 1 回だけ awaitCallback を許す
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface LoopbackCallback {
  code: string;
  state: string;
}

export interface LoopbackCallbackHandle {
  redirectUri: string;
  awaitCallback(timeoutMs?: number): Promise<LoopbackCallback>;
  close(): Promise<void>;
}

export async function startLoopbackCallbackServer(
  opts: { path?: string } = {}
): Promise<LoopbackCallbackHandle> {
  const callbackPath = opts.path ?? "/callback";

  let resolveCallback: ((cb: LoopbackCallback) => void) | null = null;
  let rejectCallback: ((err: Error) => void) | null = null;
  let timeoutHandle: NodeJS.Timeout | null = null;

  const cleanup = () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    resolveCallback = null;
    rejectCallback = null;
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== callbackPath) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description");

    if (error) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><meta charset="utf-8"><h1>認証エラー</h1><p>${escapeHtml(error)}: ${escapeHtml(errorDescription ?? "")}</p>`
      );
      const reject = rejectCallback;
      cleanup();
      reject?.(
        new Error(`OAuth callback error: ${error} ${errorDescription ?? ""}`)
      );
      return;
    }

    if (!code || !state) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        '<!doctype html><meta charset="utf-8"><h1>認証エラー</h1><p>code または state が見つかりません。</p>'
      );
      const reject = rejectCallback;
      cleanup();
      reject?.(new Error("OAuth callback missing code or state"));
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      '<!doctype html><meta charset="utf-8"><h1>認証完了</h1><p>このタブを閉じて Ark に戻ってください。</p>'
    );
    const resolve = resolveCallback;
    cleanup();
    resolve?.({ code, state });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${addr.port}${callbackPath}`;

  let closed = false;
  let awaitStarted = false;

  return {
    redirectUri,
    async awaitCallback(timeoutMs = 5 * 60 * 1000): Promise<LoopbackCallback> {
      if (closed) {
        throw new Error("OAuth callback server is already closed");
      }
      if (awaitStarted) {
        throw new Error("awaitCallback can only be called once per handle");
      }
      awaitStarted = true;
      return new Promise<LoopbackCallback>((resolve, reject) => {
        resolveCallback = resolve;
        rejectCallback = reject;
        if (timeoutMs > 0) {
          timeoutHandle = setTimeout(() => {
            const r = rejectCallback;
            cleanup();
            r?.(new Error(`OAuth callback timeout after ${timeoutMs}ms`));
          }, timeoutMs);
        }
      });
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const reject = rejectCallback;
      cleanup();
      reject?.(
        new Error("OAuth callback server closed before callback received")
      );
      await new Promise<void>((resolve, reject2) => {
        server.close(err => (err ? reject2(err) : resolve()));
      });
    },
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
