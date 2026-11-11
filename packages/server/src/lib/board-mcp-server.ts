/**
 * Board MCP Server (HTTP)
 *
 * board_open ツール（生成した図ファイルをセッションのボードペインで開かせる）を
 * 公開する **Streamable HTTP MCP server** を 127.0.0.1 に公開する。
 * 分岐TODOの todo_add / todo_list も同じサーバーで公開する（完了・削除のツールは持たない）。
 * 子タスクを別の worktree に起こす task_start も同じサーバーで公開する（実装は task-start.ts）。
 * 旧 board_write（Excalidraw scene への直接書き込み）は撤去済み（B-1）。
 *
 * ArkMcpServer（司令塔ツール群）との違い:
 * - 1 worktree = 1 board という前提のため、bearer token は
 *   「固定 1 個」ではなく `BoardSessionRegistry` で token → worktreePath を
 *   per-request 解決する（複数セッションが同一 BoardMcpServer インスタンスを共有する）。
 * - 解決できない token は認証ミドルウェアで 401 を返す（ツール内 isError にはしない）。
 *
 * セキュリティ:
 * - 127.0.0.1 のみで listen する（tunnel/リモートからは到達不可）
 * - registry に登録された token のみ許可する
 */

import { createServer, type Server as HttpServer } from "node:http";
import type { Todo } from "@ark/shared";
import { DIAGRAM_DIR } from "@ark/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { getErrorMessage } from "./errors.js";

/** text content だけの CallToolResult を生成するヘルパー */
function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * bearer token → worktreePath の対応表。
 * セッション開始時に register()、停止時に unregister() する想定。
 */
export class BoardSessionRegistry {
  private map = new Map<string, string>();

  register(token: string, worktreePath: string): void {
    this.map.set(token, worktreePath);
  }

  unregister(token: string): void {
    this.map.delete(token);
  }

  resolve(token: string): string | null {
    return this.map.get(token) ?? null;
  }
}

export interface TaskStartToolInput {
  name: string;
  prompt: string;
  baseBranch?: string;
}

export interface TaskStartToolResult {
  worktreePath: string;
  branch: string;
  /** 最初の文を送れたか。送れなかった理由は message にある */
  promptSent: boolean;
  message: string;
}

export interface BoardMcpDeps {
  /**
   * 呼び出し元の worktree を親にして、子タスクの worktree とセッションを起こし、
   * 起動を待って prompt を送る。worktree の作成か起動に失敗したら throw する
   */
  startTask(
    worktreePath: string,
    input: TaskStartToolInput
  ): Promise<TaskStartToolResult>;
  /** 分岐TODOを足す。本文の正規化と空の拒否は DB 側で行う */
  addTodo(
    worktreePath: string,
    input: { text: string; note?: string; branch?: string }
  ): Promise<Todo>;
  /** この worktree の未完了の TODO */
  listTodos(worktreePath: string): Promise<Todo[]>;
  /**
   * 図ファイルをボードペインで開かせる。
   * 実際に readDiagram で読めることを確認してから開かせる（403/404 の
   * 理由をそのまま呼び出し元 = Claude に返す）ため非同期。
   */
  openDiagram(
    worktreePath: string,
    relPath: string
  ): Promise<{ ok: boolean; error?: string }>;
}

export interface BoardOpenInput {
  path: string;
}

export interface BoardOpenResult {
  ok: boolean;
  error?: string;
}

/** board_open の純ロジック（HTTP/MCP から分離してテスト可能にする）。 */
export async function handleBoardOpen(
  deps: Pick<BoardMcpDeps, "openDiagram">,
  worktreePath: string,
  input: BoardOpenInput
): Promise<BoardOpenResult> {
  return deps.openDiagram(worktreePath, input.path);
}

/** todo_add の純ロジック。完了・削除は人間だけが行うので、ツールは足すことしかできない */
export async function handleTodoAdd(
  deps: Pick<BoardMcpDeps, "addTodo">,
  worktreePath: string,
  input: { text: string; note?: string; branch?: string }
): Promise<{ added: { id: string; text: string } } | { error: string }> {
  try {
    const todo = await deps.addTodo(worktreePath, input);
    return { added: { id: todo.id, text: todo.text } };
  } catch (error) {
    return { error: getErrorMessage(error) };
  }
}

/** todo_list の純ロジック。重複を避けるため Claude が自分で呼ぶ（セッションへは配らない） */
export async function handleTodoList(
  deps: Pick<BoardMcpDeps, "listTodos">,
  worktreePath: string
): Promise<{
  todos: Array<{ id: string; text: string; note: string | null }>;
}> {
  const todos = await deps.listTodos(worktreePath);
  return {
    todos: todos.map(t => ({ id: t.id, text: t.text, note: t.note })),
  };
}

