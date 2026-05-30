/**
 * Ark MCP Server (HTTP)
 *
 * Beacon の司令塔ツール群 (旧 beacon-manager.createMcpServer の 18 tools) を
 * **Streamable HTTP MCP server** として 127.0.0.1 に公開する。
 *
 * 旧構成では Agent SDK の `createSdkMcpServer()` でプロセス内 MCP として
 * query() に渡していたが、SDK 廃止に伴い Beacon は `claude` CLI 子プロセスで
 * 駆動するようになった。CLI は別プロセスなので、ツールを実 MCP トランスポート
 * (HTTP) で公開し直し、CLI の `--mcp-config` から接続させる。
 *
 * セキュリティ:
 * - 127.0.0.1 のみで listen する (tunnel/リモートからは到達不可)
 * - 起動時に生成したランダム bearer token を要求する。token は CLI 子プロセスの
 *   `--mcp-config` の headers に注入され、外部には漏れない。restart_service /
 *   gh_exec / start_session 等の強力なツールをこの 2 重防御で保護する。
 */

import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { promisify } from "node:util";
import type { SpecialKey } from "@ark/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import type { BeaconDeps } from "./beacon-manager.js";
import { getErrorMessage } from "./errors.js";
import { resolvePm2Path } from "./system.js";

const execFileAsync = promisify(execFile);

/** Ark MCP server の接続情報 (CLI の --mcp-config に流し込む) */
export interface ArkMcpEndpoint {
  /** http://127.0.0.1:<port>/mcp */
  url: string;
  /** Authorization: Bearer に使う token */
  token: string;
}

/** text content だけの CallToolResult を生成するヘルパー */
function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * 18 個の司令塔ツールを登録した McpServer を構築する。
 * stateless transport では request 毎に新しい server を作るため、
 * deps を引数に取るファクトリ関数にしている。
 */
