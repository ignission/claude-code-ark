import { describe, expect, it, vi } from "vitest";
import { emitDiagramAutosave } from "./DiagramPane";

describe("emitDiagramAutosave", () => {
  it("ACK timeout を保存失敗として reply する", () => {
    const reply = vi.fn();
    const emit = vi.fn(
      (_event: string, _request: unknown, callback: (error: Error) => void) =>
        callback(new Error("operation has timed out"))
    );
    const timeout = vi.fn(() => ({ emit }));

    emitDiagramAutosave(
      { timeout } as never,
      {
        sessionId: "session-1",
        worktreePath: "/worktree",
        relPath: ".claude/diagrams/sample.diagram.html",
        model: {},
        html: "<html></html>",
      },
      reply
    );

    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(reply).toHaveBeenCalledWith({
      ok: false,
      error: "保存がタイムアウトしました",
    });
  });
});
