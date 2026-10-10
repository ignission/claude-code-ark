// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyNavCommand, KeyNavRegion } from "./keynav";
import {
  activeWorkTab,
  availableRegions,
  executeKeyNavCommand,
  focusInput,
  KEYNAV_DIAGRAM_SCROLL_EVENT,
  type KeyNavDiagramScroll,
  regionFocusTarget,
} from "./keynav-dom";

/** 画面の骨組み。選択中のセッション (s2) と、隠れている別セッションのペインを持つ */
function mountApp({ workOpen = true, tab = "ファイル", chat = true } = {}) {
  document.body.innerHTML = `
    <div data-keynav-region="sidebar">
      <div data-session-list>
        <h2 data-section="your-turn">あなたの番</h2>
        <div role="button" tabindex="0" data-session-key="s1"></div>
        <div role="button" tabindex="0" data-session-key="s2" aria-current="true"></div>
        <h2 data-section="working">作業中</h2>
        <div role="button" tabindex="0" data-session-key="s3"></div>
      </div>
    </div>
    <div class="hidden">
      <div data-keynav-region="left"><textarea data-keynav="chat-input" id="other-input"></textarea></div>
      <div data-keynav-region="work"></div>
    </div>
    <div id="active">
      <div data-keynav-region="left">
        <fieldset>
          <button aria-label="端末" aria-pressed="${!chat}"></button>
          <button aria-label="会話" aria-pressed="${chat}"></button>
        </fieldset>
        <button aria-label="パネル"></button>
        <div class="${chat ? "hidden" : ""}"><iframe data-keynav="terminal"></iframe></div>
        <div class="${chat ? "" : "hidden"}">
          <div data-keynav="chat-scroll"></div>
          <textarea data-keynav="chat-input" id="input"></textarea>
        </div>
      </div>
      <div data-keynav-region="work" class="${workOpen ? "" : "hidden"}">
        <div role="tablist" aria-label="パネルの表示">
          ${["図", "ファイル", "Git"].map(label => `<button role="tab" aria-selected="${label === tab}">${label}</button>`).join("")}
        </div>
        <button aria-label="パネルを閉じる"></button>
        <div role="tablist" aria-label="開いているファイル">
          <button role="tab" aria-selected="true" id="f1"></button>
          <button role="tab" aria-selected="false" id="f2"></button>
        </div>
        <div role="tree">
          <div role="treeitem" tabindex="0" aria-expanded="true" id="dir"></div>
          <div role="treeitem" tabindex="-1" id="file"></div>
        </div>
        <div class="${tab === "Git" ? "" : "hidden"}"><div role="listbox" tabindex="0" id="commits"></div></div>
      </div>
    </div>`;
}

const clicks: string[] = [];
const keys: string[] = [];

beforeEach(() => {
  clicks.length = 0;
  keys.length = 0;
  document.addEventListener("click", onClick);
  document.addEventListener("keydown", onKey);
});
afterEach(() => {
  document.removeEventListener("click", onClick);
  document.removeEventListener("keydown", onKey);
  document.body.innerHTML = "";
});

function describeTarget(el: HTMLElement): string {
  return (
    (el.getAttribute("data-session-key") ??
      el.getAttribute("aria-label") ??
      el.id ??
      el.textContent ??
      "") ||
    (el.textContent ?? "")
  );
}
function onClick(event: Event) {
  clicks.push(describeTarget(event.target as HTMLElement));
}
function onKey(event: KeyboardEvent) {
  keys.push(`${describeTarget(event.target as HTMLElement)}:${event.key}`);
}

function run(command: KeyNavCommand, region: KeyNavRegion = "left") {
  const deferred: Array<() => void> = [];
  const result = executeKeyNavCommand(command, region, document, document, fn =>
    deferred.push(fn)
  );
  return { result, deferred };
}

describe("場所", () => {
  it("見えている場所だけを数える (隠れた別セッションのペインは数えない)", () => {
    mountApp();
    expect(availableRegions(document)).toEqual(["sidebar", "left", "work"]);
    mountApp({ workOpen: false });
    expect(availableRegions(document)).toEqual(["sidebar", "left"]);
  });

  it("h / l で隣の場所へ移り、端では動かない", () => {
    mountApp();
    expect(run({ type: "region", dir: 1 }, "left").result).toEqual({
      region: "work",
      refocus: true,
    });
    expect(run({ type: "region", dir: -1 }, "sidebar").result).toEqual({
      region: "sidebar",
    });
    mountApp({ workOpen: false });
    expect(run({ type: "region", dir: 1 }, "left").result).toEqual({
      region: "left",
    });
  });

  it("場所に入ったときのフォーカスの置き先", () => {
    mountApp();
    // サイドバーは選択中のセッション、ファイルはツリーの行、Git はコミット一覧
    expect(regionFocusTarget(document, "sidebar")?.dataset.sessionKey).toBe(
      "s2"
    );
    expect(regionFocusTarget(document, "work")?.id).toBe("dir");
    mountApp({ tab: "Git" });
    expect(activeWorkTab(document)).toBe("git");
    expect(regionFocusTarget(document, "work")?.id).toBe("commits");
    // 会話と図には置き先が無い (受け皿に置く)
    expect(regionFocusTarget(document, "left")).toBeNull();
    mountApp({ tab: "図" });
    expect(regionFocusTarget(document, "work")).toBeNull();
  });
});

