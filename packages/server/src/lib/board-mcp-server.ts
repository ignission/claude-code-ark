/**
 * Board MCP Server (HTTP)
 *
 * セッションボード（Excalidraw）へ Claude が図解を書き込むための
 * **Streamable HTTP MCP server** を 127.0.0.1 に公開する。
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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { expandElements, type SimpleElement } from "./board-element-codec.js";
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
  getBoardScene(worktreePath: string): { elements: unknown[] };
  saveBoardScene(worktreePath: string, scene: { elements: unknown[] }): void;
  notifyUpdated(worktreePath: string): void;
  /**
   * 図ファイルをボードペインで開かせる（B-0a）。
   * 実際に readDiagram で読めることを確認してから開かせる（403/404/422 の
   * 理由をそのまま呼び出し元 = Claude に返す）ため非同期。
   */
  openDiagram(
    worktreePath: string,
    relPath: string
  ): Promise<{ ok: boolean; error?: string }>;
}

export interface BoardWriteInput {
  mode: "append" | "replace";
  elements: SimpleElement[];
}

export interface BoardWriteResult {
  added: number;
  total: number;
  skipped: { id?: string; reason: string }[];
}

/**
 * board_write の純ロジック（HTTP/MCP から分離してテスト可能にする）。
 * - append: 既存 scene に展開後の要素を追記する
 * - replace: 既存を破棄し展開後の要素で置き換える
 * - 展開後の有効要素が 0 件（全 skip）なら保存/通知しない（scene を壊さない）
 */
export function handleBoardWrite(
  deps: Pick<
    BoardMcpDeps,
    "getBoardScene" | "saveBoardScene" | "notifyUpdated"
  >,
  worktreePath: string,
  input: BoardWriteInput
): BoardWriteResult {
  const existing =
    input.mode === "replace"
      ? []
      : (deps.getBoardScene(worktreePath).elements ?? []);
  const { elements, skipped } = expandElements(input.elements, {
    startIndex: existing.length,
  });
  if (elements.length === 0) {
    return { added: 0, total: existing.length, skipped };
  }
  const merged = [...existing, ...elements];
  deps.saveBoardScene(worktreePath, { elements: merged });
  deps.notifyUpdated(worktreePath);
  return { added: elements.length, total: merged.length, skipped };
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

// board_write の zod schema。
// SimpleElement は discriminated union だが、MCP スキーマとしては record で緩く受け、
// 実際の検証・変換は expandElements（codec 側）に委譲する（不正/未知 type は skip される）。
const simpleElementSchema = z.array(z.record(z.string(), z.any()));

/**
 * board_write ツールを登録した McpServer を構築する。
 * stateless transport では request 毎に新しい server を作るため、
 * deps + worktreePath（認証で解決済み）を引数に取るファクトリ関数にしている。
 */
export function createBoardMcpServer(
  deps: BoardMcpDeps,
  worktreePath: string
): McpServer {
  const server = new McpServer({ name: "ark-board", version: "1.0.0" });

  server.registerTool(
    "board_write",
    {
      description:
        "ユーザーが図解・作図・可視化・フロー図/構成図などを求めたら、チャットに mermaid や ASCII 図を書かず、必ずこのツールでこのセッションのボードに図を描くこと。elements は簡略スキーマ: " +
        '{type:"rect"|"ellipse"|"diamond",id,x,y,w,h,text?,color?} / {type:"text",id,x,y,text,color?} / {type:"arrow",id,from,to,label?}。' +
        "arrow の from/to は同じ呼び出し内のシェイプ id を指す。mode=append(既定,追記) / replace(全置換,ユーザーが明示要求した時のみ)。座標は左上原点・px。",
      inputSchema: {
        mode: z.enum(["append", "replace"]).default("append"),
        elements: simpleElementSchema.describe(
          "描く要素の配列（簡略スキーマ）"
        ),
      },
    },
    async args => {
      try {
        const res = handleBoardWrite(deps, worktreePath, {
          mode: args.mode ?? "append",
          elements: args.elements as unknown as SimpleElement[],
        });
        return textResult(JSON.stringify(res));
      } catch (e) {
        return textResult(`board_write 失敗: ${getErrorMessage(e)}`);
      }
    }
  );

  server.registerTool(
    "board_open",
    {
      description:
        "生成した図ファイル (docs/diagrams/*.diagram.html) をこのセッションのボードペインで開かせる。" +
        "図を Write/Edit で書いた直後に呼ぶこと。path は worktree 相対で指定する。",
      inputSchema: {
        path: z
          .string()
          .describe(
            "worktree 相対の図ファイルパス（例: docs/diagrams/purchase-flow.diagram.html）"
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
