import type { DiagramDeleteResponse } from "@ark/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestDiagramDelete } from "./diagram-delete-transport";

function makeSocket(connected = true) {
  let ack: ((response: DiagramDeleteResponse) => void) | undefined;
  return {
    socket: {
      connected,
      emit: vi.fn(
        (
          _event: "diagram:delete",
          _data: unknown,
          callback: (response: DiagramDeleteResponse) => void
        ) => {
          ack = callback;
        }
      ),
    },
    reply: (response: DiagramDeleteResponse) => ack?.(response),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("requestDiagramDelete", () => {
  it("ACK success を返す", async () => {
    const fake = makeSocket();
    const pending = requestDiagramDelete(
      fake.socket,
      "session-1",
      ".claude/diagrams/a.diagram.html",
      true
    );
    const response: DiagramDeleteResponse = {
      ok: true,
      relPath: ".claude/diagrams/a.diagram.html",
      tracked: true,
    };
    fake.reply(response);

    await expect(pending).resolves.toEqual(response);
  });

  it("typed ACK error を code/message ごと返す", async () => {
    const fake = makeSocket();
    const pending = requestDiagramDelete(
      fake.socket,
      "session-1",
      ".claude/diagrams/a.diagram.html",
      false
    );
    const response: DiagramDeleteResponse = {
      ok: false,
      code: "CONFLICT",
      error: "状態が変化しました",
    };
    fake.reply(response);

    await expect(pending).resolves.toEqual(response);
  });

  it("未接続なら emit せず reject する", async () => {
    const fake = makeSocket(false);

    await expect(
      requestDiagramDelete(
        fake.socket,
        "session-1",
        ".claude/diagrams/a.diagram.html",
        true
      )
    ).rejects.toThrow("ソケットが切断されています");
    expect(fake.socket.emit).not.toHaveBeenCalled();
  });

  it("10秒で timeout し、late ACK を無視する", async () => {
    vi.useFakeTimers();
    const fake = makeSocket();
    const pending = requestDiagramDelete(
      fake.socket,
      "session-1",
      ".claude/diagrams/a.diagram.html",
      true
    );
    const rejection = expect(pending).rejects.toThrow(
      "図の削除がタイムアウトしました"
    );

    await vi.advanceTimersByTimeAsync(10000);
    await rejection;
    expect(() =>
      fake.reply({
        ok: true,
        relPath: ".claude/diagrams/a.diagram.html",
        tracked: true,
      })
    ).not.toThrow();
  });
});
