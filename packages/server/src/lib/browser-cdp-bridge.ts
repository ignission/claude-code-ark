/**
 * ブラウザ機能のブリッジ
 *
 * サーバー側のChromiumにCDPで1本だけつなぎ、視聴者 (ブラウザ機能を開いている
 * クライアント) のWebSocketへscreencastのフレームを配り、入力をCDPへ渡す。
 *
 * - 生のCDPを視聴者へ渡さない。視聴者のWebSocketに来たものをそのままCDPへ流すと、
 *   ページの外 (`Browser.*` / `Target.*`、任意のURLへの遷移) まで操作できてしまう。
 *   受け付けるのは `BrowserClientMessage` だけで、`parseClientMessage` で形を確かめ、
 *   `toCdpCommand` が決めたメソッドにだけ変換する
 * - 流量はackで決める。Chromiumは `Page.screencastFrameAck` が返るまで次のフレームを
 *   出さないので、視聴者の送信バッファが空くまでackを遅らせれば、遅い回線でも
 *   フレームがサーバーに溜まらない
 * - ビューポートは1つで、最後に寸法を送った視聴者に合わせる。タブが1つなので、
 *   視聴者ごとに別の寸法は持てない
 */

import type { BrowserClientMessage, BrowserServerMessage } from "@ark/shared";
import { type CdpClient, connectCdp } from "./browser-cdp-client.js";
import { CDP_PORT } from "./constants.js";

/** CdpClientのうちブリッジが使う部分。テストで差し替えられるようにする */
export type CdpLike = Pick<
  CdpClient,
  "send" | "on" | "onClose" | "close" | "closed"
>;

/** wsのWebSocketが満たす最小限。テストで差し替えられるようにする */
export interface ViewerSocket {
  readyState: number;
  bufferedAmount: number;
  send(data: Buffer | string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(
    event: "message",
    listener: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void
  ): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** attach済みのタブ。`sessionId` はflattenしたCDPのsession */
interface Page {
  cdp: CdpLike;
  sessionId: string;
}

interface Viewport {
  width: number;
  height: number;
  dpr: number;
  mobile: boolean;
}

/** 視聴者の送信バッファがこれ以上なら、その視聴者へはフレームを送らない (バイト) */
const BACKPRESSURE_BYTES = 1_000_000;
/** 全員が詰まっているときに見直す間隔 (ミリ秒) */
const ACK_RETRY_MS = 50;
/** ペインのドラッグ中に寸法を変え続けないための待ち (ミリ秒) */
const RESIZE_DEBOUNCE_MS = 150;
const WS_OPEN = 1;
/** 1メッセージの文字列の上限 (文字数)。貼り付けの本文もこれに収める */
const MAX_TEXT_LENGTH = 100_000;

const DEFAULT_VIEWPORT: Viewport = {
  width: 1280,
  height: 900,
  dpr: 1,
  mobile: false,
};

const DISCONNECTED_MESSAGE = "ブラウザとの接続が切れました";
const CONNECT_FAILED_MESSAGE = "ブラウザへ接続できません";

const MOUSE_TYPES = {
  down: "mousePressed",
  up: "mouseReleased",
  move: "mouseMoved",
  wheel: "mouseWheel",
} as const;
/** DOMの `MouseEvent.button` の順 */
const MOUSE_BUTTONS = ["left", "middle", "right"];

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TEXT_LENGTH;
}

/**
 * 視聴者から来た文字列を `BrowserClientMessage` として読む。形が違えば `null`。
 * 知っている列だけを写すので、余分な列がCDPまで届くことはない。
 */
export function parseClientMessage(raw: string): BrowserClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const m = value as Record<string, unknown>;

