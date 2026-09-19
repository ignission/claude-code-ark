/**
 * DOC_EDITOR_LAYER のランタイム挙動を、実際に配信される（圧縮済みの）script で
 * 検証する。injectDiagramDocEditor() の出力からそのまま script を取り出して
 * 評価するため、minify が挙動を壊す種類のバグもここで捕まる。
 *
 * テストごとに独立した JSDOM window を新規に作る。委譲 listener は document に
 * 1つだけ付くため、window/document を使い回すとテストをまたいで listener が
 * 残り、二重発火系のバグを隠してしまう（#4）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { validateDiagramDocAnchors } from "./diagram-doc-anchors.js";
import { validateDiagramDocAuthorship } from "./diagram-doc-authorship.js";
import {
  DIAGRAM_DOC_EDITOR_MARKER,
  injectDiagramDocEditor,
} from "./diagram-doc-editor.js";
import type { DiagramModel } from "./diagram-model.js";

/** injectDiagramDocEditor() の出力から、実際に配信される script 本文を取り出す。 */
function extractInjectedScript(html: string): string {
  const idAttr = `id="${DIAGRAM_DOC_EDITOR_MARKER}"`;
  const idIndex = html.indexOf(idAttr);
  if (idIndex < 0) throw new Error("編集層が注入されていません");
  const tagEnd = html.indexOf(">", idIndex) + 1;
  const closeIndex = html.indexOf("</script>", tagEnd);
  if (tagEnd <= 0 || closeIndex < 0) {
    throw new Error("script タグの境界を特定できません");
  }
  return html.slice(tagEnd, closeIndex);
}

/**
 * 実際に配信される（圧縮済みの）script を、独立した JSDOM window 上で評価する。
 * bodyHtml・headExtra を injectDiagramDocEditor() に通してから script を
 * 取り出すので、常に「配信される成果物」を評価する。
 */
function runInjectedDocEditor(bodyHtml: string, headExtra = "") {
  return runInjectedDocEditorOnPage(
    `<!doctype html><html><head>${headExtra}</head><body>${bodyHtml}</body></html>`
  );
}

/** 実物のボード HTML をそのまま評価する入口。 */
function runInjectedDocEditorOnPage(page: string) {
  const injected = injectDiagramDocEditor(page);
  const script = extractInjectedScript(injected);
  const dom = new JSDOM(page, { runScripts: "dangerously" });
  // biome-ignore lint/suspicious/noExplicitAny: jsdom の Window 型は eval を持たない
  (dom.window as any).eval(script);
  if (dom.window.document.readyState === "loading") {
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
  }
  return dom;
}

describe("DOC_EDITOR_LAYER の contenteditable 配線", () => {
  it("入れ子ブロックでは最内側の葉だけを編集可能にし、入力しても葉だけが human になる", () => {
    const dom = runInjectedDocEditor(
      '<main data-ark-id="s1" data-ark-author="claude">' +
        '<table data-ark-id="s1-t1">' +
        '<tr data-ark-id="s1-t1-r1">' +
        '<td data-ark-id="s1-t1-r1-c1">x</td>' +
        "</tr>" +
        "</table>" +
        "</main>"
    );
    const { document } = dom.window;
    const root = document.querySelector('[data-ark-id="s1"]') as HTMLElement;
    const table = document.querySelector(
      '[data-ark-id="s1-t1"]'
    ) as HTMLElement;
    const row = document.querySelector(
      '[data-ark-id="s1-t1-r1"]'
    ) as HTMLElement;
    const leaf = document.querySelector(
      '[data-ark-id="s1-t1-r1-c1"]'
    ) as HTMLElement;

    expect(leaf.contentEditable).toBe("true");
    expect(root.contentEditable).not.toBe("true");
    expect(table.contentEditable).not.toBe("true");
    expect(row.contentEditable).not.toBe("true");

    leaf.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    expect(leaf.getAttribute("data-ark-author")).toBe("human");
    expect(root.getAttribute("data-ark-author")).toBe("claude");
    expect(table.hasAttribute("data-ark-author")).toBe(false);
    expect(row.hasAttribute("data-ark-author")).toBe(false);
  });
});

