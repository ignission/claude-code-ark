import { describe, expect, it } from "vitest";
import {
  DIAGRAM_COMMENT_LAYER_MARKER,
  injectDiagramCommentLayer,
} from "./diagram-comment-layer.js";

const minimalDoc =
  '<!doctype html><html><head></head><body><p data-ark-id="s1">本文</p></body></html>';

describe("injectDiagramCommentLayer", () => {
  it("</body> 直前へ marker を1回だけ注入する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain(DIAGRAM_COMMENT_LAYER_MARKER);
    expect(injected.indexOf(DIAGRAM_COMMENT_LAYER_MARKER)).toBe(
      injected.lastIndexOf(DIAGRAM_COMMENT_LAYER_MARKER)
    );
    expect(injected.indexOf(DIAGRAM_COMMENT_LAYER_MARKER)).toBeLessThan(
      injected.toLowerCase().lastIndexOf("</body>")
    );
  });

  it("body がなくても末尾へ注入する", () => {
    const html = "<main>文書</main>";

    const injected = injectDiagramCommentLayer(html);

    expect(injected.startsWith(html)).toBe(true);
    expect(injected).toContain(DIAGRAM_COMMENT_LAYER_MARKER);
  });

  it("二重注入しない", () => {
    const once = injectDiagramCommentLayer(minimalDoc);

    expect(injectDiagramCommentLayer(once)).toBe(once);
  });

  it("ark:diagram-init の transferred port で load/result を相関する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain("ark:diagram-init");
    expect(injected).toContain("event.ports[0]");
    expect(injected).toContain("ark:diagram-comments-load");
    expect(injected).toContain("ark:diagram-comments-result");
    expect(injected).toContain("requestId");
    expect(injected.match(/ark:diagram-init/gu)).toHaveLength(1);
  });

  it("128 KiB 未満で CSP 禁止 token と外部 stylesheet を含まない", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(Buffer.byteLength(injected, "utf8")).toBeLessThan(128 * 1024);
    for (const forbidden of [
      "fetch(",
      "import(",
      "https://",
      "innerHTML",
      "insertAdjacentHTML",
      "@font-face",
      "confirm(",
      "alert(",
    ]) {
      expect(injected).not.toContain(forbidden);
    }
    expect(injected).not.toMatch(
      /<link\b[^>]*rel=["']?stylesheet|@import\s|url\s*\(/iu
    );
  });

  it("DOM API だけで浮遊 card・hover composer を構築する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    for (const contract of [
      "createElement",
      "textContent",
      "setAttribute",
      "appendChild",
      "[data-ark-id]",
      "ResizeObserver",
      "scroll",
      "resize",
    ]) {
      expect(injected).toContain(contract);
    }
  });

  it("常設 panel・見出し・status・全 block の marker を生成しない", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).not.toContain('setAttribute("id","ark-comment-root")');
    expect(injected).not.toContain('element("aside"');
    expect(injected).not.toContain("文書コメント");
    expect(injected).not.toContain("ark-comment-status");
    expect(injected).not.toContain("ark-comment-marker");
  });

  it("thread card を anchor 順に配置し、直前 card との重なりを避ける", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain("function positionCards()");
    expect(injected).toContain("getBoundingClientRect()");
    expect(injected).toContain("anchorTop");
    expect(injected).toContain("previousBottom");
    expect(injected).toContain("CARD_GAP");
    expect(injected).toContain("Math.max(anchorTop,previousBottom+CARD_GAP)");
    expect(injected).toContain(
      'setAttribute("data-anchor-id",thread.anchorId)'
    );
    expect(injected).toContain(".ark-comment-card{position:fixed");
  });

  it("mouseover の最も内側の anchor 1つだけへ新規 comment の＋導線を出す", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain('element("button","＋","ark-comment-add")');
    expect(injected).toContain('document.addEventListener("mouseover"');
    expect(injected).toContain('event.target.closest("[data-ark-id]")');
    expect(injected).toContain("function showAdd(entry)");
    expect(injected).toContain('setAttribute("data-visible","true")');
    expect(injected).toContain("openComposer");
    expect(injected).toContain(".ark-comment-add[data-visible=true]");
  });

  it("＋を anchor に接して配置し、close を遅延して通常のマウス移動を許容する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain("AFFORDANCE_CLOSE_DELAY=120");
    expect(injected).toContain("function scheduleAddClose()");
    expect(injected).toContain("window.setTimeout(function ()");
    expect(injected).toContain("AFFORDANCE_CLOSE_DELAY");
    expect(injected).toContain("rect.right-2");
    expect(injected).not.toContain("rect.right+8");
  });

  it("本文 block を tab 順へ追加せず、＋ button 自身の focus 経路を使う", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).not.toContain("tabindex");
    expect(injected).not.toContain('anchor.addEventListener("keydown"');
    expect(injected).not.toContain('event.key==="Enter"');
    expect(injected).toContain('addButton.addEventListener("focus"');
    expect(injected).toContain(".ark-comment-add:focus");
  });

  it("card がある時だけ右余白を確保し、狭い pane では badge に畳む", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain("MIN_CONTENT_WIDTH=480");
    expect(injected).toContain("originalBodyPaddingRight");
    expect(injected).toContain("document.body.style.paddingRight");
    expect(injected).toContain(
      'setAttribute("data-narrow",narrow?"true":"false")'
    );
    expect(injected).toContain('setAttribute("data-collapsed","true")');
    expect(injected).toContain(
      'element("button",String(openCount),"ark-comment-badge")'
    );
    expect(injected).toContain(".ark-comment-layer[data-narrow=true]");
  });

  it("card と anchor を相互 highlight し、解決済みを控えめに表示する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain("ark-comment-anchor-active");
    expect(injected).toContain('setAttribute("data-active"');
    expect(injected).toContain(
      'card.setAttribute("data-status",thread.status)'
    );
    expect(injected).toContain(".ark-comment-card[data-status=resolved]");
    expect(injected).toContain('thread.status==="open"');
    expect(injected).toContain('element("button","解決する"');
  });

  it("テキスト node を連結して occurrence を解決し、分割 span を再描画前に戻す", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    for (const contract of [
      "function collectTextNodes",
      "NodeFilter.SHOW_TEXT",
      "anchorQuote",
      "anchorOccurrence",
      'element("span",undefined,"ark-comment-highlight")',
      'setAttribute("data-thread-id",thread.id)',
      "function clearHighlights",
      "replaceWith",
      "normalize()",
    ]) {
      expect(injected).toContain(contract);
    }
  });

  it("選択範囲から共通 anchor と occurrence を決めて近くにコメント button を出す", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    for (const contract of [
      "selectionchange",
      "mouseup",
      "keyup",
      "getSelection()",
      "commonAncestorContainer",
      "ark-comment-selection-add",
      "getRangeAt(0)",
      "getBoundingClientRect()",
      "openComposer",
    ]) {
      expect(injected).toContain(contract);
    }
  });

  it("選択 quote を composer に表示して create payload へ渡す", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain("composerAnchorQuote");
    expect(injected).toContain("composerAnchorOccurrence");
    expect(injected).toContain("ark-comment-composer-quote");
    expect(injected).toContain("anchorQuote:composerAnchorQuote");
    expect(injected).toContain("anchorOccurrence:composerAnchorOccurrence");
  });

  it("quote を解決できない thread を捨てずアンカー未解決として表示する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain("アンカー未解決");
    expect(injected).toContain("ark-comment-unresolved-anchor");
    expect(injected).toContain("thread.anchorQuote");
  });

  it("pinch/create/resolve と pending/error 契約を含む", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain("ark:diagram-pinch");
    expect(injected).toContain("ctrlKey");
    expect(injected).toContain("ark:diagram-comment-create");
    expect(injected).toContain("ark:diagram-comment-resolve");
    expect(injected).toContain("pendingRequestId");
    expect(injected).toContain("disabled");
    expect(injected).toContain("function updatePendingControls()");
    expect(injected).toContain(
      'querySelectorAll(".ark-comment-create,.ark-comment-resolve,.ark-comment-send,.ark-comment-delete,.ark-comment-input")'
    );
    expect(injected).toContain("ark-comment-error");
    expect(injected).toContain("error");
    expect(injected).not.toContain("ark:diagram-comment-reply");
    expect(injected).not.toContain("orphaned");
  });

  it("未解決 card だけに → Claude を出し、既存 result 契約で送信済みにする", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain(
      'element("button","→ Claude","ark-comment-send")'
    );
    expect(injected).toContain(
      'send("ark:diagram-comment-send",{threadId:thread.id})'
    );
    expect(injected).toContain("sentThreadIds");
    expect(injected).toContain('sendButton.textContent="送信済み"');
    expect(injected).toContain("sendButton.disabled=true");
    expect(injected.indexOf('if(thread.status==="open"){')).toBeLessThan(
      injected.indexOf('element("button","→ Claude","ark-comment-send")')
    );
    expect(injected).not.toContain("ark:diagram-comment-send-result");
  });

  it("→ Claude を pending controls に含めて二重送信を防ぐ", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain(
      'querySelectorAll(".ark-comment-create,.ark-comment-resolve,.ark-comment-send,.ark-comment-delete,.ark-comment-input")'
    );
  });

  it("未解決・解決済み・アンカー未解決を分岐せず全 card に削除を出す", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const openBlockEnd = injected.indexOf(
      "content.appendChild(resolveButton);\n    }"
    );
    const deleteButton = injected.indexOf(
      'element("button","削除","ark-comment-delete")'
    );

    expect(openBlockEnd).toBeGreaterThan(-1);
    expect(deleteButton).toBeGreaterThan(openBlockEnd);
    expect(injected).toContain(
      'send("ark:diagram-comment-delete",{threadId:thread.id})'
    );
    expect(injected).toContain(
      ".ark-comment-delete{border:0;background:transparent"
    );
  });

  it("削除は単一 card だけを5秒間の2段階確認にし、別 card で解除する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain('deleteButton.textContent="削除する？"');
    expect(injected).toContain("deleteConfirmThreadId===thread.id");
    expect(injected).toContain("clearDeleteConfirmation()");
    expect(injected).toContain("deleteConfirmTimer=window.setTimeout");
    expect(injected).toContain("},5000)");
    expect(injected).not.toContain("confirm(");
  });

  it("port 未接続時は pending にせず操作対象へエラーを表示する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain('message:"コメント機能に接続できていません"');
    expect(injected.indexOf("if(!port){")).toBeLessThan(
      injected.indexOf("pendingRequestId=requestId()")
    );
    expect(injected.indexOf("if(pendingRequestId)return")).toBeLessThan(
      injected.indexOf("if(!port){")
    );
  });

  it("空本文は送信前に拒否し、名前入力と author payload を持たない", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain("bodyInput.value.trim()");
    expect(injected).toContain("コメント本文を入力してください");
    expect(injected).not.toContain("authorInput");
    expect(injected).not.toContain("rememberedAuthor");
    expect(injected).not.toContain("composerDraftAuthor");
    expect(injected).not.toContain("message.author");
    expect(injected).not.toContain("ark-comment-author");
  });

  it("composer の本文だけを render 間で退避・復元し、成功時と閉じる時にクリアする", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain('var composerDraftBody=""');
    expect(injected).toContain("rememberComposerInput(bodyInput.value)");
    expect(injected).toContain("bodyInput.value=composerDraftBody");
    expect(injected).toContain("function clearComposerInputs()");
    expect(injected).toContain(
      'closeButton.addEventListener("click",function(){\n      if(pendingRequestId)return;\n      clearComposerInputs()'
    );
    expect(injected).toContain(
      'completedAction.type==="ark:diagram-comment-create"){\n        clearComposerInputs()'
    );
    expect(injected.match(/clearComposerInputs\(\)/gu)).toHaveLength(4);
  });

  it("15 秒の watchdog で pending を解除し、結果受信時は timer を止める", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain("15000");
    expect(injected).toContain("pendingTimer");
    expect(injected).toContain("応答がありません。もう一度お試しください");
    expect(injected).toContain("window.clearTimeout(pendingTimer)");
    expect(injected).toContain("pendingRequestId=null");
    expect(injected).toContain("updatePendingControls()");
    expect(injected).toContain("data.requestId!==pendingRequestId");
  });
});