export function createArkMcpServer(deps: BeaconDeps): McpServer {
  const server = new McpServer({ name: "ark-beacon", version: "1.0.0" });

  const ALLOWED_GH_COMMANDS = new Set([
    "pr list",
    "pr view",
    "pr checks",
    "pr diff",
    "pr status",
    "issue list",
    "issue view",
    "issue status",
    "search prs",
    "search issues",
    "search repos",
    "run list",
    "run view",
    "workflow list",
    "workflow view",
    "release list",
    "release view",
    "label list",
    "repo view",
    "status",
  ]);

  server.registerTool(
    "list_repositories",
    { description: "Arkに登録されている全リポジトリを一覧する" },
    async () => textResult(JSON.stringify(deps.getRepos(), null, 2))
  );

  server.registerTool(
    "list_worktrees",
    {
      description: "指定リポジトリ（または全リポジトリ）のworktreeを一覧する",
      inputSchema: {
        repoPath: z
          .string()
          .optional()
          .describe("リポジトリパス（省略時は全リポジトリ）"),
      },
    },
    async args => {
      const repoPath = args.repoPath;
      const worktrees = repoPath
        ? await deps.listWorktrees(repoPath)
        : await deps.listAllWorktrees(deps.getRepos());
      return textResult(JSON.stringify(worktrees, null, 2));
    }
  );

  server.registerTool(
    "list_sessions",
    {
      description:
        "現在アクティブなClaude Codeターミナルセッション一覧を取得する",
    },
    async () => textResult(JSON.stringify(deps.getAllSessions(), null, 2))
  );

  server.registerTool(
    "start_session",
    {
      description: "指定worktreeでClaude Codeターミナルセッションを起動する",
      inputSchema: {
        worktreeId: z.string().describe("worktreeのID"),
        worktreePath: z.string().describe("worktreeのパス"),
      },
    },
    async args => {
      const session = await deps.startSession(
        args.worktreeId,
        args.worktreePath
      );
      return textResult(JSON.stringify(session, null, 2));
    }
  );

  server.registerTool(
    "stop_session",
    {
      description: "Claude Codeターミナルセッションを停止する",
      inputSchema: { sessionId: z.string().describe("セッションID") },
    },
    async args => {
      deps.stopSession(args.sessionId);
      return textResult(`セッション ${args.sessionId} を停止しました`);
    }
  );

  server.registerTool(
    "send_to_session",
    {
      description:
        "稼働中のClaude Codeターミナルセッションにテキストを送信する（Enter付き）",
      inputSchema: {
        sessionId: z.string().describe("セッションID"),
        message: z.string().describe("送信するテキスト"),
      },
    },
    async args => {
      deps.sendMessage(args.sessionId, args.message);
      return textResult(
        `セッション ${args.sessionId} にメッセージを送信しました`
      );
    }
  );

  server.registerTool(
    "send_key_to_session",
    {
      description:
        "稼働中のClaude Codeターミナルセッションに特殊キーを送信する（y, n, C-c, Escape, Enter など）",
      inputSchema: {
        sessionId: z.string().describe("セッションID"),
        key: z
          .string()
          .describe("送信するキー（y, n, C-c, Escape, Enter, S-Tab）"),
      },
    },
    async args => {
      const validKeys = new Set([
        "Enter",
        "C-c",
        "C-d",
        "y",
        "n",
        "S-Tab",
        "Escape",
      ]);
      if (!validKeys.has(args.key)) {
        return textResult(
          `無効なキー: ${args.key}。使用可能: ${Array.from(validKeys).join(", ")}`
        );
      }
      deps.sendKey(args.sessionId, args.key as SpecialKey);
      return textResult(
        `セッション ${args.sessionId} にキー「${args.key}」を送信しました`
      );
    }
  );

  server.registerTool(
    "get_session_output",
    {
      description:
        "稼働中のClaude Codeターミナルセッションの現在の表示内容を取得する。進捗確認に使用する。",
      inputSchema: {
        sessionId: z.string().describe("セッションID"),
        lines: z
          .number()
          .optional()
          .describe("取得する行数（デフォルト: 100）"),
      },
    },
    async args => {
      const output = deps.capturePane(args.sessionId, args.lines ?? 100);
      if (output === null) {
        return textResult(
          "セッションが見つからないか、出力を取得できませんでした"
        );
      }
      return textResult(output);
    }
  );

  server.registerTool(
    "validate_issue_url",
    {
      description:
        "Phase 1b で渡された URL が Jira / GitHub issue として有効かを *サーバ側で* 正規表現検証する。Phase 1b の最初に必ず呼び出すこと。OK なら kind ('jira'|'github') と parsed フィールドを返す。NG なら ok:false と理由。サーバ側で fail-fast に弾くため、検証を skip して gh_exec / mcp__claude_ai_Atlassian__* を呼ぶことは禁止。",
      inputSchema: {
        url: z.string().describe("Phase 1b でユーザが貼り付けたURL"),
      },
    },
    async args => {
      const url = String(args.url ?? "");
      const jiraRe =
        /^https:\/\/([a-z0-9-]+)\.atlassian\.net\/browse\/([A-Z][A-Z0-9]*-[0-9]+)\/?$/;
      const ghRe =
        /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/issues\/([0-9]+)\/?$/;
      const jm = url.match(jiraRe);
      if (jm) {
        return textResult(
          JSON.stringify({
            ok: true,
            kind: "jira",
            host: `${jm[1]}.atlassian.net`,
            issueKey: jm[2],
          })
        );
      }
      const gm = url.match(ghRe);
      if (gm) {
        return textResult(
          JSON.stringify({
            ok: true,
            kind: "github",
            owner: gm[1],
            repo: gm[2],
            issueNumber: Number(gm[3]),
          })
        );
      }
      return textResult(
        JSON.stringify({
          ok: false,
          error: "unsupported_url",
          detail:
            "Jira (https://*.atlassian.net/browse/<KEY>) または GitHub issue (https://github.com/<owner>/<repo>/issues/<N>) のみ受け付けます",
          received: url,
        })
      );
    }
  );

  server.registerTool(
    "list_profiles",
    {
      description:
        "登録済みのClaudeプロファイル一覧を取得する。Linux + claude CLI + tmux の環境でのみ実用的。空配列ならプロファイル機能未使用。",
    },
    async () => textResult(JSON.stringify(deps.listProfiles(), null, 2))
  );

  server.registerTool(
    "create_worktree",
    {
      description:
        "リポジトリに新しいworktreeを作成する。profileIdを渡すと作成後にworktreeへClaudeプロファイルを紐付ける（次回セッション起動時に CLAUDE_CONFIG_DIR が反映される）。",
      inputSchema: {
        repoPath: z.string().describe("リポジトリのパス"),
        branchName: z
          .string()
          .describe("ブランチ名（例: feat/add-search, fix/login-bug）"),
        baseBranch: z
          .string()
          .optional()
          .describe("ベースブランチ（省略時はHEAD）"),
        profileId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Claudeプロファイルのid (list_profilesの結果から選ぶ)。省略時はリポジトリのデフォルト紐付けを使用。空文字は受け付けない (未指定なら省略すること)"
          ),
      },
    },
    async args => {
      try {
        const profileId = args.profileId;
        // profileId が指定されている場合は worktree 作成 *前* に存在確認する。
        // 作成後に link 失敗してロールバックできずに worktree だけ残るのを防ぐ。
        if (profileId) {
          const known = deps.listProfiles().some(p => p.id === profileId);
          if (!known) {
            return textResult(
              JSON.stringify({
                ok: false,
                error: "unknown_profile_id",
                detail:
                  "list_profiles に存在しない profileId です。worktreeは作成していません",
                profileId,
              })
            );
          }
        }
        const worktree = (await deps.createWorktree(
          args.repoPath,
          args.branchName,
          args.baseBranch
        )) as { id?: string; path?: string } | null;
        // createWorktree が null / id 欠落 / path 欠落で返してきた場合は
        // 後続の start_session が成立しないため、ここで明示的に失敗扱いする
        if (!worktree?.path || !worktree.id) {
          return textResult(
            JSON.stringify({
              ok: false,
              error: "create_worktree_invalid_response",
              detail:
                "createWorktreeが worktree.path / worktree.id を返さなかった",
              received: worktree,
            })
          );
        }
        let linkedProfileId: string | null = null;
        if (profileId) {
          const ok = deps.linkWorktreeProfile(worktree.path, profileId);
          if (!ok) {
            // 事前検証を通過した profileId と新規作成 worktree なのに link 失敗
            // = profile が直前に削除された / worktree path 検証が拒否したケース。
            // 副作用を残さないため worktree を自動 rollback して原子性を保つ。
            let rollback: "deleted" | "delete_failed" = "deleted";
            try {
              await deps.deleteWorktree(args.repoPath, worktree.path);
            } catch {
              rollback = "delete_failed";
            }
            return textResult(
              JSON.stringify({
                ok: false,
                error: "link_profile_failed",
                detail:
                  "worktree作成後の link に失敗しました。worktreeはrollbackで削除を試みました",
                rollback,
                worktree,
                profileId,
              })
            );
          }
          linkedProfileId = profileId;
        }
        return textResult(
          JSON.stringify(
            linkedProfileId
              ? { ...worktree, profileId: linkedProfileId }
              : worktree,
            null,
            2
          )
        );
      } catch (e) {
        return textResult(`worktree作成に失敗: ${e}`);
      }
    }
  );

  server.registerTool(
    "delete_worktree",
    {
      description: "worktreeを削除する",
      inputSchema: {
        repoPath: z.string().describe("リポジトリのパス"),
        worktreePath: z.string().describe("削除するworktreeのパス"),
      },
    },
    async args => {
      try {
        await deps.deleteWorktree(args.repoPath, args.worktreePath);
        return textResult("worktreeを削除しました");
      } catch (e) {
        return textResult(`worktree削除に失敗: ${e}`);
      }
    }
  );

  server.registerTool(
    "get_pr_url",
    {
      description: "worktreeのブランチに紐づくPull Request URLを取得する",
      inputSchema: { worktreePath: z.string().describe("worktreeのパス") },
    },
    async args => {
      const url = await deps.getPrUrl(args.worktreePath);
      return textResult(url || "このブランチにPRはありません");
    }
  );

  server.registerTool(
    "get_system_status",
    {
      description:
        "ホストのCPU使用率/load average/メモリ/CPU上位プロセスを取得する。「CPU高い」「ホスト重い」等の調査に使う。",
      inputSchema: {
        topN: z
          .number()
          .optional()
          .describe("CPU使用率上位N件のプロセスを表示（デフォルト: 10）"),
      },
    },
    async args => {
      try {
        const topN = args.topN ?? 10;
        const os = await import("node:os");
        const total = os.totalmem();
        const free = os.freemem();
        const used = total - free;
        const load = os.loadavg();
        const cpus = os.cpus().length;
        const fmtMb = (n: number) => `${(n / 1024 / 1024).toFixed(0)}MB`;
        // ps でCPU使用率上位を取得。
        // GNU/BSD両対応のため `--sort` `--no-headers` は使わず、
        // ヘッダ行をJS側で除外しpcpu降順ソートする。
        const { stdout } = await execFileAsync(
          "ps",
          ["-eo", "pid,pcpu,pmem,etime,comm"],
          { timeout: 10_000, maxBuffer: 1024 * 1024 }
        );
        const allLines = stdout.split("\n").filter(l => l.trim());
        // 先頭行はヘッダ（`PID %CPU ...`）の可能性があるので、
        // 数値で始まらない行は捨てる。
        const dataLines = allLines.filter(l => /^\s*\d/.test(l));
        const sorted = dataLines
          .map(l => {
            const parts = l.trim().split(/\s+/);
            const pcpu = Number.parseFloat(parts[1] ?? "0");
            return { line: l.trim(), pcpu: Number.isFinite(pcpu) ? pcpu : 0 };
          })
          .sort((a, b) => b.pcpu - a.pcpu)
          .slice(0, topN)
          .map(p => p.line);
        const summary = [
          `CPU cores: ${cpus}`,
          `Load average: ${load.map(n => n.toFixed(2)).join(", ")} (1/5/15min)`,
          `Memory: used ${fmtMb(used)} / total ${fmtMb(total)} (free ${fmtMb(free)})`,
          "",
          `Top ${topN} processes by CPU:`,
          "PID    %CPU %MEM ELAPSED  COMMAND",
          ...sorted,
        ].join("\n");
        return textResult(summary);
      } catch (e) {
        return textResult(`system status取得エラー: ${getErrorMessage(e)}`);
      }
    }
  );

  server.registerTool(
    "list_processes",
    {
      description:
        "実行中プロセスを一覧する。pattern指定で特定プロセス（ttyd等）に絞り込み可能。",
      inputSchema: {
        pattern: z
          .string()
          .optional()
          .describe(
            "プロセス名/コマンドラインの部分一致パターン（例: ttyd, tmux）"
          ),
      },
    },
    async args => {
      try {
        const pattern = args.pattern;
        // `args` 列はGNU/BSD両対応（`cmd` はGNU専用）。
        // `--no-headers` も非対応のためJS側でヘッダ行を除外する。
        const { stdout } = await execFileAsync(
          "ps",
          ["-eo", "pid,pcpu,pmem,etime,args"],
          { timeout: 10_000, maxBuffer: 1024 * 1024 }
        );
        let lines = stdout
          .split("\n")
          .filter(l => l.trim())
          .filter(l => /^\s*\d/.test(l));
        if (pattern) {
          const lower = pattern.toLowerCase();
          lines = lines.filter(l => l.toLowerCase().includes(lower));
        }
        // 上位50件に制限（出力サイズ抑制）
        const limited = lines.slice(0, 50);
        const text =
          limited.length === 0
            ? "該当プロセスなし"
            : ["PID    %CPU %MEM ELAPSED  COMMAND", ...limited].join("\n");
        return textResult(text);
      } catch (e) {
        return textResult(`プロセス一覧取得エラー: ${getErrorMessage(e)}`);
      }
    }
  );

  server.registerTool(
    "get_pm2_status",
    { description: "pm2で管理されているプロセス一覧と状態を取得する。" },
    async () => {
      try {
        // pm2/systemd 経由起動時はサービスPATHにpm2が無いことがあるため
        // resolvePm2Path()で絶対パスを解決する。
        const pm2Path = resolvePm2Path();
        if (!pm2Path) {
          return textResult(
            "pm2 が見つかりません（PATHにも既知の候補ディレクトリにも存在しない）"
          );
        }
        const { stdout } = await execFileAsync(pm2Path, ["jlist"], {
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        });
        const procs = JSON.parse(stdout) as Array<{
          name: string;
          pid: number;
          pm2_env?: {
            status?: string;
            pm_uptime?: number;
            restart_time?: number;
          };
          monit?: { cpu?: number; memory?: number };
        }>;
        const summary = procs.map(p => {
          const status = p.pm2_env?.status ?? "unknown";
          const cpu = p.monit?.cpu ?? 0;
          const memMb = ((p.monit?.memory ?? 0) / 1024 / 1024).toFixed(1);
          const restarts = p.pm2_env?.restart_time ?? 0;
          return `- ${p.name} (pid ${p.pid}): ${status}, CPU ${cpu}%, MEM ${memMb}MB, restarts ${restarts}`;
        });
        const text =
          procs.length === 0 ? "pm2管理プロセスなし" : summary.join("\n");
        return textResult(text);
      } catch (e) {
        return textResult(`pm2状態取得エラー: ${getErrorMessage(e)}`);
      }
    }
  );

  server.registerTool(
    "restart_service",
    {
      description:
        "事前定義された運用サービスを再起動する。許可: 'ttyd' のみ（pkill -f ttyd 後にArkサーバーをpm2 restartする。Beacon自身も一時的に切断される）。",
      inputSchema: {
        service: z.string().describe("再起動対象。現在は 'ttyd' のみ許可"),
      },
    },
    async args => {
      if (args.service !== "ttyd") {
        return textResult(
          `許可されていないサービス: ${args.service}。現在は 'ttyd' のみ許可`
        );
      }
      try {
        // pm2の絶対パスを先に解決（pm2/systemd起動時のPATH問題対策）
        const pm2Path = resolvePm2Path();
        if (!pm2Path) {
          return textResult(
            "pm2 が見つかりません（PATHにも既知の候補ディレクトリにも存在しない）"
          );
        }
        // pkill は対象なし(exit 1)でもエラー扱いしない
        await execFileAsync("pkill", ["-f", "ttyd"], { timeout: 5_000 }).catch(
          err => {
            const code = (err as { code?: number }).code;
            if (code !== 1) throw err;
          }
        );
        // 短い待機後にpm2 restart
        await new Promise(r => setTimeout(r, 1500));
        const { stdout } = await execFileAsync(
          pm2Path,
          ["restart", "claude-code-ark"],
          { timeout: 30_000 }
        );
        return textResult(
          `ttydを停止しArkサーバーを再起動しました\n${stdout.trim()}`
        );
      } catch (e) {
        return textResult(`再起動失敗: ${getErrorMessage(e)}`);
      }
    }
  );

  server.registerTool(
    "gh_exec",
    {
      description: "gh CLIコマンドを実行する（読み取り専用コマンドのみ許可）",
      inputSchema: {
        args: z
          .array(z.string())
          .describe(
            'ghサブコマンドと引数（例: ["pr", "view", "--json", "url"]）'
          ),
        cwd: z.string().optional().describe("実行ディレクトリ（省略時はHOME）"),
      },
    },
    async params => {
      const args = params.args;
      // コマンドキーを構築（"pr view", "status" 等）
      const commandKey =
        args.length >= 2 ? `${args[0]} ${args[1]}` : args[0] || "";
      // -R/--repo フラグを拒否
      if (args.includes("-R") || args.includes("--repo")) {
        return textResult(
          "--repo/-R フラグは許可されていません。cwdで対象リポジトリを指定してください"
        );
      }
      if (!ALLOWED_GH_COMMANDS.has(commandKey)) {
        return textResult(
          `許可されていないコマンドです。使用可能: ${Array.from(ALLOWED_GH_COMMANDS).join(", ")}`
        );
      }
      try {
        const cwd = params.cwd || process.env.HOME || "/home";
        const { stdout } = await execFileAsync("gh", args, {
          cwd,
          timeout: 30_000,
          maxBuffer: 512 * 1024,
        });
        return textResult(stdout || "(出力なし)");
      } catch (e: unknown) {
        const stderr = (e as { stderr?: string }).stderr;
        const errorMsg = stderr || getErrorMessage(e);
        return textResult(`gh コマンド実行エラー: ${errorMsg}`);
      }
    }
  );

  return server;
}

