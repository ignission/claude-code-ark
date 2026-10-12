/**
 * ブラウザ機能のブリッジ
 *
 * サーバー側のChromiumにCDPで1本だけつなぎ、視聴者 (ブラウザ機能を開いている
 * クライアント) のWebSocketへ画面を送り、入力をCDPへ渡す。
 *
 * - 生のCDPを視聴者へ渡さない。視聴者のメッセージは、browser-protocol.ts の検査を通った
 *   ものだけを使う
 * - 画面は差分で送る。screencastは「どこが変わったか」を知るための縮小した監視フレームで、
 *   視聴者へは送らない。送るのは、変わった矩形か全画面を取り直した画像。何をいつ取り直し、
 *   どの視聴者へ送るかの決まりは browser-frame-pipeline.ts にあり、このモジュールは
 *   接続、視聴者、入力を持つ
 * - 監視フレームのackは、届いたらすぐ返す。視聴者へ送らないフレームなので、視聴者の
 *   送信バッファの詰まりとは関係がない。詰まった視聴者には、取り直した画像を送らないことで応じる
 * - 映すタブは1つ。どのタブを映すか (切り替え、閉じる、新しいタブ、消えたタブからの移動) は
 *   browser-tab-controller.ts が決め、このモジュールは「タブへつないで準備する」
 *   (`enterTab`) と「いまのタブから離れる」(`leavePage`) だけを受け持つ。最初の接続、
 *   切り替え、消えたタブからのつなぎ直しのどれも、同じ2つを通る
 * - タブから離れても、視聴者とCDPの接続には触らない。捨てるのはタブ1つぶんの状態
 *   (監視、取り直しの途中の結果、ページの状態、開いているダイアログ、スクロールした位置、
 *   当てた寸法、寸法の変更の待ち) だけ。離れてから次のタブの準備が終わるまでは映すタブが
 *   無く、その間に届いた入力、遷移、ダイアログへの応答、コピーは捨てる (溜めない。
 *   別のタブへ届けると、利用者が見ていないページを操作することになる)
 * - 前のタブから遅れて届くものを、いまのタブに響かせない。sessionのイベントはsessionの
 *   idで、取り直しの結果はパイプラインの画面の番号で、screencastの開始の失敗は
 *   `castGeneration` で、準備の途中のコマンドの応答は `attached` が替わっていないかで見分ける
 * - タブが替わったら、寸法が同じでも世代を進める。視聴者は世代の違うフレームを捨てるので、
 *   前のタブの画が新しいタブの上に重ならない。準備が終わったら、全員へ、寸法、ページの状態、
 *   タブの一覧の順に知らせ、監視を始める。最初の監視フレームで鮮明な全画面が届く
 * - 映しているタブが消えても、クラッシュしても、視聴者は切らない (ほかのタブへ移る)。
 *   視聴者をerrorで閉じて接続ごと捨てるのは、CDPが切れたとき、どのタブにもつなげなく
 *   なったとき、screencastを始められなかったときだけ。次の `attach` でつなぎ直す。
 *   取り直しの失敗は、ページの遷移中にも起きるので、接続を捨てない
 * - どのChromiumへつなぐかは、このモジュールでは決めない。つなぎ方は `connect` で受け取る。
 *   サーバーが使う1つは、Chromiumを起動する側 (browser-manager.ts の `browserBridge`) が作る
 * - ビューポートは1つで、最後に寸法を送った視聴者に合わせる。映すタブが1つなので、
 *   視聴者ごとに別の寸法は持てない。タブを替えても同じ寸法を当てる
 * - フレームが描かれたビューポートの寸法 (CSSピクセル) と世代を、そのフレームより先に
 *   視聴者へ知らせる。ビューポートは共有なので、視聴者は自分のペインの寸法や倍率からは
 *   座標を決められない。視聴者ごとに知らせた世代を覚え、変わったときだけ送る
 * - ビューポートの寸法は、このモジュールがページへ当てたものだけをパイプラインへ伝える。
 *   監視フレームのメタデータの寸法からは決めない。届いた監視フレームは、ackを返してから
 *   そのままパイプラインへ渡す。どのフレームを使わないかの決まりはパイプラインにある
 * - JavaScriptのダイアログが開いた、閉じたことは、パイプライン (開いている間は取り直しが
 *   返らない) と、ページのUIを受け持つ browser-page-controller.ts の両方へ伝える
 * - headlessのChromiumにはブラウザのUIが無い。アドレスバー、戻ると進む、ダイアログ、
 *   コピーは browser-page-controller.ts が受け持ち、このモジュールは、タブのsessionの
 *   イベントと視聴者のメッセージを渡すだけにする。タブへattachするたびに1つ作り、
 *   そのタブから離れるときに捨てる
 * - `Target.targetInfoChanged` で映しているタブの題が変わったと分かったら、履歴を読み直す。
 *   ページの状態の題は履歴から読むので、遷移を伴わない題の変更はこれでしか分からない
 * - 視聴者へJSONを配るのは、参加の手続き (寸法の通知) が済んだ視聴者だけ。参加した
 *   視聴者には、寸法、ページの状態、開いているダイアログ、タブの一覧の順に知らせる。
 *   映すタブが無い間に参加した視聴者には、次のタブの準備が終わったときに、全員と一緒に知らせる
 */