describe("場所の中の移動", () => {
  it("サイドバーでは j / k でセッションの行にフォーカスを移す", () => {
    mountApp();
    run({ type: "move", dir: 1 }, "sidebar");
    expect((document.activeElement as HTMLElement).dataset.sessionKey).toBe(
      "s3"
    );
    run({ type: "move", dir: -1 }, "sidebar");
    run({ type: "move", dir: -1 }, "sidebar");
    expect((document.activeElement as HTMLElement).dataset.sessionKey).toBe(
      "s1"
    );
    // 端では止まる
    run({ type: "move", dir: -1 }, "sidebar");
    expect((document.activeElement as HTMLElement).dataset.sessionKey).toBe(
      "s1"
    );
    run({ type: "edge", to: "end" }, "sidebar");
    expect((document.activeElement as HTMLElement).dataset.sessionKey).toBe(
      "s3"
    );
  });

  it("ツリーは行へ直接フォーカスを移す", () => {
    mountApp();
    document.getElementById("dir")?.focus();
    run({ type: "move", dir: 1 }, "work");
    expect(document.activeElement?.id).toBe("file");
    // 端では止まる
    run({ type: "page", dir: 1 }, "work");
    expect(document.activeElement?.id).toBe("file");
    run({ type: "edge", to: "start" }, "work");
    expect(document.activeElement?.id).toBe("dir");
    expect(keys).toEqual([]);
  });

  it("コミット一覧には矢印を送り、半ページは一覧の PageDown / PageUp に任せる", () => {
    mountApp({ tab: "Git" });
    run({ type: "move", dir: -1 }, "work");
    run({ type: "edge", to: "end" }, "work");
    // 矢印を 10 回送っても、一覧は描き直すまで同じ選択から計算するので 1 行しか進まない
    run({ type: "page", dir: 1 }, "work");
    run({ type: "page", dir: -1 }, "work");
    expect(keys).toEqual([
      "commits:ArrowUp",
      "commits:End",
      "commits:PageDown",
      "commits:PageUp",
    ]);
  });

  it("ツリーの中では、h は開いたフォルダを畳み、l は開く", () => {
    mountApp();
    document.getElementById("dir")?.focus();
    expect(run({ type: "region", dir: -1 }, "work").result).toEqual({
      region: "work",
    });
    run({ type: "region", dir: 1 }, "work");
    expect(keys).toEqual(["dir:ArrowLeft", "dir:ArrowRight"]);
    // 畳めない行 (ファイル) では、h で左の場所へ出る
    document.getElementById("file")?.focus();
    expect(run({ type: "region", dir: -1 }, "work").result).toEqual({
      region: "left",
      refocus: true,
    });
  });

  it("会話は j / k で送り、gg / G で端へ寄せる", () => {
    mountApp();
    const scroller = document.querySelector<HTMLElement>(
      '#active [data-keynav="chat-scroll"]'
    );
    if (!scroller) throw new Error("no scroller");
    const scrollBy = vi.fn();
    scroller.scrollBy = scrollBy as unknown as typeof scroller.scrollBy;
    run({ type: "move", dir: 1 }, "left");
    expect(scrollBy).toHaveBeenCalledWith({ top: 80 });
    Object.defineProperty(scroller, "scrollHeight", { value: 900 });
    run({ type: "edge", to: "end" }, "left");
    expect(scroller.scrollTop).toBe(900);
  });

  it("図は中に触れないので、見えている図の iframe へ送る量の合図を投げる", () => {
    mountApp({ tab: "図" });
    const work = document.querySelector("#active [data-keynav-region=work]");
    work?.insertAdjacentHTML(
      "beforeend",
      '<div id="pane"><iframe data-keynav="diagram"></iframe></div>'
    );
    const got: KeyNavDiagramScroll[] = [];
    document
      .querySelector("#pane")
      ?.addEventListener(KEYNAV_DIAGRAM_SCROLL_EVENT, event =>
        got.push((event as CustomEvent<KeyNavDiagramScroll>).detail)
      );
    run({ type: "move", dir: 1 }, "work");
    run({ type: "page", dir: -1 }, "work");
    run({ type: "edge", to: "end" }, "work");
    run({ type: "edge", to: "start" }, "work");
    expect(got).toEqual([
      { unit: "line", dir: 1 },
      { unit: "page", dir: -1 },
      { unit: "edge", dir: 1 },
      { unit: "edge", dir: -1 },
    ]);
    // ツリーやコミット一覧には何も送らない
    expect(keys).toEqual([]);
  });

  it("図の一覧を開いている間は、図ではなく一覧を動かす", () => {
    mountApp({ tab: "図" });
    const work = document.querySelector("#active [data-keynav-region=work]");
    work?.insertAdjacentHTML(
      "beforeend",
      '<div id="pane"><div role="listbox" tabindex="0" id="diagrams"></div><iframe data-keynav="diagram"></iframe></div>'
    );
    const got: Event[] = [];
    document.addEventListener(KEYNAV_DIAGRAM_SCROLL_EVENT, event =>
      got.push(event)
    );
    run({ type: "move", dir: 1 }, "work");
    run({ type: "edge", to: "end" }, "work");
    expect(got).toEqual([]);
    expect(keys).toEqual(["diagrams:ArrowDown", "diagrams:End"]);
    expect(regionFocusTarget(document, "work")?.id).toBe("diagrams");
  });

  it("図のタブを見ていなければ、図には合図を投げない", () => {
    mountApp({ tab: "Git" });
    const work = document.querySelector("#active [data-keynav-region=work]");
    work?.insertAdjacentHTML(
      "beforeend",
      '<div class="hidden"><iframe data-keynav="diagram"></iframe></div>'
    );
    const got: Event[] = [];
    document.addEventListener(KEYNAV_DIAGRAM_SCROLL_EVENT, event =>
      got.push(event)
    );
    run({ type: "move", dir: 1 }, "work");
    expect(got).toEqual([]);
    expect(keys).toEqual(["commits:ArrowDown"]);
  });
});

