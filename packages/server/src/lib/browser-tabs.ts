/**
 * ブラウザ機能のタブの一覧。
 *
 * CDPの `Target.*` のイベントから読んだ内容を受け取って一覧を持つだけで、CDPも視聴者も
 * 知らない。いつ視聴者へ知らせるか、どのタブへつなぐかは、使う側
 * (browser-tab-controller.ts) が決める。
 *
 * - 追うのは `type` が `page` のターゲットだけ。worker、iframe、DevToolsの画面、
 *   拡張機能のページは、利用者が切り替える先ではない
 * - 並びは足した順。もうあるタブを足し直しても、更新しても、位置は変えない
 * - 視聴者に見える列 (題とURL) が変わったときだけ「変わった」と答える。Chromiumは、
 *   attachしたかどうかなどの見えない列が変わっただけでも更新を知らせてくる
 * - 更新は、追っているタブにだけ当てる。閉じたタブの更新が遅れて届いても、一覧へ戻さない
 * - タブのidは、CDPのターゲットのidをそのまま使う
 */

import type { BrowserTabInfo } from "@ark/shared";
import { MAX_TITLE_LENGTH, MAX_URL_LENGTH } from "./browser-page-state.js";

/** 視聴者が新しく開けるタブの数の上限。ページが開くタブは止められないので、一覧はこれを超えうる */
export const MAX_TABS = 20;

/** 一覧に出さないページのURLの始まり */
const INTERNAL_URL_PREFIXES = ["devtools://", "chrome-extension://"];

/** CDPの `targetInfo` のうち、使う列 */
export interface TargetInfo {
  id: string;
  type: string;
  title: string;
  url: string;
  /** このターゲットを開いたターゲットのid。無ければ `null` */
  openerId: string | null;
}

/** CDPの `targetInfo` を読む。形が違えば `null`。題とURLは上限で切る */
export function readTargetInfo(value: unknown): TargetInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const { targetId, type, title, url, openerId } = value as Record<
    string,
    unknown
  >;
  if (typeof targetId !== "string" || targetId === "") return null;
  if (typeof type !== "string") return null;
  return {
    id: targetId,
    type,
    title: typeof title === "string" ? title.slice(0, MAX_TITLE_LENGTH) : "",
    url: typeof url === "string" ? url.slice(0, MAX_URL_LENGTH) : "",
    openerId: typeof openerId === "string" ? openerId : null,
  };
}

function isTab(info: TargetInfo): boolean {
  return (
    info.type === "page" &&
    !INTERNAL_URL_PREFIXES.some(prefix => info.url.startsWith(prefix))
  );
}

export class BrowserTabs {
  /** 足した順に並ぶ */
  private readonly tabs = new Map<string, BrowserTabInfo>();

  get size(): number {
    return this.tabs.size;
  }

  has(id: string): boolean {
    return this.tabs.has(id);
  }

  get(id: string): BrowserTabInfo | null {
    const tab = this.tabs.get(id);
    return tab ? { ...tab } : null;
  }

  list(): BrowserTabInfo[] {
    return [...this.tabs.values()].map(tab => ({ ...tab }));
  }

  /**
   * タブを足す。もうあれば、位置を変えずに題とURLを変える。
   * 一覧が変わったら `true`。タブでないものは足さない。
   */
  add(info: TargetInfo): boolean {
    if (!isTab(info)) return false;
    if (this.tabs.has(info.id)) return this.update(info) !== null;
    this.tabs.set(info.id, { id: info.id, title: info.title, url: info.url });
    return true;
  }

  /**
   * 追っているタブの題とURLを変える。変わったら、題が変わったかを返す。
   * 何も変わらなければ `null`。
   */
  update(info: TargetInfo): { title: boolean } | null {
    const tab = this.tabs.get(info.id);
    if (!tab) return null;
    const title = tab.title !== info.title;
    if (!title && tab.url === info.url) return null;
    tab.title = info.title;
    tab.url = info.url;
    return { title };
  }

  /** 一覧が変わったら `true` */
  remove(id: string): boolean {
    return this.tabs.delete(id);
  }

  /**
   * `id` のタブが使えなくなったときに移る先の候補。直前、直後、そのあとは近い順。
   * `id` が一覧に無ければ、一覧の順の全部。
   */
  fallbacks(id: string): string[] {
    const ids = [...this.tabs.keys()];
    const index = ids.indexOf(id);
    if (index < 0) return ids;
    const result: string[] = [];
    for (let distance = 1; distance < ids.length; distance++) {
      const before = ids[index - distance];
      const after = ids[index + distance];
      if (before !== undefined) result.push(before);
      if (after !== undefined) result.push(after);
    }
    return result;
  }
}
