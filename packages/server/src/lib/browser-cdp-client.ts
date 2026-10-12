/**
 * CDP (Chrome DevTools Protocol) の接続1本。
 *
 * ブラウザのエンドポイントに1本だけつなぎ、タブへは `Target.attachToTarget` の
 * flattenしたsession (`sessionId` を各メッセージに載せる方式) で話す。
 * ライブラリを使わないのは、要るのが「idで応答を突き合わせる」「イベントを配る」の
 * 2つだけだから。
 *
 * - タブが閉じると、そのsessionで応答を待っていたコマンドには、応答が返らないままになる
 *   (実物のChromiumで確かめた。3秒待っても返らない。`Target.detachedFromTarget` と
 *   `Target.targetDestroyed` はすぐ届く)。待たせたままにすると、呼び出し側が先へ進めない。
 *   そこで、送ったコマンドごとにsessionを覚え、`Target.detachedFromTarget` が届いたら、
 *   そのsessionで待っているものを `isSessionDetached` で見分けられる失敗にする。
 *   sessionの付かないコマンド (ブラウザ宛て) は巻き込まない
 * - 使う側が自分でsessionを離すときは、`rejectSession` で同じことをさせる
 * - 切り離されたsessionへ新しく送ったコマンドは、Chromiumがすぐ断る
 *   (`Session with given id not found.`)。ここでは何もしない
 * - 接続もsessionも生きたまま、応答だけが返らないコマンドがある (ダイアログが開いている
 *   間の取り直し、固まったレンダラー)。待ちは、応答が返るか、sessionが切り離されるか、
 *   接続が切れるまで残るので、使う側が自分の時間切れで待つのをやめて送り直すたびに、
 *   待ちが1つずつ増える。そこで、送るときに応答の期限 (`timeoutMs`) を渡せるようにする。
 *   期限が来たら、待ちを消して、`isCommandTimeout` で見分けられる失敗にする。期限の
 *   あとに届いた応答は、待ちがもう無いので捨てる
 * - 期限のタイマーは、待ちと一緒に消す (応答が返った、sessionを失敗にした、接続が切れた、
 *   送信が投げた)。期限を渡さないコマンドには、タイマーを持たない
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
const DETACHED_MESSAGE = "CDPのsessionが切り離されました";
const TIMEOUT_MESSAGE = "CDPのコマンドが時間切れになりました";

/** コマンドを送るときの指定 */
export interface CdpSendOptions {
  /** 応答を待つ時間の上限 (ミリ秒)。渡さなければ、いつまでも待つ */
  timeoutMs?: number;
}

/** sessionが切り離されたために、応答を待つのをやめたコマンドの失敗 */
export class SessionDetachedError extends Error {
  constructor() {
    super(DETACHED_MESSAGE);
    this.name = "SessionDetachedError";
  }
}

/** `error` が、sessionが切り離されたための失敗か */
export function isSessionDetached(error: unknown): boolean {
  return error instanceof SessionDetachedError;
}

/** 期限までに応答が返らなかったコマンドの失敗 */
export class CommandTimeoutError extends Error {
  constructor(method: string) {
    super(`${method}: ${TIMEOUT_MESSAGE}`);
    this.name = "CommandTimeoutError";
  }
}

/** `error` が、期限までに応答が返らなかったための失敗か */
export function isCommandTimeout(error: unknown): boolean {
  return error instanceof CommandTimeoutError;
}

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      method: string;
      /** 送り先のsession。ブラウザ宛てなら `undefined` */
      sessionId: string | undefined;
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      /** 応答の期限のタイマー。期限が無ければ `null` */
      timer: NodeJS.Timeout | null;
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

  /** 応答を待っているコマンドの数 */
  get pendingCount(): number {
    return this.pending.size;
  }

  send<T = unknown>(
    method: string,
    params?: object,
    sessionId?: string,
    options?: CdpSendOptions
  ): Promise<T> {
    if (this.isClosed) return Promise.reject(new Error(CLOSED_MESSAGE));
    const id = this.nextId++;
    const timeoutMs = options?.timeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? null
          : setTimeout(() => {
              // 待ちを消す。このあとに届いた応答は、待ちが無いので捨てられる
              if (!this.pending.delete(id)) return;
              reject(new CommandTimeoutError(method));
            }, timeoutMs);
      this.pending.set(id, {
        method,
        sessionId,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params, sessionId }));
      } catch (e) {
        // CLOSING/CONNECTING のwsは同期的に投げる。待ちを残さない
        this.take(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** 待ちを1つ取り出し、期限のタイマーを消す。無ければ `undefined` */
  private take(id: number) {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    return entry;
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

  /** `sessionId` のsessionで応答を待っているコマンドを、すべて失敗にする */
  rejectSession(sessionId: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.sessionId !== sessionId) continue;
      this.take(id);
      entry.reject(new SessionDetachedError());
    }
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
      const entry = this.take(msg.id);
      if (!entry) return;
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
      if (msg.method === "Target.detachedFromTarget") {
        const detached = (msg.params as { sessionId?: unknown } | null)
          ?.sessionId;
        if (typeof detached === "string") this.rejectSession(detached);
      }
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
    for (const id of [...this.pending.keys()]) {
      this.take(id)?.reject(new Error(CLOSED_MESSAGE));
    }
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
