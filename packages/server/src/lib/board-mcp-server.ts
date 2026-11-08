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
        `書いた HTML (${DIAGRAM_DIR}/*.diagram.html) をこのセッションのボードペインで開かせる。` +
        "書いた直後に呼ぶこと。path は worktree 相対で指定する。",
      inputSchema: {
        path: z
          .string()
          .describe(
            `worktree 相対の図ファイルパス（例: ${DIAGRAM_DIR}/purchase-flow.diagram.html）`
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
            : `board_open 失敗: ${res.error ?? "不明なエラー"}`
        );
      } catch (e) {
        return textResult(`board_open 失敗: ${getErrorMessage(e)}`);
      }
    }
  );

  server.registerTool(
    "todo_add",
    {
      description:
        "ユーザーに頼まれたときに、保留・後回し・別件にした話題をこのセッションの TODO に足す。TODO は人間が後で読んで思い出すためのもので、完了と削除は人間が行う。足す前に todo_list で同じものが無いか確かめること。",
      inputSchema: {
        text: z
          .string()
          .describe(
            "1 行の本文 (200 文字まで)。あとで読んで何をするか分かる言葉で"
          ),
        note: z
          .string()
          .optional()
          .describe("補足 (保留にした理由や、関係するファイルなど)"),
        branch: z
          .string()
          .optional()
          .describe(
            "この TODO で新しい worktree を作るときのブランチ名の候補。話題を要約した英語の kebab-case (例: fix-log-format)、3〜5語程度"
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
          ? `todo_add 失敗: ${result.error}`
          : JSON.stringify(result)
      );
    }
  );

  server.registerTool(
    "todo_list",
    {
      description:
        "このセッションの未完了の TODO を読む。todo_add で足す前に、同じものが無いかを確かめるために呼ぶ。",
      inputSchema: {},
    },
    async () => {
      try {
        return textResult(
          JSON.stringify(await handleTodoList(deps, worktreePath))
        );
      } catch (error) {
        return textResult(`todo_list 失敗: ${getErrorMessage(error)}`);
      }
    }
  );

  server.registerTool(
    "task_start",
    {
      description:
        "子タスクを別の git worktree に起こす。呼び出し元の worktree を親にして新しいブランチの worktree を作り、" +
        "Ark のセッションを起動し、起動を待って prompt を最初の文として送る。子は Ark の一覧で親の下に並ぶ。" +
        "子の結果は返らないし、待たない (進み具合はユーザーが Ark で見る)。" +
        "戻り値は新しい worktree のパスとブランチ名、prompt を送れたか (promptSent)。",
      inputSchema: {
        name: z
          .string()
          .describe(
            "タスク名。ブランチ名と worktree のディレクトリ名になる。話題を要約した英語の kebab-case (例: fix-log-format)、3〜5語程度"
          ),
        prompt: z
          .string()
          .describe(
            "子セッションに最初に送る文。子はこの会話を知らないので、目的・背景・終わりの条件を書く"
          ),
        baseBranch: z
          .string()
          .optional()
          .describe(
            "ベースのブランチ。省略時は呼び出し元の worktree の今のブランチ"
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
          ? `task_start 失敗: ${result.error}`
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
            "[BoardMcpServer] handleRequest エラー:",
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
          reject(new Error("BoardMcpServer: ポート取得に失敗しました"));
          return;
        }
        this.httpServer = httpServer;
        this.port = addr.port;
        this.starting = null;
        const endpoint = { url: `http://127.0.0.1:${addr.port}/mcp` };
        console.log(`[BoardMcpServer] HTTP MCP server を起動: ${endpoint.url}`);
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
            `[BoardMcpServer] 希望ポート ${preferredPort} が使用中。ephemeral にフォールバックします`
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
