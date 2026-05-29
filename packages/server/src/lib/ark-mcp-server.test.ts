/**
 * ArkMcpServer (HTTP MCP) のユニットテスト。
 *
 * 実 MCP クライアント (claude CLI が行うのと同じ initialize → tools/list の
 * ハンドシェイク) で接続し、18 ツールが公開されることと、bearer token 認証が
 * 効いていることを検証する。クレジットを消費せず transport 配線を確認できる。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArkMcpServer } from "./ark-mcp-server.js";
import type { BeaconDeps } from "./beacon-manager.js";

const fakeDeps: BeaconDeps = {
  getAllSessions: () => [],
  startSession: async () => ({}),
  stopSession: () => null,
  sendMessage: () => {},
  sendKey: () => {},
  capturePane: () => null,
  getPrUrl: async () => null,
  listWorktrees: async () => [],
  listAllWorktrees: async () => [],
  createWorktree: async () => ({}),
  deleteWorktree: async () => {},
  getRepos: () => ["/repo/a", "/repo/b"],
  listProfiles: () => [],
  linkWorktreeProfile: () => true,
};

const EXPECTED_TOOLS = [
  "list_repositories",
  "list_worktrees",
  "list_sessions",
  "start_session",
  "stop_session",
  "send_to_session",
  "send_key_to_session",
  "get_session_output",
  "validate_issue_url",
  "list_profiles",
  "create_worktree",
  "delete_worktree",
  "get_pr_url",
  "get_system_status",
  "list_processes",
  "get_pm2_status",
  "restart_service",
  "gh_exec",
];

let server: ArkMcpServer;
let endpoint: { url: string; token: string };

beforeEach(async () => {
  server = new ArkMcpServer();
  endpoint = await server.start(fakeDeps);
});

afterEach(() => {
  server.stop();
});

describe("ArkMcpServer", () => {
  it("正しい token で MCP クライアントが接続でき、18 ツールを公開する", async () => {
    const client = new Client({ name: "test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: {
        headers: { Authorization: `Bearer ${endpoint.token}` },
      },
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
    await client.close();
  });

  it("list_repositories ツールを呼ぶと deps.getRepos() の結果を返す", async () => {
    const client = new Client({ name: "test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: {
        headers: { Authorization: `Bearer ${endpoint.token}` },
      },
    });
    await client.connect(transport);
    const res = (await client.callTool({
      name: "list_repositories",
      arguments: {},
    })) as { content: Array<{ type: string; text: string }> };
    expect(res.content[0].text).toContain("/repo/a");
    expect(res.content[0].text).toContain("/repo/b");
    await client.close();
  });

  it("token なし / 誤った token では 401 で接続できない", async () => {
    const client = new Client({ name: "test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: {
        headers: { Authorization: "Bearer wrong-token" },
      },
    });
    await expect(client.connect(transport)).rejects.toThrow();
  });
});
