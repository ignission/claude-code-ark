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
  BridgeSnapshot,
  ClientToServerEvents,
  ServerToClientEvents,
  SessionGridSnapshot,
  SystemCapabilities,
  UsageEntry,
  UsageProgress,
  UsageReport,
} from "../shared/types.js";
import { authManager } from "./lib/auth.js";
import { beaconManager } from "./lib/beacon-manager.js";
import {
  buildTunnelEntries,
  collectBridgeSessions,
  collectGridSnapshots,
} from "./lib/bridge-collector.js";
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
  FileUploadManagerError,
  fileUploadManager,
} from "./lib/file-upload-manager.js";
import { frontlineManager } from "./lib/frontline-manager.js";
import { listDirectory } from "./lib/fs-browser.js";
import {
  createWorktree,
  deleteWorktree,
  isGitRepository,
  listWorktrees,
  scanRepositories,
} from "./lib/git.js";
import { hostMetrics } from "./lib/host-metrics.js";
import { validateHtmlPath } from "./lib/html-path-validator.js";
import { htmlScreenshotter } from "./lib/html-screenshotter.js";
import { getListeningPorts } from "./lib/port-scanner.js";
import { printRemoteAccessInfo } from "./lib/qrcode.js";
import { sessionOrchestrator } from "./lib/session-orchestrator.js";
import { detectMultiProfileSupported } from "./lib/system.js";
import { tmuxManager } from "./lib/tmux-manager.js";
import { TunnelManager } from "./lib/tunnel.js";
import { UsageCollector } from "./lib/usage-collector.js";

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

/** 進捗バーの幅 (文字数) */
const USAGE_BAR_WIDTH = 24;

/**
 * 0-100 の percent から `█████░░░░░...` 形式のバー文字列を生成する。
 * モバイル幅を考慮して 24 文字幅 (= 約4%/char)。
 */
function renderUsageBar(percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * USAGE_BAR_WIDTH);
  return "█".repeat(filled) + "░".repeat(USAGE_BAR_WIDTH - filled);
}

/**
 * UsageReport をBeaconチャットに表示するMarkdownへ変換する。
 *
 * code block (monospace) でバーを描画してプロファイル間の使用率を視覚的に
 * 比較できるようにする。週次 (Sonnetのみ) は省略 (主要シグナルのみ表示)。
 */
function formatUsageMarkdown(report: UsageReport): string {
  const lines: string[] = ["## Claude Code 使用量サマリ", ""];
  for (const entry of report.entries) {
    lines.push(`### ${entry.profileName}`);
    lines.push(...formatUsageEntryLines(entry, report.collectedAt));
    lines.push("");
  }
  const collected = new Date(report.collectedAt).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
  });
  const okCount = report.entries.filter(e => e.status === "ok").length;
  lines.push(
    `取得時刻: ${collected} (${report.entries.length}件中${okCount}件取得成功)`
  );
  return lines.join("\n");
}

/**
 * Claude /usage の Resets 文字列を `M/D HH:MM` (時刻のみなら `HH:MM`)
 * の 24時間表記に変換する。Ark は JST 前提のため `(Asia/Tokyo)` は除去。
 *
 * 入力例:
 *   `8:20pm (Asia/Tokyo)`         -> `20:20`
 *   `3am (Asia/Tokyo)`            -> `03:00`
 *   `May 4, 1pm (Asia/Tokyo)`     -> `5/4 13:00`
 *   `May 4, 11:30am (Asia/Tokyo)` -> `5/4 11:30`
 *
 * パース不能なものは `(Asia/Tokyo)` だけ除いて返す (フォールバック)。
 */
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function formatResetTimestamp(resets: string, refMs: number): string {
  const stripped = resets.replace(/\s*\(Asia\/Tokyo\)\s*$/, "").trim();

  const dated =
    /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(
      stripped
    );
  if (dated) {
    const monthIdx = MONTH_NAMES.findIndex(
      m => m.toLowerCase() === dated[1].slice(0, 3).toLowerCase()
    );
    if (monthIdx >= 0) {
      const day = Number.parseInt(dated[2], 10);
      const time24 = to24Hour(dated[3], dated[4], dated[5]);
      return `${monthIdx + 1}/${day} ${time24}`;
    }
  }

  // 時刻のみのケース (例 "8:20pm") は日付情報が無いので、refMs 時点の JST
  // 時刻と比較して today/tomorrow を判定し、`M/D HH:MM` 形式に揃える。
  // refMs には report.collectedAt を渡すことで深夜跨ぎ時の整合性を担保。
  const timeOnly = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(stripped);
  if (timeOnly) {
    const time24 = to24Hour(timeOnly[1], timeOnly[2], timeOnly[3]);
    return appendJstDate(time24, refMs);
  }

  return stripped;
}

