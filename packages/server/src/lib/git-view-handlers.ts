/**
 * Git タブ用の socket ハンドラ (読み取りだけ。すべて ack)。
 * socket のペイロードは信頼できないので、形と値を確かめてから git に渡す。
 * ハンドラ内の throw はプロセスを落とすため、全体を try/catch で包む。
 */

import type {
  GitCommitResponse,
  GitDiffTarget,
  GitFileDiffResponse,
  GitFingerprintResponse,
  GitLogResponse,
  GitRefsResponse,
  GitStatusResponse,
} from "@ark/shared";
import {
  getCommit,
  getFileDiff,
  getFingerprint,
  getLog,
  getRefs,
  getStatus,
  isSafeRelPath,
  isValidSha,
} from "./git-view.js";

export interface GitViewHandlersDeps {
  getWorktreePath: (sessionId: string) => string | undefined;
}

type Reply<T> = (r: T) => void;
type Failure = { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseTarget(v: unknown): GitDiffTarget | null {
  if (!isRecord(v)) return null;
  switch (v.kind) {
    case "commit":
      return isValidSha(v.sha) ? { kind: "commit", sha: v.sha } : null;
    case "staged":
    case "unstaged":
    case "untracked":
      return { kind: v.kind };
    default:
      return null;
  }
}

export function createGitViewHandlers(deps: GitViewHandlersDeps) {
  /**
   * 共通の外殻: cb が関数で data が { sessionId: string } を持つときだけ動く。
   * run が null を返したらペイロード不正として黙って捨てる。
   */
  function handler<T extends { ok: true }>(
    run: (
      cwd: string,
      data: Record<string, unknown>
    ) => Promise<Omit<T, "ok"> | null> | null
  ) {
    return async (data: unknown, cb: unknown): Promise<void> => {
      if (typeof cb !== "function") return;
      const reply = cb as Reply<T | Failure>;
      try {
        if (!isRecord(data) || typeof data.sessionId !== "string") return;
        const cwd = deps.getWorktreePath(data.sessionId);
        if (cwd === undefined) {
          return reply({ ok: false, error: "セッションが見つかりません" });
        }
        const result = await run(cwd, data);
        if (result === null) return;
        reply({ ok: true, ...result } as T);
      } catch (err) {
        try {
          reply({ ok: false, error: errorMessage(err) });
        } catch {
          // ack 自体の失敗は握りつぶす (切断済みなど)
        }
      }
    };
  }

  const log = handler<Extract<GitLogResponse, { ok: true }>>((cwd, d) => {
    if (!Number.isFinite(d.skip) || !Number.isFinite(d.limit)) return null;
    return getLog(cwd, d.skip as number, d.limit as number);
  });

  const refs = handler<Extract<GitRefsResponse, { ok: true }>>(cwd =>
    getRefs(cwd)
  );

  const status = handler<Extract<GitStatusResponse, { ok: true }>>(cwd =>
    getStatus(cwd)
  );

  const commit = handler<Extract<GitCommitResponse, { ok: true }>>((cwd, d) =>
    isValidSha(d.sha) ? getCommit(cwd, d.sha) : null
  );

  const fileDiff = handler<Extract<GitFileDiffResponse, { ok: true }>>(
    (cwd, d) => {
      const target = parseTarget(d.target);
      if (!target || !isSafeRelPath(d.path)) return null;
      if (d.oldPath !== undefined && !isSafeRelPath(d.oldPath)) return null;
      return getFileDiff(cwd, target, d.path, d.oldPath as string | undefined);
    }
  );

  const fingerprint = handler<Extract<GitFingerprintResponse, { ok: true }>>(
    async cwd => ({ fingerprint: await getFingerprint(cwd) })
  );

  return { log, refs, status, commit, fileDiff, fingerprint };
}
