import type { NextFunction, Request, Response } from "express";
import type { Socket } from "socket.io";
import { describe, expect, it, vi } from "vitest";
import { AuthManager } from "./auth.js";

const TUNNEL_HOST = "random-words.trycloudflare.com";

type Headers = Record<string, string | string[] | undefined>;

function runHttp(
  auth: AuthManager,
  headers: Headers,
  options: { query?: Record<string, string>; path?: string } = {}
) {
  const req = {
    headers,
    query: options.query ?? {},
    path: options.path ?? "/api/settings",
  } as unknown as Request;
  const status = vi.fn().mockReturnValue({ json: vi.fn() });
  const res = { status } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  auth.httpMiddleware()(req, res, next);
  return { passed: vi.mocked(next).mock.calls.length === 1, status };
}

function runSocket(auth: AuthManager, headers: Headers, token?: string) {
  const socket = {
    handshake: { headers, auth: token ? { token } : {}, query: {} },
  } as unknown as Socket;
  const next = vi.fn();
  auth.socketMiddleware()(socket, next);
  return next.mock.calls[0]?.[0] as Error | undefined;
}

describe("AuthManager.requiresToken", () => {
  const auth = new AuthManager(true);

  it("Host が Quick Tunnel のドメインならトークンを求める", () => {
    expect(auth.requiresToken({ host: TUNNEL_HOST })).toBe(true);
    expect(auth.requiresToken({ host: `${TUNNEL_HOST}:443` })).toBe(true);
  });

  it("クライアントが X-Forwarded-Host を付けても Host の判定を上書きできない", () => {
    expect(
      auth.requiresToken({
        host: TUNNEL_HOST,
        "x-forwarded-host": "example.invalid",
      })
    ).toBe(true);
    expect(
      auth.requiresToken({ host: TUNNEL_HOST, "x-forwarded-host": "localhost" })
    ).toBe(true);
  });

  it("プロキシが Host を書き換えていても X-Forwarded-Host が Quick Tunnel なら求める", () => {
    expect(
      auth.requiresToken({
        host: "localhost:4001",
        "x-forwarded-host": TUNNEL_HOST,
      })
    ).toBe(true);
    expect(
      auth.requiresToken({
        host: "localhost:4001",
        "x-forwarded-host": `example.invalid, ${TUNNEL_HOST}`,
      })
    ).toBe(true);
    expect(
      auth.requiresToken({
        host: "localhost:4001",
        "x-forwarded-host": ["example.invalid", TUNNEL_HOST],
      })
    ).toBe(true);
  });

  it("Quick Tunnel を経由しないリクエストには求めない", () => {
    expect(auth.requiresToken({ host: "localhost:4001" })).toBe(false);
    expect(auth.requiresToken({ host: "192.168.1.10:4001" })).toBe(false);
    expect(auth.requiresToken({ host: "ark.example.com" })).toBe(false);
    expect(auth.requiresToken({})).toBe(false);
  });

  it("ドメインの一部が似ているだけのホストは Quick Tunnel と見なさない", () => {
    expect(auth.requiresToken({ host: "trycloudflare.com.example.com" })).toBe(
      false
    );
    expect(auth.requiresToken({ host: "nottrycloudflare.com" })).toBe(false);
  });

  it("認証が無効なら求めない", () => {
    expect(new AuthManager(false).requiresToken({ host: TUNNEL_HOST })).toBe(
      false
    );
  });
});

describe("AuthManager.httpMiddleware", () => {
  it("Quick Tunnel 経由でトークンが無ければ 401 にする", () => {
    const auth = new AuthManager(true);
    const result = runHttp(auth, { host: TUNNEL_HOST });
    expect(result.passed).toBe(false);
    expect(result.status).toHaveBeenCalledWith(401);
  });

  it("X-Forwarded-Host を付けてもトークンなしでは通さない", () => {
    const auth = new AuthManager(true);
    const result = runHttp(auth, {
      host: TUNNEL_HOST,
      "x-forwarded-host": "example.invalid",
    });
    expect(result.passed).toBe(false);
    expect(result.status).toHaveBeenCalledWith(401);
  });

  it("正しいトークンがあれば通す", () => {
    const auth = new AuthManager(true);
    expect(
      runHttp(
        auth,
        { host: TUNNEL_HOST },
        { query: { token: auth.getToken() } }
      ).passed
    ).toBe(true);
    expect(
      runHttp(auth, { host: TUNNEL_HOST, "x-auth-token": auth.getToken() })
        .passed
    ).toBe(true);
  });

  it("manifest以外の .webmanifest はトークンを求める", () => {
    const auth = new AuthManager(true);
    expect(
      runHttp(
        auth,
        { host: TUNNEL_HOST },
        { path: "/proxy/8080/private.webmanifest" }
      ).passed
    ).toBe(false);
  });

  it("ローカルからの直接アクセスはトークンなしで通す", () => {
    const auth = new AuthManager(true);
    expect(runHttp(auth, { host: "localhost:4001" }).passed).toBe(true);
  });

  it("静的アセットはトークンなしで通す", () => {
    const auth = new AuthManager(true);
    expect(
      runHttp(auth, { host: TUNNEL_HOST }, { path: "/assets/index.js" }).passed
    ).toBe(true);
  });

  it("manifestはトークンなしで通す (ブラウザがクエリなしで取りに来る)", () => {
    const auth = new AuthManager(true);
    expect(
      runHttp(auth, { host: TUNNEL_HOST }, { path: "/manifest.webmanifest" })
        .passed
    ).toBe(true);
  });
});

describe("AuthManager.socketMiddleware", () => {
  it("X-Forwarded-Host を付けてもトークンなしでは通さない", () => {
    const auth = new AuthManager(true);
    const error = runSocket(auth, {
      host: TUNNEL_HOST,
      "x-forwarded-host": "example.invalid",
    });
    expect(error).toBeInstanceOf(Error);
  });

  it("正しいトークンがあれば通す", () => {
    const auth = new AuthManager(true);
    expect(
      runSocket(auth, { host: TUNNEL_HOST }, auth.getToken())
    ).toBeUndefined();
  });

  it("ローカルからの直接アクセスはトークンなしで通す", () => {
    const auth = new AuthManager(true);
    expect(runSocket(auth, { host: "localhost:4001" })).toBeUndefined();
  });
});
