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
    const code = parsed.searchParams.get("code");
    const state = parsed.searchParams.get("state");

    // state で flow を先に引き当てる: error 付き callback の場合でもフローを
    // 「失敗」としてクリアしないと UI が「認証中」のまま 30 分残ってしまう。
    const connectionIdForState = state ? this.stateIndex.get(state) : undefined;

    if (error) {
      const message = `OAuth callback error: ${error}${errorDescription ? ` (${errorDescription})` : ""}`;
      if (connectionIdForState) {
        const entry = this.flows.get(connectionIdForState);
        if (entry) this.markFailed(connectionIdForState, entry.runId, message);
      }
      throw new Error(message);
    }
    if (!code || !state) {
      throw new Error("貼り付けた URL に code または state が含まれていません");
    }

    const connectionId = connectionIdForState;
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

      // 再認証時はユーザがリネームした label を保持する (provider 解決値で上書きしない)。
      // 新規作成時のみ resolvedLabel を初期 label として採用する。
      const existingConfig = db.getMcpServer(connectionId);
      if (existingConfig) {
        db.updateMcpServer(connectionId, {
          // label は既存値を維持 (rename UI で設定したラベルが消えないように)
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

  /**
   * Beacon 接続前に呼ばれる token refresh。
   *
   * トークン保持戦略 (= 不要に削除しない):
   * - 完全に expired (margin なし) かつ refresh_token が無い場合のみ削除する
   *   (どうやっても使えないので)
   * - margin 以内だがまだ valid な場合: refresh_token があれば refresh を試行、
   *   無ければ既存 token をそのまま使い続ける (実 expiry までは有効)
   * - refresh が transient error (network / 5xx) で失敗した場合: 既存 token を残す
   *   (次回呼び出しで再試行する; 永続切断にしないため)
   */
  async refreshIfNeeded(server: {
    id: string;
    tokenEndpoint: string;
    clientId: string;
  }): Promise<boolean> {
    const token = db.getMcpToken(server.id);
    if (!token) return false;
    const now = Date.now();

    // 実 expiry を過ぎている (= access token は確実に使えない)
    const fullyExpired = token.expiresAt !== null && token.expiresAt <= now;
    if (fullyExpired && !token.refreshToken) {
      // 復旧不可能なので削除して UI に再認証を促す
      db.deleteMcpToken(server.id);
      this.emit("token-invalidated", { connectionId: server.id });
      return false;
    }

    const margin = 60 * 1000;
    const needsRefresh =
      token.expiresAt !== null && token.expiresAt - margin <= now;
    if (!needsRefresh) return true;
    // refresh_token が無い場合: 削除はせず既存 access token をそのまま使い続ける
    // (実 expiry まではまだ有効。Beacon の MCP 呼び出しが 401 になったら次回ループで
    // fullyExpired 判定で削除される)
    if (!token.refreshToken) return true;

    try {
      const result = await refreshAccessToken({
        tokenEndpoint: server.tokenEndpoint,
        clientId: server.clientId,
        refreshToken: token.refreshToken,
      });
      db.upsertMcpToken({
        serverId: server.id,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken ?? token.refreshToken,
        tokenType: result.tokenType,
        scopes: result.scope?.split(/\s+/).filter(Boolean) ?? token.scopes,
        acquiredAt: now,
        // refresh response が expires_in を省略した場合は旧 expiresAt を維持する
        // (null にすると以降 needsRefresh が常に false になり、新 access token が
        //  実際に expire しても永遠に再利用されてしまう)
        expiresAt:
          result.expiresIn !== undefined
            ? now + result.expiresIn * 1000
            : token.expiresAt,
      });
      return true;
    } catch (err) {
      const msg = getErrorMessage(err);
      console.warn(`[mcp-oauth] refresh failed for ${server.id}: ${msg}`);
      // permanent な失敗 (revoked / invalid_grant / 400 や 401) は token を削除して
      // UI で再認証を促す。これをやらないと毎 turn 同じ refresh を試みてレイテンシが
      // 積み上がる。判定はエラー文言の heuristic で行う:
      // - oauth-client が `token endpoint failed (400): {"error":"invalid_grant"...}` の
      //   形式で throw する
      // - 400 / 401 / `invalid_grant` / `invalid_request` を permanent と扱う
      const isPermanent =
        /invalid_grant|invalid_request|invalid_client/i.test(msg) ||
        /\b40[01]\b/.test(msg);
      if (isPermanent) {
        db.deleteMcpToken(server.id);
        this.emit("token-invalidated", { connectionId: server.id });
        return false;
      }
      // transient (network / 5xx / レート制限等) は token 保持して次回 retry。
      // ただし access token が実 expiry を過ぎていれば今 turn は skip。
      if (token.expiresAt !== null && token.expiresAt <= now) {
        return false;
      }
      return true;
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
    // terminal 状態は in-memory に保持しない (UI の status は DB token から派生する)。
    // 残すと長期稼働で flows Map が膨らむ。
    this.flows.delete(connectionId);
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
    this.flows.delete(connectionId);
  }
}

export const mcpOAuthOrchestrator = new McpOAuthFlowOrchestrator();
