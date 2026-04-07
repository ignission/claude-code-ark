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
        continue;
      }

      // DBにセッション情報があればstatusを尊重（idle等の永続化された状態を維持）
      const dbSession = db.getSessionByWorktreePath(tmuxSession.worktreePath);
      if (dbSession) {
        console.log(
          `[Orchestrator] Restored session: ${tmuxSession.tmuxSessionName} -> ${dbSession.id} (status: ${dbSession.status})`
        );
        // repoPathが未設定ならgitから導出して保存
        if (!dbSession.repoPath && tmuxSession.worktreePath) {
          const repoPath = this.deriveRepoPath(tmuxSession.worktreePath);
          if (repoPath) {
            db.updateSessionRepoPath(dbSession.id, repoPath);
          }
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

    // repoPathがDBにない場合はgitから導出して保存
    let repoPath = dbSession?.repoPath;
    if (!repoPath && tmuxSession.worktreePath) {
      repoPath = this.deriveRepoPath(tmuxSession.worktreePath);
      if (repoPath && dbSession) {
        db.updateSessionRepoPath(dbSession.id, repoPath);
      }
    }

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
    };
  }

  /** worktreePathからメインリポジトリのパスを導出 */
  private deriveRepoPath(worktreePath: string): string | undefined {
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
      return gitCommonDir.replace(/\/\.git\/?$/, "") || undefined;
    } catch {
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
   * 新規セッションを開始
   */
  async startSession(
    worktreeId: string,
    worktreePath: string,
    repoPath?: string
  ): Promise<ManagedSession> {
    // 既存セッションがあれば再利用
    const existingTmux = tmuxManager.getSessionByWorktree(worktreePath);
    if (existingTmux) {
      // repoPathが渡された場合はDBを更新（既存セッションにrepoPath情報を補完）
      if (repoPath) {
        const dbSession = db.getSessionByWorktreePath(worktreePath);
        if (dbSession && !dbSession.repoPath) {
          db.updateSessionRepoPath(dbSession.id, repoPath);
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

      const managed = this.toManagedSession(existingTmux, worktreeId);
      this.emit("session:restored", managed);
      return managed;
    }

    // 新規tmuxセッションを作成
    const tmuxSession = await tmuxManager.createSession(worktreePath);

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
      repoPath,
      status: "active",
    });

    const managed: ManagedSession = {
      id: tmuxSession.id,
      worktreeId,
      worktreePath,
      repoPath,
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
