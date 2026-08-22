import type {
  ClientToServerEvents,
  DiagramCommentsResponse,
  ServerToClientEvents,
} from "@ark/shared";
import type { Socket } from "socket.io-client";

type DiagramCommentSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** 1 回の emit が ACK を待つ時間 */
export const DIAGRAM_COMMENT_ACK_TIMEOUT_MS = 5_000;
/**
 * ACK が戻らなかったときの試行回数（初回を含む）。
 * mutation は operationId でサーバー側が冪等化されているため、同じ payload を
 * そのまま再送しても二重適用にならない。get は読み取りなので元から安全。
 * 合計の待ち時間は ACK_TIMEOUT × ATTEMPTS = 10 秒で、iframe 側の
 * 15 秒 watchdog より短い。
 */
export const DIAGRAM_COMMENT_REQUEST_ATTEMPTS = 2;

function requestDiagramComments(
  socket: DiagramCommentSocket | null,
  emit: (
    activeSocket: DiagramCommentSocket,
    callback: (response: DiagramCommentsResponse) => void
  ) => void
): Promise<DiagramCommentsResponse> {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) {
      reject(new Error("ソケットが切断されています"));
      return;
    }
    let settled = false;
    let attempt = 0;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const settle = (response: DiagramCommentsResponse): void => {
      // どの試行の ACK でも最初の 1 件だけ採用し、遅れて届いた分は無視する
      if (settled) return;
      settled = true;
      if (timeoutId !== null) globalThis.clearTimeout(timeoutId);
      resolve(response);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const attemptOnce = (): void => {
      attempt += 1;
      timeoutId = globalThis.setTimeout(() => {
        if (settled) return;
        if (attempt >= DIAGRAM_COMMENT_REQUEST_ATTEMPTS) {
          fail(new Error("コメント処理がタイムアウトしました"));
          return;
        }
        if (!socket.connected) {
          fail(new Error("ソケットが切断されています"));
          return;
        }
        // 同じ payload（同じ operationId）で再送する
        attemptOnce();
      }, DIAGRAM_COMMENT_ACK_TIMEOUT_MS);
      emit(socket, settle);
    };
    attemptOnce();
  });
}

export function requestDiagramCommentsGet(
  socket: DiagramCommentSocket | null,
  sessionId: string,
  relPath: string
): Promise<DiagramCommentsResponse> {
  return requestDiagramComments(socket, (activeSocket, callback) => {
    activeSocket.emit("diagram:comments:get", { sessionId, relPath }, callback);
  });
}

export function requestDiagramCommentCreate(
  socket: DiagramCommentSocket | null,
  sessionId: string,
  relPath: string,
  operationId: string,
  anchorId: string,
  body: string,
  anchorQuote?: string,
  anchorOccurrence?: number
): Promise<DiagramCommentsResponse> {
  const payload = {
    sessionId,
    relPath,
    operationId,
    anchorId,
    body,
    ...(anchorQuote === undefined ? {} : { anchorQuote }),
    ...(anchorOccurrence === undefined ? {} : { anchorOccurrence }),
  };
  return requestDiagramComments(socket, (activeSocket, callback) => {
    activeSocket.emit("diagram:comment:create", payload, callback);
  });
}

export function requestDiagramCommentResolve(
  socket: DiagramCommentSocket | null,
  sessionId: string,
  relPath: string,
  operationId: string,
  threadId: string
): Promise<DiagramCommentsResponse> {
  return requestDiagramComments(socket, (activeSocket, callback) => {
    activeSocket.emit(
      "diagram:comment:resolve",
      { sessionId, relPath, operationId, threadId },
      callback
    );
  });
}

export function requestDiagramCommentReply(
  socket: DiagramCommentSocket | null,
  sessionId: string,
  relPath: string,
  operationId: string,
  threadId: string,
  body: string
): Promise<DiagramCommentsResponse> {
  return requestDiagramComments(socket, (activeSocket, callback) => {
    activeSocket.emit(
      "diagram:comment:reply",
      { sessionId, relPath, operationId, threadId, body },
      callback
    );
  });
}

export function requestDiagramCommentDelete(
  socket: DiagramCommentSocket | null,
  sessionId: string,
  relPath: string,
  operationId: string,
  threadId: string
): Promise<DiagramCommentsResponse> {
  return requestDiagramComments(socket, (activeSocket, callback) => {
    activeSocket.emit(
      "diagram:comment:delete",
      { sessionId, relPath, operationId, threadId },
      callback
    );
  });
}

export function requestDiagramCommentSend(
  socket: DiagramCommentSocket | null,
  sessionId: string,
  relPath: string,
  operationId: string,
  threadId: string
): Promise<DiagramCommentsResponse> {
  return requestDiagramComments(socket, (activeSocket, callback) => {
    activeSocket.emit(
      "diagram:comment:send",
      { sessionId, relPath, operationId, threadId },
      callback
    );
  });
}