describe("DOC_EDITOR_LAYER の貼り付け・ドロップ処理", () => {
  it("貼り付けは inline style 等を持ち込まず plain text だけを挿入する（execCommand が使える場合）", () => {
    const dom = runInjectedDocEditor('<p data-ark-id="p1">x</p>');
    const { document } = dom.window;
    const leaf = document.querySelector('[data-ark-id="p1"]') as HTMLElement;
    const execCommand = vi.fn().mockReturnValue(true);
    // jsdom は execCommand を実装していない（本番のブラウザには存在する）
    // biome-ignore lint/suspicious/noExplicitAny: jsdom Document 型に無いテスト用スタブ
    (document as any).execCommand = execCommand;

    const pasteEvent = new dom.window.Event("paste", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: { getData: () => "plain pasted text" },
    });
    leaf.dispatchEvent(pasteEvent);

    expect(pasteEvent.defaultPrevented).toBe(true);
    expect(execCommand).toHaveBeenCalledWith(
      "insertText",
      false,
      "plain pasted text"
    );
  });

  it("execCommand が false を返す/例外を投げるときは Selection API で直接挿入する", () => {
    const dom = runInjectedDocEditor('<p data-ark-id="p1">before</p>');
    const { document } = dom.window;
    const leaf = document.querySelector('[data-ark-id="p1"]') as HTMLElement;
    // biome-ignore lint/suspicious/noExplicitAny: jsdom Document 型に無いテスト用スタブ
    (document as any).execCommand = vi.fn().mockReturnValue(false);

    const textNode = leaf.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, textNode.textContent?.length ?? 0);
    range.setEnd(textNode, textNode.textContent?.length ?? 0);
    const selection = dom.window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const pasteEvent = new dom.window.Event("paste", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: { getData: () => "PASTED" },
    });
    leaf.dispatchEvent(pasteEvent);

    expect(leaf.textContent).toBe("beforePASTED");
    // execCommand 経由なら実ブラウザが input イベントを自動発火して human 印と
    // dirty が付くが、Selection API フォールバックはプログラムによる DOM 操作で
    // input イベントが発火しないため、ハンドラ側が明示的に付ける必要がある。
    expect(leaf.getAttribute("data-ark-author")).toBe("human");
    expect(
      document.getElementById("ark-doc-bar")?.getAttribute("data-visible")
    ).toBe("true");
  });

  it("Selection API フォールバックも失敗したときは human 印を付けず dirty にもしない", () => {
    const dom = runInjectedDocEditor('<p data-ark-id="p1">before</p>');
    const { document } = dom.window;
    const leaf = document.querySelector('[data-ark-id="p1"]') as HTMLElement;
    // biome-ignore lint/suspicious/noExplicitAny: jsdom Document 型に無いテスト用スタブ
    (document as any).execCommand = vi.fn().mockReturnValue(false);
    // Selection が無い状態（rangeCount === 0）を作る
    dom.window.getSelection()?.removeAllRanges();

    const pasteEvent = new dom.window.Event("paste", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: { getData: () => "PASTED" },
    });
    leaf.dispatchEvent(pasteEvent);

    expect(leaf.textContent).toBe("before");
    expect(leaf.hasAttribute("data-ark-author")).toBe(false);
    expect(
      document.getElementById("ark-doc-bar")?.getAttribute("data-visible")
    ).toBe("false");
  });

  it("ドロップの Selection API フォールバックが成功したときも human 印と dirty を付ける", () => {
    const dom = runInjectedDocEditor('<p data-ark-id="p1">before</p>');
    const { document } = dom.window;
    const leaf = document.querySelector('[data-ark-id="p1"]') as HTMLElement;
    // biome-ignore lint/suspicious/noExplicitAny: jsdom Document 型に無いテスト用スタブ
    (document as any).execCommand = vi.fn().mockReturnValue(false);

    const textNode = leaf.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, textNode.textContent?.length ?? 0);
    range.setEnd(textNode, textNode.textContent?.length ?? 0);
    const selection = dom.window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const dropEvent = new dom.window.Event("drop", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: { getData: () => "DROPPED" },
    });
    leaf.dispatchEvent(dropEvent);

    expect(leaf.textContent).toBe("beforeDROPPED");
    expect(leaf.getAttribute("data-ark-author")).toBe("human");
    expect(
      document.getElementById("ark-doc-bar")?.getAttribute("data-visible")
    ).toBe("true");
  });

  it("ドロップも paste と同じく inline style 等を持ち込まず plain text だけを挿入する", () => {
    const dom = runInjectedDocEditor('<p data-ark-id="p1">x</p>');
    const { document } = dom.window;
    const leaf = document.querySelector('[data-ark-id="p1"]') as HTMLElement;
    const execCommand = vi.fn().mockReturnValue(true);
    // biome-ignore lint/suspicious/noExplicitAny: jsdom Document 型に無いテスト用スタブ
    (document as any).execCommand = execCommand;

    const dropEvent = new dom.window.Event("drop", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: { getData: () => "dropped text" },
    });
    leaf.dispatchEvent(dropEvent);

    expect(dropEvent.defaultPrevented).toBe(true);
    expect(execCommand).toHaveBeenCalledWith(
      "insertText",
      false,
      "dropped text"
    );
  });
});

