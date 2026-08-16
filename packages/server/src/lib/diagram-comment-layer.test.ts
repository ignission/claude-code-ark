import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  COMMENT_LAYER,
  DIAGRAM_COMMENT_LAYER_MARKER,
  injectDiagramCommentLayer as injectMinifiedCommentLayer,
} from "./diagram-comment-layer.js";

const minimalDoc =
  '<!doctype html><html><head></head><body><p data-ark-id="s1">本文</p></body></html>';
const minimalGraph =
  '<!doctype html><html><head></head><body><article data-model-id="n1"><h2 data-model-id="n1">注文</h2></article></body></html>';

// 部分一致で振る舞いを固定する契約テストは、読みやすいソースを検証する。
const injectDiagramCommentLayer = (_html: string) => COMMENT_LAYER;

type InlineNode = {
  tagName?: string;
  textContent: string;
};

const renderInlineMarkdown = (text: string): InlineNode[] => {
  const inlineRenderer = COMMENT_LAYER.slice(
    COMMENT_LAYER.indexOf("function appendInlineMarkdown"),
    COMMENT_LAYER.indexOf("function renderCommentBody")
  );
  const nodes: InlineNode[] = [];
  const appendInlineMarkdown = runInNewContext(
    `${inlineRenderer};appendInlineMarkdown`,
    {
      document: {
        createTextNode: (textContent: string): InlineNode => ({ textContent }),
      },
      element: (tagName: string, textContent = ""): InlineNode => ({
        tagName,
        textContent,
      }),
    }
  ) as (
    container: { appendChild: (node: InlineNode) => void },
    value: string
  ) => void;

  appendInlineMarkdown(
    {
      appendChild: node => nodes.push(node),
    },
    text
  );
  return nodes;
};

