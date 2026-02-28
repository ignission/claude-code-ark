/**
 * Authentication Module
 *
 * Simple token-based authentication for remote access.
 * Generates a random token on startup that must be included in requests.
 */

import { randomBytes, timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";
import type { Socket } from "socket.io";

export class AuthManager {
  private token: string;
  private enabled: boolean;

  constructor(enabled: boolean = false) {
    this.enabled = enabled;
    this.token = this.generateToken();
  }

  /**
   * ランダムな認証トークンを生成
   */
  private generateToken(): string {
    return randomBytes(16).toString("hex");
  }

  /**
   * 現在のトークンを取得
   */
  getToken(): string {
    return this.token;
  }

  /**
   * 認証が有効かどうかを確認
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * 認証を有効化
   */
  enable(): void {
    this.enabled = true;
  }

  /**
   * 認証を無効化
   */
  disable(): void {
    this.enabled = false;
  }

  /**
   * トークンを再生成
   */
  regenerateToken(): string {
    this.token = this.generateToken();
    return this.token;
  }

  /**
   * トークンを検証
   */
  validateToken(token: string | undefined): boolean {
    if (!this.enabled) {
      return true;
    }
    if (!token) {
      return false;
    }
    // timingSafeEqualはバッファ長が異なるとエラーになるため、バイト長で比較
    const received = Buffer.from(token, "utf8");
    const expected = Buffer.from(this.token, "utf8");
    if (received.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(received, expected);
  }

  /**
   * Quick Tunnel（*.trycloudflare.com）経由のリクエストかどうかを判定
   */
  private isQuickTunnelRequest(host: string | undefined): boolean {
    if (!host) return false;
    // ポート番号を除去してホスト名を取得
    const hostname = host.split(":")[0];
    return hostname.endsWith(".trycloudflare.com");
  }

  /**
   * ホスト名がlocalhostかどうかを判定（プライベートヘルパー）
   */
  private isLocalhostHostname(host: string | undefined): boolean {
    if (!host) return false;
    const hostname = host.split(":")[0];
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1"
    );
  }

  /**
   * IPアドレスがローカル（localhost または プライベートIP）かどうかを判定
   * - 127.0.0.1, ::1: ループバック
   * - 192.168.x.x: プライベートIP (クラスC)
   * - 10.x.x.x: プライベートIP (クラスA)
   * - 172.16-31.x.x: プライベートIP (クラスB)
   */
  private isLocalIp(ip: string): boolean {
    // IPv6ループバック
    if (ip === "::1") return true;

    // IPv4-mapped IPv6 (::ffff:127.0.0.1 形式) から IPv4 を抽出
    const ipv4Match = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    const ipv4 = ipv4Match ? ipv4Match[1] : ip;

    // IPv4ループバック
    if (ipv4 === "127.0.0.1") return true;

    // プライベートIP範囲のチェック
    const parts = ipv4.split(".").map(Number);
    if (parts.length !== 4 || parts.some(isNaN)) return false;

    // 10.0.0.0/8
    if (parts[0] === 10) return true;

    // 172.16.0.0/12 (172.16.x.x - 172.31.x.x)
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;

    // 192.168.0.0/16
    if (parts[0] === 192 && parts[1] === 168) return true;

    return false;
  }

  /**
   * HTTPリクエストがローカルからのアクセスかどうかを判定
   * - X-Forwarded-Host があればプロキシ経由 → 外部アクセス
   * - X-Forwarded-For があれば、クライアントIPを確認
   * - それ以外は直接アクセスとしてhostをチェック
   */
  isLocalRequest(req: Request): boolean {
    // X-Forwarded-Host があればプロキシ経由（Vite等）→ 外部扱い
    const forwardedHost = req.headers["x-forwarded-host"];
    if (forwardedHost) {
      return false;
    }

    // X-Forwarded-For があればクライアントIPを確認
    const forwardedFor = req.headers["x-forwarded-for"];
    if (forwardedFor) {
      // カンマ区切りの最初のIPがオリジナルクライアント
      const clientIp =
        typeof forwardedFor === "string"
          ? forwardedFor.split(",")[0].trim()
          : forwardedFor[0];
      return this.isLocalIp(clientIp);
    }

    // 直接アクセスの場合はホスト名をチェック
    return this.isLocalhostHostname(req.headers.host);
  }

  /**
   * Socket.IOリクエストがローカルからのアクセスかどうかを判定
   */
  isLocalSocketRequest(socket: Socket): boolean {
    const headers = socket.handshake.headers;

    // X-Forwarded-Host があればプロキシ経由 → 外部扱い
    const forwardedHost = headers["x-forwarded-host"];
    if (forwardedHost) {
      return false;
    }

    // X-Forwarded-For があればクライアントIPを確認
    const forwardedFor = headers["x-forwarded-for"];
    if (forwardedFor) {
      const clientIp =
        typeof forwardedFor === "string"
          ? forwardedFor.split(",")[0].trim()
          : forwardedFor[0];
      return this.isLocalIp(clientIp);
    }

    // 直接アクセスの場合はホスト名をチェック
    return this.isLocalhostHostname(headers.host);
  }

  /**
   * パスが静的アセットかどうかを判定
   */
  private isStaticAsset(path: string): boolean {
    return (
      path.startsWith("/assets/") ||
      path.endsWith(".js") ||
      path.endsWith(".css") ||
      path.endsWith(".woff") ||
      path.endsWith(".woff2") ||
      path.endsWith(".ttf") ||
      path.endsWith(".ico") ||
      path.endsWith(".svg") ||
      path.endsWith(".png") ||
      path.endsWith(".jpg")
    );
  }

  /**
   * HTTP認証用のExpressミドルウェア
   * Quick Tunnel（*.trycloudflare.com）経由のアクセスのみ認証を要求
   */
  httpMiddleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!this.enabled) {
        return next();
      }

      // Quick Tunnel経由のアクセスのみ認証を要求
      // X-Forwarded-Host があればプロキシ経由なのでそちらを優先
      const host =
        (req.headers["x-forwarded-host"] as string) || req.headers.host;
      if (!this.isQuickTunnelRequest(host)) {
        return next(); // Quick Tunnel以外は認証スキップ
      }

      // 静的アセットは認証スキップ
      if (this.isStaticAsset(req.path)) {
        return next();
      }

      // クエリパラメータまたはヘッダーからトークンを取得
      const token =
        (req.query.token as string) || req.headers["x-auth-token"];

      if (this.validateToken(token as string)) {
        return next();
      }

      res.status(401).json({ error: "Unauthorized" });
    };
  }

  /**
   * WebSocket認証用のSocket.IOミドルウェア
   * Quick Tunnel（*.trycloudflare.com）経由のアクセスのみ認証を要求
   */
  socketMiddleware() {
    return (socket: Socket, next: (err?: Error) => void) => {
      if (!this.enabled) {
        return next();
      }

      // Quick Tunnel経由のアクセスのみ認証を要求
      const headers = socket.handshake.headers;
      const host = (headers["x-forwarded-host"] as string) || headers.host;
      if (!this.isQuickTunnelRequest(host)) {
        return next(); // Quick Tunnel以外は認証スキップ
      }

      // handshakeのauthまたはqueryからトークンを取得
      const token =
        socket.handshake.auth?.token || socket.handshake.query?.token;

      if (this.validateToken(token as string)) {
        return next();
      }

      next(new Error("Authentication failed"));
    };
  }

  /**
   * 認証付きURLを構築
   */
  buildAuthUrl(baseUrl: string): string {
    if (!this.enabled) {
      return baseUrl;
    }
    const url = new URL(baseUrl);
    url.searchParams.set("token", this.token);
    return url.toString();
  }
}

// Singleton instance
export const authManager = new AuthManager(false);
