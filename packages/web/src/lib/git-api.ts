import type {
  ClientToServerEvents,
  GitBranchDeleteResponse,
  GitCommitResponse,
  GitDiffTarget,
  GitFileDiffResponse,
  GitFingerprintResponse,
  GitLogResponse,
  GitOpResponse,
  GitPushResponse,
  GitRefsResponse,
  GitStatusResponse,
  ServerToClientEvents,
} from "@ark/shared";
import type { Socket } from "socket.io-client";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** サーバーは不正な payload に ack を返さないので、必ずここで打ち切る */
const ACK_TIMEOUT_MS = 5000;
/**
 * リモートの操作の待ち。サーバー側の git の timeout (2 分) より長くし、
 * サーバーが push をやり終えたのに画面だけ「応答がない」と出す食い違いを防ぐ
 */
const REMOTE_ACK_TIMEOUT_MS = 130_000;
const NO_RESPONSE = "サーバーから応答がありません";

type GitEvent =
  | "git:log"
  | "git:refs"
  | "git:status"
  | "git:commit"
  | "git:file-diff"
  | "git:fingerprint"
  | "git:branch-create"
  | "git:branch-rename"
  | "git:branch-delete"
  | "git:remote-branch-delete"
  | "git:fetch"
  | "git:pull"
  | "git:push";

export interface GitApi {
  log: (skip: number, limit: number) => Promise<GitLogResponse>;
  refs: () => Promise<GitRefsResponse>;
  status: () => Promise<GitStatusResponse>;
  commit: (sha: string) => Promise<GitCommitResponse>;
  fileDiff: (
    target: GitDiffTarget,
    path: string,
    oldPath?: string
  ) => Promise<GitFileDiffResponse>;
  fingerprint: () => Promise<GitFingerprintResponse>;
  createBranch: (name: string, startPoint: string) => Promise<GitOpResponse>;
  renameBranch: (from: string, to: string) => Promise<GitOpResponse>;
  deleteBranch: (
    name: string,
    force: boolean
  ) => Promise<GitBranchDeleteResponse>;
  deleteRemoteBranch: (remote: string, name: string) => Promise<GitOpResponse>;
  fetch: () => Promise<GitOpResponse>;
  pull: () => Promise<GitOpResponse>;
  push: (name: string) => Promise<GitPushResponse>;
}

/** ack を Promise にする薄い層。5 秒 (リモートの操作は 130 秒) で timeout し、失敗応答に畳む */
export function createGitApi(socket: TypedSocket, sessionId: string): GitApi {
  // 型付き emit の overload を経由せず、イベント名ごとの呼び出しをここに閉じ込める
  const request = <R extends { ok: boolean }>(
    event: GitEvent,
    payload: Record<string, unknown>,
    timeoutMs = ACK_TIMEOUT_MS
  ): Promise<R> =>
    new Promise(resolve => {
      // biome-ignore lint/suspicious/noExplicitAny: イベント名でpayload型が変わるため
      (socket.timeout(timeoutMs) as any).emit(
        event,
        { sessionId, ...payload },
        (err: Error | null, res: R) =>
          resolve(
            err || !res
              ? ({ ok: false, error: NO_RESPONSE } as unknown as R)
              : res
          )
      );
    });

  return {
    log: (skip, limit) => request<GitLogResponse>("git:log", { skip, limit }),
    refs: () => request<GitRefsResponse>("git:refs", {}),
    status: () => request<GitStatusResponse>("git:status", {}),
    commit: sha => request<GitCommitResponse>("git:commit", { sha }),
    fileDiff: (target, path, oldPath) =>
      request<GitFileDiffResponse>("git:file-diff", { target, path, oldPath }),
    fingerprint: () => request<GitFingerprintResponse>("git:fingerprint", {}),
    createBranch: (name, startPoint) =>
      request<GitOpResponse>("git:branch-create", { name, startPoint }),
    renameBranch: (from, to) =>
      request<GitOpResponse>("git:branch-rename", { from, to }),
    deleteBranch: (name, force) =>
      request<GitBranchDeleteResponse>("git:branch-delete", { name, force }),
    deleteRemoteBranch: (remote, name) =>
      request<GitOpResponse>(
        "git:remote-branch-delete",
        { remote, name },
        REMOTE_ACK_TIMEOUT_MS
      ),
    fetch: () => request<GitOpResponse>("git:fetch", {}, REMOTE_ACK_TIMEOUT_MS),
    pull: () => request<GitOpResponse>("git:pull", {}, REMOTE_ACK_TIMEOUT_MS),
    push: name =>
      request<GitPushResponse>("git:push", { name }, REMOTE_ACK_TIMEOUT_MS),
  };
}
