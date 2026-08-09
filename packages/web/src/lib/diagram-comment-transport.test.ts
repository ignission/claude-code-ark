import type { DiagramCommentsResponse } from "@ark/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestDiagramCommentCreate,
  requestDiagramCommentResolve,
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
      "s1",
      "Reviewer",
      "本文"
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
        anchorId: "s1",
        author: "Reviewer",
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
      "th-1"
    );

    expect(fake.socket.emit).toHaveBeenCalledWith(
      "diagram:comment:resolve",
      {
        sessionId: "session-1",
        relPath: "sample.diagram.html",
        threadId: "th-1",
      },
      expect.any(Function)
    );
    fake.reply(response);
    await expect(pending).resolves.toEqual(response);
  });

  it.each([
    ["get", requestDiagramCommentsGet],
    ["resolve", requestDiagramCommentResolve],
  ] as const)(
    "未接続の %s は emit せず reject する",
    async (_name, request) => {
      const fake = makeSocket(false);

      await expect(
        request(fake.socket, "session-1", "sample.diagram.html", "th-1")
      ).rejects.toThrow("ソケットが切断されています");
      expect(fake.socket.emit).not.toHaveBeenCalled();
    }
  );

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
});