/** task_start の純ロジック。子の結果は返さない (親は待たない。見るのは Ark の一覧) */
export async function handleTaskStart(
  deps: Pick<BoardMcpDeps, "startTask">,
  worktreePath: string,
  input: TaskStartToolInput
): Promise<TaskStartToolResult | { error: string }> {
  try {
    return await deps.startTask(worktreePath, input);
  } catch (error) {
    return { error: getErrorMessage(error) };
  }
}

/**
 * board_open ツールを登録した McpServer を構築する。
 * stateless transport では request 毎に新しい server を作るため、
 * deps + worktreePath（認証で解決済み）を引数に取るファクトリ関数にしている。
 */
export function createBoardMcpServer(
  deps: BoardMcpDeps,
  worktreePath: string
): McpServer {
  const server = new McpServer({ name: "ark-board", version: "1.0.0" });

  server.registerTool(
    "board_open",
    {
      description:
        `Open the HTML you wrote (${DIAGRAM_DIR}/*.diagram.html) in this session's board pane. ` +
        "Call it right after writing the file. Specify path relative to the worktree.",
      inputSchema: {
        path: z
          .string()
          .describe(
            `Board file path relative to the worktree (e.g. ${DIAGRAM_DIR}/purchase-flow.diagram.html)`
          ),
      },
    },
    async args => {
      try {
        const res = await handleBoardOpen(deps, worktreePath, {
          path: args.path,
        });
        return textResult(
          res.ok
            ? JSON.stringify({ opened: args.path })
            : `board_open failed: ${res.error ?? "unknown error"}`
        );
      } catch (e) {
        return textResult(`board_open failed: ${getErrorMessage(e)}`);
      }
    }
  );

  server.registerTool(
    "todo_add",
    {
      description:
        "When the user asks, add a topic that was put on hold, postponed, or set aside as a separate matter to this session's TODOs. TODOs are for the human to read later as a reminder; the human completes and deletes them. Before adding, call todo_list to check that the same item does not already exist.",
      inputSchema: {
        text: z
          .string()
          .describe(
            "One-line text (up to 200 characters). Word it so that it is clear what to do when read later"
          ),
        note: z
          .string()
          .optional()
          .describe(
            "Supplementary note (why it was put on hold, related files, etc.)"
          ),
        branch: z
          .string()
          .optional()
          .describe(
            "Suggested branch name for when a new worktree is created from this TODO. English kebab-case summarizing the topic (e.g. fix-log-format), about 3 to 5 words"
          ),
      },
    },
    async args => {
      const result = await handleTodoAdd(deps, worktreePath, {
        text: args.text,
        ...(args.note === undefined ? {} : { note: args.note }),
        ...(args.branch === undefined ? {} : { branch: args.branch }),
      });
      return textResult(
        "error" in result
          ? `todo_add failed: ${result.error}`
          : JSON.stringify(result)
      );
    }
  );

  server.registerTool(
    "todo_list",
    {
      description:
        "Read this session's open TODOs. Call it before adding with todo_add to check that the same item does not already exist.",
      inputSchema: {},
    },
    async () => {
      try {
        return textResult(
          JSON.stringify(await handleTodoList(deps, worktreePath))
        );
      } catch (error) {
        return textResult(`todo_list failed: ${getErrorMessage(error)}`);
      }
    }
  );

  server.registerTool(
    "task_start",
    {
      description:
        "Start a child task in a separate git worktree. Creates a worktree on a new branch with the caller's worktree as its parent, " +
        "starts an Ark session, waits for it to start, and sends prompt as the first message. The child appears under its parent in Ark's list. " +
        "The child's result is not returned, and this tool does not wait for it (the user watches the progress in Ark). " +
        "Returns the new worktree's path and branch name, and whether prompt was sent (promptSent).",
      inputSchema: {
        name: z
          .string()
          .describe(
            "Task name. It becomes the branch name and the worktree directory name. English kebab-case summarizing the topic (e.g. fix-log-format), about 3 to 5 words"
          ),
        prompt: z
          .string()
          .describe(
            "The first message sent to the child session. The child does not know this conversation, so state the goal, the background, and the completion criteria"
          ),
        baseBranch: z
          .string()
          .optional()
          .describe(
            "Base branch. Defaults to the current branch of the caller's worktree"
          ),
      },
    },
    async args => {
      const result = await handleTaskStart(deps, worktreePath, {
        name: args.name,
        prompt: args.prompt,
        ...(args.baseBranch === undefined
          ? {}
          : { baseBranch: args.baseBranch }),
      });
      return textResult(
        "error" in result
          ? `task_start failed: ${result.error}`
          : JSON.stringify(result)
      );
    }
  );

  return server;
}

