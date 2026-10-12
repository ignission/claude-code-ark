/**
 * ブラウザ機能のUIの状態。サーバーのメッセージから、ツールバー、タブ、ダイアログ、
 * 選択リスト、知らせの表示に使う値を作る。Reactに依らないreducer。
 *
 * 接続のたびに `reset` で初期値へ戻す (サーバーは参加した視聴者へ、いまの状態を送り直す)。
 * このreducerが扱わない種類 (`viewport` / `clipboard` / `error`)、未知の種類、形の崩れた
 * メッセージは無視する。
 *
 * 中身の同じ `page` と `dialog` が続けて届いたら、前の状態をそのまま返す。サーバーは、
 * 参加の直後に `page` を2回、`dialog` を2回送ることがあり、作り直すと、利用者が入力中の
 * `prompt` の欄が初期値に戻る。
 *
 * 選択リストは、サーバーが `selectClosed` で閉じるほか、遷移したとき (`page` のURLが
 * 変わった) と、映すタブが替わったとき (`tabs` の `activeId` が変わった) にも閉じる。
 * そのあとの `id` はサーバーで意味を持たない。
 *
 * 知らせには通し番号を付ける。同じ文言が続けて届いても別の知らせとして扱い、消すまでの
 * 時間を計り直せる。
 */

import type {
  BrowserDialogInfo,
  BrowserPageInfo,
  BrowserSelectOption,
  BrowserServerMessage,
  BrowserTabInfo,
} from "@ark/shared";

export interface BrowserSelectInfo {
  id: number;
  options: BrowserSelectOption[];
  selectedIndex: number;
  /** ビューポートのCSSピクセルでの `<select>` の位置 */
  rect: { x: number; y: number; width: number; height: number };
}

export interface BrowserNotice {
  seq: number;
  message: string;
}

export interface BrowserSessionState {
  page: BrowserPageInfo | null;
  tabs: BrowserTabInfo[];
  activeId: string | null;
  dialog: BrowserDialogInfo | null;
  select: BrowserSelectInfo | null;
  notice: BrowserNotice | null;
  /** 最後に出した知らせの通し番号 */
  noticeSeq: number;
}

export type BrowserSessionAction =
  | { type: "server"; message: BrowserServerMessage }
  /** 接続をやり直すとき */
  | { type: "reset" }
  /** 手元で出す知らせ (コピーの失敗など) */
  | { type: "notice"; message: string }
  /** 知らせを消す時刻が来た */
  | { type: "noticeExpired"; seq: number }
  /** 利用者が選択リストを閉じた (選んだ、取り消した) */
  | { type: "selectDismissed"; id: number };

export const initialBrowserSessionState: BrowserSessionState = {
  page: null,
  tabs: [],
  activeId: null,
  dialog: null,
  select: null,
  notice: null,
  noticeSeq: 0,
};

const DIALOG_KINDS = new Set(["alert", "confirm", "prompt", "beforeunload"]);

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function withNotice(
  state: BrowserSessionState,
  message: string
): BrowserSessionState {
  const seq = state.noticeSeq + 1;
  return { ...state, notice: { seq, message }, noticeSeq: seq };
}

function readPage(
  msg: Extract<BrowserServerMessage, { t: "page" }>
): BrowserPageInfo | null {
  if (typeof msg.url !== "string" || typeof msg.title !== "string") return null;
  return {
    url: msg.url,
    title: msg.title,
    loading: msg.loading === true,
    canGoBack: msg.canGoBack === true,
    canGoForward: msg.canGoForward === true,
  };
}

function samePage(a: BrowserPageInfo, b: BrowserPageInfo): boolean {
  return (
    a.url === b.url &&
    a.title === b.title &&
    a.loading === b.loading &&
    a.canGoBack === b.canGoBack &&
    a.canGoForward === b.canGoForward
  );
}

