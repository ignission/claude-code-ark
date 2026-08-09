import type { DiagramCommentsResponse } from "@ark/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createDiagramCommentsSocketHandlers,
  type DiagramCommentsHandlerDeps,
  handleDiagramCommentCreate,
  handleDiagramCommentResolve,
  handleDiagramCommentsGet,
} from "./diagram-comments-handler.js";

const snapshot: DiagramCommentsResponse = {
  ok: true,
  comments: {
    version: 1,
    target: "sample.diagram.html",
    threads: [],
  },
};

function deps(): DiagramCommentsHandlerDeps {
  return {
    getSession: vi.fn(() => ({
      id: "session-1",
      worktreePath: "/session/worktree",
    })),
    resolveManagedWorktreePath: vi.fn(() => "/managed/worktree"),
    getComments: vi.fn(async () => snapshot),
    createComment: vi.fn(async () => snapshot),
    resolveComment: vi.fn(async () => snapshot),
  };
}

describe("diagram comments handler core", () => {
  it.each([
    undefined,
    null,
    [],
    {},
    { sessionId: 1, relPath: "sample.diagram.html" },
    { sessionId: "session-1", relPath: "" },
    { sessionId: "session-1\0", relPath: "sample.diagram.html" },
    { sessionId: "session-1", relPath: "x".repeat(1025) },
    {
      sessionId: "session-1",
      relPath: "sample.diagram.html",
      worktreePath: "/client/value",
    },
  ])("get の不正 payload %j を BAD_REQUEST にする", async payload => {
    const dependencies = deps();

    await expect(
      handleDiagramCommentsGet(dependencies, payload)
    ).resolves.toMatchObject({ ok: false, code: "BAD_REQUEST" });
    expect(dependencies.getSession).not.toHaveBeenCalled();
    expect(dependencies.getComments).not.toHaveBeenCalled();
  });

  it.each([
    {
      sessionId: "session-1",
      relPath: "sample.diagram.html",
      anchorId: "",
      author: "Reviewer",
      body: "本文",
    },
    {
      sessionId: "session-1",
      relPath: "sample.diagram.html",
      anchorId: "a".repeat(257),
      author: "Reviewer",
      body: "本文",
    },
    {
      sessionId: "session-1",
      relPath: "sample.diagram.html",
      anchorId: "s1",
      author: " ",
      body: "本文",
    },
    {
      sessionId: "session-1",
      relPath: "sample.diagram.html",
      anchorId: "s1",
      author: "Reviewer",
      body: " ",
    },
    {
      sessionId: "session-1",
      relPath: "sample.diagram.html",
      anchorId: "s1",
      author: "a".repeat(81),
      body: "本文",
    },
    {
      sessionId: "session-1",
      relPath: "sample.diagram.html",
      anchorId: "s1",
      author: "Reviewer",
      body: "b".repeat(4001),
    },
  ])("create の不正 payload を BAD_REQUEST にする", async payload => {
    const dependencies = deps();

    await expect(
      handleDiagramCommentCreate(dependencies, payload)
    ).resolves.toMatchObject({ ok: false, code: "BAD_REQUEST" });
    expect(dependencies.createComment).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { sessionId: "session-1", relPath: "sample.diagram.html" },
    {
      sessionId: "session-1",
      relPath: "sample.diagram.html",
      threadId: "th-1\0",
    },
    {
      sessionId: "session-1",
      relPath: "sample.diagram.html",
      threadId: "t".repeat(257),
    },
  ])("resolve の不正 payload %j を BAD_REQUEST にする", async payload => {
    const dependencies = deps();

    await expect(
      handleDiagramCommentResolve(dependencies, payload)
    ).resolves.toMatchObject({ ok: false, code: "BAD_REQUEST" });
    expect(dependencies.resolveComment).not.toHaveBeenCalled();
  });

  it("存在しない session を SESSION_NOT_FOUND にする", async () => {
    const dependencies = deps();
    vi.mocked(dependencies.getSession).mockReturnValue(null);

    await expect(
      handleDiagramCommentsGet(dependencies, {
        sessionId: "missing",
        relPath: "sample.diagram.html",
      })
    ).resolves.toMatchObject({ ok: false, code: "SESSION_NOT_FOUND" });
    expect(dependencies.resolveManagedWorktreePath).not.toHaveBeenCalled();
  });

  it("managed worktree 解決失敗を FORBIDDEN にする", async () => {
    const dependencies = deps();
    vi.mocked(dependencies.resolveManagedWorktreePath).mockReturnValue(null);

    await expect(
      handleDiagramCommentsGet(dependencies, {
        sessionId: "session-1",
        relPath: "sample.diagram.html",
      })
    ).resolves.toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(dependencies.getComments).not.toHaveBeenCalled();
  });

  it("session の worktreePath だけを解決し、解決済み path を store へ渡す", async () => {
    const dependencies = deps();

    await expect(
      handleDiagramCommentsGet(dependencies, {
        sessionId: "session-1",
        relPath: "sample.diagram.html",
      })
    ).resolves.toEqual(snapshot);

    expect(dependencies.resolveManagedWorktreePath).toHaveBeenCalledWith(
      "/session/worktree"
    );
    expect(dependencies.getComments).toHaveBeenCalledWith(
      "/managed/worktree",
      "sample.diagram.html"
    );
  });

  it("create の author/body を trim して store へ渡す", async () => {
    const dependencies = deps();

    await handleDiagramCommentCreate(dependencies, {
      sessionId: "session-1",
      relPath: "sample.diagram.html",
      anchorId: "s1",
      author: "  Reviewer  ",
      body: "  本文  ",
    });

    expect(dependencies.createComment).toHaveBeenCalledWith(
      "/managed/worktree",
      "sample.diagram.html",
      "s1",
      "Reviewer",
      "本文"
    );
  });

  it.each(["NOT_DOC", "INVALID_SIDECAR"] as const)(
    "store の %s error をそのまま返す",
    async code => {
      const dependencies = deps();
      const response: DiagramCommentsResponse = {
        ok: false,
        code,
        error: "store error",
      };
      vi.mocked(dependencies.getComments).mockResolvedValue(response);

      await expect(
        handleDiagramCommentsGet(dependencies, {
          sessionId: "session-1",
          relPath: "sample.diagram.html",
        })
      ).resolves.toEqual(response);
    }
  );

  it("store rejection を IO_ERROR に閉じ込める", async () => {
    const dependencies = deps();
    vi.mocked(dependencies.resolveComment).mockRejectedValue(
      new Error("disk unavailable")
    );

    await expect(
      handleDiagramCommentResolve(dependencies, {
        sessionId: "session-1",
        relPath: "sample.diagram.html",
        threadId: "th-1",
      })
    ).resolves.toEqual({
      ok: false,
      code: "IO_ERROR",
      error: "コメント処理に失敗しました: disk unavailable",
    });
  });
});