describe("injectDiagramCommentLayer", () => {
  it("</body> 直前へ marker を1回だけ注入する", () => {
    const injected = injectMinifiedCommentLayer(minimalDoc);

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

    const injected = injectMinifiedCommentLayer(html);

    expect(injected.startsWith(html)).toBe(true);
    expect(injected).toContain(DIAGRAM_COMMENT_LAYER_MARKER);
  });

  it("二重注入しない", () => {
    const once = injectMinifiedCommentLayer(minimalDoc);

    expect(injectMinifiedCommentLayer(once)).toBe(once);
  });

  it("保存 HTML に混入した旧 runtime を現行コメント層へ置き換える", () => {
    const persisted = minimalGraph.replace(
      "</body>",
      '<script id="ark-diagram-comment-layer" data-ark-comment-mode="graph">oldLayer()</script><div class="ark-comment-layer"><button class="ark-comment-selection-add"></button></div></body>'
    );

    const recovered = injectMinifiedCommentLayer(persisted, "graph");

    expect(recovered.match(/id="ark-diagram-comment-layer"/gu)).toHaveLength(1);
    expect(recovered).not.toContain("oldLayer()");
    expect(recovered).toContain('data-ark-comment-mode="graph"');
    expect(recovered).toContain('data-ark-harness-ui="1"');
  });

  it("script 属性で doc / graph モードを明示する", () => {
    const injectWithMode = injectMinifiedCommentLayer as (
      html: string,
      mode: "doc" | "graph"
    ) => string;

    expect(injectWithMode(minimalDoc, "doc")).toContain(
      'data-ark-comment-mode="doc"'
    );
    expect(injectWithMode(minimalGraph, "graph")).toContain(
      'data-ark-comment-mode="graph"'
    );
    expect(COMMENT_LAYER).toContain(
      'document.currentScript.getAttribute("data-ark-comment-mode")'
    );
  });

  it("graph は node ID と可視テキストだけで composer と create payload を作る", () => {
    const injected = injectDiagramCommentLayer(minimalGraph);
    const composer = injected.slice(
      injected.indexOf("function renderComposer"),
      injected.indexOf("function updateLayout")
    );

    expect(injected).toContain(
      'graphMode?".ark-harness-graph-node[data-model-id]":"[data-ark-id]"'
    );
    expect(injected).toContain("anchor.innerText");
    expect(injected).toContain("slice(0,256)");
    expect(composer).toContain("graphMode?{");
    expect(composer).toContain("anchorId:anchorId");
    expect(composer).not.toContain("graphMode?{anchorId:anchorId,anchorQuote");
    expect(composer).toContain("entry.anchorText");
  });

  it("graph はテキスト選択と span highlight を動かさず node class を使う", () => {
    const injected = injectDiagramCommentLayer(minimalGraph);

    expect(injected).toContain(
      "if(graphMode)buildGraphSelectionAdd();else buildSelectionAdd()"
    );
    expect(injected).toContain(
      "if(graphMode){renderGraphHighlights();return;}"
    );
    expect(injected).toContain("ark-comment-node-highlight");
  });

  it("graph の node click は drag 距離を検査しイベントを止めない", () => {
    const injected = injectDiagramCommentLayer(minimalGraph);
    const graphSelection = injected.slice(
      injected.indexOf("function buildGraphSelectionAdd"),
      injected.indexOf("function buildAnchors")
    );

    expect(graphSelection).toContain('document.addEventListener("pointerdown"');
    expect(graphSelection).toContain('document.addEventListener("click"');
    expect(graphSelection).toContain("Math.hypot");
    expect(graphSelection).toContain("GRAPH_CLICK_MOVE_LIMIT");
    expect(injected).toContain(
      'target.closest(".ark-harness-graph-node[data-model-id]")'
    );
    expect(graphSelection).not.toContain("preventDefault");
    expect(graphSelection).not.toContain("stopPropagation");
  });

  it("コメント runtime は graph の保存 HTML から除外される", () => {
    const injected = injectDiagramCommentLayer(minimalGraph);

    expect(injected).toContain(
      `<script id="${DIAGRAM_COMMENT_LAYER_MARKER}" data-ark-comment-mode="doc" data-ark-harness-ui="1">`
    );
    expect(injected).toContain('style.setAttribute("data-ark-harness-ui","1")');
    expect(injected).toContain('root.setAttribute("data-ark-harness-ui","1")');
  });

  it("selection button の再構築時は既存 button を除去する", () => {
    const injected = injectDiagramCommentLayer(minimalGraph);
    const createButton = injected.slice(
      injected.indexOf("function createSelectionAddButton"),
      injected.indexOf("function graphAnchorFromTarget")
    );

    expect(createButton).toContain(
      'root.querySelectorAll(".ark-comment-selection-add")'
    );
    expect(createButton).toContain("root.removeChild(button)");
  });

  it("同じ data-model-id が入れ子なら最も外側だけを anchor にする", () => {
    const injected = injectDiagramCommentLayer(minimalGraph);

    expect(injected).toContain("function hasSameIdAncestor(anchor,anchorId)");
    expect(injected).toContain(
      "if(graphMode&&hasSameIdAncestor(anchor,anchorId))return"
    );
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
    expect(injected).toContain(
      ".ark-comment-layer{position:absolute;z-index:2147483000;top:0;left:0;width:100%;height:0"
    );
    expect(injected).toContain(".ark-comment-card{position:absolute");
    expect(injected).toContain(".ark-comment-composer{position:absolute");
    expect(injected).toContain("var anchorTop=rect.top+window.scrollY");
  });

  it("狭幅の展開 panel を文書座標で anchor の下へ置き、重なりを避ける", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const positionCards = injected.slice(
      injected.indexOf("function positionCards()"),
      injected.indexOf("function refreshLayout()")
    );

    expect(positionCards).toContain("narrow&&");
    expect(positionCards).toContain("ark-comment-composer");
    expect(positionCards).toContain('getAttribute("data-collapsed")==="false"');
    expect(positionCards).toContain(
      "baseTop=rect.bottom+window.scrollY+CARD_GAP"
    );
    expect(positionCards).toContain(
      "Math.max(baseTop,previousBottom+CARD_GAP)"
    );
  });

  it("card を viewport にクランプせず、画面外 anchor も表示したままにする", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const positionCards = injected.slice(
      injected.indexOf("function positionCards()"),
      injected.indexOf("function refreshLayout()")
    );

    expect(positionCards).toContain(
      "var cardTop=Math.max(baseTop,previousBottom+CARD_GAP)"
    );
    expect(positionCards).not.toContain("viewportTop");
    expect(positionCards).not.toContain("viewportBottom");
    expect(positionCards).not.toContain("window.innerHeight");
    expect(positionCards).not.toContain('style.display="none"');
    expect(positionCards).not.toContain('style.display=""');
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

  it("本文の padding を変更せず、実測した右側の空き幅で既定の開閉を切り替える", () => {
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
    expect(injected).not.toContain("document.body.style");
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
      'return explicitState?explicitState==="open":!narrow'
    );
    expect(injected).toContain(
      'element("button",String(openCount),"ark-comment-badge")'
    );
    expect(injected).toContain(".ark-comment-layer[data-narrow=true]");
  });

  it("折り畳みの本文・badge CSS をペイン幅に依存させない", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain(
      ".ark-comment-card[data-collapsed=true] .ark-comment-card-content{display:none}"
    );
    expect(injected).toContain(
      ".ark-comment-card[data-collapsed=true] .ark-comment-badge{display:block"
    );
    expect(injected).not.toContain(
      ".ark-comment-layer[data-narrow=true] .ark-comment-card[data-collapsed=true] .ark-comment-card-content"
    );
    expect(injected).not.toContain(
      ".ark-comment-layer[data-narrow=true] .ark-comment-card[data-collapsed=true] .ark-comment-badge"
    );
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

  it("解決済みカードを opacity で半透明にしない", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const resolvedCardStyle = injected.match(
      /\.ark-comment-card\[data-status=resolved\]\{([^}]*)\}/u
    )?.[1];

    expect(resolvedCardStyle).toBeDefined();
    expect(resolvedCardStyle).not.toMatch(/(?:^|;)opacity:/u);
  });

  it("解決済みカードは未解決カードと異なる背景色で区別する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const openCardStyle = injected.match(/\.ark-comment-card\{([^}]*)\}/u)?.[1];
    const resolvedCardStyle = injected.match(
      /\.ark-comment-card\[data-status=resolved\]\{([^}]*)\}/u
    )?.[1];
    const background = (style: string | undefined) =>
      style?.match(/(?:^|;)background:([^;]+)/u)?.[1];

    expect(background(openCardStyle)).toBeDefined();
    expect(background(resolvedCardStyle)).toBeDefined();
    expect(background(resolvedCardStyle)).not.toBe(background(openCardStyle));
  });

  it("解決済み thread は既定の card・badge 描画対象から外す", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const visibleThreads = injected.slice(
      injected.indexOf("function visibleThreads()"),
      injected.indexOf("function renderResolvedToggle()")
    );
    const render = injected.slice(
      injected.indexOf("function render(focusedInput){"),
      injected.indexOf("function commonSelectionAnchor")
    );

    expect(injected).toContain("var showResolved=false");
    expect(visibleThreads).toContain(
      'return showResolved?comments.threads:comments.threads.filter(function(thread){return thread.status==="open";})'
    );
    expect(render).toContain("visibleThreads().forEach(renderThread)");
    expect(render).not.toContain("comments.threads.forEach(renderThread)");
  });

  it("解決済み thread は既定の doc・graph アンカーハイライト対象から外す", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const highlights = injected.slice(
      injected.indexOf("function renderHighlights()"),
      injected.indexOf("function positionCards()")
    );

    expect(highlights.match(/visibleThreads\(\)\.forEach/gu)).toHaveLength(2);
    expect(highlights).not.toContain("comments.threads.forEach");
  });

  it("解決済みが 1 件以上あるときだけ件数付きトグルを描画する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const toggleRenderer = injected.slice(
      injected.indexOf("function renderResolvedToggle()"),
      injected.indexOf("function renderThread")
    );

    expect(toggleRenderer).toContain(
      'comments.threads.filter(function(thread){return thread.status==="resolved";}).length'
    );
    expect(toggleRenderer).toContain("if(resolvedCount===0)return");
    expect(toggleRenderer.indexOf("if(resolvedCount===0)return")).toBeLessThan(
      toggleRenderer.indexOf('element("button"')
    );
    expect(toggleRenderer).toContain('"解決済み "+resolvedCount+" 件"');
    expect(toggleRenderer).toContain("ark-comment-resolved-toggle");
  });

  it("解決済みトグルはページ内状態を反転して再描画する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const toggleRenderer = injected.slice(
      injected.indexOf("function renderResolvedToggle()"),
      injected.indexOf("function renderThread")
    );

    expect(toggleRenderer).toContain(
      'toggle.setAttribute("aria-pressed",showResolved?"true":"false")'
    );
    expect(toggleRenderer).toContain("showResolved=!showResolved");
    expect(toggleRenderer).toContain("render()");
  });

  it("解決済みトグルを右下に固定し、狭いペインでは右余白を詰める", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const toggleStyle = injected.slice(
      injected.indexOf(".ark-comment-resolved-toggle{"),
      injected.indexOf(".ark-comment-resolved-toggle[aria-pressed=true]")
    );

    expect(toggleStyle).toContain("position:fixed");
    expect(toggleStyle).toContain("bottom:8px");
    expect(toggleStyle).toContain("right:12px");
    expect(toggleStyle).not.toContain("top:8px");
    expect(injected).toContain(
      ".ark-comment-layer[data-narrow=true] .ark-comment-resolved-toggle{right:8px}"
    );
  });

  it("最下部のカード後方にトグル分のスクロール余白を確保する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const positionCards = injected.slice(
      injected.indexOf("function positionCards()"),
      injected.indexOf("function refreshLayout()")
    );

    expect(positionCards).toContain("var previousBottom=-CARD_GAP");
    expect(positionCards).toContain(
      "var trailingClearance=resolvedToggle?resolvedToggle.offsetHeight+8+CARD_GAP:0"
    );
    expect(positionCards).toContain(
      'root.style.height=Math.max(0,previousBottom+trailingClearance)+"px"'
    );
    expect(positionCards).not.toContain(
      "resolvedToggle.offsetTop+resolvedToggle.offsetHeight"
    );
  });

  it("未解決 0 件・解決済み 0 件ならコメント層由来の可視要素を描画しない", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const render = injected.slice(
      injected.indexOf("function render(focusedInput){"),
      injected.indexOf("function commonSelectionAnchor")
    );
    const toggleRenderer = injected.slice(
      injected.indexOf("function renderResolvedToggle()"),
      injected.indexOf("function renderThread")
    );

    expect(render).toContain("visibleThreads().forEach(renderThread)");
    expect(render).toContain("renderResolvedToggle()");
    expect(toggleRenderer).toContain("if(resolvedCount===0)return");
    expect(injected).toContain(
      'selectionAddButton.setAttribute("data-visible","false")'
    );
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

  it("card と composer の高さを制限せず、内部に縦スクロールを作らない", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).not.toContain("max-height:calc(100vh - 16px)");
    expect(injected).not.toContain(
      ".ark-comment-card-scroll,.ark-comment-composer-scroll"
    );
    expect(injected).not.toContain("overflow-y:auto");
    expect(injected).toContain(
      "content.appendChild(scroll);content.appendChild(actions)"
    );
    expect(injected).toContain(
      "composer.appendChild(composerScroll);composer.appendChild(composerActions)"
    );
  });

  it("scroll では再配置せず、resize・ResizeObserver・再描画では再計算する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).not.toContain(
      'window.addEventListener("scroll",positionCards'
    );
    expect(injected).toContain(
      'window.addEventListener("resize",refreshLayout)'
    );
    expect(injected).toContain("new ResizeObserver(refreshLayout)");
    expect(injected).toContain("window.requestAnimationFrame(positionCards)");
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

  it("コメント本文のインラインコード・太字・斜体を DOM 要素として組み立てる", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const inlineRenderer = injected.slice(
      injected.indexOf("function appendInlineMarkdown"),
      injected.indexOf("function renderCommentBody")
    );

    expect(inlineRenderer).toContain('element("code",token.slice(1,-1))');
    expect(inlineRenderer).toContain('element("strong",token.slice(2,-2))');
    expect(inlineRenderer).toContain('element("em",token.slice(1,-1))');
    expect(inlineRenderer).toContain("document.createTextNode");
  });

  it("空のインラインコードと太字は記号を literal のまま描画する", () => {
    expect(renderInlineMarkdown("``")).toEqual([{ textContent: "``" }]);
    expect(renderInlineMarkdown("****")).toEqual([{ textContent: "****" }]);
    expect(renderInlineMarkdown("`code` **bold**")).toEqual([
      { tagName: "code", textContent: "code" },
      { textContent: " " },
      { tagName: "strong", textContent: "bold" },
    ]);
  });

  it("無効な斜体区切りの後にある太字を描画する", () => {
    expect(renderInlineMarkdown("*未閉じ **太字**")).toEqual([
      { textContent: "*未閉じ " },
      { tagName: "strong", textContent: "太字" },
    ]);
  });

  it("無効なバッククォートの後にあるインラインコードを描画する", () => {
    expect(renderInlineMarkdown("``code`")).toEqual([
      { textContent: "`" },
      { tagName: "code", textContent: "code" },
    ]);
  });

  it("コメント本文のコードブロック・箇条書き・番号付きリストを DOM 要素として組み立てる", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const bodyRenderer = injected.slice(
      injected.indexOf("function renderCommentBody"),
      injected.indexOf("function renderThread")
    );

    for (const contract of [
      'element("pre")',
      'element("code",codeLines.join("\\n"))',
      'element("ul")',
      'element("ol")',
      'element("li")',
    ]) {
      expect(bodyRenderer).toContain(contract);
    }
    expect(injected).toContain(
      ".ark-comment-body pre{max-width:100%;margin:6px 0;padding:7px;box-sizing:border-box;overflow-x:auto"
    );
  });

  it("コードブロックは未閉じでも末尾まで literal とし、内部の太字を解釈しない", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const bodyRenderer = injected.slice(
      injected.indexOf("function renderCommentBody"),
      injected.indexOf("function renderThread")
    );

    expect(bodyRenderer).toContain("while(index<lines.length");
    expect(bodyRenderer).toContain('element("code",codeLines.join("\\n"))');
    expect(bodyRenderer).not.toContain("appendInlineMarkdown(code");
  });

  it("対になっていないインライン記号とリンク記法は literal のまま描画する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const inlineRenderer = injected.slice(
      injected.indexOf("function appendInlineMarkdown"),
      injected.indexOf("function renderCommentBody")
    );

    expect(inlineRenderer).toContain(
      "container.appendChild(document.createTextNode(text.slice(textStart)))"
    );
    expect(inlineRenderer).toContain("var valid=close>cursor+markerLength");
    expect(inlineRenderer).not.toContain('element("a"');
  });

  it("Markdown は message.body だけへ適用し anchorQuote・anchorText は literal のままにする", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const threadRenderer = injected.slice(
      injected.indexOf("function renderThread"),
      injected.indexOf("function renderComposer")
    );
    const composerRenderer = injected.slice(
      injected.indexOf("function renderComposer"),
      injected.indexOf("function updateLayout")
    );

    expect(threadRenderer).toContain("renderCommentBody(message.body)");
    expect(threadRenderer.match(/renderCommentBody\(/gu)).toHaveLength(1);
    expect(composerRenderer).not.toContain("renderCommentBody(");
    expect(threadRenderer).toContain(
      'element("strong",thread.anchorText,"ark-comment-anchor-text")'
    );
    expect(threadRenderer).toContain(
      'element("p",thread.anchorQuote||thread.anchorText,"ark-comment-unresolved-quote")'
    );
  });

  it("明示状態がなければ広幅で開き、狭幅で畳む", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const threadRenderer = injected.slice(
      injected.indexOf("function renderThread"),
      injected.indexOf("function renderComposer")
    );

    expect(injected).toContain("var threadOpenStates=new Map()");
    expect(injected).toContain("function isThreadOpen(threadId)");
    expect(injected).toContain(
      "var explicitState=threadOpenStates.get(threadId)"
    );
    expect(threadRenderer).toContain("updateCardCollapsed(card,thread.id)");
  });

  it("card の閉じるボタンで閉じ、badge で開き直す", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const threadRenderer = injected.slice(
      injected.indexOf("function renderThread"),
      injected.indexOf("function renderComposer")
    );

    expect(threadRenderer).toContain(
      'element("button","×","ark-comment-close")'
    );
    expect(threadRenderer).toContain(
      'closeButton.setAttribute("aria-label","コメントを閉じる")'
    );
    expect(threadRenderer).toContain(
      'threadOpenStates.set(thread.id,"closed")'
    );
    expect(threadRenderer).toContain('threadOpenStates.set(thread.id,"open")');
  });

  it("明示的に開閉した thread は幅が変わっても指定を保つ", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const updateLayout = injected.slice(
      injected.indexOf("function updateLayout()"),
      injected.indexOf("function clearHighlights()")
    );
    const activateThread = injected.slice(
      injected.indexOf("function activateThread"),
      injected.indexOf("function wrapThreadQuote")
    );

    expect(updateLayout).toContain(
      'root.querySelectorAll(".ark-comment-card").forEach(function(card)'
    );
    expect(updateLayout).toContain(
      'updateCardCollapsed(card,card.getAttribute("data-thread-id"))'
    );
    expect(activateThread).toContain('threadOpenStates.set(thread.id,"open")');
  });

  it("sidecar から消えた thread の明示状態を render 時に掃除する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain("function cleanupThreadOpenStates()");
    expect(injected).toContain(
      "var existingThreadIds=new Set(comments.threads.map(function(thread){return thread.id;}))"
    );
    expect(injected).toContain(
      "if(!existingThreadIds.has(threadId))threadOpenStates.delete(threadId)"
    );
    expect(injected).toContain("cleanupThreadOpenStates()");
  });

  it("作成成功時は応答前後の差分にある新 thread を展開する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const selectCreatedThread = injected.slice(
      injected.indexOf("function selectCreatedThread"),
      injected.indexOf("function cleanupThreadOpenStates")
    );
    const resultHandler = injected.slice(
      injected.indexOf("function onPortMessage"),
      injected.indexOf('if(!graphMode)window.addEventListener("wheel"')
    );

    expect(resultHandler).toContain(
      "var previousThreadIds=new Set(comments.threads.map(function(thread){return thread.id;}))"
    );
    expect(resultHandler.indexOf("var previousThreadIds=")).toBeLessThan(
      resultHandler.indexOf("comments=data.comments")
    );
    expect(selectCreatedThread).toContain(
      "comments.threads.filter(function(thread){return !previousThreadIds.has(thread.id);})"
    );
    expect(selectCreatedThread).toContain(
      'threadOpenStates.set(createdThread.id,"open")'
    );
    expect(selectCreatedThread).not.toContain("narrow");
  });

  it("作成成功時の増加 thread が 0 件または複数件なら展開・選択しない", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const selectCreatedThread = injected.slice(
      injected.indexOf("function selectCreatedThread"),
      injected.indexOf("function cleanupThreadOpenStates")
    );

    expect(selectCreatedThread).toContain(
      "if(createdThreads.length!==1)return"
    );
    const fallbackGuard = selectCreatedThread.indexOf(
      "if(createdThreads.length!==1)return"
    );
    for (const mutation of [
      'threadOpenStates.set(createdThread.id,"open")',
      "selectedThreadId=createdThread.id",
      "selectedAnchorId=createdThread.anchorId",
    ]) {
      expect(fallbackGuard).toBeLessThan(selectCreatedThread.indexOf(mutation));
    }
  });

  it("作成成功時は選択状態を新 thread とその anchor に向ける", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const selectCreatedThread = injected.slice(
      injected.indexOf("function selectCreatedThread"),
      injected.indexOf("function cleanupThreadOpenStates")
    );

    expect(selectCreatedThread).toContain("selectedThreadId=createdThread.id");
    expect(selectCreatedThread).toContain(
      "selectedAnchorId=createdThread.anchorId"
    );
  });

  it("返信・解決・削除成功時は新 thread の展開・選択を行わない", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const resultHandler = injected.slice(
      injected.indexOf("function onPortMessage"),
      injected.indexOf('if(!graphMode)window.addEventListener("wheel"')
    );
    const createSuccess = resultHandler.slice(
      resultHandler.indexOf(
        'completedAction.type==="ark:diagram-comment-create"'
      ),
      resultHandler.indexOf(
        'completedAction.type==="ark:diagram-comment-reply"'
      )
    );
    const otherSuccesses = resultHandler.slice(
      resultHandler.indexOf(
        'completedAction.type==="ark:diagram-comment-reply"'
      ),
      resultHandler.indexOf(
        'completedAction.type!=="ark:diagram-comments-load"'
      )
    );

    expect(createSuccess).toContain("selectCreatedThread(previousThreadIds)");
    expect(
      resultHandler.match(/selectCreatedThread\(previousThreadIds\)/gu)
    ).toHaveLength(1);
    expect(otherSuccesses).not.toContain("selectCreatedThread");
  });

  it("解決成功時は対象 thread を明示的に閉じる", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const collapseResolvedThread = injected.slice(
      injected.indexOf("function collapseResolvedThread"),
      injected.indexOf("function cleanupThreadOpenStates")
    );
    const resultHandler = injected.slice(
      injected.indexOf("function onPortMessage"),
      injected.indexOf('if(!graphMode)window.addEventListener("wheel"')
    );

    expect(collapseResolvedThread).toContain(
      'threadOpenStates.set(threadId,"closed")'
    );
    expect(resultHandler).toContain(
      'completedAction.type==="ark:diagram-comment-resolve"'
    );
    expect(resultHandler).toContain(
      "collapseResolvedThread(completedAction.threadId)"
    );
  });

  it("解決した thread が選択中なら選択を解除する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const collapseResolvedThread = injected.slice(
      injected.indexOf("function collapseResolvedThread"),
      injected.indexOf("function cleanupThreadOpenStates")
    );

    expect(collapseResolvedThread).toContain(
      "if(selectedThreadId!==threadId)return"
    );
    expect(collapseResolvedThread).toContain("selectedAnchorId=null");
    expect(collapseResolvedThread).toContain("selectedThreadId=null");
  });

  it("作成・返信・削除成功時は解決時の畳み処理を行わない", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const resultHandler = injected.slice(
      injected.indexOf("function onPortMessage"),
      injected.indexOf('if(!graphMode)window.addEventListener("wheel"')
    );

    expect(
      resultHandler.match(
        /collapseResolvedThread\(completedAction\.threadId\)/gu
      )
    ).toHaveLength(1);
    const resolveSuccess = resultHandler.slice(
      resultHandler.indexOf(
        'completedAction.type==="ark:diagram-comment-resolve"'
      ),
      resultHandler.indexOf('completedAction.type==="ark:diagram-comment-send"')
    );
    expect(resolveSuccess).toContain(
      "collapseResolvedThread(completedAction.threadId)"
    );
  });

  it("受動的な再取得の発行直前に textarea のフォーカスと選択範囲を記録する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const changedHandler = injected.slice(
      injected.indexOf('data.type==="ark:diagram-comments-changed"'),
      injected.indexOf('data.type!=="ark:diagram-comments-result"')
    );
    const render = injected.slice(
      injected.indexOf("function render(focusedInput){"),
      injected.indexOf("function commonSelectionAnchor")
    );

    expect(injected).toContain("function captureFocusedInput()");
    expect(injected).toContain("document.activeElement");
    expect(injected).toContain("root.contains(activeElement)");
    expect(injected).toContain('activeElement.tagName!=="TEXTAREA"');
    expect(injected).toContain("selectionStart:activeElement.selectionStart");
    expect(injected).toContain("selectionEnd:activeElement.selectionEnd");
    expect(injected).toContain('activeElement.closest(".ark-comment-card")');
    expect(changedHandler.indexOf("captureFocusedInput()")).toBeLessThan(
      changedHandler.indexOf('send("ark:diagram-comments-load"')
    );
    expect(render).not.toContain("document.activeElement");
    expect(render).toContain("focusedInput.threadId");
    expect(render).toContain("restoredInput.focus({preventScroll:true})");
    expect(render).toContain("restoredInput.setSelectionRange(");
    expect(injected).toContain(
      "render(completedAction&&completedAction.focusedInput)"
    );
  });

  it("すべてのフォーカス操作でページをスクロールさせない", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const focusCalls = [...injected.matchAll(/\.focus\(([^)]*)\)/gu)];

    expect(focusCalls.length).toBeGreaterThan(0);
    for (const focusCall of focusCalls) {
      expect(focusCall[1]).toContain("preventScroll:true");
    }
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
    expect(injected).toContain('send("ark:diagram-comments-load",{}');
  });

  it("sidecar 更新通知による受動 load では pending 中もコントロールを無効化しない", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const send = injected.slice(
      injected.indexOf("function send("),
      injected.indexOf("function setActiveAnchor")
    );

    expect(injected).toContain("passive:true");
    expect(injected).toContain(
      "Boolean(pendingRequestId)&&!(pendingAction&&pendingAction.passive)"
    );
    expect(send).toContain("if(!pendingAction.passive)updatePendingControls()");
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
      'control.disabled=disableForPending||control.getAttribute("data-sent")==="true"'
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
      "function render(focusedInput){\n    clearDeleteConfirmation();"
    );
  });

  it("port 未接続時は pending にせず操作対象へエラーを表示する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);

    expect(injected).toContain('message:"コメント機能に接続できていません"');
    expect(injected.indexOf("if(!port){")).toBeLessThan(
      injected.indexOf("pendingRequestId=requestId()")
    );
    expect(injected.indexOf("if(pendingRequestId){")).toBeLessThan(
      injected.indexOf("if(!port){")
    );
  });

  it("pending 中の操作は対象へ理由を表示して再描画する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const send = injected.slice(
      injected.indexOf("function send("),
      injected.indexOf("if(!port){")
    );

    expect(send).toContain("if(pendingRequestId){");
    expect(send).toContain('if(type!=="ark:diagram-comments-load"){');
    expect(send).toContain("type:type");
    expect(send).toContain("anchorId:payload&&payload.anchorId");
    expect(send).toContain("threadId:payload&&payload.threadId");
    expect(send).toContain('message:"更新中です。もう一度お試しください"');
    expect(send).toContain("render()");
  });

  it("pending 中の load は理由を表示せず無言で破棄する", () => {
    const injected = injectDiagramCommentLayer(minimalDoc);
    const send = injected.slice(
      injected.indexOf("function send("),
      injected.indexOf("if(!port){")
    );

    expect(send).toContain(
      'if(type!=="ark:diagram-comments-load"){\n        operationError='
    );
    expect(send).toContain("      }\n      return;\n    }");
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
