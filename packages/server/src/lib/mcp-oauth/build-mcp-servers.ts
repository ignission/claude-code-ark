/**
 * Beacon の claude CLI に渡す `--mcp-config` 用の外部 MCP server 定義を構築する。
 *
 * 認証済みの全 connection を `{ type: 'http'|'sse', url, headers: { Authorization:
 * Bearer ... } }` で返す。同じ provider に複数 connection があれば全部別 MCP server
 * として登録される (マルチアカウント対応)。MCP server name = connection.id。
 */

import { db } from "../database.js";
import { mcpOAuthOrchestrator } from "./oauth-flow-orchestrator.js";
import { getProvider } from "./providers.js";

/**
 * claude CLI の `--mcp-config` に渡す remote MCP server の設定。
 * Claude Code の `.mcp.json` 形式 (`{ type, url, headers }`) と一致しており、
 * そのまま mcp-config JSON に埋め込める。
 * (旧 Agent SDK の `McpServerConfig` の http/sse 部分と同一スキーマ)
 */
export interface McpServerHttpConfig {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

export interface ExternalMcpEntry {
  /** connection ID (SDK の mcpServers Record キー、tool prefix の <id> 部分) */
  connectionId: string;
  /** UI ラベル (Beacon system prompt に注入してモデルが認識できるようにする) */
  label: string;
  /** どの provider 種別か (システムプロンプトでのグルーピング用) */
  providerId: string;
  /**
   * provider 固有のアカウント詳細 (例: Atlassian なら site の cloudId / URL)。
   * モデルが URL host から正しい connection を選ぶ判断材料 + tool 引数 (cloudId 等) に流用。
   */
  accountHint?: string;
  config: McpServerHttpConfig;
}

/**
 * OAuth token_type を HTTP Authorization の canonical な auth-scheme へ正規化する。
 * "bearer" / "BEARER" 等は "Bearer" に揃える (case-sensitive な server 対策)。
 * 既知でない scheme は先頭大文字化のみ行う。
 */
export function normalizeAuthScheme(tokenType: string): string {
  const t = tokenType.trim();
  if (t.toLowerCase() === "bearer") return "Bearer";
  if (t.length === 0) return "Bearer";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * 認証済みの全 connection を SDK config に変換して返す。
 * - token が無い connection はスキップ
 * - expiry が近いものは refresh を試行
 * - refresh 不可能ならスキップ (UI 側で再認証を促す)
 */
export async function buildAuthenticatedExternalMcps(): Promise<
  ExternalMcpEntry[]
> {
  const servers = db.listMcpServers();
  const entries: ExternalMcpEntry[] = [];

  for (const server of servers) {
    // provider whitelist 判定を先に行う (refresh より前)。
    // ホワイトリストから外れた provider に refresh token を外部送信しないため。
    const provider = getProvider(server.providerId);
    if (!provider) continue;
    const ok = await mcpOAuthOrchestrator.refreshIfNeeded(server);
    if (!ok) continue;
    const token = db.getMcpToken(server.id);
    if (!token) continue;

    // OAuth の token_type は小文字 "bearer" で返ることが多い (Atlassian 等)。
    // HTTP Authorization の auth-scheme は RFC 7235 上は大小無視だが、
    // mcp.atlassian.com (Cloudflare/AtlassianEdge) は case-sensitive で小文字
    // "bearer" を 401 拒否する。canonical な "Bearer" に正規化しないと MCP 接続が
    // 失敗し、claude にツールが現れない。
    const authScheme = normalizeAuthScheme(token.tokenType);
    const headers = {
      Authorization: `${authScheme} ${token.accessToken}`,
    };
    const config: McpServerHttpConfig =
      provider.transport === "sse"
        ? { type: "sse", url: server.url, headers }
        : { type: "http", url: server.url, headers };

    entries.push({
      connectionId: server.id,
      label: server.label,
      providerId: server.providerId,
      ...(server.accountHint ? { accountHint: server.accountHint } : {}),
      config,
    });
  }

  return entries;
}