function readTabs(
  msg: Extract<BrowserServerMessage, { t: "tabs" }>
): BrowserTabInfo[] | null {
  if (!Array.isArray(msg.tabs) || typeof msg.activeId !== "string") return null;
  const tabs: BrowserTabInfo[] = [];
  for (const tab of msg.tabs as unknown[]) {
    if (typeof tab !== "object" || tab === null) return null;
    const { id, title, url } = tab as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      typeof title !== "string" ||
      typeof url !== "string"
    ) {
      return null;
    }
    tabs.push({ id, title, url });
  }
  return tabs;
}

function readDialog(
  msg: Extract<BrowserServerMessage, { t: "dialog" }>
): BrowserDialogInfo | null {
  if (!DIALOG_KINDS.has(msg.kind) || typeof msg.message !== "string") {
    return null;
  }
  return {
    kind: msg.kind,
    message: msg.message,
    defaultPrompt:
      typeof msg.defaultPrompt === "string" ? msg.defaultPrompt : "",
  };
}

function readSelect(
  msg: Extract<BrowserServerMessage, { t: "select" }>
): BrowserSelectInfo | null {
  const rect = msg.rect as Record<string, unknown> | null | undefined;
  if (
    !Number.isInteger(msg.id) ||
    !Array.isArray(msg.options) ||
    typeof rect !== "object" ||
    rect === null ||
    !isNumber(rect.x) ||
    !isNumber(rect.y) ||
    !isNumber(rect.width) ||
    !isNumber(rect.height)
  ) {
    return null;
  }
  const options: BrowserSelectOption[] = [];
  for (const option of msg.options as unknown[]) {
    if (typeof option !== "object" || option === null) return null;
    const { label, disabled, group } = option as Record<string, unknown>;
    if (typeof label !== "string") return null;
    options.push({
      label,
      disabled: disabled === true,
      group: typeof group === "string" ? group : null,
    });
  }
  return {
    id: msg.id,
    options,
    selectedIndex: Number.isInteger(msg.selectedIndex) ? msg.selectedIndex : -1,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  };
}

function receive(
  state: BrowserSessionState,
  msg: BrowserServerMessage
): BrowserSessionState {
  switch (msg.t) {
    case "page": {
      const page = readPage(msg);
      if (!page) return state;
      if (state.page && samePage(state.page, page)) return state;
      const navigated = state.page !== null && state.page.url !== page.url;
      return { ...state, page, select: navigated ? null : state.select };
    }
    case "tabs": {
      const tabs = readTabs(msg);
      if (!tabs) return state;
      const switched =
        state.activeId !== null && state.activeId !== msg.activeId;
      return {
        ...state,
        tabs,
        activeId: msg.activeId,
        select: switched ? null : state.select,
      };
    }
    case "dialog": {
      const dialog = readDialog(msg);
      if (!dialog) return state;
      const current = state.dialog;
      if (
        current &&
        current.kind === dialog.kind &&
        current.message === dialog.message &&
        current.defaultPrompt === dialog.defaultPrompt
      ) {
        return state;
      }
      return { ...state, dialog };
    }
    case "dialogClosed":
      return state.dialog ? { ...state, dialog: null } : state;
    case "select": {
      const select = readSelect(msg);
      return select ? { ...state, select } : state;
    }
    case "selectClosed":
      return state.select && state.select.id === msg.id
        ? { ...state, select: null }
        : state;
    case "notice":
      return typeof msg.message === "string"
        ? withNotice(state, msg.message)
        : state;
    default:
      return state;
  }
}

export function browserSessionReducer(
  state: BrowserSessionState,
  action: BrowserSessionAction
): BrowserSessionState {
  switch (action.type) {
    case "server":
      return receive(state, action.message);
    case "reset":
      return initialBrowserSessionState;
    case "notice":
      return withNotice(state, action.message);
    case "noticeExpired":
      return state.notice && state.notice.seq === action.seq
        ? { ...state, notice: null }
        : state;
    case "selectDismissed":
      return state.select && state.select.id === action.id
        ? { ...state, select: null }
        : state;
    default:
      return state;
  }
}
