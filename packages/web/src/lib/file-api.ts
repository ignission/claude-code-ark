import type {
  ClientToServerEvents,
  FileListResponse,
  FileOpenResponse,
  FileWriteResponse,
  ServerToClientEvents,
} from "@ark/shared";
import type { Socket } from "socket.io-client";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** サーバーは不正な payload に ack を返さないので、必ずここで打ち切る */
const ACK_TIMEOUT_MS = 5000;
const NO_RESPONSE = "サーバーから応答がありません";

export interface FileApi {
  open: (filePath: string) => Promise<FileOpenResponse>;
  list: (dirPath: string) => Promise<FileListResponse>;
  write: (
    filePath: string,
    content: string,
    expectedMtimeMs: number,
    force?: boolean
  ) => Promise<FileWriteResponse>;
  /** 戻り値を呼ぶと解除する。再接続時は張り直す */
  subscribe: (filePath: string, onUpdated: () => void) => () => void;
}

/** ack を Promise にする薄い層。5 秒で timeout し、失敗応答に畳む */
export function createFileApi(socket: TypedSocket, sessionId: string): FileApi {
  // 型付きemitのoverloadを経由せず、イベント名ごとの呼び出しをここに閉じ込める
  const request = <R>(
    event: "file:open" | "file:list" | "file:write",
    payload: Record<string, unknown>,
    fallback: (error: string) => R
  ): Promise<R> =>
    new Promise(resolve => {
      // biome-ignore lint/suspicious/noExplicitAny: イベント名でpayload型が変わるため
      (socket.timeout(ACK_TIMEOUT_MS) as any).emit(
        event,
        payload,
        (err: Error | null, res: R) =>
          resolve(err || !res ? fallback(NO_RESPONSE) : res)
      );
    });

  // サーバーの購読はsessionId + filePathに1つで、解除は無条件に消える。
  // そのため同じfilePathの購読者は数えて束ね、0 -> 1 / 1 -> 0のときだけ送る
  const subscriptions = new Map<
    string,
    {
      callbacks: Set<() => void>;
      onFileUpdated: (data: { sessionId: string; filePath: string }) => void;
      emitSubscribe: () => void;
    }
  >();

  return {
    open: filePath =>
      request<FileOpenResponse>(
        "file:open",
        { sessionId, filePath },
        error => ({ ok: false, error }) as FileOpenResponse
      ),
    list: dirPath =>
      request<FileListResponse>("file:list", { sessionId, dirPath }, error => ({
        ok: false,
        error,
      })),
    write: (filePath, content, expectedMtimeMs, force) =>
      request<FileWriteResponse>(
        "file:write",
        { sessionId, filePath, content, expectedMtimeMs, force },
        error => ({ ok: false, code: "error", error })
      ),
    subscribe: (filePath, onUpdated) => {
      let entry = subscriptions.get(filePath);
      if (!entry) {
        const callbacks = new Set<() => void>();
        const onFileUpdated = (data: {
          sessionId: string;
          filePath: string;
        }) => {
          if (data.sessionId === sessionId && data.filePath === filePath) {
            for (const cb of [...callbacks]) cb();
          }
        };
        socket.on("file:updated", onFileUpdated);
        const subscribeOnly = () =>
          socket.emit("file:subscribe", { sessionId, filePath });
        // サーバー側の購読は切断で消えるので、接続のたびに張り直す。切れている間の
        // 変更は通知されないので、張り直したら購読側に読み直させる
        const emitSubscribe = () => {
          subscribeOnly();
          for (const cb of [...callbacks]) cb();
        };
        socket.on("connect", emitSubscribe);
        subscribeOnly();
        entry = { callbacks, onFileUpdated, emitSubscribe };
        subscriptions.set(filePath, entry);
      }
      // 同じlistenerを2回登録しても1回の解除で外れないよう、呼び出しごとに包む
      const callback = () => onUpdated();
      entry.callbacks.add(callback);
      const current = entry;
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        current.callbacks.delete(callback);
        if (current.callbacks.size > 0) return;
        socket.off("file:updated", current.onFileUpdated);
        socket.off("connect", current.emitSubscribe);
        subscriptions.delete(filePath);
        socket.emit("file:unsubscribe", { sessionId, filePath });
      };
    },
  };
}