describe("writeModel() の < エスケープ", () => {
  it("本文に </script> を打っても、送信 HTML のモデル script が途中で閉じない", () => {
    // label を持たない node にする（syncModelNodes は label が既にある node を
    // 上書きしないため、label 無しか minted id でないと本文の変更が model へ
    // 反映されない）。
    const dom = runInjectedDocEditor(
      '<script type="application/json" id="ark-diagram-model">' +
        '{"version":1,"type":"doc","nodes":[{"id":"p1"}],"edges":[],"groups":[]}' +
        "</script>" +
        '<p data-ark-id="p1">x</p>'
    );
    const { window } = dom;
    const { document } = window;
    const leaf = document.querySelector('[data-ark-id="p1"]') as HTMLElement;

    // </script> と新しい <script> をまたぐ生の文字列を本文へ打ち込む
    // （貼り付け・入力どちらでも起こり得る）
    leaf.textContent = "abc</script><script>evil()</script>";
    leaf.dispatchEvent(new window.Event("input", { bubbles: true }));

    const fakePort = { start: vi.fn(), postMessage: vi.fn() };
    const initEvent = new window.MessageEvent("message", {
      data: { type: "ark:diagram-init" },
    });
    Object.defineProperty(initEvent, "ports", { value: [fakePort] });
    window.dispatchEvent(initEvent);

    const submitButton = document.querySelector(
      "#ark-doc-bar button"
    ) as HTMLElement;
    submitButton.dispatchEvent(new window.Event("click", { bubbles: true }));

    const message = fakePort.postMessage.mock.calls[0]?.[0] as {
      html: string;
    };

    // 送信 HTML を実際に HTML パーサーへ通す。モデル script が本文中の
    // </script> で早期に閉じていれば、本文の <script>evil()</script> が
    // 本物の2個目の script 要素として生まれてしまう。
    const reparsed = new JSDOM(message.html);
    const scripts = reparsed.window.document.querySelectorAll("script");
    expect(scripts.length).toBe(1);

    const modelText =
      reparsed.window.document.getElementById("ark-diagram-model")?.textContent;
    expect(() => JSON.parse(modelText ?? "")).not.toThrow();
    const model = JSON.parse(modelText ?? "null");
    expect(model.nodes[0].label).toBe("abc</script><script>evil()</script>");
  });
});

describe("submissionHtml() の焼き付き防止（実際の submit 経路で検証）", () => {
  it("著者バッジ・引用ハイライト・選択中クラス・CSP meta・contenteditable・wired 印を1つも残さず、本文は保持する", () => {
    const dom = runInjectedDocEditor(
      '<script type="application/json" id="ark-diagram-model">' +
        '{"version":1,"nodes":[{"id":"p1"}]}' +
        "</script>" +
        '<p data-ark-id="p1" class="ark-comment-anchor-active">' +
        '<span class="ark-author-badge" data-ark-harness-ui="1" data-author="claude">Claude</span>' +
        "見出しの" +
        '<span class="ark-comment-highlight" data-thread-id="t1" data-ark-comment-owned="true" data-active="false">本文</span>' +
        "です</p>",
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">'
    );
    const { window } = dom;
    const { document } = window;

    const fakePort = { start: vi.fn(), postMessage: vi.fn() };
    const initEvent = new window.MessageEvent("message", {
      data: { type: "ark:diagram-init" },
    });
    Object.defineProperty(initEvent, "ports", { value: [fakePort] });
    window.dispatchEvent(initEvent);

    const submitButton = document.querySelector(
      "#ark-doc-bar button"
    ) as HTMLElement;
    submitButton.dispatchEvent(new window.Event("click", { bubbles: true }));

    expect(fakePort.postMessage).toHaveBeenCalledTimes(1);
    const message = fakePort.postMessage.mock.calls[0]?.[0] as {
      type: string;
      html: string;
    };
    expect(message.type).toBe("ark:diagram-submit");
    const html = message.html;

    expect(html).not.toContain("ark-author-badge");
    expect(html).not.toContain("ark-comment-highlight");
    expect(html).not.toContain("data-ark-comment-owned");
    expect(html).not.toContain("ark-comment-anchor-active");
    expect(html).not.toContain("contenteditable");
    expect(html).not.toContain("data-ark-doc-wired");
    expect(html).not.toContain("data-ark-harness-ui");
    expect(html).not.toContain(DIAGRAM_DOC_EDITOR_MARKER);
    expect(html).not.toMatch(/<meta[^>]+Content-Security-Policy/i);
    expect(html).not.toMatch(/class=""/);

    // ハイライト span を剥がすときに中身ごと落としていないか
    expect(html).toContain("見出しの本文です");
  });
});

