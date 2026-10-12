/**
 * 映しているタブ1つぶんの、ブラウザのUIにあたる部分 (アドレスバー、戻ると進む、
 * JavaScriptのダイアログ、コピー)。headlessのChromiumにはUIが無いので、Arkが持つ。
 *
 * ブリッジ (browser-cdp-bridge.ts) がタブへattachするたびに1つ作り、そのタブから離れる
 * とき (ほかのタブへの切り替え、タブが消えた、接続を捨てる) に `dispose` する。
 * CDPと視聴者へは、受け取った `PageLink` を通してだけ触る。
 *
 * - 履歴 (`Page.getNavigationHistory`) は、メインフレームの遷移、読み込みの終わり、
 *   題が変わったという知らせ (`rereadSoon`) のあとに読み直す。読み込み中はイベントが
 *   続くので、最初のイベントから100ms待って1回にまとめる。タブの準備が終わった直後の
 *   1回だけは、まとめる相手が無いので待たない
 * - ページのスクリプトが題を変えても、Chromiumは何も知らせない。履歴を読めば新しい題が
 *   返るので、使う側が定期に `poll` を呼ぶ。ほかの読み直しと同じ決まりで当てる (変わって
 *   いなければ知らせない、古い結果は使わない)。読めなくても、記録もやり直しもせず、
 *   rejectで使う側へ伝える (毎回記録すると、遷移の途中のたびに記録が続く)
 * - つないだ時点でタブの一覧から分かるURLと題は、履歴を読む前の状態として置く。
 *   履歴を読めないままでも、前のタブのURLが視聴者に残らないようにするため
 * - タブの準備が終わったら、ブリッジが `announce` を呼ぶ。ページの状態を、まだ全員へ
 *   知らせていなければ知らせ、開いているダイアログを知らせ直す (準備の途中で入った
 *   視聴者は、開いたときの知らせを受け取っていない)
 * - 履歴の読み直しは、遷移の途中だと失敗する。失敗しても前の状態を保ち、次のイベントで
 *   読み直す。あとから始めた読み直しが先に返ったら、遅れて返った古い結果は使わない
 * - 読み直しを始めたあとに遷移のイベントでURLが変わったら、その読み直しの結果は、URLも題も
 *   戻れるか進めるかも使わず、読み直す。使うと、遷移の前のURLへ表示が戻る
 * - つないでから一度も履歴の応答が返っていない間は、失敗した読み直しを200ms、400ms、800ms後に
 *   やり直し、そこでやめる。動きの無いタブではイベントが来ないので、やり直さないと
 *   アドレスバーが古いままになる。イベントが来たら、そちらの読み直しに任せて数え直す
 * - 遷移させる先は `validateBrowserUrl` を通ったURLだけ。通らなければ、送った視聴者にだけ
 *   理由を返す。遷移に使うのは、視聴者の文字列ではなく `validateBrowserUrl` が返した文字列。
 *   ページ自身が行う遷移 (リンク、リダイレクト) は、ここでは止めない
 * - 戻ると進むも、移る先のエントリのURLを同じように確かめる。通るのは `http:` / `https:` の
 *   エントリと `about:blank` で、`chrome-error://` や `about:blank` 以外の `about:` のような
 *   エントリへは、Arkが戻したり進めたりしない。通らない隣では、戻れる、進めるを偽にする
 * - 読み込み直しと中止は確かめない。遷移の先を変えないので、いま居るページより外へは出ない
 * - ダイアログは全員へ見せ、だれが答えてもよい。開いていると分かっているときの応答だけを
 *   CDPへ渡す。2人が続けて答えると、あとの応答はChromiumに断られるが、それは捨てる
 * - コピーは、固定の式をページで評価して選択を読む。式に視聴者から来た値を埋め込まない
 *   (埋め込むと、視聴者がページで任意のスクリプトを動かせる)。結果は送った視聴者にだけ返す。
 *   パスワードの欄からは読まない。別オリジンのiframeの中の選択は読めない
 * - ダイアログが開いている間は、ページのスクリプトが止まっていて式の評価が返らないので、
 *   コピーを受け付けない
 * - 前のコピーの評価が返るまで、次のコピーを受け付けない (だれのものでも)。ページの
 *   メインスレッドが塞がっていると評価が返らず、受け付けると返らない評価が積もる。
 *   式そのものが長く走ったときは、`COPY_TIMEOUT_MS` でChromiumが打ち切る
 * - `dispose` のあとは、遅れて返ったCDPの応答を使わず、何も送らない。失敗も記録しない
 *   (離れたタブで待っていたコマンドは、ブリッジがまとめて失敗にする)
 */

