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
 * - 流量はackで決める。視聴者の全員の送信バッファが詰まっている間は
 *   `Page.screencastFrameAck` を返さない。ackが返らなければChromiumはフレームを出す量を
 *   絞るので、遅い回線でもフレームがサーバーに溜まり続けない。持つのは最後の1枚だけで、
 *   遅れた視聴者は途中を飛ばし、空いたときにその1枚を受け取る
 * - タブが使えなくなったら (sessionのdetach、クラッシュ、screencastの開始の失敗)、
 *   CDPが切れたときと同じに扱う。視聴者をerrorで閉じて接続ごと捨て、次の `attach` で
 *   タブを探すところからやり直す
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
/** 最後の1枚をまだ受け取っていない視聴者がいる間、見直す間隔 (ミリ秒) */
const ACK_RETRY_MS = 50;
/** ペインのドラッグ中に寸法を変え続けないための待ち (ミリ秒) */
const RESIZE_DEBOUNCE_MS = 150;
const WS_OPEN = 1;
/** 1メッセージの文字列の上限 (文字数)。貼り付けの本文もこれに収める */
const MAX_TEXT_LENGTH = 100_000;
/** `key` と `code` の上限 (文字数)。DOMのキー名はどれも短い */
const MAX_KEY_LENGTH = 64;

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

