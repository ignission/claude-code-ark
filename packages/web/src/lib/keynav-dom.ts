/**
 * keynav-dom - ノーマルモードの指示を、画面の操作に直す
 *
 * 指示は「利用者がマウスで押すもの」をそのまま押すことで実行する (行をクリックする、
 * タブをクリックする、一覧へ矢印キーを送る)。状態を持つ部品 (Dashboard・
 * SplitViewPane・FilePane …) へ指示ごとの口を足さずに済み、マウスで出来ることと
 * キーで出来ることが食い違わない。
 *
 * 全セッションぶんの SplitViewPane が常時マウントされているので、要素は必ず
 * 「見えているもの」から探す (`hidden` の祖先を持たないもの)。
 */

import type { KeyNavCommand, KeyNavRegion, KeyNavWorkTab } from "./keynav";
import { KEYNAV_REGIONS } from "./keynav";

const WORK_TAB_LABEL: Record<KeyNavWorkTab, string> = {
  board: "図",
  files: "ファイル",
  git: "Git",
};

/** 1 回の j / k で会話を送る量 (px) */
const LINE_SCROLL = 80;
/** 半ページ送りで、一覧の行をいくつ動かすか */
const PAGE_ROWS = 10;

export function isVisible(element: Element): boolean {
  return element.closest(".hidden, [hidden]") === null;
}

function visibleAll<T extends Element = HTMLElement>(
  root: ParentNode,
  selector: string
): T[] {
  return [...root.querySelectorAll<T>(selector)].filter(isVisible);
}

function visibleOne<T extends Element = HTMLElement>(
  root: ParentNode,
  selector: string
): T | null {
  return visibleAll<T>(root, selector)[0] ?? null;
}

export function regionElement(
  root: ParentNode,
  region: KeyNavRegion
): HTMLElement | null {
  return visibleOne(root, `[data-keynav-region="${region}"]`);
}

/** いま移れる場所 (作業エリアは開いているときだけ) */
export function availableRegions(root: ParentNode): KeyNavRegion[] {
  return KEYNAV_REGIONS.filter(region => regionElement(root, region) !== null);
}

/** 作業エリアで見えているタブ */
export function activeWorkTab(root: ParentNode): KeyNavWorkTab | null {
  const selected = visibleOne(
    root,
    '[role="tablist"][aria-label="パネルの表示"] [role="tab"][aria-selected="true"]'
  );
  const label = selected?.textContent?.trim();
  const found = (Object.keys(WORK_TAB_LABEL) as KeyNavWorkTab[]).find(
    tab => WORK_TAB_LABEL[tab] === label
  );
  return found ?? null;
}

function sessionRows(root: ParentNode): HTMLElement[] {
  return visibleAll(root, "[data-session-list] [data-session-key]");
}

function currentIndex(rows: HTMLElement[]): number {
  return rows.findIndex(row => row.getAttribute("aria-current") === "true");
}

function sendKey(target: Element, key: string): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
  );
}

/** 作業エリアの中で、矢印キーを受ける一覧 (ツリーの行 / コミット一覧) */
function workList(root: ParentNode): HTMLElement | null {
  const work = regionElement(root, "work");
  if (!work) return null;
  const tab = activeWorkTab(root);
  if (tab === "files") {
    return (
      visibleOne(work, '[role="tree"] [role="treeitem"][tabindex="0"]') ??
      visibleOne(work, '[role="tree"] [role="treeitem"]')
    );
  }
  if (tab === "git") return visibleOne(work, '[role="listbox"][tabindex="0"]');
  return null;
}

/** 場所に入ったときにフォーカスを置く先。無ければ null (呼び出し側が受け皿へ置く) */
export function regionFocusTarget(
  root: ParentNode,
  region: KeyNavRegion
): HTMLElement | null {
  if (region === "sidebar") {
    const rows = sessionRows(root);
    return rows[currentIndex(rows)] ?? rows[0] ?? null;
  }
  if (region === "work") return workList(root);
  return null;
}

function chatScroller(root: ParentNode): HTMLElement | null {
  return visibleOne(root, '[data-keynav="chat-scroll"]');
}