  switch (m.t) {
    case "resize":
      if (
        !isNumber(m.width) ||
        !isNumber(m.height) ||
        !isNumber(m.dpr) ||
        typeof m.mobile !== "boolean"
      ) {
        return null;
      }
      return {
        t: "resize",
        width: m.width,
        height: m.height,
        dpr: m.dpr,
        mobile: m.mobile,
      };
    case "mouse":
      if (
        (m.type !== "down" &&
          m.type !== "up" &&
          m.type !== "move" &&
          m.type !== "wheel") ||
        !isNumber(m.x) ||
        !isNumber(m.y) ||
        !isNumber(m.button) ||
        !isNumber(m.buttons) ||
        !isNumber(m.clickCount) ||
        !isNumber(m.deltaX) ||
        !isNumber(m.deltaY) ||
        !isNumber(m.modifiers)
      ) {
        return null;
      }
      return {
        t: "mouse",
        type: m.type,
        x: m.x,
        y: m.y,
        button: m.button,
        buttons: m.buttons,
        clickCount: m.clickCount,
        deltaX: m.deltaX,
        deltaY: m.deltaY,
        modifiers: m.modifiers,
      };
    case "key":
      if (
        (m.type !== "down" && m.type !== "up") ||
        !isText(m.key) ||
        !isText(m.code) ||
        !isNumber(m.keyCode) ||
        typeof m.repeat !== "boolean" ||
        !isNumber(m.modifiers) ||
        (m.text !== undefined && !isText(m.text))
      ) {
        return null;
      }
      return {
        t: "key",
        type: m.type,
        key: m.key,
        code: m.code,
        keyCode: m.keyCode,
        repeat: m.repeat,
        modifiers: m.modifiers,
        ...(m.text === undefined ? {} : { text: m.text }),
      };
    case "ime":
      if (m.type === "cancel") return { t: "ime", type: "cancel" };
      if (m.type === "commit") {
        return isText(m.text)
          ? { t: "ime", type: "commit", text: m.text }
          : null;
      }
      if (m.type === "update") {
        if (
          !isText(m.text) ||
          !isNumber(m.selectionStart) ||
          !isNumber(m.selectionEnd)
        ) {
          return null;
        }
        return {
          t: "ime",
          type: "update",
          text: m.text,
          selectionStart: m.selectionStart,
          selectionEnd: m.selectionEnd,
        };
      }
      return null;
    case "paste":
      return isText(m.text) ? { t: "paste", text: m.text } : null;
    default:
      return null;
  }
}

/** 押されているボタン (`MouseEvent.buttons`) から、CDPに渡すボタンを1つ選ぶ */
function buttonFromButtons(buttons: number): string {
  if (buttons & 1) return "left";
  if (buttons & 2) return "right";
  if (buttons & 4) return "middle";
  return "none";
}

/**
 * 入力のメッセージをCDPのコマンドへ変換する。resizeは入力ではないので `null`
 * (寸法の変更はブリッジがデバウンスして扱う)。
 */