/** 実物のボードと同じ入れ子構造（コンテナ node + 無印の見出し・セル）。 */
const NESTED_DOC_BODY =
  '<script type="application/json" id="ark-diagram-model">' +
  JSON.stringify({
    version: 1,
    type: "doc",
    title: "受注フロー 設計",
    nodes: [
      { id: "s1", label: "文書全体", kind: "section" },
      { id: "s1-p1", label: "導入の段落", kind: "paragraph" },
      { id: "s1-t1", label: "処理手順の表", kind: "table" },
      { id: "s1-t1-r1", label: "受付の行", kind: "table-row" },
    ],
    edges: [],
    groups: [
      { id: "g1", label: "全体", nodes: ["s1", "s1-p1"] },
      { id: "g2", label: "手順", nodes: ["s1-t1", "s1-t1-r1"] },
    ],
  }) +
  "</script>" +
  '<main data-ark-id="s1" data-ark-author="claude">' +
  '<p class="eyebrow">ORDER FLOW</p>' +
  "<h1>受注フロー 設計</h1>" +
  '<p class="lead" data-ark-id="s1-p1" data-ark-author="claude">導入の段落</p>' +
  '<table data-ark-id="s1-t1" data-ark-author="claude"><tbody>' +
  '<tr data-ark-id="s1-t1-r1" data-ark-author="claude">' +
  "<td>受付</td><td>依頼内容を記録する</td>" +
  "</tr>" +
  "</tbody></table>" +
  "</main>";

function readModelOf(dom: JSDOM) {
  const text =
    dom.window.document.getElementById("ark-diagram-model")?.textContent;
  return JSON.parse(text ?? "null");
}

