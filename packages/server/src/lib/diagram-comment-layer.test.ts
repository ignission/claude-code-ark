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

  it("DOM API だけで浮遊 card・selection composer を構築する", () => {
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
    expect(injected).toContain("Math.max(baseTop,previousBottom+CARD_GAP)");
    expect(injected).toContain(
      'setAttribute("data-anchor-id",thread.anchorId)'
    );
    expect(injected).toContain(".ark-comment-card{position:fixed");
  });

  it("狭幅の展開 panel を anchor の下へ置き、入らなければ上へ回して重なりを避ける", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const positionCards = injected.slice(
      injected.indexOf("function positionCards()"),
      injected.indexOf("function refreshLayout()")
    );

    expect(positionCards).toContain("narrow&&");
    expect(positionCards).toContain("ark-comment-composer");
    expect(positionCards).toContain('getAttribute("data-collapsed")==="false"');
    expect(positionCards).toContain("var belowTop=rect.bottom+CARD_GAP");
    expect(positionCards).toContain(
      "var aboveTop=rect.top-cardHeight-CARD_GAP"
    );
    expect(positionCards).toContain("if(belowTop+cardHeight<=viewportBottom)");
    expect(positionCards).toContain("else if(aboveTop>=viewportTop)");
    expect(positionCards).toContain(
      "Math.max(baseTop,previousBottom+CARD_GAP)"
    );
  });

  it("block hover の＋導線・最内側 anchor 解決・close 遅延を含まない", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    for (const removedContract of [
      "ark-comment-add",
      "function positionAddButtons()",
      'document.addEventListener("mouseover"',
      'event.target.closest("[data-ark-id]")',
      "function showAdd(entry)",
      "function scheduleAddClose()",
      "AFFORDANCE_CLOSE_DELAY",
    ]) {
      expect(injected).not.toContain(removedContract);
    }
  });

  it("本文の padding を変更せず、実測した右側の空き幅で badge 表示を切り替える", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const updateLayout = injected.slice(
      injected.indexOf("function updateLayout()"),
      injected.indexOf("function clearHighlights()")
    );
    const positionCards = injected.slice(
      injected.indexOf("function positionCards()"),
      injected.indexOf("function refreshLayout()")
    );

    expect(injected).not.toContain("MIN_CONTENT_WIDTH");
    expect(injected).not.toContain("originalBodyPaddingRight");
    expect(injected).not.toContain("originalComputedPaddingRight");
    expect(injected).not.toContain("document.body.style.paddingRight=");
    expect(injected).toContain("var contentRight=null");
    expect(updateLayout).not.toContain(
      'document.querySelectorAll("[data-ark-id]")'
    );
    expect(updateLayout).toContain("anchors.forEach(function(entry)");
    expect(updateLayout).toContain(
      "entry.anchor.getBoundingClientRect().right"
    );
    expect(injected).toContain("Math.max(contentRight,anchorRight)");
    expect(injected).toContain(
      "document.documentElement.clientWidth-contentRight"
    );
    expect(injected).toContain("CARD_WIDTH+RAIL_GAP*2");
    expect(injected).toContain("contentRight===null");
    expect(positionCards).not.toContain("updateLayout()");
    expect(updateLayout).toContain(
      "横方向の空き幅はレイアウト更新時だけ測り、スクロールでは測らない。"
    );
    expect(injected).toContain(
      'setAttribute("data-narrow",narrow?"true":"false")'
    );
    expect(injected).toContain(
      'card.setAttribute("data-collapsed",expandedThreadIds.has(thread.id)?"false":"true")'
    );
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

  it("card と composer の操作ボタンを折り返し可能な専用コンテナで整列する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected.match(/"ark-comment-actions"/gu)).toHaveLength(2);
    expect(injected).toContain(
      ".ark-comment-actions{display:flex;gap:8px;align-items:stretch;flex-wrap:wrap;margin-top:8px}"
    );
    expect(injected).toContain("actions.appendChild(sendButton)");
    expect(injected).toContain("actions.appendChild(resolveButton)");
    expect(injected).toContain("actions.appendChild(deleteButton)");
    expect(injected).toContain("composerActions.appendChild(createButton)");
  });

  it("open card だけにメッセージ列と actions の間の返信 UI を描画する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const threadRenderer = injected.slice(
      injected.indexOf("function renderThread"),
      injected.indexOf("function renderComposer")
    );

    expect(threadRenderer).toContain('if(thread.status==="open"){');
    expect(threadRenderer).toContain(
      'element("textarea",undefined,"ark-comment-input")'
    );
    expect(threadRenderer).toContain(
      'element("button","返信","ark-comment-reply")'
    );
    expect(threadRenderer).toContain(
      'send("ark:diagram-comment-reply",{threadId:thread.id,body:replyInput.value})'
    );
    expect(threadRenderer.indexOf("replyInput")).toBeLessThan(
      threadRenderer.indexOf(
        'var actions=element("div",undefined,"ark-comment-actions")'
      )
    );
  });

  it("card の展開状態を集合から復元し、選択された thread も集合へ追加する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const threadRenderer = injected.slice(
      injected.indexOf("function renderThread"),
      injected.indexOf("function renderComposer")
    );
    const activateThread = injected.slice(
      injected.indexOf("function activateThread"),
      injected.indexOf("function wrapThreadQuote")
    );

    expect(injected).toContain("var expandedThreadIds=new Set()");
    expect(threadRenderer).toContain(
      'card.setAttribute("data-collapsed",expandedThreadIds.has(thread.id)?"false":"true")'
    );
    expect(threadRenderer).not.toContain(
      'card.setAttribute("data-collapsed","true")'
    );
    expect(activateThread).toContain("expandedThreadIds.add(thread.id)");
  });

  it("badge のクリックで thread の展開状態を集合上でトグルする", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const threadRenderer = injected.slice(
      injected.indexOf("function renderThread"),
      injected.indexOf("function renderComposer")
    );

    expect(threadRenderer).toContain(
      "if(expandedThreadIds.has(thread.id))expandedThreadIds.delete(thread.id)"
    );
    expect(threadRenderer).toContain("else expandedThreadIds.add(thread.id)");
    expect(threadRenderer).toContain(
      'card.setAttribute("data-collapsed",expandedThreadIds.has(thread.id)?"false":"true")'
    );
  });

  it("sidecar から消えた thread の展開状態を render 時に掃除する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain("function cleanupExpandedThreads()");
    expect(injected).toContain(
      "var existingThreadIds=new Set(comments.threads.map(function(thread){return thread.id;}))"
    );
    expect(injected).toContain(
      "if(!existingThreadIds.has(threadId))expandedThreadIds.delete(threadId)"
    );
    expect(injected).toContain("cleanupExpandedThreads()");
  });

  it("render 前後でコメント欄 textarea のフォーカスと選択範囲を復元する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const render = injected.slice(
      injected.indexOf("function render(){"),
      injected.indexOf("function commonSelectionAnchor")
    );

    expect(render).toContain("document.activeElement");
    expect(render).toContain("root.contains(activeElement)");
    expect(render).toContain('activeElement.tagName==="TEXTAREA"');
    expect(render).toContain("selectionStart:activeElement.selectionStart");
    expect(render).toContain("selectionEnd:activeElement.selectionEnd");
    expect(render).toContain('activeElement.closest(".ark-comment-card")');
    expect(render).toContain("focusedInput.threadId");
    expect(render).toContain("restoredInput.focus()");
    expect(render).toContain("restoredInput.setSelectionRange(");
  });

  it("返信下書きを thread ごとに render 間で保持し成功時だけ消す", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain("var replyDraftBodies=new Map()");
    expect(injected).toContain(
      "replyDraftBodies.set(thread.id,replyInput.value)"
    );
    expect(injected).toContain(
      'replyInput.value=replyDraftBodies.get(thread.id)||""'
    );
    expect(injected).toContain(
      "replyDraftBodies.delete(completedAction.threadId)"
    );
  });

  it("sidecar 更新通知は pending 中を避けて既存 load を再実行する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain('data.type==="ark:diagram-comments-changed"');
    expect(injected).toContain("if(pendingRequestId)return");
    expect(injected).toContain('send("ark:diagram-comments-load",{})');
  });

  it("時刻は元の ISO 値を datetime に保ち、日本語形式へ短く整形する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain("function formatCommentTime(value)");
    expect(injected).toContain("new Date(value)");
    expect(injected).toContain("if(Number.isNaN(date.getTime()))return value");
    expect(injected).toContain("catch(_error)");
    expect(injected).toContain(
      'date.toLocaleString("ja-JP",{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false})'
    );
    expect(injected).toContain(
      'element("time",formatCommentTime(message.at),"ark-comment-time")'
    );
    expect(injected).toContain('time.setAttribute("datetime",message.at)');
  });

  it("author があるメッセージだけ投稿者を控えめに表示し、代替テキストは出さない", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain("if(message.author)");
    expect(injected).toContain(
      'element("span",message.author,"ark-comment-author")'
    );
    expect(injected).toContain(
      ".ark-comment-state,.ark-comment-time,.ark-comment-author{display:block;color:#64748b;font-size:11px}"
    );
    expect(injected).not.toContain("名無し");
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
      'document.addEventListener("keyup",updateSelectionAdd)',
      "getSelection()",
      "commonAncestorContainer",
      'return commonElement.closest("[data-ark-id]")',
      "ark-comment-selection-add",
      "getRangeAt(0)",
      "getBoundingClientRect()",
      "openComposer(selectionCandidate.anchorId,selectionCandidate.anchorQuote,selectionCandidate.anchorOccurrence)",
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
      'querySelectorAll(".ark-comment-create,.ark-comment-reply,.ark-comment-resolve,.ark-comment-send,.ark-comment-delete,.ark-comment-input")'
    );
    expect(injected).toContain("ark-comment-error");
    expect(injected).toContain("error");
    expect(injected).toContain("ark:diagram-comment-reply");
    expect(injected).not.toContain("orphaned");
  });

  it("2 点タッチだけを既存 pinch deltaY へ変換し、終了時に状態を戻す", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const touchHandlers = injected.slice(
      injected.indexOf("function handleTouchStart"),
      injected.indexOf('window.addEventListener("touchstart"')
    );
    const touchStartHandler = touchHandlers.slice(
      touchHandlers.indexOf("function handleTouchStart"),
      touchHandlers.indexOf("function handleTouchMove")
    );
    const touchMoveHandler = touchHandlers.slice(
      touchHandlers.indexOf("function handleTouchMove")
    );

    expect(injected).toContain('addEventListener("wheel"');
    expect(injected).toContain("ctrlKey");
    expect(injected).toContain('addEventListener("touchstart"');
    expect(injected).toContain('addEventListener("touchmove"');
    expect(injected).toContain('addEventListener("touchend"');
    expect(injected).toContain("touches.length!==2");
    expect(injected).toContain("Math.hypot");
    expect(injected).toContain("Math.log");
    expect(injected).toContain("var deltaY=-400*Math.log");
    expect(injected).toContain("pinchDistance=null");
    expect(touchHandlers.indexOf("touches.length!==2")).toBeLessThan(
      touchHandlers.indexOf("event.preventDefault()")
    );
    for (const handler of [touchStartHandler, touchMoveHandler]) {
      expect(handler).toContain("if(!port){resetTouchPinch();return;}");
      expect(handler.indexOf("if(!port)")).toBeLessThan(
        handler.indexOf("event.preventDefault()")
      );
    }
    expect(
      injected.match(/\{passive:false\}/gu)?.length
    ).toBeGreaterThanOrEqual(3);
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

  it("pending 中は返信・→ Claude・解決・削除・作成と入力欄をすべて無効化する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain(
      'querySelectorAll(".ark-comment-create,.ark-comment-reply,.ark-comment-resolve,.ark-comment-send,.ark-comment-delete,.ark-comment-input")'
    );
    expect(injected).toContain(
      'control.disabled=Boolean(pendingRequestId)||control.getAttribute("data-sent")==="true"'
    );
  });

  it("未解決・解決済み・アンカー未解決を分岐せず全 card に削除を出す", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const openBlockEnd = injected.indexOf(
      "actions.appendChild(resolveButton);\n    }"
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

  it("render の先頭で削除の確認待ちを解除する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain(
      "function render(){\n    clearDeleteConfirmation();"
    );
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
    const composer = injected.slice(
      injected.indexOf("function renderComposer"),
      injected.indexOf("function updateLayout")
    );

    expect(injected).toContain("bodyInput.value.trim()");
    expect(injected).toContain("コメント本文を入力してください");
    expect(composer).not.toContain("authorInput");
    expect(composer).not.toContain("rememberedAuthor");
    expect(composer).not.toContain("composerDraftAuthor");
    expect(composer).not.toContain("author");
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
