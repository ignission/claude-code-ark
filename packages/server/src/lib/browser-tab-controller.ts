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
 * - イベントだけでは、一覧は古くなる。ページのスクリプトが題を変えても
 *   `Target.targetInfoChanged` は届かない (実物のChromiumで確かめた。届くのは、URLが
 *   変わったときなど)。そこで、使う側が定期に `poll` を呼び、`Target.getTargets` の結果を
 *   一覧へ当てる (題とURLを変え、足りないタブを足し、もう無いタブを外す)。これも操作の列に
 *   並べるが、操作が走っているか待っている間は読まない (次の回に任せる)。読めなくても、
 *   記録もやり直しもしない (どう記録するかは使う側が決める)
 * - タブを動かす操作 (切り替え、閉じる、新しいタブ、消えたタブからの移動) は、1本の列に
 *   並べて1つずつ行う。互いに割り込むと、離れたタブへ準備を続けたり、閉じたタブへつないだり
 *   する。待っている切り替えは最後の1つだけを残す。視聴者の操作が並ぶ数には上限を置き、
 *   超えたぶんは捨てる。切り替えだけは捨てず、待っている古い操作を1つ捨てて並べる
 *   (利用者がいちばん最後に選んだタブを映す)
 * - 操作を受けるのは、一覧にあるidだけ。列に並べるときと、実際に行うときの両方で確かめる
 *   (待っている間にタブが消える)
 * - 映しているタブが無くなったら、列が空いたところで必ずどこかへつなぎ直す。選ぶ順は、
 *   操作が望んだタブ、消えたタブを開いたタブ (下)、消えたタブの直前、直後、あとは近い順、
 *   残りの全部。つなげなかったタブ、sessionが切れたばかりのタブ、screencastを始められ
 *   なかったタブは飛ばす。どれにもつなげなければ `about:blank` を作ってつなぐ。それも
 *   できなければCDPが切れたときと同じに扱う (`TabLink.fail`)。視聴者を切るのは、このときだけ
 * - 映しているタブでscreencastを始められなかったときも、タブが消えたときと同じに、離れて
 *   つなぎ直す (タブが閉じる途中だと、消えたという知らせより先に、開始の失敗が届く)。
 *   始められなかったタブは、どこかのタブで始められるまで、つなぎ直す先に選ばない
 *   (2つのタブを行き来し続けない)。最後の手として作った `about:blank` でも始められなければ、
 *   つなげなくなったものとして扱う (タブを作り続けない)
 * - 映しているタブを閉じるときは、先に離れてから閉じ、そのまま次のタブへつなぐ。
 *   そのあとに届く、閉じたタブのイベントでは何もしない
 * - 映しているタブが勝手に消えた (ページが `window.close()` した、sessionがdetachされた)
 *   ときは、離れて、同じ決まりでつなぎ直す。クラッシュしたタブは、sessionを離し、閉じてから
 *   つなぎ直す (閉じられなくても続ける。離しておかないと、閉じられなかったときにsessionが残る)
 * - 映しているタブが開いたタブ (`openerId` が映しているタブ) へは、自動で切り替える。
 *   利用者がリンクを押した結果だから。`target="_blank"` のリンクで開いたタブにも
 *   `openerId` は付く (実物のChromiumで確かめた)。ほかのタブが開いたタブは、一覧に出すだけにする
 * - 自動で切り替えた先のタブが消えたら、それを開いたタブへ戻る (ログインのポップアップが
 *   閉じたら、もとのページへ戻る)。開いたタブがもう無ければ、上の並びの決まりで選ぶ
 * - タブが新しくできると、それまで映していたタブは描画されなくなる。ページが開いたタブでも、
 *   `Target.createTarget` で作ったタブでも同じで、取り直し (`Page.captureScreenshot`) が
 *   返らなくなる。そのタブの `document.visibilityState` は `visible` のままなので、ページの側
 *   からは分からない (実物のChromiumで確かめた)。そこで、タブができたのに切り替えない
 *   とき (開いたのが映しているタブでない、切り替えの途中、ダイアログが開いている、Arkの外で
 *   作られた) は、映しているタブを `Target.activateTarget` で前面へ戻し、全画面を送り直させる
 *   (`TabLink.repaint`)。これも操作の列に並べ、切り替えと入れ違いにならないようにする
 * - JavaScriptのダイアログが開いている間は、切り替えと新しいタブを断り、送った視聴者に理由を
 *   返す。ダイアログが開いているタブへ、あとからつないだsessionでは、`Page.enable` も、寸法の
 *   設定も、screencastの開始も、取り直しも返らず、開いたことの知らせも届き直さず、
 *   `Page.handleJavaScriptDialog` は「ダイアログは無い」と断られる (実物のChromiumで確かめた)。
 *   つまり、ダイアログを見たsessionを離すと、そのタブは二度と操作できない。離れさせないのが
 *   いちばん安い。閉じることは、映しているタブでも、ほかのタブでも受ける (壊れたページから
 *   出る手段を残す)
 * - ダイアログが開いている間は、ページのスクリプトが止まっているので、ページがタブを開く
 *   ことは無いはず。それでも映しているタブが開いたタブが届いたら、切り替えず、前面へ戻す
 * - タブを動かすコマンド (前面にする、つなぐ、閉じる) が失敗したら、一覧がChromiumとずれて
 *   いるかもしれないので、`Target.getTargets` で取り直す (もう無いタブを外し、足りないタブを
 *   足す)。失敗が続いても1回にまとめ、これも操作の列に並べる (作ったばかりのタブを、
 *   作る前の一覧で外してしまわないように)
 * - ブラウザへのコマンド (`TabLink.send`) は、応答を待つ時間に上限があるものとして使う
 *   (上限を置くのは使う側)。時間切れは、ほかの失敗と同じに扱い、操作の列を先へ進める
 * - 視聴者が開けるタブの数には上限を置く。ページが開くタブは止められないので、追う数の上限
 *   (browser-tabs.ts) を超えたら、古いものから閉じる。映しているタブと、それを開いたタブは
 *   閉じない
 * - 追っているタブが一覧に出さないページ (DevToolsの画面など) へ移ったら、一覧から外す。
 *   映しているタブと、準備の途中のタブは外さない (`activeId` が一覧に無い状態を見せない)
 * - `tab new` で作ったタブと、閉じたタブは、Chromiumのイベントを待たずに一覧へ反映する。
 *   イベントが遅れても、`activeId` が一覧に無い状態を視聴者へ見せない
 * - `dispose` のあとは、遅れて返ったCDPの応答を使わず、何も送らない
 */