function pressEnter(dom: JSDOM, target: Element, init: KeyboardEventInit = {}) {
  const event = new dom.window.KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

/** キャレットを collapsed でテキストノードの途中（または末尾）に置く。 */
function placeCaret(dom: JSDOM, node: Node, offset: number) {
  const range = dom.window.document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = dom.window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe("syncModelNodes の DOM と model の突き合わせ", () => {
  it("入れ子のコンテナ node（葉でない）と groups の参照を消さない", () => {
    const dom = runInjectedDocEditor(NESTED_DOC_BODY);
    dom.window.document.dispatchEvent(
      new dom.window.Event("ark:doc-sync", { bubbles: false })
    );

    const model = readModelOf(dom);
    expect(model.nodes.map((n: { id: string }) => n.id)).toEqual([
      "s1",
      "s1-p1",
      "s1-t1",
      "s1-t1-r1",
    ]);
    expect(model.groups[0].nodes).toEqual(["s1", "s1-p1"]);
    expect(model.groups[1].nodes).toEqual(["s1-t1", "s1-t1-r1"]);
  });

  it("本文の無印要素（見出し・セル）へ勝手に data-ark-id を振らない", () => {
    const dom = runInjectedDocEditor(NESTED_DOC_BODY);
    const before = dom.window.document.querySelectorAll("[data-ark-id]").length;
    dom.window.document.dispatchEvent(new dom.window.Event("ark:doc-sync"));

    expect(dom.window.document.querySelectorAll("[data-ark-id]").length).toBe(
      before
    );
    expect(
      dom.window.document.querySelector("h1")?.hasAttribute("data-ark-id")
    ).toBe(false);
    expect(
      dom.window.document.querySelector("td")?.hasAttribute("data-ark-id")
    ).toBe(false);
    expect(readModelOf(dom).nodes).toHaveLength(4);
  });

  it("重複した data-ark-id からは node を1個だけ作る（先勝ち）", () => {
    // DOM に同じ id が2個ある時点で validateDiagramDocAnchors が
    // 「1個必要です（2個）」で保存を弾くので、どのみち保存は通らない。
    // ここで守るのは model 側で、node を2個作ると id 重複で parseDiagramModel が
    // 落ち、422 の理由が本当の原因（本文の重複）から逸れること。
    // 取り方は extractDocBlocks（還流側）と揃えて先勝ちにする。
    const dom = runInjectedDocEditor(NESTED_DOC_BODY);
    const duplicated = dom.window.document.createElement("p");
    duplicated.setAttribute("data-ark-id", "s1-p1");
    duplicated.textContent = "複製";
    dom.window.document
      .querySelector('[data-ark-id="s1"]')
      ?.appendChild(duplicated);
    dom.window.document.dispatchEvent(new dom.window.Event("ark:doc-sync"));

    const ids = readModelOf(dom).nodes.map((n: { id: string }) => n.id);
    expect(ids).toEqual(["s1", "s1-p1", "s1-t1", "s1-t1-r1"]);
  });

  it("DOM から消えたブロックの model node と groups の参照を落とす", () => {
    const dom = runInjectedDocEditor(NESTED_DOC_BODY);
    dom.window.document.querySelector('[data-ark-id="s1-t1-r1"]')?.remove();
    dom.window.document.dispatchEvent(new dom.window.Event("ark:doc-sync"));

    const model = readModelOf(dom);
    expect(model.nodes.map((n: { id: string }) => n.id)).toEqual([
      "s1",
      "s1-p1",
      "s1-t1",
    ]);
    expect(model.groups[1].nodes).toEqual(["s1-t1"]);
  });
});

describe("葉ブロックでの Enter による段落追加", () => {
  it("同じタグの兄弟ブロックを作り、id と human 印を付け、model node を増やす", () => {
    const dom = runInjectedDocEditor(NESTED_DOC_BODY);
    const leaf = dom.window.document.querySelector(
      '[data-ark-id="s1-p1"]'
    ) as HTMLElement;
    placeCaret(dom, leaf.firstChild as Text, leaf.textContent?.length ?? 0);

    const event = pressEnter(dom, leaf);

    expect(event.defaultPrevented).toBe(true);
    const next = leaf.nextElementSibling as HTMLElement;
    expect(next.tagName).toBe("P");
    expect(next.className).toBe("lead");
    const newId = next.getAttribute("data-ark-id");
    expect(newId).toBeTruthy();
    expect(newId).not.toBe("s1-p1");
    expect(next.getAttribute("data-ark-author")).toBe("human");
    expect(next.contentEditable).toBe("true");
    // 末尾での Enter は元ブロックの本文を1文字も動かさないので、書き手は Claude のまま。
    // Range.extractContents は末尾でも空の Text を1個返すため、断片の
    // childNodes の数で「動いた」と判定すると、ここが human に化ける。
    expect(leaf.textContent).toBe("導入の段落");
    expect(leaf.getAttribute("data-ark-author")).toBe("claude");

    const model = readModelOf(dom);
    expect(model.nodes).toHaveLength(5);
    expect(model.nodes.map((n: { id: string }) => n.id)).toContain(newId);
  });

  it("キャレットが途中にあるときは後ろのテキストを新ブロックへ移し、元ブロックも human にする", () => {
    const dom = runInjectedDocEditor(NESTED_DOC_BODY);
    const leaf = dom.window.document.querySelector(
      '[data-ark-id="s1-p1"]'
    ) as HTMLElement;
    placeCaret(dom, leaf.firstChild as Text, 2);

    pressEnter(dom, leaf);

    expect(leaf.textContent).toBe("導入");
    expect((leaf.nextElementSibling as HTMLElement).textContent).toBe("の段落");
    expect(leaf.getAttribute("data-ark-author")).toBe("human");
  });

  it("ブロック先頭での Enter は上に空行を足すだけで、本文を別 id へ移さない", () => {
    // 先頭で分割すると本文が丸ごと新しい id の human ブロックへ移り、1文字も
    // 書き換えていない段落が人間の決定として読まれる上、その id に付いていた
    // コメントの anchor も外れる。
    const dom = runInjectedDocEditor(NESTED_DOC_BODY);
    const leaf = dom.window.document.querySelector(
      '[data-ark-id="s1-p1"]'
    ) as HTMLElement;
    placeCaret(dom, leaf.firstChild as Text, 0);

    pressEnter(dom, leaf);

    expect(leaf.textContent).toBe("導入の段落");
    expect(leaf.getAttribute("data-ark-id")).toBe("s1-p1");
    expect(leaf.getAttribute("data-ark-author")).toBe("claude");

    const added = leaf.previousElementSibling as HTMLElement;
    expect(added.getAttribute("data-ark-author")).toBe("human");
    expect(added.textContent).toBe("");

    expect(readModelOf(dom).nodes.map((n: { id: string }) => n.id)).toEqual([
      "s1",
      added.getAttribute("data-ark-id"),
      "s1-p1",
      "s1-t1",
      "s1-t1-r1",
    ]);
  });

  it("先頭に著者バッジがあっても、その直後の Enter は先頭とみなす", () => {
    const dom = runInjectedDocEditor(NESTED_DOC_BODY);
    const leaf = dom.window.document.querySelector(
      '[data-ark-id="s1-p1"]'
    ) as HTMLElement;
    const badge = dom.window.document.createElement("span");
    badge.setAttribute("data-ark-harness-ui", "1");
    badge.textContent = "Claude";
    leaf.insertBefore(badge, leaf.firstChild);
    placeCaret(dom, leaf.lastChild as Text, 0);

    pressEnter(dom, leaf);

    expect(leaf.textContent).toBe("Claude導入の段落");
    expect(leaf.getAttribute("data-ark-author")).toBe("claude");
    expect(
      (leaf.previousElementSibling as HTMLElement).getAttribute(
        "data-ark-author"
      )
    ).toBe("human");
  });

  it("キャレットを新しいブロックの先頭へ移す", () => {
    const dom = runInjectedDocEditor(NESTED_DOC_BODY);
    const leaf = dom.window.document.querySelector(
      '[data-ark-id="s1-p1"]'
    ) as HTMLElement;
    placeCaret(dom, leaf.firstChild as Text, leaf.textContent?.length ?? 0);

    pressEnter(dom, leaf);

    const next = leaf.nextElementSibling as HTMLElement;
    const selection = dom.window.getSelection();
    expect(
      selection?.anchorNode === next ||
        next.contains(selection?.anchorNode ?? null)
    ).toBe(true);
    expect(selection?.anchorOffset).toBe(0);
  });

  it("キャレット以降が文字の無い要素だけでも、その要素を捨てずに新ブロックへ移す", () => {
    // extractContents は判定の前に DOM から中身を取り出してしまうので、「動いて
    // いない」と判断した断片を捨てると本文が消える。Shift+Enter で入れた <br> の
    // 手前で Enter を押す経路がこれに当たる。
    const dom = runInjectedDocEditor(NESTED_DOC_BODY);
    const leaf = dom.window.document.querySelector(
      '[data-ark-id="s1-p1"]'
    ) as HTMLElement;
    leaf.appendChild(dom.window.document.createElement("br"));
    placeCaret(
      dom,
      leaf.firstChild as Text,
      leaf.firstChild?.textContent?.length ?? 0
    );

    pressEnter(dom, leaf);

    const next = leaf.nextElementSibling as HTMLElement;
    expect(next.querySelector("br")).not.toBeNull();
    expect(leaf.querySelector("br")).toBeNull();
    expect(leaf.textContent).toBe("導入の段落");
    // 本文（<br>）が実際に移ったので、元ブロックも人間が触ったものになる
    expect(leaf.getAttribute("data-ark-author")).toBe("human");
  });

  it("採番した id は既存の data-ark-id と衝突しない", () => {
    const dom = runInjectedDocEditor(NESTED_DOC_BODY);
    // 注入 script と同じ realm の Date を固定し、先に同じ形の id を占有させる
    const fixed = 1_700_000_000_000;
    dom.window.Date.now = () => fixed;
    const taken = dom.window.document.createElement("p");
    taken.setAttribute("data-ark-id", `h${fixed.toString(36)}-1`);
    taken.setAttribute("data-ark-author", "human");
    dom.window.document.querySelector('[data-ark-id="s1"]')?.appendChild(taken);

    const leaf = dom.window.document.querySelector(
      '[data-ark-id="s1-p1"]'
    ) as HTMLElement;
    placeCaret(dom, leaf.firstChild as Text, leaf.textContent?.length ?? 0);
    pressEnter(dom, leaf);

    const minted = (leaf.nextElementSibling as HTMLElement).getAttribute(
      "data-ark-id"
    );
    expect(minted).toMatch(/^h[0-9a-z]+-[0-9]+$/);
    expect(minted).not.toBe(`h${fixed.toString(36)}-1`);
    const ids = Array.from(
      dom.window.document.querySelectorAll("[data-ark-id]")
    ).map(el => el.getAttribute("data-ark-id"));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("採番した id は model にだけ在る node id とも衝突しない", () => {
    const dom = runInjectedDocEditor(NESTED_DOC_BODY);
    const fixed = 1_700_000_000_000;
    dom.window.Date.now = () => fixed;
    // DOM には無いが model には在る id（別セッションが消したブロックの残り等）
    const model = readModelOf(dom);
    model.nodes.push({ id: `h${fixed.toString(36)}-1`, label: "残り" });
    const script = dom.window.document.getElementById("ark-diagram-model");
    if (script) script.textContent = JSON.stringify(model);

    const leaf = dom.window.document.querySelector(
      '[data-ark-id="s1-p1"]'
    ) as HTMLElement;
    placeCaret(dom, leaf.firstChild as Text, leaf.textContent?.length ?? 0);
    pressEnter(dom, leaf);

    expect(
      (leaf.nextElementSibling as HTMLElement).getAttribute("data-ark-id")
    ).toBe(`h${fixed.toString(36)}-2`);
  });

  it("IME 変換確定の Enter ではブロックを分割しない", () => {
    const dom = runInjectedDocEditor(NESTED_DOC_BODY);
    const leaf = dom.window.document.querySelector(
      '[data-ark-id="s1-p1"]'
    ) as HTMLElement;
    placeCaret(dom, leaf.firstChild as Text, 2);

    const event = pressEnter(dom, leaf, { isComposing: true });

    expect(event.defaultPrevented).toBe(false);
    expect(leaf.nextElementSibling?.getAttribute("data-ark-id")).toBe("s1-t1");
    expect(readModelOf(dom).nodes).toHaveLength(4);
  });

  it("Shift+Enter は既定の改行のままブロックを分割しない", () => {
    const dom = runInjectedDocEditor(NESTED_DOC_BODY);
    const leaf = dom.window.document.querySelector(
      '[data-ark-id="s1-p1"]'
    ) as HTMLElement;
    placeCaret(dom, leaf.firstChild as Text, 2);

    const event = pressEnter(dom, leaf, { shiftKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(readModelOf(dom).nodes).toHaveLength(4);
  });

  it("label は空白の連なりを1つに畳むだけで、本文の文字は削らない", () => {
    // 注入 script はテンプレートリテラルの中に書くので、\\s と書かないと配信物では
    // /s+/g になり、label から "s" の連なりが消える。
    const dom = runInjectedDocEditor(NESTED_DOC_BODY);
    const leaf = dom.window.document.querySelector(
      '[data-ark-id="s1-p1"]'
    ) as HTMLElement;
    placeCaret(dom, leaf.firstChild as Text, leaf.textContent?.length ?? 0);
    pressEnter(dom, leaf);

    const next = leaf.nextElementSibling as HTMLElement;
    next.textContent = "sss   分割\nした";
    dom.window.document.dispatchEvent(new dom.window.Event("ark:doc-sync"));

    const added = readModelOf(dom).nodes.find(
      (n: { id: string }) => n.id === next.getAttribute("data-ark-id")
    );
    expect(added.label).toBe("sss 分割 した");
  });

  it("注入 UI（著者バッジ）の文字を新しい node の label に混ぜない", () => {
    const dom = runInjectedDocEditor(NESTED_DOC_BODY);
    const leaf = dom.window.document.querySelector(
      '[data-ark-id="s1-p1"]'
    ) as HTMLElement;
    placeCaret(dom, leaf.firstChild as Text, 2);
    pressEnter(dom, leaf);

    const next = leaf.nextElementSibling as HTMLElement;
    const badge = dom.window.document.createElement("span");
    badge.setAttribute("data-ark-harness-ui", "1");
    badge.textContent = "人間";
    next.insertBefore(badge, next.firstChild);
    dom.window.document.dispatchEvent(new dom.window.Event("ark:doc-sync"));

    const model = readModelOf(dom);
    const added = model.nodes.find(
      (n: { id: string }) => n.id === next.getAttribute("data-ark-id")
    );
    expect(added.label).toBe("の段落");
  });
});

describe("編集後の成果物が保存側の検査を通る", () => {
  it("段落追加とブロック削除の後も data-ark-id と model node が1対1を保つ", () => {
    const dom = runInjectedDocEditor(NESTED_DOC_BODY);
    const { window } = dom;
    const { document } = window;

    const fakePort = { start: vi.fn(), postMessage: vi.fn() };
    const initEvent = new window.MessageEvent("message", {
      data: { type: "ark:diagram-init" },
    });
    Object.defineProperty(initEvent, "ports", { value: [fakePort] });
    window.dispatchEvent(initEvent);

    const leaf = document.querySelector('[data-ark-id="s1-p1"]') as HTMLElement;
    placeCaret(dom, leaf.firstChild as Text, 2);
    pressEnter(dom, leaf);
    document.querySelector('[data-ark-id="s1-t1-r1"]')?.remove();
    document.dispatchEvent(new window.Event("ark:doc-sync"));

    (
      document.querySelector("#ark-doc-bar button") as HTMLElement
    ).dispatchEvent(new window.Event("click", { bubbles: true }));
    const message = fakePort.postMessage.mock.calls.at(-1)?.[0] as {
      html: string;
      model: DiagramModel;
    };

    expect(validateDiagramDocAnchors(message.html, message.model)).toEqual({
      ok: true,
    });
    expect(validateDiagramDocAuthorship(message.html, message.model)).toEqual({
      ok: true,
    });
  });
});

const EXAMPLE_DOC_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../.claude/diagrams/_examples/order-flow-design.diagram.html"
);

describe("実物の doc ボードでの編集", () => {
  it("段落追加と行削除の後も1対1と authorship を保ち、コンテナ node を落とさない", () => {
    const dom = runInjectedDocEditorOnPage(
      fs.readFileSync(EXAMPLE_DOC_PATH, "utf-8")
    );
    const { window } = dom;
    const { document } = window;

    const fakePort = { start: vi.fn(), postMessage: vi.fn() };
    const initEvent = new window.MessageEvent("message", {
      data: { type: "ark:diagram-init" },
    });
    Object.defineProperty(initEvent, "ports", { value: [fakePort] });
    window.dispatchEvent(initEvent);

    const lead = document.querySelector('[data-ark-id="s1-p1"]') as HTMLElement;
    placeCaret(dom, lead.firstChild as Text, 6);
    pressEnter(dom, lead);
    document.querySelector('[data-ark-id="s1-t1-r2"]')?.remove();
    document.dispatchEvent(new window.Event("ark:doc-sync"));

    (
      document.querySelector("#ark-doc-bar button") as HTMLElement
    ).dispatchEvent(new window.Event("click", { bubbles: true }));
    const message = fakePort.postMessage.mock.calls.at(-1)?.[0] as {
      html: string;
      model: DiagramModel;
    };

    expect(validateDiagramDocAnchors(message.html, message.model)).toEqual({
      ok: true,
    });
    expect(validateDiagramDocAuthorship(message.html, message.model)).toEqual({
      ok: true,
    });

    const ids = message.model.nodes.map(node => node.id);
    // 葉でないコンテナ（文書全体と表）が残っている
    expect(ids).toContain("s1");
    expect(ids).toContain("s1-t1");
    // 消した行だけが落ちている
    expect(ids).not.toContain("s1-t1-r2");
    for (const group of message.model.groups) {
      expect(group.nodes).not.toContain("s1-t1-r2");
    }
    expect(
      message.model.groups.find(group => group.id === "g-process")?.nodes
    ).toEqual(["s1-t1", "s1-t1-r1", "s1-t1-r3", "s1-t1-r4", "s1-p2"]);
  });
});