describe("どこでも効く指示", () => {
  it("J / K は選択中の隣のセッションを開き、端では反対側へ回る", () => {
    mountApp();
    run({ type: "session", dir: 1 });
    run({ type: "session", dir: -1 });
    expect(clicks).toEqual(["s3", "s1"]);
  });

  it("n は「あなたの番」の中の、いまとは別のセッションを開く", () => {
    mountApp();
    run({ type: "next-your-turn" });
    expect(clicks).toEqual(["s1"]);
  });

  it("t は端末と会話を入れ替え、p は作業エリアを開閉する", () => {
    mountApp();
    run({ type: "toggle-left-mode" });
    expect(clicks).toEqual(["端末"]);
    // 作業エリアにいるときに閉じたら、左のパネルへ戻る
    expect(run({ type: "toggle-work-area" }, "work").result).toEqual({
      region: "left",
      refocus: true,
    });
    expect(clicks).toEqual(["端末", "パネル"]);
  });

  it("gs は Git のタブへ移る。閉じていれば開いてから選ぶ", () => {
    mountApp();
    expect(run({ type: "work-tab", tab: "git" }).result).toEqual({
      region: "work",
      refocus: true,
    });
    expect(clicks).toEqual(["Git"]);

    mountApp({ workOpen: false });
    clicks.length = 0;
    const { deferred } = run({ type: "work-tab", tab: "board" });
    expect(clicks).toEqual(["パネル"]);
    document
      .querySelector('#active [data-keynav-region="work"]')
      ?.classList.remove("hidden");
    for (const fn of deferred) fn();
    expect(clicks).toEqual(["パネル", "図"]);
  });

  it("gt / gT はファイルタブを巡回する", () => {
    mountApp();
    run({ type: "file-tab", dir: 1 });
    run({ type: "file-tab", dir: -1 });
    expect(clicks).toEqual(["f2", "f2"]);
  });

  it("q はピークがあればピークを、無ければ作業エリアを閉じる", () => {
    mountApp();
    run({ type: "close" }, "work");
    expect(clicks).toEqual(["パネルを閉じる"]);
    const peek = document.createElement("button");
    peek.setAttribute("aria-label", "ピークを閉じる");
    document.querySelector('#active [data-keynav-region="work"]')?.append(peek);
    clicks.length = 0;
    expect(run({ type: "close" }, "work").result).toEqual({ region: "work" });
    expect(clicks).toEqual(["ピークを閉じる"]);
  });

  it("i は見えているほうの入力 (会話の入力欄 / 端末) にフォーカスを置く", () => {
    mountApp();
    expect(run({ type: "insert" }).result).toEqual({
      region: "left",
      insert: true,
    });
    expect(document.activeElement?.id).toBe("input");

    mountApp({ chat: false });
    focusInput(document);
    expect(document.activeElement?.tagName).toBe("IFRAME");
  });
});