import type {
  BrowserClientMessage,
  BrowserDialogInfo,
  BrowserDialogKind,
  BrowserServerMessage,
} from "@ark/shared";
import {
  BrowserPageState,
  canStepTo,
  readHistory,
} from "./browser-page-state.js";
import { normalizeUserUrl, validateBrowserUrl } from "./browser-url.js";

/** ブリッジがタブのsessionから受け取って `handleEvent` へ渡すイベント */
export const PAGE_STATE_EVENTS = [
  "Page.frameNavigated",
  "Page.navigatedWithinDocument",
  "Page.frameStartedLoading",
  "Page.frameStoppedLoading",
  "Page.loadEventFired",
] as const;

/** 履歴の読み直しをまとめる待ち (ミリ秒) */
export const HISTORY_DEBOUNCE_MS = 100;
/** つないで最初の履歴の読み直しが失敗したときに、やり直すまでの待ち (ミリ秒)。使い切ったらやめる */
export const HISTORY_RETRY_DELAYS_MS: readonly number[] = [200, 400, 800];
/** コピーの式の評価を打ち切るまでの時間 (ミリ秒)。`Runtime.evaluate` の `timeout` に渡す */
export const COPY_TIMEOUT_MS = 1000;
/** ダイアログのメッセージと初期値の上限 (文字数) */
const MAX_DIALOG_TEXT_LENGTH = 10_000;
/** コピーする文字列の上限 (文字数)。下の式の中の数と揃える */
const MAX_COPY_LENGTH = 1_000_000;

const URL_REFUSED_MESSAGE = "http://またはhttps://のURLだけを開けます";

/** メインフレームのURLを変えるイベント */
const URL_EVENTS: ReadonlySet<string> = new Set([
  "Page.frameNavigated",
  "Page.navigatedWithinDocument",
]);

const DIALOG_KINDS: readonly BrowserDialogKind[] = [
  "alert",
  "confirm",
  "prompt",
  "beforeunload",
];

/**
 * 選択している文字列を読む式。フォーカスをshadow DOMと同じオリジンのiframeの中まで
 * たどり、`<input>` / `<textarea>` なら `value` の選択範囲、それ以外は文書の選択を返す。
 * 何が起きても投げず、読めなければ空の文字列を返す。
 */
export const COPY_EXPRESSION = `(() => {
  try {
    let el = document.activeElement;
    let view = null;
    for (let i = 0; el && i < 32; i++) {
      let inner = null;
      if (el.shadowRoot) {
        inner = el.shadowRoot.activeElement;
      } else if (el.contentDocument) {
        inner = el.contentDocument.activeElement;
        if (el.contentWindow) view = el.contentWindow;
      }
      if (!inner) break;
      el = inner;
    }
    let text = null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
      if (el.type === "password") return "";
      const start = el.selectionStart;
      const end = el.selectionEnd;
      if (typeof start === "number" && typeof end === "number") {
        text = String(el.value).slice(start, end);
      }
    }
    if (text === null) {
      const selection = view ? view.getSelection() : getSelection();
      text = selection ? String(selection) : "";
    }
    return text.slice(0, 1000000);
  } catch (error) {
    return "";
  }
})()`;

/** このモジュールが扱う視聴者のメッセージ */
export type PageCommand = Extract<
  BrowserClientMessage,
  { t: "nav" | "dialog" | "copy" }
>;

/** タブと視聴者への出口。`V` は視聴者 */
export interface PageLink<V> {
  /** タブのsessionへCDPのコマンドを送る */
  send(method: string, params?: object): Promise<unknown>;
  /** 視聴者1人へ送る。去った視聴者へは何もしない */
  toViewer(viewer: V, message: BrowserServerMessage): void;
  /** 参加している視聴者の全員へ送る */
  toAll(message: BrowserServerMessage): void;
}

