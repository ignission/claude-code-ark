import type { DiagramDeleteResponse } from "@ark/shared";
import { describe, expect, it } from "vitest";
import {
  applyDiagramDeleteResponse,
  getDiagramEmptyState,
  shouldRefreshDiagramList,
} from "./diagram-delete-state";

describe("diagram delete client state", () => {
  it("同じ sessionId の diagram:deleted だけで一覧を更新する", () => {
    expect(
      shouldRefreshDiagramList("session-1", {
        sessionId: "session-1",
        relPath: ".claude/diagrams/other.diagram.html",
      })
    ).toBe(true);
    expect(
      shouldRefreshDiagramList("session-1", {
        sessionId: "session-2",
        relPath: ".claude/diagrams/a.diagram.html",
      })
    ).toBe(false);
  });

  it.each(["CONFLICT", "NOT_FOUND"] as const)(
    "%s は削除済みと決めつけず error と一覧更新を返す",
    code => {
      const response: DiagramDeleteResponse = {
        ok: false,
        code,
        error: `${code} error`,
      };

      expect(applyDiagramDeleteResponse(response)).toEqual({
        message: `${code} error`,
        refreshList: true,
      });
    }
  );

  it("success は通知経由の更新を待ち、warning を区別して表示する", () => {
    expect(
      applyDiagramDeleteResponse({
        ok: true,
        relPath: ".claude/diagrams/a.diagram.html",
        tracked: true,
      })
    ).toEqual({ message: null, refreshList: false });
    expect(
      applyDiagramDeleteResponse({
        ok: true,
        relPath: ".claude/diagrams/a.diagram.html",
        tracked: true,
        warning: "DB clear failed",
      })
    ).toEqual({ message: "DB clear failed", refreshList: false });
  });

  it("current 削除後は次図を選ばず残件数に応じた空状態を返す", () => {
    expect(getDiagramEmptyState(2)).toBe("上の一覧から図を選択");
    expect(getDiagramEmptyState(0)).toBe("図がありません");
  });
});
