import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { CdpClient, type CdpSocket } from "./browser-cdp-client.js";

function fakeSocket() {
  const emitter = new EventEmitter();
  const sent: Array<Record<string, unknown>> = [];
  const socket = {
    send: (data: string) => {
      sent.push(JSON.parse(data));
    },
    close: vi.fn(() => emitter.emit("close")),
    on: (event: string, l: (...args: never[]) => void) => emitter.on(event, l),
  } as unknown as CdpSocket;
  const receive = (msg: object) => emitter.emit("message", JSON.stringify(msg));
  return { socket, sent, receive, emitter };
}

describe("CdpClient", () => {
  it("idで応答を突き合わせ、sessionIdを載せて送る", async () => {
    const { socket, sent, receive } = fakeSocket();
    const client = new CdpClient(socket);
    const p = client.send<{ ok: boolean }>("Page.enable", { a: 1 }, "S1");
    expect(sent[0]).toEqual({
      id: 1,
      method: "Page.enable",
      params: { a: 1 },
      sessionId: "S1",
    });
    receive({ id: 1, result: { ok: true } });
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("errorの応答はメソッド名つきでrejectする", async () => {
    const { socket, receive } = fakeSocket();
    const client = new CdpClient(socket);
    const p = client.send("Page.navigate", { url: "x" });
    receive({ id: 1, error: { message: "Cannot navigate" } });
    await expect(p).rejects.toThrow("Page.navigate: Cannot navigate");
  });

  it("イベントをメソッド名で配り、sessionIdを渡す", () => {
    const { socket, receive } = fakeSocket();
    const client = new CdpClient(socket);
    const listener = vi.fn();
    client.on("Page.screencastFrame", listener);
    receive({
      method: "Page.screencastFrame",
      params: { data: "x" },
      sessionId: "S1",
    });
    expect(listener).toHaveBeenCalledWith({ data: "x" }, "S1");
  });

  it("切断で待っている送信をすべてrejectし、onCloseを呼ぶ", async () => {
    const { socket, emitter } = fakeSocket();
    const client = new CdpClient(socket);
    const onClose = vi.fn();
    client.onClose(onClose);
    const p = client.send("Page.enable");
    emitter.emit("close");
    await expect(p).rejects.toThrow("CDPの接続が切れました");
    expect(onClose).toHaveBeenCalledOnce();
    expect(client.closed).toBe(true);
    await expect(client.send("Page.enable")).rejects.toThrow(
      "CDPの接続が切れました"
    );
  });

  it("壊れたJSONを無視する", () => {
    const { socket, emitter } = fakeSocket();
    new CdpClient(socket);
    expect(() => emitter.emit("message", "{")).not.toThrow();
  });
});
