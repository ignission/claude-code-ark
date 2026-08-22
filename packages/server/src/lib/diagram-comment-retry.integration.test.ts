import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ClientToServerEvents,
  DiagramCommentsResponse,
  ServerToClientEvents,
} from "@ark/shared";
import type { Socket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DIAGRAM_COMMENT_ACK_TIMEOUT_MS,
  requestDiagramCommentCreate,
  requestDiagramCommentDelete,
} from "../../../web/src/lib/diagram-comment-transport.js";
import { diagramCommentOperationLog } from "./diagram-comment-operation-log.js";
import {
  createDiagramComment,
  readDiagramCommentsFile,
} from "./diagram-comments.js";
import {
  createDiagramCommentsSocketHandlers,
  type DiagramCommentsHandlerDeps,
  diagramCommentsStore,
} from "./diagram-comments-handler.js";

type DiagramCommentSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type SocketHandlers = ReturnType<typeof createDiagramCommentsSocketHandlers>;
type SocketHandler = (data: unknown, callback: unknown) => void;

const sessionId = "session-1";
const relPath = ".claude/diagrams/order-flow.diagram.html";
let worktree: string;

function writeDiagram(): void {
  const nodes = [{ id: "s1-p1", label: "注文を受け付ける" }];
  fs.mkdirSync(path.join(worktree, ".claude/diagrams"), { recursive: true });
  fs.writeFileSync(
    path.join(worktree, relPath),
    `<!doctype html><html><body><script type="application/json" id="ark-diagram-model">${JSON.stringify({ version: 1, type: "doc", nodes, edges: [], groups: [] })}</script><p data-ark-id="s1-p1">注文を受け付ける</p></body></html>`
  );
}

function dependencies(): DiagramCommentsHandlerDeps {
  return {
    getSession: requestedId =>
      requestedId === sessionId
        ? { id: sessionId, worktreePath: worktree }
        : null,
    resolveManagedWorktreePath: requestedPath =>
      requestedPath === worktree ? worktree : null,
    ...diagramCommentsStore,
    sendMessage: vi.fn(),
    operationLog: diagramCommentOperationLog,
  };
}

function handlerForEvent(
  handlers: SocketHandlers,
  event: string
): SocketHandler {
  const byEvent: Record<string, SocketHandler> = {
    "diagram:comments:get": handlers.get,
    "diagram:comment:create": handlers.create,
    "diagram:comment:reply": handlers.reply,
    "diagram:comment:resolve": handlers.resolve,
    "diagram:comment:delete": handlers.delete,
    "diagram:comment:send": handlers.send,
  };
  const handler = byEvent[event];
  if (handler === undefined) throw new Error(`unexpected event: ${event}`);
  return handler;
}

/** 実 handler から返る最初の ACK だけをネットワーク上で破棄する socket。 */
function socketDroppingFirstAck(handlers: SocketHandlers): {
  socket: DiagramCommentSocket;
  firstAckDropped: Promise<DiagramCommentsResponse>;
  emittedPayloads: unknown[];
  serverAckCount: () => number;
} {
  let acknowledgeDrop: (response: DiagramCommentsResponse) => void = () =>
    undefined;
  const firstAckDropped = new Promise<DiagramCommentsResponse>(resolve => {
    acknowledgeDrop = resolve;
  });
  const emittedPayloads: unknown[] = [];
  let serverAckCount = 0;
  const socket = {
    connected: true,
    emit: vi.fn(
      (
        event: string,
        payload: unknown,
        clientAck: (response: DiagramCommentsResponse) => void
      ) => {
        emittedPayloads.push(payload);
        handlerForEvent(handlers, event)(
          payload,
          (response: DiagramCommentsResponse) => {
            serverAckCount += 1;
            if (serverAckCount === 1) {
              acknowledgeDrop(response);
              return;
            }
            clientAck(response);
          }
        );
      }
    ),
  } as unknown as DiagramCommentSocket;
  return {
    socket,
    firstAckDropped,
    emittedPayloads,
    serverAckCount: () => serverAckCount,
  };
}

describe("diagram comment ACK timeout retry integration (#306)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    diagramCommentOperationLog.clear();
    worktree = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "ark-comment-retry-"))
    );
    writeDiagram();
  });

  afterEach(() => {
    vi.useRealTimers();
    diagramCommentOperationLog.clear();
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it("create の ACK 欠落後に同じ payload を再送しても thread は 1 件だけ", async () => {
    const fake = socketDroppingFirstAck(
      createDiagramCommentsSocketHandlers(dependencies())
    );
    const pending = requestDiagramCommentCreate(
      fake.socket,
      sessionId,
      relPath,
      "op-create-retry",
      "s1-p1",
      "本文"
    );

    const droppedResponse = await fake.firstAckDropped;
    expect(droppedResponse.ok && droppedResponse.comments.threads).toHaveLength(
      1
    );
    const writtenAfterFirstAttempt = await readDiagramCommentsFile(
      worktree,
      relPath
    );
    expect(
      writtenAfterFirstAttempt.ok && writtenAfterFirstAttempt.comments.threads
    ).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(DIAGRAM_COMMENT_ACK_TIMEOUT_MS);
    const retriedResponse = await pending;

    expect(fake.serverAckCount()).toBe(2);
    expect(fake.emittedPayloads).toHaveLength(2);
    expect(fake.emittedPayloads[1]).toStrictEqual(fake.emittedPayloads[0]);
    expect(retriedResponse.ok && retriedResponse.comments.threads).toHaveLength(
      1
    );
    const stored = await readDiagramCommentsFile(worktree, relPath);
    expect(stored.ok && stored.comments.threads).toHaveLength(1);
  });

  it("delete の ACK 欠落後も再適用せず現在の空 sidecar を返す", async () => {
    const created = await createDiagramComment(
      worktree,
      relPath,
      "s1-p1",
      "削除対象",
      undefined,
      undefined,
      { operationId: "op-create-for-delete" }
    );
    if (!created.ok) throw new Error(created.error);
    const threadId = created.comments.threads[0]?.id;
    if (threadId === undefined) throw new Error("thread expected");
    const fake = socketDroppingFirstAck(
      createDiagramCommentsSocketHandlers(dependencies())
    );
    const pending = requestDiagramCommentDelete(
      fake.socket,
      sessionId,
      relPath,
      "op-delete-retry",
      threadId
    );

    const droppedResponse = await fake.firstAckDropped;
    expect(droppedResponse).toMatchObject({
      ok: true,
      comments: { threads: [] },
    });

    await vi.advanceTimersByTimeAsync(DIAGRAM_COMMENT_ACK_TIMEOUT_MS);
    const retriedResponse = await pending;

    expect(fake.serverAckCount()).toBe(2);
    expect(fake.emittedPayloads).toHaveLength(2);
    expect(fake.emittedPayloads[1]).toStrictEqual(fake.emittedPayloads[0]);
    expect(retriedResponse).toMatchObject({
      ok: true,
      comments: { threads: [] },
    });
    const stored = await readDiagramCommentsFile(worktree, relPath);
    expect(stored).toMatchObject({ ok: true, comments: { threads: [] } });
  });
});
