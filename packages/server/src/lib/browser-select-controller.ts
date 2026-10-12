/**
 * 映しているタブ1つぶんの `<select>`。ページが知らせた選択肢を視聴者へ渡し、視聴者が
 * 選んだものをページへ入れる。ポップアップを横取りする理由と、ページへ入れるスクリプトは
 * browser-select-shim.ts にある。
 *
 * ブリッジ (browser-cdp-bridge.ts) がタブへattachするたびに1つ作り、そのタブから離れる
 * ときに `dispose` する。CDPと視聴者へは、受け取った `SelectLink` を通してだけ触る。
 *
 * - 準備は、`Runtime.enable`、`Runtime.addBinding`、`Page.addScriptToEvaluateOnNewDocument`、
 *   いまの文書への `Runtime.evaluate` の順。`Runtime.enable` を先に送らないと、bindingが
 *   ページに置かれない (実物のChromiumで確かめた)。有効にすると `Runtime.*` のイベント
 *   (実行コンテキスト、コンソール、例外) が届くようになるが、使うのは `Runtime.bindingCalled`
 *   だけで、ほかは聞かない
 * - いまの文書へ入れる評価は、待たず、失敗しても準備を止めない。ダイアログが開いている
 *   タブでは評価が返らない。次に読み込む文書には、新しい文書へのスクリプトで入る
 * - bindingはページのどのスクリプトからも呼べるので、知らせは信用しない。検査を通らない
 *   ものは捨てる。捨てたことの警告は、ページが送り続けても1秒に1回まで
 * - 映していないタブ (準備の途中) の知らせは捨てる。入力が届かない間に利用者が
 *   `<select>` を押すことは無い
 * - 開いている選択は、タブに1つだけ。新しい知らせが来たら、前のものを閉じたと知らせてから
 *   置き換える
 * - 視聴者へ渡す番号は、ページの中のidではなく、ブリッジが振る番号。視聴者は、ページの中の
 *   idを名指しできない。古い番号や、ほかのタブの番号での選択は無視する
 * - 選択を受けるのは、開いている番号で、知らせた選択肢の範囲の中で、無効と知らせていない
 *   ものだけ。ページで評価する式には、整数2つだけを埋め込む (視聴者やページから来た
 *   文字列を埋め込まない)。評価は待たず、送ったらすぐ閉じる。結果は使わない
 * - メインフレームの遷移、ダイアログ、タブから離れることでも閉じる。閉じたら全員へ知らせる。
 *   取り消しのときだけ、ページの中で覚えた要素も捨てさせる (ほかは、文書がもう無いか、
 *   評価が返らない)
 * - `dispose` のあとは何も送らない。閉じたことの知らせは、ブリッジが `openId` を読んで送る
 */

import type { BrowserClientMessage, BrowserServerMessage } from "@ark/shared";
import { COPY_TIMEOUT_MS } from "./browser-page-controller.js";
import {
  clampSelectRect,
  parseSelectPayload,
  SELECT_BINDING_NAME,
  SELECT_SHIM_SOURCE,
  selectCancelExpression,
  selectChooseExpression,
} from "./browser-select-shim.js";

/** 捨てた知らせの警告を、これより短い間隔では出さない (ミリ秒) */
export const SELECT_WARN_INTERVAL_MS = 1000;

const DISPOSED_MESSAGE = "準備の途中でタブから離れました";

/** このモジュールが扱う視聴者のメッセージ */
export type SelectCommand = Extract<
  BrowserClientMessage,
  { t: "selectChoose" | "selectCancel" }
>;

type SelectMessage = Extract<BrowserServerMessage, { t: "select" }>;

/** タブと視聴者への出口。`V` は視聴者 */
export interface SelectLink<V> {
  /** タブのsessionへCDPのコマンドを送る */
  send(method: string, params?: object): Promise<unknown>;
  /** 視聴者1人へ送る。去った視聴者へは何もしない */
  toViewer(viewer: V, message: BrowserServerMessage): void;
  /** 参加している視聴者の全員へ送る */
  toAll(message: BrowserServerMessage): void;
  /** このタブを映しているときの、ビューポートの寸法 (CSSピクセル)。映していなければ `null` */
  viewport(): { width: number; height: number } | null;
  /** 視聴者へ渡す番号を振る。タブを替えても重ならない */
  nextId(): number;
}

