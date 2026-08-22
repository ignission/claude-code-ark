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
import {
  type BridgeSnapshot,
  type ClientToServerEvents,
  type DiagramListResponse,
  MESSAGE_SHORTCUT_MAX_LENGTH,
  type ServerToClientEvents,
  type SessionGridSnapshot,
  type SystemCapabilities,
  type UsageProgress,
} from "@ark/shared";
import httpProxy from "http-proxy";
import { Server } from "socket.io";
import {
  AUQ_EVENT_PATH,
  AUQ_TOKEN_HEADER,
  auqHookBridge,
} from "./lib/auq-hook-bridge.js";
import {
  AUQ_SCREEN_CAPTURE_LINES,
  buildAuqScreenContext,
} from "./lib/auq-screen-context.js";
import { authManager } from "./lib/auth.js";
import {
  type BoardMcpDeps,
  BoardMcpServer,
  BoardSessionRegistry,
  listDiagramCommentPaths,
  readDiagramAuthoringGuide,
} from "./lib/board-mcp-server.js";
import { rememberFifoEntry } from "./lib/bounded-fifo-map.js";
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
import {
  appendDiagramCommentMessage,
  resolveDiagramCommentsPath,
} from "./lib/diagram-comments.js";
import {
  createDiagramCommentsSocketHandlers,
  diagramCommentsStore,
  getDiagramCommentsForDoc,
} from "./lib/diagram-comments-handler.js";
import {
  createDiagramDeleteSocketHandler,
  deleteDiagramFile,
  isDiagramTracked,
} from "./lib/diagram-delete.js";
import { describeModelDiff } from "./lib/diagram-diff.js";
import { handleDiagramListRequest, listDiagrams } from "./lib/diagram-list.js";
import type { DiagramModel } from "./lib/diagram-model.js";
import { resolveDiagramPath } from "./lib/diagram-path.js";
import { readDiagram } from "./lib/diagram-reader.js";
import { saveDiagramEdit } from "./lib/diagram-save.js";
import { diagramWatcher } from "./lib/diagram-watcher.js";
import { getErrorMessage } from "./lib/errors.js";
import { readFileFromWorktree } from "./lib/file-manager.js";
import {
  FileUploadManagerError,
  fileUploadManager,
} from "./lib/file-upload-manager.js";
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
import {
  checkManagedWorktree,
  describeWorktreeFailure,
  resolveWorktreeRealPath,
} from "./lib/managed-worktree.js";
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
import { describeTmuxReadFailure } from "./lib/tmux-read-result.js";
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
 * - `diagramAuthoringGuidePath`: `.diagram.html` 作図規約の同梱パス。
 *   Electron packaged 版から明示し、未指定時は server 側の既存解決に委ねる。
 */
export interface StartServerOptions {
  port?: number;
  enableRemote?: boolean;
  enableQuick?: boolean;
  skipPermissions?: boolean;
  publicDomain?: string;
  allowedRepos?: string[];
  webStaticDir?: string;
  diagramAuthoringGuidePath?: string;
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

const MANAGED_WORKTREE_CACHE_TTL_MS = 30_000;

function diagramModelKey(worktreePath: string, relPath: string): string {
  return `${worktreePath}\0${relPath}`;
}

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

/**
 * Ark サーバーを起動し、ハンドルを返す。
 *
 * **重要**: このサーバーは module-level singleton (sessionOrchestrator,
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

  /**
   * resolveManagedWorktreePath の検証成功結果のみを保持するキャッシュ（TTL 30 秒）。
   * diagram:subscribe 等は高頻度に呼ばれるため、同期 git 呼び出しを
   * イベントごとに繰り返してイベントループを塞がないようにする。
   * 失敗結果はキャッシュしない: realpath 正規化により実在しないパスは
   * キャッシュ到達前に弾かれるため、キャッシュは実在パスの git 検証成功結果
   * だけを保持すればよく、これにより未知パスの連投で Map が際限なく肥大化する
   * 問題（負結果キャッシュの弊害）を避ける。
   * さらにサイズ上限（FIFO）で有界化し、実在パスの水平スキャン等でも
   * メモリが無制限に増えないようにする。
   * allowedRepos はサーバーインスタンスごとの設定のため、キャッシュも
   * startServer スコープに置き、インスタンス間で検証結果を共有しない。
   */
  const managedWorktreeCache = new Map<string, { at: number }>();
  const MANAGED_WORKTREE_CACHE_MAX = 256;

