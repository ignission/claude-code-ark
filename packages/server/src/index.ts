/**
 * Ark - Server
 *
 * Express server with Socket.IO for real-time communication.
 * Handles git worktree operations and ttyd/tmux-based Claude Code sessions.
 * Supports remote access via Cloudflare Tunnel.
 */

import { exec, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import express from "express";

const execAsync = promisify(exec);

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BridgeSnapshot,
  type ClientToServerEvents,
  MESSAGE_SHORTCUT_MAX_LENGTH,
  type ServerToClientEvents,
  type SessionGridSnapshot,
  type SystemCapabilities,
  type UsageEntry,
  type UsageProgress,
  type UsageReport,
} from "@ark/shared";
import httpProxy from "http-proxy";
import { nanoid } from "nanoid";
import { Server, type Socket } from "socket.io";
import {
  AUQ_EVENT_PATH,
  AUQ_TOKEN_HEADER,
  auqHookBridge,
} from "./lib/auq-hook-bridge.js";
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
import { jsonlTailManager } from "./lib/jsonl-tail-manager.js";
import { DiscoveryError } from "./lib/mcp-oauth/discovery.js";
import { mcpOAuthOrchestrator } from "./lib/mcp-oauth/oauth-flow-orchestrator.js";
import { getProvider, listProviders } from "./lib/mcp-oauth/providers.js";
import { getListeningPorts } from "./lib/port-scanner.js";
import { printRemoteAccessInfo } from "./lib/qrcode.js";
import {
  attachmentDispositionForPath,
  buildAllowlistFromTranscriptFiles,
  contentTypeForPath,
  isFilePathAllowed,
  listTranscriptPathsForWorktree,
  normalizeRequestedFilePath,
} from "./lib/session-file-download.js";
import { sessionOrchestrator } from "./lib/session-orchestrator.js";
import { listSlashCommands } from "./lib/slash-command-scanner.js";
import { SPA_FALLBACK_ROUTE_PATTERN } from "./lib/spa-fallback.js";
import { detectMultiProfileSupported } from "./lib/system.js";
import { tmuxManager } from "./lib/tmux-manager.js";
import { TunnelManager } from "./lib/tunnel.js";
import { UsageCollector } from "./lib/usage-collector.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// パス解決ヘルパを公開。Electron main プロセス (packages/desktop) など、
// `ARK_DATA_DIR` / `ARK_LOGS_DIR` の override を尊重した実体パスを必要とする
// 呼び出し元から参照する。
export {
  getBundledBinDir,
  getDataDir,
  getLogsDir,
  getUploadsDir,
} from "./lib/paths.js";

/**
 * `startServer()` のオプション。
 *
 * - `port`: 待ち受けポート。未指定の場合は `process.env.PORT` または 4001。
 * - `enableRemote` / `enableQuick`: Cloudflare Tunnel 関連スイッチ（既存 CLI 互換）。
 * - `skipPermissions`: Claude CLI を `--dangerously-skip-permissions` 付きで起動する。
 * - `publicDomain`: Named Tunnel の固定ドメイン。CLI では `ARK_PUBLIC_DOMAIN` から取得。
 * - `allowedRepos`: `--repos` オプション相当の許可リスト。
 * - `webStaticDir`: 本番モード時に静的配信する Web ビルド成果物のパス。
 *   未指定時は CLI 起動時の旧パス互換 (`<__dirname>/../../web/dist`) で解決する。
 *   Electron からは `app/web` のような同梱パスを渡す。
 */
export interface StartServerOptions {
  port?: number;
  enableRemote?: boolean;
  enableQuick?: boolean;
  skipPermissions?: boolean;
  publicDomain?: string;
  allowedRepos?: string[];
  webStaticDir?: string;
  /**
   * 将来 Electron から実データ保存ディレクトリ (`app.getPath('userData')`)
   * を渡すための予約オプション。Phase 2 では未使用 (Phase 3 で本実装予定)。
   */
  dataDir?: string;
  /**
   * tmux / ttyd / claude のバイナリ探索 PATH を上書きするための予約オプション。
   * Phase 4 で `.app` 同梱バイナリパスを差し込むのに使う。
   */
  binPaths?: string[];
  /**
   * tunnel auto-recovery を無効化 (ephemeral port 環境用、Electron からは true)。
   *
   * `/tmp/ark-tunnel-state.json` に保存された port は CLI (固定 port) では
   * 有効だが、Electron の ephemeral port では port が毎回変わるため
   * recovery 時に存在しない port を proxy してしまいリモートアクセスが
   * 切れる。Electron からは true を渡して auto-recovery 自体をスキップする。
   */
  disableTunnelAutoRecovery?: boolean;
}

/**
 * サーバー停止用のハンドル。Electron のメインプロセスが `before-quit` で
 * 呼んで Express / Socket.IO を綺麗に閉じるのに使う。
 */
export interface ServerHandle {
  /** 待ち受け中のポート (動的割当時の確認用)。 */
  readonly port: number;
  /** HTTP サーバーを閉じ、間隔タイマーや tmux/ttyd を停止する。 */
  stop: () => Promise<void>;
}

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

/**
 * Ark サーバーを起動し、ハンドルを返す。
 *
 * **重要**: このサーバーは module-level singleton (sessionOrchestrator, beaconManager,
 * browserManager, htmlScreenshotter) を内部で使用するため、**同一プロセスで複数回呼び
 * 出すことはできない**。`stop()` 後に再度 `startServer()` を呼ぶと、破壊済み singleton
 * が再利用され予期しない挙動になる。再起動が必要な場合は別プロセスを起動すること。
 *
 * @param options サーバー設定。詳細は StartServerOptions 参照
 * @returns サーバーハンドル。`stop()` でグレースフルシャットダウン
 */