function warn(what: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[BrowserBridge] ${what}: ${message}`);
}

export class BrowserSelectController<V> {
  /** 開いている選択。`pageId` はページの中のid、`message` は視聴者へ送ったもの */
  private open: { pageId: number; message: SelectMessage } | null = null;
  private lastWarnAt = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(private readonly link: SelectLink<V>) {}

  /** 開いている選択の、視聴者へ渡した番号。開いていなければ `null` */
  get openId(): number | null {
    return this.open?.message.id ?? null;
  }

  /**
   * ページから知らせを受け取れるようにし、スクリプトを入れる。途中で失敗するか、
   * `dispose` されたらrejectする。
   */
  async prepare(): Promise<void> {
    // bindingより先に要る。これが無いと、bindingがページに置かれない
    await this.step("Runtime.enable");
    await this.step("Runtime.addBinding", { name: SELECT_BINDING_NAME });
    await this.step("Page.addScriptToEvaluateOnNewDocument", {
      source: SELECT_SHIM_SOURCE,
    });
    this.evaluate(SELECT_SHIM_SOURCE, "スクリプトを入れるのに失敗");
  }

  /** タブのsessionから届いた `Runtime.bindingCalled` を受け取る */
  bindingCalled(params: unknown): void {
    if (this.disposed) return;
    const { name, payload } = (params ?? {}) as {
      name?: unknown;
      payload?: unknown;
    };
    if (name !== SELECT_BINDING_NAME) return;
    const parsed =
      typeof payload === "string" ? parseSelectPayload(payload) : null;
    if (!parsed) {
      this.warnDropped();
      return;
    }
    const viewport = this.link.viewport();
    if (!viewport) return;
    this.close();
    const message: SelectMessage = {
      t: "select",
      id: this.link.nextId(),
      options: parsed.options,
      selectedIndex: parsed.selectedIndex,
      rect: clampSelectRect(parsed.rect, viewport),
    };
    this.open = { pageId: parsed.id, message };
    this.link.toAll(message);
  }

  /** タブのsessionから届いた `Page.frameNavigated` を受け取る。メインフレームなら閉じる */
  frameNavigated(params: unknown): void {
    const frame = (params as { frame?: unknown } | null | undefined)?.frame;
    if (typeof frame !== "object" || frame === null) return;
    if ((frame as { parentId?: unknown }).parentId !== undefined) return;
    this.close();
  }

  /** 開いている選択を無効にし、全員へ知らせる。開いていなければ何もしない */
  close(): void {
    if (this.disposed || !this.open) return;
    const { id } = this.open.message;
    this.open = null;
    this.link.toAll({ t: "selectClosed", id });
  }

  /** 参加した視聴者へ、開いている選択を知らせる */
  greet(viewer: V): void {
    if (this.disposed || !this.open) return;
    this.link.toViewer(viewer, this.open.message);
  }

  handle(_viewer: V, msg: SelectCommand): void {
    const open = this.open;
    if (this.disposed || !open || msg.id !== open.message.id) return;
    if (msg.t === "selectCancel") {
      this.evaluate(
        selectCancelExpression(open.pageId),
        "選択の取り消しに失敗"
      );
      this.close();
      return;
    }
    const option = open.message.options[msg.index];
    if (!Number.isInteger(msg.index) || !option || option.disabled) return;
    this.evaluate(selectChooseExpression(open.pageId, msg.index), "選択に失敗");
    // 結果を待たない。ページが塞がっていても、視聴者の一覧は閉じる
    this.close();
  }

  /** 状態を捨てる。このあとは何も送らない */
  dispose(): void {
    this.disposed = true;
    this.open = null;
  }

  private async step(method: string, params?: object): Promise<void> {
    if (this.disposed) throw new Error(DISPOSED_MESSAGE);
    await this.link.send(method, params);
    if (this.disposed) throw new Error(DISPOSED_MESSAGE);
  }

  /** ページで式を評価する。待たない。長く走る式は `COPY_TIMEOUT_MS` でChromiumが打ち切る */
  private evaluate(expression: string, what: string): void {
    this.link
      .send("Runtime.evaluate", {
        expression,
        awaitPromise: false,
        returnByValue: true,
        timeout: COPY_TIMEOUT_MS,
      })
      .catch(error => {
        if (!this.disposed) warn(what, error);
      });
  }

  private warnDropped(): void {
    const now = Date.now();
    if (now - this.lastWarnAt < SELECT_WARN_INTERVAL_MS) return;
    this.lastWarnAt = now;
    console.warn("[BrowserBridge] <select>の知らせを捨てました (形が違います)");
  }
}
