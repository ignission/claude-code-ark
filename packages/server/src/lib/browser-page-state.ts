/**
 * 映しているタブの状態 (URL、タイトル、読み込み中か、履歴を戻れるか、進めるか)。
 *
 * CDPのイベントと `Page.getNavigationHistory` の応答を受け取って状態を持つだけで、
 * CDPも視聴者も知らない。いつ履歴を読み直すかは、使う側 (browser-page-controller.ts) が決める。
 *
 * - 見るのはメインフレームだけ。サブフレーム (iframe) の遷移と読み込みは、アドレスバーに
 *   出すものではない
 * - 読み込みの開始と終了のイベントは、フレームのidしか持たない。メインフレームのidは、
 *   作るときに受け取り (ページのターゲットでは、ターゲットのidと同じ)、メインフレームの
 *   遷移のたびに覚え直す。分からない間は、これらのイベントを使わない
 * - URLは遷移のイベントですぐに変える。タイトルと、戻れるか進めるかは履歴からしか
 *   分からないので、履歴を読むまで前の値のままにする
 * - URLが分かるまでは、状態を持たない (`snapshot()` は `null`)。`Page.enable` は
 *   過去の遷移を送り直さないので、最初の状態は履歴から来る
 * - 前と同じ状態は知らせない。読み込み中はイベントが続き、その多くは何も変えない
 * - 読めない履歴 (遷移の途中の失敗、形の違う応答) は使わず、前の状態を保つ
 */

import type { BrowserPageInfo } from "@ark/shared";

/** URLの上限 (文字数)。`data:` のURLは際限なく長くなる */
const MAX_URL_LENGTH = 8192;
/** タイトルの上限 (文字数) */
const MAX_TITLE_LENGTH = 1024;

export interface HistoryEntry {
  id: number;
  url: string;
  title: string;
}

export interface NavigationHistory {
  currentIndex: number;
  entries: HistoryEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** `Page.getNavigationHistory` の応答を読む。形が違えば `null` */
export function readHistory(result: unknown): NavigationHistory | null {
  if (!isRecord(result) || !Array.isArray(result.entries)) return null;
  const { currentIndex } = result;
  if (
    typeof currentIndex !== "number" ||
    !Number.isInteger(currentIndex) ||
    currentIndex < 0 ||
    currentIndex >= result.entries.length
  ) {
    return null;
  }
  const entries: HistoryEntry[] = [];
  for (const entry of result.entries) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "number" ||
      typeof entry.url !== "string" ||
      typeof entry.title !== "string"
    ) {
      return null;
    }
    entries.push({ id: entry.id, url: entry.url, title: entry.title });
  }
  return { currentIndex, entries };
}

function sameInfo(a: BrowserPageInfo, b: BrowserPageInfo): boolean {
  return (
    a.url === b.url &&
    a.title === b.title &&
    a.loading === b.loading &&
    a.canGoBack === b.canGoBack &&
    a.canGoForward === b.canGoForward
  );
}

export class BrowserPageState {
  private info: BrowserPageInfo = {
    url: "",
    title: "",
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  /** URLが分かったか。分かるまでは知らせない */
  private known = false;
  /** 最後に知らせた状態 */
  private notified: BrowserPageInfo | null = null;

  constructor(
    private readonly onChange: (info: BrowserPageInfo) => void,
    private mainFrameId: string | null = null
  ) {}

  /** いまの状態。URLが分かるまでは `null` */
  snapshot(): BrowserPageInfo | null {
    return this.known ? { ...this.info } : null;
  }

  /**
   * タブのsessionから届いた `Page.*` のイベントを受け取る。メインフレームのものとして
   * 使ったら `true`。サブフレームのもの、知らないもの、形の違うものは使わず `false`。
   */
  handleEvent(method: string, params: unknown): boolean {
    const p = isRecord(params) ? params : {};
    switch (method) {
      case "Page.frameNavigated": {
        const frame = p.frame;
        if (!isRecord(frame) || typeof frame.url !== "string") return false;
        if (typeof frame.id !== "string" || frame.parentId !== undefined) {
          return false;
        }
        this.mainFrameId = frame.id;
        const fragment =
          typeof frame.urlFragment === "string" ? frame.urlFragment : "";
        this.setUrl(frame.url + fragment);
        break;
      }
      case "Page.navigatedWithinDocument":
        if (!this.isMainFrame(p.frameId) || typeof p.url !== "string") {
          return false;
        }
        this.setUrl(p.url);
        break;
      case "Page.frameStartedLoading":
        if (!this.isMainFrame(p.frameId)) return false;
        this.info.loading = true;
        break;
      case "Page.frameStoppedLoading":
        if (!this.isMainFrame(p.frameId)) return false;
        this.info.loading = false;
        break;
      case "Page.loadEventFired":
        this.info.loading = false;
        break;
      default:
        return false;
    }
    this.notify();
    return true;
  }

  /** `Page.getNavigationHistory` の応答を受け取る。読めなければ何も変えない */
  applyHistory(result: unknown): void {
    const history = readHistory(result);
    if (!history) return;
    const { currentIndex, entries } = history;
    const current = entries[currentIndex];
    this.setUrl(current.url);
    this.info.title = current.title.slice(0, MAX_TITLE_LENGTH);
    this.info.canGoBack = currentIndex > 0;
    this.info.canGoForward = currentIndex < entries.length - 1;
    this.notify();
  }

  private isMainFrame(frameId: unknown): boolean {
    return this.mainFrameId !== null && frameId === this.mainFrameId;
  }

  private setUrl(url: string): void {
    this.info.url = url.slice(0, MAX_URL_LENGTH);
    this.known = true;
  }

  private notify(): void {
    if (!this.known) return;
    if (this.notified && sameInfo(this.notified, this.info)) return;
    this.notified = { ...this.info };
    this.onChange({ ...this.info });
  }
}
