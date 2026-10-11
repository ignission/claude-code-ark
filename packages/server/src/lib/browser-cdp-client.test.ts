import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  CdpClient,
  type CdpSocket,
  connectCdpUrl,
} from "./browser-cdp-client.js";

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

  it("リスナーが投げても、後ろのリスナーを呼びプロセスを落とさない", () => {
    const { socket, receive } = fakeSocket();
    const client = new CdpClient(socket);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const second = vi.fn();
    client.on("X.y", () => {
      throw new Error("boom");
    });
    client.on("X.y", second);
    expect(() => receive({ method: "X.y", params: {} })).not.toThrow();
    expect(second).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("onCloseのリスナーが投げても、後ろのリスナーを呼ぶ", () => {
    const { socket, emitter } = fakeSocket();
    const client = new CdpClient(socket);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const second = vi.fn();
    client.onClose(() => {
      throw new Error("boom");
    });
    client.onClose(second);
    expect(() => emitter.emit("close")).not.toThrow();
    expect(second).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("オブジェクトでないJSONは無視する", () => {
    const { socket, emitter } = fakeSocket();
    new CdpClient(socket);
    for (const raw of ["null", "1", '"s"', "true"]) {
      expect(() => emitter.emit("message", raw)).not.toThrow();
    }
  });

  it("socket.sendが同期的に投げたら、pendingを消してrejectする", async () => {
    const { socket } = fakeSocket();
    (socket as { send: (d: string) => void }).send = () => {
      throw new Error("not open");
    };
    const client = new CdpClient(socket);
    await expect(client.send("Page.enable")).rejects.toThrow("not open");
    expect(
      (client as unknown as { pending: Map<number, unknown> }).pending.size
    ).toBe(0);
  });
});

describe("CDP_PORT", () => {
  const load = async (value: string | undefined) => {
    vi.resetModules();
    if (value === undefined) vi.stubEnv("ARK_CDP_PORT", "");
    else vi.stubEnv("ARK_CDP_PORT", value);
    if (value === undefined) delete process.env.ARK_CDP_PORT;
    return (await import("./constants.js")).CDP_PORT;
  };
  it("不正な値は9222に戻し、値を名指しで警告する", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await load("abc")).toBe(9222);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("abc"));
    warn.mockRestore();
    vi.unstubAllEnvs();
  });
  it("未設定は黙って9222、正しい値はそのまま", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await load(undefined)).toBe(9222);
    expect(await load("9300")).toBe(9300);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    vi.unstubAllEnvs();
  });
});

describe("connectCdpUrl", () => {
  it("渡されたURLへつなぎ、コマンドをやり取りできる", async () => {
    // 空いているポートをOSに選ばせる
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>(resolve => server.once("listening", resolve));
    server.on("connection", (ws, req) => {
      ws.on("message", data => {
        const { id } = JSON.parse(String(data));
        ws.send(JSON.stringify({ id, result: { path: req.url } }));
      });
    });
    const { port } = server.address() as { port: number };
    try {
      const client = await connectCdpUrl(
        `ws://127.0.0.1:${port}/devtools/browser/abc`
      );
      await expect(client.send("Browser.getVersion")).resolves.toEqual({
        path: "/devtools/browser/abc",
      });
      client.close();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("つなげなければrejectする", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>(resolve => server.once("listening", resolve));
    const { port } = server.address() as { port: number };
    await new Promise<void>(resolve => server.close(() => resolve()));
    await expect(
      connectCdpUrl(`ws://127.0.0.1:${port}/devtools/browser/abc`)
    ).rejects.toThrow();
  });
});
