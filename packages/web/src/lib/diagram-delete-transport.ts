import type { DiagramDeleteRequest, DiagramDeleteResponse } from "@ark/shared";

interface DiagramDeleteSocket {
  connected: boolean;
  emit: (
    event: "diagram:delete",
    data: DiagramDeleteRequest,
    callback: (response: DiagramDeleteResponse) => void
  ) => void;
}

export function requestDiagramDelete(
  socket: DiagramDeleteSocket | null,
  sessionId: string,
  relPath: string,
  expectedTracked: boolean
): Promise<DiagramDeleteResponse> {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) {
      reject(new Error("ソケットが切断されています"));
      return;
    }

    let settled = false;
    const timeoutId = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("図の削除がタイムアウトしました"));
    }, 10000);

    socket.emit(
      "diagram:delete",
      { sessionId, relPath, expectedTracked },
      response => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeoutId);
        resolve(response);
      }
    );
  });
}