function warn(what: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[BrowserBridge] ${what}: ${message}`);
}

function cut(value: unknown): string {
  return typeof value === "string"
    ? value.slice(0, MAX_DIALOG_TEXT_LENGTH)
    : "";
}

function readDialog(params: unknown): BrowserDialogInfo {
  const p = (typeof params === "object" && params !== null ? params : {}) as {
    type?: unknown;
    message?: unknown;
    defaultPrompt?: unknown;
  };
  const kind = DIALOG_KINDS.find(known => known === p.type) ?? "alert";
  return { kind, message: cut(p.message), defaultPrompt: cut(p.defaultPrompt) };
}

export class BrowserPageController<V> {
  private readonly state: BrowserPageState;
  private dialog: BrowserDialogInfo | null = null;
  private historyTimer: NodeJS.Timeout | null = null;
  /** 始めた読み直しの番号。いちばん新しいものの結果だけを使う */
  private historyRead = 0;
  private historyApplied = 0;
  /** 遷移のイベントでURLが変わった回数。読み直しを始めたあとに進んでいたら、その結果は古い */
  private urlChanges = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  /** 失敗した読み直しをやり直した回数 */
  private retries = 0;
  private copying = false;
  private disposed = false;

  /**
   * `mainFrameId` はメインフレームのid (ページのターゲットでは、ターゲットのidと同じ)。
   * `seed` は、つないだ時点で分かっているURLと題。
   */
  constructor(
    private readonly link: PageLink<V>,
    mainFrameId: string,
    seed?: { url: string; title: string }
  ) {
    this.state = new BrowserPageState(
      info => this.link.toAll({ t: "page", ...info }),
      mainFrameId
    );
    if (seed) this.state.seed(seed.url, seed.title);
  }

  /** ダイアログが開いているか */
  get dialogOpen(): boolean {
    return this.dialog !== null;
  }

  /** タブのsessionから届いた `PAGE_STATE_EVENTS` のイベントを受け取る */
  handleEvent(method: string, params: unknown): void {
    if (this.disposed) return;
    if (!this.state.handleEvent(method, params)) return;
    if (URL_EVENTS.has(method)) this.urlChanges++;
    // 始まっただけでは、履歴はまだ変わっていない
    if (method !== "Page.frameStartedLoading") this.scheduleHistory();
  }

  /** いますぐ履歴を読み直す。タブの準備が終わったときに呼ぶ */
  refresh(): void {
    if (this.disposed) return;
    void this.read((error, read) => {
      // 遷移の途中では失敗する。次のイベントで読み直す
      warn("履歴の読み直しに失敗", error);
      this.retryHistory(read);
    });
  }

  /**
   * 定期の読み直し。履歴を読んで当て終えたらresolveし、読めなければrejectする。
   * 読み直しを待っているところなら、それに任せて、何もせずにresolveする。
   */
  poll(): Promise<void> {
    if (this.disposed || this.historyTimer || this.retryTimer) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      void this.read(reject).then(resolve);
    });
  }

  /**
   * 履歴を読んで当てる。rejectしない。読めなければ、`dispose` のあとでない限り、
   * `failed` を呼ぶ (`read` は、その読み直しの番号)。
   */
  private read(failed: (error: unknown, read: number) => void): Promise<void> {
    this.cancelRetry();
    const read = ++this.historyRead;
    const urlChanges = this.urlChanges;
    return this.link
      .send("Page.getNavigationHistory")
      .then(result => {
        if (this.disposed || read < this.historyApplied) return;
        this.historyApplied = read;
        this.retries = 0;
        if (urlChanges !== this.urlChanges) {
          // もっと新しい読み直しが始まっていなければ、始める
          if (read === this.historyRead) this.scheduleHistory();
          return;
        }
        this.state.applyHistory(result);
      })
      .catch(error => {
        if (!this.disposed) failed(error, read);
      });
  }

  /** 少し待ってから履歴を読み直す。題が変わったと分かったときに呼ぶ */
  rereadSoon(): void {
    if (this.disposed) return;
    this.scheduleHistory();
  }

  /** タブの準備が終わったときに、いまの状態を全員へ知らせる */
  announce(): void {
    if (this.disposed) return;
    this.state.announce();
    if (this.dialog) this.link.toAll({ t: "dialog", ...this.dialog });
  }

  dialogOpening(params: unknown): void {
    if (this.disposed) return;
    this.dialog = readDialog(params);
    this.link.toAll({ t: "dialog", ...this.dialog });
  }

  dialogClosed(): void {
    if (this.disposed || !this.dialog) return;
    this.dialog = null;
    this.link.toAll({ t: "dialogClosed" });
  }

  /** 参加した視聴者へ、いまの状態を知らせる */
  greet(viewer: V): void {
    if (this.disposed) return;
    const info = this.state.snapshot();
    if (info) this.link.toViewer(viewer, { t: "page", ...info });
    if (this.dialog)
      this.link.toViewer(viewer, { t: "dialog", ...this.dialog });
  }

  handle(viewer: V, msg: PageCommand): void {
    if (this.disposed) return;
    switch (msg.t) {
      case "nav":
        this.navigate(viewer, msg);
        return;
      case "dialog":
        this.answerDialog(msg);
        return;
      case "copy":
        this.copy(viewer);
        return;
    }
  }

  /** タイマーと状態を捨てる。このあとは何も送らない */
  dispose(): void {
    this.disposed = true;
    this.dialog = null;
    if (this.historyTimer) {
      clearTimeout(this.historyTimer);
      this.historyTimer = null;
    }
    this.cancelRetry();
  }

  private cancelRetry(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** 失敗した読み直し `read` を、まだ一度も応答が返っていなければ、待ってからやり直す */
  private retryHistory(read: number): void {
    if (this.disposed || this.historyApplied > 0) return;
    // もっと新しい読み直しが始まっているか、待っているなら、そちらに任せる
    if (read !== this.historyRead || this.historyTimer) return;
    const delay = HISTORY_RETRY_DELAYS_MS[this.retries];
    if (delay === undefined) return;
    this.retries++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.refresh();
    }, delay);
  }

  private scheduleHistory(): void {
    this.cancelRetry();
    this.retries = 0;
    if (this.historyTimer) return;
    this.historyTimer = setTimeout(() => {
      this.historyTimer = null;
      this.refresh();
    }, HISTORY_DEBOUNCE_MS);
  }

  private navigate(
    viewer: V,
    msg: Extract<BrowserClientMessage, { t: "nav" }>
  ): void {
    switch (msg.type) {
      case "goto": {
        let url: string;
        try {
          url = validateBrowserUrl(normalizeUserUrl(msg.url));
        } catch {
          this.refuse(viewer);
          return;
        }
        this.command("Page.navigate", { url });
        return;
      }
      case "back":
        this.step(viewer, -1);
        return;
      case "forward":
        this.step(viewer, 1);
        return;
      case "reload":
        this.command("Page.reload");
        return;
      case "stop":
        this.command("Page.stopLoading");
        return;
    }
  }

  private refuse(viewer: V): void {
    this.link.toViewer(viewer, { t: "notice", message: URL_REFUSED_MESSAGE });
  }

  /**
   * 履歴の隣のエントリへ移る。隣が無ければ何もしない。隣のURLが開いてよいものでなければ、
   * 移らずに `viewer` へ理由を返す。
   */
  private step(viewer: V, offset: -1 | 1): void {
    this.link
      .send("Page.getNavigationHistory")
      .then(result => {
        if (this.disposed) return;
        const history = readHistory(result);
        const entry = history?.entries[history.currentIndex + offset];
        if (!entry) return;
        if (!canStepTo(entry)) {
          this.refuse(viewer);
          return;
        }
        return this.link.send("Page.navigateToHistoryEntry", {
          entryId: entry.id,
        });
      })
      .catch(error => {
        if (!this.disposed) warn("履歴の移動に失敗", error);
      });
  }

  private answerDialog(
    msg: Extract<BrowserClientMessage, { t: "dialog" }>
  ): void {
    if (!this.dialog) return;
    // 閉じたことは `Page.javascriptDialogClosed` で知る。ここでは閉じたことにしない
    this.link
      .send("Page.handleJavaScriptDialog", {
        accept: msg.accept,
        ...(msg.promptText === undefined ? {} : { promptText: msg.promptText }),
      })
      .catch(error => {
        if (this.disposed) return;
        // ほかの視聴者が先に答えた
        if (String(error).includes("No dialog is showing")) return;
        warn("ダイアログへの応答に失敗", error);
      });
  }

  private copy(viewer: V): void {
    if (this.dialog || this.copying) return;
    this.copying = true;
    this.link
      .send("Runtime.evaluate", {
        expression: COPY_EXPRESSION,
        returnByValue: true,
        timeout: COPY_TIMEOUT_MS,
      })
      .finally(() => {
        this.copying = false;
      })
      .then(result => {
        if (this.disposed) return;
        const value = (result as { result?: { value?: unknown } } | null)
          ?.result?.value;
        if (typeof value !== "string" || value === "") return;
        this.link.toViewer(viewer, {
          t: "clipboard",
          text: value.slice(0, MAX_COPY_LENGTH),
        });
      })
      .catch(error => {
        if (!this.disposed) warn("選択の読み取りに失敗", error);
      });
  }

  /** 失敗 (遷移中のタブなど) で視聴者を切らない */
  private command(method: string, params?: object): void {
    this.link.send(method, params).catch(error => {
      if (!this.disposed) warn(`${method}に失敗`, error);
    });
  }
}
