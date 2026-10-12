/**
 * ブラウザ機能のタブ。一覧を視聴者へ知らせ、どのタブを映すかを決める。
 * headlessのChromiumにはタブのUIが無いので、Arkが持つ。
 *
 * ブリッジ (browser-cdp-bridge.ts) がCDPの接続ごとに1つ作り、接続を捨てるときに `dispose`
 * する。タブへつなぐ、離れる、視聴者へ送ることは、受け取った `TabLink` を通してだけ行う。
 * タブ1つぶんの準備 (attach、寸法、監視) の中身は知らない。
 *
 * - 一覧 (browser-tabs.ts) は `Target.*` のイベントから作る。変わったら、100ms待って
 *   1回にまとめて全員へ知らせる。`activeId` は、準備が終わって映しているタブ。映している
 *   タブが無い間 (切り替えの途中) は知らせず、つなぎ終えたときに必ず1回知らせる
 * - タブを動かす操作 (切り替え、閉じる、新しいタブ、消えたタブからの移動) は、1本の列に
 *   並べて1つずつ行う。互いに割り込むと、離れたタブへ準備を続けたり、閉じたタブへつないだり
 *   する。待っている切り替えは最後の1つだけを残す。列の長さには上限を置く
 * - 操作を受けるのは、一覧にあるidだけ。列に並べるときと、実際に行うときの両方で確かめる
 *   (待っている間にタブが消える)
 * - 映しているタブが無くなったら、列が空いたところで必ずどこかへつなぎ直す。選ぶ順は、
 *   操作が望んだタブ、消えたタブの直前、直後、あとは近い順、残りの全部。つなげなかった
 *   タブと、sessionが切れたばかりのタブは飛ばす。どれにもつなげなければ `about:blank` を作ってつなぐ。それもできなければ
 *   CDPが切れたときと同じに扱う (`TabLink.fail`)。視聴者を切るのは、このときだけ
 * - 映しているタブを閉じるときは、先に離れてから閉じ、そのまま次のタブへつなぐ。
 *   そのあとに届く、閉じたタブのイベントでは何もしない
 * - 映しているタブが勝手に消えた (ページが `window.close()` した、sessionがdetachされた)
 *   ときは、離れて、同じ決まりでつなぎ直す。クラッシュしたタブは、閉じてからつなぎ直す
 *   (閉じられなくても続ける)
 * - 映しているタブが開いたタブ (`openerId` が映しているタブ) へは、自動で切り替える。
 *   利用者がリンクを押した結果だから。ほかのタブが開いたタブは、一覧に出すだけにする
 * - 視聴者が開けるタブの数には上限を置く。ページが開くタブは止められないので、数えるだけで
 *   閉じない
 * - `tab new` で作ったタブと、閉じたタブは、Chromiumのイベントを待たずに一覧へ反映する。
 *   イベントが遅れても、`activeId` が一覧に無い状態を視聴者へ見せない
 * - `dispose` のあとは、遅れて返ったCDPの応答を使わず、何も送らない
 */

import type {
  BrowserClientMessage,
  BrowserServerMessage,
  BrowserTabInfo,
} from "@ark/shared";
import { BrowserTabs, MAX_TABS, readTargetInfo } from "./browser-tabs.js";

/** 一覧の変化をまとめる待ち (ミリ秒) */
export const TABS_DEBOUNCE_MS = 100;
/** 待たせておく操作の数の上限。超えたぶんは捨てる */
const MAX_PENDING = 32;

const BLANK_URL = "about:blank";
const TOO_MANY_MESSAGE = "タブが多すぎます";

/** このモジュールが扱う視聴者のメッセージ */
export type TabCommand = Extract<BrowserClientMessage, { t: "tab" }>;

