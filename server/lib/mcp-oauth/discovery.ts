/**
 * MCP OAuth 2.1 server discovery + Dynamic Client Registration。
 *
 * 仕様:
 * - MCP Authorization (2025-03-26 spec)
 * - RFC 9728: OAuth 2.0 Protected Resource Metadata (PRM)
 * - RFC 8414: OAuth 2.0 Authorization Server Metadata (ASM)
 * - RFC 7591: OAuth 2.0 Dynamic Client Registration (DCR)
 *
 * フロー:
 * 1. `<mcp_url>/.well-known/oauth-protected-resource` を fetch → authorization_servers[]
 *    取れなければ MCP URL の origin を auth server とみなす (fallback)
 * 2. `<auth_server>/.well-known/oauth-authorization-server` を fetch → endpoints
 * 3. registration_endpoint に POST → client_id を取得
 *
 * 結果として MCP server 接続に必要なすべて (URL / endpoints / client_id) が
 * ユーザの手入力なしで揃う。OAuth 2.1 + MCP spec の正規フロー。
 */

/** Discovery (PRM + ASM) で得た auth server の情報 */
export interface DiscoveredEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  scopes: string[];
  audience?: string;
}

export class DiscoveryError extends Error {
  constructor(
    message: string,
    public readonly stage:
      | "protected-resource"
      | "authorization-server"
      | "dynamic-registration"
      | "input"
  ) {
    super(message);
    this.name = "DiscoveryError";
  }
}

interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

interface AuthorizationServerMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

interface DcrResponse {
  client_id?: string;
  client_secret?: string;
}

/**
 * MCP server URL から OAuth 2.1 endpoints を発見する (PRM → ASM)。
 * registration_endpoint も含む。実際の DCR は別途 `registerDynamicClient` を呼ぶ。
 *
 * 設計判断: DCR と endpoints 発見を分離する理由は、loopback callback server を
 * 起動してから redirect_uri を確定し、その exact URI で DCR したいから
 * (Atlassian など strict redirect_uri match の auth server に対応するため)。
 */
export async function discoverEndpoints(
  mcpUrl: string
): Promise<DiscoveredEndpoints> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(mcpUrl);
  } catch {
    throw new DiscoveryError(`MCP server URL が不正です: ${mcpUrl}`, "input");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new DiscoveryError(
      `MCP server URL は http(s) を指定してください`,
      "input"
    );
  }

  // 1. PRM 取得 (取れなくても fallback で続行)
  const prm = await fetchProtectedResourceMetadata(parsedUrl);

  // auth server URL 候補: PRM があればそれ、無ければ MCP URL の origin
  const authServerUrls = prm?.authorization_servers?.length
    ? prm.authorization_servers
    : [parsedUrl.origin];

  // 2. ASM 取得 (複数候補を順に試す)
  let asm: AuthorizationServerMetadata | null = null;
  let lastAsmError = "";
  for (const authServer of authServerUrls) {
    try {
      asm = await fetchAuthorizationServerMetadata(authServer);
      break;
    } catch (err) {
      lastAsmError = err instanceof Error ? err.message : String(err);
    }
  }
  if (!asm) {
    throw new DiscoveryError(
      `Authorization Server Metadata を取得できませんでした (${lastAsmError})`,
      "authorization-server"
    );
  }
  if (!asm.authorization_endpoint || !asm.token_endpoint) {
    throw new DiscoveryError(
      `auth server のメタデータに authorization_endpoint / token_endpoint がありません`,
      "authorization-server"
    );
  }
  if (!asm.registration_endpoint) {
    throw new DiscoveryError(
      `この MCP server は Dynamic Client Registration をサポートしていません`,
      "dynamic-registration"
    );
  }
  if (
    asm.code_challenge_methods_supported &&
    !asm.code_challenge_methods_supported.includes("S256")
  ) {
    throw new DiscoveryError(
      `auth server は PKCE S256 をサポートしていません`,
      "authorization-server"
    );
  }

  return {
    authorizationEndpoint: asm.authorization_endpoint,
    tokenEndpoint: asm.token_endpoint,
    registrationEndpoint: asm.registration_endpoint,
    scopes: prm?.scopes_supported ?? asm.scopes_supported ?? [],
    ...(prm?.resource ? { audience: prm.resource } : {}),
  };
}

async function fetchProtectedResourceMetadata(
  mcpUrl: URL
): Promise<ProtectedResourceMetadata | null> {
  // RFC 9728 §3 / RFC 8414 §3 準拠の URL 組み立て:
  // - resource origin の場合 (mcpUrl が "/" or 空 path): `<origin>/.well-known/oauth-protected-resource`
  // - path 付き resource の場合: `<origin>/.well-known/oauth-protected-resource<path>`
  //   (path は suffix として well-known の後に置く。`<path>/.well-known/...` ではない)
  const trimmedPath = mcpUrl.pathname.replace(/\/$/, "");
  const candidates: string[] = [
    `${mcpUrl.origin}/.well-known/oauth-protected-resource`,
  ];
  if (trimmedPath && trimmedPath !== "") {
    candidates.push(
      `${mcpUrl.origin}/.well-known/oauth-protected-resource${trimmedPath}`
    );
  }
  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) continue;
      const json = (await res.json()) as ProtectedResourceMetadata;
      // PRM が JSON object なら採用する。RFC 9728 では `authorization_servers` は
      // 必須ではなく、`resource` / `scopes_supported` だけ載った same-origin PRM も
      // 有効。authorization_servers が無い場合は origin を auth server として fallback
      // するが、resource (audience) と scopes_supported はここで取得しないと OAuth
      // が機能しないので、JSON 構造があればそのまま返す。
      if (json && typeof json === "object") return json;
    } catch {
      // try next
    }
  }
  return null;
}

async function fetchAuthorizationServerMetadata(
  issuer: string
): Promise<AuthorizationServerMetadata> {
  const base = issuer.replace(/\/$/, "");
  const candidates = [
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`,
  ];
  let lastErr = "";
  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        lastErr = `${url} → ${res.status}`;
        continue;
      }
      const json = (await res.json()) as AuthorizationServerMetadata;
      if (json && typeof json === "object") return json;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(lastErr || "no metadata found");
}

/**
 * RFC 7591 DCR。public client (PKCE) として登録。
 *
 * redirect_uris は呼び出し側が指定する。Atlassian など redirect_uri を
 * strict match で照合する provider に対応するため、loopback callback server
 * を起動して exact URI を確定してから DCR を呼ぶ運用にしている。
 */
export async function registerDynamicClient(
  registrationEndpoint: string,
  appName: string,
  redirectUris: string[]
): Promise<string> {
  const body = {
    client_name: appName,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "native",
  };
  const res = await fetch(registrationEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 512);
    throw new DiscoveryError(
      `DCR failed (${res.status}): ${text}`,
      "dynamic-registration"
    );
  }
  const json = (await res.json()) as DcrResponse;
  if (typeof json.client_id !== "string" || !json.client_id) {
    throw new DiscoveryError(
      "DCR response に client_id が含まれません",
      "dynamic-registration"
    );
  }
  return json.client_id;
}
