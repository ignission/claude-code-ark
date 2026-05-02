/**
 * MCP OAuth 2.1 フロー全体のオーケストレータ。
 *
 * 設計判断:
 * - redirect_uri は loopback (`http://127.0.0.1:RANDOM_PORT/callback`) を使う。
 *   provider 側の組織 allowlist を回避する (localhost は通常デフォルトで許可)。
 * - ローカル接続のブラウザは loopback サーバが自動で受け取って完了する。
 * - リモート (Cloudflare Tunnel) からアクセスしているブラウザは loopback に到達
 *   できないので、ユーザに redirect 後の URL を Ark UI にペーストして貰う。
 *   `submitPastedRedirect()` がパース → token 交換まで実行する。
 * - state (CSRF 防止用 random) を flow 状態に保持し、loopback / paste どちらの
 *   経路でも同一 state 検証 → 同一の `_processCallback()` で完了する。
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { db } from "../database.js";
import { getErrorMessage } from "../errors.js";
import {
  type DiscoveredEndpoints,
  discoverEndpoints,
  registerDynamicClient,
} from "./discovery.js";
import {
  type LoopbackCallbackHandle,
  startLoopbackCallbackServer,
} from "./loopback-callback-server.js";
import {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  generateOAuthState,
  generatePkcePair,
  refreshAccessToken,
} from "./oauth-client.js";
import type { McpProviderEntry } from "./providers.js";

export type OAuthFlowStatus =
  | { status: "pending"; authorizationUrl: string }
  | { status: "completed"; authorizationUrl: string }
  | { status: "failed"; authorizationUrl: string; failureMessage: string };

interface FlowEntry {
  status: "pending" | "completed" | "failed";
  authorizationUrl: string;
  failureMessage?: string;
  /** flow 入れ替わり判定用 ID */
  runId: string;
  /** CSRF 防止用 state。callback 検索のキー */
  state: string;
  /** connection 一意 ID (サーバ側で生成) */
  connectionId: string;
  /** UI 表示ラベル */
  label: string;
  /** 元の provider 定義 */
  provider: McpProviderEntry;
  endpoints: DiscoveredEndpoints;
  clientId: string;
  /** PKCE code_verifier */
  codeVerifier: string;
  /** authorize で使った redirect_uri (token 交換時の完全一致用) */
  redirectUri: string;
  /** loopback サーバ。完了時 / cancel 時に close する */
  callbackHandle: LoopbackCallbackHandle;
  /** code 処理が二重に走らないようにする */
  processing: boolean;
}

export class McpOAuthFlowOrchestrator extends EventEmitter {
  /** connectionId → flow */
  private readonly flows = new Map<string, FlowEntry>();
  /** state → connectionId の index (paste 時の検索用) */
  private readonly stateIndex = new Map<string, string>();

  /**
   * 新規 connection に対して OAuth フローを開始する。
   *
   * 1. loopback callback server 起動 → redirect_uri (port 含む) 確定
   * 2. provider URL を discovery で endpoints 取得
   * 3. exact redirect_uri で DCR → client_id 発行
   * 4. authorize URL 構築
   * 5. bg で loopback callback を待ち、token 交換 + DB 保存
   *
   * connectionId はサーバが事前に生成して渡す (`<providerId>-<nanoid>`)。
   * 同 provider に複数 connection が並走しても互いに影響しない。
   */
  async startFlowForConnection(
    provider: McpProviderEntry,
    connectionId: string,
    label: string
  ): Promise<{ authorizationUrl: string }> {
    if (this.flows.get(connectionId)?.status === "pending") {
      this.clearFlow(connectionId);
    }

    const runId = randomUUID();
    const pkce = generatePkcePair();
    const state = generateOAuthState();

    // 1. loopback 起動 → redirect_uri 確定
    const callbackHandle = await startLoopbackCallbackServer();

    // 2-3. discovery + DCR
    let endpoints: DiscoveredEndpoints;
    let clientId: string;
    try {
      endpoints = await discoverEndpoints(provider.url);
      clientId = await registerDynamicClient(
        endpoints.registrationEndpoint,
        `Ark Beacon (${label})`,
        [callbackHandle.redirectUri]
      );
    } catch (err) {
      await callbackHandle.close().catch(() => {});
      throw err;
    }

    // 4. authorize URL
    const authorizationUrl = buildAuthorizationUrl({
      authorizationEndpoint: endpoints.authorizationEndpoint,
      clientId,
      redirectUri: callbackHandle.redirectUri,
      scopes: endpoints.scopes,
      state,
      codeChallenge: pkce.codeChallenge,
      ...(endpoints.audience !== undefined
        ? { audience: endpoints.audience }
        : {}),
      ...(provider.prompt !== undefined ? { prompt: provider.prompt } : {}),
    });

    const entry: FlowEntry = {
      status: "pending",
      authorizationUrl,
      runId,
      state,
      connectionId,
      label,
      provider,
      endpoints,
      clientId,
      codeVerifier: pkce.codeVerifier,
      redirectUri: callbackHandle.redirectUri,
      callbackHandle,
      processing: false,
    };
    this.flows.set(connectionId, entry);
    this.stateIndex.set(state, connectionId);

    // 5. bg で loopback callback を待つ
    callbackHandle
      .awaitCallback()
      .then(cb => {
        this._processCallback(connectionId, runId, cb.state, cb.code).catch(
          () => {
            // markFailed まで _processCallback 内で実行済み
          }
        );
      })
      .catch(err => {
        const cur = this.flows.get(connectionId);
        if (cur?.runId === runId && cur.status === "pending") {
          this.markFailed(
            connectionId,
            runId,
            `loopback callback failed: ${getErrorMessage(err)}`
          );
        }
      });

    return { authorizationUrl };
  }