/** ブラウザ、タブ1つぶんの準備、視聴者への出口。`V` は視聴者 */
export interface TabLink<V> {
  /** ブラウザへ (どのタブのsessionでもなく) CDPのコマンドを送る */
  send(method: string, params?: object): Promise<unknown>;
  /** 準備が終わって映しているタブのid。無ければ `null` */
  current(): string | null;
  /**
   * いまのタブ (準備の途中のものも含む) から離れる。離れていれば何もしない。
   * `gone` は、タブのsessionがもう無いとき (離れるためのコマンドを送らない)。
   */
  leave(gone: boolean): void;
  /** タブへつなぎ、映せるところまで準備する。できなければrejectし、離れた状態に戻す */
  enter(tab: BrowserTabInfo): Promise<void>;
  /** 視聴者1人へ送る。去った視聴者へは何もしない */
  toViewer(viewer: V, message: BrowserServerMessage): void;
  /** 参加している視聴者の全員へ送る */
  toAll(message: BrowserServerMessage): void;
  /** どのタブにもつなげなくなった。CDPが切れたときと同じに扱う */
  fail(error: unknown): void;
}

type Operation<V> =
  | { kind: "activate"; id: string }
  | { kind: "close"; id: string }
  | { kind: "new"; viewer: V }
  /** クラッシュしたタブを閉じて、一覧から消す */
  | { kind: "discard"; id: string };