describe("createDiagramCommentsSocketHandlers", () => {
  it("各 ACK を1回だけ返す", async () => {
    const handlers = createDiagramCommentsSocketHandlers(deps());
    const callback = vi.fn();

    handlers.get(
      { sessionId: "session-1", relPath: "sample.diagram.html" },
      callback
    );

    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
    expect(callback).toHaveBeenCalledWith(snapshot);
  });

  it("ACK callback が throw しても伝播しない", async () => {
    const handlers = createDiagramCommentsSocketHandlers(deps());
    const callback = vi.fn(() => {
      throw new Error("client callback failed");
    });

    expect(() =>
      handlers.get(
        { sessionId: "session-1", relPath: "sample.diagram.html" },
        callback
      )
    ).not.toThrow();
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
  });

  it.each([undefined, null, "callback"])(
    "callback 欠落 (%j) は core を呼ばず無視する",
    async callback => {
      const dependencies = deps();
      const handlers = createDiagramCommentsSocketHandlers(dependencies);

      expect(() =>
        handlers.create(
          {
            sessionId: "session-1",
            relPath: "sample.diagram.html",
            anchorId: "s1",
            author: "Reviewer",
            body: "本文",
          },
          callback
        )
      ).not.toThrow();
      await Promise.resolve();
      expect(dependencies.getSession).not.toHaveBeenCalled();
    }
  );

  it("core の予期しない rejection も IO_ERROR ACK へ閉じ込める", async () => {
    const dependencies = deps();
    vi.mocked(dependencies.getSession).mockImplementation(() => {
      throw new Error("session store failed");
    });
    const handlers = createDiagramCommentsSocketHandlers(dependencies);
    const callback = vi.fn();

    handlers.resolve(
      {
        sessionId: "session-1",
        relPath: "sample.diagram.html",
        threadId: "th-1",
      },
      callback
    );

    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
    expect(callback).toHaveBeenCalledWith({
      ok: false,
      code: "IO_ERROR",
      error: "コメント処理に失敗しました: session store failed",
    });
  });
});