function isText(value: unknown, max = MAX_TEXT_LENGTH): value is string {
  return typeof value === "string" && value.length <= max;
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
        !isText(m.key, MAX_KEY_LENGTH) ||
        !isText(m.code, MAX_KEY_LENGTH) ||
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

function sameViewport(a: Viewport, b: Viewport): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.dpr === b.dpr &&
    a.mobile === b.mobile
  );
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
  /** 最後の1枚を送り終えた視聴者。同じ1枚を二度送らないために持つ */
  private readonly upToDate = new Set<ViewerSocket>();
  /** 接続は1本にまとめる。同時の `attach` と `navigate` が2本つながないように、途中のPromiseを共有する */
  private connecting: Promise<Page> | null = null;
  /** いま使っている接続。古い接続のcloseやイベントを見分けるのに使う */
  private cdp: CdpLike | null = null;
  /** 準備が終わったタブ。イベントのリスナーから同期で使う */
  private page: Page | null = null;
  /** `reset` のたびに進める。進んだあとに終わった `connect()` は捨てる */
  private epoch = 0;
  private casting = false;
  /**
   * screencastを始めるたび、止めるたびに進める。遅れて届いた開始の失敗が、
   * そのあとに始め直したscreencastを巻き込まないように見分ける
   */
  private castGeneration = 0;
  private viewport: Viewport = DEFAULT_VIEWPORT;
  /** いまの接続のタブに当てた寸法。同じ寸法を当て直さないために持つ */
  private appliedViewport: Viewport | null = null;
  /** 最後の1枚 (JPEG)。あとから入った視聴者と遅れた視聴者へ見せるために持つ */
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
    if (this.viewers.has(ws)) return;
    this.viewers.add(ws);
    ws.on("message", (data, isBinary) => {
      // 外した視聴者 (去った、errorで閉じた) からは受け付けない。
      // 閉じ終わるまでの間もメッセージは届く
      if (!this.viewers.has(ws)) return;
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
    // 先に状態を捨てる。あとから届くcloseのイベントに、もう使っていない接続だと分からせる
    this.dropConnection();
    cdp?.close();
    const viewers = this.takeViewers();
    // 終了経路なのでclose frameの往復は待たない
    for (const ws of viewers) terminate(ws);
  }

  private async join(ws: ViewerSocket): Promise<void> {
    let page: Page;
    try {
      page = await this.ensurePage();
    } catch (error) {
      warn("接続に失敗", error);
      // 接続が切れて閉じられた視聴者は、もう外れている
      if (this.viewers.has(ws)) {
        this.detach(ws);
        closeWithError(ws, CONNECT_FAILED_MESSAGE);
      }
      return;
    }
    // つないでいる間に視聴者が去った、または接続が切れて閉じられた
    if (!this.viewers.has(ws)) return;
    // screencastは画面が変わったときしかフレームを出さない。持っている1枚を送らないと、
    // 何かが動くまで視聴者のcanvasが空になる
    this.deliverFrame();
    this.startCast(page);
  }

  private detach(ws: ViewerSocket): void {
    if (!this.viewers.delete(ws)) return;
    this.upToDate.delete(ws);
    if (this.viewers.size === 0) this.stopCast();
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
    /** attachしたタブのsession。準備の途中に届くdetachも見分けられるように、ここで持つ */
    let attached: string | null = null;
    // リスナーは接続ごとに1回だけ登録する
    cdp.onClose(() => this.teardown(cdp));
    cdp.on("Page.screencastFrame", params => this.handleFrame(cdp, params));
    // タブが閉じられたときもここへ来る (タブが消えると、そのsessionはdetachされる)。
    // ブラウザから届くイベントで、どのsessionかは `params` に入っている
    cdp.on("Target.detachedFromTarget", params => {
      if (attached !== null && params?.sessionId === attached) {
        this.failConnection(cdp, "タブのsessionがdetachされました");
      }
    });
    cdp.on("Inspector.targetCrashed", (_params, sessionId) => {
      if (attached !== null && sessionId === attached) {
        this.failConnection(cdp, "タブがクラッシュしました");
      }
    });
    try {
      const { targetInfos } = await cdp.send<{
        targetInfos: Array<{ targetId: string; type: string }>;
      }>("Target.getTargets");
      const target =
        targetInfos.find(info => info.type === "page") ??
        (await cdp.send<{ targetId: string }>("Target.createTarget", {
          url: "about:blank",
        }));
      const { sessionId } = await cdp.send<{ sessionId: string }>(
        "Target.attachToTarget",
        { targetId: target.targetId, flatten: true }
      );
      attached = sessionId;
      await cdp.send("Page.enable", undefined, sessionId);
      // headlessのタブはフォーカスを持たない。これが無いと、キャレットが出ず、
      // focusに頼るページが動かない
      await cdp.send(
        "Emulation.setFocusEmulationEnabled",
        { enabled: true },
        sessionId
      );
      const viewport = this.viewport;
      await cdp.send(
        "Emulation.setDeviceMetricsOverride",
        metricsParams(viewport),
        sessionId
      );
      if (this.cdp !== cdp) throw new Error(DISCONNECTED_MESSAGE);
      const page = { cdp, sessionId };
      this.page = page;
      this.appliedViewport = viewport;
      return page;
    } catch (error) {
      // 準備の途中で失敗した接続は使わない。残すと、つなぎ直すたびに接続が増える
      if (this.cdp === cdp) this.cdp = null;
      cdp.close();
      throw error;
    }
  }

  /** 失敗は `failCast` が接続ごと捨てるので、呼び出し側は待たない */
  private startCast(page: Page): void {
    if (this.casting) return;
    // 送る前に立てる。同時に入った視聴者が二重に始めないように
    this.casting = true;
    const generation = ++this.castGeneration;
    page.cdp
      .send(
        "Page.startScreencast",
        screencastParams(this.viewport),
        page.sessionId
      )
      .catch(error => this.failCast(page, generation, error));
  }

  /**
   * screencastを始められなかったら、接続ごと捨てる。`casting` だけを戻すと、
   * 同時に入っていた視聴者がフレームの来ないままつながり続ける。
   */
  private failCast(page: Page, generation: number, error: unknown): void {
    // 止めたあと、始め直したあと、別の接続になったあとに届いた失敗は、いまの状態と関係ない
    if (this.page !== page || this.castGeneration !== generation) return;
    warn("screencastの開始に失敗", error);
    this.failConnection(page.cdp, "screencastを始められません");
  }

  private stopCast(): void {
    if (!this.casting) return;
    this.casting = false;
    this.castGeneration++;
    this.dropFrames();
    const page = this.page;
    if (!page || page.cdp.closed) return;
    page.cdp
      .send("Page.stopScreencast", undefined, page.sessionId)
      .catch(error => warn("screencastの停止に失敗", error));
  }

  private handleMessage(msg: BrowserClientMessage): void {
    if (msg.t === "resize") {
      // 最後に寸法を送った視聴者に合わせる
      this.viewport = clampViewport(msg);
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        this.resizeTimer = null;
        this.applyViewport();
      }, RESIZE_DEBOUNCE_MS);
      return;
    }
    const command = toCdpCommand(msg);
    const page = this.page;
    if (!command || !page) return;
    // 入力の失敗 (遷移中のタブなど) で視聴者を切らない
    page.cdp
      .send(command.method, command.params, page.sessionId)
      .catch(error => warn(`${command.method}に失敗`, error));
  }

  /** つないでいなければ何もしない。寸法は次につないだときに使われる */
  private applyViewport(): void {
    const page = this.page;
    if (!page) return;
    const viewport = this.viewport;
    // 同じ寸法なら何もしない。始め直すと、全員がフレームを1枚落とす
    if (this.appliedViewport && sameViewport(this.appliedViewport, viewport)) {
      return;
    }
    this.appliedViewport = viewport;
    const { cdp, sessionId } = page;
    cdp
      .send(
        "Emulation.setDeviceMetricsOverride",
        metricsParams(viewport),
        sessionId
      )
      .catch(error => {
        warn("寸法の変更に失敗", error);
        // 当たっていないので、同じ寸法がもう一度来たら当て直す
        if (this.page === page && this.appliedViewport === viewport) {
          this.appliedViewport = null;
        }
      });
    if (!this.casting) return;
    // screencastの寸法は始めたときに決まるので、始め直す。応答を待たずに続けて送るのは、
    // 間に視聴者が0人になって止めたscreencastを、ここで始め直してしまわないため
    this.dropFrames();
    const generation = ++this.castGeneration;
    cdp
      .send("Page.stopScreencast", undefined, sessionId)
      .catch(error => warn("screencastの停止に失敗", error));
    cdp
      .send("Page.startScreencast", screencastParams(viewport), sessionId)
      .catch(error => this.failCast(page, generation, error));
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
    this.upToDate.clear();
    this.pendingAcks.push(params.sessionId);
    this.deliverFrame();
  }

  /**
   * 最後の1枚を、まだ受け取っていなくて、いま受け取れる視聴者へ配る。
   * 1人でも受け取ればackする。全員が詰まっていればackを遅らせ、Chromiumに次を出させない。
   * 受け取っていない視聴者が残る間は、`ACK_RETRY_MS` ごとに見直す。ほかの視聴者が
   * 受け取ってackしたあとに画面が止まっても、遅れた視聴者に古い画が残らないようにする。
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
    let behind = false;
    // 送信に失敗した視聴者を途中で外すので、写しを回す
    for (const ws of [...this.viewers]) {
      if (this.upToDate.has(ws)) continue;
      if (!canReceive(ws)) {
        behind = true;
        continue;
      }
      try {
        ws.send(frame);
      } catch (error) {
        // 1人の送信の失敗で、残りの視聴者への配信とackを止めない
        warn("視聴者への送信に失敗", error);
        this.detach(ws);
        terminate(ws);
        continue;
      }
      this.upToDate.add(ws);
      delivered = true;
    }
    // 最後の視聴者を外してscreencastを止めたなら、フレームはもう捨ててある
    if (this.lastFrame !== frame) return;
    if (behind) {
      this.ackTimer = setTimeout(() => this.deliverFrame(), ACK_RETRY_MS);
    }
    if (!delivered) return;
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

  /**
   * 接続が切れたとき。視聴者へerrorを送って閉じ、状態を捨てる。
   * resetや失敗で捨てた接続のcloseは、いまの接続に響かせない。
   */
  private teardown(cdp: CdpLike): void {
    if (this.cdp !== cdp) return;
    this.dropConnection();
    for (const ws of this.takeViewers()) {
      closeWithError(ws, DISCONNECTED_MESSAGE);
    }
  }

  /**
   * CDPはつながっているが、タブが使えなくなったとき。切れたときと同じに片づけてから、
   * 接続を閉じる。先に状態を捨てるので、あとから届くcloseのイベントは何もしない。
   */
  private failConnection(cdp: CdpLike, reason: string): void {
    if (this.cdp !== cdp) return;
    console.warn(`[BrowserBridge] ${reason}。接続を捨てます`);
    this.teardown(cdp);
    cdp.close();
  }

  private takeViewers(): ViewerSocket[] {
    const viewers = [...this.viewers];
    this.viewers.clear();
    this.upToDate.clear();
    return viewers;
  }

  /** 接続にひもづく状態を捨てる。ビューポートは次の接続でも使うので残す */
  private dropConnection(): void {
    this.cdp = null;
    this.page = null;
    this.connecting = null;
    this.casting = false;
    this.castGeneration++;
    this.appliedViewport = null;
    this.dropFrames();
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
  }

  private dropFrames(): void {
    this.lastFrame = null;
    this.upToDate.clear();
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

function terminate(ws: ViewerSocket): void {
  try {
    ws.terminate();
  } catch (error) {
    warn("視聴者の切断に失敗", error);
  }
}

/** 送信かcloseが投げた視聴者は、close frameを待たずに切る。残りの視聴者への通知を止めない */
function closeWithError(ws: ViewerSocket, message: string): void {
  if (ws.readyState !== WS_OPEN) return;
  const body: BrowserServerMessage = { t: "error", message };
  try {
    ws.send(JSON.stringify(body));
    ws.close(1011, message);
  } catch (error) {
    warn("視聴者への通知に失敗", error);
    terminate(ws);
  }
}

export const browserBridge = new BrowserCdpBridge(() => connectCdp(CDP_PORT));