  /** 図ごとの、最後に Claude へ通知できたモデル。autosave では更新しない。 */
  const lastNotifiedModels = new Map<string, DiagramModel>();
  const LAST_NOTIFIED_MODELS_MAX = 256;

  function rememberNotifiedModel(key: string, model: DiagramModel): void {
    rememberFifoEntry(lastNotifiedModels, key, model, LAST_NOTIFIED_MODELS_MAX);
  }

  /**
   * 期限切れエントリを掃除し、なおサイズ上限を超えていれば最古（Map の挿入順
   * 先頭）のエントリを削除する。Map は挿入順を保持するため単純な FIFO として
   * 扱える。
   */
  function pruneManagedWorktreeCache(): void {
    const now = Date.now();
    for (const [key, entry] of managedWorktreeCache) {
      if (now - entry.at >= MANAGED_WORKTREE_CACHE_TTL_MS) {
        managedWorktreeCache.delete(key);
      }
    }
    while (managedWorktreeCache.size >= MANAGED_WORKTREE_CACHE_MAX) {
      const oldestKey = managedWorktreeCache.keys().next().value;
      if (oldestKey === undefined) break;
      managedWorktreeCache.delete(oldestKey);
    }
  }

  /**
   * diagram:subscribe / linkWorktreeProfile 共通の worktree 検証（trust boundary）+
   * realpath 正規化。`/repo`・`/repo/.`・`/repo/./.` 等の表記揺れを同一の
   * 実パスへ畳み込み、DB 主キー・キャッシュキー・room 名を worktree ごとに
   * 一意化する（正規化しないと表記違いで別 DB 行が作られ、行単位のサイズ上限
   * を迂回して肥大化させ得る）。
   * (0) 入力長の上限チェック（異常に長い文字列での realpathSync 呼び出しを防ぐ）
   * (1) realpath で正規化する。実在しないパスはここで弾かれる（キャッシュにも
   *     到達しない = 未知パスの連投によるキャッシュ肥大化を防ぐ）
   * (2) git worktree であること（`.git` ファイル/ディレクトリの存在で判定）
   *     任意ディレクトリへの読み書きを防ぐ
   * (3) allowedRepos 設定時は、そこから導出した repoPath が許可リストに
   *     含まれること（socket 側 worktree:set-profile と同じ防御を維持する）
   * 戻り値: 検証成功時は正規化済みの実パス、失敗時は null。
   */
  function resolveManagedWorktreeDetailed(
    worktreePath: string
  ): { ok: true; path: string } | { ok: false; reason: string } {
    const resolved = resolveWorktreeRealPath(worktreePath);
    if (!resolved.ok) {
      return { ok: false, reason: describeWorktreeFailure(resolved.failure) };
    }
    const real = resolved.realPath;
    const cached = managedWorktreeCache.get(real);
    if (cached && Date.now() - cached.at < MANAGED_WORKTREE_CACHE_TTL_MS) {
      return { ok: true, path: real };
    }
    const checked = checkManagedWorktree(real, { allowedRepos });
    if (!checked.ok) {
      return { ok: false, reason: describeWorktreeFailure(checked.failure) };
    }
    pruneManagedWorktreeCache();
    managedWorktreeCache.set(real, { at: Date.now() });
    return { ok: true, path: real };
  }

