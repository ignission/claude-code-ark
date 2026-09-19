/**
 * doc 型ボードの本文を人間がその場で編集できるようにする注入レイヤ。
 *
 * graph の diagram-harness.ts とは別の注入文字列にする。harness の 128KiB guard
 * (diagram-harness.test.ts:187) は injectHarness の出力だけを測っており、
 * doc 編集層をそこへ混ぜると graph の残り枠を食うため。
 *
 * モード切替は置かない。コメント層は選択時に浮くボタンを出す形 (updateSelectionAdd)
 * なので、選択がそのままコメントになるわけではなく contenteditable と衝突しない。
 */

import { MODEL_SCRIPT_ID } from "./diagram-file.js";
import { createCachedMinifier } from "./injected-minify.js";

export const DIAGRAM_DOC_EDITOR_MARKER = "ark-diagram-doc-editor";

export const DOC_EDITOR_LAYER = `<script id="${DIAGRAM_DOC_EDITOR_MARKER}" data-ark-harness-ui="1">
(function(){
  var MODEL_SCRIPT_ID="${MODEL_SCRIPT_ID}";
  var port=null;
  var saveTimer=null;
  var bar=null;

  function modelScript(){return document.getElementById(MODEL_SCRIPT_ID);}

  function readModel(){
    var el=modelScript();
    if(!el)return null;
    try{return JSON.parse(el.textContent||"");}catch(e){return null;}
  }

  function writeModel(model){
    var el=modelScript();
    if(el)el.textContent=JSON.stringify(model);
  }

  // data-ark-id の入れ子は正規の構造（作図規約の階層 prefix）。編集可能にするのは
  // 他の data-ark-id を内包しない最内側の葉ブロックだけにする。祖先まで
  // contenteditable にすると、本文をクリックして全選択 → 削除するだけで
  // 複数ブロックが同時に消える上、入力イベントが祖先へもバブルして
  // 祖先の data-ark-author まで human に上書きしてしまう（#C-1）。
  // 副作用として、非葉ブロックの直下に地の文があってもそこは編集できないが、
  // 作図規約は本文を葉ブロックへ置く形なので許容する。
  function isLeafBlock(el){
    return !el.closest("[data-ark-harness-ui]")&&!el.querySelector("[data-ark-id]");
  }

  function blocks(){
    return Array.prototype.slice.call(document.querySelectorAll("[data-ark-id]"))
      .filter(isLeafBlock);
  }

  /** 送信用 HTML: 編集層の DOM と contenteditable を落とす */
  function submissionHtml(){
    var clone=document.documentElement.cloneNode(true);
    // コメント層は引用ハイライトの <span> と選択中クラスをブロック本文へ直接
    // 書き込む（data-ark-harness-ui は付かない。コメント層はこれまで読み取り専用の
    // 上に乗るだけだったので焼き付かなかったが、doc が編集可能になった今はここで
    // 剥がさないと autosave のたびにファイルへ残る）。
    // 展開の手順は comment layer 自身の clearHighlights と同じにする。
    clone.querySelectorAll('.ark-comment-highlight[data-ark-comment-owned="true"]').forEach(function(el){
      var parent=el.parentNode;
      el.replaceWith(document.createTextNode(el.textContent||""));
      if(parent&&parent.normalize)parent.normalize();
    });
    clone.querySelectorAll(".ark-comment-anchor-active").forEach(function(el){
      el.classList.remove("ark-comment-anchor-active");
      if(!el.classList.length)el.removeAttribute("class");
    });
    clone.querySelectorAll("[data-ark-harness-ui]").forEach(function(el){
      if(el.parentNode)el.parentNode.removeChild(el);
    });
    clone.querySelectorAll("[contenteditable]").forEach(function(el){
      el.removeAttribute("contenteditable");
    });
    clone.querySelectorAll("[data-ark-doc-wired]").forEach(function(el){
      el.removeAttribute("data-ark-doc-wired");
    });
    // サーバーが配信時に足す CSP meta を保存前に落とす（焼き付き防止）。
    clone.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]').forEach(function(el){
      if(el.parentNode)el.parentNode.removeChild(el);
    });
    return "<!doctype html>"+String.fromCharCode(10)+clone.outerHTML;
  }

  function markDirty(){
    syncModelNodes();
    if(bar)bar.setAttribute("data-visible","true");
    clearTimeout(saveTimer);
    saveTimer=setTimeout(save,800);
  }

  function save(){
    if(!port)return;
    var model=readModel();
    if(!model)return;
    port.postMessage({type:"ark:diagram-autosave",model:model,html:submissionHtml()});
  }

  function submit(){
    if(!port)return;
    var model=readModel();
    if(!model)return;
    clearTimeout(saveTimer);
    port.postMessage({type:"ark:diagram-submit",model:model,html:submissionHtml()});
    if(bar)bar.setAttribute("data-visible","false");
  }

  /** 人間が触ったブロックへ human 印を付ける */
  function stampAuthor(el){
    if(!el||!el.getAttribute("data-ark-id"))return;
    el.setAttribute("data-ark-author","human");
  }

  function wire(){
    blocks().forEach(function(el){
      if(el.getAttribute("data-ark-doc-wired"))return;
      el.setAttribute("data-ark-doc-wired","1");
      el.contentEditable="true";
    });
  }

  // 個別の anchor へ listener を付けるのではなく document へ1つだけ付け、
  // event.target から最も近い data-ark-id を1個だけ stamp する（delegated）。
  // 葉だけが contenteditable なので、入力の実際の発生源から closest すれば
  // 常にその葉自身に解決する。将来ブロックが増減しても listener の張り直しが要らない。
  function handleInput(event){
    var target=event&&event.target;
    var el=target&&target.closest?target.closest("[data-ark-id]"):null;
    if(!el||!el.getAttribute("data-ark-doc-wired"))return;
    stampAuthor(el);
    markDirty();
  }

  // execCommand は非推奨だが insertText の代替が無い。false 返却/例外時に
  // そのまま何もしないと、preventDefault 済みなので貼り付け内容が無言で
  // 消える（今回の Critical と同じ型の事故）。Selection API で直接テキスト
  // ノードを挿入するフォールバックへ落とし、それも失敗したときだけ諦めて
  // 警告を残す。
  function insertPlainText(text){
    var inserted=false;
    try{inserted=document.execCommand("insertText",false,text);}catch(e){inserted=false;}
    if(inserted)return;
    try{
      var selection=window.getSelection();
      if(!selection||selection.rangeCount===0)throw new Error("no selection");
      var range=selection.getRangeAt(0);
      range.deleteContents();
      var node=document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.setEndAfter(node);
      selection.removeAllRanges();
      selection.addRange(range);
    }catch(e){
      console.warn("ark: 貼り付け/ドロップしたテキストを挿入できませんでした",e);
    }
  }

  // 他サイトからの貼り付け・ドロップは inline style / class / img / a 等を
  // 本文へ持ち込み、そのままファイルへ永続化されてしまう。plain text だけを
  // 挿入する。
  function handlePaste(event){
    var target=event&&event.target;
    var el=target&&target.closest?target.closest("[data-ark-id]"):null;
    if(!el||!el.getAttribute("data-ark-doc-wired"))return;
    event.preventDefault();
    var clipboard=event.clipboardData||window.clipboardData;
    insertPlainText(clipboard?clipboard.getData("text/plain"):"");
  }

  function handleDrop(event){
    var target=event&&event.target;
    var el=target&&target.closest?target.closest("[data-ark-id]"):null;
    if(!el||!el.getAttribute("data-ark-doc-wired"))return;
    event.preventDefault();
    var data=event.dataTransfer;
    insertPlainText(data?data.getData("text/plain"):"");
  }

  var idSequence=0;
  /** このセッションで人間が作ったブロック。label を本文から追従させてよい印 */
  var mintedIds=Object.create(null);

  /**
   * data-ark-id を持つ要素を、葉に限らず全部返す。
   *
   * model との突き合わせに blocks() を使ってはいけない。blocks() は編集ホストに
   * する葉だけを返すが、実物の文書では <main data-ark-id="s1"> が全体を包み、
   * <table data-ark-id="s1-t1"> が <tr data-ark-id="s1-t1-r1"> を包む。どちらも
   * 正規の node なので、葉だけで突き合わせると「DOM に無い」と誤判定し、
   * その model node と groups[].nodes の参照まで消してしまう。
   */
  function allBlocks(){
    return Array.prototype.slice.call(document.querySelectorAll("[data-ark-id]"))
      .filter(function(el){return !el.closest("[data-ark-harness-ui]");});
  }

  /**
   * node の label 用テキスト。注入 UI（著者バッジ等）の文字は混ぜない。
   * このレイヤは TS のテンプレートリテラルなので、正規表現のバックスラッシュは
   * 二重に書く（1本だと配信物では /s+/g になり、label から "s" の連なりが消える）。
   */
  function labelFor(el){
    var clone=el.cloneNode(true);
    Array.prototype.slice.call(clone.querySelectorAll("[data-ark-harness-ui]"))
      .forEach(function(node){if(node.parentNode)node.parentNode.removeChild(node);});
    return (clone.textContent||"").replace(/\\s+/g," ").trim().slice(0,80);
  }

  /** 作図規約が定める doc の kind 語彙へタグ名を写す（該当が無ければ paragraph） */
  var KIND_BY_TAG={MAIN:"section",SECTION:"section",ARTICLE:"section",ASIDE:"panel",
    TABLE:"table",TR:"table-row",UL:"list",OL:"list",LI:"list-item",
    BLOCKQUOTE:"quote",PRE:"code",FIGURE:"figure"};
  function kindFor(el){return KIND_BY_TAG[el.tagName]||"paragraph";}

  /** 既存の data-ark-id とも model node id とも衝突しない id を採番する */
  function mintBlockId(){
    var model=readModel();
    var taken=Object.create(null);
    if(model&&Array.isArray(model.nodes)){
      model.nodes.forEach(function(node){if(node&&node.id)taken[node.id]=true;});
    }
    var stamp=Date.now().toString(36);
    for(;;){
      idSequence+=1;
      var candidate="h"+stamp+"-"+idSequence;
      if(!taken[candidate]&&!document.querySelector('[data-ark-id="'+candidate+'"]')){
        return candidate;
      }
    }
  }

  /**
   * DOM の data-ark-id 集合と model の node 集合を一致させる。
   * validateDiagramDocAnchors が1対1を強制するので、ここがずれると保存が 422 になる。
   *
   * 無印の要素へ機械的に id を振ることはしない。本文には <h1> や <td> のように
   * 意図して node を持たない要素があり、一括で振ると一度の入力で大量の偽 node が
   * 生まれる上、葉ブロックが葉でなくなって編集できなくなる。新しいブロックを
   * 作れるのは splitBlock() だけで、id はそこで採番する。
   *
   * 並びは DOM 順に揃える。kept に残る node は定義上すべて DOM に在るので、
   * これは「並べ替え」ではなく本文と同じ順に直すことになる。
   */
  function syncModelNodes(){
    var model=readModel();
    if(model&&Array.isArray(model.nodes)){
      var byId=Object.create(null);
      model.nodes.forEach(function(node){if(node&&node.id)byId[node.id]=node;});

      var present=Object.create(null);
      var kept=[];
      allBlocks().forEach(function(el){
        var id=el.getAttribute("data-ark-id");
        // 重複した data-ark-id は先勝ち（extractDocBlocks と同じ扱い）。
        // 2 個の node を作ると id 重複でモデルの parse ごと落ちる。
        if(!id||present[id])return;
        present[id]=true;
        var node=byId[id];
        if(node){
          // 人間が作ったブロックと label の無い node だけ本文から補う。
          // Claude が書いた要約 label は入力のたびに上書きしない。
          if(mintedIds[id]||!node.label)node.label=labelFor(el);
        }else{
          node={id:id,label:labelFor(el),kind:kindFor(el)};
        }
        kept.push(node);
      });

      // 消えた node を参照する group member も落とす（参照整合性）
      if(Array.isArray(model.groups)){
        model.groups.forEach(function(group){
          if(!group||!Array.isArray(group.nodes))return;
          group.nodes=group.nodes.filter(function(id){return present[id];});
        });
      }
      model.nodes=kept;
      writeModel(model);
    }
    // model を読めない文書でも、増えたブロックは編集可能にする
    wire();
  }

  /** 本文として数えるものが無い断片か（注入 UI は本文ではないので数えない） */
  function isBlankFragment(fragment){
    var probe=document.createElement("div");
    probe.appendChild(fragment);
    Array.prototype.slice.call(probe.querySelectorAll("[data-ark-harness-ui]"))
      .forEach(function(node){if(node.parentNode)node.parentNode.removeChild(node);});
    return (probe.textContent||"").trim()===""&&!probe.querySelector("*");
  }

  /** キャレットがブロックの先頭にあるか（手前に本文が1つも無いか） */
  function caretAtBlockStart(el){
    try{
      var selection=window.getSelection();
      if(!selection||selection.rangeCount===0)return false;
      var range=selection.getRangeAt(0);
      if(!range.collapsed||!el.contains(range.startContainer))return false;
      var head=document.createRange();
      head.setStart(el,0);
      head.setEnd(range.startContainer,range.startOffset);
      return isBlankFragment(head.cloneContents());
    }catch(e){
      return false;
    }
  }

  /** キャレットから後ろの内容を next へ移す。移したものがあれば true */
  function moveTailInto(el,next){
    try{
      var selection=window.getSelection();
      if(!selection||selection.rangeCount===0)return false;
      var range=selection.getRangeAt(0);
      // 選択がブロックの外へ出ているときは触らない（他ブロックを巻き込まない）
      if(!el.contains(range.startContainer)||!el.contains(range.endContainer))return false;
      if(!range.collapsed)range.deleteContents();
      var tail=document.createRange();
      tail.setStart(range.startContainer,range.startOffset);
      tail.setEnd(el,el.childNodes.length);
      var fragment=tail.extractContents();
      // 断片の「数」で判定してはいけない。Range は部分的に含まれる先頭の Text を
      // 必ず1個クローンするので、キャレットが Text の末尾にあるとき（段落末尾で
      // 改段落する一番普通の操作）でも空の Text が1個入り、何も動いていないのに
      // 動いたことになる。元ブロックが誤って human になる。
      var moved=(fragment.textContent||"")!==""||!!fragment.querySelector("*");
      if(!moved)return false;
      next.appendChild(fragment);
      return true;
    }catch(e){
      console.warn("ark: ブロックを分割できませんでした",e);
      return false;
    }
  }

  function focusBlockStart(el){
    try{
      if(el.focus)el.focus();
      var selection=window.getSelection();
      if(!selection)return;
      var range=document.createRange();
      range.setStart(el,0);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }catch(e){
      // キャレットを移せなくてもブロック自体は増えているので、編集は続けられる
    }
  }

  /** 葉ブロックの直後に、同じタグの新しい兄弟ブロックを作る */
  function splitBlock(el){
    var parent=el.parentNode;
    if(!parent)return;
    var next=document.createElement(el.tagName);
    var id=mintBlockId();
    mintedIds[id]=true;
    next.setAttribute("data-ark-id",id);
    next.setAttribute("data-ark-author","human");
    // 見た目の連続性のため class だけ引き継ぐ（<p class="lead"> 等）。
    // コメント層が付ける選択中クラスは submissionHtml() が剥がす。
    var className=el.getAttribute("class");
    if(className)next.setAttribute("class",className);
    // 先頭での Enter は「上に空行を足す」。ここで分割すると本文が丸ごと新しい id の
    // human ブロックへ移り、1文字も書き換えていない段落が人間の決定として読まれる上、
    // その id に付いていたコメントの anchor も外れる。
    if(caretAtBlockStart(el)){
      parent.insertBefore(next,el);
      markDirty();
      focusBlockStart(el);
      return;
    }
    // 本文が実際に動いたときだけ、元ブロックも人間が触ったものとして印を付ける
    if(moveTailInto(el,next))stampAuthor(el);
    parent.insertBefore(next,el.nextSibling);
    markDirty();
    focusBlockStart(next);
  }

  // 編集ホストは葉ブロック自身なので、既定の Enter は葉の「内側」へ改行を入れる
  // だけで、新しい data-ark-id ブロックは生まれない。人間が段落を足す経路が
  // 他に無いため、既定を止めて自分で兄弟ブロックを作る。
  function handleKeydown(event){
    if(!event||event.key!=="Enter")return;
    if(event.shiftKey||event.ctrlKey||event.metaKey||event.altKey)return;
    // IME の変換確定（日本語入力）の Enter で段落を割らない
    if(event.isComposing||event.keyCode===229)return;
    var target=event.target;
    if(!target||!target.closest)return;
    // 注入 UI（コメント層の入力欄等）の中の Enter は既定のまま通す
    if(target.closest("[data-ark-harness-ui]"))return;
    var el=target.closest("[data-ark-id]");
    if(!el||!el.getAttribute("data-ark-doc-wired"))return;
    event.preventDefault();
    splitBlock(el);
  }

  function buildBar(){
    var style=document.createElement("style");
    style.setAttribute("data-ark-harness-ui","1");
    style.textContent='#ark-doc-bar{display:none}#ark-doc-bar[data-visible="true"]{display:block}[data-ark-id][contenteditable="true"]:focus{outline:2px solid #38bdf8;outline-offset:2px}[data-ark-id][contenteditable="true"]:empty{min-height:1.2em}';
    document.head.appendChild(style);

    bar=document.createElement("div");
    bar.id="ark-doc-bar";
    bar.setAttribute("data-ark-harness-ui","1");
    bar.setAttribute("data-visible","false");
    bar.style.cssText="position:fixed;right:12px;bottom:12px;z-index:9";
    var send=document.createElement("button");
    send.textContent="変更を送る";
    send.style.cssText="font:inherit;padding:6px 12px;border-radius:6px;border:1px solid #475569;background:#1e293b;color:#e2e8f0;cursor:pointer";
    send.addEventListener("click",submit);
    bar.appendChild(send);
    document.body.appendChild(bar);
  }

  window.addEventListener("message",function(event){
    if(port||!event.data||event.data.type!=="ark:diagram-init")return;
    if(!event.ports||!event.ports[0])return;
    port=event.ports[0];
    port.start();
  });

  function start(){
    buildBar();
    wire();
    document.addEventListener("input",handleInput);
    document.addEventListener("paste",handlePaste);
    document.addEventListener("drop",handleDrop);
    document.addEventListener("keydown",handleKeydown);
    document.addEventListener("ark:doc-sync",syncModelNodes);
  }
  if(document.readyState==="loading"){
    document.addEventListener("DOMContentLoaded",start);
  }else{
    start();
  }
})();
</script>`;

