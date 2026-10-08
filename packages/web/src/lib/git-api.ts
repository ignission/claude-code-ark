import type {
  ClientToServerEvents,
  GitCommitResponse,
  GitDiffTarget,
  GitFileDiffResponse,
  GitFingerprintResponse,
  GitLogResponse,
  GitRefsResponse,
  GitStatusResponse,
  ServerToClientEvents,
} from "@ark/shared";
import type { Socket } from "socket.io-client";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** サーバーは不正な payload に ack を返さないので、必ずここで打ち切る */
const ACK_TIMEOUT_MS = 5000;
const NO_RESPONSE = "サーバーから応答がありません";

type GitEvent =
  | "git:log"
  | "git:refs"
  | "git:status"
  | "git:commit"
  | "git:file-diff"
  | "git:fingerprint";

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
}

/** ack を Promise にする薄い層。5 秒で timeout し、失敗応答に畳む */
export function createGitApi(socket: TypedSocket, sessionId: string): GitApi {
  // 型付き emit の overload を経由せず、イベント名ごとの呼び出しをここに閉じ込める
  const request = <R extends { ok: boolean }>(
    event: GitEvent,
    payload: Record<string, unknown>
  ): Promise<R> =>
    new Promise(resolve => {
      // biome-ignore lint/suspicious/noExplicitAny: イベント名でpayload型が変わるため
      (socket.timeout(ACK_TIMEOUT_MS) as any).emit(
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
  };
}