  function resolveManagedWorktreePath(worktreePath: string): string | null {
    const result = resolveManagedWorktreeDetailed(worktreePath);
    return result.ok ? result.path : null;
  }

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
    // 直前の会話文脈は AUQ 解決まで JSONL に書かれないため、hook 受信の
    // この瞬間 (質問ボックス描画前後) の tmux 画面を verbatim で添付する。
    // 解釈はしない (auq-screen-context.ts の原則境界コメント参照)
    // capture に失敗しても AUQ カード自体は出す (画面添付だけ欠ける)。
    // 「値が無い」のではなく tmux が失敗したことを、理由付きで残す (#393)
    const captured = tmuxManager.capturePane(
      session.id,
      AUQ_SCREEN_CAPTURE_LINES
    );
    if (!captured.ok) {
      console.warn(
        `[AuqHook] ${session.id}: 直前の画面を取得できません (${describeTmuxReadFailure(captured.failure)})`
      );
    }
    const screen = buildAuqScreenContext(captured.ok ? captured.value : null);
    const entry = auqHookBridge.setPending(
      session.id,
      body.tool_input.questions,
      screen
    );
    // screen は端末の生画面なので、コマンド出力・パス・token 等を含みうる。
    // 全 socket への broadcast はやめ、当該セッションの購読者だけへ送る
    io.to(sessionRoom(session.id)).emit("session:auq", {
      sessionId: session.id,
      at: entry.at,
      questions: entry.questions,
      screen: entry.screen,
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

  // ===== セッションボード MCP サーバー (board_open ツール) =====
  // 1 プロセスに 1 インスタンスで良く、worktree ごとの区別は
  // BoardSessionRegistry の bearer token 解決で行う（セッション起動時の
  // register/unregister は SessionOrchestrator 側に配線済み）。
  // ここでは BoardMcpDeps の実体（socket 通知）と起動のみ行う。
  // 旧 board_write（Excalidraw scene への直接書き込み）用の getBoardScene /
  // saveBoardScene / notifyUpdated は撤去済み（B-1）。openDiagram のみ残る。
  const boardRegistry = new BoardSessionRegistry();
  const boardMcp = new BoardMcpServer();
  const boardDeps: BoardMcpDeps = {
    readAuthoringGuide: () =>
      readDiagramAuthoringGuide(undefined, options.diagramAuthoringGuidePath),
    async listDiagramPaths(worktreePath) {
      const resolved = resolveManagedWorktreeDetailed(worktreePath);
      if (!resolved.ok) {
        throw new Error(`worktree を解決できません: ${resolved.reason}`);
      }
      return listDiagramCommentPaths(resolved.path);
    },
    async getDiagramComments(worktreePath, relPath) {
      const resolved = resolveManagedWorktreeDetailed(worktreePath);
      if (!resolved.ok) {
        return {
          ok: false,
          code: "FORBIDDEN",
          error: `worktree を解決できません: ${resolved.reason}`,
        };
      }
      return getDiagramCommentsForDoc(resolved.path, relPath);
    },
    async replyDiagramComment(worktreePath, relPath, threadId, input) {
      const resolved = resolveManagedWorktreeDetailed(worktreePath);
      if (!resolved.ok) {
        return {
          ok: false,
          code: "FORBIDDEN",
          error: `worktree を解決できません: ${resolved.reason}`,
        };
      }
      return appendDiagramCommentMessage(
        resolved.path,
        relPath,
        threadId,
        input
      );
    },
    async openDiagram(worktreePath, relPath) {
      const resolved = resolveManagedWorktreeDetailed(worktreePath);
      if (!resolved.ok) {
        return {
          ok: false,
          error: `worktree を解決できません: ${resolved.reason}`,
        };
      }
      // セッション検索は引数の worktreePath（registry 登録時の生パス）で行う。
      // tmuxManager / DB のセッション行は session:start が受け取った生パスの
      // ままキーになっており、getSessionByWorktree は文字列完全一致でしか
      // ヒットしない。resolved.path（realpath 正規化済み）で引いてしまうと、
      // realpath ≠ 生パスの環境（symlink を含む home 等）では常に
      // 「セッションが見つかりません」になり、board_open の唯一の入口が
      // 死んでしまう。ファイル読み書きと DB のボードキーは逆に realpath が
      // 規約（commit 0e547d0 で確定）なので、下の readDiagram には
      // resolved.path を渡す ― この2つを取り違えないこと。
      const session = sessionOrchestrator.getSessionByWorktree(worktreePath);
      if (!session) {
        return {
          ok: false,
          error: "この worktree のセッションが見つかりません",
        };
      }
      // Claude に「開いた」と嘘をつかないよう、diagram:open を emit する前に
      // 実際に readDiagram で読めることを確認する（/api/diagram と同じ検証
      // = 403 パス不正・worktree外・symlink脱出 / 404 不在 / 422 モデルブロック
      // 無し・壊れている、を理由付きで弾く）。ファイル読み込みは realpath
      // （resolved.path）を使う規約なのでこちらはそのまま。
      const result = await readDiagram(resolved.path, relPath);
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      io.emit("diagram:open", { sessionId: session.id, relPath });
      // 「セッションで最後に開いた図」を永続化する。リロード後も
      // session:list 経由で lastDiagramPath を受け取り、クライアントが
      // 右ペインの図タブを復元できるようにするため。
      db.updateSessionLastDiagram(session.id, relPath);
      return { ok: true };
    },
  };
  // 前回 bind したポートに再度 bind し直すことで、稼働中セッションの
  // mcp-config の url を維持する。
  // 1〜65535 の整数以外（範囲外・非整数・NaN・不正値混入）は無視して ephemeral 起動にフォールバックする
  // （httpServer.listen() への不正値渡しによる例外を防ぐ）。
  const savedBoardMcpPort = db.getSetting("board_mcp_port");
  const boardMcpPort =
    typeof savedBoardMcpPort === "number" &&
    Number.isInteger(savedBoardMcpPort) &&
    savedBoardMcpPort >= 1 &&
    savedBoardMcpPort <= 65535
      ? savedBoardMcpPort
      : undefined;
  await boardMcp.start(boardDeps, boardRegistry, { port: boardMcpPort });
  // 実際に bind できたポートを settings に保存する（次回起動で同じポートに bind し直すため）。
  const boundBoardMcpPort = boardMcp.getPort();
  if (boundBoardMcpPort) {
    db.setSetting("board_mcp_port", boundBoardMcpPort);
  }
  // 会話セッション起動時に per-session token/mcp-config を注入できるよう、
  // SessionOrchestrator へ boardMcp/boardRegistry を配線する (Task 4)。
  sessionOrchestrator.setBoardMcp(boardMcp, boardRegistry);

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

  // ===== 図解キャンバス配信API =====

  app.get("/api/diagram", async (req, res) => {
    const worktreePath = req.query.worktreePath;
    const relPath = req.query.path;
    if (typeof worktreePath !== "string" || typeof relPath !== "string") {
      res.status(400).json({ error: "worktreePath と path が必要です" });
      return;
    }
    const resolved = resolveManagedWorktreePath(worktreePath);
    if (!resolved) {
      res.status(403).json({ error: "管理外の worktree です" });
      return;
    }
    const result = await readDiagram(resolved, relPath);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    // 初回配信時のモデルは Claude が生成済みの状態として通知 baseline にする。
    // 既存値は未通知の autosave 差分を含み得るため上書きしない。
    const modelKey = diagramModelKey(resolved, relPath);
    if (!lastNotifiedModels.has(modelKey)) {
      rememberNotifiedModel(modelKey, result.model);
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // 本文に meta CSP を注入済み。クライアントは srcDoc で描画するため
    // ヘッダの CSP は当該文書に適用されない（判断4.2.1 の実測）
    res.setHeader("Cache-Control", "no-store");
    res.send(result.html);
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
  /**
   * セッション単位の配信先。JSONL を購読しているクライアント
   * （= そのセッションの会話ビューを開いている画面）だけが入る。
   * 端末画面のような機微を含む配信を全 socket へ broadcast しないため。
   */
  const sessionRoom = (sessionId: string) => `session:${sessionId}`;

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
          .then(repos => socket.emit("repos:scanned", repos))
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

        // キャッシュキーは realpath 正規化済みパス。生パスで delete しても
        // ヒットしないため、worktree が消える前に realpath を解決してその
        // キーを消す（消し損ねると同じ realpath に新 worktree が作られた際、
        // TTL 切れまで stale な検証結果を返し得る）。
        const cachedReal = resolveManagedWorktreePath(worktreePath);
        const result = await deleteWorktree(repoPath, worktreePath);
        if (cachedReal) managedWorktreeCache.delete(cachedReal);
        managedWorktreeCache.delete(worktreePath);
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
              managedWorktreeCache.delete(result.worktreePath);
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

    // ===== 図解キャンバス（board_open による表示 + 更新監視） =====
    const diagramUnsubs = new Map<string, () => void>();
    // autosave の自己書き込みで、この socket の iframe だけを再読込しない。
    // O_TRUNC と本文書き込みが別々に見える環境もあるため短い期間で抑制する。
    const suppressedDiagramUpdates = new Map<string, NodeJS.Timeout>();

    const suppressNextDiagramUpdate = (absPath: string) => {
      const previous = suppressedDiagramUpdates.get(absPath);
      if (previous) clearTimeout(previous);
      const timeout = setTimeout(() => {
        suppressedDiagramUpdates.delete(absPath);
      }, 2_500);
      suppressedDiagramUpdates.set(absPath, timeout);
    };

    socket.on("diagram:list", (data: unknown, callback: unknown) => {
      if (typeof callback !== "function") return;
      const reply = callback as (response: DiagramListResponse) => void;

      void handleDiagramListRequest(
        { resolveManagedWorktreePath, listDiagrams },
        data
      ).then(response => {
        try {
          reply(response);
        } catch {
          // ACK callback はクライアント由来。throw を server process へ伝播させない。
        }
      });
    });

    socket.on(
      "diagram:delete",
      createDiagramDeleteSocketHandler({
        getSession: sessionId => sessionOrchestrator.getSession(sessionId),
        resolveManagedWorktreePath,
        isDiagramTracked,
        deleteDiagramFile,
        clearSessionLastDiagramIfMatches: (sessionId, relPath) => {
          try {
            return db.clearSessionLastDiagramIfMatches(sessionId, relPath);
          } catch (error) {
            console.error(
              "[Diagram] last_diagram_path の消去に失敗しました:",
              getErrorMessage(error)
            );
            throw error;
          }
        },
        onSessionCleared: sessionId => {
          const session = sessionOrchestrator.getSession(sessionId);
          if (session) io.emit("session:updated", session);
        },
        onDeleted: data => {
          const session = sessionOrchestrator.getSession(data.sessionId);
          const resolved = session
            ? resolveManagedWorktreePath(session.worktreePath)
            : null;
          if (resolved) {
            lastNotifiedModels.delete(diagramModelKey(resolved, data.relPath));
          }
          io.emit("diagram:deleted", data);
        },
      })
    );

    const diagramCommentsHandlers = createDiagramCommentsSocketHandlers({
      getSession: sessionId => sessionOrchestrator.getSession(sessionId),
      resolveManagedWorktreePath,
      sendMessage: (sessionId, message) =>
        sessionOrchestrator.sendMessage(sessionId, message),
      ...diagramCommentsStore,
    });
    socket.on("diagram:comments:get", diagramCommentsHandlers.get);
    socket.on("diagram:comment:create", diagramCommentsHandlers.create);
    socket.on("diagram:comment:reply", diagramCommentsHandlers.reply);
    socket.on("diagram:comment:resolve", diagramCommentsHandlers.resolve);
    socket.on("diagram:comment:delete", diagramCommentsHandlers.delete);
    socket.on("diagram:comment:send", diagramCommentsHandlers.send);

    socket.on("diagram:subscribe", (data: unknown) => {
      // payload は外部入力。分割代入前に型を検証しないと、引数なし emit や
      // null/不正形状の payload でハンドラ内 throw → プロセスごと落ちる
      // （socket.io の同期ハンドラ内例外は uncaughtException になる）。
      const d = data as { worktreePath?: unknown; relPath?: unknown } | null;
      if (
        !d ||
        typeof d !== "object" ||
        typeof d.worktreePath !== "string" ||
        typeof d.relPath !== "string"
      ) {
        return;
      }
      const { worktreePath, relPath } = d;
      const resolved = resolveManagedWorktreePath(worktreePath);
      if (!resolved) return;
      // 空白連結だと path や relPath に空白がある場合に別購読と衝突するため
      // JSON 配列表現をキーにする（jsonl-tail-manager.ts の keyOf と同じ方針）
      const key = JSON.stringify([resolved, relPath]);
      if (diagramUnsubs.has(key)) return;

      // watcher を張る条件は「パスが worktree の DIAGRAM_DIR 配下に収まって
      // いるか」だけにする（resolveDiagramPath は文字列上の解決のみで FS I/O
      // を行わないため同期）。ファイルが読めるか（403/404/422）を条件にすると、
      // DiagramWatcher は「ファイルが未作成でも polling が後から拾う」設計
      // なのに、Claude が Edit で図を書き換えている最中（モデルブロック未
      // 書き込み等で readDiagram が一時的に失敗する）にタブを開き直すと
      // watcher が張られないまま終わり、書き込み完了後も diagram:updated が
      // 届かなくなる。DiagramPane の購読はマウント時 1 回きりで再試行もない
      // ため、タブを閉じて開き直すまで永久にエラー表示のままになってしまう。
      // 内容が読めるかどうかの判定は配信時 (/api/diagram) の責務にする。
      const pathResolved = resolveDiagramPath(resolved, relPath);
      if (!pathResolved.ok) return; // パス自体が不正 (403 相当) なら購読しない

      const offDiagram = diagramWatcher.subscribe(pathResolved.absPath, () => {
        if (suppressedDiagramUpdates.has(pathResolved.absPath)) return;
        // クライアントへは購読要求で送られてきた worktreePath（生パス）を
        // そのままエコーバックする。サーバー内部の購読キー・ファイル解決は
        // realpath（resolved）で行うが、クライアント（DiagramPane）は
        // session:start に渡した生パスしか知らないため、resolved を返すと
        // realpath ≠ 生パスの環境で一致判定 (data.worktreePath ===
        // worktreePath) が常に false になり、fs.watch による再投影が
        // エラーも出さず無言で機能しなくなる。
        socket.emit("diagram:updated", { worktreePath, relPath });
      });
      const commentsResolved = resolveDiagramCommentsPath(resolved, relPath);
      const offComments = commentsResolved.ok
        ? diagramWatcher.subscribe(commentsResolved.commentsAbsPath, () => {
            socket.emit("diagram:comments-updated", {
              worktreePath,
              relPath,
            });
          })
        : null;
      diagramUnsubs.set(key, () => {
        offDiagram();
        offComments?.();
      });
    });

    socket.on("diagram:unsubscribe", (data: unknown) => {
      // subscribe と同じく、外部入力を分割代入する前に型を検証する
      const d = data as { worktreePath?: unknown; relPath?: unknown } | null;
      if (
        !d ||
        typeof d !== "object" ||
        typeof d.worktreePath !== "string" ||
        typeof d.relPath !== "string"
      ) {
        return;
      }
      const { worktreePath, relPath } = d;
      const resolved = resolveManagedWorktreePath(worktreePath);
      if (!resolved) return;
      // 空白連結だと path や relPath に空白がある場合に別購読と衝突するため
      // JSON 配列表現をキーにする（jsonl-tail-manager.ts の keyOf と同じ方針）
      const key = JSON.stringify([resolved, relPath]);
      diagramUnsubs.get(key)?.();
      diagramUnsubs.delete(key);
    });

    /** 図の編集結果をファイルへ保存する。会話への通知と baseline 更新はしない。 */
    socket.on("diagram:autosave", async (data: unknown, callback: unknown) => {
      if (typeof callback !== "function") return;
      const reply = callback as (response: {
        ok: boolean;
        error?: string;
      }) => void;
      const d = data as {
        sessionId?: unknown;
        worktreePath?: unknown;
        relPath?: unknown;
        model?: unknown;
        html?: unknown;
      } | null;
      if (
        !d ||
        typeof d !== "object" ||
        typeof d.sessionId !== "string" ||
        typeof d.worktreePath !== "string" ||
        typeof d.relPath !== "string" ||
        typeof d.html !== "string"
      ) {
        reply({ ok: false, error: "不正なリクエストです" });
        return;
      }

      try {
        const resolved = resolveManagedWorktreePath(d.worktreePath);
        if (!resolved) {
          reply({ ok: false, error: "worktree を解決できません" });
          return;
        }
        const saved = await saveDiagramEdit(
          resolved,
          d.relPath,
          d.model,
          d.html,
          suppressNextDiagramUpdate
        );
        if (!saved.ok) {
          reply(saved);
          return;
        }
        // 未登録時だけ保存前モデルを初期 baseline にする。以後の autosave は
        // baseline を進めず、明示 submit まで未通知差分を蓄積する。
        const modelKey = diagramModelKey(resolved, d.relPath);
        if (!lastNotifiedModels.has(modelKey)) {
          rememberNotifiedModel(modelKey, saved.previousModel);
        }
        reply({ ok: true });
      } catch (error) {
        reply({ ok: false, error: getErrorMessage(error) });
      }
    });

    /** 図を保存し、最後に通知したモデルからの意味差分を会話へ還流する。 */
    socket.on("diagram:submit", async (data: unknown, callback: unknown) => {
      if (typeof callback !== "function") return;
      const reply = callback as (response: {
        ok: boolean;
        sent?: string[];
        error?: string;
      }) => void;
      const d = data as {
        sessionId?: unknown;
        worktreePath?: unknown;
        relPath?: unknown;
        model?: unknown;
        html?: unknown;
      } | null;
      if (
        !d ||
        typeof d !== "object" ||
        typeof d.sessionId !== "string" ||
        typeof d.worktreePath !== "string" ||
        typeof d.relPath !== "string" ||
        typeof d.html !== "string"
      ) {
        reply({ ok: false, error: "不正なリクエストです" });
        return;
      }

      try {
        const resolved = resolveManagedWorktreePath(d.worktreePath);
        if (!resolved) {
          reply({ ok: false, error: "worktree を解決できません" });
          return;
        }
        const saved = await saveDiagramEdit(
          resolved,
          d.relPath,
          d.model,
          d.html
        );
        if (!saved.ok) {
          reply(saved);
          return;
        }

        const modelKey = diagramModelKey(resolved, d.relPath);
        const baseline =
          lastNotifiedModels.get(modelKey) ?? saved.previousModel;
        const sent = describeModelDiff(baseline, saved.savedModel);
        if (sent.length > 0) {
          const message = `図を編集しました（${d.relPath}）:\n${sent
            .map(line => `- ${line}`)
            .join("\n")}`;
          try {
            sessionOrchestrator.sendMessage(d.sessionId, message);
          } catch (error) {
            console.error(
              "[Diagram] sendMessage failed:",
              getErrorMessage(error)
            );
            reply({
              ok: false,
              error: `図は保存しましたが、セッションへの通知に失敗しました: ${getErrorMessage(error)}`,
            });
            return;
          }
        }

        // 通知が成功した（または意味差分が無かった）時だけ baseline を進める。
        rememberNotifiedModel(modelKey, saved.savedModel);
        reply({ ok: true, sent });
      } catch (error) {
        reply({ ok: false, error: getErrorMessage(error) });
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
        // このセッションの会話ビューを開いている socket として登録する
        // （session:auq の配信先。broadcast による端末画面の漏洩を防ぐ）
        socket.join(sessionRoom(sessionId));
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
          screen: pendingAuq.screen,
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
      socket.leave(sessionRoom(sessionId));
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
        const result = tmuxManager.getBuffer(sessionId);
        if (result.ok) {
          callback(
            result.value
              ? { text: result.value }
              : { error: "バッファが空です" }
          );
          return;
        }
        // 「バッファが無い」と tmux の失敗を区別して返す (#393)
        switch (result.failure.kind) {
          case "no-buffer":
            callback({ error: "バッファが空です" });
            break;
          case "no-session":
            callback({ error: "セッションが見つかりません" });
            break;
          default:
            console.warn(
              `[Copy] ${sessionId}: ${describeTmuxReadFailure(result.failure)}`
            );
            callback({
              error: `tmux バッファを取得できません: ${describeTmuxReadFailure(result.failure)}`,
            });
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

      try {
        const report = await usageCollector.collect(profiles);
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

      for (const unsub of diagramUnsubs.values()) {
        try {
          unsub();
        } catch (err) {
          console.error("[Diagram] Unsubscribe error:", getErrorMessage(err));
        }
      }
      diagramUnsubs.clear();
      for (const timeout of suppressedDiagramUpdates.values()) {
        clearTimeout(timeout);
      }
      suppressedDiagramUpdates.clear();

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

  // Board SessionStart / AskUserQuestion hooks 入りの claude 用 settings を
  // 書き出し、以降のセッション起動コマンドに --settings として注入する
  // (listen 後 = port 確定後)
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
    browserManager.cleanup();
    boardMcp.stop();
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