import type {
  BrowserClientMessage,
  BrowserServerMessage,
  BrowserTabInfo,
} from "@ark/shared";
import type { CdpClient } from "./browser-cdp-client.js";
import {
  BrowserFramePipeline,
  monitorParams,
  readFrameMetadata,
} from "./browser-frame-pipeline.js";
import {
  BrowserPageController,
  PAGE_STATE_EVENTS,
} from "./browser-page-controller.js";
import {
  isNumber,
  parseClientMessage,
  toCdpCommand,
} from "./browser-protocol.js";
import { BrowserTabController } from "./browser-tab-controller.js";

export { encodeFrameHeader } from "./browser-frame-pipeline.js";

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
  targetId: string;
  /** このタブの、ページのUIにあたる部分 */
  ui: BrowserPageController<ViewerSocket>;
}

interface Viewport {
  width: number;
  height: number;
  dpr: number;
  mobile: boolean;
}

/** 視聴者の送信バッファがこれ以上なら、その視聴者へはフレームを送らない (バイト) */
const BACKPRESSURE_BYTES = 1_000_000;
/** ペインのドラッグ中に寸法を変え続けないための待ち (ミリ秒) */
const RESIZE_DEBOUNCE_MS = 150;
const WS_OPEN = 1;

const DEFAULT_VIEWPORT: Viewport = {
  width: 1280,
  height: 900,
  dpr: 1,
  mobile: false,
};