import type {
  BrowserClientMessage,
  BrowserServerMessage,
  BrowserTabInfo,
} from "@ark/shared";
import {
  BrowserTabs,
  MAX_TABS,
  MAX_TRACKED_TABS,
  readTargetInfo,
  type TargetInfo,
} from "./browser-tabs.js";

/** 一覧の変化をまとめる待ち (ミリ秒) */
export const TABS_DEBOUNCE_MS = 100;
/** タブを動かすコマンドが失敗してから、一覧を取り直すまでの待ち (ミリ秒)。続いた失敗をまとめる */
export const SYNC_DEBOUNCE_MS = 200;
/** 待たせておく視聴者の操作の数の上限 */
const MAX_PENDING = 32;

const BLANK_URL = "about:blank";
const TOO_MANY_MESSAGE = "タブが多すぎます";
const DIALOG_OPEN_MESSAGE = "ダイアログに応答してから切り替えてください";

/** このモジュールが扱う視聴者のメッセージ */
export type TabCommand = Extract<BrowserClientMessage, { t: "tab" }>;

/** ブラウザ、タブ1つぶんの準備、視聴者への出口。`V` は視聴者 */
export interface TabLink<V> {
  /**
   * ブラウザへ (どのタブのsessionでもなく) CDPのコマンドを送る。応答が返らないコマンドは、
   * 時間を切ってrejectする (返らないままだと、操作の列が止まる)
   */
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
  /** 映しているタブで、JavaScriptのダイアログが開いているか */
  dialogOpen(): boolean;
  /** 映しているタブの全画面を、全員へ送り直させる */
  repaint(): void;
  /** 視聴者1人へ送る。去った視聴者へは何もしない */
  toViewer(viewer: V, message: BrowserServerMessage): void;
  /** 参加している視聴者の全員へ送る */
  toAll(message: BrowserServerMessage): void;
  /** どのタブにもつなげなくなった。CDPが切れたときと同じに扱う */
  fail(error: unknown): void;
}