export function toCdpCommand(
  msg: BrowserClientMessage
): { method: string; params: object } | null {
  switch (msg.t) {
    case "resize":
      return null;
    case "mouse": {
      const base = {
        type: MOUSE_TYPES[msg.type],
        x: msg.x,
        y: msg.y,
        buttons: msg.buttons,
        clickCount: msg.clickCount,
        modifiers: msg.modifiers,
      };
      if (msg.type === "wheel") {
        return {
          method: "Input.dispatchMouseEvent",
          params: {
            ...base,
            button: "none",
            deltaX: msg.deltaX,
            deltaY: msg.deltaY,
          },
        };
      }
      return {
        method: "Input.dispatchMouseEvent",
        params: {
          ...base,
          button:
            msg.type === "move"
              ? buttonFromButtons(msg.buttons)
              : (MOUSE_BUTTONS[msg.button] ?? "none"),
        },
      };
    }
    case "key": {
      // textを付けたkeyDownだけが文字を入力する。keyUpに付けると二重に入る
      const text = msg.type === "down" ? msg.text : undefined;
      return {
        method: "Input.dispatchKeyEvent",
        params: {
          type:
            msg.type === "up"
              ? "keyUp"
              : text !== undefined
                ? "keyDown"
                : "rawKeyDown",
          key: msg.key,
          code: msg.code,
          modifiers: msg.modifiers,
          windowsVirtualKeyCode: msg.keyCode,
          nativeVirtualKeyCode: msg.keyCode,
          ...(text === undefined ? {} : { text, unmodifiedText: text }),
          autoRepeat: msg.repeat,
        },
      };
    }
    case "ime":
      if (msg.type === "commit") {
        return { method: "Input.insertText", params: { text: msg.text } };
      }
      if (msg.type === "update") {
        return {
          method: "Input.imeSetComposition",
          params: {
            text: msg.text,
            selectionStart: msg.selectionStart,
            selectionEnd: msg.selectionEnd,
          },
        };
      }
      return {
        method: "Input.imeSetComposition",
        params: { text: "", selectionStart: 0, selectionEnd: 0 },
      };
    case "paste":
      return { method: "Input.insertText", params: { text: msg.text } };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** ビューポートをChromiumが扱える範囲へ丸める */
function clampViewport(msg: Viewport): Viewport {
  return {
    width: clamp(Math.round(msg.width), 200, 3840),
    height: clamp(Math.round(msg.height), 200, 2160),
    dpr: clamp(msg.dpr, 1, 2),
    mobile: msg.mobile,
  };
}

function metricsParams(viewport: Viewport): object {
  return {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.dpr,
    mobile: viewport.mobile,
  };
}

function screencastParams(viewport: Viewport): object {
  return {
    format: "jpeg",
    quality: 80,
    maxWidth: Math.round(viewport.width * viewport.dpr),
    maxHeight: Math.round(viewport.height * viewport.dpr),
    everyNthFrame: 1,
  };
}

function canReceive(ws: ViewerSocket): boolean {
  return ws.readyState === WS_OPEN && ws.bufferedAmount < BACKPRESSURE_BYTES;
}

function warn(what: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[BrowserBridge] ${what}: ${message}`);
}

export class BrowserCdpBridge {
  private readonly viewers = new Set<ViewerSocket>();
  /** 接続は1本にまとめる。同時の `attach` と `navigate` が2本つながないように、途中のPromiseを共有する */
  private connecting: Promise<Page> | null = null;
  /** いま使っている接続。古い接続のcloseやイベントを見分けるのに使う */
  private cdp: CdpLike | null = null;
  /** 準備が終わったタブ。イベントのリスナーから同期で使う */
  private page: Page | null = null;
  /** `reset` のたびに進める。進んだあとに終わった `connect()` は捨てる */
  private epoch = 0;
  private casting = false;
  private viewport: Viewport = DEFAULT_VIEWPORT;
  /** 最後の1枚 (JPEG)。あとから入った視聴者へすぐ見せるために持つ */
  private lastFrame: Buffer | null = null;
  /** まだackしていないフレームのid。詰まっている間に複数たまりうる */
  private pendingAcks: number[] = [];
  private ackTimer: NodeJS.Timeout | null = null;
  private resizeTimer: NodeJS.Timeout | null = null;

  constructor(private readonly connect: () => Promise<CdpLike>) {}

  get viewerCount(): number {
    return this.viewers.size;
  }

  attach(ws: ViewerSocket): void {
    this.viewers.add(ws);
    ws.on("message", (data, isBinary) => {
      // 視聴者が送るのはJSONだけ。バイナリは受け付けない
      if (isBinary) return;
      const msg = parseClientMessage(toText(data));
      if (msg) this.handleMessage(msg);
    });
    ws.on("close", () => this.detach(ws));
    ws.on("error", () => this.detach(ws));
    void this.join(ws);
  }

  /** つないでいなければつなぎ、タブを `url` へ遷移させる */
  async navigate(url: string): Promise<void> {
    const page = await this.ensurePage();
    await page.cdp.send("Page.navigate", { url }, page.sessionId);
  }

  /** サーバー停止とChromium停止のとき。CDPを閉じ、視聴者を切る */
  reset(): void {
    this.epoch++;
    const cdp = this.cdp;
    // 先に状態を捨てる。close() が呼ぶcloseのリスナーに、もう使っていない接続だと分からせる
    this.dropConnection();
    cdp?.close();
    // 終了経路なのでclose frameの往復は待たない
    for (const ws of this.viewers) ws.terminate();
    this.viewers.clear();
  }

  private async join(ws: ViewerSocket): Promise<void> {
    try {
      const page = await this.ensurePage();
      // つないでいる間に視聴者が去った、または接続が切れて閉じられた
      if (!this.viewers.has(ws)) return;
      // screencastは画面が変わったときしかフレームを出さない。持っている1枚を送らないと、
      // 何かが動くまで視聴者のcanvasが空になる
      if (this.lastFrame && canReceive(ws)) ws.send(this.lastFrame);
      await this.startCast(page);
    } catch (error) {
      warn("接続に失敗", error);
      if (!this.viewers.delete(ws)) return;
      closeWithError(ws, CONNECT_FAILED_MESSAGE);
      // この視聴者のために始めたscreencastを、見る人がいないまま残さない
      if (this.viewers.size === 0) void this.stopCast();
    }
  }

  private detach(ws: ViewerSocket): void {
    if (!this.viewers.delete(ws)) return;
    if (this.viewers.size === 0) void this.stopCast();
  }

  private ensurePage(): Promise<Page> {
    if (!this.connecting) {
      const attempt = this.openPage();
      this.connecting = attempt;
      // 失敗した接続を持ち続けない。次の `attach` でつなぎ直す
      attempt.catch(() => {
        if (this.connecting === attempt) this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async openPage(): Promise<Page> {
    const epoch = this.epoch;
    const cdp = await this.connect();
    if (epoch !== this.epoch) {
      cdp.close();
      throw new Error("接続を待つ間にリセットされました");
    }
    this.cdp = cdp;
    // リスナーは接続ごとに1回だけ登録する
    cdp.onClose(() => this.handleCdpClose(cdp));
    cdp.on("Page.screencastFrame", params => this.handleFrame(cdp, params));
    try {
      const { targetInfos } = await cdp.send<{
        targetInfos: Array<{ targetId: string; type: string }>;
      }>("Target.getTargets");
      const target = targetInfos.find(info => info.type === "page");
      if (!target) throw new Error("タブがありません");
      const { sessionId } = await cdp.send<{ sessionId: string }>(
        "Target.attachToTarget",
        { targetId: target.targetId, flatten: true }
      );
      await cdp.send("Page.enable", undefined, sessionId);
      // headlessのタブはフォーカスを持たない。これが無いと、キャレットが出ず、
      // focusに頼るページが動かない
      await cdp.send(
        "Emulation.setFocusEmulationEnabled",
        { enabled: true },
        sessionId
      );
      await cdp.send(
        "Emulation.setDeviceMetricsOverride",
        metricsParams(this.viewport),
        sessionId
      );
      if (this.cdp !== cdp) throw new Error(DISCONNECTED_MESSAGE);
      const page = { cdp, sessionId };
      this.page = page;
      return page;
    } catch (error) {
      // 準備の途中で失敗した接続は使わない。残すと、つなぎ直すたびに接続が増える
      if (this.cdp === cdp) this.cdp = null;
      cdp.close();
      throw error;
    }
  }

  private async startCast(page: Page): Promise<void> {
    if (this.casting) return;
    // awaitの前に立てる。同時に入った視聴者が二重に始めないように
    this.casting = true;
    try {
      await page.cdp.send(
        "Page.startScreencast",
        screencastParams(this.viewport),
        page.sessionId
      );
    } catch (error) {
      if (this.page === page) this.casting = false;
      throw error;
    }
  }

  private async stopCast(): Promise<void> {
    if (!this.casting) return;
    this.casting = false;
    this.dropFrames();
    const page = this.page;
    if (!page || page.cdp.closed) return;
    try {
      await page.cdp.send("Page.stopScreencast", undefined, page.sessionId);
    } catch (error) {
      warn("screencastの停止に失敗", error);
    }
  }

  private handleMessage(msg: BrowserClientMessage): void {
    if (msg.t === "resize") {
      // 最後に寸法を送った視聴者に合わせる
      this.viewport = clampViewport(msg);
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        this.resizeTimer = null;
        void this.applyViewport();
      }, RESIZE_DEBOUNCE_MS);
      return;
    }
    const command = toCdpCommand(msg);
    const page = this.page;
    if (!command || !page) return;
    // 入力の失敗 (遷移中のタブなど) で視聴者を切らない
    page.cdp
      .send(command.method, command.params, page.sessionId)
      .catch(error => warn(`${command.method} に失敗`, error));
  }

  /** つないでいなければ何もしない。寸法は次につないだときに使われる */
  private async applyViewport(): Promise<void> {
    const page = this.page;
    if (!page) return;
    const { cdp, sessionId } = page;
    const sends = [
      cdp.send(
        "Emulation.setDeviceMetricsOverride",
        metricsParams(this.viewport),
        sessionId
      ),
    ];
    if (this.casting) {
      // screencastの寸法は始めたときに決まるので、始め直す。3つを待たずに続けて送るのは、
      // 間に視聴者が0人になって止めたscreencastを、ここで始め直してしまわないため
      this.dropFrames();
      sends.push(
        cdp.send("Page.stopScreencast", undefined, sessionId),
        cdp.send(
          "Page.startScreencast",
          screencastParams(this.viewport),
          sessionId
        )
      );
    }
    try {
      await Promise.all(sends);
    } catch (error) {
      warn("寸法の変更に失敗", error);
    }
  }

  /**
   * `params.sessionId` はフレームの番号で、ackに使う。
   * 名前は同じだが、CDPのsession (`Page.sessionId`) とは別のもの。
   */
  private handleFrame(
    cdp: CdpLike,
    params: { data?: unknown; sessionId?: unknown } | undefined
  ): void {
    // 止めたあとに届いた分は配らない。ackも要らない
    if (this.page?.cdp !== cdp || !this.casting) return;
    if (typeof params?.data !== "string" || !isNumber(params.sessionId)) return;
    this.lastFrame = Buffer.from(params.data, "base64");
    this.pendingAcks.push(params.sessionId);
    this.deliverFrame();
  }

  /**
   * 最後の1枚を、受け取れる視聴者へ配る。1人でも受け取ればackして次のフレームを出させる。
   * 全員が詰まっていればackを遅らせ、Chromiumに次を出させない。
   */
  private deliverFrame(): void {
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    const page = this.page;
    const frame = this.lastFrame;
    if (!page || !frame) return;

    let delivered = false;
    for (const ws of this.viewers) {
      if (!canReceive(ws)) continue;
      ws.send(frame);
      delivered = true;
    }
    if (!delivered) {
      this.ackTimer = setTimeout(() => this.deliverFrame(), ACK_RETRY_MS);
      return;
    }
    // 詰まっている間に届いた分もまとめて返す。1つでも返し忘れると、
    // Chromiumが出せるフレームの枠が減ったままになる
    const ids = this.pendingAcks;
    this.pendingAcks = [];
    for (const id of ids) {
      page.cdp
        .send("Page.screencastFrameAck", { sessionId: id }, page.sessionId)
        .catch(error => warn("ackに失敗", error));
    }
  }

  private handleCdpClose(cdp: CdpLike): void {
    // resetや失敗で捨てた接続のcloseは、いまの接続に響かせない
    if (this.cdp !== cdp) return;
    this.dropConnection();
    const viewers = [...this.viewers];
    this.viewers.clear();
    for (const ws of viewers) closeWithError(ws, DISCONNECTED_MESSAGE);
  }

  /** 接続にひもづく状態を捨てる。ビューポートは次の接続でも使うので残す */
  private dropConnection(): void {
    this.cdp = null;
    this.page = null;
    this.connecting = null;
    this.casting = false;
    this.dropFrames();
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
  }

  private dropFrames(): void {
    this.lastFrame = null;
    this.pendingAcks = [];
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
  }
}

/** wsのRawData (Buffer | ArrayBuffer | Buffer[]) を文字列にする */
function toText(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  if (Buffer.isBuffer(data)) return data.toString();
  return Buffer.from(data).toString();
}

function closeWithError(ws: ViewerSocket, message: string): void {
  if (ws.readyState !== WS_OPEN) return;
  const body: BrowserServerMessage = { t: "error", message };
  ws.send(JSON.stringify(body));
  ws.close(1011, message);
}

export const browserBridge = new BrowserCdpBridge(() => connectCdp(CDP_PORT));
