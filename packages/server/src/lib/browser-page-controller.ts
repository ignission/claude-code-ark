/**
 * 映しているタブ1つぶんの、ブラウザのUIにあたる部分 (アドレスバー、戻ると進む、
 * JavaScriptのダイアログ、コピー)。headlessのChromiumにはUIが無いので、Arkが持つ。
 *
 * ブリッジ (browser-cdp-bridge.ts) がタブへattachするたびに1つ作り、接続を捨てるときに
 * `dispose` する。CDPと視聴者へは、受け取った `PageLink` を通してだけ触る。
 *
 * - 履歴 (`Page.getNavigationHistory`) は、メインフレームの遷移、読み込みの終わりの
 *   あとに読み直す。読み込み中はイベントが続くので、最初のイベントから100ms待って1回に
 *   まとめる。タブの準備が終わった直後の1回だけは、まとめる相手が無いので待たない
 * - 履歴の読み直しは、遷移の途中だと失敗する。失敗しても前の状態を保ち、次のイベントで
 *   読み直す。あとから始めた読み直しが先に返ったら、遅れて返った古い結果は使わない
 * - 遷移させる先は `validateBrowserUrl` を通ったURLだけ。通らなければ、送った視聴者にだけ
 *   理由を返す。ページ自身が行う遷移 (リンク、リダイレクト) は、ここでは止めない
 * - ダイアログは全員へ見せ、だれが答えてもよい。開いていると分かっているときの応答だけを
 *   CDPへ渡す。2人が続けて答えると、あとの応答はChromiumに断られるが、それは捨てる
 * - コピーは、固定の式をページで評価して選択を読む。式に視聴者から来た値を埋め込まない
 *   (埋め込むと、視聴者がページで任意のスクリプトを動かせる)。結果は送った視聴者にだけ返す。
 *   パスワードの欄からは読まない。別オリジンのiframeの中の選択は読めない
 * - ダイアログが開いている間は、ページのスクリプトが止まっていて式の評価が返らないので、
 *   コピーを受け付けない
 * - `dispose` のあとは、遅れて返ったCDPの応答を使わず、何も送らない
 */

import type {
  BrowserClientMessage,
  BrowserDialogInfo,
  BrowserDialogKind,
  BrowserServerMessage,
} from "@ark/shared";
import { BrowserPageState, readHistory } from "./browser-page-state.js";
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
/** ダイアログのメッセージと初期値の上限 (文字数) */
const MAX_DIALOG_TEXT_LENGTH = 10_000;
/** コピーする文字列の上限 (文字数)。下の式の中の数と揃える */
const MAX_COPY_LENGTH = 1_000_000;

const URL_REFUSED_MESSAGE = "localhostのURLだけを開けます";

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
  private disposed = false;

  /** `mainFrameId` はメインフレームのid (ページのターゲットでは、ターゲットのidと同じ) */
  constructor(
    private readonly link: PageLink<V>,
    mainFrameId: string
  ) {
    this.state = new BrowserPageState(
      info => this.link.toAll({ t: "page", ...info }),
      mainFrameId
    );
  }

  /** タブのsessionから届いた `PAGE_STATE_EVENTS` のイベントを受け取る */
  handleEvent(method: string, params: unknown): void {
    if (this.disposed) return;
    if (!this.state.handleEvent(method, params)) return;
    // 始まっただけでは、履歴はまだ変わっていない
    if (method !== "Page.frameStartedLoading") this.scheduleHistory();
  }

  /** いますぐ履歴を読み直す。タブの準備が終わったときに呼ぶ */
  refresh(): void {
    if (this.disposed) return;
    const read = ++this.historyRead;
    this.link
      .send("Page.getNavigationHistory")
      .then(result => {
        if (this.disposed || read < this.historyApplied) return;
        this.historyApplied = read;
        this.state.applyHistory(result);
      })
      // 遷移の途中では失敗する。次のイベントで読み直す
      .catch(error => warn("履歴の読み直しに失敗", error));
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
  }

  private scheduleHistory(): void {
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
        const url = normalizeUserUrl(msg.url);
        try {
          validateBrowserUrl(url);
        } catch {
          this.link.toViewer(viewer, {
            t: "notice",
            message: URL_REFUSED_MESSAGE,
          });
          return;
        }
        this.command("Page.navigate", { url });
        return;
      }
      case "back":
        this.step(-1);
        return;
      case "forward":
        this.step(1);
        return;
      case "reload":
        this.command("Page.reload");
        return;
      case "stop":
        this.command("Page.stopLoading");
        return;
    }
  }

  /** 履歴の隣のエントリへ移る。隣が無ければ何もしない */
  private step(offset: -1 | 1): void {
    this.link
      .send("Page.getNavigationHistory")
      .then(result => {
        if (this.disposed) return;
        const history = readHistory(result);
        const entry = history?.entries[history.currentIndex + offset];
        if (!entry) return;
        return this.link.send("Page.navigateToHistoryEntry", {
          entryId: entry.id,
        });
      })
      .catch(error => warn("履歴の移動に失敗", error));
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
        // ほかの視聴者が先に答えた
        if (String(error).includes("No dialog is showing")) return;
        warn("ダイアログへの応答に失敗", error);
      });
  }

  private copy(viewer: V): void {
    if (this.dialog) return;
    this.link
      .send("Runtime.evaluate", {
        expression: COPY_EXPRESSION,
        returnByValue: true,
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
      .catch(error => warn("選択の読み取りに失敗", error));
  }

  /** 失敗 (遷移中のタブなど) で視聴者を切らない */
  private command(method: string, params?: object): void {
    this.link
      .send(method, params)
      .catch(error => warn(`${method}に失敗`, error));
  }
}
