/**
 * Session Orchestrator
 *
 * tmuxセッションとttydインスタンスを統合管理。
 * セッションライフサイクルの統一APIを提供する。
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BridgeSessionStatus,
  DIAGRAM_DIR,
  type ManagedSession,
  type SessionStatus,
  type SpecialKey,
} from "@ark/shared";
import { stripAnsi } from "./ansi.js";
import type {
  BoardMcpServer,
  BoardSessionRegistry,
} from "./board-mcp-server.js";
import { analyzeBridgeStatus } from "./bridge-collector.js";
import { db } from "./database.js";
import { type TmuxSession, tmuxManager } from "./tmux-manager.js";
import { ttydManager } from "./ttyd-manager.js";

export type { ManagedSession };

export class SessionOrchestrator extends EventEmitter {
  /**
   * worktreePath → repoPath のキャッシュ
   *
   * deriveRepoPath() は execFileSync(git) で同期子プロセスを起動するため、
   * getAllSessions/toManagedSession のhot pathでN回呼ばれると接続時応答が遅れる。
   * worktreeは削除イベント時のみ変更されるので、生存期間中はキャッシュして良い。
   * stopSession / 孤立セッションクリーンアップ時に invalidate する。
   */
  private repoPathCache = new Map<string, string | undefined>();

  /**
   * sessionId → 起動時に確定したプロファイルのスナップショット
   *
   * tmuxセッション自体はprofile情報を持たないため、SessionOrchestratorで
   * セッションごとに記憶しておく。restartSession時の再解決や、
   * staleProfile判定（プロファイル切替・configDir変更）に使う。
   * 値がnullなら「プロファイル未紐付け」、未設定（mapにキーなし）も同義。
   */
  private sessionProfiles = new Map<
    string,
    { id: string; configDir: string } | null
  >();

  /**
   * board_open MCP (BoardMcpServer / BoardSessionRegistry) への依存。
   * index.ts が boardMcp.start() 後に setBoardMcp() で一度だけ注入する。
   * 未注入 (null) の間は新規セッションに --mcp-config を付与しない。
   */
  private boardMcp: BoardMcpServer | null = null;
  private boardRegistry: BoardSessionRegistry | null = null;

  /**
   * sessionId → board MCP 用に発行した per-session bearer token と
   * mcp-config ファイルのパス
   *
   * stopSession / restartSession (旧セッション) 時に registry から
   * unregister し、対応する per-session mcp-config ファイルも削除する
   * (token をファイル/registry に残さない)。
   *
   * cfgPath は token と**無関係のランダム id** で命名する: cfgPath は
   * `--mcp-config <path>` として claude 起動コマンドに渡り `ps aux` 等で
   * 露出するため、ファイル名/path に token を含めない (token 秘匿)。
   * token を後で unregister するために cfgPath とセットで保持する。
   */
  private sessionBoardTokens = new Map<
    string,
    { token: string; cfgPath: string }
  >();

  constructor() {
    super();
    this.setupEventForwarding();
    this.restoreExistingSessions();
  }

  /**
   * board_write MCP の依存を注入する (index.ts から一度だけ呼ばれる想定)。
   * 既存セッションの復元 (restoreExistingSessions) はコンストラクタで
   * 走り終えているため、ここで復元済みセッションの board token を
   * registry へ復帰させる (restoreBoardTokens)。
   */
  setBoardMcp(
    boardMcp: BoardMcpServer,
    boardRegistry: BoardSessionRegistry
  ): void {
    this.boardMcp = boardMcp;
    this.boardRegistry = boardRegistry;
    this.restoreBoardTokens();
  }

  /**
   * サーバー再起動後、復元済みセッションの board token を registry へ復帰させる。
   *
   * 稼働中の claude は起動時に `--mcp-config` で渡された token を保持し続ける
   * (プロセスを作り直さない限り変えられない)。registry は in-memory なので
   * 再起動で空になり、復帰させないと既存セッションの board_write が
   * すべて 401 になる (セッションを作り直すまで復旧しない)。
   *
   * token は 0600 の mcp-config ファイルにのみ置き、DB にはそのパスだけを
   * 永続化しているため、ここでファイルから読み戻す。
   */
  private restoreBoardTokens(): void {
    if (!this.boardRegistry) return;
    for (const session of tmuxManager.getAllSessions()) {
      if (!session.worktreePath) continue;
      // 同一プロセス内で既に登録済みのものは触らない
      if (this.sessionBoardTokens.has(session.id)) continue;
      const cfgPath = db.getSessionByWorktreePath(
        session.worktreePath
      )?.boardMcpConfigPath;
      if (!cfgPath) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as {
          mcpServers?: {
            "ark-board"?: { headers?: { Authorization?: string } };
          };
        };
        const auth = parsed.mcpServers?.["ark-board"]?.headers?.Authorization;
        const token = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!token) continue;
        this.boardRegistry.register(token, session.worktreePath);
        this.sessionBoardTokens.set(session.id, { token, cfgPath });
      } catch {
        // ファイルが消えている/壊れている場合は諦める (次回起動時に再作成される)
      }
    }
  }

  /** per-session mcp-config ファイルを格納するディレクトリ (token は含めない) */
  private boardMcpConfigDir(): string {
    return join(tmpdir(), "ark-board-mcp");
  }

  /**
   * 新規 tmux セッション向けに board MCP 用の per-session token/config を用意し、
   * tmuxManager (共有インスタンス) の --mcp-config 設定を更新する。
   *
   * board MCP 未起動 (port なし) または未注入 (setBoardMcp 未呼び出し) の場合は
   * tmuxManager.setClaudeMcpConfigPath(null) を呼んで前回セッションの設定を
   * 持ち越さないようにし、null を返す。
   *
   * セキュリティ:
   * - ファイル名は token と無関係のランダム id にする。cfgPath は
   *   `--mcp-config <path>` として起動コマンドに渡り `ps aux` で露出するため、
   *   token を path に含めない (token は内容の headers.Authorization のみに置く)。
   * - 格納 dir は 0700 (他ユーザーから列挙不可)、ファイルは 0600 で書く。
   *
   * 呼び出し直後 (await を挟まず) に tmuxManager.createSession() を呼ぶこと。
   * claudeMcpConfigPath は tmuxManager の共有状態のため、間に他の非同期処理を
   * 挟むと並行する別セッションの起動と競合し得る。
   */
  private prepareBoardMcpConfig(): { token: string; cfgPath: string } | null {
    const port = this.boardMcp?.getPort() ?? null;
    if (port === null || !this.boardRegistry) {
      tmuxManager.setClaudeMcpConfigPath(null);
      tmuxManager.setClaudeAppendSystemPrompt(null);
      return null;
    }
    const token = randomBytes(24).toString("hex");
    // ファイル名は token と無関係のランダム id (path から token を漏らさない)
    const fileId = randomBytes(16).toString("hex");
    const dir = this.boardMcpConfigDir();
    const cfgPath = join(dir, `${fileId}.json`);
    // dir は 0700 で作成。既存 dir は mkdirSync では mode が変わらないため、
    // chmod で 0700 を保証する (他ユーザーからの列挙を防ぐ)。
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // ベストエフォート (所有権が異なる等で失敗しても続行)
    }
    // bearer token を含むため 0600 で書く (beacon の mcp-config.json と同方針)
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        mcpServers: {
          "ark-board": {
            type: "http",
            url: `http://127.0.0.1:${port}/mcp`,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      }),
      { mode: 0o600 }
    );
    tmuxManager.setClaudeMcpConfigPath(cfgPath);
    // ボードの図・文書機能に加え、コメント機能の存在と、コメントを受けて
    // 修正・再表示する往復手順を全セッションへ伝える。
    // 生成規約自体は diagram-authoring skill が持つ。
    // tmux send-keys に -l がなく、改行は Enter キーとして解釈されるため、
    // append-system-prompt に渡す文字列は必ず 1 行にする。
    tmuxManager.setClaudeAppendSystemPrompt(
      [
        "このセッションにはボードペインがあり、図と文書を表示できる。board_open（ボードに開く）と board_comments（人間が付けたコメントを読む）の 2 つのツールを持っている。",
        `ユーザーが「図解して」「図で説明して」「フロー図/構成図にして」等、図解・作図・可視化を求めたら、チャットに mermaid や ASCII 図を出すのではなく、${DIAGRAM_DIR}/ 配下に *.diagram.html を書き、board_open で開くこと。`,
        '設計メモ・仕様・調査結果など「人に読ませる文書」も同じ形式で書ける。model の type を "doc" にすると、ユーザーが本文をテキスト選択してコメントを付けられる、レビュー可能な文書になる。',
        "ユーザーが「コメントした」「図を見て」等と言ったら、board_comments で未解決コメントを読み、引用された箇所を直してから board_open で開き直すこと。",
        "書き込む直前に parent directory が存在しない場合だけ作成する。作図・文書の規約（type と kind の語彙、data-ark-id の対応、label の書き方）は diagram-authoring skill に従う。",
      ].join(" ")
    );
    return { token, cfgPath };
  }

  /**
   * prepareBoardMcpConfig() の後にセッション作成が失敗した場合の後始末。
   * registry には未登録 (成功後にのみ register するため) だが、書き込んだ
   * 設定ファイルと tmuxManager の設定は残ってしまうため破棄する。
   */
  private discardBoardMcpConfig(cfgPath: string): void {
    tmuxManager.setClaudeMcpConfigPath(null);
    tmuxManager.setClaudeAppendSystemPrompt(null);
    try {
      fs.unlinkSync(cfgPath);
    } catch {
      // ベストエフォート (既に無い場合等は無視)
    }
  }

  /** セッション作成成功後、board token を registry + sessionBoardTokens に登録する */
  private registerBoardToken(
    sessionId: string,
    worktreePath: string,
    token: string,
    cfgPath: string
  ): void {
    this.boardRegistry?.register(token, worktreePath);
    this.sessionBoardTokens.set(sessionId, { token, cfgPath });
  }

  /** セッション停止時、board token を registry + ファイルから解除する */
  private unregisterBoardToken(sessionId: string): void {
    const entry = this.sessionBoardTokens.get(sessionId);
    if (!entry) return;
    this.boardRegistry?.unregister(entry.token);
    this.sessionBoardTokens.delete(sessionId);
    try {
      fs.unlinkSync(entry.cfgPath);
    } catch {
      // ベストエフォート (既に無い場合等は無視)
    }
  }

  /**
   * 下位マネージャーからのイベントを転送
   */
  private setupEventForwarding(): void {
    tmuxManager.on("session:created", (_tmuxSession: TmuxSession) => {
      // セッション作成時はstartSession内で処理するのでここでは何もしない
    });

    tmuxManager.on("session:stopped", (sessionId: string) => {
      // tmuxが停止した場合はttydも停止するが、session:stoppedは発行しない
      // 明示的にstopSession()が呼ばれた場合のみセッション削除する
      ttydManager.stopInstance(sessionId);
    });

    ttydManager.on("instance:stopped", (_sessionId: string) => {
      // ttydが停止してもtmuxセッションは維持
      // セッション削除もしない（明示的なstopSession呼び出し時のみ削除）
    });
  }

  /**
   * 前回の実行から残っているセッションを復元（ttydも起動）
   */
  private restoreExistingSessions(): void {
    const tmuxSessions = tmuxManager.getAllSessions();

    for (const tmuxSession of tmuxSessions) {
      // worktreeディレクトリが存在しないセッションはクリーンアップ
      if (
        tmuxSession.worktreePath &&
        !fs.existsSync(tmuxSession.worktreePath)
      ) {
        console.log(
          `[Orchestrator] Cleaning up orphaned session (worktree deleted): ${tmuxSession.tmuxSessionName} -> ${tmuxSession.worktreePath}`
        );
        tmuxManager.killSession(tmuxSession.id);
        const dbSession = db.getSessionByWorktreePath(tmuxSession.worktreePath);
        if (dbSession) {
          db.deleteSession(dbSession.id);
        }
        this.repoPathCache.delete(tmuxSession.worktreePath);
        continue;
      }

      // DBにセッション情報があればstatusを尊重（idle等の永続化された状態を維持）
      // repoPathの不整合はttyd起動完了時のtoManagedSession()が修正するので
      // ここで二度execFileSyncを走らせない
      const dbSession = db.getSessionByWorktreePath(tmuxSession.worktreePath);
      if (dbSession) {
        console.log(
          `[Orchestrator] Restored session: ${tmuxSession.tmuxSessionName} -> ${dbSession.id} (status: ${dbSession.status})`
        );
        // 永続化されたprofileスナップショットを sessionProfiles Map に復元
        // (サーバ再起動後でも staleProfile 判定が正しく動くため)
        const restoredProfile =
          dbSession.profileId && dbSession.profileConfigDir
            ? { id: dbSession.profileId, configDir: dbSession.profileConfigDir }
            : this.detectEnvProfile(tmuxSession);
        this.sessionProfiles.set(dbSession.id, restoredProfile);
      } else {
        // DB に対応レコードなし (例: data dir を別パスに移行した直後)。
        // env から CLAUDE_CONFIG_DIR を補完し、JsonlTailManager が正しい
        // プロファイル配下の JSONL を見つけられるようにする。
        const envProfile = this.detectEnvProfile(tmuxSession);
        if (envProfile) {
          this.sessionProfiles.set(tmuxSession.id, envProfile);
        }
      }

      // ttydも自動起動（起動完了後にクライアントへ通知）
      ttydManager
        .startInstance(tmuxSession.id, tmuxSession.tmuxSessionName)
        .then(() => {
          console.log(
            `[Orchestrator] Started ttyd for restored session: ${tmuxSession.id}`
          );
          // ttyd起動完了をクライアントに通知（ttydPort/ttydUrlを含む最新情報を送信）
          const dbSession = db.getSessionByWorktreePath(
            tmuxSession.worktreePath
          );
          const managed = this.toManagedSession(
            tmuxSession,
            dbSession?.worktreeId || ""
          );
          this.emit("session:updated", managed);
        })
        .catch(err => {
          console.error(
            `[Orchestrator] Failed to start ttyd for ${tmuxSession.id}:`,
            err.message
          );
        });
    }
  }

  /**
   * TmuxSessionをManagedSessionに変換
   * tmuxがrunning状態の場合はDBのstatusを優先し、idle状態をリロード後も維持する
   */
  private toManagedSession(
    tmuxSession: TmuxSession,
    worktreeId: string
  ): ManagedSession {
    const ttydInstance = ttydManager.getInstance(tmuxSession.id);
    // tmuxがrunning状態の場合、DBのstatusを優先（idle等の永続化された状態を反映）
    const dbSession = db.getSessionByWorktreePath(tmuxSession.worktreePath);
    const status =
      tmuxSession.status === "running"
        ? (dbSession?.status as SessionStatus) || "active"
        : this.mapTmuxStatus(tmuxSession.status);

    // worktreePathから導出したrepoPathを正として扱い、
    // DBとの不整合があれば修正する
    const derivedRepoPath = tmuxSession.worktreePath
      ? this.deriveRepoPath(tmuxSession.worktreePath)
      : undefined;
    const repoPath = derivedRepoPath ?? dbSession?.repoPath;
    if (
      derivedRepoPath &&
      dbSession &&
      dbSession.repoPath !== derivedRepoPath
    ) {
      db.updateSessionRepoPath(dbSession.id, derivedRepoPath);
    }

    // 起動時に確定したプロファイルと、現在の (worktree個別 or repoデフォルト)
    // 紐付けの解決結果を比較して staleProfile を判定する。
    // - profileId 切替 (null↔id、id↔別id) → stale
    // - 同一profileIdでも configDir が変わった場合も stale
    //   (tmux env は起動時に固定されるため再起動しないと反映されない)
    const current = this.sessionProfiles.get(tmuxSession.id) ?? null;
    const { snapshot: desiredProfile } = this.resolveProfileForWorktree(
      tmuxSession.worktreePath,
      repoPath
    );
    const staleProfile = !this.profileSnapshotsEqual(current, desiredProfile);

    return {
      id: tmuxSession.id,
      worktreeId,
      worktreePath: tmuxSession.worktreePath,
      repoPath,
      status,
      createdAt: tmuxSession.createdAt,
      tmuxSessionName: tmuxSession.tmuxSessionName,
      ttydPort: ttydInstance?.port || null,
      ttydUrl: ttydInstance ? `/ttyd/${tmuxSession.id}/` : null,
      profileId: current?.id ?? null,
      // JSONL tail (チャットビュー) がプロファイル配下の
      // <configDir>/projects を参照するために必要
      profileConfigDir: current?.configDir ?? null,
      staleProfile,
      // リロード後にクライアントが右ペインの図タブを復元するために必要
      // (board_open の度に db.updateSessionLastDiagram で更新される)
      lastDiagramPath: dbSession?.lastDiagramPath ?? null,
    };
  }

  /**
   * 復元したセッションの「事実上の CLAUDE_CONFIG_DIR」を env から検出する。
   *
   * DB にプロファイル記録が無い (または null の) セッションでも、
   * - 旧コードで起動され tmux サーバー env から CLAUDE_CONFIG_DIR を継承した
   * - data dir 移行で DB レコードが消えた
   * 等で claude が別プロファイル配下に transcript を書いていることがある。
   * その場合 JsonlTailManager がデフォルト ~/.claude/projects を見てしまい、
   * チャットビューに会話が一切表示されない。
   * tmux session env (`show-environment`) → pane プロセス environ (/proc) の
   * 順で実際の値を探し、見つかれば configDir のみのダミープロファイルとして
   * 反映する (profileId は管理 UI と紐付かない `__env__`)。
   */
  private detectEnvProfile(tmuxSession: {
    id: string;
    tmuxSessionName: string;
  }): { id: string; configDir: string } | null {
    const envConfigDir =
      tmuxManager.getEnv(tmuxSession.id, "CLAUDE_CONFIG_DIR") ??
      tmuxManager.getPaneEnv(tmuxSession.id, "CLAUDE_CONFIG_DIR");
    if (!envConfigDir) return null;
    console.log(
      `[Orchestrator] Restored profile from env: ${tmuxSession.tmuxSessionName} -> ${envConfigDir}`
    );
    return { id: "__env__", configDir: envConfigDir };
  }

  /**
   * 起動時のプロファイルスナップショットと現在のプロファイルが一致するか。
   * 両方null（紐付けなし）も一致とみなす。
   */
  private profileSnapshotsEqual(
    current: { id: string; configDir: string } | null,
    desired: { id: string; configDir: string } | null
  ): boolean {
    if (current === null && desired === null) return true;
    if (current === null || desired === null) return false;
    return current.id === desired.id && current.configDir === desired.configDir;
  }

  /**
   * worktreePathからメインリポジトリのパスを導出
   *
   * `repoPathCache` でメモ化する。ヒット時はgitプロセスを起動しない。
   * 失敗結果 (undefined) も再試行を避けるためキャッシュする。
   */
  private deriveRepoPath(worktreePath: string): string | undefined {
    if (this.repoPathCache.has(worktreePath)) {
      return this.repoPathCache.get(worktreePath);
    }
    try {
      const gitCommonDir = execFileSync(
        "git",
        [
          "-C",
          worktreePath,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ],
        { encoding: "utf-8" }
      ).trim();
      const repo = gitCommonDir.replace(/\/\.git\/?$/, "") || undefined;
      this.repoPathCache.set(worktreePath, repo);
      return repo;
    } catch {
      this.repoPathCache.set(worktreePath, undefined);
      return undefined;
    }
  }

  /**
   * tmuxのステータスをSessionStatusにマップ
   */
  private mapTmuxStatus(status: TmuxSession["status"]): SessionStatus {
    switch (status) {
      case "running":
        return "active";
      case "starting":
        return "idle";
      case "stopped":
        return "stopped";
      case "error":
        return "error";
      default:
        return "idle";
    }
  }

  /**
   * 紐付けプロファイルから env / プロファイルスナップショットを解決する。
   *
   * 解決順序:
   * 1. worktree_profile_links[worktreePath] (worktree個別の紐付けが優先)
   * 2. repo_profile_links[repoPath] (リポジトリのデフォルト)
   * 3. どちらも無ければ null env / null snapshot
   *
   * 紐付けはあるが profile が無い (削除済等) 場合も null 扱い。
   * configDir/.credentials.json の存在チェックは行わない。claude CLI が
   * 必要なら自動で /login を促す。
   *
   * lookup 戦略:
   * - まず受信した path で lookup を試す
   * - 見つからなければ fs.realpathSync で正規化したパスで再試行
   *   (クライアントは symlink path で送ってくる場合と、git rev-parse 経由
   *    で正規化した path で送ってくる場合の両方があり、保存と lookup の key
   *    が食い違う可能性があるため)
   */
  private resolveProfileForWorktree(
    worktreePath: string | undefined,
    repoPath: string | undefined
  ): {
    env: Record<string, string> | undefined;
    snapshot: { id: string; configDir: string } | null;
  } {
    // 1. worktree個別の紐付け
    let profileId: string | null = null;
    if (worktreePath) {
      let wtLink = db.getWorktreeProfileLink(worktreePath);
      if (!wtLink) {
        try {
          const real = fs.realpathSync(worktreePath);
          if (real !== worktreePath) {
            wtLink = db.getWorktreeProfileLink(real);
          }
        } catch {
          // realpath 解決失敗 → 受信値のままで紐付けなし扱い
        }
      }
      if (wtLink) {
        profileId = wtLink.profileId;
      }
    }

    // 2. リポジトリのデフォルト紐付け
    if (!profileId && repoPath) {
      let repoLink = db.getRepoProfileLink(repoPath);
      if (!repoLink) {
        try {
          const real = fs.realpathSync(repoPath);
          if (real !== repoPath) {
            repoLink = db.getRepoProfileLink(real);
          }
        } catch {
          // realpath 解決失敗 → 受信値のままで紐付けなし扱い
        }
      }
      if (repoLink) {
        profileId = repoLink.profileId;
      }
    }

    if (!profileId) {
      return { env: undefined, snapshot: null };
    }
    const profile = db.getProfile(profileId);
    if (!profile) {
      return { env: undefined, snapshot: null };
    }
    return {
      env: { CLAUDE_CONFIG_DIR: profile.configDir },
      snapshot: { id: profile.id, configDir: profile.configDir },
    };
  }

  /**
   * 新規セッションを開始
   */
  async startSession(
    worktreeId: string,
    worktreePath: string,
    repoPath?: string
  ): Promise<ManagedSession> {
    // worktreePathから導出したrepoPathを優先する。
    // 呼び出し側の `currentRepoPath` はソケット状態に依存するため、
    // 別リポジトリのworktreeに対して誤った値が渡るケースがある。
    const resolvedRepoPath = this.deriveRepoPath(worktreePath) ?? repoPath;

    // 既存セッションがあれば再利用
    const existingTmux = tmuxManager.getSessionByWorktree(worktreePath);
    if (existingTmux) {
      // repoPathが解決できた場合はDBを更新（既存セッションにrepoPath情報を補完）
      if (resolvedRepoPath) {
        const dbSession = db.getSessionByWorktreePath(worktreePath);
        if (dbSession && dbSession.repoPath !== resolvedRepoPath) {
          db.updateSessionRepoPath(dbSession.id, resolvedRepoPath);
        }
      }

      // ttydが起動していなければ起動
      let ttydInstance = ttydManager.getInstance(existingTmux.id);
      if (!ttydInstance) {
        ttydInstance = await ttydManager.startInstance(
          existingTmux.id,
          existingTmux.tmuxSessionName
        );
      }

      // toManagedSession 内で sessionProfiles と紐付けを比較して
      // profileId / staleProfile を反映済み
      const managed = this.toManagedSession(existingTmux, worktreeId);
      this.emit("session:restored", managed);
      return managed;
    }

    // 新規作成パス: 紐付けプロファイルから env / スナップショットを解決
    // (worktree個別 → repoデフォルト の順で解決)
    const { env, snapshot } = this.resolveProfileForWorktree(
      worktreePath,
      resolvedRepoPath
    );

    // board MCP (ark-board / board_write) 用の per-session token/config を用意する。
    // 未起動/未注入なら tmuxManager の --mcp-config 設定を null にリセットする
    // (tmuxManager は共有インスタンスのため、前回セッションの設定を持ち越さない)。
    const boardPrep = this.prepareBoardMcpConfig();

    // 新規tmuxセッションを作成（envがあれば注入）
    let tmuxSession: TmuxSession;
    try {
      tmuxSession = await tmuxManager.createSession(
        worktreePath,
        env ? { env } : undefined
      );
    } catch (e) {
      if (boardPrep) this.discardBoardMcpConfig(boardPrep.cfgPath);
      throw e;
    }
    if (boardPrep) {
      this.registerBoardToken(
        tmuxSession.id,
        worktreePath,
        boardPrep.token,
        boardPrep.cfgPath
      );
    }

    // ttydインスタンスを起動。失敗したら startSession 全体が失敗する（throw）ため、
    // 直前に作った tmux セッションと board token を両方ロールバックする。
    // tmux を残すと ttyd の無いゾンビセッションになり、board token を残すと
    // DB セッションの無い孤児 token が認可され続ける（どちらも getAllSessions の
    // 孤児掃除では回収されない = worktree は実在するため）。
    let ttydInstance: Awaited<ReturnType<typeof ttydManager.startInstance>>;
    try {
      ttydInstance = await ttydManager.startInstance(
        tmuxSession.id,
        tmuxSession.tmuxSessionName
      );
    } catch (e) {
      this.unregisterBoardToken(tmuxSession.id);
      tmuxManager.killSession(tmuxSession.id);
      throw e;
    }

    // DBに保存（既存レコードがあればupsertで更新）
    db.upsertSession({
      id: tmuxSession.id,
      worktreeId,
      worktreePath,
      repoPath: resolvedRepoPath,
      status: "active",
      profileId: snapshot?.id ?? null,
      profileConfigDir: snapshot?.configDir ?? null,
      // サーバー再起動後に token を registry へ復帰させるため、
      // mcp-config のパスを永続化する (token 自体は 0600 のファイル内のみ)
      boardMcpConfigPath: boardPrep?.cfgPath ?? null,
    });

    // プロファイルスナップショットをsession-id毎に記憶
    // (restartSession / staleProfile判定用)
    this.sessionProfiles.set(tmuxSession.id, snapshot);

    const managed: ManagedSession = {
      id: tmuxSession.id,
      worktreeId,
      worktreePath,
      repoPath: resolvedRepoPath,
      status: "active",
      createdAt: tmuxSession.createdAt,
      tmuxSessionName: tmuxSession.tmuxSessionName,
      ttydPort: ttydInstance.port,
      ttydUrl: `/ttyd/${tmuxSession.id}/`,
      profileId: snapshot?.id ?? null,
    };

    this.emit("session:created", managed);
    return managed;
  }

  /**
   * 稼働中セッションを kill して、現在の紐付けで再起動する。
   * staleProfile となったセッションをユーザが「再起動」した際に呼ぶ。
   *
   * 失敗時の安全性: 新セッションの起動 (tmux/ttyd) が成功するまで旧セッション
   * には触らない。新側で失敗したら旧は無傷で残り、エラーが上に伝播するだけ。
   * 旧tmux/ttyd は「新セッションが usable と確認できた後」にだけ停止する。
   *
   * 内部処理:
   * 1. プロファイル解決 (envと configDir スナップショット)
   * 2. 新tmuxセッションを **別ID** で作成 (旧と並走)
   * 3. 新ttydを起動。失敗時は新tmuxを kill して throw
   * 4. 旧 ttyd 停止 / 旧 tmux kill / sessionProfiles/repoPathCache クリア
   * 5. DB を upsert (worktree_path UNIQUE により旧行が新IDで上書きされる)
   * 6. session:stopped (旧ID) → session:created (新ID) を emit
   *
   * @throws sessionId に対応する tmux セッションが見つからない場合
   * @throws 新セッション起動失敗 (旧セッションは無傷)
   */
  /**
   * 同一セッションへの並行 restartSession を直列化する in-flight guard。
   * ガード無しだと複数タブからの同時再起動が両方とも旧セッションを基に
   * 新セッションを作成し、重複 tmux/ttyd と DB 不整合が発生する。
   * 進行中の再起動があればその Promise に相乗りする (冪等)
   */
  private restartsInFlight = new Map<string, Promise<ManagedSession>>();

  async restartSession(sessionId: string): Promise<ManagedSession> {
    const inFlight = this.restartsInFlight.get(sessionId);
    if (inFlight) return inFlight;
    const promise = this.doRestartSession(sessionId).finally(() => {
      this.restartsInFlight.delete(sessionId);
    });
    this.restartsInFlight.set(sessionId, promise);
    return promise;
  }

  private async doRestartSession(sessionId: string): Promise<ManagedSession> {
    const oldTmux = tmuxManager.getSession(sessionId);
    if (!oldTmux) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const worktreePath = oldTmux.worktreePath;
    const dbSession = db.getSessionByWorktreePath(worktreePath);
    const worktreeId = dbSession?.worktreeId || "";
    const repoPath =
      dbSession?.repoPath ||
      (worktreePath ? this.deriveRepoPath(worktreePath) : undefined);

    // 1. 新プロファイルを解決 (worktree個別 → repoデフォルト の順)
    const { env, snapshot } = this.resolveProfileForWorktree(
      worktreePath,
      repoPath
    );

    // 2. board MCP 用の per-session token/config を用意してから、
    //    新tmuxセッションを別IDで作成する (失敗時は旧セッション無傷)。
    //    旧セッションの token はまだ解除しない (新側が usable と確認できてから)。
    const boardPrep = this.prepareBoardMcpConfig();
    let newTmux: TmuxSession;
    try {
      newTmux = await tmuxManager.createSession(
        worktreePath,
        env ? { env } : undefined
      );
    } catch (e) {
      if (boardPrep) this.discardBoardMcpConfig(boardPrep.cfgPath);
      throw e;
    }

    // 3. 新ttydを起動 (失敗時は新tmuxを後始末してから throw、旧は無傷)
    let newTtyd: Awaited<ReturnType<typeof ttydManager.startInstance>>;
    try {
      newTtyd = await ttydManager.startInstance(
        newTmux.id,
        newTmux.tmuxSessionName
      );
    } catch (e) {
      tmuxManager.killSession(newTmux.id);
      if (boardPrep) this.discardBoardMcpConfig(boardPrep.cfgPath);
      throw e;
    }

    // 4. DB の切替を「旧tmux/ttyd停止より前」に atomic 実施する。
    //    sessions.id は messages.session_id から外部キー参照されており、
    //    messages 行に ON UPDATE CASCADE がないため、UPSERT による id 書き換えは
    //    SQLite に拒否される。よって旧行を delete (messages は ON DELETE CASCADE
    //    で連鎖削除) → 新行を upsert する順序にする。delete と insert を別個に
    //    実行すると、insert 失敗時に DB行+messages を失ったまま旧tmux が残るので、
    //    `replaceSession` (transaction) で atomic 化し、失敗時は ROLLBACK で
    //    旧行を保護する。
    //    restart は新たな claude プロセスを起動する仕様で、Ark側の会話履歴
    //    (messages) も同期して破棄する想定。
    //    ここで失敗した場合は旧tmuxはまだ生きているので新tmuxを後始末して throw。
    try {
      const newSessionInput = {
        id: newTmux.id,
        worktreeId,
        worktreePath,
        repoPath,
        status: "active" as const,
        profileId: snapshot?.id ?? null,
        profileConfigDir: snapshot?.configDir ?? null,
        boardMcpConfigPath: boardPrep?.cfgPath ?? null,
      };
      if (dbSession) {
        db.replaceSession(dbSession.id, newSessionInput);
      } else {
        db.upsertSession(newSessionInput);
      }
    } catch (e) {
      ttydManager.stopInstance(newTmux.id);
      tmuxManager.killSession(newTmux.id);
      if (boardPrep) this.discardBoardMcpConfig(boardPrep.cfgPath);
      throw e;
    }
    this.sessionProfiles.set(newTmux.id, snapshot);
    this.sessionProfiles.delete(sessionId);
    this.repoPathCache.delete(worktreePath);
    if (boardPrep) {
      this.registerBoardToken(
        newTmux.id,
        worktreePath,
        boardPrep.token,
        boardPrep.cfgPath
      );
    }
    // 旧セッションの board token を解除する (新セッションのIDに切り替わるため)
    this.unregisterBoardToken(sessionId);

    // 5. ここまで成功 → 旧 tmux/ttyd を停止
    ttydManager.stopInstance(sessionId);
    tmuxManager.killSession(sessionId);

    // 6. クライアント通知。順序が重要:
    //    created(新) → restarted(旧→新の対応) → stopped(旧)。
    //    stopped を先に流すと、受信側で「選択中セッションの消失」による
    //    フォールバック選択が session:restarted の到着より先に走り、
    //    選択追従 (prev === oldSessionId) が失敗するため
    const managed: ManagedSession = {
      id: newTmux.id,
      worktreeId,
      worktreePath,
      repoPath,
      status: "active",
      createdAt: newTmux.createdAt,
      tmuxSessionName: newTmux.tmuxSessionName,
      ttydPort: newTtyd.port,
      ttydUrl: `/ttyd/${newTmux.id}/`,
      profileId: snapshot?.id ?? null,
    };
    this.emit("session:created", managed);
    this.emit("session:restarted", {
      oldSessionId: sessionId,
      session: managed,
    });
    this.emit("session:stopped", sessionId);
    return managed;
  }

  /**
   * 指定セッションの staleProfile を再評価する。
   *
   * `repo:set-profile` / `worktree:set-profile` 等で紐付けが変わった際に、
   * 稼働中セッションの staleProfile を再計算してクライアントへ反映するための
   * ヘルパー。
   *
   * @returns 現在 staleProfile かどうか（セッション不存在時は false）
   */
  recomputeStaleProfile(sessionId: string): boolean {
    const tmuxSession = tmuxManager.getSession(sessionId);
    if (!tmuxSession) return false;
    const repoPath = tmuxSession.worktreePath
      ? this.deriveRepoPath(tmuxSession.worktreePath)
      : undefined;
    const { snapshot: desired } = this.resolveProfileForWorktree(
      tmuxSession.worktreePath,
      repoPath
    );
    const current = this.sessionProfiles.get(sessionId) ?? null;
    return !this.profileSnapshotsEqual(current, desired);
  }

  /**
   * メッセージを送信
   */
  sendMessage(sessionId: string, message: string): void {
    tmuxManager.sendKeys(sessionId, message);

    const session = tmuxManager.getSession(sessionId);
    if (session) {
      db.updateSessionStatus(sessionId, "active");
    }
  }

  /**
   * 特殊キーを送信
   */
  sendSpecialKey(sessionId: string, key: SpecialKey): void {
    tmuxManager.sendSpecialKey(sessionId, key);
  }

  /**
   * セッションを削除（tmux/ttyd停止 + DB削除）
   * worktreeの削除はserver/index.tsのハンドラ側で行う
   */
  stopSession(
    sessionId: string
  ): { worktreePath: string; repoPath?: string } | null {
    const tmuxSession = tmuxManager.getSession(sessionId);
    const dbSession = tmuxSession
      ? db.getSessionByWorktreePath(tmuxSession.worktreePath)
      : null;
    const worktreePath = tmuxSession?.worktreePath || "";
    // DBにrepoPathがない場合はgitコマンドで導出を試みる
    const repoPath =
      dbSession?.repoPath ||
      (worktreePath ? this.deriveRepoPath(worktreePath) : undefined);

    ttydManager.stopInstance(sessionId);
    tmuxManager.killSession(sessionId);
    db.deleteSession(sessionId);
    this.sessionProfiles.delete(sessionId);
    this.unregisterBoardToken(sessionId);
    if (worktreePath) {
      this.repoPathCache.delete(worktreePath);
    }
    this.emit("session:stopped", sessionId);

    return worktreePath ? { worktreePath, repoPath } : null;
  }

  /**
   * IDでセッションを取得
   */
  getSession(sessionId: string): ManagedSession | undefined {
    const tmuxSession = tmuxManager.getSession(sessionId);
    if (!tmuxSession) return undefined;

    // DBからworktreeIdを取得
    const dbSession = db.getSessionByWorktreePath(tmuxSession.worktreePath);
    const worktreeId = dbSession?.worktreeId || "";

    return this.toManagedSession(tmuxSession, worktreeId);
  }

  /**
   * worktreeパスでセッションを取得
   */
  getSessionByWorktree(worktreePath: string): ManagedSession | undefined {
    const tmuxSession = tmuxManager.getSessionByWorktree(worktreePath);
    if (!tmuxSession) return undefined;

    const dbSession = db.getSessionByWorktreePath(worktreePath);
    const worktreeId = dbSession?.worktreeId || "";

    return this.toManagedSession(tmuxSession, worktreeId);
  }

  /**
   * 既存セッションを復元（ttydが起動していなければ起動）
   */
  async restoreSession(
    worktreePath: string
  ): Promise<ManagedSession | undefined> {
    const tmuxSession = tmuxManager.getSessionByWorktree(worktreePath);
    if (!tmuxSession) return undefined;

    // ttydが起動していなければ起動
    let ttydInstance = ttydManager.getInstance(tmuxSession.id);
    if (!ttydInstance) {
      ttydInstance = await ttydManager.startInstance(
        tmuxSession.id,
        tmuxSession.tmuxSessionName
      );
    }

    const dbSession = db.getSessionByWorktreePath(worktreePath);
    const worktreeId = dbSession?.worktreeId || "";

    const managed = this.toManagedSession(tmuxSession, worktreeId);
    this.emit("session:restored", managed);
    return managed;
  }

  /**
   * 全セッションを取得
   */
  getAllSessions(): ManagedSession[] {
    const allSessions = tmuxManager.getAllSessions();
    // 孤立セッション（worktree削除済み）をクリーンアップ
    for (const s of allSessions) {
      if (s.worktreePath && !fs.existsSync(s.worktreePath)) {
        console.log(
          `[Orchestrator] Cleaning up orphaned session: ${s.tmuxSessionName} -> ${s.worktreePath}`
        );
        ttydManager.stopInstance(s.id);
        tmuxManager.killSession(s.id);
        // board token を解除する。削除済み worktree を指す token が registry に
        // 残ると、その token での board_write が realpathSync の ENOENT により
        // 「board scene の保存先 worktree が見つかりません」で失敗し続ける。
        this.unregisterBoardToken(s.id);
        const dbSession = db.getSessionByWorktreePath(s.worktreePath);
        if (dbSession) {
          db.deleteSession(dbSession.id);
        }
        this.sessionProfiles.delete(s.id);
        this.repoPathCache.delete(s.worktreePath);
        this.emit("session:stopped", s.id);
      }
    }
    return tmuxManager.getAllSessions().map(s => {
      const dbSession = db.getSessionByWorktreePath(s.worktreePath);
      return this.toManagedSession(s, dbSession?.worktreeId || "");
    });
  }

  /**
   * ttydのURLを取得
   */
  getTtydUrl(sessionId: string): string | null {
    const instance = ttydManager.getInstance(sessionId);
    if (!instance) return null;
    return `/ttyd/${sessionId}/`;
  }

  /**
   * ttydのポートを取得
   */
  getTtydPort(sessionId: string): number | null {
    const instance = ttydManager.getInstance(sessionId);
    return instance?.port || null;
  }

  /**
   * 全アクティブセッションのプレビューテキストを取得
   */
  getAllPreviews(): Array<{
    sessionId: string;
    text: string;
    activityText: string;
    status: SessionStatus;
    bridgeStatus: BridgeSessionStatus;
    awaitingText?: string;
    timestamp: number;
  }> {
    const allSessions = tmuxManager.getAllSessions();
    const previews: Array<{
      sessionId: string;
      text: string;
      activityText: string;
      status: SessionStatus;
      bridgeStatus: BridgeSessionStatus;
      awaitingText?: string;
      timestamp: number;
    }> = [];

    for (const session of allSessions) {
      // 可視範囲のみ取得 (scrollback 込みだと /clear 後にも過去ログが残り、
      // BridgeSessionStatus の READY 判定や preview 表示が壊れる)
      const raw = tmuxManager.capturePaneVisible(session.id);
      if (raw === null) continue;
      // Bridge dashboard / サイドバードット / RepoGridView で共通利用する状態判定。
      // 既存の text/activityText/status (legacy SessionStatus) と同じ raw から
      // 派生させて、tmux capture を1回で済ませる
      const { status: bridgeStatus } = analyzeBridgeStatus(
        raw,
        session.status === "stopped"
      );
      const allLines = stripAnsi(raw)
        .split("\n")
        .map(line => line.trim())
        .filter(line => line !== "");

      // Claude Code UI行を判定する関数
      const isUiLine = (line: string): boolean => {
        // アニメーション記号行（✢ ✻ や起動アニメーションのブロック要素）は常にUI行として除外
        if (/[✢✻▘▝▛▜▐▌█]/.test(line)) return true;
        // Sautéed/Baked等のアイドル表示
        if (line.includes("Sautéed for")) return true;
        // ステータスバー・モード表示
        if (line.includes("⏵")) return true;
        if (line.includes("bypass permissions")) return true;
        if (line.includes("shift+tab to cycle")) return true;
        if (line.includes("auto mode")) return true;
        if (line.includes("plan mode")) return true;
        // 対話UIのヒント行（Enter to selectは選択待ちなので除外しない）
        if (line.includes("Baked for")) return true;
        if (line.includes("Chat about this")) return true;
        // メニュー選択肢（"1. ...", "S. ...", "a. ..." 等の短い行）
        if (/^[A-Za-z0-9]\.\s/.test(line) && line.length < 60) return true;
        // プロンプト記号のみ
        if (/^[>❯$%#]\s*$/.test(line)) return true;
        // ─ や ━ のみの区切り線
        if (/^[─━═▔▁]{3,}$/.test(line)) return true;
        // Claude Code起動ヘッダー
        if (/^Claude Code\s/.test(line)) return true;
        // モデル情報行（Opus/Sonnet/Haiku + context）
        if (/context\)/.test(line) && /Opus|Sonnet|Haiku/.test(line))
          return true;
        // リポジトリパス表示（~/path や /path でスペースなし）
        if (/^[~/][\w.\-/]+$/.test(line)) return true;
        // Claude Codeスラッシュコマンド（/clear等）
        if (/^\/[a-z][\w-]*$/.test(line)) return true;
        // (no content)表示
        if (line.includes("(no content)")) return true;
        // ツリー文字行（└├│で始まる）
        if (/^[└├│]/.test(line)) return true;
        return false;
      };

      // UI行を除外した最後の行を取得
      const contentLines = allLines.filter(line => !isUiLine(line));
      const text =
        contentLines.length > 0 ? contentLines[contentLines.length - 1] : "";
      // ✢✻行（アイドル時表示用）
      const activityLine = allLines.findLast(line => /[✢✻]/.test(line)) || "";

      // コンテンツ行が空 → idle（起動中アニメーションやno content）
      // コンテンツ行あり → active
      const status: SessionStatus = text === "" ? "idle" : "active";
      // ステータス変化時のみDB更新（不要なI/Oを回避）
      // stopped/errorはライフサイクル駆動のstatusなので上書きしない
      const dbSession = db.getSessionByWorktreePath(session.worktreePath);
      if (
        dbSession &&
        dbSession.status !== "stopped" &&
        dbSession.status !== "error" &&
        dbSession.status !== status
      ) {
        db.updateSessionStatus(session.id, status);
      }

      // AWAITING (ユーザー判断待ち) のときは、確認 UI の生テキストを添える。
      // チャットビューのバナーが「何を聞かれているか」をそのまま表示するため。
      //
      // AUQ ボックス (ヘッダ「☐/☒」行 〜 フッタ「Enter to select/confirm」行) だけを
      // 抽出する。以前は末尾 slice(-18) だったため、選択肢が多い縦長 AUQ では先頭の
      // 質問文/見出しが落ちて ttyd と一致しなかった。
      // ボックスのヘッダ行 (☐/☒) を上端アンカーにすることで、その上にある assistant
      // prose やツール結果 (⎿ = Edit プレビュー/ファイル内容など機密が混じり得る) を
      // 構造上一切含めない (ツール結果の継続行も混入しない)。
      // AUQ_HEADER_RE: AUQ のヘッダ/タブ行 (単問「☐ <header>」/ 複数問タブバー)
      // フッタ正規表現は bridge-collector.ts の AWAITING 検出契約 (先頭空白 0〜2) に
      // 揃える。同じ capture-pane のフッタ行を見ているため、緩い \s* だとインデント
      // された引用/混入行を誤検出し得る。
      const AUQ_FOOTER_RE = /^\s{0,2}Enter to (?:select|confirm)\b/;
      // AUQ ヘッダ/タブ行: 行頭 (任意の先頭空白 + 複数問タブの「←」) の直後に
      // チェックボックス記号。本文・選択肢内に紛れた ☐/☒ を誤検出しないよう
      // 行頭形状に限定する。
      const AUQ_HEADER_RE = /^\s*(?:←\s*)?[☐☒]\s/;
      // ツール結果 (⎿) / assistant 出力ブロック (●) の「先頭行」。継続行は
      // toolBlockEnd でインデントから判定し、ブロックごと除外する。
      const BLOCK_START_RE = /^\s*(?:⎿|●)/;
      const MAX_SCAN_LINES = 60; // ヘッダ探索の上限 (暴走防止)
      const FALLBACK_TAIL_LINES = 20; // フッタ未検出時に出す末尾行数の上限
      let awaitingText: string | undefined;
      if (bridgeStatus === "AWAITING") {
        const rawLines = stripAnsi(raw)
          .split("\n")
          .map(l => l.replace(/\s+$/, ""));
        while (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
          rawLines.pop();
        }
        // ⎿/● ブロックを「先頭行 + それより深いインデントの継続行 (空行含む)」と
        // みなし、ブロック直後の行 index を返す。継続行 (⎿ Edited 配下の差分や
        // ファイル内容) がバナーへ漏れるのを防ぐ。選択肢/プロンプト (先頭行と同等
        // 以下のインデント) で打ち切る。
        const toolBlockEnd = (headerIdx: number): number => {
          const headerIndent =
            rawLines[headerIdx].match(/^\s*/)?.[0].length ?? 0;
          let j = headerIdx + 1;
          while (j < rawLines.length) {
            const line = rawLines[j];
            if (line === "") {
              j++;
              continue;
            }
            const indent = line.match(/^\s*/)?.[0].length ?? 0;
            if (indent > headerIndent) {
              j++;
              continue;
            }
            break;
          }
          return j;
        };
        let footerIdx = -1;
        for (let i = rawLines.length - 1; i >= 0; i--) {
          if (AUQ_FOOTER_RE.test(rawLines[i])) {
            footerIdx = i;
            break;
          }
        }
        if (footerIdx >= 0) {
          // フッタから上へヘッダ (☐/☒) を探す。ヘッダ = ボックス先頭なので
          // それ以上は遡らない。ヘッダ前にツール結果ブロックに当たったら、
          // ブロック (継続行含む) を丸ごと除外した直後から開始する。
          let startIdx = footerIdx;
          for (
            let i = footerIdx - 1;
            i >= 0 && footerIdx - i <= MAX_SCAN_LINES;
            i--
          ) {
            if (AUQ_HEADER_RE.test(rawLines[i])) {
              startIdx = i;
              break;
            }
            if (BLOCK_START_RE.test(rawLines[i])) {
              startIdx = toolBlockEnd(i);
              break;
            }
            startIdx = i;
          }
          // 除外の結果フッタしか残らない場合があるため start<=footer を保証
          if (startIdx > footerIdx) startIdx = footerIdx;
          awaitingText = rawLines.slice(startIdx, footerIdx + 1).join("\n");
        } else {
          // フッタ未検出 (permission プロンプト等)。末尾 FALLBACK_TAIL_LINES 行を窓と
          // し、その中で最下位のツール結果ブロックを検出したら、ブロック (継続行含む)
          // を丸ごと除外した直後から下を出す (フッタが無くてもツール出力を漏らさない)。
          let startIdx = Math.max(0, rawLines.length - FALLBACK_TAIL_LINES);
          for (let i = rawLines.length - 1; i >= startIdx; i--) {
            if (BLOCK_START_RE.test(rawLines[i])) {
              startIdx = toolBlockEnd(i);
              break;
            }
          }
          awaitingText = rawLines.slice(startIdx).join("\n");
        }
      }

      previews.push({
        sessionId: session.id,
        text,
        activityText: activityLine,
        status,
        bridgeStatus,
        awaitingText,
        timestamp: Date.now(),
      });
    }

    return previews;
  }

  /**
   * リソースをクリーンアップ
   * 注意: tmuxセッションは永続化のため終了しない
   */
  cleanup(): void {
    ttydManager.cleanup();
    // tmuxManager.cleanup() は呼ばない - セッション永続化のため
  }
}

export const sessionOrchestrator = new SessionOrchestrator();
