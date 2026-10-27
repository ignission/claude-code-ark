import type {
  ClientToServerEvents,
  ServerToClientEvents,
  TodoListResponse,
  TodoOpResponse,
} from "@ark/shared";
import type { Socket } from "socket.io-client";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** サーバーは不正な payload に ack を返さないので、必ずここで打ち切る */
const ACK_TIMEOUT_MS = 5000;
const NO_RESPONSE = "サーバーから応答がありません";

type TodoEvent =
  | "todo:list"
  | "todo:set-done"
  | "todo:set-started"
  | "todo:delete";

export interface TodoApi {
  list: () => Promise<TodoListResponse>;
  setDone: (id: string, done: boolean) => Promise<TodoOpResponse>;
  remove: (id: string) => Promise<TodoOpResponse>;
  /** 会話を始めた先の worktree を記録する */
  setStarted: (id: string, worktreePath: string) => Promise<TodoOpResponse>;
}

/** ack を Promise にする薄い層。5 秒で timeout し、失敗応答に畳む */
export function createTodoApi(socket: TypedSocket): TodoApi {
  const request = <R extends { ok: boolean }>(
    event: TodoEvent,
    payload: Record<string, unknown>
  ): Promise<R> =>
    new Promise(resolve => {
      // biome-ignore lint/suspicious/noExplicitAny: イベント名でpayload型が変わるため
      (socket.timeout(ACK_TIMEOUT_MS) as any).emit(
        event,
        payload,
        (err: Error | null, res: R) =>
          resolve(
            err ? ({ ok: false, error: NO_RESPONSE } as unknown as R) : res
          )
      );
    });
  return {
    list: () => request("todo:list", {}),
    setDone: (id, done) => request("todo:set-done", { id, done }),
    remove: id => request("todo:delete", { id }),
    setStarted: (id, worktreePath) =>
      request("todo:set-started", { id, worktreePath }),
  };
}
