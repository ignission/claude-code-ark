import type { DiagramCommentsResponse } from "@ark/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createDiagramCommentsSocketHandlers,
  type DiagramCommentsHandlerDeps,
  handleDiagramCommentCreate,
  handleDiagramCommentDelete,
  handleDiagramCommentResolve,
  handleDiagramCommentSend,
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
    deleteComment: vi.fn(async () => snapshot),
    resolveComment: vi.fn(async () => snapshot),
    sendMessage: vi.fn(),
  };
}

const sendSnapshot: DiagramCommentsResponse = {
  ok: true,
  comments: {
    version: 1,
    target: "sample.diagram.html",
    threads: [
      {
        id: "th-send",
        anchorId: "s1",
        anchorText:
          "これは八十文字を超えた場合に切り詰める対象テキストです。改行\nやタブ\tも含みます。さらに十分な長さを加えて末尾を切ります。abcdefghij",
        anchorQuote: "引用の一行目\n引用の二行目",
        status: "open",
        createdAt: "2026-08-10T00:00:00.000Z",
        messages: [
          {
            id: "msg-send",
            author: "Reviewer",
            at: "2026-08-10T00:00:00.000Z",
            body: "本文の一行目\n本文の二行目\t末尾",
          },
        ],
      },
      {
        id: "th-other-open",
        anchorId: "s2",
        anchorText: "別の未解決",
        status: "open",
        createdAt: "2026-08-10T00:00:00.000Z",
        messages: [
          {
            id: "msg-other-open",
            author: "Reviewer",
            at: "2026-08-10T00:00:00.000Z",
            body: "別件",
          },
        ],
      },
      {
        id: "th-resolved",
        anchorId: "s3",
        anchorText: "解決済み",
        status: "resolved",
        createdAt: "2026-08-10T00:00:00.000Z",
        messages: [
          {
            id: "msg-resolved",
            author: "Reviewer",
            at: "2026-08-10T00:00:00.000Z",
            body: "解決済み",
          },
        ],
      },
    ],
  },
};

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
      body: "本文",
    },
    {
      sessionId: "session-1",
      relPath: "sample.diagram.html",
      anchorId: "a".repeat(257),
      body: "本文",
    },
    {
      sessionId: "session-1",
      relPath: "sample.diagram.html",
      anchorId: "s1",
      body: " ",
    },
    {
      sessionId: "session-1",
      relPath: "sample.diagram.html",
      anchorId: "s1",
      body: "b".repeat(4001),
    },
  ])("create の不正 payload を BAD_REQUEST にする", async payload => {
    const dependencies = deps();

    await expect(
      handleDiagramCommentCreate(dependencies, payload)
    ).resolves.toMatchObject({ ok: false, code: "BAD_REQUEST" });
    expect(dependencies.createComment).not.toHaveBeenCalled();
  });

  it("create payload の author を未知フィールドとして拒否する", async () => {
    const dependencies = deps();

    await expect(
      handleDiagramCommentCreate(dependencies, {
        sessionId: "session-1",
        relPath: "sample.diagram.html",
        anchorId: "s1",
        author: "Reviewer",
        body: "本文",
      })
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

  it("delete は session の managed worktree と検証済み payload だけを store へ渡す", async () => {
    const dependencies = deps();

    await expect(
      handleDiagramCommentDelete(dependencies, {
        sessionId: "session-1",
        relPath: "sample.diagram.html",
        threadId: "th-1",
      })
    ).resolves.toEqual(snapshot);

    expect(dependencies.resolveManagedWorktreePath).toHaveBeenCalledWith(
      "/session/worktree"
    );
    expect(dependencies.deleteComment).toHaveBeenCalledWith(
      "/managed/worktree",
      "sample.diagram.html",
      "th-1"
    );
  });

  it.each([
    null,
    { sessionId: "session-1", relPath: "sample.diagram.html" },
    {
      sessionId: "session-1",
      relPath: "sample.diagram.html",
      threadId: "th-1",
      unknown: true,
    },
  ])("delete の不正 payload %j を BAD_REQUEST にする", async payload => {
    const dependencies = deps();

    await expect(
      handleDiagramCommentDelete(dependencies, payload)
    ).resolves.toMatchObject({ ok: false, code: "BAD_REQUEST" });
    expect(dependencies.deleteComment).not.toHaveBeenCalled();
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

  it("send は sessionId から解決した worktree の comments を読む", async () => {
    const dependencies = deps();
    vi.mocked(dependencies.getComments).mockResolvedValue(sendSnapshot);

    await handleDiagramCommentSend(dependencies, {
      sessionId: "session-1",
      relPath: "sample.diagram.html",
      threadId: "th-send",
    });

    expect(dependencies.resolveManagedWorktreePath).toHaveBeenCalledWith(
      "/session/worktree"
    );
    expect(dependencies.getComments).toHaveBeenCalledWith(
      "/managed/worktree",
      "sample.diagram.html"
    );
  });

  it("send の不明な threadId を THREAD_NOT_FOUND にする", async () => {
    const dependencies = deps();
    vi.mocked(dependencies.getComments).mockResolvedValue(sendSnapshot);

    await expect(
      handleDiagramCommentSend(dependencies, {
        sessionId: "session-1",
        relPath: "sample.diagram.html",
        threadId: "missing",
      })
    ).resolves.toMatchObject({ ok: false, code: "THREAD_NOT_FOUND" });
    expect(dependencies.sendMessage).not.toHaveBeenCalled();
  });

  it("sendMessage を引用・本文・他の未解決件数を含む一行で呼び、最新 comments を返す", async () => {
    const dependencies = deps();
    vi.mocked(dependencies.getComments).mockResolvedValue(sendSnapshot);

    await expect(
      handleDiagramCommentSend(dependencies, {
        sessionId: "session-1",
        relPath: "sample.diagram.html",
        threadId: "th-send",
      })
    ).resolves.toEqual(sendSnapshot);

    expect(dependencies.sendMessage).toHaveBeenCalledOnce();
    const call = vi.mocked(dependencies.sendMessage).mock.calls[0];
    expect(call).toBeDefined();
    if (!call) throw new Error("sendMessage call expected");
    const [sessionId, message] = call;
    expect(sessionId).toBe("session-1");
    expect(message).not.toMatch(/[\r\n\t]/u);
    expect(message).toContain("図のコメント（sample.diagram.html）");
    expect(message).toContain("引用: 「引用の一行目 引用の二行目」");
    expect(message).toContain("コメント: 本文の一行目 本文の二行目 末尾");
    expect(message).not.toContain("Reviewer");
    expect(message).toContain(
      "他に未解決 1 件（board_comments で全件取得できる）"
    );
  });

  it("sendMessage へ渡す本文から制御文字・書式文字を除去する", async () => {
    const dependencies = deps();
    const response = structuredClone(sendSnapshot);
    if (!response.ok) throw new Error("successful comments response expected");
    const message = response.comments.threads[0]?.messages[0];
    if (!message) throw new Error("comment message expected");
    message.body = "本文\x1b[31m赤\x07色";
    vi.mocked(dependencies.getComments).mockResolvedValue(response);

    await handleDiagramCommentSend(dependencies, {
      sessionId: "session-1",
      relPath: "sample.diagram.html",
      threadId: "th-send",
    });

    expect(dependencies.sendMessage).toHaveBeenCalledOnce();
    const sent = vi.mocked(dependencies.sendMessage).mock.calls[0]?.[1];
    expect(sent).toBeDefined();
    expect(sent).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  it("メッセージが 0 件の thread は送信せず INVALID_SIDECAR にする", async () => {
    const dependencies = deps();
    const response = structuredClone(sendSnapshot);
    if (!response.ok) throw new Error("successful comments response expected");
    const thread = response.comments.threads[0];
    if (!thread) throw new Error("comment thread expected");
    thread.messages = [];
    vi.mocked(dependencies.getComments).mockResolvedValue(response);

    await expect(
      handleDiagramCommentSend(dependencies, {
        sessionId: "session-1",
        relPath: "sample.diagram.html",
        threadId: "th-send",
      })
    ).resolves.toEqual({
      ok: false,
      code: "INVALID_SIDECAR",
      error: "送信できるコメントメッセージがありません",
    });
    expect(dependencies.sendMessage).not.toHaveBeenCalled();
  });

  it("create の body を trim して store へ渡す", async () => {
    const dependencies = deps();

    await handleDiagramCommentCreate(dependencies, {
      sessionId: "session-1",
      relPath: "sample.diagram.html",
      anchorId: "s1",
      body: "  本文  ",
    });

    expect(dependencies.createComment).toHaveBeenCalledWith(
      "/managed/worktree",
      "sample.diagram.html",
      "s1",
      "本文",
      undefined,
      undefined
    );
  });

  it("create の anchorQuote/anchorOccurrence を検証して store へ渡す", async () => {
    const dependencies = deps();

    await handleDiagramCommentCreate(dependencies, {
      sessionId: "session-1",
      relPath: "sample.diagram.html",
      anchorId: "s1",
      anchorQuote: "選択した本文",
      anchorOccurrence: 1,
      body: "本文",
    });

    expect(dependencies.createComment).toHaveBeenCalledWith(
      "/managed/worktree",
      "sample.diagram.html",
      "s1",
      "本文",
      "選択した本文",
      1
    );
  });

  it("create の anchorQuote 単独を先頭出現として store へ渡す", async () => {
    const dependencies = deps();

    await handleDiagramCommentCreate(dependencies, {
      sessionId: "session-1",
      relPath: "sample.diagram.html",
      anchorId: "s1",
      anchorQuote: "選択した本文",
      body: "本文",
    });

    expect(dependencies.createComment).toHaveBeenCalledWith(
      "/managed/worktree",
      "sample.diagram.html",
      "s1",
      "本文",
      "選択した本文",
      undefined
    );
  });

  it.each([
    {
      anchorQuote: "",
      anchorOccurrence: 0,
    },
    {
      anchorQuote: "本文",
      anchorOccurrence: -1,
    },
    {
      anchorQuote: "本文",
      anchorOccurrence: 0.5,
    },
    {
      anchorOccurrence: 0,
    },
    {
      anchorQuote: "本文",
      anchorOccurrence: 0,
      unknown: true,
    },
  ])("create の不正な選択 payload %j を拒否する", async extra => {
    const dependencies = deps();

    await expect(
      handleDiagramCommentCreate(dependencies, {
        sessionId: "session-1",
        relPath: "sample.diagram.html",
        anchorId: "s1",
        body: "本文",
        ...extra,
      })
    ).resolves.toMatchObject({ ok: false, code: "BAD_REQUEST" });
    expect(dependencies.createComment).not.toHaveBeenCalled();
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
