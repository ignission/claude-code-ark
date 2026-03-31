/**
 * Session Orchestrator
 *
 * tmuxセッションとttydインスタンスを統合管理。
 * セッションライフサイクルの統一APIを提供する。
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import type {
  ManagedSession,
  SessionStatus,
  SpecialKey,
} from "../../shared/types.js";
import { db } from "./database.js";
import { type TmuxSession, tmuxManager } from "./tmux-manager.js";
import { ttydManager } from "./ttyd-manager.js";

export type { ManagedSession };

export class SessionOrchestrator extends EventEmitter {
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
          `[Orchestrator] Cleaning up orphaned session (worktree deleted): ${tmuxSession.tmuxSessionName} -> ${tmuxSession.worktreePath}`,
        );
        tmuxManager.killSession(tmuxSession.id);
        const dbSession = db.getSessionByWorktreePath(tmuxSession.worktreePath);
        if (dbSession) {
          db.updateSessionStatus(dbSession.id, "stopped");
        }
        continue;
      }

      // DBにセッション情報があれば更新
      const dbSession = db.getSessionByWorktreePath(tmuxSession.worktreePath);
      if (dbSession) {
        console.log(
          `[Orchestrator] Restored session: ${tmuxSession.tmuxSessionName} -> ${dbSession.id}`,
        );
      }

      // ttydも自動起動（起動完了後にクライアントへ通知）
      ttydManager
        .startInstance(tmuxSession.id, tmuxSession.tmuxSessionName)
        .then(() => {
          console.log(
            `[Orchestrator] Started ttyd for restored session: ${tmuxSession.id}`,
          );
          // ttyd起動完了をクライアントに通知（ttydPort/ttydUrlを含む最新情報を送信）
          const dbSession = db.getSessionByWorktreePath(
            tmuxSession.worktreePath,
          );
          const managed = this.toManagedSession(
            tmuxSession,
            dbSession?.worktreeId || "",
          );
          this.emit("session:updated", managed);
        })
        .catch((err) => {
          console.error(
            `[Orchestrator] Failed to start ttyd for ${tmuxSession.id}:`,
            err.message,
          );
        });
    }
  }

  /**
   * TmuxSessionをManagedSessionに変換
   */
  private toManagedSession(
    tmuxSession: TmuxSession,
    worktreeId: string,
  ): ManagedSession {
    const ttydInstance = ttydManager.getInstance(tmuxSession.id);
    return {
      id: tmuxSession.id,
      worktreeId,
      worktreePath: tmuxSession.worktreePath,
      status: this.mapTmuxStatus(tmuxSession.status),
      createdAt: tmuxSession.createdAt,
      tmuxSessionName: tmuxSession.tmuxSessionName,
      ttydPort: ttydInstance?.port || null,
      ttydUrl: ttydInstance ? `/ttyd/${tmuxSession.id}/` : null,
    };
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
   * 新規セッションを開始
   */
  async startSession(
    worktreeId: string,
    worktreePath: string,
  ): Promise<ManagedSession> {
    // 既存セッションがあれば再利用
    const existingTmux = tmuxManager.getSessionByWorktree(worktreePath);
    if (existingTmux) {
      // ttydが起動していなければ起動
      let ttydInstance = ttydManager.getInstance(existingTmux.id);
      if (!ttydInstance) {
        ttydInstance = await ttydManager.startInstance(
          existingTmux.id,
          existingTmux.tmuxSessionName,
        );
      }

      const managed = this.toManagedSession(existingTmux, worktreeId);
      this.emit("session:restored", managed);
      return managed;
    }

    // 新規tmuxセッションを作成
    const tmuxSession = await tmuxManager.createSession(worktreePath);

    // ttydインスタンスを起動
    const ttydInstance = await ttydManager.startInstance(
      tmuxSession.id,
      tmuxSession.tmuxSessionName,
    );

    // DBに保存（既存レコードがあればupsertで更新、idは既存値を維持）
    db.upsertSession({
      id: tmuxSession.id,
      worktreeId,
      worktreePath,
      status: "active",
    });

    // upsertではidが更新されないため、DB上の実際のidを取得して使用する
    const dbSession = db.getSessionByWorktreePath(worktreePath);
    const sessionId = dbSession?.id ?? tmuxSession.id;

    const managed: ManagedSession = {
      id: sessionId,
      worktreeId,
      worktreePath,
      status: "active",
      createdAt: tmuxSession.createdAt,
      tmuxSessionName: tmuxSession.tmuxSessionName,
      ttydPort: ttydInstance.port,
      ttydUrl: `/ttyd/${tmuxSession.id}/`,
    };

    this.emit("session:created", managed);
    return managed;
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
   * セッションを停止
   */
  stopSession(sessionId: string): void {
    ttydManager.stopInstance(sessionId);
    tmuxManager.killSession(sessionId);
    db.updateSessionStatus(sessionId, "stopped");
    this.emit("session:stopped", sessionId);
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
    worktreePath: string,
  ): Promise<ManagedSession | undefined> {
    const tmuxSession = tmuxManager.getSessionByWorktree(worktreePath);
    if (!tmuxSession) return undefined;

    // ttydが起動していなければ起動
    let ttydInstance = ttydManager.getInstance(tmuxSession.id);
    if (!ttydInstance) {
      ttydInstance = await ttydManager.startInstance(
        tmuxSession.id,
        tmuxSession.tmuxSessionName,
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
          `[Orchestrator] Cleaning up orphaned session: ${s.tmuxSessionName} -> ${s.worktreePath}`,
        );
        ttydManager.stopInstance(s.id);
        tmuxManager.killSession(s.id);
        const dbSession = db.getSessionByWorktreePath(s.worktreePath);
        if (dbSession) {
          db.updateSessionStatus(dbSession.id, "stopped");
        }
        this.emit("session:stopped", s.id);
      }
    }
    return tmuxManager.getAllSessions().map((s) => {
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
   * リソースをクリーンアップ
   * 注意: tmuxセッションは永続化のため終了しない
   */
  cleanup(): void {
    ttydManager.cleanup();
    // tmuxManager.cleanup() は呼ばない - セッション永続化のため
  }
}

export const sessionOrchestrator = new SessionOrchestrator();
