import type { DiagramCommentsResponse } from "@ark/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DIAGRAM_COMMENT_ACK_TIMEOUT_MS,
  DIAGRAM_COMMENT_REQUEST_ATTEMPTS,
  requestDiagramCommentCreate,
  requestDiagramCommentDelete,
  requestDiagramCommentReply,
  requestDiagramCommentResolve,
  requestDiagramCommentSend,
  requestDiagramCommentsGet,
} from "./diagram-comment-transport";

const response: DiagramCommentsResponse = {
  ok: true,
  comments: { version: 1, target: "sample.diagram.html", threads: [] },
};

function makeSocket(connected = true) {
  let ack: ((value: DiagramCommentsResponse) => void) | undefined;
  const socket = {
    connected,
    emit: vi.fn(
      (
        _event: string,
        _payload: unknown,
        callback: (value: DiagramCommentsResponse) => void
      ) => {
        ack = callback;
      }
    ),
  };
  return {
    socket,
    reply: (value: DiagramCommentsResponse) => ack?.(value),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

it("reply は threadId と本文を送る", async () => {
  const fake = makeSocket();
  const pending = requestDiagramCommentReply(
    fake.socket,
    "session-1",
    ".claude/diagrams/a.diagram.html",
    "op-1",
    "th-1",
    "返信本文"
  );

  expect(fake.socket.emit).toHaveBeenCalledWith(
    "diagram:comment:reply",
    {
      sessionId: "session-1",
      relPath: ".claude/diagrams/a.diagram.html",
      operationId: "op-1",
      threadId: "th-1",
      body: "返信本文",
    },
    expect.any(Function)
  );
  fake.reply(response);
  await expect(pending).resolves.toEqual(response);
});

describe("diagram comment transport", () => {
  it("get は正しい event/payload で typed ACK を返す", async () => {
    const fake = makeSocket();
    const pending = requestDiagramCommentsGet(
      fake.socket,
      "session-1",
      "sample.diagram.html"
    );

    expect(fake.socket.emit).toHaveBeenCalledWith(
      "diagram:comments:get",
      { sessionId: "session-1", relPath: "sample.diagram.html" },
      expect.any(Function)
    );
    fake.reply(response);
    await expect(pending).resolves.toEqual(response);
  });

  it("create は正しい event/payload で typed ACK error も保持する", async () => {
    const fake = makeSocket();
    const pending = requestDiagramCommentCreate(
      fake.socket,
      "session-1",
      "sample.diagram.html",
      "op-1",
      "s1",
      "本文",
      "選択した本文",
      1
    );
    const error: DiagramCommentsResponse = {
      ok: false,
      code: "INVALID_SIDECAR",
      error: "broken",
    };

    expect(fake.socket.emit).toHaveBeenCalledWith(
      "diagram:comment:create",
      {
        sessionId: "session-1",
        relPath: "sample.diagram.html",
        operationId: "op-1",
        anchorId: "s1",
        anchorQuote: "選択した本文",
        anchorOccurrence: 1,
        body: "本文",
      },
      expect.any(Function)
    );
    fake.reply(error);
    await expect(pending).resolves.toEqual(error);
  });

  it("resolve は正しい event/payload で typed ACK を返す", async () => {
    const fake = makeSocket();
    const pending = requestDiagramCommentResolve(
      fake.socket,
      "session-1",
      "sample.diagram.html",
      "op-1",
      "th-1"
    );

    expect(fake.socket.emit).toHaveBeenCalledWith(
      "diagram:comment:resolve",
      {
        sessionId: "session-1",
        relPath: "sample.diagram.html",
        operationId: "op-1",
        threadId: "th-1",
      },
      expect.any(Function)
    );
    fake.reply(response);
    await expect(pending).resolves.toEqual(response);
  });

  it("delete は threadId だけを正しい event/payload で送る", async () => {
    const fake = makeSocket();
    const pending = requestDiagramCommentDelete(
      fake.socket,
      "session-1",
      "sample.diagram.html",
      "op-1",
      "th-1"
    );

    expect(fake.socket.emit).toHaveBeenCalledWith(
      "diagram:comment:delete",
      {
        sessionId: "session-1",
        relPath: "sample.diagram.html",
        operationId: "op-1",
        threadId: "th-1",
      },
      expect.any(Function)
    );
    fake.reply(response);
    await expect(pending).resolves.toEqual(response);
  });

  it("send は threadId だけを正しい event/payload で送る", async () => {
    const fake = makeSocket();
    const pending = requestDiagramCommentSend(
      fake.socket,
      "session-1",
      "sample.diagram.html",
      "op-1",
      "th-1"
    );

    expect(fake.socket.emit).toHaveBeenCalledWith(
      "diagram:comment:send",
      {
        sessionId: "session-1",
        relPath: "sample.diagram.html",
        operationId: "op-1",
        threadId: "th-1",
      },
      expect.any(Function)
    );
    fake.reply(response);
    await expect(pending).resolves.toEqual(response);
  });

  it.each([
    [
      "get",
      (socket: ReturnType<typeof makeSocket>["socket"]) =>
        requestDiagramCommentsGet(socket, "session-1", "sample.diagram.html"),
    ],
    [
      "resolve",
      (socket: ReturnType<typeof makeSocket>["socket"]) =>
        requestDiagramCommentResolve(
          socket,
          "session-1",
          "sample.diagram.html",
          "op-1",
          "th-1"
        ),
    ],
  ] as const)(
    "未接続の %s は emit せず reject する",
    async (_name, request) => {
      const fake = makeSocket(false);

      await expect(request(fake.socket)).rejects.toThrow(
        "ソケットが切断されています"
      );
      expect(fake.socket.emit).not.toHaveBeenCalled();
    }
  );

  it("合計の待ち時間は 10 秒で、iframe 側の 15 秒 watchdog より短い", () => {
    expect(
      DIAGRAM_COMMENT_ACK_TIMEOUT_MS * DIAGRAM_COMMENT_REQUEST_ATTEMPTS
    ).toBe(10_000);
  });

  it("10秒 timeout 後の late ACK を無視する", async () => {
    vi.useFakeTimers();
    const fake = makeSocket();
    const pending = requestDiagramCommentsGet(
      fake.socket,
      "session-1",
      "sample.diagram.html"
    );
    const rejection = expect(pending).rejects.toThrow(
      "コメント処理がタイムアウトしました"
    );

    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(() => fake.reply(response)).not.toThrow();
  });

  it("ACK が戻らなければ同じ operationId の payload をそのまま再送する (#306)", async () => {
    vi.useFakeTimers();
    const fake = makeSocket();
    const pending = requestDiagramCommentCreate(
      fake.socket,
      "session-1",
      "sample.diagram.html",
      "op-retry",
      "s1",
      "本文"
    );

    await vi.advanceTimersByTimeAsync(DIAGRAM_COMMENT_ACK_TIMEOUT_MS - 1);
    expect(fake.socket.emit).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fake.socket.emit).toHaveBeenCalledTimes(
      DIAGRAM_COMMENT_REQUEST_ATTEMPTS
    );
    const payloads = fake.socket.emit.mock.calls.map(call => call[1]);
    expect(payloads[1]).toEqual(payloads[0]);
    expect(payloads[0]).toMatchObject({ operationId: "op-retry" });

    fake.reply(response);
    await expect(pending).resolves.toEqual(response);
  });

  it("再送後に届いた初回の late ACK を採用し、2 回目の ACK は無視する", async () => {
    vi.useFakeTimers();
    const acks: ((value: DiagramCommentsResponse) => void)[] = [];
    const socket = {
      connected: true,
      emit: vi.fn(
        (
          _event: string,
          _payload: unknown,
          callback: (value: DiagramCommentsResponse) => void
        ) => {
          acks.push(callback);
        }
      ),
    };
    const pending = requestDiagramCommentResolve(
      socket,
      "session-1",
      "sample.diagram.html",
      "op-1",
      "th-1"
    );
    await vi.advanceTimersByTimeAsync(DIAGRAM_COMMENT_ACK_TIMEOUT_MS);
    expect(acks).toHaveLength(2);

    const late: DiagramCommentsResponse = {
      ok: false,
      code: "THREAD_NOT_FOUND",
      error: "late",
    };
    acks[0]?.(late);
    acks[1]?.(response);

    await expect(pending).resolves.toEqual(late);
  });

  it("ACK 前に応答があれば再送しない", async () => {
    vi.useFakeTimers();
    const fake = makeSocket();
    const pending = requestDiagramCommentDelete(
      fake.socket,
      "session-1",
      "sample.diagram.html",
      "op-1",
      "th-1"
    );
    fake.reply(response);
    await expect(pending).resolves.toEqual(response);

    await vi.advanceTimersByTimeAsync(
      DIAGRAM_COMMENT_ACK_TIMEOUT_MS * DIAGRAM_COMMENT_REQUEST_ATTEMPTS
    );
    expect(fake.socket.emit).toHaveBeenCalledTimes(1);
  });

  it("再送時点で切断していれば再送せず reject する", async () => {
    vi.useFakeTimers();
    const fake = makeSocket();
    const pending = requestDiagramCommentSend(
      fake.socket,
      "session-1",
      "sample.diagram.html",
      "op-1",
      "th-1"
    );
    const rejection = expect(pending).rejects.toThrow(
      "ソケットが切断されています"
    );
    fake.socket.connected = false;

    await vi.advanceTimersByTimeAsync(DIAGRAM_COMMENT_ACK_TIMEOUT_MS);
    await rejection;
    expect(fake.socket.emit).toHaveBeenCalledTimes(1);
  });
});