export async function startServer(
  options: StartServerOptions = {}
): Promise<ServerHandle> {
  const app = express();
  const server = createServer(app);
  const port = options.port ?? (Number(process.env.PORT) || 4001);

  // ===== オプション展開 =====
  // CLI から呼ばれた場合は cli.ts で argv → options に変換済み。
  // Electron 等の埋め込み起動からは TS の型経由で直接渡される。
  //
  // F4 (決定事項 #12): Cloudflare Tunnel 機能は MVP スコープ外。
  // `ARK_FEATURE_TUNNEL === "false"` のとき以下を全て disabled にする:
  //   - `--quick` / `--remote` 起動時の tunnel 自動起動
  //   - `tunnel:start` / `tunnel:stop` Socket.IO イベント
  //   - サーバー起動時の tunnel 自動復旧
  // それ以外 (unset / "true" / 任意値) は enabled (後方互換)。
  const tunnelFeatureEnabled = process.env.ARK_FEATURE_TUNNEL !== "false";
  if (!tunnelFeatureEnabled) {
    console.log(
      "[Feature] ARK_FEATURE_TUNNEL=false: Cloudflare Tunnel disabled"
    );
  }
  const enableRemote = tunnelFeatureEnabled && (options.enableRemote ?? false);
  const enableQuick = tunnelFeatureEnabled && (options.enableQuick ?? false);
  const skipPermissions = options.skipPermissions ?? false;
  const publicDomain = options.publicDomain;
  const allowedRepos = options.allowedRepos ?? [];
  if (allowedRepos.length > 0) {
    console.log(`Allowed repositories: ${allowedRepos.join(", ")}`);
  }

  // クライアントが選択・スキャンしたリポジトリを追跡（Beaconが参照する）
  const knownRepos = new Set<string>(allowedRepos);

  // トンネル状態管理 (startServer のライフタイム内に閉じ込める)
  let activeTunnel: TunnelManager | null = null;
  let tunnelUrl: string | null = null;
  let tunnelToken: string | null = null;

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

  // ===== AskUserQuestion hook 受け口 =====
  // セッション内 claude の PreToolUse hook (auq-hook-bridge が --settings で
  // 注入) から、回答待ち質問の構造化データが POST される。
  // 対話版 claude は AUQ の tool_use を回答確定までJSONLに書かないため、
  // 「質問が表示された」のリアルタイム検出はこの hook が唯一の情報源。
  app.post(AUQ_EVENT_PATH, (req, res) => {
    if (!auqHookBridge.verifyToken(req.headers[AUQ_TOKEN_HEADER])) {
      // 旧 token を保持したままの常駐 claude などからの hook。
      // token は DB 永続化しているので通常は起きないが、調査の手がかりに残す
      console.warn("[AuqHook] 403: token 不一致の hook を拒否しました");
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const body = req.body as {
      cwd?: unknown;
      tool_name?: unknown;
      tool_input?: { questions?: unknown };
    };
    if (
      body?.tool_name !== "AskUserQuestion" ||
      typeof body.cwd !== "string" ||
      !body.tool_input ||
      typeof body.tool_input !== "object"
    ) {
      console.warn(
        `[AuqHook] 400: 想定外 payload (tool=${String(body?.tool_name)})`
      );
      res.status(400).json({ error: "bad request" });
      return;
    }
    const session = sessionOrchestrator.getSessionByWorktree(body.cwd);
    if (!session) {
      // Ark 管理外の claude (ユーザーが手動起動した等) からの hook は無視
      console.log(`[AuqHook] 管理外 cwd からの hook を無視: ${body.cwd}`);
      res.status(204).end();
      return;
    }
    const entry = auqHookBridge.setPending(
      session.id,
      body.tool_input.questions
    );
    io.emit("session:auq", {
      sessionId: session.id,
      at: entry.at,
      questions: entry.questions,
    });
    console.log(`[AuqHook] session:auq 配信: ${session.id} (${body.cwd})`);
    res.status(204).end();
  });

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
    listProfiles: () => {
      // multiProfileSupported が false (Linux 以外 / claude or tmux 未検出)
      // の環境では DB の内容を返さず空配列にする。Beacon 側でこれを見て
      // プロファイル選択 step をスキップできるようにする。
      if (!capabilities.multiProfileSupported) return [];
      // configDir はサーバ内部の filesystem path であり、UI / モデルの
      // 選択には id と name のみで十分。最小権限の観点で公開しない。
      return db.listProfiles().map(p => ({ id: p.id, name: p.name }));
    },
    linkWorktreeProfile: (worktreePath, profileId) => {
      // 無効な profileId / worktreePath で DB に書き込んで UI 側だけ
      // 「成功した」状態になるのを防ぐため、書き込み前に存在確認する。
      // (worktree_profile_links は FK 制約を持たないため明示チェックが必要)
      if (!db.getProfile(profileId)) return false;
      // 1) 実在 directory であること
      // 2) git worktree であること (.git ファイル/ディレクトリの存在で判定)
      //    任意ディレクトリへの link 書き込みを防ぐ trust boundary。
      // 3) (allowedRepos 設定時) repoPath が許可リストに含まれること
      //    socket側 worktree:set-profile と同じ防御を維持する。
      try {
        const stat = fs.statSync(worktreePath);
        if (!stat.isDirectory()) return false;
      } catch {
        return false;
      }
      if (!fs.existsSync(`${worktreePath}/.git`)) return false;
      if (allowedRepos.length > 0) {
        let derivedRepoPath: string | undefined;
        try {
          // execFileSync は shell を介さないため worktreePath のメタ文字
          // (`、$()、;、空白) によるコマンド注入を防げる。
          const stdout = execFileSync(
            "git",
            [
              "-C",
              worktreePath,
              "rev-parse",
              "--path-format=absolute",
              "--git-common-dir",
            ],
            { stdio: ["ignore", "pipe", "ignore"] }
          ).toString();
          const gitCommonDir = stdout.trim();
          derivedRepoPath =
            gitCommonDir.replace(/\/\.git\/?$/, "") || undefined;
        } catch {
          return false;
        }
        if (!derivedRepoPath) return false;
        let inAllowed = allowedRepos.includes(derivedRepoPath);
        if (!inAllowed) {
          try {
            inAllowed = allowedRepos.includes(fs.realpathSync(derivedRepoPath));
          } catch {
            inAllowed = false;
          }
        }
        if (!inAllowed) return false;
      }
      db.setWorktreeProfileLink(worktreePath, profileId);
      // UIの worktreeProfileLinks マップ / プロファイルバッジを更新するため
      // 全クライアントに通知する。worktree:set-profile ハンドラと同じイベント。
      io.emit("worktree:profile-changed", { worktreePath, profileId });
      return true;
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
  // 履歴の再同期。kill による user プロンプト除去 / close→reopen を跨いだ応答確定など、
  // 単発の beacon:message では追従できない変化を全クライアントへ反映する。
  beaconManager.on("beacon:history", data => {
    io.emit("beacon:history", data);
  });
  // Beacon 専用プロファイルの状態変化 (設定変更 / staleProfile 解消) を全クライアントへ反映。
  beaconManager.on("beacon:profile", data => {
    io.emit("beacon:profile", data);
  });

  // MCP OAuth フローの完了/失敗を全クライアントに通知。
  // 認証成功時は Beacon セッションに stale マークを付ける: startSession で
  // 構築済みの mcpServers map / Bearer token は freeze されているため、
  // 次の send 時に idle なら新セッションに作り直して反映する。
  // 進行中ターンを途中で中断しないために close は呼ばない。
  mcpOAuthOrchestrator.on("auth-completed", data => {
    io.emit("mcp:auth-completed", { connectionId: data.connectionId });
    io.emit("mcp:state", buildMcpSnapshot());
    beaconManager.markMcpConfigStale();
  });
  mcpOAuthOrchestrator.on("auth-failed", data => {
    io.emit("mcp:auth-failed", {
      connectionId: data.connectionId,
      message: data.message,
    });
    io.emit("mcp:state", buildMcpSnapshot());
  });
  // refresh 失敗で token が無効化されたとき UI に再認証を促せるよう state を再送 +
  // Beacon にも stale マーク (systemPrompt / allowedTools 内の死んだ connection を消す)
  mcpOAuthOrchestrator.on("token-invalidated", () => {
    io.emit("mcp:state", buildMcpSnapshot());
    beaconManager.markMcpConfigStale();
  });

  /**
   * カタログ (registry) + 全 connection スナップショット。
   * 同 providerId に複数 connection が存在し得る (マルチアカウント)。
   */
  function buildMcpSnapshot(): import("@ark/shared").McpProvidersSnapshot {
    const now = Date.now();
    const catalog = listProviders().map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
    }));
    const dbConnections = db.listMcpServers().map(config => {
      const token = db.getMcpToken(config.id);
      let status: import("@ark/shared").McpAuthStatus;
      if (mcpOAuthOrchestrator.getStatus(config.id)?.status === "pending") {
        status = "authenticating";
      } else if (!token) {
        status = "unauthenticated";
      } else if (token.expiresAt !== null && token.expiresAt <= now) {
        status = "expired";
      } else {
        status = "authenticated";
      }
      return {
        id: config.id,
        providerId: config.providerId,
        label: config.label,
        status,
        ...(token ? { acquiredAt: token.acquiredAt } : {}),
        ...(token?.expiresAt !== null && token?.expiresAt !== undefined
          ? { expiresAt: token.expiresAt }
          : {}),
      };
    });
    // 新規 connection 起動直後は DB に行が無い (token 受領時に作る)。
    // pending flow を別ソースから合成して、UI から「認証中」が見える + paste UI が出るようにする。
    const pending = mcpOAuthOrchestrator.listPendingFlows();
    const dbIds = new Set(dbConnections.map(c => c.id));
    const pendingConnections: import("@ark/shared").McpConnectionInfo[] =
      pending
        .filter(f => !dbIds.has(f.connectionId))
        .map(f => ({
          id: f.connectionId,
          providerId: f.providerId,
          label: f.label,
          status: "authenticating" as const,
        }));
    // 認可 URL を再接続/リロード後にも UI から開けるよう snapshot に同梱する
    const pendingAuthUrls: Record<string, string> = {};
    for (const f of pending) {
      pendingAuthUrls[f.connectionId] = f.authorizationUrl;
    }
    return {
      catalog,
      connections: [...dbConnections, ...pendingConnections],
      pendingAuthUrls,
    };
  }

  /**
   * provider 別のラベル予約カウンタ。
   * mcp:connect ハンドラ内で discovery / DCR の await 前に同期的にインクリメントし、
   * 同 provider に並列で「アカウント追加」されても重複 #N にならないようにする
   * (DB 件数 + orchestrator の pending flow 件数だけでは、await 開始前に複数の
   *  ハンドラが同じ count を読んでしまう競合がある)。
   */
  const mcpLabelReservation = new Map<string, number>();

  /**
   * Quick Tunnelを起動する共通関数
   * tunnel:startハンドラーとサーバー起動時の自動復旧から呼ばれる。
   * @param targetPort トンネル対象のポート番号
   * @returns トンネルURL（認証トークン付き）
   */
  async function startQuickTunnelShared(targetPort: number): Promise<string> {
    if (activeTunnel) {
      if (tunnelUrl) return tunnelUrl;
      throw new Error("Quick Tunnel URL is missing");
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

  // ===== セッション生成ファイル配信API =====

  app.get("/api/session/:sessionId/file", async (req, res) => {
    const { sessionId } = req.params;
    const filePath = req.query.path;
    const mode = req.query.mode === "download" ? "download" : "inline";
    if (typeof filePath !== "string") {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }
    const normalizedPath = normalizeRequestedFilePath(filePath);
    if (!normalizedPath) {
      res.status(400).json({ error: "Invalid path" });
      return;
    }

    const session = sessionOrchestrator.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const transcriptPaths = await listTranscriptPathsForWorktree(
      session.worktreePath,
      session.profileConfigDir ?? null
    );
    if (transcriptPaths.length === 0) {
      res.status(404).json({ error: "Transcript not found" });
      return;
    }

    const allowlist = await buildAllowlistFromTranscriptFiles(transcriptPaths);
    if (!isFilePathAllowed(filePath, allowlist)) {
      res.status(403).json({ error: "File path is not allowed" });
      return;
    }

    // TOCTOU/symlink 対策: O_NOFOLLOW で最終要素が symlink なら open を失敗させ、
    // allowlist 済みパスが symlink 経由で別実体を指す経路を排除する。検証(fstat)も
    // 配信(stream)も同一 fd 経由にし、open 後のパス差し替えの影響を受けないようにする
    // (realpath をパス名で再確認すると fd と乖離するため使わない)。
    // 中間ディレクトリの symlink は辿るが、その作成には FS 書き込み権限が必要で、
    // 本ツールの利用者は既に同等の権限を持つため脅威としては等価。
    let fileHandle: fs.promises.FileHandle;
    try {
      fileHandle = await fs.promises.open(
        normalizedPath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
      );
    } catch {
      // ELOOP(最終要素が symlink) / ENOENT など。存在しない扱いで 404
      res.status(404).json({ error: "File not found" });
      return;
    }
    try {
      const stat = await fileHandle.stat();
      if (!stat.isFile()) {
        await fileHandle.close();
        res.status(400).json({ error: "Path is not a regular file" });
        return;
      }
    } catch {
      await fileHandle.close();
      res.status(404).json({ error: "File not found" });
      return;
    }

    const contentType = contentTypeForPath(normalizedPath);
    res.setHeader("Content-Type", contentType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    // 直接ナビゲーション時のスクリプト実行を無効化 (SVG/HTML の stored XSS 対策)
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Cache-Control", "no-store");
    // HTML 系はインラインでもダウンロード扱いにし、アプリ origin での実行を防ぐ
    const forceAttachment =
      contentType.startsWith("text/html") ||
      contentType.startsWith("application/xhtml");
    if (mode === "download" || forceAttachment) {
      res.setHeader(
        "Content-Disposition",
        attachmentDispositionForPath(normalizedPath)
      );
    }

    // open 済み fd からストリーム配信し、終了/エラー/クライアント切断時に必ず一度だけ
    // fd を閉じる。stream.pipe だけだと配信途中の切断で stream の close が来ず fd が
    // 残るため、res の close でも stream を破棄して fd を解放する。
    const stream = fileHandle.createReadStream({ autoClose: false });
    let handleClosed = false;
    const closeHandleOnce = () => {
      if (handleClosed) return;
      handleClosed = true;
      void fileHandle.close().catch(() => {});
    };
    res.on("close", () => {
      stream.destroy();
      closeHandleOnce();
    });
    stream.on("error", error => {
      console.error("[SessionFile] stream error:", getErrorMessage(error));
      closeHandleOnce();
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to read file" });
      } else {
        res.destroy(error);
      }
    });
    stream.on("close", closeHandleOnce);
    stream.pipe(res);
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

  // ===== Licenses API (F4 Step 8) =====
  //
  // 同梱バイナリ (tmux/ttyd と依存ライブラリ) の LICENSE / NOTICE を返す。
  // 配置元は electron-builder の extraResources で
  // `.app/Contents/Resources/licenses/` に展開される build-bin/collect-licenses.sh
  // の出力。CLI / PM2 起動など packaged でない環境では空配列を返す (=> AboutDialog
  // の「同梱コンポーネント」セクションは「Bundled binaries are not packaged in this
  // build.」のような表示になる)。
  app.get("/api/licenses", async (_req, res) => {
    try {
      // process.resourcesPath は Electron packaged のみ有効。
      // それ以外では undefined / 空文字を許容して空応答する。
      const resourcesPath = (
        process as NodeJS.Process & { resourcesPath?: string }
      ).resourcesPath;
      if (!resourcesPath) {
        res.json({ packages: [], available: false });
        return;
      }
      const licensesDir = path.join(resourcesPath, "licenses");
      if (!fs.existsSync(licensesDir)) {
        res.json({ packages: [], available: false });
        return;
      }

      // INDEX.json (collect-licenses.sh 生成) を優先的に読む
      const indexPath = path.join(licensesDir, "INDEX.json");
      let metadata: {
        packages: Array<{ name: string; version?: string; license?: string }>;
      } = { packages: [] };
      if (fs.existsSync(indexPath)) {
        try {
          metadata = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
        } catch (e) {
          console.warn(
            "[Licenses] INDEX.json parse failed:",
            getErrorMessage(e)
          );
        }
      }

      // 各 package の LICENSE 本文を読み出す。
      // パストラバーサル対策: name は英数 / _-. のみ許容し、
      // resolveしたパスが licensesDir 配下であることを再検証する。
      const safeName = /^[a-zA-Z0-9_.-]+$/;
      const results: Array<{
        name: string;
        version?: string;
        license?: string;
        text: string;
      }> = [];
      for (const pkg of metadata.packages ?? []) {
        if (!pkg.name || !safeName.test(pkg.name)) continue;
        const licensePath = path.join(licensesDir, pkg.name, "LICENSE");
        const resolved = path.resolve(licensePath);
        if (!resolved.startsWith(path.resolve(licensesDir) + path.sep))
          continue;
        let text = "";
        try {
          text = fs.readFileSync(resolved, "utf-8");
        } catch {
          text = "";
        }
        results.push({
          name: pkg.name,
          version: pkg.version,
          license: pkg.license,
          text,
        });
      }
      res.json({ packages: results, available: true });
    } catch (e) {
      console.error("[Licenses API] error:", getErrorMessage(e));
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

  // ===== 静的ファイル配信 =====
  // 配信パスは以下の優先順位で解決する:
  //   1. options.webStaticDir (Electron 同梱版・テスト等から明示)
  //   2. NODE_ENV=production 時のみ、旧 CLI と同じ既定パス
  //      (`packages/server/dist/index.js` から見て `../../web/dist`)
  // どちらにも該当しない開発時 (`pnpm dev:server`) は Vite が別ポートで
  // 配信するため、Express では静的配信を行わない。
  const resolvedStaticDir =
    options.webStaticDir ??
    (process.env.NODE_ENV === "production"
      ? path.resolve(__dirname, "../../web/dist")
      : null);
  if (resolvedStaticDir) {
    app.use(express.static(resolvedStaticDir));

    // Handle client-side routing - serve index.html for all routes
    // 除外: ttyd/proxy/browser (プロキシ領域) と /assets/ (実ファイル要求)。
    // /assets/ の未ヒットに index.html を 200 で返すと、再ビルドの狭間で
    // 旧ハッシュを要求したクライアントに偽アセット (HTML) がキャッシュされ、
    // リロードしても白画面のままになるため、除外して Express 既定の 404 に
    // 落とす (lib/spa-fallback.ts 参照)
    app.get(SPA_FALLBACK_ROUTE_PATTERN, (_req, res) => {
      res.sendFile(path.join(resolvedStaticDir, "index.html"));
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

    // Beacon 専用プロファイルの状態を接続時に送信 (UI 初期化用)
    socket.emit("beacon:profile", beaconManager.getProfileState());

    // 接続時にショートカット一覧を即時送信（クライアント側のキャッシュ初期化用）
    try {
      socket.emit("shortcut:list", db.listMessageShortcuts());
    } catch (e) {
      socket.emit("shortcut:error", { message: getErrorMessage(e) });
    }

    // worktree表示名（カスタム名）の一覧を初期同期。
    // プロファイル機能と独立した汎用機能のため capabilities に依存しない。
    try {
      socket.emit("worktree:display-names", db.listWorktreeDisplayNames());
    } catch (e) {
      console.error(
        "[Socket] failed to emit worktree:display-names:",
        getErrorMessage(e)
      );
    }

    // ===== Session Orchestrator Event Handlers =====
    // sessionOrchestrator のイベントをそのまま Socket.IO クライアントへ転送する
    // 注意: session:list送信やttyd自動復元より前に登録する必要がある
    // （自動復元で発行されるsession:restoredイベントを転送するため）
    const forwardedEvents = [
      "session:created",
      "session:restarted",
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
          // UI 通知だけでなくサーバーログにも残して調査可能にする (Issue #213 ③)
          console.error(
            `[Worktree] 作成に失敗しました (repo=${repoPath}, branch=${branchName}, base=${baseBranch ?? "HEAD"}): ${getErrorMessage(error)}`
          );
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

        const result = await deleteWorktree(repoPath, worktreePath);
        if (result.branchKeptReason) {
          // ブランチが残った場合は調査の起点になるようハンドラー側でも記録する
          console.log(
            `[Worktree] ${result.branchKeptReason} (repo=${repoPath})`
          );
        }

        // 削除成功を通知
        io.emit("worktree:deleted", {
          repoPath,
          worktreeId: deletedWorktreeId,
        });

        const worktrees = await listWorktrees(repoPath);
        io.emit("worktree:list", { repoPath, worktrees });
      } catch (error) {
        // UI 通知だけでなくサーバーログにも残して調査可能にする (Issue #213 ③)
        console.error(
          `[Worktree] 削除に失敗しました (repo=${repoPath}, path=${worktreePath}): ${getErrorMessage(error)}`
        );
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

    // literal テキストのみ送信 (Enter を付けない)。
    // AskUserQuestion の自由入力モードで「1 文字ずつタイプ」する用途。
    // payload は外部入力なので分割代入の前に型検証する (不正 payload での
    // ハンドラ内 throw を防ぐ)
    socket.on("session:send-literal", (data: unknown) => {
      const d = data as { sessionId?: unknown; text?: unknown } | null;
      if (
        !d ||
        typeof d !== "object" ||
        typeof d.sessionId !== "string" ||
        typeof d.text !== "string"
      ) {
        return;
      }
      try {
        tmuxManager.sendLiteral(d.sessionId, d.text);
      } catch (error) {
        socket.emit("session:error", {
          sessionId: d.sessionId,
          error: getErrorMessage(error),
        });
      }
    });

    // ===== JSONL tail（チャットビューの会話データソース） =====
    // socket ごとに購読を管理する。クライアントはアクティブ表示中の
    // セッションだけを購読する想定 (非表示ペインの分は購読しない)。
    const jsonlUnsubscribers = new Map<string, () => void>();

    socket.on("session:jsonl-subscribe", (sessionId: unknown) => {
      if (typeof sessionId !== "string") return;
      if (jsonlUnsubscribers.has(sessionId)) return;
      const session = sessionOrchestrator.getSession(sessionId);
      if (!session) {
        socket.emit("session:error", {
          sessionId,
          error: "Session not found for JSONL tail",
        });
        return;
      }
      const worktreePath = session.worktreePath;
      const configDir = session.profileConfigDir ?? null;

      try {
        // 購読 (offset 確定) と snapshot を原子的に行う。別々に行うと
        // その間の追記行が snapshot にも onLine にも入らず欠落する
        const { snapshot, unsubscribe } =
          jsonlTailManager.subscribeWithSnapshot(worktreePath, configDir, {
            onLine: line => {
              socket.emit("session:jsonl-line", { sessionId, line: line.raw });
            },
            onReset: () => {
              // `/clear` 等で JSONL ファイルが切り替わったタイミング。
              // 空 snapshot を送ることでクライアント側 events が空配列に置換され、
              // 旧会話履歴が UI から消える。新ファイルの行は後続の onLine で届く。
              socket.emit("session:jsonl-snapshot", { sessionId, lines: [] });
            },
          });
        socket.emit("session:jsonl-snapshot", {
          sessionId,
          lines: snapshot.map(l => l.raw),
        });
        jsonlUnsubscribers.set(sessionId, unsubscribe);
      } catch (err) {
        console.error("[JsonlTail] Subscribe error:", getErrorMessage(err));
        return;
      }

      // 回答待ちの AskUserQuestion があれば再送する (リロード/再接続対応)。
      // 既に回答済みかどうかはクライアントが JSONL の解決イベント timestamp
      // と at を比較して判定する
      const pendingAuq = auqHookBridge.getPending(sessionId);
      if (pendingAuq) {
        socket.emit("session:auq", {
          sessionId,
          at: pendingAuq.at,
          questions: pendingAuq.questions,
        });
      }
    });

    socket.on("session:jsonl-unsubscribe", (sessionId: unknown) => {
      if (typeof sessionId !== "string") return;
      const unsub = jsonlUnsubscribers.get(sessionId);
      if (unsub) {
        unsub();
        jsonlUnsubscribers.delete(sessionId);
      }
    });

    // ===== Slash command 候補列挙 =====
    // チャットビュー入力欄の `/` 補完用。worktree + プロファイル configDir の
    // `.claude/commands/*.md` を集約して返す。callback パターン (1 回限り)。
    // ack callback は外部入力なので関数であることを検証してから呼ぶ
    socket.on("slash:list", async (sessionId: unknown, callback: unknown) => {
      if (typeof callback !== "function") return;
      const reply = callback as (response: {
        commands?: unknown;
        error?: string;
      }) => void;
      try {
        if (typeof sessionId !== "string") {
          reply({ error: "Invalid sessionId" });
          return;
        }
        const session = sessionOrchestrator.getSession(sessionId);
        if (!session) {
          reply({ error: "Session not found" });
          return;
        }
        const commands = await listSlashCommands(
          session.worktreePath,
          session.profileConfigDir ?? null
        );
        reply({ commands });
      } catch (err) {
        try {
          reply({ error: getErrorMessage(err) });
        } catch {
          // ack が二重呼び出し等で throw しても落とさない
        }
      }
    });

    // 過去履歴をより多く読み直す。snapshot を limit 付きで再送する。
    // payload は外部入力なので分割代入の前に型検証する
    socket.on("session:jsonl-load-more", (data: unknown) => {
      const d = data as { sessionId?: unknown; limit?: unknown } | null;
      if (!d || typeof d !== "object" || typeof d.sessionId !== "string") {
        return;
      }
      const sessionId = d.sessionId;
      const session = sessionOrchestrator.getSession(sessionId);
      if (!session) return;
      const worktreePath = session.worktreePath;
      const configDir = session.profileConfigDir ?? null;
      try {
        // クライアント指定の limit をそのまま fs 読みに使わないようガード
        const capped = Math.max(1, Math.min(Number(d.limit) || 0, 2000));
        const snapshot = jsonlTailManager.readCurrentSnapshot(
          worktreePath,
          configDir,
          capped
        );
        socket.emit("session:jsonl-snapshot", {
          sessionId,
          lines: snapshot.map(l => l.raw),
        });
      } catch (err) {
        console.error("[JsonlTail] LoadMore error:", getErrorMessage(err));
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
    // F4: ARK_FEATURE_TUNNEL=false の場合は tunnel:start/stop ハンドラを
    // 登録しない (no-op)。クライアント側は tunnel:status で active=false を
    // 受け取って UI を非表示にする想定。

    if (tunnelFeatureEnabled) {
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
    }

    // 新しい接続時に現在のトンネル状態を送信
    // F4: 機能 disable 時は常に active=false を返す (UI 側で remote access の
    // ボタンが非表示になる)。
    const tunnelStatus = tunnelFeatureEnabled
      ? {
          active: !!activeTunnel,
          url: tunnelUrl ?? undefined,
          token: tunnelToken ?? undefined,
        }
      : { active: false };
    console.log(`[Tunnel] Sending status to ${socket.id}:`, {
      active: tunnelStatus.active,
      hasUrl: !!tunnelStatus.url,
      featureEnabled: tunnelFeatureEnabled,
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

    // Beaconセッション終了 (明示的な close)。
    // CLI 会話 (cliSessionId) は破棄しない: DB のチャット履歴は残り再接続時に
    // 再表示されるため、resume を維持して「UI 履歴 = LLM 文脈」を一致させる。
    // 文脈を完全に捨てたい場合は beacon:clear (履歴ごと削除) を使う。
    socket.on("beacon:close", () => {
      beaconManager.closeSession();
    });

    // Beacon応答停止 + セッションリセット (UI の停止ボタン)
    //
    // 名前で意図を明示: 単なる「キャンセル」ではなく、abort + session 破棄を伴う。
    // SDK の AbortController が単発 (一度 abort すると同じ query を再開不可) のため
    // 次の sendMessage は新規 session で起動し、LLM の multi-turn 中間状態は失われる。
    // チャット履歴 (DB / messages) は残るので UI 上の見た目は連続するが、
    // モデル側の文脈は仕切り直しになる。「応答が止まらない」よりは ましという判断。
    //
    // ガード: 進行中の session が無いときの誤送信は no-op にする。idle 状態で
    // closeSession を呼んでもメソッド側の `if (!this.session) return;` で安全だが、
    // ここで明示的に弾くことで「destructive 操作は条件成立時のみ受理」を契約として
    // 表明する (Assertive Programming)。
    //
    // セキュリティ: payload なしで停止できるが、これは既存 beacon:close /
    // beacon:clear と同じ trust model (Beacon は接続クライアント間で共有資源)。
    // Cloudflare Tunnel + token 認証の後ろにある前提で、追加の所有者制御は持たない。
    socket.on("beacon:stop-and-reset", () => {
      // 「仕切り直し」: CLI 会話 (cliSessionId) も破棄し、次の sendMessage は
      // --resume せず新規会話で開始する (モデル側の文脈をリセットする)。
      // hasSession() ガードは付けない: サーバー再起動 / idle close 後は live session が
      // 無くても cliSessionId が settings に残るため、その状態でも破棄する必要がある
      // (closeSession 内で resetConversation を live session の有無に関わらず処理する)。
      beaconManager.closeSession({ resetConversation: true });
    });

    // Beacon履歴クリア（LLMコンテキスト・DB履歴もリセット）
    // 履歴は全接続クライアントで共有されるため、broadcastで他タブ・他端末も同期する
    socket.on("beacon:clear", () => {
      beaconManager.clearHistory();
      io.emit("beacon:history", { messages: [] });
    });

    // Beacon 専用プロファイルの現在状態を要求 (接続後の再取得用)
    socket.on("beacon:get-profile", () => {
      socket.emit("beacon:profile", beaconManager.getProfileState());
    });

    // Beacon 専用プロファイルを設定 (null で既定)。稼働中セッションは即時切替せず
    // staleProfile になる (C-1)。setProfile が broadcastProfile するので個別 emit は不要。
    socket.on("beacon:set-profile", (data: { profileId: string | null }) => {
      const profileId = data?.profileId ?? null;
      const ok = beaconManager.setProfile(profileId);
      if (!ok) {
        socket.emit("beacon:error", {
          error: "指定されたプロファイルが見つかりません",
        });
        // 失敗時は要求元に現状態を返して UI を巻き戻す
        socket.emit("beacon:profile", beaconManager.getProfileState());
      }
    });

    // ===== MCP OAuth Commands (whitelist 形式) =====

    socket.on("mcp:state", () => {
      try {
        socket.emit("mcp:state", buildMcpSnapshot());
      } catch (e) {
        socket.emit("mcp:error", { message: getErrorMessage(e) });
      }
    });

    /**
     * 新しい connection を作成して接続を開始する。
     * - サーバが connection ID を `<providerId>-<nanoid>` で生成
     * - label 省略時は `<provider.name> #<index>` を自動採番
     * - discovery + DCR で client_id を取得 → loopback callback サーバ起動
     */
    socket.on(
      "mcp:connect",
      async ({ providerId, label, connectionId: existingId, requestId }) => {
        try {
          // provider 検証は popup correlation のため inline で行う
          // (共通ヘルパだと requestId を保持できず mcp:error を相関できないため)。
          if (typeof providerId !== "string" || providerId.length === 0) {
            socket.emit("mcp:error", {
              message: "providerId は必須です",
              code: "invalid_provider_id",
              ...(requestId ? { requestId } : {}),
            });
            return;
          }
          const provider = getProvider(providerId);
          if (!provider) {
            socket.emit("mcp:error", {
              message: `サポート対象外のプロバイダ: ${providerId}`,
              code: "unknown_provider",
              providerId,
              ...(requestId ? { requestId } : {}),
            });
            return;
          }

          // connectionId が指定されていれば再認証 (in-place 更新)。指定なら新規作成。
          let connectionId: string;
          let resolvedLabel: string;
          if (typeof existingId === "string" && existingId.length > 0) {
            const existing = db.getMcpServer(existingId);
            if (!existing) {
              socket.emit("mcp:error", {
                message: `connection が見つかりません: ${existingId}`,
                code: "not_found",
              });
              return;
            }
            if (existing.providerId !== provider.id) {
              socket.emit("mcp:error", {
                message: "connection の provider 種別が一致しません",
                code: "provider_mismatch",
              });
              return;
            }
            connectionId = existingId;
            // 再認証時は既存 label を維持 (resolveAccountLabel が後で上書きする可能性あり)
            const trimmed =
              typeof label === "string" && label.trim() ? label.trim() : null;
            resolvedLabel = trimmed ?? existing.label;
            // 古いトークンは破棄しない: ユーザがブラウザ認可を中断/失敗した場合に
            // 既存の有効トークンを失わないように、orchestrator の _processCallback での
            // upsertMcpToken 成功時にのみ上書きする方針。
          } else {
            // 新規 connection ID を生成
            connectionId = `${provider.id}-${nanoid(6)}`;
            const trimmed =
              typeof label === "string" && label.trim() ? label.trim() : null;
            // 連番採番: 競合を避けるため synchronous な予約カウンタで採番する。
            // 初回呼び出し時のみ DB count + pending flow count で初期化し、以降は
            // インクリメントだけ。同 provider への並列 connect でも重複しない。
            const counter = mcpLabelReservation;
            if (!counter.has(provider.id)) {
              const dbCount = db.countMcpServersByProvider(provider.id);
              const pendingCount = mcpOAuthOrchestrator
                .listPendingFlows()
                .filter(f => f.providerId === provider.id).length;
              counter.set(provider.id, dbCount + pendingCount);
            }
            const next = (counter.get(provider.id) ?? 0) + 1;
            counter.set(provider.id, next);
            resolvedLabel = trimmed ?? `${provider.name} #${next}`;
          }

          const result = await mcpOAuthOrchestrator.startFlowForConnection(
            provider,
            connectionId,
            resolvedLabel
          );
          socket.emit("mcp:auth-started", {
            connectionId,
            providerId: provider.id,
            ...(requestId ? { requestId } : {}),
            authorizationUrl: result.authorizationUrl,
          });
          io.emit("mcp:state", buildMcpSnapshot());
        } catch (e) {
          // providerId / requestId を同梱して client 側で popup correlation する。
          // requestId が含まれていれば該当 popup のみ close、無ければ provider の
          // FIFO キューから最古を close する fallback。
          const base: { providerId: string; requestId?: string } = {
            providerId,
            ...(requestId ? { requestId } : {}),
          };
          if (e instanceof DiscoveryError) {
            socket.emit("mcp:error", {
              message: `自動登録に失敗 (${e.stage}): ${e.message}`,
              code: e.stage,
              ...base,
            });
          } else {
            socket.emit("mcp:error", {
              message: getErrorMessage(e),
              ...base,
            });
          }
        }
      }
    );

    /** リモート接続時のフォールバック (URL ペースト) */
    socket.on("mcp:submit-redirect", async ({ redirectUrl }) => {
      try {
        if (
          typeof redirectUrl !== "string" ||
          redirectUrl.trim().length === 0
        ) {
          socket.emit("mcp:error", {
            message: "URL が空です",
            code: "invalid_redirect_url",
          });
          return;
        }
        await mcpOAuthOrchestrator.submitPastedRedirect(redirectUrl.trim());
        // 成功時は orchestrator の auth-completed イベントが mcp:state を再送する
      } catch (e) {
        socket.emit("mcp:error", { message: getErrorMessage(e) });
      }
    });

    socket.on("mcp:disconnect", ({ connectionId }) => {
      try {
        if (typeof connectionId !== "string" || !connectionId) {
          socket.emit("mcp:error", { message: "connectionId は必須です" });
          return;
        }
        // pending な OAuth フローがあれば中断 (loopback server を閉じる)
        mcpOAuthOrchestrator.clearFlow(connectionId);
        db.deleteMcpServer(connectionId);
        // 稼働中 Beacon セッションは旧 mcpServers map (削除済み connection 含む) を
        // 保持しているため stale マーク → 次回 send で idle なら再構成
        beaconManager.markMcpConfigStale();
        io.emit("mcp:state", buildMcpSnapshot());
      } catch (e) {
        socket.emit("mcp:error", { message: getErrorMessage(e) });
      }
    });

    socket.on("mcp:auth-cancel", ({ connectionId }) => {
      try {
        if (typeof connectionId !== "string" || !connectionId) {
          socket.emit("mcp:error", { message: "connectionId は必須です" });
          return;
        }
        mcpOAuthOrchestrator.clearFlow(connectionId);
        io.emit("mcp:state", buildMcpSnapshot());
      } catch (e) {
        socket.emit("mcp:error", { message: getErrorMessage(e) });
      }
    });

    socket.on("mcp:rename", ({ connectionId, label }) => {
      try {
        if (typeof connectionId !== "string" || !connectionId) {
          socket.emit("mcp:error", { message: "connectionId は必須です" });
          return;
        }
        if (typeof label !== "string" || !label.trim()) {
          socket.emit("mcp:error", { message: "label は必須です" });
          return;
        }
        db.updateMcpServer(connectionId, { label: label.trim() });
        io.emit("mcp:state", buildMcpSnapshot());
        // Beacon system prompt が旧 label を保持しているため stale マーク
        // (次の send で idle なら新 label で再構成される)
        beaconManager.markMcpConfigStale();
      } catch (e) {
        socket.emit("mcp:error", { message: getErrorMessage(e) });
      }
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
     * link.worktreePath が session.worktreePath と論理的に一致するか判定する。
     * 新規保存は canonical 形式に揃えているが、symlink 経由で異なる文字列に
     * なっているケースを realpath fallback で救済。
     */
    const worktreePathMatchesSession = (
      linkPath: string,
      sessionWorktreePath: string | undefined
    ): boolean => {
      if (!sessionWorktreePath) return false;
      if (sessionWorktreePath === linkPath) return true;
      try {
        return fs.realpathSync(linkPath) === sessionWorktreePath;
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
        // リポジトリ / worktree 紐付けも同梱送信（リロード時の初期同期用）
        socket.emit("repo:profile-links", db.listRepoProfileLinks());
        socket.emit("worktree:profile-links", db.listWorktreeProfileLinks());
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
        const affectedWorktreePaths = db
          .listWorktreeProfileLinks()
          .filter(link => link.profileId === id)
          .map(link => link.worktreePath);
        for (const sess of sessionOrchestrator.getAllSessions()) {
          const repoMatches = affectedRepoPaths.some(p =>
            repoPathMatchesSession(p, sess.repoPath)
          );
          const wtMatches = affectedWorktreePaths.some(p =>
            worktreePathMatchesSession(p, sess.worktreePath)
          );
          if (repoMatches || wtMatches) {
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
        const affectedWorktreePaths = db
          .listWorktreeProfileLinks()
          .filter(link => link.profileId === id)
          .map(link => link.worktreePath);

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
        }
        for (const worktreePath of affectedWorktreePaths) {
          io.emit("worktree:profile-changed", {
            worktreePath,
            profileId: null,
          });
        }
        // 稼働中セッションを再emit。worktree個別 / repoデフォルト どちらか
        // 一方でも該当すれば staleProfile が変化し得るため両方を見る。
        for (const sess of sessionOrchestrator.getAllSessions()) {
          const repoMatches = affectedRepoPaths.some(p =>
            repoPathMatchesSession(p, sess.repoPath)
          );
          const wtMatches = affectedWorktreePaths.some(p =>
            worktreePathMatchesSession(p, sess.worktreePath)
          );
          if (repoMatches || wtMatches) {
            io.emit("session:updated", sess);
          }
        }
      } catch (e) {
        socket.emit("profile:error", { message: getErrorMessage(e) });
      }
    });

    // ============================================================
    // メッセージショートカット
    // ============================================================
    socket.on("shortcut:list", () => {
      try {
        socket.emit("shortcut:list", db.listMessageShortcuts());
      } catch (e) {
        socket.emit("shortcut:error", { message: getErrorMessage(e) });
      }
    });

    // メッセージショートカットは設計上「全クライアント共通（グローバル）」で、
    // io.emit により接続中の全ソケットへ broadcast する。
    //
    // なぜ per-user / per-session スコープを持たないか:
    // - Ark の運用前提は「単一開発者が自分のローカル / Cloudflare Tunnel 経由で利用」
    //   する開発支援ツール。マルチテナント運用は想定外。
    // - 認可境界は接続レベルの token 認証 (server/lib/auth.ts) が担っている。
    //   トンネル越しのアクセスはトークン必須、ローカル / プライベート IP はスキップ。
    //   つまり「同じ開発者の複数デバイスからの並行接続」しか到達しない。
    // - マルチアカウント機能 (CLAUDE_CONFIG_DIR profile) はあくまで Claude CLI の
    //   プロセス分離 / 認証情報分離が目的で、UI 状態の共有とは独立。
    // - 将来複数ユーザー運用に切り替える場合は、ここに加えて auth.ts のトークン
    //   モデル自体を再設計する必要がある (per-user token / session scope)。
    //
    // 設計書: docs/superpowers/specs/2026-05-03-message-shortcuts-design.md
    socket.on("shortcut:create", payload => {
      if (typeof payload !== "object" || payload === null) {
        socket.emit("shortcut:error", {
          message: "payload が不正です",
          code: "invalid_payload",
        });
        return;
      }
      const { message } = payload as { message?: unknown };
      const trimmedMessage = typeof message === "string" ? message.trim() : "";
      if (
        trimmedMessage.length === 0 ||
        trimmedMessage.length > MESSAGE_SHORTCUT_MAX_LENGTH
      ) {
        socket.emit("shortcut:error", {
          message: `message は 1〜${MESSAGE_SHORTCUT_MAX_LENGTH} 文字で入力してください`,
          code: "invalid_message",
        });
        return;
      }
      try {
        const shortcut = db.createMessageShortcut({
          message: trimmedMessage,
        });
        io.emit("shortcut:created", shortcut);
        io.emit("shortcut:list", db.listMessageShortcuts());
      } catch (e) {
        socket.emit("shortcut:error", { message: getErrorMessage(e) });
      }
    });

    socket.on("shortcut:update", payload => {
      if (typeof payload !== "object" || payload === null) {
        socket.emit("shortcut:error", {
          message: "payload が不正です",
          code: "invalid_payload",
        });
        return;
      }
      const { id, message, sortOrder } = payload as {
        id?: unknown;
        message?: unknown;
        sortOrder?: unknown;
      };
      if (typeof id !== "string" || id.length === 0) {
        socket.emit("shortcut:error", {
          message: "id は必須です",
          code: "invalid_id",
        });
        return;
      }
      const patch: { message?: string; sortOrder?: number } = {};
      if (message !== undefined) {
        const trimmed = typeof message === "string" ? message.trim() : "";
        if (
          trimmed.length === 0 ||
          trimmed.length > MESSAGE_SHORTCUT_MAX_LENGTH
        ) {
          socket.emit("shortcut:error", {
            message: `message は 1〜${MESSAGE_SHORTCUT_MAX_LENGTH} 文字で入力してください`,
            code: "invalid_message",
          });
          return;
        }
        patch.message = trimmed;
      }
      if (sortOrder !== undefined) {
        if (!Number.isInteger(sortOrder)) {
          socket.emit("shortcut:error", {
            message: "sortOrder は整数で指定してください",
            code: "invalid_sort_order",
          });
          return;
        }
        patch.sortOrder = sortOrder as number;
      }
      if (Object.keys(patch).length === 0) {
        socket.emit("shortcut:error", {
          message: "更新する項目を指定してください",
          code: "empty_patch",
        });
        return;
      }
      try {
        const shortcut = db.updateMessageShortcut(id, patch);
        io.emit("shortcut:updated", shortcut);
        io.emit("shortcut:list", db.listMessageShortcuts());
      } catch (e) {
        socket.emit("shortcut:error", { message: getErrorMessage(e) });
      }
    });

    socket.on("shortcut:delete", payload => {
      if (typeof payload !== "object" || payload === null) {
        socket.emit("shortcut:error", {
          message: "payload が不正です",
          code: "invalid_payload",
        });
        return;
      }
      const { id } = payload as { id?: unknown };
      if (typeof id !== "string" || id.length === 0) {
        socket.emit("shortcut:error", {
          message: "id は必須です",
          code: "invalid_id",
        });
        return;
      }
      try {
        db.deleteMessageShortcut(id);
        io.emit("shortcut:deleted", { id });
        io.emit("shortcut:list", db.listMessageShortcuts());
      } catch (e) {
        socket.emit("shortcut:error", { message: getErrorMessage(e) });
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
        // worktree個別の紐付けがあるセッションは resolveProfileForWorktree が
        // worktree側を優先するため、staleProfile が変化しないことを期待する
        // (toManagedSession 内で再評価されるので別途分岐は不要)
        for (const session of sessionOrchestrator.getAllSessions()) {
          if (session.repoPath === canonicalRepoPath) {
            io.emit("session:updated", session);
          }
        }
      } catch (e) {
        socket.emit("profile:error", { message: getErrorMessage(e) });
      }
    });

    socket.on("worktree:set-profile", async ({ worktreePath, profileId }) => {
      if (!capabilities.multiProfileSupported) {
        emitUnsupported();
        return;
      }
      if (typeof worktreePath !== "string" || worktreePath.length === 0) {
        socket.emit("profile:error", {
          message: "worktreePath は必須です",
          code: "invalid_worktree",
        });
        return;
      }
      // ManagedSession.worktreePath は tmux 起動時の引数を保存しているため、
      // 必ずしも canonical ではない。そこで保存も lookup も canonical に揃える。
      let canonicalWorktreePath: string;
      try {
        canonicalWorktreePath = fs.realpathSync(worktreePath);
      } catch {
        socket.emit("profile:error", {
          message: "worktreeパスが解決できません",
          code: "invalid_worktree",
        });
        return;
      }
      try {
        if (!(await isGitRepository(canonicalWorktreePath))) {
          socket.emit("profile:error", {
            message: "worktreeパスがgit working treeではありません",
            code: "invalid_worktree",
          });
          return;
        }

        // 境界検証: worktree が属する repoPath を導出し、allowedRepos に
        // 含まれているか確認。任意 path への書き込みを防ぐ。
        if (allowedRepos.length > 0) {
          let derivedRepoPath: string | undefined;
          try {
            const { stdout } = await execAsync(
              `git -C "${canonicalWorktreePath}" rev-parse --path-format=absolute --git-common-dir`
            );
            const gitCommonDir = stdout.trim();
            derivedRepoPath =
              gitCommonDir.replace(/\/\.git\/?$/, "") || undefined;
          } catch {
            // 導出失敗 → 許可リストありなら拒否
          }
          const allowedMatch = (() => {
            if (!derivedRepoPath) return false;
            if (allowedRepos.includes(derivedRepoPath)) return true;
            try {
              const real = fs.realpathSync(derivedRepoPath);
              return allowedRepos.includes(real);
            } catch {
              return false;
            }
          })();
          if (!allowedMatch) {
            socket.emit("profile:error", {
              message: "リポジトリが許可リストに含まれていません",
              code: "repo_not_allowed",
            });
            return;
          }
        }

        if (profileId === null) {
          db.removeWorktreeProfileLink(canonicalWorktreePath);
        } else {
          db.setWorktreeProfileLink(canonicalWorktreePath, profileId);
        }
        io.emit("worktree:profile-changed", {
          worktreePath: canonicalWorktreePath,
          profileId,
        });

        // 該当worktreeの稼働中セッションを再emit (staleProfile再評価)
        for (const session of sessionOrchestrator.getAllSessions()) {
          if (
            worktreePathMatchesSession(
              canonicalWorktreePath,
              session.worktreePath
            )
          ) {
            io.emit("session:updated", session);
          }
        }
      } catch (e) {
        socket.emit("profile:error", { message: getErrorMessage(e) });
      }
    });

    socket.on(
      "worktree:set-display-name",
      async ({ worktreePath, displayName }) => {
        if (typeof worktreePath !== "string" || worktreePath.length === 0) {
          // エラー専用 channel が無いので silent reject (UI 側は不変表示のまま)
          return;
        }
        // canonical 化して保存と broadcast の key を統一する
        let canonicalWorktreePath: string;
        try {
          canonicalWorktreePath = fs.realpathSync(worktreePath);
        } catch {
          return;
        }
        // git working tree であることを確認 (任意 path への書き込みを防ぐ)
        try {
          if (!(await isGitRepository(canonicalWorktreePath))) return;
        } catch {
          return;
        }

        // 境界検証: allowedRepos が指定されていれば、worktree の親 repo が
        // 含まれているかチェック。worktree:set-profile と同じ防御。
        if (allowedRepos.length > 0) {
          let derivedRepoPath: string | undefined;
          try {
            const { stdout } = await execAsync(
              `git -C "${canonicalWorktreePath}" rev-parse --path-format=absolute --git-common-dir`
            );
            const gitCommonDir = stdout.trim();
            derivedRepoPath =
              gitCommonDir.replace(/\/\.git\/?$/, "") || undefined;
          } catch {
            // 導出失敗 → 許可リストありなら拒否
          }
          const allowedMatch = (() => {
            if (!derivedRepoPath) return false;
            if (allowedRepos.includes(derivedRepoPath)) return true;
            try {
              const real = fs.realpathSync(derivedRepoPath);
              return allowedRepos.includes(real);
            } catch {
              return false;
            }
          })();
          if (!allowedMatch) return;
        }

        // 入力正規化: trim 後に空 / null なら削除、それ以外は upsert
        const trimmed =
          typeof displayName === "string" ? displayName.trim() : "";
        const MAX_LEN = 200;
        try {
          if (trimmed.length === 0) {
            db.removeWorktreeDisplayName(canonicalWorktreePath);
            io.emit("worktree:display-name-changed", {
              worktreePath: canonicalWorktreePath,
              displayName: null,
            });
          } else {
            const value = trimmed.slice(0, MAX_LEN);
            db.setWorktreeDisplayName(canonicalWorktreePath, value);
            io.emit("worktree:display-name-changed", {
              worktreePath: canonicalWorktreePath,
              displayName: value,
            });
          }
        } catch (e) {
          console.error(
            "[Socket] worktree:set-display-name failed:",
            getErrorMessage(e)
          );
        }
      }
    );

    // 再起動は profile 機能に依存しない汎用操作 (restartSession 内の
    // profile 再解決は、profile 未対応環境では env 無しに解決されるだけ)
    // のため、multiProfileSupported では gate しない
    socket.on("session:restart-with-profile", async ({ sessionId }) => {
      try {
        // restartSession 自身が orchestrator 経由で
        // session:created → session:restarted → session:stopped を発行し、
        // forwardedEvents で全接続クライアントに届く (順序は選択追従の要件。
        // session-orchestrator.ts 参照)。ここで重ねて emit すると、別タブが
        // session:stopped を取りこぼした幻シナリオで旧IDが残ったまま新IDが
        // 追加される懸念があるため、追加 emit はしない。
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
      for (const unsub of jsonlUnsubscribers.values()) {
        try {
          unsub();
        } catch (err) {
          console.error("[JsonlTail] Unsubscribe error:", getErrorMessage(err));
        }
      }
      jsonlUnsubscribers.clear();
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

  // server.listen を Promise 化し、リスニング開始まで startServer を解決しない。
  // これにより呼び出し側 (cli.ts / Electron) は「ポートが開いた」状態を確実に
  // 得てから次の処理 (UI 表示等) に進める。
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      resolve();
    });
  });

  console.log(`Ark server running on http://localhost:${port}/`);

  // AskUserQuestion hook 入りの claude 用 settings を書き出し、以降の
  // セッション起動コマンドに --settings として注入する (listen 後 = port 確定後)
  try {
    const hookSettingsPath = auqHookBridge.writeSettingsFile(port);
    tmuxManager.setClaudeSettingsPath(hookSettingsPath);
    console.log(`[AuqHook] settings: ${hookSettingsPath}`);
  } catch (err) {
    // hook が無くてもセッション自体は動く (AUQ カードが出ないだけ) ので
    // 起動は継続する
    console.error("[AuqHook] settings 書き出しに失敗:", getErrorMessage(err));
  }

  // Start Quick Tunnel if enabled
  // 注: enableQuick は --quick コマンドラインオプションによるトンネル起動。
  // 共通関数 startQuickTunnelShared を使用し、activeTunnel を設定する。
  if (enableQuick) {
    console.log("Starting Quick Tunnel...");
    try {
      const url = await startQuickTunnelShared(port);
      // tunnelToken は startQuickTunnelShared の副作用でセットされるが、
      // 型システムからは保証できないので ?? "" で defensive にフォールバックする。
      await printRemoteAccessInfo(url, tunnelToken ?? "");
    } catch (error) {
      console.error("Failed to start tunnel:", getErrorMessage(error));
      console.log("Continuing without remote access...");
    }
  }

  // Named Tunnel起動（publicDomainが設定されている場合のみ）
  // 起動した tunnel はクロージャ経由で stop ハンドルに登録する。
  let namedTunnel: TunnelManager | null = null;
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

      namedTunnel = tunnel;
    } catch (error) {
      console.error("Failed to start tunnel:", getErrorMessage(error));
      console.log("Continuing without remote access...");
    }
  }

  // トンネル自動復旧: 前回トンネルが有効だった場合に自動起動
  // enableQuick が既にトンネルを起動している場合はスキップ
  // ephemeral port 環境 (Electron) では port が毎回変わるため、
  // disableTunnelAutoRecovery=true で自動復旧自体をスキップする。
  // F4: ARK_FEATURE_TUNNEL=false でも skip (機能 disable)。
  if (
    tunnelFeatureEnabled &&
    !activeTunnel &&
    !options.disableTunnelAutoRecovery
  ) {
    const savedState = loadTunnelState();
    if (savedState) {
      console.log(
        "[Tunnel] 前回のトンネル状態を検出しました。自動復旧を開始します..."
      );
      try {
        const url = await startQuickTunnelShared(savedState.port);
        // tunnelToken は startQuickTunnelShared の副作用でセットされるが、
        // 型システムからは保証できないので ?? "" で defensive にフォールバックする。
        await printRemoteAccessInfo(url, tunnelToken ?? "");
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

  // ===== Graceful shutdown =====
  // 内部実装は「停止しか実行しない」。プロセス終了 (`process.exit`) は呼び出し
  // 側 (cli.ts のシグナルハンドラ) の責務とし、Electron 等の埋め込み起動では
  // メインプロセスのライフサイクルに任せる。
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    console.log("Shutting down...");
    clearInterval(fileUploadCleanupInterval);
    clearInterval(bridgeBroadcastInterval);
    clearInterval(gridBroadcastInterval);
    sessionOrchestrator.cleanup();
    beaconManager.cleanup();
    browserManager.cleanup();
    if (activeTunnel) {
      try {
        activeTunnel.stop();
      } catch (error) {
        console.error("[Tunnel] stop に失敗:", getErrorMessage(error));
      }
    }
    if (namedTunnel) {
      try {
        namedTunnel.stop();
      } catch (error) {
        console.error("[Tunnel] named stop に失敗:", getErrorMessage(error));
      }
    }
    try {
      await htmlScreenshotter.shutdown();
    } catch {
      // close 失敗は無視（プロセス終了直前なので）
    }
    await new Promise<void>(resolve => {
      server.close(() => resolve());
    });
  };

  return { port, stop };
}
