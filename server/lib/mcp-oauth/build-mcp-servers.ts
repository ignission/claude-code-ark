/**
 * Beacon の query() に渡す mcpServers Record を構築する。
 *
 * ark-beacon (in-process カスタム tool) に加え、認証済みの全 connection を
 * `{ type: 'http', url, headers: { Authorization: Bearer ... } }` で混ぜ込む。
 * 同じ provider に複数 connection があれば全部別 MCP server として登録される
 * (マルチアカウント対応)。SDK MCP server name = connection.id。
 */

import type { McpServerConfig as SdkMcpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { db } from "../database.js";
import { mcpOAuthOrchestrator } from "./oauth-flow-orchestrator.js";
import { getProvider } from "./providers.js";

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
  config: SdkMcpServerConfig;
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
    const ok = await mcpOAuthOrchestrator.refreshIfNeeded(server);
    if (!ok) continue;
    const token = db.getMcpToken(server.id);
    if (!token) continue;
    // provider 定義から transport (sse / http) を引く。
    // 万一 provider が registry から消えていれば skip (ホワイトリスト外なので使わせない)。
    const provider = getProvider(server.providerId);
    if (!provider) continue;

    const headers = {
      Authorization: `${token.tokenType} ${token.accessToken}`,
    };
    const config: SdkMcpServerConfig =
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
