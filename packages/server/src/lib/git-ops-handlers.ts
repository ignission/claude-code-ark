/**
 * Git タブの書き込み操作の socket ハンドラ (すべて ack)。
 * 読み取り (git-view-handlers.ts) と違い、入力の誤りは黙って捨てず理由を返す
 * (利用者が打ったブランチ名が通らない理由を画面に出すため)。
 * 同じ worktree への操作は重ねない。実行中に届いた操作は待たせず断る (待たせると
 * クライアントの ack の待ちが先に切れ、失敗と出たあとで実行されてしまう)。
 * 実行中の印は socket をまたいで共有する (別のタブ・再接続からの操作も重ねない)
 */

import type {
  GitBranchDeleteResponse,
  GitOpResponse,
  GitPushResponse,
} from "@ark/shared";
import {
  createBranch,
  deleteBranch,
  deleteRemoteBranch,
  fetchAll,
  GitOpError,
  pullFastForward,
  pushBranch,
  renameBranch,
} from "./git-ops.js";

export interface GitOpsHandlersDeps {
  getWorktreePath: (sessionId: string) => string | undefined;
  /**
   * ブランチの名前を変えたあと。セッション一覧やコマンドパレットは worktree の一覧から
   * ブランチ名を出すので、一覧を配り直させる (別のセッションのブランチを変えた場合も)
   */
  onBranchRenamed?: (sessionId: string) => void;
  /**
   * 作業ツリーを消す。そこで動いているセッションを止め、worktree の一覧を配り直す
   * (サイドバーの「削除」と同じ後始末)。ブランチを作業ツリーごと消すときに使う
   */
  removeWorktree?: (sessionId: string, worktreePath: string) => Promise<void>;
}

type Data = Record<string, unknown>;
type Failure = {
  ok: false;
  error: string;
  notMerged?: boolean;
  inWorktree?: string;
};

function isRecord(v: unknown): v is Data {
  return typeof v === "object" && v !== null;
}

function toFailure(err: unknown): Failure {
  if (err instanceof GitOpError) {
    return {
      ok: false,
      error: err.message,
      ...(err.notMerged && { notMerged: true }),
      ...(err.inWorktree && { inWorktree: err.inWorktree }),
    };
  }
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

/** 操作の実行中の worktree。socket ごとではなくプロセスで 1 つ持つ */
const runningWorktrees = new Set<string>();

export function createGitOpsHandlers(deps: GitOpsHandlersDeps) {
  async function exclusive<T>(cwd: string, run: () => Promise<T>): Promise<T> {
    if (runningWorktrees.has(cwd)) {
      throw new GitOpError("別の Git の操作が実行中です");
    }
    runningWorktrees.add(cwd);
    try {
      return await run();
    } finally {
      runningWorktrees.delete(cwd);
    }
  }

  function handler<T extends { ok: true }>(
    run: (cwd: string, data: Data) => Promise<Omit<T, "ok">>
  ) {
    return async (data: unknown, cb: unknown): Promise<void> => {
      if (typeof cb !== "function") return;
      const reply = cb as (r: T | Failure) => void;
      try {
        if (!isRecord(data) || typeof data.sessionId !== "string") {
          return reply({ ok: false, error: "要求の形が不正です" });
        }
        const cwd = deps.getWorktreePath(data.sessionId);
        if (cwd === undefined) {
          return reply({ ok: false, error: "セッションが見つかりません" });
        }
        const result = await exclusive(cwd, () => run(cwd, data));
        reply({ ok: true, ...result } as T);
      } catch (err) {
        try {
          reply(toFailure(err));
        } catch {
          // ack 自体の失敗は握りつぶす (切断済みなど)
        }
      }
    };
  }

  type Ok = Extract<GitOpResponse, { ok: true }>;
  const done = async () => ({});

  return {
    branchCreate: handler<Ok>((cwd, d) =>
      createBranch(cwd, d.name, d.startPoint, d.upstream).then(done)
    ),
    branchRename: handler<Ok>(async (cwd, d) => {
      await renameBranch(cwd, d.from, d.to);
      deps.onBranchRenamed?.(d.sessionId as string);
      return {};
    }),
    branchDelete: handler<Extract<GitBranchDeleteResponse, { ok: true }>>(
      (cwd, d) => {
        const remove = deps.removeWorktree;
        return deleteBranch(cwd, d.name, d.force === true, {
          removeWorktree:
            d.removeWorktree === true && remove
              ? path => remove(d.sessionId as string, path)
              : undefined,
        });
      }
    ),
    remoteBranchDelete: handler<Ok>((cwd, d) =>
      deleteRemoteBranch(cwd, d.remote, d.name).then(done)
    ),
    fetch: handler<Ok>(cwd => fetchAll(cwd).then(done)),
    pull: handler<Ok>(cwd => pullFastForward(cwd).then(done)),
    push: handler<Extract<GitPushResponse, { ok: true }>>((cwd, d) =>
      pushBranch(cwd, d.name)
    ),
  };
}