function warn(what: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[BrowserBridge] ${what}: ${message}`);
}

function readTargetId(value: unknown): string | null {
  const id = (value as { targetId?: unknown } | null)?.targetId;
  return typeof id === "string" && id !== "" ? id : null;
}

export class BrowserTabController<V> {
  private readonly tabs = new BrowserTabs();
  /** 待っている操作。先頭から行う */
  private readonly queue: Operation<V>[] = [];
  /** 操作を順に行っている間のPromise。走っていなければ `null` */
  private draining: Promise<void> | null = null;
  /** 消えたタブの代わりに移る先の候補。消えたときの並びから決めておく */
  private fallback: string[] = [];
  /** いま `TabLink.enter` で準備しているタブ。映しているタブ (`current`) には、まだなっていない */
  private entering: string | null = null;
  /**
   * sessionが切れたタブ。一覧に残っていても、次につなぐまでは、つなぎ直す先に選ばない
   * (消える途中のタブへつないでしまう)。視聴者が名指しで切り替えたときは試す
   */
  private readonly lostIds = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  /** 最初のタブへつなぎ終えたか。それまでは視聴者の操作を受けず、一覧も知らせない */
  private opened = false;
  private disposed = false;

  constructor(private readonly link: TabLink<V>) {}

  /**
   * 最初のタブへつなぐ。一覧の先頭から試し、無ければ `about:blank` を作る。
   * どこにもつなげなければrejectする (`TabLink.fail` は呼ばない)。
   */
  async open(): Promise<void> {
    await this.pump();
    this.opened = true;
  }

  /** 走っている操作と、待っている操作がすべて終わるまで待つ。rejectしない */
  async idle(): Promise<void> {
    while (this.draining) await this.draining.catch(() => {});
  }

  /** `Target.targetCreated` を受け取る */
  targetCreated(params: unknown): void {
    if (this.disposed) return;
    const info = readTargetInfo(
      (params as { targetInfo?: unknown } | null | undefined)?.targetInfo
    );
    if (!info) return;
    const known = this.tabs.has(info.id);
    if (!this.tabs.add(info)) return;
    this.schedulePublish();
    const current = this.link.current();
    if (!known && current !== null && info.openerId === current) {
      this.enqueue({ kind: "activate", id: info.id });
    }
  }

  /**
   * `Target.targetInfoChanged` を受け取る。映しているタブの題が変わったら `true`
   * (ページの状態の題は履歴から読むので、使う側が読み直す)。
   */
  targetInfoChanged(params: unknown): boolean {
    if (this.disposed) return false;
    const info = readTargetInfo(
      (params as { targetInfo?: unknown } | null | undefined)?.targetInfo
    );
    const change = info && this.tabs.update(info);
    if (!info || !change) return false;
    this.schedulePublish();
    return change.title && info.id === this.link.current();
  }

  /** `Target.targetDestroyed` を受け取る */
  targetDestroyed(params: unknown): void {
    if (this.disposed) return;
    const id = readTargetId(params);
    if (id === null || !this.tabs.has(id)) return;
    // 消す前の並びから、移る先を決める
    const fallback = this.tabs.fallbacks(id);
    this.tabs.remove(id);
    this.schedulePublish();
    if (id === this.link.current()) this.fallback = fallback;
    else if (id !== this.entering) return;
    // 準備の途中のタブなら、離れることで準備が失敗し、次の候補へ進む
    this.link.leave(true);
    this.kick();
  }

  /** いまのタブ (準備の途中のものも含む) のsessionがdetachされた */
  lost(): void {
    if (this.disposed) return;
    const current = this.link.current();
    if (current !== null) this.fallback = this.tabs.fallbacks(current);
    const id = current ?? this.entering;
    if (id !== null) this.lostIds.add(id);
    this.link.leave(true);
    this.kick();
  }

  /** いまのタブ (準備の途中のものも含む) がクラッシュした。`id` はそのタブ */
  crashed(id: string): void {
    if (this.disposed) return;
    if (id === this.link.current()) this.fallback = this.tabs.fallbacks(id);
    this.lostIds.add(id);
    this.link.leave(true);
    // ほかの操作より先に片づける。クラッシュしたタブへ戻る操作をさせない
    this.queue.unshift({ kind: "discard", id });
    this.kick();
  }

  /** 参加した視聴者へ、一覧を知らせる。映しているタブが無い間は、つなぎ終えたときに届く */
  greet(viewer: V): void {
    const message = this.message();
    if (message) this.link.toViewer(viewer, message);
  }

  handle(viewer: V, msg: TabCommand): void {
    // 最初のタブへつなぎ終えるまでは、入力と同じく捨てる
    if (this.disposed || !this.opened) return;
    switch (msg.type) {
      case "activate":
      case "close":
        if (this.tabs.has(msg.id)) this.enqueue({ kind: msg.type, id: msg.id });
        return;
      case "new":
        this.enqueue({ kind: "new", viewer });
        return;
    }
  }

  /** タイマーと待っている操作を捨てる。このあとは何も送らない */
  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private enqueue(operation: Operation<V>): void {
    if (operation.kind === "activate") {
      // 待っている切り替えは、最後の1つだけを残す
      for (let i = this.queue.length - 1; i >= 0; i--) {
        if (this.queue[i].kind === "activate") this.queue.splice(i, 1);
      }
    }
    if (this.queue.length >= MAX_PENDING) return;
    this.queue.push(operation);
    this.kick();
  }

  /** 操作を順に行う。走っていれば、その続きで行われる */
  private pump(): Promise<void> {
    if (!this.draining) {
      const draining = this.drain().finally(() => {
        if (this.draining === draining) this.draining = null;
      });
      this.draining = draining;
    }
    return this.draining;
  }

  private kick(): void {
    this.pump().catch(error => {
      // 最初のタブへつなぐ間の失敗は、`open` の呼び出し側が扱う
      if (!this.disposed && this.opened) this.link.fail(error);
    });
  }

  /** rejectするのは、どのタブにもつなげなかったときだけ */
  private async drain(): Promise<void> {
    for (;;) {
      if (this.disposed) return;
      const operation = this.queue.shift();
      if (operation) await this.run(operation);
      else if (this.link.current() === null) await this.moveTo([]);
      else return;
    }
  }

  private async run(operation: Operation<V>): Promise<void> {
    switch (operation.kind) {
      case "activate": {
        const { id } = operation;
        const from = this.link.current();
        if (!this.tabs.has(id) || id === from) return;
        this.link.leave(false);
        // つなげなければ、もとのタブへ戻る
        await this.moveTo(from === null ? [id] : [id, from]);
        return;
      }
      case "close": {
        const { id } = operation;
        if (!this.tabs.has(id)) return;
        const active = id === this.link.current();
        const fallback = this.tabs.fallbacks(id);
        if (active) this.link.leave(false);
        if (await this.closeTarget(id)) this.forget(id);
        if (active) await this.moveTo(fallback);
        return;
      }
      case "discard":
        await this.closeTarget(operation.id);
        this.forget(operation.id);
        return;
      case "new": {
        if (this.tabs.size >= MAX_TABS) {
          this.link.toViewer(operation.viewer, {
            t: "notice",
            message: TOO_MANY_MESSAGE,
          });
          return;
        }
        let id: string | null;
        try {
          id = await this.createBlank();
        } catch (error) {
          if (!this.disposed) warn("タブの作成に失敗", error);
          return;
        }
        if (this.disposed) return;
        const from = this.link.current();
        this.link.leave(false);
        await this.moveTo(from === null ? [id] : [id, from]);
        return;
      }
    }
  }

  /**
   * `preferred` の順、消えたタブの代わりの候補の順、一覧の順で、つなげるタブを探してつなぐ。
   * どれにもつなげなければ `about:blank` を作ってつなぐ。それもできなければrejectする。
   */
  private async moveTo(preferred: string[]): Promise<void> {
    const tried = new Set<string>();
    for (;;) {
      if (this.disposed) return;
      // 待っている間に一覧が変わるので、毎回選び直す
      const others = [
        ...this.fallback,
        ...this.tabs.list().map(tab => tab.id),
      ].filter(candidate => !this.lostIds.has(candidate));
      const id = [...preferred, ...others].find(
        candidate => !tried.has(candidate) && this.tabs.has(candidate)
      );
      if (id === undefined) break;
      tried.add(id);
      try {
        await this.enter(id);
        return;
      } catch (error) {
        if (!this.disposed) warn("タブへの接続に失敗", error);
      }
    }
    const id = await this.createBlank();
    if (this.disposed) return;
    await this.enter(id);
  }

  private async enter(id: string): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error("タブが一覧にありません");
    this.entering = id;
    try {
      await this.link.enter(tab);
    } finally {
      this.entering = null;
    }
    this.fallback = [];
    this.lostIds.clear();
    // 一覧が変わっていなくても、映しているタブが変わったので知らせる
    this.publishNow();
  }

  /** `about:blank` のタブを作り、Chromiumの知らせを待たずに一覧へ足す */
  private async createBlank(): Promise<string> {
    const id = readTargetId(
      await this.link.send("Target.createTarget", { url: BLANK_URL })
    );
    if (id === null) throw new Error("作ったタブのidを読めません");
    if (!this.disposed && !this.tabs.has(id)) {
      this.tabs.add({
        id,
        type: "page",
        title: "",
        url: BLANK_URL,
        openerId: null,
      });
      this.schedulePublish();
    }
    return id;
  }

  /** 閉じられたら `true`。失敗しても投げない */
  private async closeTarget(id: string): Promise<boolean> {
    try {
      await this.link.send("Target.closeTarget", { targetId: id });
      return true;
    } catch (error) {
      if (!this.disposed) warn("タブを閉じるのに失敗", error);
      return false;
    }
  }

  /** Chromiumの知らせを待たずに、一覧から消す */
  private forget(id: string): void {
    if (!this.disposed && this.tabs.remove(id)) this.schedulePublish();
  }

  private message(): BrowserServerMessage | null {
    const activeId = this.link.current();
    if (this.disposed || activeId === null) return null;
    return { t: "tabs", tabs: this.tabs.list(), activeId };
  }

  private schedulePublish(): void {
    if (this.timer || this.disposed || !this.opened) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const message = this.message();
      if (message) this.link.toAll(message);
    }, TABS_DEBOUNCE_MS);
  }

  private publishNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const message = this.message();
    if (message) this.link.toAll(message);
  }
}
