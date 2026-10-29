/**
 * BoardMcpServer の純ロジック部（BoardSessionRegistry / handleBoardOpen / TODO）のユニットテスト。
 * HTTP transport 配線は ark-mcp-server.ts と同構造のため、ここでは純ロジックのみ検証する。
 */

import { DIAGRAM_DIR, type Todo } from "@ark/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BoardSessionRegistry,
  createBoardMcpServer,
  handleBoardOpen,
  handleTodoAdd,
  handleTodoList,
} from "./board-mcp-server.js";

afterEach(() => {
  vi.restoreAllMocks();
});

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
  it("board_open / todo_add / todo_list の 3 ツールを登録する", () => {
    const registerTool = vi.spyOn(McpServer.prototype, "registerTool");

    createBoardMcpServer(
      {
        openDiagram: vi.fn(async () => ({ ok: true })),
        addTodo: vi.fn(),
        listTodos: vi.fn(async () => []),
      },
      "/wt"
    );

    expect(registerTool.mock.calls.map(call => call[0])).toEqual([
      "board_open",
      "todo_add",
      "todo_list",
    ]);
    const [, config] = registerTool.mock.calls[0] ?? [];
    const metadata = config as
      | {
          description?: string;
          inputSchema?: { path?: { description?: string } };
        }
      | undefined;
    expect(metadata?.description).toContain(DIAGRAM_DIR);
    expect(metadata?.inputSchema?.path?.description).toContain(DIAGRAM_DIR);
  });
});

describe("handleTodoAdd / handleTodoList", () => {
  const todo = (text: string): Todo => ({
    id: `id-${text}`,
    worktreePath: "/w",
    text,
    note: null,
    createdAt: 0,
    doneAt: null,
    startedWorktreePath: null,
    startedAt: null,
    branchName: null,
  });

  it("ブランチ名の候補をそのまま addTodo へ渡す", async () => {
    const addTodo = vi.fn(async (_w: string, input: { text: string }) =>
      todo(input.text)
    );
    await handleTodoAdd({ addTodo }, "/w", {
      text: "ログの形式",
      branch: "fix-log-format",
    });
    expect(addTodo).toHaveBeenCalledWith("/w", {
      text: "ログの形式",
      branch: "fix-log-format",
    });
  });

  it("足した TODO の id と本文を返す", async () => {
    const addTodo = vi.fn(async (_w: string, input: { text: string }) =>
      todo(input.text)
    );
    expect(
      await handleTodoAdd({ addTodo }, "/w", { text: "ログの形式" })
    ).toEqual({ added: { id: "id-ログの形式", text: "ログの形式" } });
    expect(addTodo).toHaveBeenCalledWith("/w", { text: "ログの形式" });
  });

  it("足せなければ error を返す", async () => {
    const addTodo = vi.fn(async () => {
      throw new Error("TODO の本文が空です");
    });
    expect(await handleTodoAdd({ addTodo }, "/w", { text: " " })).toEqual({
      error: "TODO の本文が空です",
    });
  });

  it("未完了の一覧を id・本文・メモだけにして返す", async () => {
    const listTodos = vi.fn(async () => [todo("a")]);
    expect(await handleTodoList({ listTodos }, "/w")).toEqual({
      todos: [{ id: "id-a", text: "a", note: null }],
    });
  });
});
