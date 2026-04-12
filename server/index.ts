/**
 * Ark - Server
 *
 * Express server with Socket.IO for real-time communication.
 * Handles git worktree operations and ttyd/tmux-based Claude Code sessions.
 * Supports remote access via Cloudflare Tunnel.
 */

import { exec } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import express from "express";

const execAsync = promisify(exec);

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import httpProxy from "http-proxy";
import { Server, type Socket } from "socket.io";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "../shared/types.js";
import { authManager } from "./lib/auth.js";
import { beaconManager } from "./lib/beacon-manager.js";
import { browserManager } from "./lib/browser-manager.js";
import {
  CDP_PORT,
  TTYD_PORT_END,
  TTYD_PORT_START,
  VNC_PORT_END,
  VNC_PORT_START,
  WS_PORT_END,
  WS_PORT_START,
} from "./lib/constants.js";
import { db } from "./lib/database.js";
import { getErrorMessage } from "./lib/errors.js";
import { readFileFromWorktree } from "./lib/file-manager.js";
import {
  createWorktree,
  deleteWorktree,
  isGitRepository,
  listWorktrees,
  scanRepositories,
} from "./lib/git.js";
import { ImageManagerError, imageManager } from "./lib/image-manager.js";
import { getListeningPorts } from "./lib/port-scanner.js";
import { printRemoteAccessInfo } from "./lib/qrcode.js";
import { sessionOrchestrator } from "./lib/session-orchestrator.js";
import { tmuxManager } from "./lib/tmux-manager.js";
import { TunnelManager } from "./lib/tunnel.js";

// Parse command line arguments
const args = process.argv.slice(2);
const enableRemote = args.includes("--remote") || args.includes("-r");
const enableQuick = args.includes("--quick") || args.includes("-q");
const skipPermissions =
  args.includes("--skip-permissions") ||
  process.env.SKIP_PERMISSIONS === "true";

// 公開ドメイン（Named Tunnel / CORS許可用）
const publicDomain = process.env.ARK_PUBLIC_DOMAIN;

// Parse --repos option: --repos /path1,/path2
let allowedRepos: string[] = [];
const reposIndex = args.indexOf("--repos");
if (reposIndex !== -1 && args[reposIndex + 1]) {
  allowedRepos = args[reposIndex + 1]
    .split(",")
    .map(p => p.trim())
    .filter(p => p.length > 0);
  console.log(`Allowed repositories: ${allowedRepos.join(", ")}`);
}

// クライアントが選択・スキャンしたリポジトリを追跡（Beaconが参照する）
const knownRepos = new Set<string>(allowedRepos);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// トンネル状態管理
let activeTunnel: TunnelManager | null = null;
let tunnelUrl: string | null = null;
let tunnelToken: string | null = null;

// トンネル状態ファイルのパス
const TUNNEL_STATE_FILE = path.join(os.tmpdir(), "ark-tunnel-state.json");

/** トンネル状態をファイルに保存する */
function saveTunnelState(port: number): void {
  try {
    fs.writeFileSync(
      TUNNEL_STATE_FILE,
      JSON.stringify({ active: true, port }),
      "utf-8"
    );
  } catch (error) {
    console.error("[Tunnel] 状態ファイルの保存に失敗:", getErrorMessage(error));
  }
}

/** トンネル状態ファイルを削除する */
function removeTunnelState(): void {
  try {
    if (fs.existsSync(TUNNEL_STATE_FILE)) {
      fs.unlinkSync(TUNNEL_STATE_FILE);
    }
  } catch (error) {
    console.error("[Tunnel] 状態ファイルの削除に失敗:", getErrorMessage(error));
  }
}

