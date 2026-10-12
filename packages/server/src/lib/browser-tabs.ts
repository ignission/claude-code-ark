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
 * - 追っているタブが、追わない種類のページ (DevToolsの画面、拡張機能のページ) へ移ったら、
 *   一覧から外す。使う側が残すと決めたタブ (映しているタブ) は外さない
 * - 映しているタブが開いたので切り替えた先のタブには、開いたタブを覚える。切り替えた先が
 *   消えたときに、開いたタブへ戻るため (ログインのポップアップなど)。覚えるのは一覧の外で、
 *   視聴者へは見せない
 * - 追う数には上限を置く。ページがタブを開き続けると、一覧と、視聴者へ送る一覧の通知が
 *   際限なく大きくなる。超えたぶんのどれを閉じるかはここで選び、閉じるのは使う側
 * - タブのidは、CDPのターゲットのidをそのまま使う
 */

import type { BrowserTabInfo } from "@ark/shared";
import { MAX_TITLE_LENGTH, MAX_URL_LENGTH } from "./browser-page-state.js";

/** 視聴者が新しく開けるタブの数の上限。ページが開くタブは止められないので、一覧はこれを超えうる */
export const MAX_TABS = 20;

/** 追うタブの数の上限。超えたぶんは、使う側が古いものから閉じる */
export const MAX_TRACKED_TABS = 50;

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
  /** 切り替えた先のタブのidから、それを開いたタブのid */
  private readonly openers = new Map<string, string>();

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
    if (this.tabs.has(info.id)) return this.update(info, true) !== null;
    this.tabs.set(info.id, { id: info.id, title: info.title, url: info.url });
    return true;
  }

  /**
   * 追っているタブの題とURLを変える。変わったら、題が変わったかを返す。
   * 何も変わらなければ `null`。追わない種類のページへ移っていたら、一覧から外して
   * `"removed"` を返す (`keep` なら外さない)。
   */
  update(
    info: TargetInfo,
    keep = false
  ): { title: boolean } | "removed" | null {
    const tab = this.tabs.get(info.id);
    if (!tab) return null;
    if (!keep && !isTab(info)) {
      this.remove(info.id);
      return "removed";
    }
    const title = tab.title !== info.title;
    if (!title && tab.url === info.url) return null;
    tab.title = info.title;
    tab.url = info.url;
    return { title };
  }

  /** 一覧が変わったら `true` */
  remove(id: string): boolean {
    this.openers.delete(id);
    return this.tabs.delete(id);
  }

  /** `id` のタブは、`openerId` のタブが開いたので切り替えた先だと覚える。どちらも一覧にあるときだけ */
  follow(id: string, openerId: string): void {
    if (this.tabs.has(id) && this.tabs.has(openerId)) {
      this.openers.set(id, openerId);
    }
  }

  /** `id` のタブを開いたと覚えているタブ。覚えていないか、もう一覧に無ければ `null` */
  openerOf(id: string): string | null {
    const opener = this.openers.get(id);
    return opener !== undefined && this.tabs.has(opener) ? opener : null;
  }

  /**
   * `id` のタブが使えなくなったときに移る先の候補。開いたタブを覚えていればそれが先で、
   * あとは直前、直後、近い順。`id` が一覧に無ければ、一覧の順の全部。
   */
  fallbacks(id: string): string[] {
    const ids = [...this.tabs.keys()];
    const index = ids.indexOf(id);
    if (index < 0) return ids;
    const opener = this.openerOf(id);
    const result: string[] = opener === null ? [] : [opener];
    for (let distance = 1; distance < ids.length; distance++) {
      for (const near of [ids[index - distance], ids[index + distance]]) {
        if (near !== undefined && near !== opener) result.push(near);
      }
    }
    return result;
  }

  /**
   * 上限を超えたぶんの、閉じるタブ。古い順に、`keep` に無いものから選ぶ。
   * 超えていなければ空。
   */
  overflow(keep: ReadonlySet<string>): string[] {
    const excess = this.tabs.size - MAX_TRACKED_TABS;
    if (excess <= 0) return [];
    return [...this.tabs.keys()].filter(id => !keep.has(id)).slice(0, excess);
  }
}
