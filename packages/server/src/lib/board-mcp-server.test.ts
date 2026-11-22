/**
 * BoardMcpServer の純ロジック部（BoardSessionRegistry / handleBoardOpen / TODO）のユニットテスト。
 * HTTP transport 配線は ark-mcp-server.ts と同構造のため、ここでは純ロジックのみ検証する。
 */

import { DIAGRAM_DIR, NEXT_ACTIONS_LIMITS, type Todo } from "@ark/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import {
  BoardSessionRegistry,
  createBoardMcpServer,
  handleBoardOpen,
  handleTaskList,
  handleTaskStart,
  handleTodoAdd,
  handleTodoList,
  type TaskListItem,
  taskStateOf,
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
  it("board_open / todo_add / todo_list / task_start / task_list / next_actions の 6 ツールを登録する", () => {
    const registerTool = vi.spyOn(McpServer.prototype, "registerTool");

    createBoardMcpServer(
      {
        openDiagram: vi.fn(async () => ({ ok: true })),
        addTodo: vi.fn(),
        listTodos: vi.fn(async () => []),
        startTask: vi.fn(),
        listTasks: vi.fn(async () => []),
      },
      "/wt"
    );

    expect(registerTool.mock.calls.map(call => call[0])).toEqual([
      "board_open",
      "todo_add",
      "todo_list",
      "task_start",
      "task_list",
      "next_actions",
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

describe("next_actions", () => {
  const actionsSchema = () => {
    const registerTool = vi.spyOn(McpServer.prototype, "registerTool");
    createBoardMcpServer(
      {
        openDiagram: vi.fn(async () => ({ ok: true })),
        addTodo: vi.fn(),
        listTodos: vi.fn(async () => []),
        startTask: vi.fn(),
        listTasks: vi.fn(async () => []),
      },
      "/wt"
    );
    const call = registerTool.mock.calls.find(c => c[0] === "next_actions");
    const config = call?.[1] as { inputSchema: { actions: z.ZodTypeAny } };
    return config.inputSchema.actions;
  };
  const action = (over: Record<string, unknown> = {}) => ({
    label: "PRを作る",
    prompt: "コミットしてPRを作って。",
    ...over,
  });

  it("1〜3個の選択肢を受け取る", () => {
    const schema = actionsSchema();
    expect(schema.safeParse([action()]).success).toBe(true);
    expect(schema.safeParse([action(), action(), action()]).success).toBe(true);
    expect(schema.safeParse([]).success).toBe(false);
    expect(
      schema.safeParse([action(), action(), action(), action()]).success
    ).toBe(false);
  });

  it("空の文と、上限を超える長さを拒む", () => {
    const schema = actionsSchema();
    expect(schema.safeParse([action({ label: "  " })]).success).toBe(false);
    expect(schema.safeParse([action({ prompt: "" })]).success).toBe(false);
    expect(
      schema.safeParse([
        action({ label: "あ".repeat(NEXT_ACTIONS_LIMITS.label + 1) }),
      ]).success
    ).toBe(false);
    expect(
      schema.safeParse([
        action({ prompt: "あ".repeat(NEXT_ACTIONS_LIMITS.prompt + 1) }),
      ]).success
    ).toBe(false);
    expect(
      schema.safeParse([
        action({ reason: "あ".repeat(NEXT_ACTIONS_LIMITS.reason + 1) }),
      ]).success
    ).toBe(false);
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
    repoPath: null,
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

  it("repo を渡すとそのまま addTodo に渡し、一覧では解決済みのパスを返す", async () => {
    const addTodo = vi.fn(async (_w: string, input: { text: string }) =>
      todo(input.text)
    );
    await handleTodoAdd({ addTodo }, "/w", { text: "見積もり", repo: "app" });
    expect(addTodo).toHaveBeenCalledWith("/w", {
      text: "見積もり",
      repo: "app",
    });
    const listTodos = vi.fn(async () => [
      { ...todo("見積もり"), repoPath: "/dev/acme/app" },
    ]);
    expect(await handleTodoList({ listTodos }, "/w")).toEqual({
      todos: [
        {
          id: "id-見積もり",
          text: "見積もり",
          note: null,
          repo: "/dev/acme/app",
        },
      ],
    });
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
      todos: [{ id: "id-a", text: "a", note: null, repo: null }],
    });
  });
});

describe("handleTaskStart", () => {
  it("呼び出し元の worktree と引数をそのまま渡し、結果を返す", async () => {
    const result = {
      worktreePath: "/r/app-fix",
      branch: "fix",
      promptSent: true,
      message: "最初の文を送りました",
    };
    const startTask = vi.fn(async () => result);
    expect(
      await handleTaskStart({ startTask }, "/r/app", {
        name: "fix",
        prompt: "直して",
      })
    ).toEqual(result);
    expect(startTask).toHaveBeenCalledWith("/r/app", {
      name: "fix",
      prompt: "直して",
    });
  });

  it("失敗は error にして返す (throw しない)", async () => {
    const startTask = vi.fn(async () => {
      throw new Error("ブランチ 'fix' は既に別の worktree で使用中です");
    });
    expect(
      await handleTaskStart({ startTask }, "/r/app", {
        name: "fix",
        prompt: "直して",
      })
    ).toEqual({ error: "ブランチ 'fix' は既に別の worktree で使用中です" });
  });
});

describe("task_list", () => {
  const item: TaskListItem = {
    name: "app-fix",
    repoPath: "/r/app",
    worktreePath: "/r/app-fix",
    branch: "fix",
    state: "your_turn",
    bridgeStatus: "IDLE",
    pr: null,
  };

  it("呼び出し元の worktree の子を返す", async () => {
    const listTasks = vi.fn(async () => [item]);
    expect(await handleTaskList({ listTasks }, "/home")).toEqual({
      tasks: [item],
    });
    expect(listTasks).toHaveBeenCalledWith("/home");
  });

  it("失敗は error にして返す (throw しない)", async () => {
    const listTasks = vi.fn(async () => {
      throw new Error("読めません");
    });
    expect(await handleTaskList({ listTasks }, "/home")).toEqual({
      error: "読めません",
    });
  });

  it("Bridge の状態を一覧のセクションと同じ 3 区分に寄せる", () => {
    expect(taskStateOf("TOOL")).toBe("working");
    expect(taskStateOf("THINK")).toBe("working");
    expect(taskStateOf("AWAITING")).toBe("your_turn");
    expect(taskStateOf("IDLE")).toBe("your_turn");
    expect(taskStateOf("ERR")).toBe("your_turn");
    expect(taskStateOf("READY")).toBe("resting");
    expect(taskStateOf("STOP")).toBe("resting");
    expect(taskStateOf(null)).toBe("unknown");
  });
});