function moveSidebar(root: ParentNode, by: number, doc: Document): void {
  const rows = sessionRows(root);
  if (rows.length === 0) return;
  const focused = rows.indexOf(doc.activeElement as HTMLElement);
  const from = focused >= 0 ? focused : Math.max(0, currentIndex(rows));
  const next = Math.min(rows.length - 1, Math.max(0, from + by));
  rows[next].focus();
}

function moveIn(
  root: ParentNode,
  region: KeyNavRegion,
  dir: -1 | 1,
  count: number,
  doc: Document
): void {
  if (region === "sidebar") {
    moveSidebar(root, dir * count, doc);
    return;
  }
  if (region === "left") {
    const scroller = chatScroller(root);
    if (!scroller) return;
    const amount = count === 1 ? LINE_SCROLL : scroller.clientHeight / 2;
    scroller.scrollBy({ top: dir * amount });
    return;
  }
  const list = workList(root);
  if (!list) return;
  if (list.getAttribute("role") === "listbox") {
    // 矢印を続けて送っても、一覧は描き直すまで同じ選択から次を計算する (1 行しか進まない)。
    // まとめて動かすときは、一覧が持つ PageDown / PageUp に任せる
    const key =
      count === 1
        ? dir === 1
          ? "ArrowDown"
          : "ArrowUp"
        : dir === 1
          ? "PageDown"
          : "PageUp";
    sendKey(list, key);
    return;
  }
  focusTreeRow(root, doc, at => at + dir * count);
}

/** ツリーは行ごとにフォーカスを持つので、行へ直接フォーカスを移す (行が自分で選択を追う) */
function focusTreeRow(
  root: ParentNode,
  doc: Document,
  pick: (at: number, length: number) => number
): void {
  const rows = visibleAll(
    regionElement(root, "work") ?? root,
    '[role="tree"] [role="treeitem"]'
  );
  if (rows.length === 0) return;
  const focused = rows.indexOf(doc.activeElement as HTMLElement);
  const at =
    focused >= 0
      ? focused
      : Math.max(
          0,
          rows.findIndex(row => row.tabIndex === 0)
        );
  rows[Math.min(rows.length - 1, Math.max(0, pick(at, rows.length)))].focus();
}

function edgeIn(
  root: ParentNode,
  region: KeyNavRegion,
  to: "start" | "end",
  doc: Document
): void {
  if (region === "sidebar") {
    const rows = sessionRows(root);
    rows[to === "start" ? 0 : rows.length - 1]?.focus();
    return;
  }
  if (region === "left") {
    const scroller = chatScroller(root);
    if (scroller)
      scroller.scrollTop = to === "start" ? 0 : scroller.scrollHeight;
    return;
  }
  const list = workList(root);
  if (!list) return;
  if (list.getAttribute("role") === "listbox") {
    sendKey(list, to === "start" ? "Home" : "End");
    return;
  }
  focusTreeRow(root, doc, (_, length) => (to === "start" ? 0 : length - 1));
}

function clickSession(
  root: ParentNode,
  pick: (rows: HTMLElement[]) => HTMLElement | undefined
): void {
  pick(sessionRows(root))?.click();
}

/** 「あなたの番」の見出しの下にある行 (次の見出しまで) */
function yourTurnRows(root: ParentNode): HTMLElement[] {
  const items = visibleAll(
    root,
    "[data-session-list] h2[data-section], [data-session-list] [data-session-key]"
  );
  const rows: HTMLElement[] = [];
  let inside = false;
  for (const item of items) {
    if (item.hasAttribute("data-section")) {
      inside = item.getAttribute("data-section") === "your-turn";
    } else if (inside) {
      rows.push(item);
    }
  }
  return rows;
}

function clickWorkTab(root: ParentNode, tab: KeyNavWorkTab): boolean {
  const target = visibleAll(
    root,
    '[role="tablist"][aria-label="パネルの表示"] [role="tab"]'
  ).find(el => el.textContent?.trim() === WORK_TAB_LABEL[tab]);
  target?.click();
  return target !== undefined;
}

function toggleWorkArea(root: ParentNode): void {
  visibleOne(root, 'button[aria-label="パネル"]')?.click();
}

