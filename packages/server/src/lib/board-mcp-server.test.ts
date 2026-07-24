/**
 * BoardMcpServer の純ロジック部（BoardSessionRegistry / handleBoardOpen）のユニットテスト。
 * HTTP transport 配線は ark-mcp-server.ts と同構造のため、ここでは純ロジックのみ検証する。
 * 旧 board_write（Excalidraw scene への直接書き込み）のテストは撤去済み（B-1）。
 */

import { DIAGRAM_DIR } from "@ark/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import {
  BoardSessionRegistry,
  createBoardMcpServer,
  handleBoardOpen,
} from "./board-mcp-server.js";

describe("BoardSessionRegistry", () => {
  it("register/resolve/unregister が機能する", () => {
    const r = new BoardSessionRegistry();
    r.register("tok1", "/wt/a");
    expect(r.resolve("tok1")).toBe("/wt/a");
    r.unregister("tok1");
    expect(r.resolve("tok1")).toBeNull();
    expect(r.resolve("unknown")).toBeNull();
  });
});

describe("handleBoardOpen", () => {
  it("deps.openDiagram に worktreePath と相対パスを渡す", async () => {
    const openDiagram = vi.fn(async () => ({ ok: true }));
    const deps = { openDiagram } as never;

    const res = await handleBoardOpen(deps, "/wt", {
      path: ".claude/diagrams/a.diagram.html",
    });

    expect(openDiagram).toHaveBeenCalledWith(
      "/wt",
      ".claude/diagrams/a.diagram.html"
    );
    expect(res.ok).toBe(true);
  });

  it("deps がエラーを返したらそのまま伝える", async () => {
    const deps = {
      openDiagram: vi.fn(async () => ({ ok: false, error: "見つかりません" })),
    } as never;

    const res = await handleBoardOpen(deps, "/wt", { path: "a.diagram.html" });

    expect(res.ok).toBe(false);
    expect(res.error).toBe("見つかりません");
  });
});

describe("createBoardMcpServer", () => {
  it("board_open metadata を shared の正準 directory から生成する", () => {
    const registerTool = vi.spyOn(McpServer.prototype, "registerTool");
    const deps = {
      openDiagram: vi.fn(async () => ({ ok: true })),
    };

    createBoardMcpServer(deps, "/wt");

    expect(registerTool).toHaveBeenCalledOnce();
    const [, config] = registerTool.mock.calls[0] ?? [];
    const metadata = config as
      | {
          description?: string;
          inputSchema?: { path?: { description?: string } };
        }
      | undefined;
    expect(metadata?.description).toContain(DIAGRAM_DIR);
    expect(metadata?.description).not.toContain("docs/diagrams");
    expect(metadata?.inputSchema?.path?.description).toContain(DIAGRAM_DIR);
    expect(metadata?.inputSchema?.path?.description).not.toContain(
      "docs/diagrams"
    );
  });
});