/**
 * `HH:MM` 形式の時刻に JST の日付を補って `M/D HH:MM` を返す。
 * `refMs` 時点 (collectedAt) の JST と比較し、与えられた時刻が refMs 以後
 * 今日中ならtoday、過ぎていれば tomorrow を採用する (claude /usage が示す
 * reset は常に「次回」)。
 *
 * refMs を引数で受け取ることで、render 時刻ではなく capture 時刻を基準に
 * できる (深夜跨ぎ時の整合性確保)。
 *
 * 注: host TZ に依存しないよう Intl.DateTimeFormat.formatToParts で
 * JST の年/月/日/時/分を直接取得する。`new Date(toLocaleString)` 経由だと
 * UTC コンテナ等で再パース時に host TZ で解釈され翌日判定がズレる。
 */
function appendJstDate(time24: string, refMs: number): string {
  const [hStr, mStr] = time24.split(":");
  const targetH = Number.parseInt(hStr, 10);
  const targetM = Number.parseInt(mStr, 10);
  const targetMinutes = targetH * 60 + targetM;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date(refMs));
  const getPart = (type: string) =>
    Number.parseInt(parts.find(p => p.type === type)?.value ?? "0", 10);
  // hour=24 になるケース (formatToParts の en-US 仕様) を 0 に補正
  const nowH = getPart("hour") % 24;
  const nowM = getPart("minute");
  const nowMinutes = nowH * 60 + nowM;
  const isTomorrow = targetMinutes <= nowMinutes;

  // JST のローカル年/月/日 として扱える Date を構築 (UTC 値で持ちながら
  // 表示時は JST 換算ではなく getMonth/getDate で参照する。
  // ※ Date.UTC で組み立てることで host TZ に依存しない)
  const target = new Date(
    Date.UTC(getPart("year"), getPart("month") - 1, getPart("day"))
  );
  if (isTomorrow) target.setUTCDate(target.getUTCDate() + 1);
  return `${target.getUTCMonth() + 1}/${target.getUTCDate()} ${time24}`;
}