/** 入力モードへ: 見えているほう (端末 / 会話の入力欄) にフォーカスを置く */
export function focusInput(root: ParentNode): void {
  const terminal = visibleOne<HTMLIFrameElement>(
    root,
    'iframe[data-keynav="terminal"]'
  );
  if (terminal) {
    // ttyd は同じ出どころなので、中の xterm (`window.term`) へ直接フォーカスを渡せる
    const term = (
      terminal.contentWindow as unknown as {
        term?: { focus?: () => void };
      } | null
    )?.term;
    terminal.focus();
    term?.focus?.();
    return;
  }
  visibleOne(root, 'textarea[data-keynav="chat-input"]')?.focus();
}

export interface KeyNavExecution {
  /** 指示のあとにいる場所 (変わらなければ渡された場所のまま) */
  region: KeyNavRegion;
  /** 入力モードへ出る指示だったか */
  insert?: boolean;
  /** 場所が変わり、フォーカスの置き直しが要るか */
  refocus?: boolean;
}

/**
 * 指示を実行する。`help` と `cancel` は表示だけの指示なので、呼び出し側が扱う。
 * 作業エリアを開いてからタブを選ぶ操作は描画を 1 回挟むので、`defer` で後回しにする。
 */
export function executeKeyNavCommand(
  command: KeyNavCommand,
  region: KeyNavRegion,
  root: ParentNode,
  doc: Document,
  defer: (run: () => void) => void
): KeyNavExecution {
  switch (command.type) {
    case "insert":
      focusInput(root);
      return { region, insert: true };
    case "region": {
      // ツリーの中では、h は開いているフォルダを畳み、l は開く (vim のファイラと同じ)
      const focused = doc.activeElement;
      if (
        region === "work" &&
        focused instanceof HTMLElement &&
        focused.getAttribute("role") === "treeitem"
      ) {
        if (command.dir === 1) {
          sendKey(focused, "ArrowRight");
          return { region };
        }
        if (focused.getAttribute("aria-expanded") === "true") {
          sendKey(focused, "ArrowLeft");
          return { region };
        }
      }
      const regions = availableRegions(root);
      const at = regions.indexOf(region);
      const next = regions[at + command.dir];
      return next ? { region: next, refocus: true } : { region };
    }
    case "move":
      moveIn(root, region, command.dir, 1, doc);
      return { region };
    case "page":
      moveIn(root, region, command.dir, PAGE_ROWS, doc);
      return { region };
    case "edge":
      edgeIn(root, region, command.to, doc);
      return { region };
    case "session":
      clickSession(root, rows => {
        if (rows.length === 0) return undefined;
        const at = currentIndex(rows);
        const next = (at + command.dir + rows.length) % rows.length;
        return rows[at < 0 ? 0 : next];
      });
      return { region, refocus: region === "sidebar" };
    case "next-your-turn": {
      const rows = yourTurnRows(root);
      const at = currentIndex(rows);
      (rows[at + 1] ?? rows.find((_, index) => index !== at))?.click();
      return { region, refocus: region === "sidebar" };
    }
    case "toggle-left-mode":
      visibleOne(
        regionElement(root, "left") ?? root,
        'fieldset button[aria-pressed="false"]'
      )?.click();
      return { region };
    case "toggle-work-area": {
      const wasOpen = regionElement(root, "work") !== null;
      toggleWorkArea(root);
      return wasOpen && region === "work"
        ? { region: "left", refocus: true }
        : { region };
    }
    case "work-tab":
      if (regionElement(root, "work") === null) {
        toggleWorkArea(root);
        defer(() => clickWorkTab(root, command.tab));
      } else {
        clickWorkTab(root, command.tab);
      }
      return { region: "work", refocus: true };
    case "file-tab": {
      const tabs = visibleAll(
        root,
        '[role="tablist"][aria-label="開いているファイル"] [role="tab"]'
      );
      if (tabs.length === 0) return { region };
      const at = tabs.findIndex(
        tab => tab.getAttribute("aria-selected") === "true"
      );
      tabs[(Math.max(0, at) + command.dir + tabs.length) % tabs.length].click();
      return { region };
    }
    case "close": {
      const peek = visibleOne(root, 'button[aria-label="ピークを閉じる"]');
      if (peek) {
        peek.click();
        return { region };
      }
      const panel = visibleOne(root, 'button[aria-label="パネルを閉じる"]');
      if (!panel) return { region };
      panel.click();
      return region === "work" ? { region: "left", refocus: true } : { region };
    }
    case "help":
    case "cancel":
      return { region };
  }
}
