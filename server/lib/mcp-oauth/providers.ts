/**
 * Ark が公式サポートする MCP プロバイダのホワイトリスト。
 *
 * 接続時の流れ (OAuth 2.1 + RFC 7591 DCR の正規フロー):
 * 1. UI から provider を選んで「接続」を押す
 * 2. サーバが MCP URL に対して discovery を実行
 *    (PRM → Authorization Server Metadata)
 * 3. Authorization Server の registration_endpoint に DCR で動的登録
 *    → client_id を自動取得
 * 4. OAuth フロー開始
 *
 * ユーザは事前に provider 側でアプリ登録する必要なし。clientId 入力も不要。
 *
 * 新しい provider を足す場合:
 * - id は英小文字 + 数字 + ハイフンのみ (mcp ツール名のプレフィックスに使う)
 * - DCR をサポートする MCP server のみホワイトリスト対象
 *   (DCR 非対応 provider は技術的に "ユーザの手入力なし" を達成できないので対象外)
 */

export interface McpProviderEntry {
  /** プロバイダ ID。`mcp__<id>__<tool>` の <id> 部分 */
  id: string;
  /** UI 表示名 */
  name: string;
  /** UI に出す短い説明 */
  description: string;
  /** MCP server の HTTP エンドポイント。discovery の起点 */
  url: string;
  /**
   * authorization request の prompt パラメータ。
   * 既定は consent (provider が refresh_token を確実に返すよう促す)。
   */
  prompt?: string;
  /**
   * 取得した access token から「どのアカウント / ワークスペース で認証したか」を解決する。
   * - label: UI 表示用の短い識別子 (auto-generated を上書き)
   * - hint: Beacon system prompt に注入する詳細情報
   *   モデルが URL からこの connection を選ぶ判断材料にする (cloudId / URL / 組織名等)
   *
   * 取得失敗・未対応なら null。
   */
  resolveAccountLabel?: (
    accessToken: string
  ) => Promise<{ label: string; hint: string } | null>;
}

interface AtlassianResource {
  id?: string;
  name?: string;
  url?: string;
}

/**
 * Atlassian のアカウント識別:
 * `https://api.atlassian.com/oauth/token/accessible-resources` で承認済み site 一覧取得。
 * - label: site 名 (複数なら ", " 結合)
 * - hint: 各 site の cloudId と URL を Beacon に渡す。モデルが URL host から
 *   どの connection を使うか判定 + Atlassian MCP tool の cloudId 引数に流用できる。
 */
async function atlassianResolveAccountLabel(
  accessToken: string
): Promise<{ label: string; hint: string } | null> {
  try {
    const res = await fetch(
      "https://api.atlassian.com/oauth/token/accessible-resources",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      }
    );
    if (!res.ok) return null;
    const sites = (await res.json()) as AtlassianResource[];
    if (!Array.isArray(sites) || sites.length === 0) return null;
    const valid = sites.filter(s => s.name && s.url);
    if (valid.length === 0) return null;
    const label = valid
      .map(s => s.name?.trim())
      .filter((n): n is string => !!n)
      .join(", ");
    // モデル向け詳細: 各 site の URL host (URL マッチ用) + cloudId (MCP tool 引数用)
    const hint = `Atlassian sites accessible by this connection:\n${valid
      .map(s => {
        const host = s.url ? new URL(s.url).host : "?";
        return `  - host=${host} cloudId=${s.id ?? "?"} name=${s.name ?? "?"}`;
      })
      .join("\n")}`;
    return { label, hint };
  } catch {
    return null;
  }
}

export const MCP_PROVIDERS: Record<string, McpProviderEntry> = {
  atlassian: {
    id: "atlassian",
    name: "Atlassian",
    description: "Jira / Confluence (Cloud)",
    url: "https://mcp.atlassian.com/v1/sse",
    prompt: "consent",
    resolveAccountLabel: atlassianResolveAccountLabel,
  },
};

export function getProvider(id: string): McpProviderEntry | undefined {
  return MCP_PROVIDERS[id];
}

export function listProviders(): McpProviderEntry[] {
  return Object.values(MCP_PROVIDERS);
}
