/**
 * Claude Code Manager - Server
 *
 * Express server with Socket.IO for real-time communication.
 * Handles git worktree operations and ttyd/tmux-based Claude Code sessions.
 * Supports remote access via Cloudflare Tunnel.
 */

import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import path from "node:path";
import { fileURLToPath } from "node:url";
import httpProxy from "http-proxy";
import {
  listWorktrees,
  createWorktree,
  deleteWorktree,
  isGitRepository,
  scanRepositories,
} from "./lib/git.js";
import { sessionOrchestrator } from "./lib/session-orchestrator.js";
import { tmuxManager } from "./lib/tmux-manager.js";
import { TunnelManager } from "./lib/tunnel.js";
import { authManager } from "./lib/auth.js";
import { printRemoteAccessInfo } from "./lib/qrcode.js";
import { getListeningPorts } from "./lib/port-scanner.js";
import { imageManager, ImageManagerError } from "./lib/image-manager.js";
import { getErrorMessage } from "./lib/errors.js";
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  ManagedSession,
} from "../shared/types.js";

// Parse command line arguments
const args = process.argv.slice(2);
const enableRemote = args.includes("--remote") || args.includes("-r");
const enableQuick = args.includes("--quick") || args.includes("-q");

// Parse --repos option: --repos /path1,/path2
let allowedRepos: string[] = [];
const reposIndex = args.findIndex((arg) => arg === "--repos");
if (reposIndex !== -1 && args[reposIndex + 1]) {
  allowedRepos = args[reposIndex + 1]
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  console.log(`Allowed repositories: ${allowedRepos.join(", ")}`);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// トンネル状態管理
let activeTunnel: TunnelManager | null = null;
let tunnelUrl: string | null = null;
let tunnelToken: string | null = null;

async function startServer() {
  const app = express();
  const server = createServer(app);
  const port = Number(process.env.PORT) || 3001;

  // Create proxy for ttyd WebSocket connections
  const ttydProxy = httpProxy.createProxyServer({
    ws: true,
    changeOrigin: true,
  });

  // Handle proxy errors
  ttydProxy.on("error", (err, _req, res) => {
    console.error("[Proxy] Error:", err.message);
    if (res && "writeHead" in res) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Bad Gateway - ttyd connection failed");
    }
  });

  if (enableRemote) {
    console.log("Remote access mode enabled - using Cloudflare Access for authentication");
  }

  if (enableQuick) {
    console.log("Quick Tunnel mode enabled - using temporary *.trycloudflare.com URL with token authentication");
  }

  // Apply HTTP authentication middleware
  app.use(authManager.httpMiddleware());

  // Initialize Socket.IO
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  // Apply Socket.IO authentication middleware
  io.use(authManager.socketMiddleware());

  // ===== ttyd Proxy Routes =====

  // HTTP proxy for ttyd
  app.use("/ttyd/:sessionId", (req, res) => {
    const { sessionId } = req.params;
    const session = sessionOrchestrator.getSession(sessionId);

    if (!session || !session.ttydPort) {
      res.status(404).json({ error: "Session not found or ttyd not running" });
      return;
    }

    // ttydは--base-path=/ttyd/{sessionId}で起動しており、
    // /ttyd/{sessionId}/以下のパスでリクエストを待ち受ける。
    // Expressのapp.useはマウントパス(/ttyd/:sessionId)を削除するため、
    // req.urlは/index.htmlのようにプレフィックスが削除された状態になる。
    // ttydにはフルパスで転送する必要があるため、originalUrlを使用する。
    req.url = req.originalUrl;

    ttydProxy.web(req, res, {
      target: `http://127.0.0.1:${session.ttydPort}`,
    });
  });

  // Serve static files from dist/public in production only
  if (process.env.NODE_ENV === "production") {
    const staticPath = path.resolve(__dirname, "public");
    app.use(express.static(staticPath));

    // Handle client-side routing - serve index.html for all routes
    // Exclude ttyd routes
    app.get(/^(?!\/ttyd\/).*$/, (_req, res) => {
      res.sendFile(path.join(staticPath, "index.html"));
    });
  }

  // ===== WebSocket Upgrade Handler =====

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Handle ttyd WebSocket connections
    const ttydMatch = pathname.match(/^\/ttyd\/([^/]+)/);
    if (ttydMatch) {
      const sessionId = ttydMatch[1];
      const session = sessionOrchestrator.getSession(sessionId);

      if (session?.ttydPort) {
        // ttydは--base-path=/ttyd/{sessionId}で起動しており、
        // /ttyd/{sessionId}/wsでWebSocket接続を待ち受ける。
        // req.urlはそのまま転送する（パスの変更不要）。
        ttydProxy.ws(req, socket, head, {
          target: `ws://127.0.0.1:${session.ttydPort}`,
        });
        return;
      } else {
        socket.destroy();
        return;
      }
    }

    // Let Socket.IO handle other WebSocket connections
    // (Socket.IO has its own upgrade handler)
  });

  // ===== Socket.IO Connection Handler =====

  io.on("connection", (socket) => {
    console.log(`Client connected: ${socket.id}`);

    // Send allowed repos list to client on connection
    socket.emit("repos:list", allowedRepos);

    // ===== Repository Commands =====

    socket.on("repo:scan", async (basePath) => {
      try {
        socket.emit("repos:scanning", { basePath, status: "start" });
        const repos = await scanRepositories(basePath);
        socket.emit("repos:scanned", repos);
        socket.emit("repos:scanning", { basePath, status: "complete" });
      } catch (error) {
        socket.emit("repos:scanning", {
          basePath,
          status: "error",
          error: getErrorMessage(error),
        });
      }
    });

    socket.on("repo:select", async (repoPath) => {
      try {
        if (allowedRepos.length > 0 && !allowedRepos.includes(repoPath)) {
          socket.emit("repo:error", "Repository not in allowed list");
          return;
        }

        const isRepo = await isGitRepository(repoPath);
        if (!isRepo) {
          socket.emit("repo:error", "Not a valid git repository");
          return;
        }
        socket.emit("repo:set", repoPath);

        const worktrees = await listWorktrees(repoPath);
        socket.emit("worktree:list", worktrees);
      } catch (error) {
        socket.emit("repo:error", getErrorMessage(error));
      }
    });

    // ===== Worktree Commands =====

    socket.on("worktree:list", async (repoPath) => {
      try {
        const worktrees = await listWorktrees(repoPath);
        socket.emit("worktree:list", worktrees);
      } catch (error) {
        socket.emit("worktree:error", getErrorMessage(error));
      }
    });

    socket.on("worktree:create", async ({ repoPath, branchName, baseBranch }) => {
      try {
        const worktree = await createWorktree(repoPath, branchName, baseBranch);
        socket.emit("worktree:created", worktree);

        const worktrees = await listWorktrees(repoPath);
        socket.emit("worktree:list", worktrees);
      } catch (error) {
        socket.emit("worktree:error", getErrorMessage(error));
      }
    });

    socket.on("worktree:delete", async ({ repoPath, worktreePath }) => {
      try {
        // Find and stop any session using this worktree
        const session = sessionOrchestrator.getSessionByWorktree(worktreePath);
        if (session) {
          sessionOrchestrator.stopSession(session.id);
        }

        // worktree IDをパスから決定的に導出（listWorktreesと同じロジック）
        const deletedWorktreeId = Buffer.from(worktreePath)
          .toString("base64")
          .replace(/[/+=]/g, "");

        await deleteWorktree(repoPath, worktreePath);

        // 削除成功を通知
        socket.emit("worktree:deleted", deletedWorktreeId);

        const worktrees = await listWorktrees(repoPath);
        socket.emit("worktree:list", worktrees);
      } catch (error) {
        socket.emit("worktree:error", getErrorMessage(error));
      }
    });

    // ===== Session Commands =====

    socket.on("session:start", async ({ worktreeId, worktreePath }) => {
      try {
        const session = await sessionOrchestrator.startSession(worktreeId, worktreePath);
        socket.emit("session:created", session);
      } catch (error) {
        socket.emit("session:error", {
          sessionId: "",
          error: getErrorMessage(error),
        });
      }
    });

    socket.on("session:restore", async (worktreePath) => {
      try {
        // 既存セッションを復元（ttydが起動していなければ起動）
        const session = await sessionOrchestrator.restoreSession(worktreePath);
        if (session) {
          socket.emit("session:restored", session);
        } else {
          socket.emit("session:restore_failed", {
            worktreePath,
            error: "No existing session found",
          });
        }
      } catch (error) {
        socket.emit("session:restore_failed", {
          worktreePath,
          error: getErrorMessage(error),
        });
      }
    });

    socket.on("session:stop", (sessionId) => {
      sessionOrchestrator.stopSession(sessionId);
    });

    socket.on("session:send", ({ sessionId, message }) => {
      try {
        sessionOrchestrator.sendMessage(sessionId, message);
      } catch (error) {
        socket.emit("session:error", {
          sessionId,
          error: getErrorMessage(error),
        });
      }
    });

    // New: Send special keys (Ctrl+C, etc.)
    socket.on("session:key", ({ sessionId, key }) => {
      try {
        sessionOrchestrator.sendSpecialKey(sessionId, key);
      } catch (error) {
        socket.emit("session:error", {
          sessionId,
          error: getErrorMessage(error),
        });
      }
    });

    // コピー: tmuxバッファの内容をクライアントに返す（コールバックパターン）
    socket.on("session:copy", (sessionId, callback) => {
      try {
        const text = tmuxManager.getBuffer(sessionId);
        if (text) {
          callback({ text });
        } else {
          callback({ error: "バッファが空です" });
        }
      } catch (error) {
        callback({ error: String(error) });
      }
    });

    // ===== Session Orchestrator Event Handlers =====
    // sessionOrchestrator のイベントをそのまま Socket.IO クライアントへ転送する
    const forwardedEvents = ["session:created", "session:restored", "session:stopped"] as const;
    type ForwardedEvent = (typeof forwardedEvents)[number];

    const forwardHandlers = new Map<ForwardedEvent, (...args: unknown[]) => void>();
    for (const event of forwardedEvents) {
      const handler = (...args: unknown[]) => {
        (socket.emit as (event: string, ...args: unknown[]) => void)(event, ...args);
      };
      forwardHandlers.set(event, handler);
      sessionOrchestrator.on(event, handler);
    }

    // ===== Port Scan Commands =====

    // ポートスキャン
    socket.on("ports:scan", () => {
      const ports = getListeningPorts();
      socket.emit("ports:list", { ports });
    });

    // ===== Tunnel Commands =====

    // トンネル起動
    socket.on("tunnel:start", async (data?: { port?: number }) => {
      const targetPort = data?.port ?? port; // デフォルトはサーバーポート

      if (activeTunnel) {
        // 既にアクティブなら現在の情報を返す
        socket.emit("tunnel:status", { active: true, url: tunnelUrl ?? undefined, token: tunnelToken ?? undefined });
        return;
      }

      try {
        // トークン生成
        authManager.enable();
        tunnelToken = authManager.getToken();

        // Quick Tunnel 起動
        activeTunnel = new TunnelManager({
          localPort: targetPort,
          mode: "quick",
        });

        const publicUrl = await activeTunnel.start();
        console.log("[Tunnel] Public URL:", publicUrl);
        tunnelUrl = authManager.buildAuthUrl(publicUrl);
        console.log("[Tunnel] Auth URL:", tunnelUrl);
        console.log("[Tunnel] Token:", tunnelToken);

        // 全クライアントに通知
        io.emit("tunnel:started", { url: tunnelUrl, token: tunnelToken });

        // エラーハンドリング
        activeTunnel.on("error", (error) => {
          io.emit("tunnel:error", { message: error.message });
        });

        activeTunnel.on("close", () => {
          activeTunnel = null;
          tunnelUrl = null;
          tunnelToken = null;
          authManager.disable();
          io.emit("tunnel:stopped");
        });
      } catch (error) {
        socket.emit("tunnel:error", { message: getErrorMessage(error) });
      }
    });

    // トンネル停止
    socket.on("tunnel:stop", () => {
      if (activeTunnel) {
        activeTunnel.stop();
        activeTunnel = null;
        tunnelUrl = null;
        tunnelToken = null;
        authManager.disable();
        io.emit("tunnel:stopped");
      }
    });

    // 新しい接続時に現在のトンネル状態を送信
    socket.emit("tunnel:status", {
      active: !!activeTunnel,
      url: tunnelUrl ?? undefined,
      token: tunnelToken ?? undefined,
    });

    // ===== Image Upload Commands =====

    socket.on("image:upload", async ({ sessionId, base64Data, mimeType }) => {
      try {
        const result = await imageManager.saveImage(sessionId, base64Data, mimeType);
        socket.emit("image:uploaded", result);
      } catch (error) {
        socket.emit("image:error", {
          message: error instanceof ImageManagerError ? error.message : "画像のアップロードに失敗しました",
        });
      }
    });

    // Cleanup on disconnect
    socket.on("disconnect", () => {
      console.log(`Client disconnected: ${socket.id}`);

      forwardHandlers.forEach((handler, event) => {
        sessionOrchestrator.off(event, handler);
      });
    });
  });

  server.listen(port, async () => {
    console.log(`Claude Code Manager server running on http://localhost:${port}/`);

    // Start Quick Tunnel if enabled
    if (enableQuick) {
      console.log("Starting Quick Tunnel...");
      authManager.enable(); // トークン認証を有効化

      const tunnel = new TunnelManager({
        localPort: port,
        mode: "quick",
      });

      try {
        const publicUrl = await tunnel.start();
        const authUrl = authManager.buildAuthUrl(publicUrl);
        await printRemoteAccessInfo(authUrl, authManager.getToken());

        tunnel.on("error", (error) => {
          console.error("Tunnel error:", error.message);
        });

        tunnel.on("close", (code) => {
          console.log(`Tunnel closed with code ${code}`);
        });

        const tunnelCleanup = () => {
          tunnel.stop();
        };

        process.on("SIGTERM", tunnelCleanup);
        process.on("SIGINT", tunnelCleanup);
      } catch (error) {
        console.error(
          "Failed to start tunnel:",
          getErrorMessage(error)
        );
        console.log("Continuing without remote access...");
      }
    }

    // Start Named Tunnel if remote access is enabled
    if (enableRemote) {
      console.log("Starting Cloudflare Tunnel...");
      const tunnel = new TunnelManager({
        localPort: port,
        mode: "named",
        namedTunnelOptions: {
          tunnelName: "claude-code-manager",
          publicUrl: "https://ccm.ignission.tech",
        },
      });

      try {
        const publicUrl = await tunnel.start();
        await printRemoteAccessInfo(publicUrl, "");

        tunnel.on("error", (error) => {
          console.error("Tunnel error:", error.message);
        });

        tunnel.on("close", (code) => {
          console.log(`Tunnel closed with code ${code}`);
        });

        const tunnelCleanup = () => {
          tunnel.stop();
        };

        process.on("SIGTERM", tunnelCleanup);
        process.on("SIGINT", tunnelCleanup);
      } catch (error) {
        console.error(
          "Failed to start tunnel:",
          getErrorMessage(error)
        );
        console.log("Continuing without remote access...");
      }
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("Shutting down...");
    sessionOrchestrator.cleanup();
    server.close(() => {
      process.exit(0);
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

startServer().catch(console.error);
