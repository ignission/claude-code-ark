/**
 * CDP (Chrome DevTools Protocol) の接続1本。
 *
 * ブラウザのエンドポイントに1本だけつなぎ、タブへは `Target.attachToTarget` の
 * flattenしたsession (`sessionId` を各メッセージに載せる方式) で話す。
 * ライブラリを使わないのは、要るのが「idで応答を突き合わせる」「イベントを配る」の
 * 2つだけだから。
 */

import WebSocket from "ws";

/** ws の WebSocket が満たす最小限。テストで差し替えられるようにする */
export interface CdpSocket {
  send(data: string): void;
  close(): void;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

// biome-ignore lint/suspicious/noExplicitAny: CDPのイベントの形はメソッドごとに違い、ここでは解釈しない
type CdpListener = (params: any, sessionId?: string) => void;

const CLOSED_MESSAGE = "CDPの接続が切れました";

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      method: string;
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
    }
  >();
  private readonly listeners = new Map<string, CdpListener[]>();
  private readonly closeListeners: Array<() => void> = [];
  private isClosed = false;

  constructor(private readonly socket: CdpSocket) {
    socket.on("message", data => this.handleMessage(data));
    socket.on("close", () => this.handleClose());
    // error のあとには必ず close が来る。ここで握らないとプロセスが落ちる
    socket.on("error", () => {});
  }

  get closed(): boolean {
    return this.isClosed;
  }

  send<T = unknown>(
    method: string,
    params?: object,
    sessionId?: string
  ): Promise<T> {
    if (this.isClosed) return Promise.reject(new Error(CLOSED_MESSAGE));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params, sessionId }));
      } catch (e) {
        // CLOSING/CONNECTING のwsは同期的に投げる。待ちを残さない
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  on(method: string, listener: CdpListener): void {
    const list = this.listeners.get(method) ?? [];
    list.push(listener);
    this.listeners.set(method, list);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  close(): void {
    if (!this.isClosed) this.socket.close();
  }

  private handleMessage(data: unknown): void {
    let msg: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: unknown;
      sessionId?: string;
    };
    try {
      const parsed: unknown = JSON.parse(String(data));
      // null や数値などオブジェクトでないJSONは扱わない
      if (typeof parsed !== "object" || parsed === null) return;
      msg = parsed;
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        entry.reject(
          new Error(`${entry.method}: ${msg.error.message ?? "unknown error"}`)
        );
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === "string") {
      for (const listener of this.listeners.get(msg.method) ?? []) {
        try {
          listener(msg.params, msg.sessionId);
        } catch (e) {
          // 1つのリスナーの例外で、後ろのリスナーとプロセスを巻き込まない
          console.warn(
            `[CdpClient] ${msg.method} のリスナーが失敗しました:`,
            e
          );
        }
      }
    }
  }

  private handleClose(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const entry of this.pending.values()) {
      entry.reject(new Error(CLOSED_MESSAGE));
    }
    this.pending.clear();
    for (const listener of this.closeListeners) {
      try {
        listener();
      } catch (e) {
        console.warn("[CdpClient] closeのリスナーが失敗しました:", e);
      }
    }
  }
}

/**
 * ブラウザのエンドポイント (`ws://127.0.0.1:<port>/devtools/browser/<id>`) へつなぐ。
 * URLは、起動した側がChromiumの出力から得たものを渡す (browser-manager.ts)。
 */
export async function connectCdpUrl(wsUrl: string): Promise<CdpClient> {
  const ws = new WebSocket(wsUrl, {
    perMessageDeflate: false,
    handshakeTimeout: 3000,
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return new CdpClient(ws as unknown as CdpSocket);
}
