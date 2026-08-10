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
  handleBoardComments,
  handleBoardOpen,
} from "./board-mcp-server.js";

const comments = {
  ok: true as const,
  comments: {
    version: 1 as const,
    target: "a.diagram.html",
    threads: [
      {
        id: "thread-open",
        anchorId: "section-1",
        anchorText: "対象 A",
        status: "open" as const,
        createdAt: "2026-08-10T00:00:00.000Z",
        messages: [
          {
            id: "message-open",
            author: "Reviewer",
            at: "2026-08-10T00:00:00.000Z",
            body: "未解決です",
          },
        ],
      },
      {
        id: "thread-resolved",
        anchorId: "section-2",
        anchorText: "対象 B",
        anchorQuote: "引用 B",
        anchorOccurrence: 1,
        status: "resolved" as const,
        createdAt: "2026-08-10T01:00:00.000Z",
        messages: [
          {
            id: "message-resolved",
            author: "Reviewer",
            at: "2026-08-10T01:00:00.000Z",
            body: "解決済みです",
          },
        ],
      },
    ],
  },
};

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

describe("handleBoardComments", () => {
  it("既定では指定した図の open thread だけを返す", async () => {
    const deps = {
      listDiagramPaths: vi.fn(async () => []),
      getDiagramComments: vi.fn(async () => comments),
    };

    const result = await handleBoardComments(deps, "/wt", {
      path: `${DIAGRAM_DIR}/a.diagram.html`,
    });

    expect(deps.getDiagramComments).toHaveBeenCalledWith(
      "/wt",
      `${DIAGRAM_DIR}/a.diagram.html`
    );
    expect(result).toEqual({
      diagrams: [
        {
          path: `${DIAGRAM_DIR}/a.diagram.html`,
          threads: [
            {
              id: "thread-open",
              anchorId: "section-1",
              anchorText: "対象 A",
              status: "open",
              messages: [
                {
                  at: "2026-08-10T00:00:00.000Z",
                  body: "未解決です",
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("includeResolved=true なら解決済み thread も返す", async () => {
    const result = await handleBoardComments(
      {
        listDiagramPaths: vi.fn(async () => []),
        getDiagramComments: vi.fn(async () => comments),
      },
      "/wt",
      { path: `${DIAGRAM_DIR}/a.diagram.html`, includeResolved: true }
    );

    expect(result.diagrams[0]).toMatchObject({
      threads: [
        { id: "thread-open", status: "open" },
        {
          id: "thread-resolved",
          anchorQuote: "引用 B",
          anchorOccurrence: 1,
          status: "resolved",
        },
      ],
    });
  });

  it("path 省略時は DIAGRAM_DIR 配下の複数図を走査する", async () => {
    const paths = [
      `${DIAGRAM_DIR}/a.diagram.html`,
      `${DIAGRAM_DIR}/nested/b.diagram.html`,
    ];
    const deps = {
      listDiagramPaths: vi.fn(async () => paths),
      getDiagramComments: vi.fn(async (_worktree: string, relPath: string) => ({
        ...comments,
        comments: {
          ...comments.comments,
          target: relPath.split("/").at(-1) ?? relPath,
        },
      })),
    };

    const result = await handleBoardComments(deps, "/wt", {});

    expect(deps.listDiagramPaths).toHaveBeenCalledWith("/wt");
    expect(deps.getDiagramComments).toHaveBeenCalledTimes(2);
    expect(result.diagrams.map(diagram => diagram.path)).toEqual(paths);
  });

  it("壊れた sidecar は error として含め、他の図を返し続ける", async () => {
    const broken = `${DIAGRAM_DIR}/broken.diagram.html`;
    const valid = `${DIAGRAM_DIR}/a.diagram.html`;
    const result = await handleBoardComments(
      {
        listDiagramPaths: vi.fn(async () => [broken, valid]),
        getDiagramComments: vi.fn(async (_worktree: string, relPath: string) =>
          relPath === broken
            ? {
                ok: false as const,
                code: "INVALID_SIDECAR" as const,
                error: "JSON が壊れています",
              }
            : comments
        ),
      },
      "/wt",
      {}
    );

    expect(result.diagrams).toEqual([
      { path: broken, error: "JSON が壊れています" },
      expect.objectContaining({ path: valid, threads: expect.any(Array) }),
    ]);
  });
});

describe("createBoardMcpServer", () => {
  it("board_open metadata を shared の正準 directory から生成する", () => {
    const registerTool = vi.spyOn(McpServer.prototype, "registerTool");
    const deps = {
      openDiagram: vi.fn(async () => ({ ok: true })),
      listDiagramPaths: vi.fn(async () => []),
      getDiagramComments: vi.fn(async () => comments),
    };

    createBoardMcpServer(deps, "/wt");

    expect(registerTool).toHaveBeenCalledTimes(2);
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
    expect(registerTool.mock.calls[1]?.[0]).toBe("board_comments");
  });
});