const DISCONNECTED_MESSAGE = "ブラウザとの接続が切れました";
const CONNECT_FAILED_MESSAGE = "ブラウザへ接続できません";
const LEFT_MESSAGE = "準備の途中でタブから離れました";

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
  private connecting: Promise<void> | null = null;
  /** いま使っている接続。古い接続のcloseやイベントを見分けるのに使う */
  private cdp: CdpLike | null = null;
  /** attachしたタブ。準備の途中のものも入る。sessionのイベントは、これと突き合わせる */
  private attached: Page | null = null;
  /** 準備が終わって映しているタブ。切り替えの途中は `null` で、その間の入力は捨てる */
  private page: Page | null = null;
  /** いまの接続の、タブの一覧と切り替え。接続してから接続を捨てるまで持つ */
  private tabUi: BrowserTabController<ViewerSocket> | null = null;
  /** `reset` のたびに進める。進んだあとに終わった `connect()` は捨てる */
  private epoch = 0;
  private casting = false;
  /**
   * screencastを始めるたび、止めるたびに進める。遅れて届いた開始の失敗が、
   * そのあとに始め直したscreencastを巻き込まないように見分ける
   */
  private castGeneration = 0;
  private viewport: Viewport = DEFAULT_VIEWPORT;
  /** いまのタブに当てた寸法。同じ寸法を当て直さないために持つ */
  private appliedViewport: Viewport | null = null;
  /** 視聴者ごとの、最後に知らせたビューポートの世代。同じ世代を二度送らないために持つ */
  private readonly notifiedGen = new Map<ViewerSocket, number>();
  /** 参加の手続きが済んだ視聴者。ページの状態とダイアログは、この視聴者にだけ配る */
  private readonly joined = new Set<ViewerSocket>();
  private resizeTimer: NodeJS.Timeout | null = null;
  /** 監視フレームから、何を取り直してどの視聴者へ送るかを決める */
  private readonly pipeline = new BrowserFramePipeline<ViewerSocket>({
    viewers: () => this.viewers,
    canReceive,
    deliver: (ws, frame) => this.deliver(ws, frame),
    capture: params => this.capture(params),
  });

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
      if (msg) this.handleMessage(ws, msg);
    });
    ws.on("close", () => this.detach(ws));
    ws.on("error", () => this.detach(ws));
    void this.join(ws);
  }

  /** つないでいなければつなぎ、映しているタブを `url` へ遷移させる。切り替えの途中なら終わるのを待つ */
  async navigate(url: string): Promise<void> {
    await this.ensurePage();
    await this.tabUi?.idle();
    const page = this.page;
    if (!page) throw new Error(DISCONNECTED_MESSAGE);
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
    try {
      await this.ensurePage();
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
    // フレームがまだ無くても寸法は知らせる。視聴者は寸法を知るまでマウスの入力を送れない
    if (ws.readyState === WS_OPEN) {
      try {
        this.notifyViewport(ws);
      } catch (error) {
        warn("視聴者への送信に失敗", error);
        this.detach(ws);
        terminate(ws);
        return;
      }
    }
    this.joined.add(ws);
    // 映すタブが無い間 (切り替えの途中) は、準備が終わったときに全員と一緒に知らせる
    const page = this.page;
    page?.ui.greet(ws);
    this.tabUi?.greet(ws);
    // 知らせる途中で送信が投げた視聴者は、もう外れている
    if (!this.viewers.has(ws)) return;
    // screencastは画面が変わったときしか監視フレームを出さない。もう始まっているなら、
    // 何かが動くのを待たずに全画面を取り直して送る
    this.pipeline.requestFull(ws);
    if (page) this.startCast(page);
  }

  private detach(ws: ViewerSocket): void {
    if (!this.viewers.delete(ws)) return;
    this.notifiedGen.delete(ws);
    this.joined.delete(ws);
    if (this.viewers.size === 0) this.stopCast();
  }

  /** つないでいなければつなぐ。最初のタブの準備が終わったら解決する */
  private ensurePage(): Promise<void> {
    if (!this.connecting) {
      const attempt = this.openConnection();
      this.connecting = attempt;
      // 失敗した接続を持ち続けない。次の `attach` でつなぎ直す
      attempt.catch(() => {
        if (this.connecting === attempt) this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async openConnection(): Promise<void> {
    const epoch = this.epoch;
    const cdp = await this.connect();
    if (epoch !== this.epoch) {
      cdp.close();
      throw new Error("接続を待つ間にリセットされました");
    }
    this.cdp = cdp;
    /** 捨てた接続から遅れて届いたものを、いまの接続に響かせない */
    const mine = () => this.cdp === cdp;
    const tabUi = new BrowserTabController<ViewerSocket>({
      send: (method, params) => cdp.send(method, params),
      current: () => (mine() ? (this.page?.targetId ?? null) : null),
      leave: gone => {
        if (mine()) this.leavePage(gone);
      },
      enter: tab => this.enterTab(cdp, tab),
      toViewer: (ws, message) => this.sendJson(ws, message),
      toAll: message => this.broadcast(message),
      fail: error => {
        warn("どのタブにもつなげません", error);
        this.failConnection(cdp, "映せるタブがありません");
      },
    });
    this.tabUi = tabUi;
    /** `sessionId` が、いまattachしているタブ (準備の途中のものも含む) のsessionなら、そのタブ */
    const tabOf = (sessionId: unknown): Page | null => {
      const tab = this.attached;
      return mine() && tab !== null && tab.sessionId === sessionId ? tab : null;
    };
    // リスナーは接続ごとに1回だけ登録する
    cdp.onClose(() => this.teardown(cdp));
    cdp.on("Page.screencastFrame", (params, sessionId) =>
      this.handleFrame(cdp, params, sessionId)
    );
    cdp.on("Target.targetCreated", params => {
      if (mine()) tabUi.targetCreated(params);
    });
    cdp.on("Target.targetInfoChanged", params => {
      if (mine() && tabUi.targetInfoChanged(params)) this.page?.ui.rereadSoon();
    });
    cdp.on("Target.targetDestroyed", params => {
      if (mine()) tabUi.targetDestroyed(params);
    });
    // タブが閉じられたときもここへ来る (タブが消えると、そのsessionはdetachされる)。
    // ブラウザから届くイベントで、どのsessionかは `params` に入っている
    cdp.on("Target.detachedFromTarget", params => {
      if (tabOf(params?.sessionId)) tabUi.lost();
    });
    cdp.on("Inspector.targetCrashed", (_params, sessionId) => {
      const tab = tabOf(sessionId);
      if (tab) tabUi.crashed(tab.targetId);
    });
    // 準備の途中に開いたダイアログも覚える
    const dialog = (open: boolean) => (params: unknown, sessionId?: string) => {
      const tab = tabOf(sessionId);
      if (!tab) return;
      this.pipeline.setDialogOpen(open);
      if (open) tab.ui.dialogOpening(params);
      else tab.ui.dialogClosed();
    };
    cdp.on("Page.javascriptDialogOpening", dialog(true));
    cdp.on("Page.javascriptDialogClosed", dialog(false));
    for (const method of PAGE_STATE_EVENTS) {
      cdp.on(method, (params, sessionId) => {
        tabOf(sessionId)?.ui.handleEvent(method, params);
      });
    }
    try {
      // いまあるターゲットの `Target.targetCreated` が、応答より先に届く
      await cdp.send("Target.setDiscoverTargets", { discover: true });
      // 届かなかったぶんを補う。もう一覧にあるタブは、並びを変えない
      const { targetInfos } = await cdp.send<{ targetInfos?: unknown }>(
        "Target.getTargets"
      );
      if (mine() && Array.isArray(targetInfos)) {
        for (const targetInfo of targetInfos) {
          tabUi.targetCreated({ targetInfo });
        }
      }
      await tabUi.open();
      if (!mine()) throw new Error(DISCONNECTED_MESSAGE);
    } catch (error) {
      // 準備の途中で失敗した接続は使わない。残すと、つなぎ直すたびに接続が増える
      if (mine()) this.dropConnection();
      cdp.close();
      throw error;
    }
  }

  /**
   * タブへつなぎ、映せるところまで準備する。最初の接続でも、切り替えでも、消えたタブからの
   * つなぎ直しでも、これを通る。途中で失敗するか、タブから離れたら、rejectする
   * (attachしていれば離れてから)。
   */
  private async enterTab(cdp: CdpLike, target: BrowserTabInfo): Promise<void> {
    const targetId = target.id;
    // 前面でないタブは描画されず、screencastのフレームも取り直しも返らない
    await cdp.send("Target.activateTarget", { targetId });
    const { sessionId } = await cdp.send<{ sessionId?: unknown }>(
      "Target.attachToTarget",
      { targetId, flatten: true }
    );
    if (this.cdp !== cdp) throw new Error(DISCONNECTED_MESSAGE);
    if (typeof sessionId !== "string") {
      throw new Error("attachしたsessionのidを読めません");
    }
    // `Page.enable` より先に作る。準備の途中に届く遷移とダイアログも覚える
    const ui = new BrowserPageController<ViewerSocket>(
      {
        send: (method, params) => cdp.send(method, params, sessionId),
        toViewer: (ws, message) => this.sendJson(ws, message),
        toAll: message => this.broadcast(message),
      },
      targetId,
      target.url === "" ? undefined : target
    );
    const tab: Page = { cdp, sessionId, targetId, ui };
    this.attached = tab;
    let viewport: Viewport;
    try {
      /** 応答を待つ間にタブから離れていたら (消えた、接続が切れた)、準備を続けない */
      const step = async (method: string, params?: object) => {
        await cdp.send(method, params, sessionId);
        if (this.attached !== tab) throw new Error(LEFT_MESSAGE);
      };
      await step("Page.enable");
      // headlessのタブはフォーカスを持たない。これが無いと、キャレットが出ず、
      // focusに頼るページが動かない
      await step("Emulation.setFocusEmulationEnabled", { enabled: true });
      viewport = this.viewport;
      await step("Emulation.setDeviceMetricsOverride", metricsParams(viewport));
    } catch (error) {
      if (this.attached === tab) this.leavePage(false);
      throw error;
    }
    this.page = tab;
    this.appliedViewport = viewport;
    // 前のタブから離れたときに寸法を外してあるので、同じ寸法でも世代が進む
    this.pipeline.setApplied(viewport);
    // 準備の途中に届いたresizeは、デバウンスが明けた時点でタブが無く、当たっていない。
    // screencastはまだ始めていないので、ここでは寸法だけが変わる
    if (!sameViewport(this.viewport, viewport)) this.applyViewport();
    // `Page.enable` は過去の遷移を送り直さない。いまのタイトルと履歴は読みにいく
    ui.refresh();
    // 先にいる視聴者へ、新しいタブのことを知らせる。寸法が先 (世代が進んでいる)
    for (const ws of [...this.joined]) this.announceViewport(ws);
    ui.announce();
    if (this.joined.size > 0) this.startCast(tab);
  }

  /**
   * いまのタブ (準備の途中のものも含む) から離れる。タブ1つぶんの状態を捨てるだけで、
   * 視聴者とCDPの接続には触らない。`gone` は、タブのsessionがもう無いとき
   * (止める、離れるためのコマンドを送らない)。`silent` は、視聴者をこのあと閉じるとき。
   */
  private leavePage(gone: boolean, silent = false): void {
    const tab = this.attached;
    const wasCasting = this.casting;
    this.attached = null;
    this.page = null;
    this.casting = false;
    this.castGeneration++;
    this.appliedViewport = null;
    // 監視の状態、取り直しの途中の結果、スクロールした位置、ダイアログが開いていたことを捨てる
    this.pipeline.setApplied(null);
    // 待っていた寸法は覚えてあり、次のタブの準備で当てる
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    if (!tab) return;
    const dialogOpen = tab.ui.dialogOpen;
    tab.ui.dispose();
    // 次のタブでダイアログが開いているかは分からない。前のタブのものは閉じたと知らせる
    if (dialogOpen && !silent) this.broadcast({ t: "dialogClosed" });
    if (gone || tab.cdp.closed) return;
    if (wasCasting) {
      tab.cdp
        .send("Page.stopScreencast", undefined, tab.sessionId)
        .catch(error => warn("screencastの停止に失敗", error));
    }
    tab.cdp
      .send("Target.detachFromTarget", { sessionId: tab.sessionId })
      .catch(error => warn("タブからのdetachに失敗", error));
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
        monitorParams(this.viewport),
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
    this.pipeline.stop();
    const page = this.page;
    if (!page || page.cdp.closed) return;
    page.cdp
      .send("Page.stopScreencast", undefined, page.sessionId)
      .catch(error => warn("screencastの停止に失敗", error));
  }

  private handleMessage(ws: ViewerSocket, msg: BrowserClientMessage): void {
    if (msg.t === "refresh") {
      this.pipeline.requestFull(ws);
      return;
    }
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
    const page = this.page;
    switch (msg.t) {
      case "nav":
      case "dialog":
      case "copy":
        // タブの準備が終わるまでは、入力と同じく捨てる
        page?.ui.handle(ws, msg);
        return;
      case "tab":
        this.tabUi?.handle(ws, msg);
        return;
      case "selectChoose":
      case "selectCancel":
        // `<select>` の選択肢を受け持つモジュールが扱う。まだ無いので何もしない
        return;
      case "touch":
        // タッチの入力への変換が扱う。まだ無いので何もしない
        return;
    }
    const command = toCdpCommand(msg);
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
    // 同じ寸法なら何もしない。始め直すと、全員へ全画面を送り直すことになる
    if (this.appliedViewport && sameViewport(this.appliedViewport, viewport)) {
      return;
    }
    this.appliedViewport = viewport;
    // 画面が切り替わる。監視をやり直し、全員へ全画面を送り直す
    this.pipeline.setApplied(viewport);
    const { cdp, sessionId } = page;
    cdp
      .send(
        "Emulation.setDeviceMetricsOverride",
        metricsParams(viewport),
        sessionId
      )
      .catch(error => {
        warn("寸法の変更に失敗", error);
        // 当たっていないので、同じ寸法がもう一度来たら当て直す。ページは前の寸法のままで、
        // その監視フレームは、パイプラインが寸法を見るのをやめるまで使われない
        if (this.page === page && this.appliedViewport === viewport) {
          this.appliedViewport = null;
        }
      });
    if (!this.casting) return;
    // 監視フレームの寸法は始めたときに決まるので、始め直す。応答を待たずに続けて送るのは、
    // 間に視聴者が0人になって止めたscreencastを、ここで始め直してしまわないため
    const generation = ++this.castGeneration;
    cdp
      .send("Page.stopScreencast", undefined, sessionId)
      .catch(error => warn("screencastの停止に失敗", error));
    cdp
      .send("Page.startScreencast", monitorParams(viewport), sessionId)
      .catch(error => this.failCast(page, generation, error));
  }

  /**
   * 監視フレームを受け取る。`params.sessionId` はフレームの番号で、ackに使う。
   * 名前は同じだが、CDPのsession (`Page.sessionId`) とは別のもの。
   */
  private handleFrame(
    cdp: CdpLike,
    params:
      | { data?: unknown; sessionId?: unknown; metadata?: unknown }
      | undefined,
    sessionId: string | undefined
  ): void {
    const page = this.page;
    // 止めたあとに届いた分と、離れたタブのsessionから届いた分は使わない。ackも要らない
    if (!page || page.cdp !== cdp || !this.casting) return;
    if (page.sessionId !== sessionId) return;
    if (typeof params?.data !== "string" || !isNumber(params.sessionId)) return;
    // 1つでも返し忘れると、Chromiumが出せるフレームの枠が減ったままになる
    cdp
      .send(
        "Page.screencastFrameAck",
        { sessionId: params.sessionId },
        page.sessionId
      )
      .catch(error => warn("ackに失敗", error));
    this.pipeline.monitorFrame(
      Buffer.from(params.data, "base64"),
      readFrameMetadata(params.metadata)
    );
  }

  /** いまのタブの画面を取り直す。タブが無ければrejectする */
  private capture(params: object): Promise<unknown> {
    const page = this.page;
    if (!page) return Promise.reject(new Error(DISCONNECTED_MESSAGE));
    return page.cdp.send("Page.captureScreenshot", params, page.sessionId);
  }

  /**
   * 取り直したフレームを1つ送る。寸法が先。フレームが先に届くと、視聴者は世代の違う
   * フレームとして捨てる。1人の送信の失敗で、残りの視聴者への送信を止めない。
   */
  private deliver(ws: ViewerSocket, frame: Buffer): void {
    if (!this.viewers.has(ws)) return;
    try {
      this.notifyViewport(ws);
      ws.send(frame);
    } catch (error) {
      warn("視聴者への送信に失敗", error);
      this.detach(ws);
      terminate(ws);
    }
  }

  /**
   * いまのフレームが描かれるビューポートの寸法と世代を、まだ知らせていない視聴者へ送る。
   * 送信が投げたら、そのまま呼び出し側へ投げる。
   */
  private notifyViewport(ws: ViewerSocket): void {
    const viewport = this.pipeline.viewport;
    if (!viewport || this.notifiedGen.get(ws) === viewport.gen) return;
    const body: BrowserServerMessage = { t: "viewport", ...viewport };
    ws.send(JSON.stringify(body));
    this.notifiedGen.set(ws, viewport.gen);
  }

  /** 入ったあとにタブが替わった視聴者へ、新しい世代の寸法を知らせる。投げたら、その視聴者だけを外す */
  private announceViewport(ws: ViewerSocket): void {
    if (!this.viewers.has(ws) || ws.readyState !== WS_OPEN) return;
    try {
      this.notifyViewport(ws);
    } catch (error) {
      warn("視聴者への送信に失敗", error);
      this.detach(ws);
      terminate(ws);
    }
  }

  /** 参加している視聴者の全員へJSONを送る */
  private broadcast(message: BrowserServerMessage): void {
    for (const ws of [...this.joined]) this.sendJson(ws, message);
  }

  /**
   * 参加している視聴者1人へJSONを送る。去った視聴者と閉じかけの視聴者へは送らない。
   * 送信が投げたら、その視聴者だけを外す。
   *
   * コピーの結果 (`clipboard`) だけは、送信が詰まっている視聴者へは送らずに捨てる。
   * 1通が1MB近くになるので、詰まったままコピーを繰り返す視聴者のぶんが積もる。
   * ほかのJSONは小さいので、詰まっていても送る。
   */
  private sendJson(ws: ViewerSocket, message: BrowserServerMessage): void {
    if (!this.joined.has(ws) || ws.readyState !== WS_OPEN) return;
    if (message.t === "clipboard" && !canReceive(ws)) return;
    try {
      ws.send(JSON.stringify(message));
    } catch (error) {
      warn("視聴者への送信に失敗", error);
      this.detach(ws);
      terminate(ws);
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
   * CDPはつながっているが、映せるタブが無くなったとき。切れたときと同じに片づけてから、
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
    this.notifiedGen.clear();
    this.joined.clear();
    return viewers;
  }

  /** 接続にひもづく状態を捨てる。ビューポートは次の接続でも使うので残す */
  private dropConnection(): void {
    this.cdp = null;
    this.connecting = null;
    this.tabUi?.dispose();
    this.tabUi = null;
    this.leavePage(true, true);
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
