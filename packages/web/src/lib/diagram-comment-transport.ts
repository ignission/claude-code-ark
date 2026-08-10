import type {
  ClientToServerEvents,
  DiagramCommentsResponse,
  ServerToClientEvents,
} from "@ark/shared";
import type { Socket } from "socket.io-client";

type DiagramCommentSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

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
    const timeoutId = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("コメント処理がタイムアウトしました"));
    }, 10_000);
    emit(socket, response => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeoutId);
      resolve(response);
    });
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
  anchorId: string,
  body: string,
  anchorQuote?: string,
  anchorOccurrence?: number
): Promise<DiagramCommentsResponse> {
  return requestDiagramComments(socket, (activeSocket, callback) => {
    const payload = {
      sessionId,
      relPath,
      anchorId,
      body,
      ...(anchorQuote === undefined ? {} : { anchorQuote }),
      ...(anchorOccurrence === undefined ? {} : { anchorOccurrence }),
    };
    activeSocket.emit("diagram:comment:create", payload, callback);
  });
}

export function requestDiagramCommentResolve(
  socket: DiagramCommentSocket | null,
  sessionId: string,
  relPath: string,
  threadId: string
): Promise<DiagramCommentsResponse> {
  return requestDiagramComments(socket, (activeSocket, callback) => {
    activeSocket.emit(
      "diagram:comment:resolve",
      { sessionId, relPath, threadId },
      callback
    );
  });
}

export function requestDiagramCommentDelete(
  socket: DiagramCommentSocket | null,
  sessionId: string,
  relPath: string,
  threadId: string
): Promise<DiagramCommentsResponse> {
  return requestDiagramComments(socket, (activeSocket, callback) => {
    activeSocket.emit(
      "diagram:comment:delete",
      { sessionId, relPath, threadId },
      callback
    );
  });
}

export function requestDiagramCommentSend(
  socket: DiagramCommentSocket | null,
  sessionId: string,
  relPath: string,
  threadId: string
): Promise<DiagramCommentsResponse> {
  return requestDiagramComments(socket, (activeSocket, callback) => {
    activeSocket.emit(
      "diagram:comment:send",
      { sessionId, relPath, threadId },
      callback
    );
  });
}