const scriptContentStart = DOC_EDITOR_LAYER.indexOf(">") + 1;
const scriptContentEnd = DOC_EDITOR_LAYER.lastIndexOf("</script>");
const minify = createCachedMinifier(
  DOC_EDITOR_LAYER.slice(scriptContentStart, scriptContentEnd),
  "js"
);

function minifiedLayer(): string {
  return (
    DOC_EDITOR_LAYER.slice(0, scriptContentStart) +
    minify() +
    DOC_EDITOR_LAYER.slice(scriptContentEnd)
  );
}

// マーカー文字列の bare な includes() だけだと、doc の本文にたまたま
// "ark-diagram-doc-editor" という語が書かれているだけで、以後その board は
// 無言で二度と注入されなくなる。comment layer（injectDiagramCommentLayer）と
// 同じ堅さにする: 実際に注入済みの <script id="..."> タグがあるかで判定する。
const INJECTED_SCRIPT_RE = new RegExp(
  `<script[^>]*\\bid=["']${DIAGRAM_DOC_EDITOR_MARKER}["']`,
  "i"
);

export function injectDiagramDocEditor(html: string): string {
  if (INJECTED_SCRIPT_RE.test(html)) return html;
  const layer = minifiedLayer();
  const closing = html.toLowerCase().lastIndexOf("</body>");
  if (closing === -1) return html + layer;
  return html.slice(0, closing) + layer + html.slice(closing);
}
