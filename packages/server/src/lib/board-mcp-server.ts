/**
 * Board MCP Server (HTTP)
 *
 * board_open ツール（生成した図ファイルをセッションのボードペインで開かせる）を
 * 公開する **Streamable HTTP MCP server** を 127.0.0.1 に公開する。
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

import fs from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import path from "node:path";
import type {
  DiagramCommentsResponse,
  DiagramCommentThread,
} from "@ark/shared";
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

export interface BoardMcpDeps {
  /**
   * 図ファイルをボードペインで開かせる（B-0a）。
   * 実際に readDiagram で読めることを確認してから開かせる（403/404/422 の
   * 理由をそのまま呼び出し元 = Claude に返す）ため非同期。
   */
  openDiagram(
    worktreePath: string,
    relPath: string
  ): Promise<{ ok: boolean; error?: string }>;
  /** コメントを走査する図候補を worktree 相対パスで返す。 */
  listDiagramPaths(worktreePath: string): Promise<string[]>;
  /** doc/anchor trust boundary を通して sidecar を読む。 */
  getDiagramComments(
    worktreePath: string,
    relPath: string
  ): Promise<DiagramCommentsResponse>;
}

export interface BoardOpenInput {
  path: string;
}

export interface BoardOpenResult {
  ok: boolean;
  error?: string;
}

export interface BoardCommentsInput {
  path?: string;
  includeResolved?: boolean;
}

type BoardCommentThread = Pick<
  DiagramCommentThread,
  | "id"
  | "anchorId"
  | "anchorText"
  | "anchorQuote"
  | "anchorOccurrence"
  | "status"
> & {
  messages: Array<{ at: string; body: string }>;
};

export type BoardCommentsResult = {
  diagrams: Array<
    | { path: string; threads: BoardCommentThread[] }
    | { path: string; error: string }
  >;
};

/** board_open の純ロジック（HTTP/MCP から分離してテスト可能にする）。 */
export async function handleBoardOpen(
  deps: Pick<BoardMcpDeps, "openDiagram">,
  worktreePath: string,
  input: BoardOpenInput
): Promise<BoardOpenResult> {
  return deps.openDiagram(worktreePath, input.path);
}

/** board_comments の純ロジック（HTTP/MCP から分離してテスト可能にする）。 */
export async function handleBoardComments(
  deps: Pick<BoardMcpDeps, "listDiagramPaths" | "getDiagramComments">,
  worktreePath: string,
  input: BoardCommentsInput
): Promise<BoardCommentsResult> {
  const paths = input.path
    ? [input.path]
    : await deps.listDiagramPaths(worktreePath);
  const diagrams: BoardCommentsResult["diagrams"] = [];

  for (const relPath of paths) {
    let response: DiagramCommentsResponse;
    try {
      response = await deps.getDiagramComments(worktreePath, relPath);
    } catch (error) {
      diagrams.push({ path: relPath, error: getErrorMessage(error) });
      continue;
    }
    if (!response.ok) {
      diagrams.push({ path: relPath, error: response.error });
      continue;
    }
    const threads = response.comments.threads
      .filter(thread => input.includeResolved || thread.status === "open")
      .map(thread => ({
        id: thread.id,
        anchorId: thread.anchorId,
        anchorText: thread.anchorText,
        ...(thread.anchorQuote === undefined
          ? {}
          : { anchorQuote: thread.anchorQuote }),
        ...(thread.anchorOccurrence === undefined
          ? {}
          : { anchorOccurrence: thread.anchorOccurrence }),
        status: thread.status,
        messages: thread.messages.map(message => ({
          at: message.at,
          body: message.body,
        })),
      }));
    if (threads.length > 0) diagrams.push({ path: relPath, threads });
  }

  return { diagrams };
}

async function collectDiagramPaths(
  directory: string,
  relativeParts: string[]
): Promise<string[]> {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const childParts = [...relativeParts, entry.name];
    if (entry.isDirectory()) {
      result.push(
        ...(await collectDiagramPaths(
          path.join(directory, entry.name),
          childParts
        ))
      );
    } else if (entry.isFile() && entry.name.endsWith(".diagram.html")) {
      result.push([DIAGRAM_DIR, ...childParts].join("/"));
    }
  }
  return result;
}

/** DIAGRAM_DIR 配下の図候補を決定的な順序で列挙する。 */
export async function listDiagramCommentPaths(
  worktreeReal: string
): Promise<string[]> {
  try {
    const paths = await collectDiagramPaths(
      path.join(worktreeReal, DIAGRAM_DIR),
      []
    );
    return paths.sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
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
        `生成した図ファイル (${DIAGRAM_DIR}/*.diagram.html) をこのセッションのボードペインで開かせる。` +
        "図を Write/Edit で書いた直後に呼ぶこと。path は worktree 相対で指定する。",
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
    "board_comments",
    {
      description:
        "ボード（文書型の図）に付いた未解決コメントを読む。ユーザーが「コメントした」「図を見て」と言ったとき、または図のレビューを依頼されたときに呼ぶ。",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            `worktree 相対の図ファイルパス（省略時は ${DIAGRAM_DIR} 配下の全図）`
          ),
        includeResolved: z
          .boolean()
          .optional()
          .default(false)
          .describe("解決済みスレッドも含める"),
      },
    },
    async args => {
      try {
        const result = await handleBoardComments(deps, worktreePath, {
          ...(args.path === undefined ? {} : { path: args.path }),
          includeResolved: args.includeResolved,
        });
        return textResult(JSON.stringify(result));
      } catch (error) {
        return textResult(
          JSON.stringify({
            diagrams: [],
            error: `board_comments 失敗: ${getErrorMessage(error)}`,
          })
        );
      }
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