/** 2 つの文字列を timing-safe に比較する */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Ark MCP server (HTTP) のライフサイクル管理。
 * BeaconManager が 1 インスタンス保持し、ターン実行前に start() で起動を保証する。
 */
export class ArkMcpServer {
  private httpServer: HttpServer | null = null;
  private endpoint: ArkMcpEndpoint | null = null;
  private starting: Promise<ArkMcpEndpoint> | null = null;

  /**
   * HTTP MCP server を起動する (冪等)。起動済みなら既存 endpoint を返す。
   * 127.0.0.1 で listen し、bearer token を要求する。
   *
   * @param opts.port  bind するポート (省略/0 で ephemeral)。対話版 Beacon は
   *   常駐 claude が起動時の mcp-config (url=port を含む) を保持し続けるため、
   *   サーバー再起動後も **同じポート** に bind し直す必要がある。BeaconManager が
   *   永続化したポートを渡す。bind に失敗した場合は ephemeral にフォールバックする。
   * @param opts.token  使用する bearer token (省略でランダム生成)。再起動後も
   *   常駐 claude の mcp-config に焼き込まれた token と一致させるため、
   *   BeaconManager が永続化した token を渡す。
   */
  start(
    deps: BeaconDeps,
    opts: { port?: number; token?: string } = {}
  ): Promise<ArkMcpEndpoint> {
    if (this.endpoint) return Promise.resolve(this.endpoint);
    if (this.starting) return this.starting;

    const preferredPort = opts.port;
    this.starting = new Promise<ArkMcpEndpoint>((resolve, reject) => {
      const token = opts.token ?? randomBytes(32).toString("hex");
      const app = express();
      app.use(express.json({ limit: "8mb" }));

      // bearer token 認証 (localhost listen と二重防御)
      const requireToken: express.RequestHandler = (req, res, next) => {
        const auth = req.header("authorization") ?? "";
        const prefix = "Bearer ";
        if (
          !auth.startsWith(prefix) ||
          !safeEqual(auth.slice(prefix.length), token)
        ) {
          res.status(401).json({
            jsonrpc: "2.0",
            error: { code: -32001, message: "unauthorized" },
            id: null,
          });
          return;
        }
        next();
      };

      app.post("/mcp", requireToken, async (req, res) => {
        // stateless: request 毎に server + transport を生成する。
        // ツールは deps を叩くだけで request 間に状態を持たないため安全。
        const server = createArkMcpServer(deps);
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
            "[ArkMcpServer] handleRequest エラー:",
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
      // 希望ポートが埋まっていた場合 (EADDRINUSE) は ephemeral に 1 度だけ
      // フォールバックする。フォールバックすると常駐 claude の mcp-config と
      // ポートがズレるため、その会話の ark-beacon ツールは次のリセットまで失敗する。
      let triedFallback = false;
      const onListening = () => {
        const addr = httpServer.address();
        if (!addr || typeof addr === "string") {
          httpServer.close();
          this.starting = null;
          reject(new Error("ArkMcpServer: ポート取得に失敗しました"));
          return;
        }
        this.httpServer = httpServer;
        this.endpoint = { url: `http://127.0.0.1:${addr.port}/mcp`, token };
        this.starting = null;
        console.log(
          `[ArkMcpServer] HTTP MCP server を起動: ${this.endpoint.url}`
        );
        resolve(this.endpoint);
      };
      httpServer.on("error", err => {
        if (
          !triedFallback &&
          preferredPort &&
          (err as NodeJS.ErrnoException).code === "EADDRINUSE"
        ) {
          triedFallback = true;
          console.warn(
            `[ArkMcpServer] 希望ポート ${preferredPort} が使用中。ephemeral にフォールバックします`
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

  /** 現在の endpoint (未起動なら null) */
  getEndpoint(): ArkMcpEndpoint | null {
    return this.endpoint;
  }

  /** HTTP MCP server を停止する */
  stop(): void {
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
    this.endpoint = null;
    this.starting = null;
  }
}