  /**
   * UI からペーストされた redirect URL (フル URL) を処理する。
   * リモート接続時のフォールバック経路。state で flow を検索する。
   */
  async submitPastedRedirect(
    redirectUrl: string
  ): Promise<{ connectionId: string }> {
    let parsed: URL;
    try {
      parsed = new URL(redirectUrl);
    } catch {
      throw new Error("貼り付けられた URL の形式が不正です");
    }
    const error = parsed.searchParams.get("error");
    const errorDescription = parsed.searchParams.get("error_description");
    if (error) {
      throw new Error(
        `OAuth callback error: ${error}${errorDescription ? ` (${errorDescription})` : ""}`
      );
    }
    const code = parsed.searchParams.get("code");
    const state = parsed.searchParams.get("state");
    if (!code || !state) {
      throw new Error("貼り付けた URL に code または state が含まれていません");
    }

    const connectionId = this.stateIndex.get(state);
    if (!connectionId) {
      throw new Error(
        "state に紐づく flow が見つかりません (期限切れ・キャンセル済み・不正)"
      );
    }
    const entry = this.flows.get(connectionId);
    if (!entry) {
      throw new Error("OAuth flow がアクティブではありません");
    }
    return await this._processCallback(connectionId, entry.runId, state, code);
  }

  /**
   * 共通の callback 処理。
   * loopback 経路 / paste 経路どちらからも呼ばれる。多重実行は processing フラグで防ぐ。
   */
  private async _processCallback(
    connectionId: string,
    runId: string,
    state: string,
    code: string
  ): Promise<{ connectionId: string }> {
    const entry = this.flows.get(connectionId);
    if (!entry || entry.runId !== runId || entry.status !== "pending") {
      throw new Error("OAuth flow がアクティブではありません");
    }
    if (entry.state !== state) {
      throw new Error("state が一致しません (CSRF 防止)");
    }
    if (entry.processing) {
      throw new Error("既に処理中です");
    }
    entry.processing = true;

    try {
      const result = await exchangeCodeForToken({
        tokenEndpoint: entry.endpoints.tokenEndpoint,
        clientId: entry.clientId,
        code,
        redirectUri: entry.redirectUri,
        codeVerifier: entry.codeVerifier,
      });

      // race: 別 run に置き換わっていたら何もしない
      const cur = this.flows.get(connectionId);
      if (!cur || cur.runId !== runId) {
        throw new Error(
          `OAuth flow was preempted before token write for "${connectionId}"`
        );
      }

      const now = Date.now();
      const expiresAt =
        result.expiresIn !== undefined ? now + result.expiresIn * 1000 : null;
      const scopesParsed =
        result.scope?.split(/\s+/).filter(Boolean) ?? entry.endpoints.scopes;

      // provider 固有のアカウント識別を解決:
      // - resolvedLabel: UI 表示用 (auto-generated label を上書き)
      // - resolvedHint: モデル向け詳細 (system prompt 注入用、URL→connection 判定材料)
      let resolvedLabel = entry.label;
      let resolvedHint: string | null = null;
      if (entry.provider.resolveAccountLabel) {
        try {
          const fetched = await entry.provider.resolveAccountLabel(
            result.accessToken
          );
          if (fetched) {
            resolvedLabel = fetched.label;
            resolvedHint = fetched.hint;
          }
        } catch (err) {
          console.warn(
            `[mcp-oauth] resolveAccountLabel failed for ${connectionId}: ${getErrorMessage(err)}`
          );
        }
      }

      // McpServerConfig を upsert (再認証時は client_id 更新)
      if (db.getMcpServer(connectionId)) {
        db.updateMcpServer(connectionId, {
          label: resolvedLabel,
          url: entry.provider.url,
          authorizationEndpoint: entry.endpoints.authorizationEndpoint,
          tokenEndpoint: entry.endpoints.tokenEndpoint,
          clientId: entry.clientId,
          scopes: scopesParsed,
          ...(entry.endpoints.audience !== undefined
            ? { audience: entry.endpoints.audience }
            : {}),
          ...(entry.provider.prompt !== undefined
            ? { prompt: entry.provider.prompt }
            : {}),
          // resolvedHint が null なら hint を空文字で上書き (再認証時に古い hint を残さない)
          accountHint: resolvedHint ?? "",
        });
      } else {
        db.createMcpServer({
          id: connectionId,
          providerId: entry.provider.id,
          label: resolvedLabel,
          name: entry.provider.name,
          url: entry.provider.url,
          authorizationEndpoint: entry.endpoints.authorizationEndpoint,
          tokenEndpoint: entry.endpoints.tokenEndpoint,
          clientId: entry.clientId,
          scopes: scopesParsed,
          ...(entry.endpoints.audience !== undefined
            ? { audience: entry.endpoints.audience }
            : {}),
          ...(entry.provider.prompt !== undefined
            ? { prompt: entry.provider.prompt }
            : {}),
          ...(resolvedHint ? { accountHint: resolvedHint } : {}),
        });
      }

      db.upsertMcpToken({
        serverId: connectionId,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken ?? null,
        tokenType: result.tokenType,
        scopes: scopesParsed,
        acquiredAt: now,
        expiresAt,
      });

      this.markCompleted(connectionId, runId);
      return { connectionId };
    } catch (err) {
      const message = getErrorMessage(err);
      console.warn(
        `[mcp-oauth] callback processing failed for ${connectionId}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
      );
      this.markFailed(connectionId, runId, message);
      throw err;
    } finally {
      const cur = this.flows.get(connectionId);
      if (cur) cur.processing = false;
    }
  }

  /**
   * pending な flow の minimal info を返す (UI snapshot 用)。
   * DB 行が無い段階の connection も UI で「認証中」として見せたい。
   * authorizationUrl も同梱: リロード / 再接続後に popup ブロック時の
   * 「認可ページを開く」リンクを復元するため。
   */
  listPendingFlows(): Array<{
    connectionId: string;
    providerId: string;
    label: string;
    authorizationUrl: string;
  }> {
    return [...this.flows.values()]
      .filter(f => f.status === "pending")
      .map(f => ({
        connectionId: f.connectionId,
        providerId: f.provider.id,
        label: f.label,
        authorizationUrl: f.authorizationUrl,
      }));
  }

  getStatus(connectionId: string): OAuthFlowStatus | null {
    const f = this.flows.get(connectionId);
    if (!f) return null;
    if (f.status === "pending")
      return { status: "pending", authorizationUrl: f.authorizationUrl };
    if (f.status === "completed")
      return { status: "completed", authorizationUrl: f.authorizationUrl };
    return {
      status: "failed",
      authorizationUrl: f.authorizationUrl,
      failureMessage: f.failureMessage ?? "unknown",
    };
  }

  /** flow を消す。pending 中の loopback サーバも close */
  clearFlow(connectionId: string): void {
    const f = this.flows.get(connectionId);
    if (!f) return;
    this.stateIndex.delete(f.state);
    f.callbackHandle.close().catch(() => {});
    this.flows.delete(connectionId);
  }

  /** Beacon 接続前に呼ばれる token refresh */
  async refreshIfNeeded(server: {
    id: string;
    tokenEndpoint: string;
    clientId: string;
  }): Promise<boolean> {
    const token = db.getMcpToken(server.id);
    if (!token) return false;

    const margin = 60 * 1000;
    const needsRefresh =
      token.expiresAt !== null && token.expiresAt - margin <= Date.now();
    if (!needsRefresh) return true;
    if (!token.refreshToken) {
      db.deleteMcpToken(server.id);
      // UI に状態反映を促す (manager dialog のバッジが「期限切れ」/「未認証」に切り替わる)
      this.emit("token-invalidated", { connectionId: server.id });
      return false;
    }

    try {
      const result = await refreshAccessToken({
        tokenEndpoint: server.tokenEndpoint,
        clientId: server.clientId,
        refreshToken: token.refreshToken,
      });
      const now = Date.now();
      db.upsertMcpToken({
        serverId: server.id,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken ?? token.refreshToken,
        tokenType: result.tokenType,
        scopes: result.scope?.split(/\s+/).filter(Boolean) ?? token.scopes,
        acquiredAt: now,
        expiresAt:
          result.expiresIn !== undefined ? now + result.expiresIn * 1000 : null,
      });
      return true;
    } catch (err) {
      console.warn(
        `[mcp-oauth] refresh failed for ${server.id}: ${getErrorMessage(err)}`
      );
      db.deleteMcpToken(server.id);
      this.emit("token-invalidated", { connectionId: server.id });
      return false;
    }
  }

  // ============================================================
  // 内部ステータス遷移
  // ============================================================

  private markCompleted(connectionId: string, runId: string): void {
    const cur = this.flows.get(connectionId);
    if (!cur || cur.runId !== runId) return;
    cur.status = "completed";
    this.stateIndex.delete(cur.state);
    cur.callbackHandle.close().catch(() => {});
    this.emit("auth-completed", { connectionId });
  }

  private markFailed(
    connectionId: string,
    runId: string,
    message: string
  ): void {
    const cur = this.flows.get(connectionId);
    if (!cur || cur.runId !== runId) return;
    cur.status = "failed";
    cur.failureMessage = message;
    this.stateIndex.delete(cur.state);
    cur.callbackHandle.close().catch(() => {});
    this.emit("auth-failed", { connectionId, message });
  }
}

export const mcpOAuthOrchestrator = new McpOAuthFlowOrchestrator();