type Operation<V> =
  /** `by` は、頼んだ視聴者か、このタブを開いたタブ (自動の切り替え) */
  | { kind: "activate"; id: string; by: { viewer: V } | { opener: string } }
  | { kind: "close"; id: string }
  | { kind: "new"; viewer: V }
  /** クラッシュしたタブを閉じて、一覧から消す */
  | { kind: "discard"; id: string }
  /** 映しているタブを前面へ戻す。`created` は、きっかけになった新しいタブ */
  | { kind: "reassert"; created: string }
  /** 一覧をChromiumから取り直す */
  | { kind: "sync" }
  /** 定期の読み直し。読んで当て終えたら `resolve`、読めなければ `reject` を呼ぶ */
  | { kind: "poll"; resolve: () => void; reject: (error: unknown) => void }
  /** 追う数の上限を超えたぶんを閉じる */
  | { kind: "trim" };

type Kind = Operation<unknown>["kind"];

/** 視聴者が頼んだ操作。並ぶ数に上限がある */
const VIEWER_KINDS: ReadonlySet<Kind> = new Set(["activate", "close", "new"]);
/** 待っているものが1つあれば足りる操作。あとから来たものへ置き換える */
const SINGLE_KINDS: ReadonlySet<Kind> = new Set([
  "activate",
  "reassert",
  "sync",
  "trim",
]);

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
  /**
   * screencastを始められなかったタブ。どこかのタブで始められるまで、つなぎ直す先に選ばない。
   * つなげただけでは消さない (始められるかは、つないだあとに分かる)
   */
  private readonly castFailedIds = new Set<string>();
  /** ほかにつなげるタブが無くて作った `about:blank`。ここでも始められなければ、あきらめる */
  private lastResort: string | null = null;
  /** `kick` が失敗を見張っている `draining`。同じものを二重に見張らないために持つ */
  private watched: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
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
    if (known) return;
    // 最初のタブへつなぐ前は、どのタブも映していない
    if (this.opened) {
      const current = this.link.current();
      if (
        current !== null &&
        info.openerId === current &&
        !this.link.dialogOpen()
      ) {
        this.enqueue({
          kind: "activate",
          id: info.id,
          by: { opener: current },
        });
      } else {
        this.enqueue({ kind: "reassert", created: info.id });
      }
    }
    // 切り替えのあとに並べる。映しているタブと、それを開いたタブを残すため
    if (this.tabs.size > MAX_TRACKED_TABS) this.enqueue({ kind: "trim" });
  }

  /**
   * `Target.targetInfoChanged` を受け取る。映しているタブの題が変わったら `true`
   * (ページの状態の題は履歴から読むので、使う側が読み直す)。スクリプトが題だけを変えた
   * ときには届かないので、それは定期の読み直し (`poll`) で拾う。
   */
  targetInfoChanged(params: unknown): boolean {
    if (this.disposed) return false;
    const info = readTargetInfo(
      (params as { targetInfo?: unknown } | null | undefined)?.targetInfo
    );
    return info !== null && this.change(info);
  }

  /**
   * 定期の読み直し。一覧をChromiumから読んで当てる。操作が走っているか待っている間と、
   * 最初のタブへつなぐ前は、何もせずに終わる。読めなければrejectする (記録しない)。
   */
  poll(): Promise<void> {
    if (
      this.disposed ||
      !this.opened ||
      this.draining ||
      this.queue.length > 0
    ) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ kind: "poll", resolve, reject });
      this.kick();
    });
  }

  /** 追っているタブの題とURLを変える。映しているタブの題が変わったら `true` */
  private change(info: TargetInfo): boolean {
    const current = this.link.current();
    const change = this.tabs.update(
      info,
      info.id === current || info.id === this.entering
    );
    if (!change) return false;
    this.schedulePublish();
    return change !== "removed" && change.title && info.id === current;
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
    // sessionは残っている。離しておかないと、閉じられなかったときに残る
    this.link.leave(false);
    // ほかの操作より先に片づける。クラッシュしたタブへ戻る操作をさせない
    this.queue.unshift({ kind: "discard", id });
    this.kick();
  }

  /** 映しているタブ `id` で、screencastを始められなかった */
  castFailed(id: string, error: unknown): void {
    if (this.disposed || id !== this.link.current()) return;
    if (id === this.lastResort) {
      this.link.fail(error);
      return;
    }
    this.fallback = this.tabs.fallbacks(id);
    this.castFailedIds.add(id);
    this.link.leave(false);
    this.kick();
  }

  /** 映しているタブ `id` で、screencastを始められた */
  castStarted(id: string): void {
    if (this.disposed || id !== this.link.current()) return;
    this.castFailedIds.clear();
    this.lastResort = null;
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
        if (!this.tabs.has(msg.id) || this.refusedForDialog(viewer)) return;
        this.enqueue({ kind: "activate", id: msg.id, by: { viewer } });
        return;
      case "close":
        if (this.tabs.has(msg.id)) this.enqueue({ kind: "close", id: msg.id });
        return;
      case "new":
        if (this.refusedForDialog(viewer)) return;
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
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /** ダイアログが開いていれば、`viewer` へ理由を返して `true` */
  private refusedForDialog(viewer: V): boolean {
    if (!this.link.dialogOpen()) return false;
    this.link.toViewer(viewer, { t: "notice", message: DIALOG_OPEN_MESSAGE });
    return true;
  }

  private enqueue(operation: Operation<V>): void {
    const { kind } = operation;
    if (SINGLE_KINDS.has(kind)) {
      for (let i = this.queue.length - 1; i >= 0; i--) {
        if (this.queue[i].kind === kind) this.queue.splice(i, 1);
      }
    }
    if (VIEWER_KINDS.has(kind)) {
      const waiting = this.queue.filter(queued =>
        VIEWER_KINDS.has(queued.kind)
      ).length;
      if (waiting >= MAX_PENDING) {
        if (kind !== "activate") return;
        // 切り替えは捨てない。待っている切り替えはもう無いので、古い操作を1つ捨てる
        const oldest = this.queue.findIndex(queued =>
          VIEWER_KINDS.has(queued.kind)
        );
        this.queue.splice(oldest, 1);
      }
    }
    this.queue.push(operation);
    // 最初のタブへつなぐ前に並んだものは、`open` が行う
    if (this.opened) this.kick();
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
    const draining = this.pump();
    // 走っている間に何度呼ばれても、失敗を扱うのは1回
    if (this.watched === draining) return;
    this.watched = draining;
    draining.catch(error => {
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
        const { id, by } = operation;
        const from = this.link.current();
        if (id === from) return;
        // 並んでいる間にタブが消えた、ダイアログが開いた
        const refused = this.link.dialogOpen();
        if (!this.tabs.has(id) || refused) {
          if ("opener" in by) await this.reassert();
          else if (refused) this.refusedForDialog(by.viewer);
          return;
        }
        this.link.leave(false);
        // つなげなければ、もとのタブへ戻る
        await this.moveTo(from === null ? [id] : [id, from]);
        if ("opener" in by && this.link.current() === id) {
          this.tabs.follow(id, by.opener);
        }
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
      case "reassert":
        // 切り替えた先のタブなら、つなぐときに前面にしてある
        if (operation.created !== this.link.current()) await this.reassert();
        return;
      case "sync":
        await this.sync();
        return;
      case "poll":
        try {
          this.applyTargets(await this.link.send("Target.getTargets"));
          operation.resolve();
        } catch (error) {
          operation.reject(error);
        }
        return;
      case "trim": {
        const keep = new Set<string>();
        const current = this.link.current();
        if (current !== null) {
          keep.add(current);
          const opener = this.tabs.openerOf(current);
          if (opener !== null) keep.add(opener);
        }
        for (const id of this.tabs.overflow(keep)) {
          if (this.disposed) return;
          if (this.tabs.has(id) && (await this.closeTarget(id))) {
            this.forget(id);
          }
        }
        return;
      }
      case "new": {
        if (this.refusedForDialog(operation.viewer)) return;
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
      ].filter(
        candidate =>
          !this.lostIds.has(candidate) && !this.castFailedIds.has(candidate)
      );
      const id = [...preferred, ...others].find(
        candidate => !tried.has(candidate) && this.tabs.has(candidate)
      );
      if (id === undefined) break;
      tried.add(id);
      try {
        await this.enter(id);
        return;
      } catch (error) {
        if (this.disposed) return;
        warn("タブへの接続に失敗", error);
        this.scheduleSync();
      }
    }
    const id = await this.createBlank();
    if (this.disposed) return;
    this.lastResort = id;
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
    if (id !== this.lastResort) this.lastResort = null;
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
      if (!this.disposed) {
        warn("タブを閉じるのに失敗", error);
        this.scheduleSync();
      }
      return false;
    }
  }

  /** 映しているタブを前面へ戻し、全画面を送り直させる。映しているタブが無ければ何もしない */
  private async reassert(): Promise<void> {
    const current = this.link.current();
    if (current === null) return;
    try {
      await this.link.send("Target.activateTarget", { targetId: current });
    } catch (error) {
      if (this.disposed) return;
      warn("タブを前面へ戻すのに失敗", error);
      this.scheduleSync();
      return;
    }
    // 待つ間にタブから離れていたら、つなぎ直すときに前面になる
    if (this.disposed || this.link.current() !== current) return;
    this.link.repaint();
  }

  /** 一覧をChromiumから取り直す。失敗しても投げない */
  private async sync(): Promise<void> {
    let result: unknown;
    try {
      result = await this.link.send("Target.getTargets");
    } catch (error) {
      if (!this.disposed) warn("タブの一覧の取り直しに失敗", error);
      return;
    }
    this.applyTargets(result);
  }

  /**
   * `Target.getTargets` の結果を一覧へ当てる。追っているタブの題とURLを変え、足りない
   * タブを足し、もう無いタブを外す。
   */
  private applyTargets(result: unknown): void {
    const infos = (result as { targetInfos?: unknown } | null)?.targetInfos;
    if (this.disposed || !Array.isArray(infos)) return;
    const alive = new Set<string>();
    let added = false;
    for (const raw of infos) {
      const info = readTargetInfo(raw);
      if (!info) continue;
      alive.add(info.id);
      if (this.tabs.has(info.id)) {
        this.change(info);
      } else if (this.tabs.add(info)) {
        this.schedulePublish();
        added = true;
      }
    }
    for (const tab of this.tabs.list()) {
      // 映しているタブ、準備の途中のタブなら、消えたときと同じに離れる
      if (!alive.has(tab.id)) this.targetDestroyed({ targetId: tab.id });
    }
    if (added && this.tabs.size > MAX_TRACKED_TABS) {
      this.enqueue({ kind: "trim" });
    }
  }

  private scheduleSync(): void {
    if (this.syncTimer || this.disposed) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      this.enqueue({ kind: "sync" });
    }, SYNC_DEBOUNCE_MS);
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
