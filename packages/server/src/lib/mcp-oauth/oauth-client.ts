/**
 * MCP server に対する OAuth 2.1 (Authorization Code + PKCE) クライアント。
 * Tally の oauth-client.ts (ADR-0011 PR-E2) からの移植。
 *
 * 設計判断:
 * - PKCE は S256 のみ
 * - state は呼び出し側 (orchestrator) が生成・verify する
 * - public client (PKCE) なので client_secret は使わない
 */

import { createHash, randomBytes } from "node:crypto";

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

/** RFC 7636 §4.1: 32 byte random を base64url すると 43 文字（下限）になる */
export function generatePkcePair(): PkcePair {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeVerifier, codeChallenge };
}

/** CSRF 対策の opaque random。16 byte = 128 bit entropy */
export function generateOAuthState(): string {
  return randomBytes(16).toString("base64url");
}

export interface BuildAuthorizationUrlInput {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  codeChallenge: string;
  audience?: string;
  prompt?: string;
}

export function buildAuthorizationUrl(
  input: BuildAuthorizationUrlInput
): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  if (input.scopes.length > 0) {
    url.searchParams.set("scope", input.scopes.join(" "));
  }
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.audience) {
    url.searchParams.set("audience", input.audience);
  }
  if (input.prompt) {
    url.searchParams.set("prompt", input.prompt);
  }
  return url.toString();
}

interface TokenEndpointResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

export interface TokenExchangeResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
  tokenType: string;
}

export interface ExchangeCodeInput {
  tokenEndpoint: string;
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

export async function exchangeCodeForToken(
  input: ExchangeCodeInput
): Promise<TokenExchangeResult> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: input.clientId,
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  return await postTokenEndpoint(input.tokenEndpoint, body);
}

export interface RefreshTokenInput {
  tokenEndpoint: string;
  clientId: string;
  refreshToken: string;
}

export async function refreshAccessToken(
  input: RefreshTokenInput
): Promise<TokenExchangeResult> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: input.clientId,
    refresh_token: input.refreshToken,
  });
  return await postTokenEndpoint(input.tokenEndpoint, body);
}

async function postTokenEndpoint(
  endpoint: string,
  body: URLSearchParams
): Promise<TokenExchangeResult> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    // エラー本文に機密が含まれる可能性は低いが念のため最初の 512 文字に切る
    const text = (await res.text().catch(() => "")).slice(0, 512);
    throw new Error(`token endpoint failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as TokenEndpointResponse;
  if (typeof json.access_token !== "string" || json.access_token === "") {
    throw new Error("token endpoint response missing access_token");
  }
  const result: TokenExchangeResult = {
    accessToken: json.access_token,
    tokenType: json.token_type ?? "Bearer",
  };
  if (json.refresh_token !== undefined)
    result.refreshToken = json.refresh_token;
  if (json.expires_in !== undefined) result.expiresIn = json.expires_in;
  if (json.scope !== undefined) result.scope = json.scope;
  return result;
}
