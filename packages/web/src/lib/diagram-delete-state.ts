import type { DiagramDeleteResponse } from "@ark/shared";

export function shouldRefreshDiagramList(
  sessionId: string,
  event: { sessionId: string; relPath: string }
): boolean {
  return event.sessionId === sessionId;
}

export function applyDiagramDeleteResponse(response: DiagramDeleteResponse): {
  message: string | null;
  refreshList: boolean;
} {
  if (response.ok) {
    return {
      message: response.warning ?? null,
      refreshList: false,
    };
  }
  return {
    message: response.error,
    refreshList: response.code === "CONFLICT" || response.code === "NOT_FOUND",
  };
}

export function getDiagramEmptyState(diagramCount: number): string {
  return diagramCount > 0 ? "上の一覧から図を選択" : "図がありません";
}
