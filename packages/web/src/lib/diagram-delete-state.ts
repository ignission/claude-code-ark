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

/** まとめて消すときに、図ごとの知らせを 1 つに重ねる (同じ文は 1 度だけ) */
export function joinDeleteMessages(
  previous: string | null,
  next: string | null
): string | null {
  if (!next) return previous;
  if (!previous) return next;
  return previous.split("\n").includes(next)
    ? previous
    : `${previous}\n${next}`;
}