function to24Hour(
  hourStr: string,
  minuteStr: string | undefined,
  ampm: string
): string {
  let h = Number.parseInt(hourStr, 10);
  const m = minuteStr ? Number.parseInt(minuteStr, 10) : 0;
  const isPm = ampm.toLowerCase() === "pm";
  if (h === 12) {
    h = isPm ? 12 : 0;
  } else if (isPm) {
    h += 12;
  }
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

function formatUsageEntryLines(entry: UsageEntry, refMs: number): string[] {
  if (entry.status === "ok" && entry.parsed) {
    const p = entry.parsed;
    const sessionPct = p.sessionPercent.toString().padStart(3, " ");
    const weeklyPct = p.weeklyAllPercent.toString().padStart(3, " ");
    const sessionReset = formatResetTimestamp(p.sessionResets, refMs);
    const weeklyReset = formatResetTimestamp(p.weeklyAllResets, refMs);
    // ラベル / バー / % / リセット時刻 を 1 行に並べる。
    // 「セ」「週」は両方 1 文字 (ほとんどの monospace 環境で同じセル幅で
    // 描画される) なので column 整列が壊れない。
    return [
      "```",
      `セ ${renderUsageBar(p.sessionPercent)} ${sessionPct}% ${sessionReset}`,
      `週 ${renderUsageBar(p.weeklyAllPercent)} ${weeklyPct}% ${weeklyReset}`,
      "```",
    ];
  }
  if (entry.status === "unauthenticated") {
    return ["- 状態: 未認証 (オンボーディング画面)"];
  }
  if (entry.status === "timeout") {
    return ["- 状態: タイムアウト"];
  }
  return [`- 状態: エラー (${entry.errorMessage ?? "詳細不明"})`];
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

  // ===== プロファイル切替機能 (Linux限定) =====
  const capabilities: SystemCapabilities = {
    multiProfileSupported: detectMultiProfileSupported(),
  };
  console.log(
    `[Capabilities] multiProfileSupported = ${capabilities.multiProfileSupported}`
  );

  // ===== Usage取得 =====
  const usageCollector = new UsageCollector();
  // 全クライアント横断で同時実行を1件に制限する
  let usageInFlight = false;

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
    // 10MBファイル（base64化で約13.3MB）のアップロードに対応するためデフォルト1MBを拡張
    maxHttpBufferSize: 15 * 1024 * 1024,
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
        io.emit("worktree:created", { repoPath, worktree });
        const worktrees = await listWorktrees(repoPath);
        io.emit("worktree:list", { repoPath, worktrees });
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
        io.emit("worktree:deleted", {
          repoPath,
          worktreeId: deletedWorktreeId,
        });
        const worktrees = await listWorktrees(repoPath);
        io.emit("worktree:list", { repoPath, worktrees });
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
  // 外部メッセージ (Usage取得結果など) は LLM streaming 中の場合に
  // BeaconManager 側で flush タイミングを制御してから emit する。
  // ここで全クライアントへブロードキャスト (Beacon利用状況に関わらず共有)。
  beaconManager.on("beacon:external-message", message => {
    io.emit("beacon:external-message", message);
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
    if (typeof filePath !== "string") {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }
    const validated = await validateHtmlPath(filePath);
    if (!validated.ok) {
      res.status(validated.status).json({ error: validated.error });
      return;
    }
    try {
      const content = await fs.promises.readFile(validated.path, "utf-8");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Content-Security-Policy", "sandbox allow-scripts");
      res.send(content);
    } catch {
      res.status(404).json({ error: "File not found" });
    }
  });

  // HTML をレンダリングして PNG スクリーンショットを返す
  app.get("/api/html-file/screenshot", async (req, res) => {
    const filePath = req.query.path;
    const fullPageRaw = req.query.fullPage;
    if (typeof filePath !== "string") {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }
    const validated = await validateHtmlPath(filePath);
    if (!validated.ok) {
      res.status(validated.status).json({ error: validated.error });
      return;
    }
    try {
      const png = await htmlScreenshotter.screenshot(validated.path, {
        fullPage: fullPageRaw !== "false",
      });
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "no-store");
      res.send(png);
    } catch (e) {
      console.error("[Screenshot] エラー:", getErrorMessage(e));
      res.status(500).json({ error: getErrorMessage(e) });
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

  // ===== Bridge / Grid 共有サンプリング =====
  // hostMetrics.sample() / capturePane は前回値との差分や時間あたりレートを内部状態で
  // 持つ。クライアントごとに setInterval を回すと、複数クライアントで差分計算の基準が
  // 乱れて不正な値になる。サーバ全体で 1本のループに統一して、購読中のクライアント
  // (Socket.IO room) にブロードキャストする。
  const BRIDGE_ROOM = "bridge:subscribers";
  const GRID_ROOM = "grid:subscribers";

  // 直近のブロードキャスト結果。新規 subscribe 時に即時応答として送る
  // (subscribe ハンドラ内で hostMetrics.sample() を再実行すると、内部の prev*
  // 状態が乱れて次回 broadcast の差分計算が崩れるためキャッシュ参照に絞る)
  let lastBridgeSnapshot: BridgeSnapshot | null = null;
  let lastGridSnapshots: SessionGridSnapshot[] | null = null;

  const broadcastBridgeSnapshot = async () => {
    if (io.sockets.adapter.rooms.get(BRIDGE_ROOM)?.size === undefined) return;
    try {
      const metrics = await hostMetrics.sample();
      const sessions = collectBridgeSessions();
      const tunnels = buildTunnelEntries({ primaryUrl: tunnelUrl });
      const snapshot = {
        metrics,
        sessions,
        tunnels,
        collectedAt: Date.now(),
      };
      lastBridgeSnapshot = snapshot;
      io.to(BRIDGE_ROOM).emit("bridge:snapshot", snapshot);
    } catch (err) {
      console.error("[Bridge] スナップショット失敗:", getErrorMessage(err));
    }
  };

  const broadcastGridSnapshot = () => {
    if (io.sockets.adapter.rooms.get(GRID_ROOM)?.size === undefined) return;
    try {
      const snapshots = collectGridSnapshots();
      lastGridSnapshots = snapshots;
      io.to(GRID_ROOM).emit("session:grid:snapshot", snapshots);
    } catch (err) {
      console.error("[Grid] スナップショット失敗:", getErrorMessage(err));
    }
  };

  // 購読クライアントがいるときだけ実行する (idle 時は no-op)
  const bridgeBroadcastInterval = setInterval(() => {
    void broadcastBridgeSnapshot();
  }, 1000);
  const gridBroadcastInterval = setInterval(() => {
    broadcastGridSnapshot();
  }, 1500);

  io.on("connection", socket => {
    console.log(`Client connected: ${socket.id}`);

    // このソケット接続で選択中のリポジトリパス
    let currentRepoPath: string | null = null;

    // プロファイル切替機能のサポート状況を最初に通知
    socket.emit("system:capabilities", capabilities);

    // Send allowed repos list to client on connection
    socket.emit("repos:list", allowedRepos);

    // Beaconのチャット履歴を接続時に自動送信（クライアント側の取得タイミング問題を回避）
    socket.emit("beacon:history", { messages: beaconManager.getHistory() });

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

    // 既存セッション一覧を送信（リロード時のペイン復元用）。
    // クライアント側で「session:list 受信完了」を正確に判定できるよう、
    // 0件でも必ず emit する。0件で emit しないと、savedId 復元時の
    // dangling cleanup が動かず stale な selectedSessionId が残り続ける。
    const existingSessions = sessionOrchestrator.getAllSessions();
    socket.emit("session:list", existingSessions);

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

    // フォルダ選択ダイアログ用: 指定パス配下のサブディレクトリを返却（コールバックパターン）
    // --repos で許可リポジトリが指定されている場合、フォルダブラウザは
    // allowlistをバイパスして任意のディレクトリを列挙できてしまうため無効化する。
    // 許可リポジトリは `repos:list` で既に提供されているのでブラウザは不要。
    socket.on("fs:list", async (data, callback) => {
      if (allowedRepos.length > 0) {
        callback({
          error:
            "このサーバーでは許可リポジトリのみ利用可能なためフォルダ参照は無効です",
        });
        return;
      }
      try {
        const result = await listDirectory(data?.path);
        callback({ result });
      } catch (error) {
        callback({ error: getErrorMessage(error) });
      }
    });

    socket.on("repo:select", async repoPath => {
      try {
        if (allowedRepos.length > 0 && !allowedRepos.includes(repoPath)) {
          socket.emit("repo:error", {
            repoPath,
            error: "Repository not in allowed list",
          });
          return;
        }

        const isRepo = await isGitRepository(repoPath);
        if (!isRepo) {
          socket.emit("repo:error", {
            repoPath,
            error: "Not a valid git repository",
          });
          return;
        }
        socket.emit("repo:set", repoPath);
        currentRepoPath = repoPath;
        knownRepos.add(repoPath);

        const worktrees = await listWorktrees(repoPath);
        socket.emit("worktree:list", { repoPath, worktrees });
      } catch (error) {
        socket.emit("repo:error", { repoPath, error: getErrorMessage(error) });
      }
    });

    // ===== Worktree Commands =====

    socket.on("worktree:list", async repoPath => {
      try {
        const worktrees = await listWorktrees(repoPath);
        socket.emit("worktree:list", { repoPath, worktrees });
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
          io.emit("worktree:created", { repoPath, worktree });
        } catch (error) {
          socket.emit("worktree:error", getErrorMessage(error));
          return;
        }

        try {
          const worktrees = await listWorktrees(repoPath);
          io.emit("worktree:list", { repoPath, worktrees });
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
        io.emit("worktree:deleted", {
          repoPath,
          worktreeId: deletedWorktreeId,
        });

        const worktrees = await listWorktrees(repoPath);
        io.emit("worktree:list", { repoPath, worktrees });
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
              socket.emit("worktree:deleted", {
                repoPath: result.repoPath,
                worktreeId: deletedWorktreeId,
              });
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
              socket.emit("worktree:list", {
                repoPath: result.repoPath,
                worktrees,
              });
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

    // ===== File Upload Commands =====

    socket.on(
      "file-upload:upload",
      async ({
        sessionId,
        base64Data,
        mimeType,
        originalFilename,
        requestId,
      }) => {
        try {
          // セッションの実在確認（未知のsessionIdで /tmp/ark-files/ 配下にゴミを作らない）
          if (!sessionOrchestrator.getSession(sessionId)) {
            socket.emit("file-upload:error", {
              requestId,
              message: "無効なセッションIDです",
              code: "INVALID_SESSION_ID",
            });
            return;
          }
          const result = await fileUploadManager.saveFile(
            sessionId,
            base64Data,
            mimeType,
            originalFilename
          );
          socket.emit("file-upload:uploaded", { requestId, ...result });
        } catch (error) {
          const code =
            error instanceof FileUploadManagerError ? error.code : undefined;
          socket.emit("file-upload:error", {
            requestId,
            message:
              error instanceof FileUploadManagerError
                ? error.message
                : "ファイルのアップロードに失敗しました",
            code,
          });
        }
      }
    );

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

    // Beacon履歴クリア（LLMコンテキスト・DB履歴もリセット）
    // 履歴は全接続クライアントで共有されるため、broadcastで他タブ・他端末も同期する
    socket.on("beacon:clear", () => {
      beaconManager.clearHistory();
      io.emit("beacon:history", { messages: [] });
    });

    // ===== Frontline Commands =====

    const emitFrontlineError = (
      action: "get_stats" | "get_records" | "save_record",
      error: unknown
    ) => {
      const message = getErrorMessage(error);
      socket.emit("frontline:error", { action, message });
      return message;
    };

    socket.on("frontline:get_stats", () => {
      try {
        const stats = frontlineManager.getStats();
        socket.emit("frontline:stats", stats);
      } catch (error) {
        console.error(
          `[Frontline] get_stats エラー: ${emitFrontlineError("get_stats", error)}`
        );
      }
    });

    socket.on("frontline:get_records", data => {
      try {
        const rawLimit =
          typeof data?.limit === "string"
            ? Number.parseInt(data.limit, 10)
            : data?.limit;
        const limit =
          typeof rawLimit === "number" && Number.isFinite(rawLimit)
            ? Math.min(100, Math.max(1, Math.floor(rawLimit)))
            : 50;
        const records = frontlineManager.getRecords(limit);
        socket.emit("frontline:records", records);
      } catch (error) {
        console.error(
          `[Frontline] get_records エラー: ${emitFrontlineError("get_records", error)}`
        );
      }
    });

    socket.on("frontline:save_record", record => {
      try {
        const result = frontlineManager.saveRecord(record);
        io.emit("frontline:record_saved", result);
      } catch (error) {
        console.error(
          `[Frontline] save_record エラー: ${emitFrontlineError("save_record", error)}`
        );
      }
    });

    // ===== Profile Commands (Linux限定) =====

    /** プロファイル切替機能未サポート時の共通レスポンス */
    const emitUnsupported = () => {
      socket.emit("profile:error", {
        message: "プロファイル切替機能は Linux + claude CLI 必須です",
        code: "unsupported",
      });
    };

    /**
     * link.repoPath が session.repoPath と論理的に一致するか判定する。
     * 新規保存は canonical 形式に揃えているが、旧データ (symlink path で
     * 保存されているもの) が DB に残っているケースを realpath fallback で救済。
     */
    const repoPathMatchesSession = (
      linkPath: string,
      sessionRepoPath: string | undefined
    ): boolean => {
      if (!sessionRepoPath) return false;
      if (sessionRepoPath === linkPath) return true;
      try {
        return fs.realpathSync(linkPath) === sessionRepoPath;
      } catch {
        return false;
      }
    };

    /**
     * configDir のバリデーション。
     * @returns 正規化済み configDir、または null（エラーは socket に emit 済み）
     */
    const validateConfigDir = (configDir: string): string | null => {
      if (typeof configDir !== "string" || configDir.trim().length === 0) {
        socket.emit("profile:error", {
          message: "configDir は必須です",
          code: "invalid_path",
        });
        return null;
      }
      // チルダ展開: 先頭の `~` を $HOME に置換
      let expanded = configDir.trim();
      if (expanded === "~" || expanded.startsWith("~/")) {
        expanded = path.join(os.homedir(), expanded.slice(1));
      }
      // 絶対パス必須
      if (!path.isAbsolute(expanded)) {
        socket.emit("profile:error", {
          message: "configDir は絶対パスで指定してください",
          code: "invalid_path",
        });
        return null;
      }
      // 危険文字チェック (git.ts validatePath と同等)
      if (/[;&|`$(){}[\]<>!"'\\]/.test(expanded)) {
        socket.emit("profile:error", {
          message: "configDir に使用できない文字が含まれています",
          code: "invalid_path",
        });
        return null;
      }
      // 禁止パス: ルート/システムディレクトリ
      const normalized = path.resolve(expanded);
      const forbidden = ["/", "/etc", "/usr", "/var", "/bin", "/sbin"];
      for (const f of forbidden) {
        if (normalized === f || normalized.startsWith(`${f}/`)) {
          socket.emit("profile:error", {
            message: `configDir に禁止パス (${f}) は使用できません`,
            code: "forbidden_path",
          });
          return null;
        }
      }
      return normalized;
    };

    socket.on("profile:list", () => {
      if (!capabilities.multiProfileSupported) {
        emitUnsupported();
        return;
      }
      try {
        socket.emit("profile:list", db.listProfiles());
        // リポジトリ紐付けも同梱送信（リロード時の初期同期用）
        socket.emit("repo:profile-links", db.listRepoProfileLinks());
      } catch (e) {
        socket.emit("profile:error", { message: getErrorMessage(e) });
      }
    });

    socket.on("profile:create", ({ name, configDir }) => {
      if (!capabilities.multiProfileSupported) {
        emitUnsupported();
        return;
      }
      if (typeof name !== "string" || name.trim().length === 0) {
        socket.emit("profile:error", {
          message: "name は必須です",
          code: "invalid_name",
        });
        return;
      }
      const normalized = validateConfigDir(configDir);
      if (!normalized) return;
      try {
        const profile = db.createProfile({
          name: name.trim(),
          configDir: normalized,
        });
        io.emit("profile:created", profile);
        io.emit("profile:list", db.listProfiles());
      } catch (e) {
        socket.emit("profile:error", { message: getErrorMessage(e) });
      }
    });

    socket.on("profile:update", ({ id, name, configDir }) => {
      if (!capabilities.multiProfileSupported) {
        emitUnsupported();
        return;
      }
      if (typeof id !== "string" || id.length === 0) {
        socket.emit("profile:error", {
          message: "id は必須です",
          code: "invalid_id",
        });
        return;
      }
      const patch: { name?: string; configDir?: string } = {};
      if (name !== undefined) {
        if (typeof name !== "string" || name.trim().length === 0) {
          socket.emit("profile:error", {
            message: "name は空にできません",
            code: "invalid_name",
          });
          return;
        }
        patch.name = name.trim();
      }
      if (configDir !== undefined) {
        const normalized = validateConfigDir(configDir);
        if (!normalized) return;
        patch.configDir = normalized;
      }
      try {
        const profile = db.updateProfile(id, patch);
        io.emit("profile:updated", profile);
        io.emit("profile:list", db.listProfiles());

        // configDirが変わった場合、このプロファイルを使っている稼働中セッションは
        // 古いCLAUDE_CONFIG_DIRで動作している → staleProfile を再計算して通知。
        // (nameのみ変更でも稼働セッションには影響しないが、副作用は無害なので
        //  常に再計算する。configDir差分判定はprofileSnapshotsEqualが行う)
        const affectedRepoPaths = db
          .listRepoProfileLinks()
          .filter(link => link.profileId === id)
          .map(link => link.repoPath);
        for (const sess of sessionOrchestrator.getAllSessions()) {
          if (
            affectedRepoPaths.some(p =>
              repoPathMatchesSession(p, sess.repoPath)
            )
          ) {
            io.emit("session:updated", sess);
          }
        }
      } catch (e) {
        socket.emit("profile:error", { message: getErrorMessage(e) });
      }
    });

    socket.on("profile:delete", ({ id }) => {
      if (!capabilities.multiProfileSupported) {
        emitUnsupported();
        return;
      }
      try {
        // 削除前に該当紐付け一覧をスナップショット (CASCADE でDB上は消えるため)
        const affectedRepoPaths = db
          .listRepoProfileLinks()
          .filter(link => link.profileId === id)
          .map(link => link.repoPath);

        db.deleteProfile(id);
        io.emit("profile:deleted", { id });
        io.emit("profile:list", db.listProfiles());

        // 紐付けが切れた各リポジトリについて、クライアントのバッジ + 稼働中
        // セッションの staleProfile を更新する
        for (const repoPath of affectedRepoPaths) {
          io.emit("repo:profile-changed", {
            repoPath,
            profileId: null,
          });
          // そのリポジトリで稼働中のセッションを列挙して staleProfile 再計算
          // (link 側 = 受信値 / 旧 symlink、session 側 = canonical の可能性が
          //  あるため realpath fallback で判定する)
          for (const sess of sessionOrchestrator.getAllSessions()) {
            if (repoPathMatchesSession(repoPath, sess.repoPath)) {
              io.emit("session:updated", sess);
            }
          }
        }
      } catch (e) {
        socket.emit("profile:error", { message: getErrorMessage(e) });
      }
    });

    socket.on("repo:set-profile", async ({ repoPath, profileId }) => {
      if (!capabilities.multiProfileSupported) {
        emitUnsupported();
        return;
      }
      if (typeof repoPath !== "string" || repoPath.length === 0) {
        socket.emit("profile:error", {
          message: "repoPath は必須です",
          code: "invalid_repo",
        });
        return;
      }
      // 全レイヤーで repoPath を canonical (realpath) に統一する。
      // ManagedSession.repoPath は git rev-parse 由来で常に canonical なので、
      // ここを揃えることで client 側の repoProfileLinks Map と
      // session.repoPath を直接比較できる (lookup の不整合を防ぐ)。
      let canonicalRepoPath: string;
      try {
        canonicalRepoPath = fs.realpathSync(repoPath);
      } catch {
        socket.emit("profile:error", {
          message: "リポジトリパスが解決できません",
          code: "invalid_repo",
        });
        return;
      }
      // repo:select と同等の境界検証: 任意のpathへの書き込みを防ぐ。
      // allowedRepos が指定されている場合のみ「元 path / canonical path」
      // どちらかが含まれているかを確認する。
      if (
        allowedRepos.length > 0 &&
        !allowedRepos.includes(repoPath) &&
        !allowedRepos.includes(canonicalRepoPath)
      ) {
        socket.emit("profile:error", {
          message: "リポジトリが許可リストに含まれていません",
          code: "repo_not_allowed",
        });
        return;
      }
      try {
        if (!(await isGitRepository(canonicalRepoPath))) {
          socket.emit("profile:error", {
            message: "リポジトリパスが有効なgitリポジトリではありません",
            code: "invalid_repo",
          });
          return;
        }
        if (profileId === null) {
          db.removeRepoProfileLink(canonicalRepoPath);
        } else {
          db.setRepoProfileLink(canonicalRepoPath, profileId);
        }
        // broadcast も canonical で送る (クライアントの Map キーが canonical で
        // 揃うため、SessionSidebar の lookup と整合する)
        io.emit("repo:profile-changed", {
          repoPath: canonicalRepoPath,
          profileId,
        });

        // 該当 repoPath 配下の稼働中セッションを再emit
        // (session.repoPath は canonical なので canonicalRepoPath で直接比較可能)
        for (const session of sessionOrchestrator.getAllSessions()) {
          if (session.repoPath === canonicalRepoPath) {
            io.emit("session:updated", session);
          }
        }
      } catch (e) {
        socket.emit("profile:error", { message: getErrorMessage(e) });
      }
    });

    socket.on("session:restart-with-profile", async ({ sessionId }) => {
      if (!capabilities.multiProfileSupported) {
        emitUnsupported();
        return;
      }
      try {
        // restartSession 自身が orchestrator.emit("session:stopped") と
        // session:created を発行し、forwardedEvents 経由で全接続クライアントに
        // 旧IDの停止と新IDの作成が届く。ここで重ねて io.emit("session:updated")
        // を流すと、別タブが session:stopped を取りこぼした幻シナリオで旧IDが
        // 残ったまま新IDが追加される懸念があるため、追加 emit はしない。
        await sessionOrchestrator.restartSession(sessionId);
      } catch (e) {
        socket.emit("session:error", {
          sessionId,
          error: getErrorMessage(e),
        });
      }
    });

    socket.on("usage:request", async () => {
      if (!capabilities.multiProfileSupported) {
        socket.emit("usage:error", {
          message: "この環境ではプロファイル機能が使えません",
        });
        return;
      }
      if (usageInFlight) {
        socket.emit("usage:error", {
          message: "Usage取得が既に進行中です",
        });
        return;
      }
      const registeredProfiles = db.listProfiles();
      // デフォルトアカウント (CLAUDE_CONFIG_DIR を設定しないときの ~/.claude) も
      // 集計対象に含める。configDir 空文字 = デフォルト指定として UsageCollector
      // 側で「CLAUDE_CONFIG_DIR を渡さない」分岐を選ぶ。
      // 注: ユーザが ~/.claude を明示プロファイル登録している場合、そのまま
      // CLAUDE_CONFIG_DIR=~/.claude で起動するとオンボーディング画面に詰まるため
      // (UsageCollector のコメント参照)、ここで configDir を空に正規化する。
      // 比較は fs.realpathSync で canonical 化して symlink / bind mount 経由で
      // 同じ実体を指す経路でも検出できるようにする。
      const defaultConfigDir = path.join(os.homedir(), ".claude");
      let canonicalDefaultDir = defaultConfigDir;
      try {
        canonicalDefaultDir = fs.realpathSync(defaultConfigDir);
      } catch {
        // ~/.claude が無い環境ではそのまま使う (どのプロファイルとも一致しない)
      }
      const isDefaultPath = (configDir: string): boolean => {
        if (configDir === defaultConfigDir) return true;
        try {
          return fs.realpathSync(configDir) === canonicalDefaultDir;
        } catch {
          return false;
        }
      };
      const normalizedRegistered = registeredProfiles.map(p =>
        isDefaultPath(p.configDir) ? { ...p, configDir: "" } : p
      );
      const hasDefaultProfile = normalizedRegistered.some(
        p => p.configDir === ""
      );
      const profiles = hasDefaultProfile
        ? normalizedRegistered
        : [
            {
              id: "__default__",
              name: "デフォルト",
              configDir: "",
              createdAt: 0,
              updatedAt: 0,
            },
            ...normalizedRegistered,
          ];

      if (profiles.length === 0) {
        socket.emit("usage:error", {
          message: "プロファイルが登録されていません",
        });
        return;
      }

      usageInFlight = true;
      const onProgress = (data: UsageProgress) => {
        io.emit("usage:progress", data);
      };
      usageCollector.on("usage:progress", onProgress);
      console.log(
        `[UsageCollector] 開始: ${profiles.length} プロファイル (要求元: ${socket.id})`
      );

      // 完了時に Beacon履歴がクリアされていないか判定するため、開始時の
      // 世代をcaptureする。背景処理 (~30s) 中に clearHistory されていたら
      // postExternalMessage は no-op になり、新しい transcript を汚染しない。
      const beaconVersionAtStart = beaconManager.getHistoryVersion();
      try {
        const report = await usageCollector.collect(profiles);
        const markdown = formatUsageMarkdown(report);
        // postExternalMessage は LLM streaming 中なら pending queue に入れ、
        // turn 完了 / セッション close 時に "beacon:external-message" を emit
        // する。emit を購読する beaconManager.on(...) → io.emit が全クライ
        // アントへブロードキャストする (live UI と DB reload の順序を一致)。
        // expectedVersion を渡すことで、開始後に clearHistory された場合は
        // 投稿スキップ (cleared chat 復活防止)。
        // null が返っても client は usage:complete + toast.success で結果を
        // 認識できるので、ここでエラー扱いはしない。
        beaconManager.postExternalMessage(markdown, beaconVersionAtStart);
        io.emit("usage:complete", report);
        console.log(
          `[UsageCollector] 完了: ok=${report.entries.filter(e => e.status === "ok").length}/${report.entries.length}`
        );
      } catch (e) {
        socket.emit("usage:error", { message: getErrorMessage(e) });
      } finally {
        usageCollector.off("usage:progress", onProgress);
        usageInFlight = false;
      }
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

    // ===== Bridge Dashboard =====
    // 購読は Socket.IO room (BRIDGE_ROOM) で管理。
    // 実際のサンプリング/送信はサーバ共有の broadcastBridgeSnapshot が行う。
    // 初回応答はキャッシュ参照のみ (sample() を呼ぶと共有 prev* 状態が乱れる)。
    socket.on("bridge:subscribe", () => {
      socket.join(BRIDGE_ROOM);
      if (lastBridgeSnapshot) {
        socket.emit("bridge:snapshot", lastBridgeSnapshot);
      }
      // キャッシュ未着の場合 (起動直後) は次回 broadcastBridgeSnapshot で受け取る
    });

    socket.on("bridge:unsubscribe", () => {
      socket.leave(BRIDGE_ROOM);
    });

    // ===== Repo Grid View =====
    // 同じく room (GRID_ROOM) で購読管理。Bridge と独立して購読/解除できる。
    socket.on("session:grid:subscribe", () => {
      socket.join(GRID_ROOM);
      if (lastGridSnapshots) {
        socket.emit("session:grid:snapshot", lastGridSnapshots);
      }
    });

    socket.on("session:grid:unsubscribe", () => {
      socket.leave(GRID_ROOM);
    });

    // Cleanup on disconnect
    socket.on("disconnect", () => {
      console.log(`Client disconnected: ${socket.id}`);
      clearInterval(previewInterval);
      // socket.leave は disconnect 時に Socket.IO が自動で行うので room の明示的な
      // クリーンアップは不要

      forwardHandlers.forEach((handler, event) => {
        sessionOrchestrator.off(event, handler);
      });

      // ブラウザセッションはシングルトンのため、socket切断では停止しない。
      // 明示的なbrowser:stopまたはSIGTERM/SIGINT時のcleanup()で停止する。
    });
  });

  // ファイルアップロード: 24h経過ファイルの定期クリーンアップ（1時間ごと）
  const fileUploadCleanupInterval = setInterval(
    async () => {
      try {
        const deleted = await fileUploadManager.cleanup();
        if (deleted > 0) {
          console.log(
            `[FileUpload] 期限切れファイル ${deleted} 件を削除しました`
          );
        }
      } catch (error) {
        console.error("[FileUpload] クリーンアップに失敗:", error);
      }
    },
    60 * 60 * 1000 // 1時間
  );

  // 起動時に1回クリーンアップ
  fileUploadManager.cleanup().catch(error => {
    console.error("[FileUpload] 起動時クリーンアップに失敗:", error);
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
    clearInterval(fileUploadCleanupInterval);
    clearInterval(bridgeBroadcastInterval);
    clearInterval(gridBroadcastInterval);
    sessionOrchestrator.cleanup();
    beaconManager.cleanup();
    browserManager.cleanup();
    htmlScreenshotter.shutdown().catch(() => {
      // close 失敗は無視（プロセス終了直前なので）
    });
    server.close(() => {
      process.exit(0);
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

startServer().catch(console.error);