/** トンネル状態ファイルを読み込む */
function loadTunnelState(): { active: boolean; port: number } | null {
  try {
    if (!fs.existsSync(TUNNEL_STATE_FILE)) {
      return null;
    }
    const data = JSON.parse(fs.readFileSync(TUNNEL_STATE_FILE, "utf-8"));
    if (data && data.active === true && typeof data.port === "number") {
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  const port = Number(process.env.PORT) || 4001;

  // --skip-permissions が指定された場合、Claudeを --dangerously-skip-permissions 付きで起動
  if (skipPermissions) {
    tmuxManager.setSkipPermissions(true);
    console.log(
      "Skip permissions mode enabled - Claude will run with --dangerously-skip-permissions"
    );
  }

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

  // プロキシ経由のレスポンスに強制的にクリックジャッキング対策ヘッダを付与する。
  // ttyd/noVNCはiframe埋め込みで使うため、SAMEORIGINまで許可する。
  ttydProxy.on("proxyRes", proxyRes => {
    proxyRes.headers["x-frame-options"] = "SAMEORIGIN";
    proxyRes.headers["content-security-policy"] = "frame-ancestors 'self'";
  });

  if (enableRemote) {
    console.log(
      "Remote access mode enabled - using Cloudflare Access for authentication"
    );
  }

  if (enableQuick) {
    console.log(
      "Quick Tunnel mode enabled - using temporary *.trycloudflare.com URL with token authentication"
    );
  }

  // JSON body parser（Settings API用）
  app.use(express.json({ limit: "10kb" }));

  // セキュリティヘッダー
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });

  // Apply HTTP authentication middleware
  app.use(authManager.httpMiddleware());

  // Initialize Socket.IO
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
    cors: {
      origin: (origin, callback) => {
        // originがundefined = 同一オリジンリクエスト（許可）
        if (!origin) {
          callback(null, true);
          return;
        }
        try {
          const url = new URL(origin);
          const hostname = url.hostname;
          // localhostは常に許可
          if (hostname === "localhost" || hostname === "127.0.0.1") {
            callback(null, true);
            return;
          }
          // Quick Tunnel時の許可ドメイン（トークン認証が有効な場合のみ）
          if (
            hostname.endsWith(".trycloudflare.com") &&
            authManager.isEnabled()
          ) {
            callback(null, true);
            return;
          }
          // Named Tunnel時の許可ドメイン（Named TunnelはArkサーバーとは独立稼働）
          if (publicDomain && hostname === publicDomain) {
            callback(null, true);
            return;
          }
          callback(new Error("CORS not allowed"), false);
        } catch {
          callback(new Error("Invalid origin"), false);
        }
      },
      methods: ["GET", "POST"],
    },
  });

  // Apply Socket.IO authentication middleware
  io.use(authManager.socketMiddleware());

  // BeaconにArk操作の依存を注入（MCPツールで利用）
  beaconManager.configure({
    getAllSessions: () => sessionOrchestrator.getAllSessions(),
    startSession: (worktreeId, worktreePath) =>
      sessionOrchestrator.startSession(worktreeId, worktreePath),
    stopSession: sessionId => sessionOrchestrator.stopSession(sessionId),
    sendMessage: (sessionId, message) =>
      sessionOrchestrator.sendMessage(sessionId, message),
    sendKey: (sessionId, key) =>
      sessionOrchestrator.sendSpecialKey(sessionId, key),
    capturePane: (sessionId, lines) =>
      tmuxManager.capturePane(sessionId, lines),
    listWorktrees: repoPath => listWorktrees(repoPath),
    createWorktree: async (repoPath, branchName, baseBranch) => {
      const worktree = await createWorktree(repoPath, branchName, baseBranch);
      // 通知は操作の成否に影響させない
      try {
        io.emit("worktree:created", worktree);
        const worktrees = await listWorktrees(repoPath);
        io.emit("worktree:list", worktrees);
      } catch {
        console.error("[Beacon] worktree通知に失敗しました");
      }
      return worktree;
    },
    deleteWorktree: async (repoPath, worktreePath) => {
      // 削除前にworktreeのセッションを停止
      const session = sessionOrchestrator.getSessionByWorktree(worktreePath);
      if (session) {
        sessionOrchestrator.stopSession(session.id);
      }
      // worktreeのIDをパスから決定的に導出（listWorktreesと同じロジック）
      const deletedWorktreeId = Buffer.from(worktreePath)
        .toString("base64")
        .replace(/[/+=]/g, "");
      await deleteWorktree(repoPath, worktreePath);
      // 通知は操作の成否に影響させない
      try {
        io.emit("worktree:deleted", deletedWorktreeId);
        const worktrees = await listWorktrees(repoPath);
        io.emit("worktree:list", worktrees);
      } catch {
        console.error("[Beacon] worktree通知に失敗しました");
      }
    },
    listAllWorktrees: async repos => {
      const all: unknown[] = [];
      for (const repo of repos) {
        try {
          const wts = await listWorktrees(repo);
          all.push(...wts.map(w => ({ ...w, repoPath: repo })));
        } catch {
          // 個別リポジトリのエラーはスキップ
        }
      }
      return all;
    },
    getRepos: () => Array.from(knownRepos),
    getPrUrl: async worktreePath => {
      try {
        const { stdout } = await execAsync("gh pr view --json url -q .url", {
          cwd: worktreePath,
        });
        return stdout.trim() || null;
      } catch {
        return null;
      }
    },
  });

  // Beaconイベントを要求元のSocket.IOクライアントのみに転送
  type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
  let activeBeaconSocket: TypedSocket | null = null;

  beaconManager.on("beacon:message", message => {
    if (activeBeaconSocket?.connected) {
      activeBeaconSocket.emit("beacon:message", message);
    }
  });
  beaconManager.on("beacon:stream", data => {
    if (activeBeaconSocket?.connected) {
      activeBeaconSocket.emit("beacon:stream", data);
    }
  });
  beaconManager.on("beacon:error", data => {
    if (activeBeaconSocket?.connected) {
      activeBeaconSocket.emit("beacon:error", data);
    }
  });

  /**
   * Quick Tunnelを起動する共通関数
   * tunnel:startハンドラーとサーバー起動時の自動復旧から呼ばれる。
   * @param targetPort トンネル対象のポート番号
   * @returns トンネルURL（認証トークン付き）
   */
  async function startQuickTunnelShared(targetPort: number): Promise<string> {
    if (activeTunnel) {
      return tunnelUrl!;
    }

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

    // 状態ファイルに保存
    saveTunnelState(targetPort);

    // 全クライアントに通知
    io.emit("tunnel:started", { url: tunnelUrl, token: tunnelToken });

    // エラーハンドリング
    activeTunnel.on("error", error => {
      io.emit("tunnel:error", { message: error.message });
    });

    activeTunnel.on("close", () => {
      activeTunnel = null;
      tunnelUrl = null;
      tunnelToken = null;
      authManager.disable();
      removeTunnelState();
      io.emit("tunnel:stopped");
    });

    return tunnelUrl;
  }

  // ===== HTML ファイル配信API =====

  app.get("/api/html-file", async (req, res) => {
    const filePath = req.query.path;
    if (typeof filePath !== "string" || !filePath) {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }

    // セキュリティ: 絶対パスのみ許可、パストラバーサル防止
    const normalized = path.resolve(filePath);
    if (normalized !== filePath || filePath.includes("..")) {
      res.status(400).json({ error: "Invalid file path" });
      return;
    }

    // .html / .htm 拡張子のみ許可
    const ext = path.extname(normalized).toLowerCase();
    if (ext !== ".html" && ext !== ".htm") {
      res.status(400).json({ error: "Only HTML files are allowed" });
      return;
    }

    // ローカル専用ツールのため、ディレクトリ制限は緩和
    // パストラバーサル防止・拡張子チェック・ファイル存在確認で十分なセキュリティを確保

    let fd: import("node:fs/promises").FileHandle | null = null;
    try {
      // TOCTOU防止: open→fstat→realpath+stat でinode一致を検証してからfd経由で読み取り
      fd = await fs.promises.open(normalized, fs.constants.O_RDONLY);
      const fdStat = await fd.stat();
      const realPath = await fs.promises.realpath(normalized);
      const realStat = await fs.promises.stat(realPath);
      // inode/deviceの一致でopen済みfdとrealpath結果が同一ファイルであることを保証
      if (fdStat.ino !== realStat.ino || fdStat.dev !== realStat.dev) {
        res.status(403).json({ error: "Access to this path is not allowed" });
        return;
      }
      const content = await fd.readFile("utf-8");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Content-Security-Policy", "sandbox allow-scripts");
      res.send(content);
    } catch {
      res.status(404).json({ error: "File not found" });
    } finally {
      await fd?.close();
    }
  });

  // ===== Settings API =====

  // Settings APIのキー名バリデーション
  const isValidSettingKey = (key: string): boolean =>
    /^[a-zA-Z0-9_\-:.]+$/.test(key) && key.length <= 64;

  // 全設定を取得
  app.get("/api/settings", (_req, res) => {
    try {
      const settings = db.getAllSettings();
      res.json(settings);
    } catch (e) {
      console.error("Settings API error:", getErrorMessage(e));
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // 特定キーの設定を取得
  app.get("/api/settings/:key", (req, res) => {
    if (!isValidSettingKey(req.params.key)) {
      res.status(400).json({ error: "Invalid setting key" });
      return;
    }
    try {
      const value = db.getSetting(req.params.key);
      if (value === undefined) {
        res.status(404).json({ error: "Setting not found" });
        return;
      }
      res.json({ value });
    } catch (e) {
      console.error("Settings API error:", getErrorMessage(e));
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // 複数キーを一括更新
  app.put("/api/settings", (req, res) => {
    try {
      const entries = req.body;
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
        res.status(400).json({ error: "Body must be a JSON object" });
        return;
      }
      const keys = Object.keys(entries);
      if (keys.length > 50) {
        res.status(400).json({ error: "Too many keys (max 50)" });
        return;
      }
      for (const key of keys) {
        if (!isValidSettingKey(key)) {
          res.status(400).json({ error: "Invalid setting key" });
          return;
        }
      }
      db.setSettings(entries);
      res.json({ ok: true });
    } catch (e) {
      console.error("Settings API error:", getErrorMessage(e));
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // 単一キーを更新
  app.put("/api/settings/:key", (req, res) => {
    if (!isValidSettingKey(req.params.key)) {
      res.status(400).json({ error: "Invalid setting key" });
      return;
    }
    try {
      const { value } = req.body;
      if (value === undefined) {
        res.status(400).json({ error: "Body must have a 'value' field" });
        return;
      }
      db.setSetting(req.params.key, value);
      res.json({ ok: true });
    } catch (e) {
      console.error("Settings API error:", getErrorMessage(e));
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // 設定を削除
  app.delete("/api/settings/:key", (req, res) => {
    if (!isValidSettingKey(req.params.key)) {
      res.status(400).json({ error: "Invalid setting key" });
      return;
    }
    try {
      db.deleteSetting(req.params.key);
      res.json({ ok: true });
    } catch (e) {
      console.error("Settings API error:", getErrorMessage(e));
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ===== ttyd Proxy Routes =====

  // HTTP proxy for ttyd
  app.use("/ttyd/:sessionId", (req, res) => {
    const { sessionId } = req.params;
    const session = sessionOrchestrator.getSession(sessionId);

    if (!session?.ttydPort) {
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

  // ===== noVNC Browser Proxy Routes =====

  app.use("/browser/:browserId", (req, res) => {
    const { browserId } = req.params;
    const session = browserManager.getSession(browserId);
    if (!session) {
      res.status(404).json({ error: "Browser session not found" });
      return;
    }
    // http-proxyインスタンスはttydProxyを共用する
    const subPath = req.url || "/";
    req.url = subPath;
    ttydProxy.web(req, res, { target: `http://127.0.0.1:${session.wsPort}` });
  });

  // ===== ローカルポートプロキシ（リモートアクセス時にlocalhost URLを表示するため） =====

  app.all("/proxy/:port/{*splat}", (req, res) => {
    const rawPort = req.params.port;
    if (!/^\d+$/.test(rawPort)) {
      res.status(400).json({ error: "Invalid port" });
      return;
    }
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      res.status(400).json({ error: "Invalid port" });
      return;
    }

    // Ark自体のポート・CDPポート・ttydポート範囲をブロック（SSRF対策）
    const serverPort = parseInt(process.env.PORT || "4001", 10);
    if (port === serverPort || port === CDP_PORT) {
      res.status(403).json({ error: "This port is not accessible via proxy" });
      return;
    }
    // ttydポート範囲(TTYD_PORT_START〜TTYD_PORT_END)もブロック
    if (port >= TTYD_PORT_START && port <= TTYD_PORT_END) {
      res.status(403).json({ error: "This port is not accessible via proxy" });
      return;
    }
    // VNC/WSポート範囲もブロック（noVNCブラウザセッション用）
    if (port >= VNC_PORT_START && port <= VNC_PORT_END) {
      res.status(403).json({ error: "This port is not accessible via proxy" });
      return;
    }
    if (port >= WS_PORT_START && port <= WS_PORT_END) {
      res.status(403).json({ error: "This port is not accessible via proxy" });
      return;
    }

    // req.params.splatはpath-to-regexp v8の{*splat}パターンにマッチしたパスセグメント配列
    const splatSegments = req.params.splat;
    const basePath = Array.isArray(splatSegments)
      ? `/${splatSegments.join("/")}`
      : "/";
    // クエリストリングを保持（req.urlには含まれるがreq.params.splatには含まれない）
    const queryIndex = req.url.indexOf("?");
    const query = queryIndex !== -1 ? req.url.slice(queryIndex) : "";
    const targetPath = basePath + query;
    req.url = targetPath;

    ttydProxy.web(req, res, { target: `http://127.0.0.1:${port}` }, _err => {
      if (!res.headersSent) {
        res.status(502).json({ error: "Proxy error" });
      }
    });
  });

  // Serve static files from dist/public in production only
  if (process.env.NODE_ENV === "production") {
    const staticPath = path.resolve(__dirname, "public");
    app.use(express.static(staticPath));

    // Handle client-side routing - serve index.html for all routes
    // Exclude ttyd, proxy, and browser routes
    app.get(/^(?!\/ttyd\/|\/proxy\/|\/browser\/).*$/, (_req, res) => {
      res.sendFile(path.join(staticPath, "index.html"));
    });
  }

  // ===== WebSocket Upgrade Handler =====

  /**
   * WebSocket upgradeリクエストの認証を検証する
   * authManagerが有効な場合、Quick Tunnel経由のアクセスのみトークン認証を要求する。
   * ローカル/プライベートIPは認証スキップ。
   * @returns 認証OKならtrue、失敗時はfalse（呼び出し側でsocket.destroy()する）
   */
  function authorizeWebSocketUpgrade(
    req: import("node:http").IncomingMessage,
    url: URL
  ): boolean {
    if (!authManager.isEnabled()) {
      return true;
    }

    // Quick Tunnel以外（ローカル等）はスキップ
    const host =
      (req.headers["x-forwarded-host"] as string | undefined) ||
      req.headers.host;
    const hostname = host?.split(":")[0] ?? "";
    const isQuickTunnel = hostname.endsWith(".trycloudflare.com");
    if (!isQuickTunnel) {
      return true;
    }

    const token = url.searchParams.get("token") ?? undefined;
    return authManager.validateToken(token);
  }

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Handle ttyd WebSocket connections
    const ttydMatch = pathname.match(/^\/ttyd\/([^/]+)/);
    if (ttydMatch) {
      // 認証検証（Quick Tunnel時のみ）
      if (!authorizeWebSocketUpgrade(req, url)) {
        socket.destroy();
        return;
      }

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
      }
      socket.destroy();
      return;
    }

    // Handle browser (noVNC) WebSocket connections
    const browserMatch = pathname.match(/^\/browser\/([^/]+)(\/.*)?$/);
    if (browserMatch) {
      // 認証検証（Quick Tunnel時のみ）
      if (!authorizeWebSocketUpgrade(req, url)) {
        socket.destroy();
        return;
      }

      const browserId = browserMatch[1];
      const session = browserManager.getSession(browserId);
      if (session) {
        const targetPath = browserMatch[2] || "/";
        req.url = targetPath;
        ttydProxy.ws(req, socket, head, {
          target: `ws://127.0.0.1:${session.wsPort}`,
        });
        return;
      }
      socket.destroy();
      return;
    }

    // Handle proxy WebSocket connections（ローカルポートプロキシ用）
    const proxyMatch = pathname.match(/^\/proxy\/(\d+)(\/.*)?$/);
    if (proxyMatch) {
      // 認証検証（Quick Tunnel時のみ）
      if (!authorizeWebSocketUpgrade(req, url)) {
        socket.destroy();
        return;
      }

      const proxyPort = parseInt(proxyMatch[1], 10);
      if (proxyPort >= 1 && proxyPort <= 65535) {
        // SSRF対策: Ark自体のポート、CDPポート、ttydポート範囲、VNC/WSポート範囲をブロック
        const serverPort = parseInt(process.env.PORT || "4001", 10);
        if (
          proxyPort === serverPort ||
          proxyPort === CDP_PORT ||
          (proxyPort >= TTYD_PORT_START && proxyPort <= TTYD_PORT_END) ||
          (proxyPort >= VNC_PORT_START && proxyPort <= VNC_PORT_END) ||
          (proxyPort >= WS_PORT_START && proxyPort <= WS_PORT_END)
        ) {
          socket.destroy();
          return;
        }
        const targetPath = proxyMatch[2] || "/";
        req.url = targetPath;
        ttydProxy.ws(req, socket, head, {
          target: `ws://127.0.0.1:${proxyPort}`,
        });
        return;
      }
      socket.destroy();
      return;
    }

    // Let Socket.IO handle other WebSocket connections
    // (Socket.IO has its own upgrade handler)
  });

  // ===== Socket.IO Connection Handler =====

  // 複数クライアント同時接続時の重複復元を防ぐ（セッションID → 復元中のPromise）
  const pendingAutoRestores = new Map<string, Promise<void>>();

  io.on("connection", socket => {
    console.log(`Client connected: ${socket.id}`);

    // このソケット接続で選択中のリポジトリパス
    let currentRepoPath: string | null = null;

    // Send allowed repos list to client on connection
    socket.emit("repos:list", allowedRepos);

    // ===== Session Orchestrator Event Handlers =====
    // sessionOrchestrator のイベントをそのまま Socket.IO クライアントへ転送する
    // 注意: session:list送信やttyd自動復元より前に登録する必要がある
    // （自動復元で発行されるsession:restoredイベントを転送するため）
    const forwardedEvents = [
      "session:created",
      "session:restored",
      "session:stopped",
      "session:updated",
    ] as const;
    type ForwardedEvent = (typeof forwardedEvents)[number];

    const forwardHandlers = new Map<
      ForwardedEvent,
      (...args: unknown[]) => void
    >();
    for (const event of forwardedEvents) {
      const handler = (...args: unknown[]) => {
        (socket.emit as (event: string, ...args: unknown[]) => void)(
          event,
          ...args
        );
      };
      forwardHandlers.set(event, handler);
      sessionOrchestrator.on(event, handler);
    }

    // 既存セッション一覧を送信（リロード時のペイン復元用）
    const existingSessions = sessionOrchestrator.getAllSessions();
    if (existingSessions.length > 0) {
      socket.emit("session:list", existingSessions);
    }

    // ttydが未起動のセッションを自動復元（非同期）
    // 複数クライアント同時接続でも同一セッションの復元は1回だけ実行される
    for (const session of existingSessions) {
      if (session.ttydPort || !session.worktreePath) continue;

      let recovery = pendingAutoRestores.get(session.id);
      if (!recovery) {
        recovery = sessionOrchestrator
          .restoreSession(session.worktreePath)
          .then(() => undefined)
          .finally(() => {
            pendingAutoRestores.delete(session.id);
          });
        pendingAutoRestores.set(session.id, recovery);
      }

      recovery.catch(err => {
        console.error(
          `[Socket] ttyd自動復元失敗 (${session.id}):`,
          getErrorMessage(err)
        );
        socket.emit("session:error", {
          sessionId: session.id,
          error: `ターミナルの起動に失敗しました: ${getErrorMessage(err)}`,
        });
      });
    }

    // 保存済みbasePathがあれば自動スキャン（リロード時のリポジトリ一覧復元）
    if (allowedRepos.length === 0) {
      const savedBasePath = db.getSetting("scanBasePath") as string | undefined;
      if (savedBasePath) {
        scanRepositories(savedBasePath)
          .then(repos => {
            for (const repo of repos) {
              knownRepos.add(repo.path);
            }
            socket.emit("repos:scanned", repos);
          })
          .catch(err => {
            console.error("[Socket] 自動スキャン失敗:", getErrorMessage(err));
            socket.emit("repos:scanning", {
              basePath: savedBasePath,
              status: "error",
              error: getErrorMessage(err),
            });
          });
      }
    }

    // ===== Repository Commands =====

    socket.on("repo:scan", async basePath => {
      try {
        socket.emit("repos:scanning", { basePath, status: "start" });
        const repos = await scanRepositories(basePath);
        // スキャンで見つかったリポジトリをknownReposに追加
        for (const repo of repos) {
          knownRepos.add(repo.path);
        }
        // スキャン成功時にbasePathを永続化（リロード時の自動スキャン用）
        db.setSetting("scanBasePath", basePath);
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

    socket.on("repo:select", async repoPath => {
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
        currentRepoPath = repoPath;
        knownRepos.add(repoPath);

        const worktrees = await listWorktrees(repoPath);
        socket.emit("worktree:list", worktrees);
      } catch (error) {
        socket.emit("repo:error", getErrorMessage(error));
      }
    });

    // ===== Worktree Commands =====

    socket.on("worktree:list", async repoPath => {
      try {
        const worktrees = await listWorktrees(repoPath);
        socket.emit("worktree:list", worktrees);
      } catch (error) {
        socket.emit("worktree:error", getErrorMessage(error));
      }
    });

    socket.on(
      "worktree:create",
      async ({ repoPath, branchName, baseBranch }) => {
        let worktree: Awaited<ReturnType<typeof createWorktree>>;
        try {
          worktree = await createWorktree(repoPath, branchName, baseBranch);
          io.emit("worktree:created", worktree);
        } catch (error) {
          socket.emit("worktree:error", getErrorMessage(error));
          return;
        }

        try {
          const worktrees = await listWorktrees(repoPath);
          io.emit("worktree:list", worktrees);
        } catch {
          // worktree一覧の更新失敗はセッション起動をブロックしない
        }

        // worktree作成後にセッションを自動起動（orchestratorのイベント転送に委ねる）
        try {
          await sessionOrchestrator.startSession(
            worktree.id,
            worktree.path,
            repoPath
          );
        } catch (error) {
          socket.emit("session:error", {
            sessionId: "",
            error: getErrorMessage(error),
          });
        }
      }
    );

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
        io.emit("worktree:deleted", deletedWorktreeId);

        const worktrees = await listWorktrees(repoPath);
        io.emit("worktree:list", worktrees);
      } catch (error) {
        socket.emit("worktree:error", getErrorMessage(error));
      }
    });

    // ===== Session Commands =====

    socket.on("session:start", async ({ worktreeId, worktreePath }) => {
      try {
        const session = await sessionOrchestrator.startSession(
          worktreeId,
          worktreePath,
          currentRepoPath ?? undefined
        );
        socket.emit("session:created", session);
      } catch (error) {
        socket.emit("session:error", {
          sessionId: "",
          error: getErrorMessage(error),
        });
      }
    });

    socket.on("session:restore", async worktreePath => {
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

    socket.on("session:stop", async sessionId => {
      try {
        const result = sessionOrchestrator.stopSession(sessionId);

        // worktreeも削除（メインworktreeは除外）
        if (result?.worktreePath && result.repoPath) {
          const isMain = result.worktreePath === result.repoPath;
          if (!isMain) {
            try {
              const deletedWorktreeId = Buffer.from(result.worktreePath)
                .toString("base64")
                .replace(/[/+=]/g, "");
              await deleteWorktree(result.repoPath, result.worktreePath);
              socket.emit("worktree:deleted", deletedWorktreeId);
            } catch (wtError) {
              console.error(
                `[Session] Worktree削除に失敗（セッションは削除済み）: ${getErrorMessage(wtError)}`
              );
              socket.emit("session:error", {
                sessionId,
                error: `セッションは削除しましたが、Worktreeの削除に失敗しました: ${getErrorMessage(wtError)}`,
              });
              return;
            }

            try {
              const worktrees = await listWorktrees(result.repoPath);
              socket.emit("worktree:list", worktrees);
            } catch {
              // worktree一覧の更新失敗は無視
            }
          }
        }
      } catch (error) {
        socket.emit("session:error", {
          sessionId,
          error: getErrorMessage(error),
        });
      }
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

    // スクロール: tmux copy-modeでスクロール
    socket.on("session:scroll", ({ sessionId, direction, lines }) => {
      try {
        // 入力バリデーション
        if (direction !== "up" && direction !== "down") return;
        if (typeof lines !== "number" || !Number.isFinite(lines) || lines < 1)
          return;
        const clampedLines = Math.min(lines, 500);

        sessionOrchestrator.scrollSession(sessionId, direction, clampedLines);
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
        socket.emit("tunnel:status", {
          active: true,
          url: tunnelUrl ?? undefined,
          token: tunnelToken ?? undefined,
        });
        return;
      }

      try {
        await startQuickTunnelShared(targetPort);
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
        removeTunnelState();
        io.emit("tunnel:stopped");
      }
    });

    // 新しい接続時に現在のトンネル状態を送信
    const tunnelStatus = {
      active: !!activeTunnel,
      url: tunnelUrl ?? undefined,
      token: tunnelToken ?? undefined,
    };
    console.log(`[Tunnel] Sending status to ${socket.id}:`, {
      active: tunnelStatus.active,
      hasUrl: !!tunnelStatus.url,
    });
    socket.emit("tunnel:status", tunnelStatus);

    // ===== Image Upload Commands =====

    socket.on("image:upload", async ({ sessionId, base64Data, mimeType }) => {
      try {
        const result = await imageManager.saveImage(
          sessionId,
          base64Data,
          mimeType
        );
        socket.emit("image:uploaded", result);
      } catch (error) {
        socket.emit("image:error", {
          message:
            error instanceof ImageManagerError
              ? error.message
              : "画像のアップロードに失敗しました",
        });
      }
    });

    // ===== File Viewer =====
    // レート制限: ソケットごとに最後のリクエスト時間を記録
    let lastFileReadTime = 0;

    socket.on("file:read", async ({ sessionId, filePath }) => {
      // レート制限チェック（100ms未満の間隔のリクエストを拒否）
      const now = Date.now();
      if (now - lastFileReadTime < 100) {
        socket.emit("file:content", {
          filePath,
          content: "",
          mimeType: "application/octet-stream",
          size: 0,
          error: "リクエストが多すぎます",
        });
        return;
      }
      lastFileReadTime = now;

      try {
        // /tmp配下のファイルはsessionに依存せず直接読み取り
        // sessionIdの存在チェック（認証済みソケットであることを確認）
        if (filePath.startsWith("/tmp/")) {
          if (!sessionId || !sessionOrchestrator.getSession(sessionId)) {
            socket.emit("file:content", {
              filePath,
              content: "",
              mimeType: "application/octet-stream",
              size: 0,
              error: "有効なセッションが必要です",
            });
            return;
          }
          const normalizedPath = path.resolve(filePath);
          if (!normalizedPath.startsWith("/tmp/")) {
            socket.emit("file:content", {
              filePath,
              content: "",
              mimeType: "application/octet-stream",
              size: 0,
              error: "不正なパスです",
            });
            return;
          }
          const result = await readFileFromWorktree("", normalizedPath);
          socket.emit("file:content", result);
          return;
        }

        // sessionIdからworktreePathをサーバー側で解決
        const session = sessionOrchestrator.getSession(sessionId);
        if (!session?.worktreePath) {
          socket.emit("file:content", {
            filePath,
            content: "",
            mimeType: "application/octet-stream",
            size: 0,
            error: "セッションが見つかりません",
          });
          return;
        }
        const result = await readFileFromWorktree(
          session.worktreePath,
          filePath
        );
        socket.emit("file:content", result);
      } catch (error) {
        socket.emit("file:content", {
          filePath,
          content: "",
          mimeType: "application/octet-stream",
          size: 0,
          error: getErrorMessage(error),
        });
      }
    });

    // ===== Browser Session Commands (noVNC) =====
    //
    // 設計: ブラウザセッションはシングルトンのため、
    // 特定のクライアントの切断で停止させると他クライアントの画面が消える。
    // そのため明示的な`browser:stop`のみで停止する方針を取り、
    // disconnect時の自動停止は行わない。
    // 最終的なプロセス掃除はSIGTERM/SIGINT時の`browserManager.cleanup()`で行う。

    socket.on("browser:start", async () => {
      try {
        if (!browserManager.isAvailable()) {
          socket.emit("browser:error", {
            message:
              "ブラウザタブ機能は無効です。依存パッケージをインストールしてください。",
          });
          return;
        }

        const session = await browserManager.start();
        // シングルトンブラウザは全クライアントで共有されるため、
        // 他の接続クライアントにも同期する。
        io.emit("browser:started", session);
      } catch (error) {
        socket.emit("browser:error", { message: getErrorMessage(error) });
      }
    });

    socket.on("browser:stop", async data => {
      try {
        await browserManager.stop(data.browserId);
        // 全クライアントにブラウザ停止を通知
        io.emit("browser:stopped", { browserId: data.browserId });
      } catch (error) {
        socket.emit("browser:error", { message: getErrorMessage(error) });
      }
    });

    socket.on("browser:navigate", async data => {
      try {
        const session = await browserManager.navigate(data.url);
        // 全クライアントに通知
        // （セッションを知らないクライアントの初期同期、および
        //  他クライアントにもナビゲーション結果を共有する）
        io.emit("browser:started", session);
      } catch (error) {
        socket.emit("browser:error", { message: getErrorMessage(error) });
      }
    });

    // ===== Beacon Commands =====

    // Beaconメッセージ送信
    socket.on("beacon:send", async (data: { message: string }) => {
      // 入力検証
      if (
        typeof data?.message !== "string" ||
        data.message.trim().length === 0
      ) {
        socket.emit("beacon:error", { error: "メッセージが空です" });
        return;
      }
      activeBeaconSocket = socket;
      try {
        await beaconManager.sendMessage(data.message.trim());
      } catch (error) {
        socket.emit("beacon:error", { error: getErrorMessage(error) });
      }
    });

    // Beacon履歴取得
    socket.on("beacon:history", () => {
      // activeBeaconSocketは設定しない（ストリーミング中の横取り防止）
      const messages = beaconManager.getHistory();
      socket.emit("beacon:history", { messages });
    });

    // Beaconセッション終了
    socket.on("beacon:close", () => {
      beaconManager.closeSession();
    });

    // セッションプレビューのポーリング（1秒間隔）
    const previewInterval = setInterval(() => {
      try {
        const previews = sessionOrchestrator.getAllPreviews();
        if (previews.length > 0) {
          socket.emit("session:previews", previews);
        }
      } catch (err) {
        console.error("[Preview] Error:", getErrorMessage(err));
      }
    }, 1000);

    // 接続時に初回プレビューを送信
    try {
      const initialPreviews = sessionOrchestrator.getAllPreviews();
      if (initialPreviews.length > 0) {
        socket.emit("session:previews", initialPreviews);
      }
    } catch (err) {
      console.error("[Preview] Initial error:", getErrorMessage(err));
    }

    // Cleanup on disconnect
    socket.on("disconnect", () => {
      console.log(`Client disconnected: ${socket.id}`);
      clearInterval(previewInterval);

      forwardHandlers.forEach((handler, event) => {
        sessionOrchestrator.off(event, handler);
      });

      // ブラウザセッションはシングルトンのため、socket切断では停止しない。
      // 明示的なbrowser:stopまたはSIGTERM/SIGINT時のcleanup()で停止する。
    });
  });

  server.listen(port, async () => {
    console.log(`Ark server running on http://localhost:${port}/`);

    // Start Quick Tunnel if enabled
    // 注: enableQuick は --quick コマンドラインオプションによるトンネル起動。
    // 共通関数 startQuickTunnelShared を使用し、activeTunnel を設定する。
    if (enableQuick) {
      console.log("Starting Quick Tunnel...");
      try {
        const url = await startQuickTunnelShared(port);
        await printRemoteAccessInfo(url, tunnelToken!);

        const tunnelCleanup = () => {
          if (activeTunnel) {
            activeTunnel.stop();
          }
        };

        process.on("SIGTERM", tunnelCleanup);
        process.on("SIGINT", tunnelCleanup);
      } catch (error) {
        console.error("Failed to start tunnel:", getErrorMessage(error));
        console.log("Continuing without remote access...");
      }
    }

    // Named Tunnel起動（publicDomainが設定されている場合のみ）
    if (enableRemote && publicDomain) {
      console.log("Starting Cloudflare Tunnel...");
      const tunnel = new TunnelManager({
        localPort: port,
        mode: "named",
        namedTunnelOptions: {
          tunnelName: process.env.ARK_TUNNEL_NAME || "claude-code-ark",
          publicUrl: `https://${publicDomain}`,
        },
      });

      try {
        const publicUrl = await tunnel.start();
        await printRemoteAccessInfo(publicUrl, "");

        tunnel.on("error", error => {
          console.error("Tunnel error:", error.message);
        });

        tunnel.on("close", code => {
          console.log(`Tunnel closed with code ${code}`);
        });

        const tunnelCleanup = () => {
          tunnel.stop();
        };

        process.on("SIGTERM", tunnelCleanup);
        process.on("SIGINT", tunnelCleanup);
      } catch (error) {
        console.error("Failed to start tunnel:", getErrorMessage(error));
        console.log("Continuing without remote access...");
      }
    }

    // トンネル自動復旧: 前回トンネルが有効だった場合に自動起動
    // enableQuick が既にトンネルを起動している場合はスキップ
    if (!activeTunnel) {
      const savedState = loadTunnelState();
      if (savedState) {
        console.log(
          "[Tunnel] 前回のトンネル状態を検出しました。自動復旧を開始します..."
        );
        try {
          const url = await startQuickTunnelShared(savedState.port);
          await printRemoteAccessInfo(url, tunnelToken!);
          console.log("[Tunnel] トンネルの自動復旧に成功しました");
        } catch (error) {
          console.error(
            "[Tunnel] トンネルの自動復旧に失敗:",
            getErrorMessage(error)
          );
          removeTunnelState();
          console.log(
            "[Tunnel] 状態ファイルを削除しました。トンネルなしで継続します"
          );
        }
      }
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("Shutting down...");
    sessionOrchestrator.cleanup();
    beaconManager.cleanup();
    browserManager.cleanup();
    server.close(() => {
      process.exit(0);
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

startServer().catch(console.error);