/**
 * Board MCP server (HTTP) のライフサイクル管理。
 * 1 プロセスに 1 インスタンスで良く、worktree ごとの区別は
 * bearer token → worktreePath の registry 解決で行う。
 */
export class BoardMcpServer {
  private httpServer: HttpServer | null = null;
  private port: number | null = null;
  private starting: Promise<{ url: string }> | null = null;

  /**
   * HTTP MCP server を起動する（冪等）。起動済みなら既存 endpoint を返す。
   * 127.0.0.1 で listen し、Authorization: Bearer を registry で解決する。
   *
   * @param opts.port 希望する bind ポート（省略/0 で ephemeral）。EADDRINUSE の場合は
   *   ephemeral に 1 度だけフォールバックする（ArkMcpServer と同じ方針）。
   * @param opts.token 受け付けない（`never`）。token は per-request で
   *   registry から解決するため、ArkMcpServer のような server 単一 token は持たない。
   */
  start(
    deps: BoardMcpDeps,
    registry: BoardSessionRegistry,
    opts: { port?: number; token?: never } = {}
  ): Promise<{ url: string }> {
    if (this.port !== null) {
      return Promise.resolve({ url: `http://127.0.0.1:${this.port}/mcp` });
    }
    if (this.starting) return this.starting;

    const preferredPort = opts.port;
    this.starting = new Promise<{ url: string }>((resolve, reject) => {
      const app = express();
      app.use(express.json({ limit: "8mb" }));

      // 認証: Bearer token を registry で worktree に解決。解決できなければ 401。
      const requireSession: express.RequestHandler = (req, res, next) => {
        const auth = req.header("authorization") ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const worktreePath = registry.resolve(token);
        if (!worktreePath) {
          res.status(401).json({
            jsonrpc: "2.0",
            error: { code: -32001, message: "unauthorized" },
            id: null,
          });
          return;
        }
        (req as express.Request & { worktreePath: string }).worktreePath =
          worktreePath;
        next();
      };

      app.post("/mcp", requireSession, async (req, res) => {
        const worktreePath = (req as express.Request & { worktreePath: string })
          .worktreePath;
        // stateless: request 毎に server + transport を生成する。
        const server = createBoardMcpServer(deps, worktreePath);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on("close", () => {
          transport.close().catch(() => {});
          server.close().catch(() => {});
        });
        try {
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } catch (err) {
          console.error(
            "[BoardMcpServer] handleRequest error:",
            getErrorMessage(err)
          );
          if (!res.headersSent) {
            res.status(500).json({
              jsonrpc: "2.0",
              error: { code: -32603, message: "internal error" },
              id: null,
            });
          }
        }
      });
      // stateless モードでは GET(SSE)/DELETE は使わない
      app.get("/mcp", (_req, res) => res.status(405).end());
      app.delete("/mcp", (_req, res) => res.status(405).end());

      const httpServer = createServer(app);
      let triedFallback = false;
      const onListening = () => {
        const addr = httpServer.address();
        if (!addr || typeof addr === "string") {
          httpServer.close();
          this.starting = null;
          reject(new Error("BoardMcpServer: failed to get the port"));
          return;
        }
        this.httpServer = httpServer;
        this.port = addr.port;
        this.starting = null;
        const endpoint = { url: `http://127.0.0.1:${addr.port}/mcp` };
        console.log(
          `[BoardMcpServer] HTTP MCP server started: ${endpoint.url}`
        );
        resolve(endpoint);
      };
      httpServer.on("error", err => {
        if (
          !triedFallback &&
          preferredPort &&
          (err as NodeJS.ErrnoException).code === "EADDRINUSE"
        ) {
          triedFallback = true;
          console.warn(
            `[BoardMcpServer] Preferred port ${preferredPort} is in use. Falling back to an ephemeral port`
          );
          httpServer.listen(0, "127.0.0.1", onListening);
          return;
        }
        this.starting = null;
        reject(err);
      });
      httpServer.listen(preferredPort ?? 0, "127.0.0.1", onListening);
    });
    return this.starting;
  }

  /** 現在の bind ポート（未起動なら null） */
  getPort(): number | null {
    return this.port;
  }

  /** HTTP MCP server を停止する */
  stop(): void {
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
    this.port = null;
    this.starting = null;
  }
}
