import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  CdpClient,
  type CdpSocket,
  connectCdpUrl,
  isCommandTimeout,
  isSessionDetached,
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

  it("sessionが切り離されたら、そのsessionで待っている送信だけをrejectする", async () => {
    const { socket, receive } = fakeSocket();
    const client = new CdpClient(socket);
    const listener = vi.fn();
    client.on("Target.detachedFromTarget", listener);
    const gone = client.send("Page.enable", undefined, "S1");
    const other = client.send("Page.enable", undefined, "S2");
    const browser = client.send("Target.getTargets");
    receive({
      method: "Target.detachedFromTarget",
      params: { sessionId: "S1", targetId: "T1" },
    });
    await expect(gone).rejects.toThrow("CDPのsessionが切り離されました");
    await expect(gone).rejects.toSatisfy(isSessionDetached);
    // イベントは、これまでどおり配る
    expect(listener).toHaveBeenCalledWith(
      { sessionId: "S1", targetId: "T1" },
      undefined
    );
    receive({ id: 2, result: { ok: 2 } });
    receive({ id: 3, result: { ok: 3 } });
    await expect(other).resolves.toEqual({ ok: 2 });
    await expect(browser).resolves.toEqual({ ok: 3 });
    // 切り離されたあとに届いた応答は、もう待っていない
    expect(() => receive({ id: 1, result: {} })).not.toThrow();
    expect(
      (client as unknown as { pending: Map<number, unknown> }).pending.size
    ).toBe(0);
  });

  it("sessionの無い切り離しの知らせでは、何もrejectしない", async () => {
    const { socket, receive } = fakeSocket();
    const client = new CdpClient(socket);
    const p = client.send("Target.getTargets");
    receive({ method: "Target.detachedFromTarget", params: {} });
    receive({ method: "Target.detachedFromTarget" });
    receive({ id: 1, result: { ok: true } });
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("rejectSessionで、名指ししたsessionで待っている送信をrejectする", async () => {
    const { socket, receive } = fakeSocket();
    const client = new CdpClient(socket);
    const gone = client.send("Page.enable", undefined, "S1");
    const other = client.send("Page.enable", undefined, "S2");
    const browser = client.send("Target.getTargets");
    client.rejectSession("S1");
    await expect(gone).rejects.toThrow("CDPのsessionが切り離されました");
    receive({ id: 2, result: {} });
    receive({ id: 3, result: {} });
    await expect(other).resolves.toEqual({});
    await expect(browser).resolves.toEqual({});
    expect(isSessionDetached(new Error("Page.enable: failed"))).toBe(false);
    expect(isSessionDetached("CDPのsessionが切り離されました")).toBe(false);
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

describe("CdpClientの応答の期限", () => {
  const CAPTURE = "Page.captureScreenshot";

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("期限までに応答が無ければ、待ちを消して、見分けられる失敗にする", async () => {
    const { socket } = fakeSocket();
    const client = new CdpClient(socket);
    const p = client.send(CAPTURE, {}, "S1", { timeoutMs: 3000 });
    const settled = p.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2999);
    expect(client.pendingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const error = await settled;
    expect(isCommandTimeout(error)).toBe(true);
    expect(isSessionDetached(error)).toBe(false);
    expect((error as Error).message).toBe(
      `${CAPTURE}: CDPのコマンドが時間切れになりました`
    );
    expect(client.pendingCount).toBe(0);
  });

  it("応答の返らない取り直しを20回重ねても、期限が過ぎれば待ちは残らない", async () => {
    const { socket } = fakeSocket();
    const client = new CdpClient(socket);
    const failures: unknown[] = [];
    for (let i = 0; i < 20; i++) {
      client
        .send(CAPTURE, {}, "S1", { timeoutMs: 3000 })
        .catch((error: unknown) => failures.push(error));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(client.pendingCount).toBe(20);
    await vi.advanceTimersByTimeAsync(3000);
    expect(client.pendingCount).toBe(0);
    expect(failures).toHaveLength(20);
    expect(failures.every(isCommandTimeout)).toBe(true);
  });

  it("期限を渡さなければ、応答が返るまで待つ", async () => {
    const { socket, receive } = fakeSocket();
    const client = new CdpClient(socket);
    const p = client.send(CAPTURE);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.pendingCount).toBe(1);
    receive({ id: 1, result: { data: "x" } });
    await expect(p).resolves.toEqual({ data: "x" });
    expect(client.pendingCount).toBe(0);
  });

  it("期限のあとに届いた応答は無視する", async () => {
    const { socket, receive } = fakeSocket();
    const client = new CdpClient(socket);
    const p = client.send(CAPTURE, {}, "S1", { timeoutMs: 3000 });
    const settled = p.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(3000);
    expect(() => receive({ id: 1, result: { data: "late" } })).not.toThrow();
    expect(isCommandTimeout(await settled)).toBe(true);
    // 次のコマンドの応答と取り違えない
    const next = client.send("Page.enable");
    receive({ id: 2, result: { ok: true } });
    await expect(next).resolves.toEqual({ ok: true });
  });

  it("応答が返ったら、期限のタイマーを残さない", async () => {
    const { socket, receive } = fakeSocket();
    const client = new CdpClient(socket);
    const ok = client.send(CAPTURE, {}, "S1", { timeoutMs: 3000 });
    const failed = client.send(CAPTURE, {}, "S1", { timeoutMs: 3000 });
    receive({ id: 1, result: { data: "x" } });
    receive({ id: 2, error: { message: "no" } });
    await expect(ok).resolves.toEqual({ data: "x" });
    await expect(failed).rejects.toThrow(`${CAPTURE}: no`);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sessionを失敗にしたら、期限のタイマーを残さない", async () => {
    const { socket } = fakeSocket();
    const client = new CdpClient(socket);
    const p = client.send(CAPTURE, {}, "S1", { timeoutMs: 3000 });
    const settled = p.catch((error: unknown) => error);
    client.rejectSession("S1");
    expect(isSessionDetached(await settled)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(client.pendingCount).toBe(0);
  });

  it("切断したら、期限のタイマーを残さない", async () => {
    const { socket, emitter } = fakeSocket();
    const client = new CdpClient(socket);
    const p = client.send(CAPTURE, {}, "S1", { timeoutMs: 3000 });
    const settled = p.catch((error: unknown) => error);
    emitter.emit("close");
    expect(((await settled) as Error).message).toBe("CDPの接続が切れました");
    expect(vi.getTimerCount()).toBe(0);
    expect(client.pendingCount).toBe(0);
  });

  it("socket.sendが投げたら、期限のタイマーを残さない", async () => {
    const { socket } = fakeSocket();
    socket.send = () => {
      throw new Error("not open");
    };
    const client = new CdpClient(socket);
    await expect(
      client.send(CAPTURE, {}, "S1", { timeoutMs: 3000 })
    ).rejects.toThrow("not open");
    expect(vi.getTimerCount()).toBe(0);
    expect(client.pendingCount).toBe(0);
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
