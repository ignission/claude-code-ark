/**
 * Session Orchestrator
 *
 * tmuxセッションとttydインスタンスを統合管理。
 * セッションライフサイクルの統一APIを提供する。
 */

import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type {
  ManagedSession,
  SessionStatus,
  SpecialKey,
} from "../../shared/types.js";
import { stripAnsi } from "./ansi.js";
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

  constructor() {
    super();
    this.setupEventForwarding();
    this.restoreExistingSessions();
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
            : null;
        this.sessionProfiles.set(dbSession.id, restoredProfile);
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

    // 起動時に確定したプロファイルと、現在のリポジトリ紐付け+プロファイル状態
    // を比較して staleProfile を判定する。
    // - profileId 切替 (null↔id、id↔別id) → stale
    // - 同一profileIdでも configDir が変わった場合も stale
    //   (tmux env は起動時に固定されるため再起動しないと反映されない)
    const current = this.sessionProfiles.get(tmuxSession.id) ?? null;
    const link = repoPath ? db.getRepoProfileLink(repoPath) : null;
    const desiredProfile = link ? db.getProfile(link.profileId) : null;
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
      staleProfile,
    };
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
   * - 紐付け無し → null env / null snapshot
   * - 紐付けあるが profile が無い（削除済等）→ null env / null snapshot
   * - 紐付けあり → env={CLAUDE_CONFIG_DIR}, snapshot={id, configDir}
   *
   * configDir/.credentials.json の存在チェックは行わない。claude CLI が
   * 必要なら自動で /login を促す。
   */
  private resolveProfileForRepo(repoPath: string | undefined): {
    env: Record<string, string> | undefined;
    snapshot: { id: string; configDir: string } | null;
  } {
    if (!repoPath) {
      return { env: undefined, snapshot: null };
    }
    const link = db.getRepoProfileLink(repoPath);
    if (!link) {
      return { env: undefined, snapshot: null };
    }
    const profile = db.getProfile(link.profileId);
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
    const { env, snapshot } = this.resolveProfileForRepo(resolvedRepoPath);

    // 新規tmuxセッションを作成（envがあれば注入）
    const tmuxSession = await tmuxManager.createSession(
      worktreePath,
      env ? { env } : undefined
    );

    // ttydインスタンスを起動
    const ttydInstance = await ttydManager.startInstance(
      tmuxSession.id,
      tmuxSession.tmuxSessionName
    );

    // DBに保存（既存レコードがあればupsertで更新）
    db.upsertSession({
      id: tmuxSession.id,
      worktreeId,
      worktreePath,
      repoPath: resolvedRepoPath,
      status: "active",
      profileId: snapshot?.id ?? null,
      profileConfigDir: snapshot?.configDir ?? null,
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
   * 内部処理:
   * 1. ttyd 停止 / tmux kill / sessionProfiles/repoPathCacheクリア
   * 2. startSession を再呼び出し（env が再解決される）
   *
   * @throws sessionId に対応する tmux セッションが見つからない場合
   */
  async restartSession(sessionId: string): Promise<ManagedSession> {
    const tmuxSession = tmuxManager.getSession(sessionId);
    if (!tmuxSession) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const worktreePath = tmuxSession.worktreePath;
    const dbSession = db.getSessionByWorktreePath(worktreePath);
    const worktreeId = dbSession?.worktreeId || "";
    // repoPathはDBからの値もしくはgit導出を優先（startSessionで再解決される）
    const repoPath =
      dbSession?.repoPath ||
      (worktreePath ? this.deriveRepoPath(worktreePath) : undefined);

    // 既存リソースを停止 + DB エントリ削除
    // (新セッションは別の sessionId で作成されるため、古い ID をクライアントから
    // 消さないと「再起動」のたびにセッション一覧に古いエントリが残ってしまう)
    ttydManager.stopInstance(sessionId);
    tmuxManager.killSession(sessionId);
    db.deleteSession(sessionId);
    this.sessionProfiles.delete(sessionId);
    this.repoPathCache.delete(worktreePath);
    // 古いセッション ID の停止をクライアントへ通知 → UI から消える
    this.emit("session:stopped", sessionId);

    // 新しい env で再起動 (新しい sessionId で session:created が発火)
    const managed = await this.startSession(worktreeId, worktreePath, repoPath);
    return managed;
  }

  /**
   * 指定セッションの staleProfile を再評価する。
   *
   * `repo:set-profile` 等で紐付けが変わった際に、稼働中セッションの
   * staleProfile を再計算してクライアントへ反映するためのヘルパー。
   *
   * @returns 現在 staleProfile かどうか（セッション不存在時は false）
   */
  recomputeStaleProfile(sessionId: string): boolean {
    const tmuxSession = tmuxManager.getSession(sessionId);
    if (!tmuxSession) return false;
    const repoPath = tmuxSession.worktreePath
      ? this.deriveRepoPath(tmuxSession.worktreePath)
      : undefined;
    const link = repoPath ? db.getRepoProfileLink(repoPath) : null;
    const desired = link ? db.getProfile(link.profileId) : null;
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
    timestamp: number;
  }> {
    const allSessions = tmuxManager.getAllSessions();
    const previews: Array<{
      sessionId: string;
      text: string;
      activityText: string;
      status: SessionStatus;
      timestamp: number;
    }> = [];

    for (const session of allSessions) {
      const raw = tmuxManager.capturePane(session.id, 200);
      if (raw === null) continue;
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

      previews.push({
        sessionId: session.id,
        text,
        activityText: activityLine,
        status,
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
